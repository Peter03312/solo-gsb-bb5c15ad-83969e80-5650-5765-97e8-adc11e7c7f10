# 巡展作品光照预算 Web 工作台

为巡展作品管理展期曝光预算的本地 Web 工具：Node.js + SQLite + 浏览器页面，单机本地运行。

- **作品维度**：录入展期曝光上限与既有累计量，实时显示已用 / 预占 / 余额（单位 lux·min）。
- **计划外受光（布展 / 搬运）**：作品可能在排期之外受光。工作人员可选**一件**作品，录入实际起止与**连续照度分段**，查看本次曝光与归档留痕。区间须为正时长、分段首尾衔接完整覆盖且照度非负；不得与该作品已有时段（未开始 / 进行中 / 已结束）或其他**有效**计划外记录重叠，后续排期与时段结算（实际区间）也不得覆盖有效记录。已归档记录只能**带理由更正分段**（区间沿用）或**作废**，每次变动保留前后值与理由。
- **额度组维度**：巡展中易损作品可共用一笔曝光额度。策展人维护组的名称、非负上限与成员（每件作品至多归属一组）；组已用 = 成员既有累计 + 已结束时段实际曝光 + 计划外有效记录曝光，预占 = 成员进行中（冻结）+ 未开始计划曝光，同一时段有多件组内作品时逐件计入。
- **时段维度**：为展厅时段录入起止时间、照度（lux）和展出作品，按 **实际经过分钟 × 照度** 计算曝光。
- **多段照度**：巡展现场实际照度可能随时间变化。进行中时段可按**实际起止 + 多段照度**结算，每段含起止与非负照度，曝光 = Σ（段内实际分钟 × 照度）；分段必须按时间顺序首尾衔接、无重叠且完整覆盖实际区间，否则**整批拒绝**。
- **整批排期**：未开始时段在草稿中统一编辑后整批提交；同一作品时段重叠、或“已用 + 预占”超上限（**单件上限与组上限须同时满足**）时 **拒绝整批**，逐条指出冲突作品与时段；组超限时指出组、各成员贡献与超额量。
- **生命周期**：时段开始即冻结原排期并保留预占；结束时补记实际起止与照度（单一或多段），**实际曝光替换该时段预占**；结算超量后按开始时间/编号顺序标出不可启动时段与缺口并禁止启动。
- **结算更正**：已结束时段可凭理由提交**完整分段更正**（起止沿用原实际区间），系统记录更正前后的曝光、时间与分段；**新总量替换旧总量，不重复累计**，并同步重算作品已用量、后续时段不可启动状态与缺口；更正历史只增不改。
- **组配置调整**：结算、更正或调整组配置后，按现有时序重算余额与不可启动时段；组上限调低到已用量以下时仍保留历史及进行中状态，仅阻止后续启动并展示缺口。
- **计划外记录生命周期**：`active` 有效记录计入已用量；只能**带理由更正分段**（实际起止沿用原值）或**作废**为 `void`（归档保留、只读、移出核算）。更正 / 作废 / 录入都写入只增不改的变动留痕（前后状态、起止、照度、分钟数、曝光与完整分段），并按现有时序重算未开始时段的缺口与启动阻断。计划外实耗允许把作品 / 组余额压成负数（历史实耗保留）。
- **乐观并发**：所有调整（含多段结算、更正、组配置与计划外记录的录入 / 更正 / 作废）携带当前版本号，过期版本返回 409 与最新预算，失败不改变结算、记录与版本。

## 一键启动（Docker Compose，推荐）

```bash
docker compose up -d --build
```

启动后打开：

- **页面地址**：http://localhost:8080
- 初始化：首次启动自动建表并写入演示数据（3 件作品 + 已结束/进行中/未开始时段 + 计划外曝光记录：
  《青铜纹样》摄影一条有效「搬运入库」多段记录 8400 lux·min、一条已作废的误录记录）。

如需更换宿主机端口：

```bash
PORT=9090 docker compose up -d --build   # 页面变为 http://localhost:9090
```

停止与重置初始数据：

```bash
docker compose down            # 停止，数据保留在命名卷中
docker compose down -v         # 同时删除数据卷，下次启动重新初始化
```

