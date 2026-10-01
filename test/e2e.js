'use strict';
// 端到端规则验证（使用临时内存数据库逻辑通过 HTTP 接口验证）
const BASE = process.env.BASE || 'http://localhost:8080';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗ FAIL:', msg); }
}
async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({})).then((j) => j || {});
  return { status: res.status, json };
}
const getState = async () => (await call('GET', '/api/state')).json;

(async () => {
  console.log('# 1. 整批校验：负值 / 无效时序');
  let r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'a', hall: 'X', start: '2026-10-05T10:00', end: '2026-10-05T09:00', lux: 100, artworkIds: [3] },
    { cid: 'b', hall: 'Y', start: '2026-10-06T10:00', end: '2026-10-06T11:00', lux: -5, artworkIds: [3] },
    { cid: 'c', hall: 'Z', start: '2026-02-30T10:00', end: '2026-10-06T11:00', lux: 5, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.errors.length === 3, `拒绝三种无效输入（得到 ${r.status}, ${r.json.errors?.length} 条）`);
  let st = await getState();
  ok(st.version === 1, '被拒绝后版本不变、数据不变');

  console.log('# 2. 同作品时段重叠（新-新 / 新-冻结）');
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'p1', hall: '二号厅', start: '2026-10-10T10:00', end: '2026-10-10T12:00', lux: 100, artworkIds: [3] },
    { cid: 'p2', hall: '三号厅', start: '2026-10-10T11:00', end: '2026-10-10T13:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.length === 1, '新时段互相重叠被拒绝');
  ok(r.json.conflicts[0].artworkId === 3 && r.json.conflicts[0].slotA.cid === 'p1', '冲突指出作品与两个时段');

  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'f1', hall: '一号厅', start: '2026-09-30T10:00', end: '2026-09-30T11:00', lux: 100, artworkIds: [1] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-frozen', '与进行中冻结时段重叠被拒绝');
  // 不同作品同一时间允许
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'ok1', hall: '一号厅', start: '2026-09-30T10:00', end: '2026-09-30T11:00', lux: 100, artworkIds: [3] },
  ]});
  ok(r.status === 200, '不同作品同展厅时间重叠允许（仅按作品约束）');

  console.log('# 3. 预算超限整批拒绝');
  st = await getState(); // version 现在 2
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'big', hall: '四号厅', start: '2026-11-01T08:00', end: '2026-11-01T20:00', lux: 500, artworkIds: [2] },
  ]});
  ok(r.status === 422 && r.json.budgetExceeded?.[0]?.artworkId === 2,
     `超量拒绝并指出作品与超出值（overflow=${r.json.budgetExceeded?.[0]?.overflow}）`);
  st = await getState();
  ok(st.version === 2, '超量拒绝后版本不变');

  console.log('# 4. 过期版本并发拒绝');
  r = await call('POST', '/api/schedule', { version: 1, slots: [
    { cid: 'v', hall: '五号厅', start: '2026-12-01T10:00', end: '2026-12-01T11:00', lux: 10, artworkIds: [3] },
  ]});
  ok(r.status === 409 && r.json.error?.code === 'VERSION_STALE' && r.json.state.version === 2,
     `过期版本返回 409 与最新预算（state v${r.json.state?.version}）`);

  console.log('# 5. 合法整批保存 + 版本递增 + 重新编号');
  r = await call('POST', '/api/schedule', { version: 2, slots: [
    { cid: 'x', hall: '二号厅', start: '2026-10-20T10:00', end: '2026-10-20T12:00', lux: 120, artworkIds: [1, 2] },
    { cid: 'y', hall: '三号厅', start: '2026-10-19T09:00', end: '2026-10-19T10:00', lux: 80, artworkIds: [3] },
  ]});
  ok(r.status === 200 && r.json.version === 3, `整批保存成功，版本→${r.json.version}`);
  const sched = r.json.slots.filter((s) => s.status === 'scheduled').sort((a, b) => a.seq - b.seq);
  ok(sched.length === 2 && sched[0].hall === '三号厅' && sched[0].seq === 3 && sched[1].seq === 4,
     '按开始时间重新编号（冻结时段在前）');
  ok(sched.every((s) => !s.blocked), '预算充足：无不可启动时段');

  console.log('# 6. 启动进行中时段不允许 / 启动未开始时段');
  const target = sched[0]; // 三号厅 W3
  r = await call('POST', `/api/slots/2/start`);
  ok(r.status === 422 && r.json.error?.code === 'NOT_STARTABLE', '已在进行中的时段不能再次启动');
  r = await call('POST', `/api/slots/${target.id}/start`);
  ok(r.status === 200, '未开始时段可启动');
  st = r.json;
  const running3 = st.slots.find((s) => s.id === target.id);
  ok(running3.status === 'running', '状态变为进行中');
  ok(st.version === 4, '启动后版本 +1');
  // 启动后再保存排期：该时段必须从可编辑集合消失，且仍不可被重叠
  r = await call('POST', '/api/schedule', { version: 4, slots: [
    { cid: 'ov', hall: '三号厅', start: '2026-10-19T09:30', end: '2026-10-19T10:30', lux: 50, artworkIds: [3] },
  ]});
  ok(r.status === 422 && r.json.conflicts?.[0]?.kind === 'new-frozen', '启动后冻结：新排期与其重叠被拒');
  // 空批次合法
  r = await call('POST', '/api/schedule', { version: 4, slots: [] });
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').length === 0, '空批次合法（清空未开始排期）');

  console.log('# 7. 结束补记：无效时序拒绝');
  r = await call('POST', `/api/slots/${target.id}/finish`, {
    actualStart: '2026-10-19T10:00', actualEnd: '2026-10-19T09:00', actualLux: 100,
  });
  ok(r.status === 422, '实际结束早于开始被拒绝');
  r = await call('POST', `/api/slots/${target.id}/finish`, {
    actualStart: '2026-10-19T09:00', actualEnd: '2026-10-19T10:00', actualLux: -1,
  });
  ok(r.status === 422, '负照度被拒绝');

  console.log('# 8. 超量结算 → 后续时段按顺序标为不可启动并禁止启动');
  // 先重建排期：W1、W2 在进行中时段(2号 240min*200)之后
  st = await getState();
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    { cid: 'w1s', hall: '二号厅', start: '2026-10-01T10:00', end: '2026-10-01T12:00', lux: 180, artworkIds: [1] }, // 21600
    { cid: 'w2s', hall: '二号厅', start: '2026-10-02T10:00', end: '2026-10-02T13:00', lux: 150, artworkIds: [2, 3] }, // 27000
    { cid: 'w3s', hall: '三号厅', start: '2026-10-03T09:30', end: '2026-10-03T11:00', lux: 220, artworkIds: [3] }, // 19800
  ]});
  ok(r.status === 200, '恢复三条未开始时段');
  const beforeFinish = r.json;
  const w1Slot = beforeFinish.slots.find((s) => s.hall === '二号厅' && s.plannedStart.startsWith('2026-10-01'));
  const w2Slot = beforeFinish.slots.find((s) => s.hall === '二号厅' && s.plannedStart.startsWith('2026-10-02'));
  ok(!w1Slot.blocked && !w2Slot.blocked, '结算前均可启动');

  // 结束 slot 2（W1+W2），实际 300 lux × 240 = 72000，远超冻结预占 48000
  r = await call('POST', '/api/slots/2/finish', {
    actualStart: '2026-09-30T09:00', actualEnd: '2026-09-30T13:00', actualLux: 300,
  });
  ok(r.status === 200 && r.json.justFinishedExposure === 72000, `实际曝光 ${r.json.justFinishedExposure} 替换预占`);
  // W1: 12000+22400+72000 = 106400, 余 13600 < 21600 → 缺口 8000
  // W2: 20000+72000 = 92000, 余 8000 < 27000 → 缺口 19000
  const blockedIds = r.json.blockedAfterFinish.map((s) => s.id);
  ok(blockedIds.length === 2 && blockedIds[0] === w1Slot.id,
     `按开始顺序标出不可开始时段：#${r.json.blockedAfterFinish.map((s) => s.seq).join(', #')}`);
  const g1 = w1Slot ? r.json.blockedAfterFinish.find((s) => s.id === w1Slot.id).blockedReason.gaps[0] : null;
  ok(g1 && g1.artworkId === 1 && g1.gap === 8000 && g1.has === 13600 && g1.need === 21600,
     `W1 缺口数据正确（has=${g1?.has}, need=${g1?.need}, gap=${g1?.gap}）`);

  // 尝试启动被拦截时段
  r = await call('POST', `/api/slots/${w1Slot.id}/start`);
  ok(r.status === 422 && r.json.error?.code === 'BLOCKED' && r.json.blockedReason.gaps[0].gap === 8000,
     '预算不足时段禁止启动并返回缺口');

  // W3 时段（10-03）：由于 w2s 联展 W3 但被跳过（不占预算），W3 独立时段应仍可启动
  const w3Only = r.json ? null : null;
  st = await getState();
  const w3slot = st.slots.find((s) => s.plannedStart.startsWith('2026-10-03'));
  ok(!w3slot.blocked, '被拦截时段不占预算，后续预算充足的时段仍标记可启动（贪婪核算）');

  console.log('# 9. 调整排期后重新核算，缺口消除');
  r = await call('POST', '/api/schedule', { version: st.version, slots: [
    // W1 缩短到 60 分钟 × 180 = 10800 <= 13600
    { cid: 'w1f', hall: '二号厅', start: '2026-10-01T10:00', end: '2026-10-01T11:00', lux: 180, artworkIds: [1] },
    // W2 降到 50 lux × 60 = 3000 <= 8000，同时联展 W3
    { cid: 'w2f', hall: '二号厅', start: '2026-10-02T10:00', end: '2026-10-02T11:00', lux: 50, artworkIds: [2, 3] },
    { cid: 'w3f', hall: '三号厅', start: '2026-10-03T09:30', end: '2026-10-03T11:00', lux: 220, artworkIds: [3] },
  ]});
  ok(r.status === 200 && r.json.slots.filter((s) => s.status === 'scheduled').every((s) => !s.blocked),
     '调整后重新核算：所有时段均可启动');
  st = r.json;
  const w1Final = st.slots.find((s) => s.plannedStart.startsWith('2026-10-01'));
  r = await call('POST', `/api/slots/${w1Final.id}/start`);
  ok(r.status === 200, '调整后时段可以启动');

  console.log('# 10. 作品校验：既有>上限拒绝；重复名拒绝；被引用时删除拒绝');
  st = await getState(); // #9 的启动操作又递增过版本，重新取最新版本
  r = await call('POST', '/api/artworks', { version: st.version, name: '测试品', limit: 100, existing: 200 });
  ok(r.status === 422, '既有累计超过上限拒绝');
  r = await call('POST', '/api/artworks', { version: st.version, name: '《山水轴》纸本水墨', limit: 100, existing: 0 });
  ok(r.status === 422, '作品名重复拒绝');
  r = await call('DELETE', '/api/artworks/1', { version: st.version });
  ok(r.status === 409 && r.json.error?.code === 'IN_USE', '被时段引用的作品不可删除');

  console.log('# 11. 合法作品增删改');
  r = await call('POST', '/api/artworks', { version: st.version, name: '新增测试品', limit: 5000, existing: 100, note: 'hi' });
  ok(r.status === 200, '新作品录入成功');
  const newId = r.json.artworks.at(-1).id;
  r = await call('PUT', `/api/artworks/${newId}`, { version: r.json.version, name: '新增测试品改', limit: 6000, existing: 200, note: 'x' });
  ok(r.status === 200 && r.json.artworks.at(-1).limit === 6000, '作品更新成功');
  r = await call('DELETE', `/api/artworks/${newId}`, { version: r.json.version });
  ok(r.status === 200 && !r.json.artworks.some((a) => a.id === newId), '未被引用的作品可删除');

  console.log('# 12. 多段照度结算：分段完整性校验（衔接/覆盖/非负）');
  st = await getState();
  // 独立演示作品，避免与前面步骤的数据耦合
  r = await call('POST', '/api/artworks', { version: st.version, name: '分段测试品', limit: 200000, existing: 0 });
  ok(r.status === 200, '分段测试作品已创建');
  const segArtId = r.json.artworks.at(-1).id;
  let v = r.json.version;
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'seg-a', hall: '四号厅', start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100, artworkIds: [segArtId] },
    { cid: 'seg-b', hall: '四号厅', start: '2026-11-10T14:00', end: '2026-11-10T16:00', lux: 100, artworkIds: [segArtId] },
  ]});
  ok(r.status === 200, '两个测试时段已排期');
  v = r.json.version;
  const segA = r.json.slots.find((s) => s.plannedStart.startsWith('2026-11-10T09'));
  const segB = r.json.slots.find((s) => s.plannedStart.startsWith('2026-11-10T14'));
  r = await call('POST', `/api/slots/${segA.id}/start`);
  ok(r.status === 200, '测试时段 A 已启动');
  v = r.json.version;

  const settlePath = `/api/slots/${segA.id}/settle`;
  // 缺口：两段之间空 10 分钟
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 100 },
    { start: '2026-11-10T10:10', end: '2026-11-10T11:00', lux: 200 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID' && r.json.segmentErrors.length >= 1,
     '分段有缺口被整批拒绝');
  // 重叠
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:30', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 200 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('衔接')), '分段重叠被拒绝');
  // 未覆盖到区间末尾
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:30', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('完整覆盖')), '分段未完整覆盖实际区间被拒绝');
  // 负照度
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: -1 },
  ]});
  ok(r.status === 422, '分段负照度被拒绝');
  // 空数组
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [] });
  ok(r.status === 422, '空分段被拒绝');
  // 零长度中间段（末段恰好等于区间结束，也不能漏网）
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T10:00', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('结束必须晚于开始')), '零长度中间段被拒绝');
  // 末段被包含在前段内（前段已到区间结束）→ 重叠
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 200 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('重叠')), '末段与前段重叠（区间被超过）被拒绝');
  // 乱序提交（第 2 段在第 1 段之前）→ 缺口
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 200 },
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.segmentErrors.some((m) => m.includes('缺口') || m.includes('覆盖')), '分段未按时间顺序提交被拒绝');
  st = await getState();
  ok(st.version === v, '分段拒绝不改变结算与版本');

  // 过期版本 → 409 + 最新预算
  r = await call('POST', settlePath, { version: 1, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100 },
  ]});
  ok(r.status === 409 && r.json.error.code === 'VERSION_STALE' && r.json.state.version === v,
     '多段结算过期版本返回 409 与最新预算');

  console.log('# 13. 多段结算成功：Σ(分钟×照度)，返回分段与总量');
  // 60*120 + 30*200 + 30*0 = 7200 + 6000 + 0 = 13200
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 120 },
    { start: '2026-11-10T10:00', end: '2026-11-10T10:30', lux: 200 },
    { start: '2026-11-10T10:30', end: '2026-11-10T11:00', lux: 0 },
  ]});
  ok(r.status === 200 && r.json.justFinishedExposure === 13200 && r.json.justFinishedMinutes === 120
     && r.json.justFinishedSegments.length === 3,
     `多段结算总量 ${r.json.justFinishedExposure}（应 13200）、时长 ${r.json.justFinishedMinutes} 分、3 段`);
  v = r.json.version;
  const settledA = r.json.slots.find((s) => s.id === segA.id);
  ok(settledA.status === 'finished' && settledA.actualLux === null && settledA.segmentCount === 3
     && settledA.actualSegments[2].exposure === 0,
     '多段结算后状态 finished、无单一照度、含 0 照度段');
  const segArt = r.json.artworks.find((a) => a.id === segArtId);
  ok(segArt.used === 13200, `作品已用 = 分段曝光之和 ${segArt.used}`);
  // 已结束时段不能再 settle
  r = await call('POST', settlePath, { version: v, actualStart: '2026-11-10T09:00', actualEnd: '2026-11-10T11:00', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 100 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'NOT_RUNNING', '已结束时段不能再次结算');

  console.log('# 14. 已结束时段分段更正：理由/覆盖校验/替换语义/记录');
  const correctPath = `/api/slots/${segA.id}/correct`;
  // 缺理由
  r = await call('POST', correctPath, { version: v, segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 110 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'VALIDATION', '无理由更正被拒绝');
  // 分段不覆盖原实际区间
  r = await call('POST', correctPath, { version: v, reason: 'x', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 110 },
  ]});
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID', '更正分段未覆盖原区间被拒绝');
  // 过期版本
  r = await call('POST', correctPath, { version: 1, reason: 'x', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 110 },
  ]});
  ok(r.status === 409 && r.json.state.version === v, '更正过期版本返回 409 与最新预算');
  st = await getState();
  ok(st.version === v && st.slots.find((s) => s.id === segA.id).actualExposure === 13200, '更正失败不改结算与版本');

  // 合法更正：改为两段 60*110 + 60*130 = 6600 + 7800 = 14400（替换 13200，不累加）
  r = await call('POST', correctPath, { version: v, reason: '照度计复核：开场调暗、随后恢复', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 110 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 130 },
  ]});
  ok(r.status === 200 && r.json.correction.seqNo === 1
     && r.json.correction.before.exposure === 13200 && r.json.correction.after.exposure === 14400
     && r.json.correction.before.segments.length === 3 && r.json.correction.after.segments.length === 2,
     '更正记录含更正前后曝光(13200→14400)、时间与分段数');
  v = r.json.version;
  const afterArt = r.json.artworks.find((a) => a.id === segArtId);
  ok(afterArt.used === 14400, `新总量替换旧总量、不重复累计：已用 ${afterArt.used}（应 14400）`);
  const afterSlot = r.json.slots.find((s) => s.id === segA.id);
  ok(afterSlot.actualExposure === 14400 && afterSlot.corrections.length === 1
     && afterSlot.corrections[0].reason.includes('照度计复核')
     && afterSlot.corrections[0].before.minutes === 120 && afterSlot.corrections[0].after.minutes === 120,
     '时段 DTO 携带更正记录（理由与前后时间）');

  console.log('# 15. 更正影响后续时段不可启动状态与缺口，再更正恢复');
  // segB（14:00–16:00，120 分钟）先启动前应可启动；当前已用 14400，上限 200000 充足 → 启动它
  r = await call('POST', `/api/slots/${segB.id}/start`);
  ok(r.status === 200, '测试时段 B 可启动');
  v = r.json.version;
  // 把 segA 更正为 199000：120 分钟单一照度，超出后 B 已在进行中（不标 blocked），
  // 这里改为验证未开始时段：再排一个 segC
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'seg-c', hall: '五号厅', start: '2026-11-11T09:00', end: '2026-11-11T10:00', lux: 100, artworkIds: [segArtId] },
  ]});
  ok(r.status === 200, '测试时段 C 已排期（60*100=6000）');
  v = r.json.version;
  const segC = r.json.slots.find((s) => s.plannedStart.startsWith('2026-11-11'));
  // 已用 14400（A）+ B 进行中预占 12000 = 26400；C 需 6000 → 当前可启动
  ok(!segC.blocked, '更正前 C 可启动');

  // 更正 A：120 分钟 * 1900 = 228000？上限 200000，会导致 B+C 全部超量；
  // 但 B 进行中预占固定 12000。C 判定时基线 = 1900*120 + 12000 = 240000 > 200000 → 缺口
  r = await call('POST', correctPath, { version: v, reason: '发现长期超照度，补登实测', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 1900 },
  ]});
  ok(r.status === 200 && r.json.correction.seqNo === 2, '第二次更正成功（seqNo=2）');
  v = r.json.version;
  const blockedC = r.json.blockedAfterFinish.find((s) => s.id === segC.id);
  ok(!!blockedC && blockedC.blockedReason.gaps[0].artworkId === segArtId,
     `更正后后续未开始时段被标不可启动，缺口 ${blockedC?.blockedReason.gaps[0].gap}`);
  const artOver = r.json.artworks.find((a) => a.id === segArtId);
  ok(artOver.used === 228000 && artOver.over === true, '更正后作品已用量同步重算为 228000');
  // 启动被拦截
  r = await call('POST', `/api/slots/${segC.id}/start`);
  ok(r.status === 422 && r.json.error.code === 'BLOCKED', '更正致缺口后 C 禁止启动');

  // 再更正回低照度：缺口消除
  r = await call('POST', correctPath, { version: v, reason: '复核为照度记录仪故障，恢复实测值', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T10:00', lux: 110 },
    { start: '2026-11-10T10:00', end: '2026-11-10T11:00', lux: 130 },
  ]});
  ok(r.status === 200 && r.json.correction.seqNo === 3
     && r.json.correction.before.exposure === 228000 && r.json.correction.after.exposure === 14400
     && r.json.blockedAfterFinish.length === 0,
     '第三次更正 228000→14400，缺口消除、后续时段恢复可启动');
  st = await getState();
  const restoredC = st.slots.find((s) => s.id === segC.id);
  ok(!restoredC.blocked && st.artworks.find((a) => a.id === segArtId).used === 14400,
     '恢复更正后 C 可启动、作品已用量回到 14400、更正记录共 3 条');
  ok(st.slots.find((s) => s.id === segA.id).corrections.length === 3, '更正历史累计 3 条且只增不改');

  console.log('# 16. 演示数据自带分段与更正记录');
  st = await getState();
  ok(st.slots.find((s) => s.id === 1).segmentCount === 2
     && st.slots.find((s) => s.id === 1).actualLux === null
     && st.slots.find((s) => s.id === 1).corrections.length >= 1
     && st.slots.find((s) => s.id === 1).actualExposure === 22400,
     '初始已结束时段为多段结算（2 段、合计 22400）并带更正记录');

  console.log('# 17. 额度组录入校验：重复/不存在/跨组占用/负上限/重名/空名 + 版本冲突');
  st = await getState();
  v = st.version;
  ok(st.groups.length === 1 && st.groups[0].name === '纸本联展共用额度'
     && st.groups[0].members.map((m) => m.id).join(',') === '1,2',
     '演示数据自带额度组（成员为两件纸本作品）');
  r = await call('POST', '/api/groups', { version: v, name: 'X组', limit: 100, memberIds: [segArtId, segArtId] });
  ok(r.status === 422, '组内成员重复被拒绝');
  r = await call('POST', '/api/groups', { version: v, name: 'X组', limit: 100, memberIds: [999999] });
  ok(r.status === 422, '成员作品不存在被拒绝');
  r = await call('POST', '/api/groups', { version: v, name: 'X组', limit: -5, memberIds: [] });
  ok(r.status === 422, '组上限为负被拒绝');
  r = await call('POST', '/api/groups', { version: v, name: '  ', limit: 100, memberIds: [] });
  ok(r.status === 422, '组名称为空被拒绝');
  r = await call('POST', '/api/groups', { version: v, name: '纸本联展共用额度', limit: 100, memberIds: [] });
  ok(r.status === 422, '组名称重复被拒绝');
  r = await call('POST', '/api/groups', { version: v, name: 'X组', limit: 100, memberIds: [1] });
  ok(r.status === 422 && /已归属/.test(r.json.error?.message || ''), '作品已归属其他组被拒绝（每件作品至多一组）');
  r = await call('POST', '/api/groups', { version: 1, name: 'Y组', limit: 100, memberIds: [] });
  ok(r.status === 409 && r.json.error?.code === 'VERSION_STALE' && r.json.state.version === v,
     '组配置过期版本返回 409 与最新预算');
  st = await getState();
  ok(st.version === v && st.groups.length === 1, '组校验失败不改版本与记录');

  console.log('# 18. 创建额度组成功：聚合已用/预占/余额；成员作品不可删除');
  r = await call('POST', '/api/groups', { version: v, name: '巡展摄影共用额度', limit: 100000, memberIds: [segArtId] });
  ok(r.status === 200 && r.json.version === v + 1, `额度组创建成功，版本→${r.json.version}`);
  let grp = r.json.groups.find((g) => g.name === '巡展摄影共用额度');
  ok(grp && grp.used === 14400 && grp.reservedRunning === 12000 && grp.reservedScheduled === 6000
     && grp.committed === 32400 && grp.balance === 67600 && grp.over === false,
     `组聚合正确（已用 ${grp?.used} / 预占 ${grp?.reserved} / 余额 ${grp?.balance}）`);
  const grpId = grp.id;
  v = r.json.version;
  r = await call('POST', '/api/groups', { version: v, name: '再抢一次', limit: 100, memberIds: [segArtId] });
  ok(r.status === 422 && /已归属/.test(r.json.error?.message || ''), '同一作品不能加入第二个组');
  // 组成员作品删除被拒；移出组后可删
  r = await call('POST', '/api/artworks', { version: v, name: '组删除测试品', limit: 1000, existing: 0 });
  const tmpArt = r.json.artworks.at(-1).id;
  v = r.json.version;
  r = await call('POST', '/api/groups', { version: v, name: '临时组', limit: 1000, memberIds: [tmpArt] });
  const tmpGrp = r.json.groups.find((g) => g.name === '临时组').id;
  v = r.json.version;
  r = await call('DELETE', `/api/artworks/${tmpArt}`, { version: v });
  ok(r.status === 409 && r.json.error?.code === 'IN_USE', '组成员作品删除被拒绝（IN_USE）');
  r = await call('DELETE', `/api/groups/${tmpGrp}`, { version: v });
  ok(r.status === 200, '空组可删除');
  v = r.json.version;
  r = await call('DELETE', `/api/artworks/${tmpArt}`, { version: v });
  ok(r.status === 200, '移出组后作品可删除');
  v = r.json.version;

  console.log('# 19. 整批排期：单件未超但组超限 → 整批拒绝并指出组、成员贡献、超额量');
  // segArt 单件：已用 14400 + 进行中 12000 = 26400，上限 200000；组上限 100000
  // 本批 6000 + 132000 = 138000 → 单件 164400 未超，组 164400 超 64400
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'c1', hall: '五号厅', start: '2026-11-11T09:00', end: '2026-11-11T10:00', lux: 100, artworkIds: [segArtId] },
    { cid: 'big', hall: '六号厅', start: '2026-11-13T09:00', end: '2026-11-13T20:00', lux: 200, artworkIds: [segArtId] },
  ]});
  const ge = r.json.groupExceeded?.[0];
  ok(r.status === 422 && (!r.json.budgetExceeded || r.json.budgetExceeded.length === 0)
     && ge && ge.groupId === grpId && ge.overflow === 64400
     && ge.used === 26400 && ge.batchNeed === 138000 && ge.projected === 164400
     && ge.members.length === 1 && ge.members[0].artworkId === segArtId && ge.members[0].contribution === 164400,
     `组超限拒绝：指出组、成员贡献 ${ge?.members?.[0]?.contribution} 与超额量 ${ge?.overflow}`);
  st = await getState();
  ok(st.version === v, '组超限拒绝后版本不变');

  console.log('# 20. 调低组上限 + 结算更正 → 组缺口阻断后续启动（单件仍充足）');
  r = await call('PUT', `/api/groups/${grpId}`, { version: v, name: '巡展摄影共用额度', limit: 40000, memberIds: [segArtId] });
  ok(r.status === 200, '组上限调低到 40000（≥ 当前已用 26400）成功');
  v = r.json.version;
  let segCnow = r.json.slots.find((s) => s.id === segC.id);
  ok(!segCnow.blocked, '组 26400 + 6000 = 32400 ≤ 40000：C 仍可启动');
  // 更正 segA 为 120 分钟 × 300 = 36000：组基线变为 36000 + 12000 = 48000 > 40000
  r = await call('POST', `/api/slots/${segA.id}/correct`, { version: v, reason: '照度计复核：实测偏高', segments: [
    { start: '2026-11-10T09:00', end: '2026-11-10T11:00', lux: 300 },
  ]});
  ok(r.status === 200 && r.json.correction.after.exposure === 36000, '更正成功（14400→36000）');
  v = r.json.version;
  const blockedC2 = r.json.blockedAfterFinish.find((s) => s.id === segC.id);
  const gg = blockedC2?.blockedReason?.groupGaps?.[0];
  ok(!!blockedC2 && blockedC2.blockedReason.gaps.length === 0
     && gg && gg.groupId === grpId && gg.has === -8000 && gg.need === 6000 && gg.gap === 14000 && gg.memberCount === 1,
     `更正后按现有时序重算：C 被组缺口阻断（组可用 ${gg?.has} / 需 ${gg?.need} / 缺口 ${gg?.gap}）`);
  r = await call('POST', `/api/slots/${segC.id}/start`);
  ok(r.status === 422 && r.json.error?.code === 'BLOCKED' && r.json.blockedReason.groupGaps?.[0]?.gap === 14000,
     '组缺口时段禁止启动并返回组缺口');

  console.log('# 21. 组上限低于已用量：历史与进行中保留，仅阻止后续启动并展示缺口');
  r = await call('PUT', `/api/groups/${grpId}`, { version: v, name: '巡展摄影共用额度', limit: 20000, memberIds: [segArtId] });
  ok(r.status === 200, '组上限允许调低到已用量以下（20000 < 48000）');
  v = r.json.version;
  grp = r.json.groups.find((g) => g.id === grpId);
  ok(grp.used === 36000 && grp.reservedRunning === 12000 && grp.committed === 54000
     && grp.balance === -34000 && grp.over === true,
     `组余额为负并展示缺口（余额 ${grp?.balance}）`);
  ok(r.json.slots.find((s) => s.id === segA.id).status === 'finished'
     && r.json.slots.find((s) => s.id === segA.id).actualExposure === 36000
     && r.json.slots.find((s) => s.id === segB.id).status === 'running',
     '已结束历史与进行中状态保留不变');
  segCnow = r.json.slots.find((s) => s.id === segC.id);
  ok(segCnow.blocked && segCnow.blockedReason.groupGaps?.[0]?.gap === 34000,
     `仅后续未开始时段被阻止（组缺口 ${segCnow.blockedReason.groupGaps?.[0]?.gap}）`);

  console.log('# 22. 组配置版本冲突 + 删除组后重算恢复');
  r = await call('PUT', `/api/groups/${grpId}`, { version: 1, name: '巡展摄影共用额度', limit: 999999, memberIds: [segArtId] });
  ok(r.status === 409 && r.json.state.version === v, '组更新过期版本返回 409 与最新预算');
  st = await getState();
  ok(st.version === v && st.groups.find((g) => g.id === grpId).limit === 20000, '版本冲突失败不改版本与记录');
  r = await call('DELETE', `/api/groups/${grpId}`, { version: v });
  ok(r.status === 200 && !r.json.groups.some((g) => g.id === grpId), '额度组已删除');
  v = r.json.version;
  ok(!r.json.slots.find((s) => s.id === segC.id).blocked, '删除组后重算：C 恢复可启动（单件预算充足）');
  r = await call('DELETE', `/api/groups/${grpId}`, { version: v });
  ok(r.status === 404, '重复删除返回 404');

  console.log('# 23. 同一时段多件组内作品逐件计入');
  r = await call('POST', '/api/artworks', { version: v, name: '联展甲', limit: 1000000, existing: 0 });
  v = r.json.version;
  const artA = r.json.artworks.at(-1).id;
  r = await call('POST', '/api/artworks', { version: v, name: '联展乙', limit: 1000000, existing: 0 });
  v = r.json.version;
  const artB = r.json.artworks.at(-1).id;
  r = await call('POST', '/api/groups', { version: v, name: '联展共用额度', limit: 10000, memberIds: [artA, artB] });
  v = r.json.version;
  const duoGrp = r.json.groups.find((g) => g.name === '联展共用额度').id;
  // 同一时段联展两件：60 分钟 × 100 = 6000/件 → 组需求 12000 > 10000，整批拒绝
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'duo', hall: '七号厅', start: '2026-12-01T10:00', end: '2026-12-01T11:00', lux: 100, artworkIds: [artA, artB] },
  ]});
  ok(r.status === 422 && r.json.groupExceeded?.[0]?.batchNeed === 12000
     && r.json.groupExceeded?.[0]?.overflow === 2000,
     '同一时段两件组内作品逐件计入（需求 6000×2=12000，超 2000）');
  // 缩短为 40 分钟：4000/件 → 组需求 8000 ≤ 10000，保存成功且组预占按两件计
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'duo', hall: '七号厅', start: '2026-12-01T10:00', end: '2026-12-01T10:40', lux: 100, artworkIds: [artA, artB] },
  ]});
  ok(r.status === 200, '缩短后整批保存成功');
  v = r.json.version;
  const duo = r.json.groups.find((g) => g.id === duoGrp);
  ok(duo.reservedScheduled === 8000 && duo.balance === 2000, `组预占逐件计入（${duo.reservedScheduled} = 4000×2）`);
  // 清理：清空排期 → 删组 → 删作品
  r = await call('POST', '/api/schedule', { version: v, slots: [] });
  v = r.json.version;
  r = await call('DELETE', `/api/groups/${duoGrp}`, { version: v });
  v = r.json.version;
  r = await call('DELETE', `/api/artworks/${artA}`, { version: v });
  v = r.json.version;
  r = await call('DELETE', `/api/artworks/${artB}`, { version: v });
  ok(r.status === 200, '联展测试数据已清理');

  console.log('# 24. 计划外记录：录入校验（正时长 / 分段衔接覆盖 / 非负照度 / 作品）');
  st = await getState();
  v = st.version;
  r = await call('POST', '/api/artworks', { version: v, name: '计划外测试品', limit: 1000000, existing: 0 });
  ok(r.status === 200, '计划外测试作品已创建');
  const recArtId = r.json.artworks.at(-1).id;
  v = r.json.version;
  // 区间非正时长
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArtId,
    start: '2027-03-01T11:00', end: '2027-03-01T10:00',
    segments: [{ start: '2027-03-01T10:00', end: '2027-03-01T11:00', lux: 10 }] });
  ok(r.status === 422 && r.json.error.code === 'VALIDATION', '结束不晚于开始被拒绝');
  // 作品不存在
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: 987654,
    start: '2027-03-01T10:00', end: '2027-03-01T11:00',
    segments: [{ start: '2027-03-01T10:00', end: '2027-03-01T11:00', lux: 10 }] });
  ok(r.status === 422 && r.json.error.code === 'VALIDATION', '作品不存在被拒绝');
  // 分段缺口
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArtId,
    start: '2027-03-01T10:00', end: '2027-03-01T12:00',
    segments: [
      { start: '2027-03-01T10:00', end: '2027-03-01T11:00', lux: 10 },
      { start: '2027-03-01T11:30', end: '2027-03-01T12:00', lux: 10 }] });
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID' && r.json.segmentErrors.length, '分段缺口拒绝');
  // 负照度
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArtId,
    start: '2027-03-01T10:00', end: '2027-03-01T11:00',
    segments: [{ start: '2027-03-01T10:00', end: '2027-03-01T11:00', lux: -1 }] });
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID', '负照度拒绝');
  st = await getState();
  ok(st.version === v, '校验失败不推进版本');

  console.log('# 25. 计划外记录：与已有时段重叠（指出对象与区间）；不同作品允许');
  // 用专用作品搭建：一条已结束时段（演示 slot 1，作品 1，实际 2026-09-29 09:10–11:50）用于已结束冲突；
  // 再为本作品排两条时段，启动其中一条形成 进行中冻结 + 未开始。
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: 1,
    start: '2026-09-29T10:00', end: '2026-09-29T10:30',
    segments: [{ start: '2026-09-29T10:00', end: '2026-09-29T10:30', lux: 50 }] });
  ok(r.status === 422 && r.json.error.code === 'OVERLAP_CONFLICT'
    && r.json.conflicts[0].artworkId === 1 && r.json.conflicts[0].kind === 'record-slot-finished'
    && r.json.conflicts[0].other.slotId === 1
    && r.json.conflicts[0].other.start === '2026-09-29T09:10',
    '与已结束时段重叠：冲突指出作品、对象时段与区间');
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'rec-run', hall: '甲厅', start: '2027-03-02T09:00', end: '2027-03-02T10:00', lux: 10, artworkIds: [recArtId] },
    { cid: 'rec-sched', hall: '乙厅', start: '2027-03-03T09:00', end: '2027-03-03T10:00', lux: 10, artworkIds: [recArtId] },
  ]});
  ok(r.status === 200, '为重叠校验搭建两条排期');
  v = r.json.version;
  const runSlotId = r.json.slots.find((s) => s.plannedStart.startsWith('2027-03-02')).id;
  const schedSlotId = r.json.slots.find((s) => s.plannedStart.startsWith('2027-03-03')).id;
  r = await call('POST', `/api/slots/${runSlotId}/start`);
  ok(r.status === 200, '第一条启动为进行中（冻结）');
  v = r.json.version;
  // 与进行中冻结时段重叠
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArtId,
    start: '2027-03-02T09:30', end: '2027-03-02T09:45',
    segments: [{ start: '2027-03-02T09:30', end: '2027-03-02T09:45', lux: 50 }] });
  ok(r.status === 422 && r.json.conflicts[0].kind === 'record-slot-running'
    && r.json.conflicts[0].other.slotId === runSlotId, '与进行中冻结时段重叠被拒绝（指出时段与区间）');
  // 与未开始时段重叠
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArtId,
    start: '2027-03-03T09:30', end: '2027-03-03T09:45',
    segments: [{ start: '2027-03-03T09:30', end: '2027-03-03T09:45', lux: 50 }] });
  ok(r.status === 422 && r.json.conflicts[0].kind === 'record-slot-scheduled'
    && r.json.conflicts[0].other.slotId === schedSlotId,
    '与未开始时段重叠被拒绝（后续排期也不得覆盖有效记录）');
  // 同一区间不同作品允许（作品 2 在 2027-03-03 无任何时段）
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: 2, reasonKind: '布展',
    start: '2027-03-03T09:30', end: '2027-03-03T09:45',
    segments: [{ start: '2027-03-03T09:30', end: '2027-03-03T09:45', lux: 50 }] });
  ok(r.status === 200, '同区间不同作品允许（仅按同作品约束）');
  v = r.json.version;
  // 结束进行中的专用时段，避免占用后续预算；随后清空未开始排期
  r = await call('POST', `/api/slots/${runSlotId}/finish`, {
    actualStart: '2027-03-02T09:00', actualEnd: '2027-03-02T10:00', actualLux: 10,
  });
  ok(r.status === 200, '进行中专用时段已结束（600 lux·min）');
  v = r.json.version;
  r = await call('POST', '/api/schedule', { version: v, slots: [] });
  v = r.json.version;

  console.log('# 26. 计划外记录：有效曝光计入作品与额度组已用，余额可为负并重算阻断');
  // 清空前序可能残留的未开始排期，确保本测试的预算口径自包含
  r = await call('POST', '/api/schedule', { version: v, slots: [] });
  v = r.json.version;
  // 作品初始上限 20000：录 18000 后余额只剩 2000；再录大实耗把余额压成负（历史实耗允许）。
  r = await call('PUT', `/api/artworks/${recArtId}`, { version: v, name: '计划外测试品', limit: 20000, existing: 0 });
  ok(r.status === 200, '测试作品上限调整为 20000');
  v = r.json.version;
  // recArt：录一段 2027-01 多段：60*100 + 60*200 = 18000
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArtId, reasonKind: '搬运入库', note: 'e2e',
    start: '2027-01-10T09:00', end: '2027-01-10T11:00',
    segments: [
      { start: '2027-01-10T09:00', end: '2027-01-10T10:00', lux: 100 },
      { start: '2027-01-10T10:00', end: '2027-01-10T11:00', lux: 200 }] });
  ok(r.status === 200 && r.json.record.actualExposure === 18000 && r.json.record.segmentCount === 2
    && r.json.record.reasonKind === '搬运入库', `多段计划外记录有效曝光 ${r.json.record?.actualExposure}（应 18000）`);
  const recA = r.json.record.id;
  v = r.json.version;
  // recArt 刚结束的专用时段已贡献 600（actualExposure），故初始已用 = 600 + 18000 = 18600
  let recArt = r.json.artworks.find((a) => a.id === recArtId);
  ok(recArt.used === 18600 && recArt.unscheduledUsed === 18000,
    `作品已用含计划外有效曝光 ${recArt.used}（其中计划外 unscheduledUsed=${recArt.unscheduledUsed}，另含已结束时段 600）`);
  // 再录一段 2027-01-11，150 分钟 × 200 = 30000：历史实耗允许超过上限，余额被压成负数
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArtId, reasonKind: '布展',
    start: '2027-01-11T08:00', end: '2027-01-11T10:30',
    segments: [{ start: '2027-01-11T08:00', end: '2027-01-11T10:30', lux: 200 }] });
  ok(r.status === 200, '允许计划外实耗使余额为负（历史实耗不拒绝）');
  v = r.json.version;
  recArt = r.json.artworks.find((a) => a.id === recArtId);
  ok(recArt.used === 48600 && recArt.balance === -28600 && recArt.over === true,
    `历史实耗后作品余额为负 ${recArt.balance}（已用 ${recArt.used} = 600+18000+30000）`);
  // 负余额下排未来未开始时段（10 分钟 × 500 = 5000）：
  // 保存期硬预算只校验“既有 + 冻结时段 + 本批预占”，计划外实耗属既成历史、允许余额为负，
  // 因而草稿可保存；保存后由贪婪核算（含计划外记录）把该时段标为不可启动，启动返回 422。
  const futureSlotBody = () => ({ version: v, slots: [
    { cid: 'recblock', hall: '八号厅', start: '2027-02-01T10:00', end: '2027-02-01T10:10', lux: 500, artworkIds: [recArtId] },
  ]});
  r = await call('POST', '/api/schedule', futureSlotBody());
  ok(r.status === 200, '历史已超限额时草稿仍可保存（计划外实耗不硬拒绝整批；区间重叠才硬拒绝）');
  v = r.json.version;
  let blockedSlot = r.json.slots.find((s) => s.plannedStart.startsWith('2027-02-01'));
  // 贪婪核算（含计划外记录）：已用 48600 + 需求 5000 - 上限 20000 = 缺口 33600
  ok(blockedSlot.blocked && blockedSlot.blockedReason.gaps[0].gap === 33600
    && blockedSlot.blockedReason.gaps[0].has === -28600,
    `保存后按现有时序标为不可启动（可用 ${blockedSlot?.blockedReason?.gaps?.[0]?.has} / 缺口 ${blockedSlot?.blockedReason?.gaps?.[0]?.gap}，缺口应 33600）`);
  r = await call('POST', `/api/slots/${blockedSlot.id}/start`);
  ok(r.status === 422 && r.json.error.code === 'BLOCKED', '负余额时段启动被阻断（422）');

  // 更正把大实耗 30000 → 36000（+6000），缺口同步扩大到 39600（更正也重算）
  const bigRecId = (await getState()).exposureRecords
    .find((x) => x.artworkId === recArtId && x.actualStart === '2027-01-11T08:00').id;
  r = await call('POST', `/api/exposure-records/${bigRecId}/correct`, { version: v, reason: '复核照度偏高',
    segments: [{ start: '2027-01-11T08:00', end: '2027-01-11T10:30', lux: 240 }] });
  ok(r.status === 200 && r.json.change.after.exposure === 36000, '更正计划外记录（30000→36000）成功');
  v = r.json.version;
  const reblocked = r.json.blockedAfterChange.find((s) => s.id === blockedSlot.id);
  // 已用 600+18000+36000 = 54600；缺口 54600+5000-20000 = 39600
  ok(!!reblocked && reblocked.blockedReason.gaps[0].gap === 39600,
    `更正后缺口同步重算扩大：${reblocked?.blockedReason?.gaps?.[0]?.gap}（应 39600）`);

  // 作废 bigRec（36000 移出，保留 recA 供后续更正测试）：已用降到 18600，缺口 18600+5000-20000 = 3600
  r = await call('POST', `/api/exposure-records/${bigRecId}/void`, { version: v, reason: '大实耗误录，作废以观察缺口回落' });
  ok(r.status === 200 && r.json.change.after.exposure === 36000, '作废大实耗记录（36000 移出）');
  v = r.json.version;
  const afterVoidBlock = r.json.blockedAfterChange.find((s) => s.id === blockedSlot.id);
  ok(!!afterVoidBlock && afterVoidBlock.blockedReason.gaps[0].gap === 3600,
    `作废后缺口随已用同步回落：${afterVoidBlock?.blockedReason?.gaps?.[0]?.gap}（应 3600）`);
  // 放宽上限到 24000：18600+5000 = 23600 ≤ 24000，恢复可启动
  r = await call('PUT', `/api/artworks/${recArtId}`, { version: v, name: '计划外测试品', limit: 24000, existing: 0 });
  ok(r.status === 200, '放宽单件上限到 24000');
  v = r.json.version;
  blockedSlot = r.json.slots.find((s) => s.plannedStart.startsWith('2027-02-01'));
  ok(blockedSlot && !blockedSlot.blocked, '缺口消除：该时段恢复可启动（18600+5000 ≤ 24000）');
  // 清排期，便于后续组测试
  r = await call('POST', '/api/schedule', { version: v, slots: [] });
  v = r.json.version;

  console.log('# 27. 计划外记录：额度组计入与组缺口阻断');
  // bigRec 已作废；当前作品有效计划外 = 18000（recA），另加已结束时段 600 → 已用 18600
  r = await call('POST', '/api/groups', { version: v, name: '计划外共用组', limit: 20000, memberIds: [recArtId] });
  ok(r.status === 200, '为计划外测试作品建组（上限 20000）');
  v = r.json.version;
  let recGrp = r.json.groups.find((g) => g.name === '计划外共用组');
  ok(recGrp.used === 18600 && recGrp.unscheduledUsed === 18000 && recGrp.balance === 1400,
    `组已用计入成员计划外有效曝光 ${recGrp.used}（其中计划外 ${recGrp.unscheduledUsed}），组余额 ${recGrp.balance}`);
  // 调低组上限到 15000（< 组已用 18600，余额为负但历史与进行中保留）；单件上限 24000 仍有余量。
  // 保存通过，但贪婪核算仅以组缺口阻断。
  r = await call('PUT', `/api/groups/${recGrp.id}`, { version: v, name: '计划外共用组', limit: 15000, memberIds: [recArtId] });
  ok(r.status === 200, '调低组上限到 15000（低于组已用，允许负余额）');
  v = r.json.version;
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'gblock', hall: '九号厅', start: '2027-02-02T10:00', end: '2027-02-02T10:10', lux: 100, artworkIds: [recArtId] },
  ]});
  ok(r.status === 200, '单件预算充足、组为负：排期可保存');
  v = r.json.version;
  const gblockSlot = r.json.slots.find((s) => s.plannedStart.startsWith('2027-02-02'));
  const ggRec = gblockSlot.blockedReason.groupGaps[0];
  // 组已用 18600，需求 10*100=1000，上限 15000 → 缺口 18600+1000-15000 = 4600
  ok(gblockSlot.blocked && gblockSlot.blockedReason.gaps.length === 0
    && ggRec.groupName === '计划外共用组' && ggRec.gap === 4600,
    `后续时段仅被组缺口阻断（缺口 ${ggRec?.gap}，应 4600）`);
  // 清排期
  r = await call('POST', '/api/schedule', { version: v, slots: [] });
  v = r.json.version;

  console.log('# 28. 计划外记录：记录-记录重叠 / 首尾相接允许 / 作废记录不参与冲突');
  const recBaseStart = '2027-03-10T10:00', recBaseEnd = '2027-03-10T11:00';
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArtId, reasonKind: '布展',
    start: recBaseStart, end: recBaseEnd,
    segments: [{ start: recBaseStart, end: recBaseEnd, lux: 100 }] });
  ok(r.status === 200, '基础记录已录入（60*100=6000）');
  const recB = r.json.record.id;
  v = r.json.version;
  // 重叠
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArtId, reasonKind: '搬运',
    start: '2027-03-10T10:30', end: '2027-03-10T10:45',
    segments: [{ start: '2027-03-10T10:30', end: '2027-03-10T10:45', lux: 10 }] });
  ok(r.status === 422 && r.json.conflicts[0].kind === 'record-record'
    && r.json.conflicts[0].other.recordId === recB, '与其他有效记录重叠被拒绝（指出记录编号与区间）');
  // 首尾相接（11:00 起）允许
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArtId, reasonKind: '搬运',
    start: '2027-03-10T11:00', end: '2027-03-10T11:30',
    segments: [{ start: '2027-03-10T11:00', end: '2027-03-10T11:30', lux: 10 }] });
  ok(r.status === 200, '首尾相接（半开区间，end==start）允许');
  v = r.json.version;
  // 先作废 recB，再在其原区间登记应允许
  r = await call('POST', `/api/exposure-records/${recB}/void`, { version: v, reason: '误录作废' });
  ok(r.status === 200, 'recB 作废成功');
  v = r.json.version;
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: recArtId, reasonKind: '布展',
    start: recBaseStart, end: recBaseEnd,
    segments: [{ start: recBaseStart, end: recBaseEnd, lux: 100 }] });
  ok(r.status === 200, '作废记录不参与冲突：其原区间可重新登记');
  v = r.json.version;

  console.log('# 29. 计划外记录：更正沿用原区间、理由必填、替换不重复累计、留痕只增');
  // recA 区间 2027-01-10 09:00–11:00，当前 18000（100/200 两段）
  r = await call('POST', `/api/exposure-records/${recA}/correct`, { version: v,
    segments: [{ start: '2027-01-10T09:00', end: '2027-01-10T11:00', lux: 120 }] });
  ok(r.status === 422 && r.json.error.code === 'VALIDATION', '无理由更正拒绝');
  r = await call('POST', `/api/exposure-records/${recA}/correct`, { version: v, reason: 'x',
    segments: [{ start: '2027-01-10T09:00', end: '2027-01-10T10:00', lux: 120 }] });
  ok(r.status === 422 && r.json.error.code === 'SEGMENTS_INVALID', '更正分段未完整覆盖原区间被拒绝（区间沿用）');
  // 合法更正：120 分钟 * 50 = 6000 替换 18000
  const usedBefore = (await getState()).artworks.find((a) => a.id === recArtId).used;
  r = await call('POST', `/api/exposure-records/${recA}/correct`, { version: v, reason: '照度计复核：实测偏低',
    segments: [{ start: '2027-01-10T09:00', end: '2027-01-10T11:00', lux: 50 }] });
  ok(r.status === 200 && r.json.change.seqNo === 1
    && r.json.change.before.exposure === 18000 && r.json.change.after.exposure === 6000
    && r.json.change.before.segments.length === 2 && r.json.change.after.segments.length === 1
    && r.json.change.before.start === r.json.change.after.start,
    '更正保留前后曝光/分段/时间且区间沿用（18000→6000）');
  v = r.json.version;
  const usedAfter = r.json.artworks.find((a) => a.id === recArtId).used;
  ok(usedAfter === usedBefore - 12000, `新总量替换旧总量不重复累计：已用 ${usedBefore} → ${usedAfter}（差 -12000）`);
  // 再次更正（seqNo=2），历史累计
  r = await call('POST', `/api/exposure-records/${recA}/correct`, { version: v, reason: '二次复核',
    segments: [
      { start: '2027-01-10T09:00', end: '2027-01-10T10:00', lux: 40 },
      { start: '2027-01-10T10:00', end: '2027-01-10T11:00', lux: 60 }] });
  ok(r.status === 200 && r.json.change.seqNo === 2
    && r.json.change.after.exposure === 6000, '第二次更正成功（seqNo=2，40*60+60*60=6000）');
  v = r.json.version;

  console.log('# 30. 计划外记录：作废移出核算并同步重算；作废只读；409 语义');
  const usedPreVoid = (await getState()).artworks.find((a) => a.id === recArtId).used;
  // 排一个组上限内但依赖当前余额判断的未开始时段，观察作废后重算（这里直接验证已用下降 + 组余额恢复）
  r = await call('POST', `/api/exposure-records/${recA}/void`, { version: v });
  ok(r.status === 422 && r.json.error.code === 'VALIDATION', '无理由作废拒绝');
  r = await call('POST', `/api/exposure-records/${recA}/void`, { version: v, reason: '重复登记作废' });
  ok(r.status === 200 && r.json.change.changeType === 'void'
    && r.json.change.before.status === 'active' && r.json.change.after.status === 'void'
    && r.json.change.before.exposure === 6000, '带理由作废成功，保留前后值与理由');
  v = r.json.version;
  const usedPostVoid = r.json.artworks.find((a) => a.id === recArtId).used;
  ok(usedPostVoid === usedPreVoid - 6000, `作废移出已用量并同步重算：${usedPreVoid} → ${usedPostVoid}`);
  recGrp = r.json.groups.find((g) => g.name === '计划外共用组');
  ok(recGrp.used === usedPostVoid, '组已用同步重算');
  st = await getState();
  const recADto = st.exposureRecords.find((x) => x.id === recA);
  ok(recADto.status === 'void' && recADto.changes.length === 3
    && recADto.changes[2].changeType === 'void' && recADto.changes[2].reason === '重复登记作废',
    '作废记录归档保留，变动历史为 2 次更正 + 1 次作废（只增）');
  // 作废后只读
  r = await call('POST', `/api/exposure-records/${recA}/void`, { version: v, reason: 'x' });
  ok(r.status === 422 && r.json.error.code === 'ALREADY_VOID', '重复作废拒绝');
  r = await call('POST', `/api/exposure-records/${recA}/correct`, { version: v, reason: 'x',
    segments: [{ start: '2027-01-10T09:00', end: '2027-01-10T11:00', lux: 1 }] });
  ok(r.status === 422 && r.json.error.code === 'NOT_ACTIVE', '已作废记录不可更正');
  r = await call('POST', `/api/exposure-records/999999/void`, { version: v, reason: 'x' });
  ok(r.status === 404 && r.json.error.code === 'NOT_FOUND', '不存在记录返回 404');
  // 版本并发
  r = await call('POST', '/api/exposure-records', { version: 1, artworkId: recArtId,
    start: '2028-01-01T10:00', end: '2028-01-01T11:00',
    segments: [{ start: '2028-01-01T10:00', end: '2028-01-01T11:00', lux: 1 }] });
  ok(r.status === 409 && r.json.error.code === 'VERSION_STALE' && r.json.state.version === v,
    '计划外录入过期版本返回 409 与最新预算');
  r = await call('POST', `/api/exposure-records/${recB}/correct`, { version: 1, reason: 'x',
    segments: [{ start: recBaseStart, end: recBaseEnd, lux: 1 }] });
  ok(r.status === 409 && r.json.state.version === v, '更正/作废同样沿用版本冲突语义');
  st = await getState();
  ok(st.version === v, '冲突/校验失败不推进版本、不改变记录与预算');

  console.log('# 31. 计划外记录：列表 / 归档记录演示数据 / 反向阻断排期与结算');
  r = await call('GET', '/api/exposure-records?artworkId=3');
  ok(r.status === 200 && r.json.records.length >= 2, '列表可按作品过滤');
  const seedVoid = r.json.records.find((x) => x.status === 'void');
  ok(seedVoid && seedVoid.changes.some((c) => c.changeType === 'void') && seedVoid.actualExposure === 12000,
    '演示数据自带一条已作废归档记录（带作废留痕）');
  r = await call('GET', '/api/exposure-records?status=active');
  ok(r.json.records.every((x) => x.status === 'active'), 'status=active 只返回有效记录');
  // 反向：后续排期不得覆盖有效记录（recArt 在 2027-03-10 11:00–11:30 有一条有效记录）
  const keptActiveStart = '2027-03-10T11:00', keptActiveEnd = '2027-03-10T11:30';
  const keptRecId = (await getState()).exposureRecords
    .find((x) => x.artworkId === recArtId && x.status === 'active'
      && x.actualStart === keptActiveStart && x.actualEnd === keptActiveEnd).id;
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'coverrec', hall: '十号厅', start: '2027-03-10T11:10', end: '2027-03-10T11:20', lux: 10, artworkIds: [recArtId] },
  ]});
  ok(r.status === 422 && r.json.conflicts[0].kind === 'new-record'
    && r.json.conflicts[0].slotB.cid === `record#${keptRecId}`, '排期覆盖有效计划外记录被整批拒绝（指出记录与区间）');
  // 结束结算（finish/settle）实际区间撞上有效记录也拒绝。
  // 用一个干净的专用作品承载该记录与时段，避免 recArt 的负余额干扰“可启动”。
  r = await call('POST', '/api/artworks', { version: v, name: '结算冲突品', limit: 1000000, existing: 0 });
  ok(r.status === 200, '结算冲突测试作品已创建');
  const clashArtId = r.json.artworks.at(-1).id;
  v = r.json.version;
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: clashArtId, reasonKind: '布展',
    start: keptActiveStart, end: keptActiveEnd,
    segments: [{ start: keptActiveStart, end: keptActiveEnd, lux: 10 }] });
  ok(r.status === 200, '在专用作品上建立有效记录（与后续实际区间重叠用）');
  v = r.json.version;
  const clashRecId = r.json.record.id;
  r = await call('POST', '/api/schedule', { version: v, slots: [
    { cid: 'finrec', hall: '十一号厅', start: '2027-04-01T09:00', end: '2027-04-01T10:00', lux: 10, artworkIds: [clashArtId] },
  ]});
  ok(r.status === 200, '不与记录重叠的时段可排期');
  v = r.json.version;
  const finSlotId = r.json.slots.find((s) => s.plannedStart.startsWith('2027-04-01')).id;
  r = await call('POST', `/api/slots/${finSlotId}/start`);
  ok(r.status === 200, '该时段可启动（干净作品，预算充足）');
  v = r.json.version;
  // finish 时实际区间落在该作品有效记录 2027-03-10 11:00–11:30 → 拒绝
  r = await call('POST', `/api/slots/${finSlotId}/finish`, {
    actualStart: keptActiveStart, actualEnd: keptActiveEnd, actualLux: 10,
  });
  ok(r.status === 422 && r.json.error.code === 'OVERLAP_CONFLICT'
    && r.json.conflicts[0].kind === 'slot-record' && r.json.conflicts[0].other.recordId === clashRecId,
    '结束补记实际区间覆盖有效记录被拒绝（指出记录与区间）');
  // 多段结算同样拒绝
  r = await call('POST', `/api/slots/${finSlotId}/settle`, { version: v,
    actualStart: keptActiveStart, actualEnd: keptActiveEnd,
    segments: [{ start: keptActiveStart, end: keptActiveEnd, lux: 10 }] });
  ok(r.status === 422 && r.json.error.code === 'OVERLAP_CONFLICT', '多段结算实际区间覆盖有效记录被拒绝');
  st = await getState();
  ok(st.version === v, '结算被拒不推进版本');
  // 正常结束该时段（用回其自身区间，不撞记录）
  r = await call('POST', `/api/slots/${finSlotId}/finish`, {
    actualStart: '2027-04-01T09:00', actualEnd: '2027-04-01T10:00', actualLux: 10,
  });
  ok(r.status === 200, '不冲突的结束补记成功');
  v = r.json.version;

  console.log('# 32. 清理：删组；作品被已结束时段引用时不可删（保留历史）；无引用作品级联删除记录');
  const grpIdNow = (await getState()).groups.find((g) => g.name === '计划外共用组').id;
  r = await call('DELETE', `/api/groups/${grpIdNow}`, { version: v });
  ok(r.status === 200, '删除计划外共用组');
  v = r.json.version;
  // recArt / clashArt 都被已结束时段引用，按既有规则作品不可删除（历史完整保留）
  r = await call('DELETE', `/api/artworks/${recArtId}`, { version: v });
  ok(r.status === 409 && r.json.error.code === 'IN_USE', '被已结束时段引用的作品不可删除（记录与历史保留）');
  // 无时段引用的作品：删除时其计划外记录与留痕随外键级联删除
  r = await call('POST', '/api/artworks', { version: v, name: '纯记录作品', limit: 100000, existing: 0 });
  const cascadeArtId = r.json.artworks.at(-1).id;
  v = r.json.version;
  r = await call('POST', '/api/exposure-records', { version: v, artworkId: cascadeArtId, reasonKind: '布展',
    start: '2028-06-01T09:00', end: '2028-06-01T10:00',
    segments: [{ start: '2028-06-01T09:00', end: '2028-06-01T10:00', lux: 30 }] });
  const cascadeRecId = r.json.record.id;
  v = r.json.version;
  r = await call('POST', `/api/exposure-records/${cascadeRecId}/correct`, { version: v, reason: '复核',
    segments: [{ start: '2028-06-01T09:00', end: '2028-06-01T10:00', lux: 40 }] });
  ok(r.status === 200 && r.json.change.seqNo === 1, '纯记录作品的记录已更正（产生留痕）');
  v = r.json.version;
  r = await call('DELETE', `/api/artworks/${cascadeArtId}`, { version: v });
  ok(r.status === 200, '无时段引用的作品可删除');
  st = await getState();
  ok(!st.exposureRecords.some((x) => x.artworkId === cascadeArtId),
    '该作品的计划外记录已随作品级联删除');
  // 留痕也级联删除（直接查接口：被删记录不再出现，列表中无其变更）
  r = await call('GET', '/api/exposure-records');
  ok(!r.json.records.some((x) => x.id === cascadeRecId), '级联删除后记录与留痕均不存在于归档列表');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
