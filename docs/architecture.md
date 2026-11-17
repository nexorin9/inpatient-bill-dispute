# 架构、状态机与审计链

本文是 `README.md` 架构章节的展开。核心原则只有一条：**模型与规则产出的永远是草稿，
收费员确认是唯一放行闸门**。所有分层都围绕这条边界组织。

## 分层

```
┌─────────────────────────────────────────────────────────────┐
│ src/renderer/     收费员工作台（无 Node 权限，只调 desktopAPI） │
│   设计 token / 三态 / toast / 自定义模态 / 引用折叠 / 设置页    │
└───────────────────────────┬─────────────────────────────────┘
                            │ preload.cjs · contextBridge 白名单
┌───────────────────────────▼─────────────────────────────────┐
│ src/main/         Electron 主进程：窗口、托盘、IPC 边界        │
│   contextIsolation=true / nodeIntegration=false / 单实例锁     │
└───────────────────────────┬─────────────────────────────────┘
                            │ 只调用 core，不接触凭据明文
┌───────────────────────────▼─────────────────────────────────┐
│ src/core/         与界面无关的业务内核                          │
│  domain      领域类型 / 六态状态机 / 统一错误码 / 掩码          │
│  dictionary  口径字典（版本化装载，缺项显式报「依据缺失」）      │
│  adapters    HIS / 价目 / 工单 / IM 四端真实 HTTP 协议适配器    │
│  attribution 质疑点抽取 → n:m 归并 → 带引用解释稿 → 合规校验    │
│  rules       负面清单 §4 七条 / 金额勾稽 / 三重绑定守门         │
│  workunit    多通道归一 / 队列绑定 / 容量派单 / 超时升级        │
│  dispatch    确认闸门 / 打印稿 / 交办工单 / IM 白名单推送        │
│  audit       归因留痕 / 台账检索 / 原样重放 / 导出包            │
└───────────────────────────┬─────────────────────────────────┘
                            │ Store 窄接口（query / get / run / transaction）
┌───────────────────────────▼─────────────────────────────────┐
│ src/db/           SQLite（node:sqlite DatabaseSync）           │
│  schema.ts 是 DDL 单一真源，SCHEMA_VERSION=1，busy_timeout=5s │
└─────────────────────────────────────────────────────────────┘
```

`src/cli/` 与 `src/main/` 共用同一套 `core`，因此 CLI 与桌面端的口径、规则、留痕完全一致，
不存在两套实现。`Store` 保持窄接口，驱动可替换（当前用 Node 内置 `node:sqlite`，
避免原生模块编译失败）。

## 六态状态机

跃迁表在 `src/core/domain/state-machine.ts` 的 `ALLOWED_TRANSITIONS`，表驱动，非法跃迁抛
`ERR_ILLEGAL_TRANSITION` 并保持原状态不变。

| 当前状态 | 允许跃迁到 | 说明 |
|----------|------------|------|
| `pending_reply` 待答复 | `draft_pending_confirm`、`withdrawn` | 归因出稿后进入草稿；未确认可撤回 |
| `draft_pending_confirm` 草稿待确认 | `answered`、`transferred`、`withdrawn` | 必须经收费员确认 |
| `answered` 已答复 | `closed` | 打印稿已交付 |
| `transferred` 已转办 | `closed` | 工单回执写回后 |
| `closed` 已关闭 | 无 | 终态 |
| `withdrawn` 已撤回 | 无 | 终态 |

未确认态为 `pending_reply` 与 `draft_pending_confirm`，只有这两个状态允许撤回。
`CONFIRMED_STATES` 为 `answered` / `transferred` / `closed`，确认闸门同时校验状态与
`confirmed_at` 时间戳，二者缺一即拒绝外发。

## 确认闸门与三条外发通道

`src/core/dispatch/gate.ts` 的 `ConfirmationGate.assertAllowed()` 被 `print` / `workorder` /
`im` 三条通道共用，没有旁路：

1. 校验咨询单未被撤回；
2. 校验状态属于可外发集合，且 `confirmed_at` 非空；
3. 任一项不满足即抛统一错误，终端与界面都提示「尚未经收费员确认，不得外发」。