## 本地直接运行（需要 Node.js ≥ 20）

```bash
npm install
npm start
# 打开 http://localhost:8080
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址（本地直跑可设 `127.0.0.1`） |
| `DB_PATH` | `./data/lightbudget.db`（Docker 内为 `/app/data/lightbudget.db`） | SQLite 数据库文件路径；文件不存在时自动建库并初始化 |

## 计算与校验规则

- **曝光量** = （结束 − 开始，分钟）× 照度 lux，单位 **lux·min**。
- **多段结算曝光量** = Σ各段（段结束 − 段开始，分钟）× 该段照度；每段照度须为非负数。
- **分段完整性**（多段结算 / 更正共用）：
  1. 每段时间格式合法、结束晚于开始、照度非负；
  2. 分段按时间顺序排列，第 *n* 段开始必须等于第 *n−1* 段结束（首尾衔接、无缺口、无重叠）；
  3. 首段开始 = 实际区间开始、末段结束 = 实际区间结束（完整覆盖）。
  
  任一条不满足返回 `422 SEGMENTS_INVALID`，`segmentErrors` 逐条说明，整批不落库。
- **已用** = 作品既有累计量 + 所有已结束时段的**实际**曝光（多段结算取分段求和值；更正后为最新总量，旧值不保留在累计中）**+ 有效（`active`）计划外记录曝光**（已作废 `void` 记录不计入）。
- **预占** = 进行中时段的（冻结）计划曝光 + 所有未开始时段的计划曝光之和。
- **余额** = 上限 − 已用 − 预占；余额为负即超量。计划外实耗 / 更正可使余额为负，历史实耗保留不回退。
- **额度组**：
  - 组有名称（唯一）、非负上限与成员列表；**每件作品至多归属一组**，重复或不存在的成员一律拒绝；
  - **组已用** = 各成员（既有累计 + 已结束时段实际曝光）之和；**组预占** = 各成员（进行中冻结计划 + 未开始计划曝光）之和；
  - **同一时段有多件组内作品时逐件计入**：该时段曝光按组内成员数重复累计（与单件口径一致）；
  - 组上限允许调低到已用量以下：历史（已结束）与进行中状态保留不变，仅后续未开始时段被阻止启动，组余额显示为负缺口。
- 排期整批保存时校验：
  1. 时间格式合法、结束晚于开始、照度/累计量非负（无效时序或负值一律拒绝）；
  2. 同一作品在任意两个未开始时段、以及与进行中（冻结区间）/已结束（实际区间）时段之间不得重叠；
  3. 每件作品「既有 + 已结束实际 + 进行中预占 + 本批未开始预占」不得超过展期上限；
  4. 每个额度组「组已用 + 进行中预占 + 本批未开始预占（逐件计入）」不得超过组上限。
- 任一条不满足则整批不落库，响应中给出作品、冲突时段对或超量数值；组超限时给出组、各成员贡献与超额量。
- **结算更正规则**：
  - 仅 `finished` 时段可更正；更正必须带 `reason`（1–500 字）；
  - 更正分段的实际起止**沿用该时段原实际起止**（更正只调整照度分段，不改变展出区间）；
  - 每次更正写一条 `slot_corrections` 记录：理由、更正前后起止/照度/分钟数/曝光/完整分段、时间戳与序号（只增不改）；
  - 新总量**替换**旧总量（不重复累计），随后重算作品已用量、未开始时段不可启动标记与缺口；
  - 更正同样需要携带当前版本，过期返回 409 与最新预算。
- **不可启动核算**：每次调整/启动/结算/更正/组配置变更/计划外记录变动后，未开始时段按开始时间（再按编号）顺序尝试占用预算；任一关联作品余额不足、或所属额度组余额不足，即标记为“不可启动”并列出每件作品 / 每个组的可用余额、需求与缺口，启动接口对该时段返回 422。调整排期保存后自动重新核算。
- **计划外曝光记录规则**（布展 / 搬运等排期外受光）：
  - 每条记录针对**一件**作品（`artworkId`），含事由 `reasonKind`、备注 `note`、实际起止与连续照度分段；
  - 区间必须为**正时长**（结束严格晚于开始）；分段校验与多段结算 / 更正完全一致（逐段正时长、照度非负、首尾衔接、完整覆盖），任一不满足返回 `422 SEGMENTS_INVALID`，`segmentErrors` 逐条说明、整批不落库；
  - **不重叠**：同一作品的有效记录不得与下列区间重叠（半开区间，首尾相接 `end == start` 允许）——
    1. 该作品的已结束时段（按实际区间）、进行中时段（按冻结计划区间）、未开始时段（按计划区间）；
    2. 该作品的其他**有效**计划外记录（已作废记录不参与冲突、其区间可重新登记）；
    
    违反返回 `422 OVERLAP_CONFLICT`，`conflicts` 逐条给出作品、本次区间与冲突对象（时段或记录）及其区间；
  - **双向约束**：整批保存未开始排期、或时段结束（`finish` / `settle`）时的实际区间，若覆盖某作品的有效记录，同样以 `OVERLAP_CONFLICT` 拒绝（后续排期 / 结算不得覆盖有效记录）；
  - **更正**（`POST /api/exposure-records/:id/correct`）：仅 `active` 记录可更正，必须带 1–500 字 `reason`；提交的分段必须完整覆盖**原实际区间**（更正只改照度分段，区间沿用）；新总量替换旧总量（不重复累计）；
  - **作废**（`POST /api/exposure-records/:id/void`）：必须带 1–500 字 `reason`；记录变为 `void`，归档保留、只读（不可再更正 / 再作废），其曝光移出作品与组已用，区间随之释放；
  - 每次更正 / 作废写一条 `exposure_record_changes`：变更类型、序号、理由、时间戳，以及前后**状态 / 起止 / 照度 / 分钟数 / 曝光 / 完整分段**（只增不改）；
  - 录入 / 更正 / 作废都携带当前 `version`，过期返回 `409 VERSION_STALE` 与最新预算；**校验失败不推进版本、不改变记录与预算**。
- **并发版本**：每次成功变更版本号 +1。请求必须携带当前 `version`；不匹配时返回 `409 VERSION_STALE` 与最新完整预算，前端自动刷新后需重新调整提交。**校验失败不会推进版本、不改变任何结算数据。**

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 最新版本、作品预算汇总、**额度组预算汇总（`groups`）**、全部时段（含 `actualSegments` 与 `corrections` 更正历史）及不可启动核算结果 |
| POST | `/api/artworks` | 录入作品（body 带 `version`） |
| PUT | `/api/artworks/:id` | 修改作品上限/既有量等 |
| DELETE | `/api/artworks/:id` | 删除作品（被时段引用或属于额度组时拒绝） |
| POST | `/api/groups` | **新建额度组**：`{version, name, limit, memberIds:[作品id...]}` |
| PUT | `/api/groups/:id` | **修改额度组**名称/上限/成员（整组替换成员列表） |
| DELETE | `/api/groups/:id` | **删除额度组**（成员作品与历史记录保留） |
| POST | `/api/schedule` | **整批替换未开始时段**（body：`{version, slots:[...]}`；单件与组上限同时校验） |
| POST | `/api/slots/:id/start` | 启动时段：冻结原排期、保留预占 |
| POST | `/api/slots/:id/finish` | 结束补记（单一照度，兼容语义不变）：`{actualStart, actualEnd, actualLux}`，实际曝光替换预占并重新核算 |
| POST | `/api/slots/:id/settle` | **多段照度结算（进行中时段）**：`{version, actualStart, actualEnd, segments:[{start,end,lux}]}` |
| POST | `/api/slots/:id/correct` | **已结束时段完整分段更正**：`{version, reason, segments:[{start,end,lux}]}`，起止须完整覆盖原实际区间 |
| GET | `/api/exposure-records` | **计划外曝光记录列表**（可 `?artworkId=3&status=active|void` 过滤；无需版本） |
| POST | `/api/exposure-records` | **登记计划外受光**（单件作品）：`{version, artworkId, reasonKind, note, start, end, segments:[{start,end,lux}]}` |
| POST | `/api/exposure-records/:id/correct` | **计划外记录分段更正**：`{version, reason, segments}`，区间沿用原实际起止 |
| POST | `/api/exposure-records/:id/void` | **计划外记录作废**：`{version, reason}`，归档保留并移出核算 |

`GET /api/state` 中作品 / 额度组新增 `unscheduledUsed` 字段（有效计划外记录曝光之和；组为成员求和），并新增顶层 `exposureRecords` 数组。计划外记录 DTO 字段：

- `id` / `artworkId` / `artworkName` / `reasonKind` / `note` / `createdAt`；
- `status`：`active` 有效 / `void` 已作废（另有便捷布尔 `active`）；
- `actualStart` / `actualEnd` / `actualMinutes` / `actualExposure` / `actualLux`（仅单段有值，多段为 `null`）；
- `actualSegments`：`[{start,end,lux,minutes,exposure}]` 完整分段，`segmentCount` 为段数；
- `changes`：变动留痕数组，每条含 `seqNo`、`changeType`（`correct` / `void`）、`reason`、`createdAt` 与 `before` / `after`
  （各自含 `status, start, end, lux, minutes, exposure, segments`）。

录入 / 更正 / 作废成功返回与 `/api/state` 同构的完整预算，并附带 `record`（本次记录）或 `change`（本次变动）以及
`blockedAfterChange`（变动后被标为不可启动的未开始时段数组，含缺口）。重叠冲突响应形如：

```json
{
  "error": { "code": "OVERLAP_CONFLICT", "message": "计划外记录已拒绝：与同作品已有时段或有效计划外记录重叠" },
  "conflicts": [{
    "artworkId": 1, "artworkName": "《山水轴》纸本水墨",
    "kind": "record-slot-finished",
    "record": { "kind": "new-record", "reasonKind": "布展", "start": "...", "end": "...", "label": "..." },
    "other":  { "kind": "slot", "slotId": 1, "slotStatus": "finished", "hall": "一号厅", "start": "...", "end": "...", "label": "..." }
  }]
}
```

`kind` 取值：记录↔时段 `record-slot-scheduled` / `record-slot-running` / `record-slot-finished`，记录↔记录 `record-record`；
排期 / 结算反向覆盖记录时为 `new-record`（整批排期）或 `slot-record`（结束结算）。

`GET /api/state` 中额度组（`groups`）的字段：

- `id` / `name` / `limit`：组编号、名称、组上限；
- `members`：`[{id, name}]` 成员作品；
- `used` / `reserved`（含 `reservedRunning` / `reservedScheduled`）/ `committed` / `balance` / `over`：
  与作品同口径的组级汇总（成员求和，同一时段多件组内作品逐件计入）。

时段 `blockedReason` 在原有 `gaps`（单件缺口）之外新增 `groupGaps`（组缺口）：
`[{groupId, groupName, has, need, gap, memberCount}]`，其中 `need` 已按组内成员数逐件计入。

`GET /api/state` 中已结束时段的字段：

- `actualStart` / `actualEnd` / `actualMinutes` / `actualExposure`：实际区间与总量；
- `actualLux`：仅单段时为该段照度，多段时为 `null`；
- `actualSegments`：`[{start,end,lux,minutes,exposure}, ...]` 完整分段；
- `corrections`：更正历史数组，每条含 `seqNo`、`reason`、`createdAt` 与 `before`/`after`（各自含 `start,end,lux,minutes,exposure,segments`）。

## HTTP 调用示例（多段结算 / 更正）

以下示例使用初始演示数据（`http://localhost:8080`）。先取当前版本：

