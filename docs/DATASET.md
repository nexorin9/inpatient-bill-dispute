# 数据集说明（公开数据派生口径）

本文件说明 `samples/` 下 6 个 JSON 产物的来源、许可证、派生口径、断网降级行为，
以及真实院内 HIS 数据的接入条件。生成脚本为 `scripts/fetch-synthea.ts`
（`npm run fetch:data`，Node 22 原生类型剥离执行）。

> **如实声明**：本环境若无网络（或下载 / 校验失败），产物来自**按 Synthea 公开字段口径、
> 固定 seed 确定性生成的缓存派生数据**，**不是从真实医院获得的数据**。
> 产物中不含任何真实患者；住院号 `ZY2026xxxxxx`、咨询单号 `CS2026xxxxxxxx` 均为占位编号。
> 本仓库不得以任何形式把这些样例表述为「来自真实医院的 HIS 数据」。

---

## 1. 来源 URL 与许可证

| 项 | 值 |
|----|----|
| 默认来源 URL（脚本常量 `DEFAULT_SYNTHEA_SOURCE_URL`） | `https://raw.githubusercontent.com/synthetichealth/synthea/master/src/main/resources/costs/encounters.csv` |
| 仓库 | `https://github.com/synthetichealth/synthea` |
| 许可证 | **Apache-2.0**（Synthea 主仓库 LICENSE） |
| 覆盖方式 | 环境变量 `SYNTHEA_SOURCE_URL`，留空时使用上表默认值 |
| 下载超时 | 5 秒（`AbortSignal.timeout(5000)`） |
| 该 CSV 真实表头 | `CODE,MIN,MODE,MAX,COMMENTS`；`CODE` 为 SNOMED 就诊 / 处置编码，`MIN/MODE/MAX` 为 Synthea 成本模型中的就诊费用区间 |

该 CSV 是 Synthea 官方仓库中真实公开可访问的资源表（成本模型输入），不是患者级导出数据。
脚本只把它当作**附加输入**：下载成功时读取其条目数（本次实测 659 字节 / 9 条），
用于扰动固定随机种子；不会把其中的任何字段直接当作患者事实写入产物。

`samples/qc-cases.json` 的来源是本项目自带的官方评测用例
`domain/cases/settlement_qc_cases.json`（8 条结算质控硬校验用例），逐字复制，
`case_id` / `input` / `expect` / `basis` 保持不变；脚本内置同一份副本作为离线回退。
这部分属于项目内评测口径，不是外部公开数据集，也不单独主张许可证。

---

## 2. 派生口径（公开字段 → 本项目字段）

派生的字段命名对齐 Synthea CSV Exporter 的官方 `patients.csv` / `encounters.csv` /
`claims` 结构口径，以及 `src/core/domain/types.ts` 中的业务类型。映射关系如下：

| Synthea 官方字段（CSV Exporter / 成本表） | 本项目字段 | 处理方式 |
|---|---|---|
| `encounters.csv: Id`（就诊唯一标识） | `encounter_no` | **脱敏占位**：`ZY2026` + 6 位序号（`ZY2026000001` … `ZY2026000020`），不保留原始 Id |
| `encounters.csv: START` | `admission_date` | 2026 年 3 月内的住院起始日期 |
| `encounters.csv: STOP` | `discharge_date` | 起始日 + 6~12 天 |
| `encounters.csv: ENCOUNTERCLASS = inpatient` | —— | 只取住院类就诊，生成 20 次住院 |
| `encounters.csv: CODE` / `DESCRIPTION`、成本表 `CODE` | `price_item_code` / `item_name` | 映射为 22 个中文收费项目编码（`ITEM001`…`ITEM022`），覆盖 14 个费用归集类目 |
| `encounters.csv: BASE_ENCOUNTER_COST` / `TOTAL_CLAIM_COST` | `lines[].amount` / `payment.total_amount` | 以收费项目单价 × 数量生成明细金额；`total_amount` = 明细合计 |
| `encounters.csv: PAYER_COVERAGE`、`claims` / `claim_transaction` 支付分摊 | `insured_fund_paid` / `supplementary_paid` / `medical_aid_paid` / `personal_burden` / `other_paid` / `personal_paid` | 把总额按固定比例拆成统筹 / 补充 / 救助 / 个人负担；个人负担再拆成其他支付与个人支付 |
| `encounters.csv: ORGANIZATION` / `PROVIDER` | `dept_code` | 占位科室编码 `D001`…`D008` |
| `patients.csv: FIRST` / `LAST` / `SSN` / `ADDRESS` / `PHONE` | —— | **整列丢弃，不落盘**；产物不含真实姓名、身份证、床号、电话、住址 |

