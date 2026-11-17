# CLI 全量参考

CLI 是运维与排障通道，收费员日常出稿走桌面工作台。统一入口：

```bash
npm run cli -- <子命令> [参数]
```

执行方式为 Node 22.5+ 的 `--experimental-strip-types` 直接运行 TypeScript，无需预编译；
持久化使用 Node 内置 `node:sqlite`，台账默认 `data/ledger.sqlite`，可用 `LEDGER_DB_PATH` 覆盖。
未配置 HIS 与价目凭据时，命令显式读取 `samples/` 下的本地脱敏样例，并在产物中标注
`数据来源：本地脱敏样例（非真实院内数据）`，不会把样例冒充真实 HIS 数据。

## 命令总览

| 子命令 | 用途 | 关键参数 | 主要产物 |
|--------|------|----------|----------|
| `doctor` | 列出全部凭据位配置状态，只显示「已配置 / 未配置」 | 无 | 终端矩阵；缺必填项退出码 1 |
| `help` / `version` | 帮助与版本号 | 无 | 终端输出 |
| `dict:check` | 校验口径字典装载完整性 | `--inject-missing <编号>` | 终端自检报告 |
| `ledger` | 咨询台账分页列出 | `--seed [文件]`、`--status`、`--from`、`--to`、`--limit`、`--offset` | 终端表格；`--seed` 导入种子台账 |
| `explain` | 对一次住院跑归因，产出带引用解释稿与争议分类 | `--encounter`、`--text`、`--operator` | `outbox/explanation-*.md`、`classification-*.json` |
| `confirm` | 收费员确认，写入 `confirmed_at` 放行闸门 | `<咨询编号>`、`--operator` | 台账状态更新 |
| `print` | 生成家属可读打印稿 | `<咨询编号>` | `outbox/print-*.html` |
| `handoff` | 提交科室交办工单并回写回执 | `<咨询编号>`、`--operator` | 工单请求、`transferred` 状态 |
| `replay` | 原样重放当时的解释稿与引用清单 | `<咨询编号>`、`--operator` | 终端正文；写一条重放审计 |
| `export` | 导出引用留痕包 | `--from`、`--to`、`--status`、`--limit` | `outbox/audit-export.csv`、`.json` |
| `intake` | 多通道诉求归一为一条咨询单 | `--channel`、`--encounter`、`--text`、`--operator` | 新咨询单编号 |
| `assign` | 按队列与在岗容量派单 | `<咨询编号>`（必填位置参数）、`--queue`、`--operator` | 幂等派单记录 |
| `cases:run` | 官方 8 条结算清单质控用例跑批 | `--break <检查名>` | 终端逐例结果 |
| `bench:attribution` | 语义归并路径与纯规则基线对照评测 | 无 | `reports/attribution-benchmark.json` |
| `bench:scale` | ≥300 条明细规模验收 | 无 | `reports/attribution-scale.json` |
| `sla:scan` | 咨询超时升级扫描 | `--at <ISO 时间>` | 终端升级清单 |

`--inject-missing` 与 `--break` 是故障注入开关，用于验证失败路径确实会以非 0 退出码失败，
而不是把校验写成永远通过的摆设。正常验收不要带这两个参数。

## 典型调用

```bash
# 1. 配置自检与字典自检
npm run cli -- doctor
npm run cli -- dict:check

# 2. 导入种子台账并查看
npm run cli -- ledger --seed
npm run cli -- ledger --status draft_pending_confirm --limit 20

# 3. 一条命令出稿（无模型凭据时走确定性基线）
npm run cli -- explain --encounter ZY2026000001 --text "化验费怎么这么贵"

# 4. 确认闸门与外发（未确认时 print / handoff 一律被拒）
npm run cli -- confirm CS-EXPLAIN-000001
npm run cli -- print CS-EXPLAIN-000001
npm run cli -- handoff CS-EXPLAIN-000001

# 5. 重放与导出
npm run cli -- replay CS-EXPLAIN-000001
npm run cli -- export --from 2026-11-01 --to 2026-11-30

# 6. 工作单元与验收
npm run cli -- intake --channel counter --encounter ZY2026000001 --text "床位费是不是算重了"
npm run cli -- assign CS-EXPLAIN-000006
npm run cli -- cases:run
npm run cli -- bench:attribution
npm run cli -- bench:scale
npm run cli -- sla:scan --at 2026-11-14T12:00:00
```

## 故障注入示例

```bash
# 人为删掉一个字典编号，自检必须报「依据缺失」并非 0 退出
npm run cli -- dict:check --inject-missing FEE-017

# 人为破坏一条质控规则，用例跑批必须出现失败项
npm run cli -- cases:run --break 主诊断唯一性
```

## 退出码约定

| 退出码 | 含义 |
|--------|------|
| `0` | 命令成功，产物已落盘 |
| `1` | 校验失败、凭据缺失或业务规则拒绝（如未确认外发、非法状态跃迁、依据缺失） |
| 非 `0` 且带错误码 | 统一错误码（模型不可达、Schema 非法、工单 5xx、歧义住院号等），终端打印错误码与可读说明 |

所有命令只打印脱敏字段：住院号一律掩码，密钥与令牌从不回显。失败时落错误码与重试标记，
不静默吞掉，也不假装已提交。完整错误与降级对照见 `README.md` 的「错误与降级」表。