```bash
curl -s http://localhost:8080/api/state            # 读取 "version"
```

### 1. 多段照度结算（进行中时段 → 已结束）

把进行中的时段 #2（计划 2026-09-30 09:00–13:00）按三段实测照度结算：
09:00–11:00 为 180 lux（120 分）、11:00–12:30 为 240 lux（90 分）、12:30–13:00 闭灯为 0 lux（30 分）。
曝光 = 120×180 + 90×240 + 30×0 = 43200 lux·min。

```bash
curl -s -X POST http://localhost:8080/api/slots/2/settle \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 1,
    "actualStart": "2026-09-30T09:00",
    "actualEnd":   "2026-09-30T13:00",
    "segments": [
      {"start": "2026-09-30T09:00", "end": "2026-09-30T11:00", "lux": 180},
      {"start": "2026-09-30T11:00", "end": "2026-09-30T12:30", "lux": 240},
      {"start": "2026-09-30T12:30", "end": "2026-09-30T13:00", "lux": 0}
    ]
  }'
```

成功返回完整最新预算（与 `/api/state` 同构），并附带：

```json
{
  "version": 2,
  "justFinishedExposure": 43200,
  "justFinishedMinutes": 240,
  "justFinishedSegments": [ {"start": "...", "end": "...", "lux": 180, "minutes": 120, "exposure": 21600}, "..."],
  "settlement": { "actualStart": "...", "actualEnd": "...", "actualMinutes": 240, "actualExposure": 43200, "segments": ["..."] },
  "blockedAfterFinish": [ {"id": 3, "blockedReason": {"gaps": ["..."]}} ]
}
```