### 金额与勾稽口径

- 单位元，字面量一律保留两位小数（如 `320.00`）。
- 所有金额在内部以「分」为整数运算，且**一律是 0.25 元（25 分）的整数倍**。
  这样每个金额都是二进制浮点可精确表示的值，下列三条勾稽关系均满足**严格 `===` 相等**：
  1. `payment.total_amount === Σ lines[].amount`
  2. `payment.total_amount === insured_fund_paid + supplementary_paid + medical_aid_paid + personal_burden`
  3. `payment.personal_burden === other_paid + personal_paid`
- `line_no` 在单次住院内唯一、从 1 递增；`occurred_at` 大部分落在住院区间内，
  少数故意越界，供负面清单 §4-6「费用日期在住院期间」规则命中。

### 确定性生成方式

使用固定 seed 的 LCG（线性同余，`seed = 20260301`）驱动数量、日期、科室、文本抽样等
全部随机选择；前 22 条明细强制覆盖全部 22 个收费项目编码。因此**无需网络也能生成真实规模**，
且重复生成业务字段完全一致（`generated_at` 为当次运行时间，属元数据）。
下载成功时 `seed = 20260301 + CSV 条目数`，使下载内容确实影响生成结果。

---

## 3. 产物清单与本次实测规模

| 文件 | 内容 | 实测 |
|---|---|---|
| `samples/bill-details.json` | 20 次住院的费用明细与各支付口径 | **339** 行明细 |
| `samples/price-items.json` | 带版本号的价目目录 `PRICE-2026-03` | **21** 个条目（22 个编码故意遗漏 1 个） |
| `samples/transcripts.json` | 家属口语化费用疑问 | **140** 条 |
| `samples/ledger-seed.json` | 咨询台账种子 | **3** 条咨询单（窗口 / 电话 / 线上各 1），每条带 5 行明细 |
| `samples/attribution-labels.json` | 人工标注子集（从转录派生，字段一致） | **48** 条 |
| `samples/qc-cases.json` | 官方结算 QC 用例逐字副本 | **8** 条 |

所有 JSON 均为 UTF-8、2 空格缩进、末尾单个换行。

### 标注集口径（可复核，不是随机行号）

`transcripts.json` 每条 `text` 的主语取自该次住院真实存在的收费项目（正式名称或俗称），
`expected_line_numbers` 取**该次住院中同一 `price_item_code` 的全部明细行**；
同一项目出现两行以上时自然形成「一句质疑 → 多行明细」的 n:m 标注。
`attribution-labels.json` 从转录等距抽样 48 条，其中 `question_point` 直接是家属那句原话，
`line_numbers` 与对应转录的 `expected_line_numbers` 逐条一致（本次实测 48/48 一致）。
这样 `bench:attribution` 的语义归并路径必须从**文本**回指明细行，
而不是从泛化短语或预置答案里取数；标注快照随报告写入
`reports/attribution-labels-snapshot.json` 供逐条复核。

### 故意埋设的反例（供规则层与对照评测使用）

| 反例 | 位置 | 用途 |
|---|---|---|
| 2 次住院金额轻微不勾稽（统筹少记 2.50 元），带 `"reconciliation_expected": false` | `ZY2026000007`、`ZY2026000014` | 勾稽校验的反例 |
| 24 条明细 `occurred_at` 越出住院区间 | 分散在各次住院 | §4-6 费用日期规则命中 |
| 价目目录故意遗漏 `ITEM013`（一次性输液器） | 明细中出现、目录中查不到 | 非目录审核 / 依据缺失 |
| 3 个编码医保属性与明细 `fee_category` 故意冲突 | `ITEM004`（乙类↔甲）、`ITEM015`（乙类↔自费）、`ITEM019`（自费↔甲） | 属性守门 |
| 转录中的口述金额单位变体、俗称、女儿转述、错别字 | 全量 140 条 | 归因 / 归一化评测 |

`insurance_attribute`（甲 / 乙 / 自费）与明细 `fee_category`（甲类 / 乙类 / 自费 / 其他）
的常规对应为：甲类→甲、乙类→乙、自费→自费、其他→自费；上表 3 项即为刻意偏离。

---

## 4. 断网降级行为

