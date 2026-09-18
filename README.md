# 跨境收付款对账中枢

面向海外工程团队的跨境收付款对账服务：出纳导入多家银行回单、合同收款计划与人工调整，
系统以**原始发生时间**区分在途、到账、退汇与部分结算，月末可在乱序回单、重复推送、
汇率变更与并发认领下核对账面余额、审计链与幂等结果。

零外部依赖，仅使用 Node.js 内置模块（`node:http` / `node:crypto` / 文件系统）。

## 核心设计

| 需求 | 实现 |
| --- | --- |
| 回单重传只得到原结果 | 事件溯源 + 自然键幂等索引（`银行\|回单号`、`通知ID`、客户端分录ID），重放后索引同样恢复 |
| 以原始发生时间区分在途/到账/退汇/部分结算 | 回单生命周期按事件携带的 `occurredAt`（回单/通知上的时间，而非系统时间）排序，报表支持任意 `asOf` 时点重算 |
| 跨日到账不覆盖前一日判断 | `GET /v1/report?asOf=` 只统计 `occurredAt <= asOf` 的事件；`/v1/freeze` 对期末结论做哈希固化 |
| 币种换算保留报价来源与生效时刻 | 每条 FX 报价带 `source`、`effectiveAt`、`recordedAt`；结算按发生时刻选价，报价快照写入匹配事件 |
| 汇率在结算间变更 | 报价按 `effectiveAt` 版本化，历史结算永远引用成交时的报价，新结算自动用新价 |
| 无法匹配的款项分级入队 | L1 疑似（参考号相符、容差内溢缴）/ L2 不符（金额币种不符、缺汇率、退汇）/ L3 孤儿（无参考号或无合同） |
| 两名出纳同时认领 | 所有写命令经同一把异步互斥锁串行化，认领冲突返回 409，赢家重复认领为幂等 |
| 主管确认留下不可删除的依据 | 闭环事件固化决策、主管、回单号、导入事件序号与原始发生时间；事件只追加，无删除路径 |
| 撤销/更正通过追加分录 | `reversal`（负数追加并引用原分录）与 `matchCorrection`（带符号差额），原记录原样保留 |
| 进程重启后可重算 | 状态全部由追加式 JSONL 事件日志重放重建；每条事件带 seq 与 SHA-256 哈希链，篡改/删除可检出 |

金额以整数最小币种单位（BigInt）存储与运算，支持 JPY/KRW 等 0 小数位币种；
换汇按源/目标币种精度一次性舍入，避免浮点误差。

## 目录

```
src/domain/util.mjs    金额/汇率定点运算、ID、时间
src/domain/fx.mjs      FX 报价版本登记与按时点选价
src/domain/store.mjs   追加式事件存储（JSONL + SHA-256 哈希链）、互斥锁
src/domain/ledger.mjs  对账核心：命令（追加事件）+ 投影（重放重建）+ 时点报表
src/server.mjs         HTTP 路由
test/ledger.test.mjs   13 个场景测试（幂等/乱序/汇率/队列/并发/留证/重启/篡改）
```

## 运行

```bash
npm start                 # 默认台账 ./data/ledger.jsonl，端口 3000
LEDGER_FILE=/data/a.jsonl PORT=8080 npm start
L1_TOLERANCE="USD:0.01,CNY:0.05" npm start   # L1/L2 容差（按合同币种）
npm test                  # node --test
```

## HTTP 接口

所有写操作为 `POST` + JSON；重复的幂等请求返回 `{duplicated:true, originalSeq}`。

| 方法与路径 | 说明 |
| --- | --- |
| `POST /v1/currencies` | 登记币种精度（未知币种默认 2 位） |
| `POST /v1/fx-quotes` | 登记报价 `{fromCurrency,toCurrency,rate,source,effectiveAt}` |
| `POST /v1/contracts` | 合同收款计划 `{contractId,externalRef,currency,expectedAmount,dueAt}` |
| `POST /v1/receipts/import` | 导入回单 `{bank,bankReference,externalRef,currency,amount,status,occurredAt,partialAmount?}`，`status ∈ in_transit|arrived|partial|returned` |
| `POST /v1/receipts/:id/notifications` | 后续生命周期通知（可乱序、可重发），需 `notificationId` |
| `GET  /v1/receipts/:id` | 回单视图：当前状态与按原始时间排序的生命周期 |
| `GET  /v1/queue` | 人工队列（分级、认领、闭环与依据） |
| `POST /v1/queue/:id/claim` | 出纳认领 `{by}`（并发冲突 409） |
| `POST /v1/queue/:id/resolve` | 主管闭环 `{role:"supervisor",by,decision:match|suspense|return,contractId?,memo?}` |
| `POST /v1/queue/:id/retry` | 补齐汇率/参考信息后重跑自动匹配 |
| `POST /v1/entries` | 人工追加分录：`adjustment` / `reversal`（带 `refEntryId`）/ `matchCorrection`（带 `refMatchId,delta`），支持 `clientEntryId` 幂等 |
| `GET  /v1/report?asOf=` | 任一时点账面：各银行账户现金、合同核销（含使用的报价快照）、队列 |
| `POST /v1/freeze` | 固化期末结论 `{asOf,by}`，返回 totalsHash |
| `GET  /v1/verify` | 校验事件哈希链 |

### 最小示例

```bash
curl -s -XPOST localhost:3000/v1/fx-quotes -d '{
  "fromCurrency":"EUR","toCurrency":"USD","rate":"1.08",
  "source":"REUTERS","effectiveAt":"2026-05-10T00:00:00Z"}'

curl -s -XPOST localhost:3000/v1/receipts/import -d '{
  "bank":"HSBC-HK","bankReference":"BK-1","externalRef":"PO-88",
  "currency":"EUR","amount":"1000.00","status":"in_transit",
  "occurredAt":"2026-04-30T22:30:00Z","by":"cashier-a"}'
```

## 审计与运维说明

- 台账文件每行一个事件，顺序即 seq；删除/插入/改动任一事件，`GET /v1/verify` 会在
  `brokenAt` 处报告链断裂或哈希不一致。
- 备份只需复制 JSONL；迁移/换机器后用同一文件启动即完成恢复。
- 没有任何 UPDATE/DELETE：更正、撤销、退汇处置全部表现为新增事件，账面由事件净值重算。