分段有缺口 / 重叠 / 未覆盖 / 负照度时：

```json
HTTP 422
{ "error": {"code": "SEGMENTS_INVALID", "message": "分段结算已拒绝：..."},
  "segmentErrors": ["第 2 段开始 2026-09-30T11:10 必须与第 1 段结束 2026-09-30T11:00 首尾衔接（无重叠、无缺口）"] }
```

### 2. 已结束时段分段更正

对已结束的时段 #1 提交带理由的完整分段更正（起止沿用原实际区间 09:10–11:50）：

```bash
curl -s -X POST http://localhost:8080/api/slots/1/correct \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 2,
    "reason": "照度计复核：布光阶段 100 lux，巡场调亮后 170 lux",
    "segments": [
      {"start": "2026-09-29T09:10", "end": "2026-09-29T10:30", "lux": 100},
      {"start": "2026-09-29T10:30", "end": "2026-09-29T11:50", "lux": 170}
    ]
  }'
```

返回最新预算与本次更正记录（`correction.before/after` 含更正前后曝光、分钟数与完整分段），
时段的 `corrections` 历史追加一条；作品已用量、后续时段 `blocked` 与缺口已按新总量重算。

错误情况：

- 分段未完整覆盖原实际区间 / 衔接失败 / 负照度 → `422 SEGMENTS_INVALID`（`segmentErrors` 逐条说明）；
- 缺少理由 → `422 VALIDATION`；
- 时段不是 `finished` → `422 NOT_FINISHED`；
- 版本过期 → `409 VERSION_STALE`，响应带 `state`（最新完整预算）；用其中的 `version` 重试即可。

