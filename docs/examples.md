# 输出样例全集

以下片段来自真实运行产物，落盘位置为 `outbox/` 与 `reports/`。**诚实前提**：
本机没有配置真实 HIS 与模型凭据，因此这些产物统一来自 `samples/` 下的本地脱敏样例，
归因走确定性基线，产物中标注「非真实院内数据」。它们用于说明字段与格式，
不代表任何真实医院的收费数据，也不宣称模型推理效果。

CLI 通道的原始输出见 [`screenshots/04-cli-explain.txt`](screenshots/04-cli-explain.txt)，
界面实测见 [`screenshots/01-workbench.png`](screenshots/01-workbench.png) 与
[`screenshots/02-citations.png`](screenshots/02-citations.png)。

## 一、解释稿片段

取自 `outbox/explanation-CS-EXPLAIN-000001.md`。引用编号按首次出现顺序分配，
相同依据复用同一编号，正文里不出现裸数字而无对应依据条目。

```text
# 住院费用口径解释稿（确定性基线草稿）

- 咨询编号：CS-EXPLAIN-000001
- 住院号（掩码）：****0001
- 数据来源：本地脱敏样例（非真实院内数据）
- 争议分类：需人工判断
- 依据版本快照：SNAP-dee8e25f8aa69996
- 引用条数：30
- 质疑点数：1 ｜ 归并条目：0 ｜ 拒答：1
- 规则命中：11 ｜ 金额勾稽命中：0
- 模型通道：确定性基线

## 一、逐笔说明

1. 2026-03-06 的一笔「床位费」 100.00 元；属于医保目录内甲类项目，按本院价目口径结算（依据 [1][2]）
   - 明细行：1 ｜ 依据编号：[1][2]
2. 2026-03-02 的一笔「诊察费」 60.00 元；属于医保目录内甲类项目，按本院价目口径结算（依据 [3][4]）
   - 明细行：2 ｜ 依据编号：[3][4]
3. 2026-03-07 的一笔「住院诊查费」 125.00 元；属于医保目录内甲类项目，按本院价目口径结算（依据 [5][4]）
   - 明细行：3 ｜ 依据编号：[5][4]
4. 2026-03-01 的一笔「CT 平扫」 1120.00 元；属于医保目录内甲类项目，按本院价目口径结算（依据 [6][7][8]）
   - 明细行：4 ｜ 依据编号：[6][7][8]
```

该样例共 18 行明细，逐行都有解释条目，即「零漏行」。质疑点「上次多算了 3200」
被判为口述金额无法可靠回指具体行，进入 `unmatched` 与拒答，不强行挂到某一行。

## 二、争议分类单

取自 `outbox/classification-CS-EXPLAIN-000001.json`（字段节选，非完整文件）：

```json
{
  "consultation_no": "CS-EXPLAIN-000001",
  "encounter_no_masked": "****0001",
  "category": "needs_human",
  "category_label": "需人工判断",
  "status": "draft_pending_confirm",
  "data_source": "samples",
  "snapshot_ref": "SNAP-dee8e25f8aa69996",
  "degraded": false,
  "question_points": [
    {
      "id": "Q01",
      "text": "上次多算了 3200",
      "kind": "amount",
      "spoken_amount": { "min": 3040, "max": 3360, "uncertain": false, "raw": "3200" }
    }
  ],
  "matches": [],
  "unmatched": ["上次多算了 3200"],
  "rule_hits": [{ "rule_id": "§4-1", "basis_ref": "§4-1", "line_no": 13, "severity": "high" }],
  "citations": [
    {
      "index": 1,
      "type": "price_item",
      "code": "ITEM001",
      "label": "本院价目目录「床位费」",
      "version": "PRICE-2026-03",
      "lineNumbers": [1]
    }
  ],
  "parts": [
    { "line_numbers": [1], "citation_indexes": [1, 2], "needs_human": false, "evidence_missing": false, "category": "internal_check" }
  ],
  "arbitration": null
}
```

`arbitration` 为空是因为本次没有配置模型，裁定由确定性规则路径完成。
引用类型只允许 `price_item` / `settlement_field` / `rule` 三类。

## 三、引用清单与版本快照