转办工单另带 `Idempotency-Key: sha256(encounter_no|reason_code|item_code)`，超时与 5xx
指数退避重试（最多 3 次），4xx 不重试；成功后回执写回 `transferred` 与 `workOrderNo`。
IM 推送只允许四个白名单字段（咨询编号、收费项目编码、争议分类、解释稿编号），
出现姓名、证件号、床号或金额即中止推送。

## 归因链路与降级

```
脱敏上下文 → 质疑点抽取 → n:m 语义归并 → 引用分配（首次出现顺序递增）
   → 歧义/置信度拒答 → 超长重写与裁剪 → 禁语合规校验
   → 规则守门融合裁定（三值分类）→ 版本快照 → 每轮留痕
```

`ModelGateway` 是唯一的模型出口，OpenAI-compatible `/chat/completions`，
`response_format: json_schema` 要求 `parts[{text, citation_indexes}]` 与 `attribution[]`。
超时与 5xx 最多重试 1 次，Schema 非法与 JSON 解析失败不重试，统一归一为错误码。

模型未配置或不可达时走 `buildBaseline()` 确定性基线：仍产出逐行带引用的解释稿，
但正文标注「待人工撰写」，咨询单状态只允许停留在 `draft_pending_confirm` 或退回
`pending_reply`，绝不推进到已答复。引用类型只有三类：`price_item` / `settlement_field` / `rule`。

## 版本快照与原样重放

每轮归因写一行 `attribution_sessions`，含引用清单、模型名与版本、守门命中、耗时、
操作人、掩码住院号。同时把价目版本、字典版本、规则版本、解释稿 `parts`、引用清单
写入 `snapshots`，生成 `snapshot_ref`。

`replay` 用 `snapshot_ref` 取回当时的 `parts` 原样输出，不重跑模型、不新增归因轮次，
只追加一条 `replay_audits`。因此价目改版后历史解释稿的依据不会被改写。
超长裁剪中被移除的低争议条目在 `AttributionResult` 里显式记录被裁剪行号，
保证「零漏行」口径可复核。

## SQLite 表清单

`src/db/schema.ts` 中 `CORE_TABLES`：

| 表 | 职责 |
|----|------|
| `consultations` | 咨询单主表（状态、确认时间、争议分类、掩码住院号、工单号） |
| `bill_lines` | 费用明细行，三重绑定字段 |
| `attribution_sessions` | 每轮归因留痕 |
| `assignments` | 派单记录，`idempotency_key` 唯一约束保证并发幂等 |
| `agent_capacity` | 助手在岗容量 |
| `queue_bindings` | 争议类型与队列绑定 |
| `sla_escalations` | 超时升级记录 |
| `snapshots` | 版本快照（含解释稿正文） |
| `replay_audits` | 重放审计 |

并发抢单用事务内 `SELECT` 加唯一约束插入双重保护，捕获 `UNIQUE` 冲突即视为已被其他进程派单，
返回 false，不产生第二条记录。

## IPC 边界

`preload.cjs` 只暴露 `desktopAPI` 九个方法，不暴露通用 `invoke`：
`getSummary`、`listConsultations`、`getExplanation`、`confirm`、`handoff`、`print`、
`replay`、`checkConnectivity`、`reportReady`。主进程 `ipcMain.handle` 一一对应，
渲染层不直连 SQLite、不接触凭据、不加载 Node 模块。

`--capture` 模式由 `scripts/launch.mjs` 启动：固定脱敏样例、固定 1280×768 窗口，
等待渲染层 `document.body.dataset.ready === 'true'` 后调用 `capturePage()` 生成真实 PNG，
引用视图会把引用折叠区滚入视口再截图。启动包装显式清除宿主可能注入的
`ELECTRON_RUN_AS_NODE`，并在受限环境下附加无沙箱与软件渲染参数。

## 真实协议与本地样例的边界

HIS、价目、工单、IM 四端都实现了正式 HTTP 协议适配器，端点与令牌从环境变量读取。
没有真实凭据时，入站显式切换到 `samples/` 脱敏样例，产物标注 `data_source: samples`；
工单与 IM 未配置时转办与推送直接失败并写明原因，不假装已提交。
公开数据集的来源、许可证与断网降级口径见 `docs/DATASET.md`。