### 3. 单一照度结算（原接口，语义不变）

```bash
curl -s -X POST http://localhost:8080/api/slots/2/finish \
  -H 'Content-Type: application/json' \
  -d '{"actualStart": "2026-09-30T09:00", "actualEnd": "2026-09-30T13:00", "actualLux": 300}'
```

> `finish` 仍为原有无版本、单照度结算与返回语义（`justFinishedExposure`、`blockedAfterFinish`）；
> 内部以单段形式保存，因此该时段之后同样可以用 `/correct` 做多段更正。

## HTTP 调用示例（曝光额度组）

以下示例基于初始演示数据（`http://localhost:8080`）：演示组 **#1「纸本联展共用额度」**（上限 300000，
成员为《山水轴》《星夜手稿》）。所有组配置接口与作品接口一样携带 `version`，
过期返回 `409 VERSION_STALE` 与最新预算；校验失败不改版本与任何记录。

### 1. 新建额度组

```bash
curl -s -X POST http://localhost:8080/api/groups \
  -H 'Content-Type: application/json' \
  -d '{"version": 1, "name": "摄影联展共用额度", "limit": 80000, "memberIds": [3]}'
```

- `memberIds` 中**重复、不存在、或已归属其他组**的作品都会返回 `422 VALIDATION`（每件作品至多归属一组；
  例如演示数据中作品 1、2 已属组 #1，直接再入其他组会被拒绝）；