解释稿里的每个编号都能在 `citations` 里查到类型、编码、标签与版本：

| 依据编号 | 类型 | 编码 | 说明 |
|----------|------|------|------|
| 1 | 价目条目 | `ITEM001` | 本院价目目录「床位费」，版本 `PRICE-2026-03` |
| 2 | 结算清单字段 | `FEE-007` | 结算清单「床位费」字段 |
| 12 | 规则 | `§4-6` | 医保违规负面清单审核规则 |

版本快照同时固化 `PRICE-2026-03`、`SETTLEMENT-193-2021`、`NEGATIVE-LIST-2024`
与解释稿 `parts`。`replay` 取回的是当时的正文，不重新生成。

## 四、家属可读打印稿

`outbox/print-<咨询编号>.html` 只在收费员确认后生成。渲染时过滤内部字段名与内部术语，
不出现「模型」「置信度」「规则命中」等内审用语，也不包含完整住院号。

```html
<h1>住院费用说明</h1>
<p>咨询编号：CS-EXPLAIN-000001　住院号：****0001</p>
<ol>
  <li>2026-03-06 床位费 100.00 元，按本院价目目录与结算清单口径说明。</li>
</ol>
<p>本说明仅解释院内收费口径，具体报销结果以医保结算为准。</p>
```

## 五、交办工单请求体

下面是协议示意（脱敏字段名与样例值），真实提交由 `WorkOrderAdapter` 生成并附
`Idempotency-Key`。未配置工单端点时转办会直接失败并写明原因，不会静默成功。

```json
{
  "consultation_no": "CS-EXPLAIN-000006",
  "encounter_no": "ZY2026000006",
  "target_dept": "医保办",
  "reason_code": "insurance_attribute_dispute",
  "item_code": "ITEM015",
  "evidence_refs": [
    { "type": "price_item", "code": "ITEM015", "label": "本院价目目录「注射用头孢呋辛」" },
    { "type": "settlement_field", "code": "FEE-015", "label": "结算清单 · 西药费" },
    { "type": "rule", "code": "§4-6", "label": "医保属性审核规则" }
  ],
  "draft_summary": "家属对药品费用医保属性有疑问，需核定。",
  "submitted_by": "clerk-01"
}
```

幂等键为 `sha256(encounter_no|reason_code|item_code)`，同一笔争议重复提交只产生一张工单。

## 六、台账导出列头

取自 `outbox/audit-export.csv` 真实表头（UTF-8 BOM，可直接用 Excel 打开）：

```text
咨询编号,渠道,住院号(掩码),状态,争议分类,金额(元),确认人,确认时间,价目版本,字典版本,规则版本,引用条数,引用清单,依据出处,模型名,模型版本,归因轮次,耗时(毫秒),降级标记,创建时间
```

`audit-export.json` 含同样的咨询级字段以及解释级字段（解释稿 `parts`、引用清单、
规则命中、勾稽命中、快照编号）。导出前做敏感信息扫描，导出内容不含姓名、证件号、
床号、电话、住址与任何密钥。

## 七、CLI 真实输出

`docs/screenshots/04-cli-explain.txt` 是 `cli explain` 的原始终端输出，包含咨询编号、
掩码住院号、数据来源标注、解释稿与分类单路径、引用条数、逐条覆盖明细行数、
争议分类、质疑点 / 规则命中 / 勾稽命中计数、模型通道、咨询单状态与归因轮次。

```text
住院费用口径解释已生成
  咨询编号：CS-EXPLAIN-000001
  住院号（掩码）：****0001
  数据来源：本地脱敏样例（非真实院内数据）
  引用条数：30
  逐条覆盖明细行：18 行
  争议分类：需人工判断
  模型通道：确定性基线（模型未配置）
  咨询单状态：草稿待确认（未经收费员确认，不得外发）
```

## 八、评测报告

`reports/attribution-scale.json` 记录规模验收（≥300 条明细、≤5 秒、零漏行、引用覆盖 100%）；
`reports/attribution-benchmark.json` 记录语义归并路径与纯规则基线的覆盖率 / 误挂率对照。
报告如实标注：无真实模型凭据时，语义路径是本地确定性归并器（协议替身），
不宣称真实模型推理增益。
