# 跨境收付款对账中枢

面向海外工程团队的收付款对账服务：出纳导入银行回单、合同收款计划与人工调整，系统按**原始发生时间**区分在途 / 到账 / 退汇 / 部分结算，月末据此核对账面余额、审计链与幂等结果。

## 运行

```bash
npm start          # 默认端口 3000，数据目录 ./data（可用 PORT / DATA_DIR 覆盖）
npm test           # 月末对账场景测试（乱序、重推、汇率变更、并发认领、重启重算等）
```

## 架构

事件溯源 + 追加式账本，全部状态由事件推导：

- `src/store.mjs` — 追加式事件日志（JSONL），每个事件带前向哈希构成审计链；启动时整链校验并回放，**进程重启后未处理队列与已确认余额仍可重算**。
- `src/domain.mjs` — 领域核心。命令是纯决策函数（返回事件或抛错），由外层统一落库，失败不产生半状态；投影（余额 / 分日状态 / 队列）全部从事件重算。
- `src/money.mjs` — 金额以最小货币单位整数存储；汇率解析为分数做整数换算，结果可逐笔重算。
- `src/app.mjs` / `src/server.mjs` — HTTP 层与入口。

## 关键不变量

- **幂等**：回单按 `(bank, externalRef)` 去重，同一回单重传只返回首次处理结果（含重启后）；同编号不同内容返回 409。计划、报价按客户端 ID 幂等。
- **汇率留痕**：每次结算记录所用报价的 `rate / source / effectiveAt`；折本位币按各分录发生时刻的生效报价逐笔换算，不用最新价覆盖历史。
- **跨日不覆盖**：`POST /days/close` 封存当日快照后不可更改；迟到的跨日回单只在后续日快照的 `lateArrivals` 中列示。
- **并发认领**：案件认领是状态机迁移（`open → claimed`），两名出纳同时认领恰有一人成功，另一人得 409。
- **人工队列分级**：高（无同币种计划 / 退汇）、中（金额不符，疑似部分结算）、低（多个候选计划）。认领人提方案、主管确认（留不可删除的 `evidence` 与方案哈希，处理人与确认人不得同一人），更正只能追加。
- **追加式账本**：分录不可删除，撤销通过追加等额反向的冲销分录完成。

## API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/receipts` | 导入回单（`bank/externalRef/currency/amount/fee/kind/occurredAt`），幂等 |
| POST | `/receipts/:id/match` | 手工撮合回单与计划（跨币种需已有报价） |
| POST | `/plans` | 登记合同收款计划；计划后到时自动撮合等待中的回单 |
| POST | `/fx-quotes` | 登记汇率报价（`from/to/rate/source/effectiveAt` 必填） |
| POST | `/adjustments` | 人工调整（必须留原因，直接落现金分录） |
| GET | `/cases?status=` | 人工队列（按等级高→低排序） |
| POST | `/cases/:id/claim` `/resolve` `/confirm` `/correct` | 认领 / 方案 / 主管确认 / 追加更正 |
| GET | `/ledger` | 分录账（可按 `account/currency` 过滤） |
| POST | `/entries/:id/reverse` | 追加冲销分录撤销 |
| GET | `/balance?date=&base=` | 账面余额；`base` 指定时逐笔按生效报价折本位币 |
| POST | `/days/close` · GET `/days/:date` | 封存 / 查看日快照（在途、到账、退汇、部分结算） |
| GET | `/audit/verify` · `/audit/events` | 审计链校验 / 事件流 |
| GET | `/health` | 健康检查 |

金额请求用字符串（如 `"1234.56"`），响应统一为最小货币单位整数（`amountMinor`）。错误响应为 `{ "error": { "code", "message" } }`。