- 成功返回完整最新预算，`groups` 数组中包含新组的 `used / reserved / committed / balance` 聚合值。

### 2. 修改组配置（名称 / 上限 / 成员）

```bash
curl -s -X PUT http://localhost:8080/api/groups/1 \
  -H 'Content-Type: application/json' \
  -d '{"version": 2, "name": "纸本联展共用额度", "limit": 150000, "memberIds": [1, 2]}'
```

- 上限允许调低到当前已用量以下：历史（已结束）与进行中状态保留，仅后续未开始时段被阻止启动；
  响应中该组 `balance` 为负（缺口），受影响时段的 `blockedReason.groupGaps` 给出组缺口，例如：

```json
{ "groupId": 1, "groupName": "纸本联展共用额度", "has": -400, "need": 21600, "gap": 22000, "memberCount": 1 }
```

### 3. 整批排期的组上限校验

整批保存未开始排期时，**单件上限与组上限须同时满足**。下面的批次单件预算充足，
但两件组内作品同批排期使组预占超限（同一时段多件组内作品逐件计入），整批拒绝：

```bash
curl -s -X POST http://localhost:8080/api/schedule \
  -H 'Content-Type: application/json' \
  -d '{"version": 3, "slots": [
        {"cid": "duo", "hall": "四号厅", "start": "2026-10-05T10:00", "end": "2026-10-05T11:00",
         "lux": 100, "artworkIds": [1, 2]}
      ]}'
```

```json
HTTP 422
{ "error": {"code": "BATCH_REJECTED", "message": "整批已拒绝：有作品或额度组预占后将超过上限"},
  "groupExceeded": [{
    "groupId": 1, "groupName": "纸本联展共用额度", "limit": 150000,
    "used": 150400, "batchNeed": 12000, "projected": 162400, "overflow": 12400,
    "members": [
      {"artworkId": 1, "artworkName": "《山水轴》纸本水墨", "contribution": 88400},
      {"artworkId": 2, "artworkName": "《星夜手稿》水彩", "contribution": 74000}
    ]
  }]
}
```

> `used` = 成员既有累计 + 已结束实际 + 进行中预占；`batchNeed` = 本批新增预占（同一时段两件成员计 6000×2）；
> `members[].contribution` 为各成员对 `projected` 的贡献，合计即 `projected`。
> 单件超限时仍返回原有的 `budgetExceeded`，两者可同时出现。

### 4. 删除额度组

```bash
curl -s -X DELETE http://localhost:8080/api/groups/1 \
  -H 'Content-Type: application/json' -d '{"version": 3}'
```

> 上一步整批拒绝不会推进版本，因此此处仍为 `version: 3`。

删除后成员作品与全部历史记录保留，余额与不可启动时段按现有时序重算。

## HTTP 调用示例（计划外曝光记录 / 布展 · 搬运）

巡展布展或搬运时，作品可能在排期之外受光。以下示例基于初始演示数据（`http://localhost:8080`）。
所有变更接口与其他调整一样携带 `version`，过期返回 `409 VERSION_STALE` 与最新预算；校验失败不改版本、记录与预算。
初始数据已含《青铜纹样》摄影的一条**有效**搬运入库记录（8400 lux·min）和一条**已作废**的误录记录。

### 1. 查看记录（可按作品 / 状态过滤）

```bash
curl -s 'http://localhost:8080/api/exposure-records'                       # 全部
curl -s 'http://localhost:8080/api/exposure-records?artworkId=3'           # 仅作品 #3
curl -s 'http://localhost:8080/api/exposure-records?artworkId=3&status=active'
```

### 2. 登记一次布展受光（单件作品 + 连续照度分段）

先取当前版本，再为作品 #3 登记 2026-10-10 夜间布展：20:00–21:00 为 100 lux，21:00–22:00 调亮到 200 lux
（曝光 = 60×100 + 60×200 = 18000 lux·min）：

