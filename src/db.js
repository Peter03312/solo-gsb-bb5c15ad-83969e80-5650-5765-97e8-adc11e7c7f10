'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'lightbudget.db');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 全局版本：任何对作品 / 排期 / 时段生命周期的变更都会使其 +1。
-- 并发调整必须携带当前版本，过期则拒绝（409）。
CREATE TABLE IF NOT EXISTS meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 1
);

-- 作品：展期曝光上限（lux·min）与既有累计量
CREATE TABLE IF NOT EXISTS artworks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  limit_amount REAL NOT NULL CHECK (limit_amount >= 0),
  existing_amount REAL NOT NULL CHECK (existing_amount >= 0),
  note TEXT NOT NULL DEFAULT ''
);

-- 展厅时段
-- status: scheduled 未开始 / running 进行中(冻结原排期) / finished 已结束(以实际值结算)
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hall TEXT NOT NULL,
  seq INTEGER NOT NULL,                 -- 编号（按开始时间排序的顺序号）
  status TEXT NOT NULL DEFAULT 'scheduled',
  -- 排期（计划）值：开始后冻结
  planned_start TEXT NOT NULL,
  planned_end TEXT NOT NULL,
  planned_lux REAL NOT NULL CHECK (planned_lux >= 0),
  -- 结束时补记的实际值
  actual_start TEXT,
  actual_end TEXT,
  actual_lux REAL,                       -- 单一照度结算的照度；分段结算为 NULL（以 actual_segments 为准）
  actual_exposure REAL,
  -- 多段照度结算：JSON 数组 [{start,end,lux,minutes,exposure}]，首尾衔接完整覆盖实际区间
  actual_segments TEXT NOT NULL DEFAULT '[]',
  -- 核算结果：该时段按当前预算是否可启动
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT NOT NULL DEFAULT '{}'
);

-- 已结束时段的分段更正记录（只增不改：每次更正写一条）
CREATE TABLE IF NOT EXISTS slot_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  seq_no INTEGER NOT NULL,              -- 该时段第几次更正（从 1 开始）
  before_start TEXT, before_end TEXT,   -- 更正前实际起止
  before_lux REAL,                      -- 更正前单一照度（分段时为 NULL）
  before_minutes INTEGER,
  before_exposure REAL,
  before_segments TEXT NOT NULL DEFAULT '[]',
  after_start TEXT NOT NULL,
  after_end TEXT NOT NULL,
  after_lux REAL,
  after_minutes INTEGER NOT NULL,
  after_exposure REAL NOT NULL,
  after_segments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- 时段 <-> 作品（一个时段可同时展出多件作品，同照度下分别计入各作品）
CREATE TABLE IF NOT EXISTS slot_artworks (
  slot_id INTEGER NOT NULL REFERENCES slots(id) ON DELETE CASCADE,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  PRIMARY KEY (slot_id, artwork_id)
);

-- 曝光额度组：巡展中易损作品共用一笔曝光额度（名称 + 非负上限）
CREATE TABLE IF NOT EXISTS quota_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  limit_amount REAL NOT NULL CHECK (limit_amount >= 0)
);

-- 额度组成员：每件作品至多归属一组（artwork_id 唯一索引保证）
CREATE TABLE IF NOT EXISTS quota_group_members (
  group_id INTEGER NOT NULL REFERENCES quota_groups(id) ON DELETE CASCADE,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, artwork_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_group_members_artwork ON quota_group_members(artwork_id);

-- 计划外曝光记录：布展 / 搬运等排期外受光。单件作品 + 实际起止 + 连续照度分段。
-- status: active 有效（计入已用量）/ void 已作废（归档保留、不再计入）
-- 更正只改照度分段（区间沿用），作废后记录只读；每次变动写 exposure_record_changes。
CREATE TABLE IF NOT EXISTS exposure_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  artwork_id INTEGER NOT NULL REFERENCES artworks(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',
  -- 事由（布展 / 搬运 / 其他）与备注
  reason_kind TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  actual_start TEXT NOT NULL,
  actual_end TEXT NOT NULL,
  actual_lux REAL,                       -- 仅单段时为该段照度，多段为 NULL
  actual_minutes INTEGER NOT NULL,
  actual_exposure REAL NOT NULL CHECK (actual_exposure >= 0),
  -- 连续照度分段 JSON：[{start,end,lux,minutes,exposure}]，首尾衔接、完整覆盖实际区间
  actual_segments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exposure_records_artwork ON exposure_records(artwork_id);

-- 计划外记录的更正 / 作废审计（只增不改：每次变动写一条，保留前后值与理由）
-- change_type: correct 更正分段 / void 作废
CREATE TABLE IF NOT EXISTS exposure_record_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL REFERENCES exposure_records(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL,
  seq_no INTEGER NOT NULL,               -- 该记录第几次变动（从 1 开始，更正/作废连续编号）
  reason TEXT NOT NULL,
  before_status TEXT NOT NULL,
  before_start TEXT NOT NULL, before_end TEXT NOT NULL,
  before_lux REAL, before_minutes INTEGER NOT NULL, before_exposure REAL NOT NULL,
  before_segments TEXT NOT NULL DEFAULT '[]',
  after_status TEXT NOT NULL,
  after_start TEXT NOT NULL, after_end TEXT NOT NULL,
  after_lux REAL, after_minutes INTEGER NOT NULL, after_exposure REAL NOT NULL,
  after_segments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exposure_record_changes_record ON exposure_record_changes(record_id, seq_no, id);
`;

// 旧库升级：为已存在的 slots 表补齐多段结算列
const MIGRATIONS = [
  `ALTER TABLE slots ADD COLUMN actual_segments TEXT NOT NULL DEFAULT '[]'`,
];

function openDb() {
  if (DB_PATH !== ':memory:') {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  for (const sql of MIGRATIONS) {
    const hasCol = db.prepare("PRAGMA table_info(slots)").all()
      .some((c) => c.name === 'actual_segments');
    if (!hasCol) db.exec(sql);
  }
  return db;
}

function resetDb() {
  if (DB_PATH !== ':memory:' && fs.existsSync(DB_PATH)) {
    fs.rmSync(DB_PATH);
    for (const suffix of ['-wal', '-shm']) {
      const f = DB_PATH + suffix;
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  }
  const db = openDb();
  db.close();
  return DB_PATH;
}

module.exports = { openDb, resetDb, DB_PATH };