脚本按以下顺序执行，保证 CI 可重复运行且**不以非零码中断**：

1. **优先复用缓存**：`samples/` 下 6 个产物若全部存在且通过完整校验（行数、勾稽、
   行号、编码覆盖、转录行号有效性、QC 用例条数等），直接打印精确字符串
   `reused cached: ...`，跳过下载与生成，退出码 0。
   → 第一次运行生成产物，**第二次及以后输出 `reused cached`**。
2. **尝试下载**：`fetch(SOURCE_URL)` + 5 秒超时；完整性校验三项：
   归档字节数 > 0、条目数 > 0、必需表头字段存在（命中 `CODE/MIN/MODE/MAX` 组，
   或 Synthea CSV Exporter 的 `Id/START/STOP/PATIENT/ENCOUNTERCLASS/BASE_ENCOUNTER_COST/TOTAL_CLAIM_COST` 组）。
3. **降级**：网络不可用 / 下载失败 / 校验失败时，打印中文告警，告警中明确含
   「降级」「缓存」字样（例如：`[降级] 下载/校验失败：fetch failed；已切换到仓库内缓存派生数据
   （缓存口径：按 Synthea 公开字段口径确定性生成），产物仍可复用，不静默失败。`），
   随后改用固定 seed 确定性生成全部产物，**仍以退出码 0 结束**（因为产物可复用），
   数据来源标注为「缓存派生」。
4. 无论哪条路径，均打印派生统计：住院次数、明细行数、转录条数、数据来源
   （「真实下载」或「缓存派生」）。

降级路径已在隔离副本中实测：强制坏 URL 时告警正确、退出码 0、生成 20 次住院 /
345 行明细 / 140 条转录；再跑一次输出 `reused cached`。

### 关于缓存目录

原始归档如需落盘，约定放在 `.cache/synthea/`，该目录**应被忽略**（不进版本库）。
本脚本为避免写入所有权范围之外的路径，**不创建该目录**，而是直接以
`samples/` 下已校验通过的派生产物作为可复用缓存；`.gitignore` 由主工程统一维护，
本脚本与本文档均不修改它。

---

## 5. 真实院内 HIS 数据的接入条件与尚不可连范围

`README.md` 与 `.env.example` 已定义真实接入所需的凭据位。若要接入真实院内数据，
必须**全部满足**以下条件：

| 条件 | 说明 |
|---|---|
| `HIS_BASE_URL` + `HIS_API_TOKEN` | HIS 住院费用明细接口地址与真实访问令牌（读） |
| `PRICING_BASE_URL` + `PRICING_API_TOKEN` | 本院带版本号的价目目录接口地址与令牌（读） |
| 院方书面授权与数据合规审批 | 明确数据用途、范围、脱敏规则、留存期限与访问审计 |
| 网络可达 | 端点在院内网络 / 专线 / VPN 白名单内可达，且通过等保与接口鉴权 |
| 字段映射与脱敏 | 按 `src/core/adapters/` 映射到 `src/core/domain/types.ts`，日志/界面/模型上下文只使用掩码住院号 |

其他出站凭据位（`WORKORDER_BASE_URL` / `WORKORDER_TOKEN` / `IM_WEBHOOK_URL`）
属于交办与通知链路，同样需要院方授权后才可启用。

**本环境尚不可连的范围（如实说明）**：

- 没有院内网 / 专线 / VPN 可达性，也没有任何真实 HIS、价目、工单、IM 端点与令牌；
- 没有院方授权与数据合规审批；
- 因此不能、也不允许连接真实 HIS 拉取患者数据；按 `README.md` 的约定，
  HIS 不可用时应「界面提示并阻断归因，不拿本地样例冒充真实数据」；
- 本脚本在缺少凭据时**不会**尝试访问 `HIS_BASE_URL` 等地址，只使用公开 Synthea 资源
  或确定性缓存派生数据。上述任何样例都不得被当作真实院内 HIS 数据使用或对外宣称。

---

## 6. 复现命令

```bash
npm run fetch:data            # 第一次：下载/降级并生成
npm run fetch:data            # 第二次：输出 reused cached，退出码 0
SYNTHEA_SOURCE_URL=<另一个 Synthea CSV> npm run fetch:data   # 覆盖来源（需删产物后重跑）
```

脚本只写 `scripts/fetch-synthea.ts` 自身之外的 `samples/*.json`；
`docs/DATASET.md` 由人工维护，不由脚本生成。