```bash
V=$(curl -s http://localhost:8080/api/state | node -pe "JSON.parse(require('fs').readFileSync(0)).version")
curl -s -X POST http://localhost:8080/api/exposure-records \
  -H 'Content-Type: application/json' \
  -d "{
    \"version\": $V,
    \"artworkId\": 3,
    \"reasonKind\": \"布展\",
    \"note\": \"夜间预布光\",
    \"start\": \"2026-10-10T20:00\",
    \"end\":   \"2026-10-10T22:00\",
    \"segments\": [
      {\"start\": \"2026-10-10T20:00\", \"end\": \"2026-10-10T21:00\", \"lux\": 100},
      {\"start\": \"2026-10-10T21:00\", \"end\": \"2026-10-10T22:00\", \"lux\": 200}
    ]
  }"
```

成功返回完整最新预算，并附带本次记录与受影响的未开始时段：

```json
{
  "version": 2,
  "record": { "id": 3, "artworkId": 3, "status": "active",
    "actualStart": "2026-10-10T20:00", "actualEnd": "2026-10-10T22:00",
    "actualMinutes": 120, "actualExposure": 18000, "segmentCount": 2,
    "actualSegments": [ {"start": "...", "end": "...", "lux": 100, "minutes": 60, "exposure": 6000}, "..."] },
  "blockedAfterChange": [ {"id": 3, "blockedReason": {"gaps": [], "groupGaps": []}} ]
}
```

该 18000 lux·min 立即计入作品 #3 及其所属额度组的 `used`（演示中作品 #3 不属于任何组）。

错误情况：

- 区间非正时长 / 作品不存在 → `422 VALIDATION`；
- 分段缺口、重叠、未覆盖、照度为负 → `422 SEGMENTS_INVALID`（`segmentErrors` 逐条说明）；
- 与该作品已有时段或其他有效记录重叠 → `422 OVERLAP_CONFLICT`（`conflicts` 指出作品、本次区间与冲突对象区间）；
- 版本过期 → `409 VERSION_STALE`（响应带 `state`，用其中 `version` 重试）。

```bash
# 例：与作品 #1 已结束时段（2026-09-29 09:10–11:50）重叠 → 422 OVERLAP_CONFLICT
curl -s -X POST http://localhost:8080/api/exposure-records -H 'Content-Type: application/json' -d '{
  "version": 2, "artworkId": 1, "reasonKind": "布展",
  "start": "2026-09-29T10:00", "end": "2026-09-29T10:30",
  "segments": [{"start": "2026-09-29T10:00", "end": "2026-09-29T10:30", "lux": 50}]}'
```

### 3. 更正分段（带理由，区间沿用原实际起止）

```bash
curl -s -X POST http://localhost:8080/api/exposure-records/3/correct \
  -H 'Content-Type: application/json' \
  -d '{
    "version": 2,
    "reason": "照度计复核：开场调暗、随后恢复",
    "segments": [
      {"start": "2026-10-10T20:00", "end": "2026-10-10T22:00", "lux": 120}
    ]
  }'
```

- 分段必须完整覆盖**原实际区间**（20:00–22:00），否则 `422 SEGMENTS_INVALID`；更正不改变展出区间；
- 返回 `change.before / change.after`（前后状态、曝光、分钟数、完整分段），新总量（120 分 × 120 = 14400）**替换**旧总量（18000）；
- 作品 / 组已用量、后续未开始时段的 `blocked` 与缺口同步重算；记录 `changes` 留痕追加一条（只增不改）。

### 4. 作废（带理由，归档保留、移出核算）

```bash
curl -s -X POST http://localhost:8080/api/exposure-records/3/void \
  -H 'Content-Type: application/json' \
  -d '{"version": 3, "reason": "复核为隔壁展厅灯光，非本作品受光"}'
```

- 记录变为 `void`：仍在列表中可见（`?status=void`），但只读、不可再更正 / 再作废；
- 其曝光移出作品与额度组已用量，区间随之释放（可在该区间重新登记），未开始时段缺口 / 阻断同步重算；
- 作废动作本身也写一条 `changes`（`changeType: "void"`，含理由与作废前后快照）。

### 5. 后续排期 / 结算不得覆盖有效记录（反向约束）

```bash
# 未开始排期覆盖作品 #3 的有效记录区间 → 整批拒绝（conflicts.kind = "new-record"）
curl -s -X POST http://localhost:8080/api/schedule -H 'Content-Type: application/json' -d '{
  "version": 4, "slots": [
    {"cid": "cover", "hall": "四号厅", "start": "2026-10-10T21:00", "end": "2026-10-10T21:30",
     "lux": 100, "artworkIds": [3]}
  ]}'
# → HTTP 422 BATCH_REJECTED，conflicts 指出冲突对象为「计划外记录 #3」与其区间
```

进行中时段结束（`/api/slots/:id/finish` 或 `/settle`）时，若补记的**实际区间**撞上同作品有效记录，
返回 `422 OVERLAP_CONFLICT`（`conflicts.kind = "slot-record"`），不改变时段、预算与版本。

## 页面用法

- **额度组**：「曝光额度组」卡片展示各组成员、上限、已用 / 预占 / 余额；点击 **＋ 新建额度组** 或行内 **编辑**
  可维护名称、上限与成员（已归属其他组的作品在成员列表中禁用）；**删除** 仅解除共用额度，作品与历史保留。
  作品表新增「额度组」列标识每件作品所属组。
- **阻断原因**：未开始排期中被标记「不可启动」的行下方列出缺口明细——既包括单件作品缺口，
  也包括额度组缺口（组可用余额、本时段需求与缺口）；启动被拦截时 Toast 同样展示。
- **结束进行中时段**：在「进行中 / 已结束时段」点击 **结束补记**，弹窗内可切换
  「单一照度结算 / 多段照度结算」；多段模式下逐段填写起止与照度，弹窗实时显示各段时长/曝光与总量，
  提交时服务端再次校验衔接与覆盖。
- **查看分段与更正历史**：已结束时段点击 **分段/更正** 展开，展示实际照度分段与历次更正
  （理由、更正前后曝光与时间）。
- **更正已结束时段**：点击 **分段更正**，弹窗预填当前分段并显示原实际区间与更正前曝光，
  调整分段、填写理由后提交；成功后页面刷新作品已用量、缺口与不可启动标记。

### 计划外曝光记录（布展 / 搬运）

- 「**计划外曝光记录（布展 / 搬运）**」卡片列出全部记录，可按**作品**与**状态**（有效 / 已作废）筛选；
  作品表与额度组表的「已用」列在含计划外曝光时额外显示「计划外 …」小计。
- 点击 **＋ 登记计划外受光**：选择**单件**作品、填写事由 / 实际起止，逐段维护连续照度
  （单段时分段自动跟随区间起止；多段时手动添加），弹窗实时显示总时长与本次曝光；提交时服务端再次校验正时长、
  分段衔接 / 覆盖 / 非负照度，以及与已有时段、其他有效记录的重叠。
- 成功后 Toast 提示本次曝光已计入作品与额度组；若使后续未开始时段出现缺口，会逐时段列出缺口明细。
- 有效记录行可 **分段/留痕**（展开查看照度分段与历次更正 / 作废的理由及前后值）、
  **分段更正**（弹窗显示原实际区间与更正前曝光，区间沿用、理由必填）、**作废**（理由必填，二次确认）。
- 已作废记录置灰、删除线展示并标记「已作废」，仅保留归档与留痕，不再出现更正 / 作废按钮。


## 快速体验超量拦截

初始演示数据以 2026-09-30 为当天，预算均充足。进入页面：

1. 对「一号厅 09:00–13:00（进行中）」点 **结束补记**；
2. 把实际照度改为 `300`（240 分钟 × 300 = 72000 lux·min），保存；
3. 后续二号厅时段会被标记为 **不可启动**，页面列出《山水轴》《星夜手稿》的缺口，启动按钮被禁止；
4. 在未开始排期草稿中缩短时长 / 降低照度 / 改展作品后 **整批校验并保存**，缺口消除即可重新启动。

体验**组维度阻断**：把演示组「纸本联展共用额度」上限改为 `150000`（低于当前组已用+预占 199000），
保存后组余额显示负缺口，两件纸本作品的后续未开始时段即因组缺口被禁止启动；
将上限调回或调整排期后恢复。
