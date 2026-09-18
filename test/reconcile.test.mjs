import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../src/app.mjs';

// 启动一个独立数据目录的对账中枢实例
async function startHub(dataDir) {
  const dir = dataDir || mkdtempSync(join(tmpdir(), 'recon-'));
  const server = createServer(createApp({ dataDir: dir }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, body: json };
  };
  return {
    dir,
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b ?? {}),
    close: () => new Promise((r) => server.close(r)),
  };
}

test('乱序回单按原始发生时间入账，重复推送只得到原处理结果', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());

  await hub.post('/plans', { planId: 'plan-1', contractId: 'HT-001', currency: 'USD', expected: '10000.00', expectedDate: '2026-08-31' });

  // 乱序导入：先导入发生时间较晚的回单
  const late = await hub.post('/receipts', { bank: 'HSBC', externalRef: 'R-002', currency: 'USD', amount: '4000.00', fee: '5.00', occurredAt: '2026-08-29T09:00:00Z', importedBy: 'n1' });
  assert.equal(late.status, 201);
  assert.equal(late.body.status, 'queued');
  const early = await hub.post('/receipts', { bank: 'HSBC', externalRef: 'R-001', currency: 'USD', amount: '6000.00', occurredAt: '2026-08-28T09:00:00Z', importedBy: 'n1' });
  assert.equal(early.body.status, 'queued');

  // 按原始发生时间结算：8-28 的 6000 为部分结算，8-29 的 4000 补足到账
  const m1 = await hub.post(`/receipts/${early.body.receiptId}/match`, { planId: 'plan-1', by: 'n1' });
  assert.equal(m1.body.settlement, 'partial');
  const m2 = await hub.post(`/receipts/${late.body.receiptId}/match`, { planId: 'plan-1', by: 'n2' });
  assert.equal(m2.body.settlement, 'full');

  // 分日判断由原始发生时间决定，与导入顺序无关
  const d28 = await hub.get('/days/2026-08-28');
  assert.equal(d28.body.plans[0].status, '部分结算');
  const d29 = await hub.get('/days/2026-08-29');
  assert.equal(d29.body.plans[0].status, '到账');

  // 重复推送：同编号同内容 → 返回首次处理结果，不重复入账
  const dup = await hub.post('/receipts', { bank: 'HSBC', externalRef: 'R-002', currency: 'USD', amount: '4000.00', fee: '5.00', occurredAt: '2026-08-29T09:00:00Z' });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.idempotent, true);
  assert.equal(dup.body.receiptId, late.body.receiptId);
  assert.equal(dup.body.status, late.body.status);

  // 同编号不同内容 → 冲突
  const clash = await hub.post('/receipts', { bank: 'HSBC', externalRef: 'R-002', currency: 'USD', amount: '9999.00', occurredAt: '2026-08-29T09:00:00Z' });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'RECEIPT_CONFLICT');

  // 账面余额只记一次：6000 + (4000 - 5) = 9995.00，手续费 5.00
  const bal = await hub.get('/balance');
  assert.equal(bal.body.cash.USD, 999500);
  assert.equal(bal.body.feeExpense.USD, 500);
});

test('汇率在结算间变更：每次结算保留报价来源与生效时刻', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());

  await hub.post('/fx-quotes', { quoteId: 'q1', from: 'USD', to: 'CNY', rate: '7.10', source: 'bank-of-china', effectiveAt: '2026-08-01T00:00:00Z' });
  await hub.post('/fx-quotes', { quoteId: 'q2', from: 'USD', to: 'CNY', rate: '7.20', source: 'reuters', effectiveAt: '2026-08-15T00:00:00Z' });
  await hub.post('/plans', { planId: 'plan-a', contractId: 'HT-A', currency: 'CNY', expected: '35500.00', expectedDate: '2026-08-31' });
  await hub.post('/plans', { planId: 'plan-b', contractId: 'HT-B', currency: 'CNY', expected: '36000.00', expectedDate: '2026-08-31' });

  const r1 = await hub.post('/receipts', { bank: 'Citi', externalRef: 'F-1', currency: 'USD', amount: '5000.00', occurredAt: '2026-08-10T08:00:00Z' });
  const r2 = await hub.post('/receipts', { bank: 'Citi', externalRef: 'F-2', currency: 'USD', amount: '5000.00', occurredAt: '2026-08-20T08:00:00Z' });

  // 第一笔按 8-10 生效的 7.10 结算，第二笔按 8-20 生效的 7.20 结算
  const m1 = await hub.post(`/receipts/${r1.body.receiptId}/match`, { planId: 'plan-a', by: 'n1' });
  assert.equal(m1.status, 201);
  assert.equal(m1.body.settledMinor, 3550000);
  assert.deepEqual(m1.body.quote, { rate: '7.10', source: 'bank-of-china', effectiveAt: '2026-08-01T00:00:00.000Z' });
  const m2 = await hub.post(`/receipts/${r2.body.receiptId}/match`, { planId: 'plan-b', by: 'n1' });
  assert.equal(m2.body.settledMinor, 3600000);
  assert.deepEqual(m2.body.quote, { rate: '7.20', source: 'reuters', effectiveAt: '2026-08-15T00:00:00.000Z' });

  // 折本位币：逐笔按分录发生时刻的生效报价换算，而非统一用最新价
  const bal = await hub.get('/balance?base=CNY');
  assert.equal(bal.body.base.totalMinor, 7150000); // 5000×7.10 + 5000×7.20，而非 10000×7.20
  assert.equal(bal.body.base.quotesUsed.length, 2);
  assert.deepEqual(bal.body.base.unconvertible, []);

  // 结算记录永久留痕，可回放核对
  const planA = await hub.get('/plans/plan-a');
  assert.equal(planA.body.status, '到账');
  assert.equal(planA.body.matches[0].quote.source, 'bank-of-china');
  const day = await hub.get('/days/2026-08-20');
  assert.equal(day.body.quotesUsed.length, 2);
});

test('两名出纳同时认领只有一人成功，主管确认后依据不可删除', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());

  const r = await hub.post('/receipts', { bank: 'DBS', externalRef: 'X-1', currency: 'USD', amount: '123.45', occurredAt: '2026-09-05T08:00:00Z' });
  const caseId = r.body.caseId;
  assert.equal(r.body.grade, 'high');

  // 同时认领：恰好一人成功
  const [a, b] = await Promise.all([
    hub.post(`/cases/${caseId}/claim`, { cashier: 'alice' }),
    hub.post(`/cases/${caseId}/claim`, { cashier: 'bob' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const winner = a.status === 200 ? 'alice' : 'bob';
  const loser = a.status === 200 ? 'bob' : 'alice';

  // 非认领人不能提交方案
  const notYours = await hub.post(`/cases/${caseId}/resolve`, { by: loser, action: 'write_off', note: 'x' });
  assert.equal(notYours.status, 409);

  const resolved = await hub.post(`/cases/${caseId}/resolve`, { by: winner, action: 'write_off', note: '无法查明来源，确认为营业外收入' });
  assert.equal(resolved.status, 200);

  // 缺依据、自我确认都被拒绝
  assert.equal((await hub.post(`/cases/${caseId}/confirm`, { supervisor: 'boss' })).status, 400);
  assert.equal((await hub.post(`/cases/${caseId}/confirm`, { supervisor: winner, evidence: 'x' })).status, 409);

  const confirmed = await hub.post(`/cases/${caseId}/confirm`, { supervisor: 'boss', evidence: '与银行电话核实记录 2026-09-06' });
  assert.equal(confirmed.status, 200);
  assert.ok(confirmed.body.resolutionHash);

  // 已确认：不可再认领、不可再确认，只能追加更正
  assert.equal((await hub.post(`/cases/${caseId}/claim`, { cashier: 'alice' })).status, 409);
  assert.equal((await hub.post(`/cases/${caseId}/confirm`, { supervisor: 'boss2', evidence: 'y' })).status, 409);
  const corrected = await hub.post(`/cases/${caseId}/correct`, { by: 'boss', correction: '补充：后续查明为 HT-009 尾款' });
  assert.equal(corrected.status, 200);

  const cases = await hub.get('/cases');
  const theCase = cases.body.cases.find((c) => c.caseId === caseId);
  assert.equal(theCase.status, 'confirmed');
  assert.equal(theCase.evidence, '与银行电话核实记录 2026-09-06');
  assert.equal(theCase.corrections.length, 1);

  // 确认后账面体现，审计链完整
  const bal = await hub.get('/balance');
  assert.equal(bal.body.cash.USD, 12345);
  const audit = await hub.get('/audit/verify');
  assert.equal(audit.body.valid, true);
});

test('跨日到账不覆盖前一日判断，重启后未处理队列与已确认余额可重算', async (t) => {
  const hub = await startHub();

  await hub.post('/plans', { planId: 'plan-x', contractId: 'HT-X', currency: 'USD', expected: '100.00', expectedDate: '2026-08-31' });
  const day1 = await hub.post('/days/close', { date: '2026-08-31' });
  assert.equal(day1.body.plans[0].status, '在途');
  assert.equal(day1.body.cash.USD, undefined);

  // 9-01 才收到发生时间为 8-31 晚间的回单（跨日迟到）→ 自动匹配
  const r = await hub.post('/receipts', { bank: 'HSBC', externalRef: 'L-1', currency: 'USD', amount: '100.00', occurredAt: '2026-08-31T22:30:00Z' });
  assert.equal(r.body.status, 'matched');

  // 已封存的 8-31 判断不变
  const day1After = await hub.get('/days/2026-08-31');
  assert.equal(day1After.body.sealed, true);
  assert.equal(day1After.body.plans[0].status, '在途');

  // 9-01 快照：体现到账，并把迟到回单列作跨日调整
  const day2 = await hub.post('/days/close', { date: '2026-09-01' });
  assert.equal(day2.body.plans[0].status, '到账');
  assert.equal(day2.body.cash.USD, 10000);
  assert.equal(day2.body.lateArrivals.length, 1);
  assert.equal(day2.body.lateArrivals[0].receiptId, r.body.receiptId);

  // 重复封存同一日 → 幂等返回原快照
  const again = await hub.post('/days/close', { date: '2026-08-31' });
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.plans[0].status, '在途');

  // 留下一笔未匹配款项在队列中，随后重启进程
  const pending = await hub.post('/receipts', { bank: 'OCBC', externalRef: 'P-9', currency: 'USD', amount: '77.00', occurredAt: '2026-09-02T01:00:00Z' });
  assert.equal(pending.body.status, 'queued');
  const balBefore = await hub.get('/balance');
  await hub.close();

  // 进程再次启动：事件回放，余额、队列、封存快照全部重算一致
  const hub2 = await startHub(hub.dir);
  t.after(() => hub2.close());
  const balAfter = await hub2.get('/balance');
  assert.deepEqual(balAfter.body.cash, balBefore.body.cash);
  const open = await hub2.get('/cases?status=open');
  assert.equal(open.body.cases.length, 1);
  assert.equal(open.body.cases[0].receipt.receiptId, pending.body.receiptId);
  const day1Re = await hub2.get('/days/2026-08-31');
  assert.equal(day1Re.body.sealed, true);
  assert.equal(day1Re.body.plans[0].status, '在途');

  // 重启后重传同一回单 → 仍是原处理结果
  const redeliver = await hub2.post('/receipts', { bank: 'HSBC', externalRef: 'L-1', currency: 'USD', amount: '100.00', occurredAt: '2026-08-31T22:30:00Z' });
  assert.equal(redeliver.body.idempotent, true);
  assert.equal(redeliver.body.status, 'matched');
  const audit = await hub2.get('/audit/verify');
  assert.equal(audit.body.valid, true);
});

test('退汇经人工队列确认后冲减账面，计划状态变为退汇', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());

  await hub.post('/plans', { planId: 'plan-r', contractId: 'HT-R', currency: 'USD', expected: '500.00', expectedDate: '2026-09-05' });
  const credit = await hub.post('/receipts', { bank: 'HSBC', externalRef: 'C-1', currency: 'USD', amount: '500.00', occurredAt: '2026-09-03T08:00:00Z' });
  assert.equal(credit.body.status, 'matched');

  const ret = await hub.post('/receipts', { bank: 'HSBC', externalRef: 'C-1-RET', currency: 'USD', amount: '500.00', kind: 'return', occurredAt: '2026-09-06T08:00:00Z' });
  assert.equal(ret.body.status, 'queued');
  assert.equal(ret.body.grade, 'high');

  await hub.post(`/cases/${ret.body.caseId}/claim`, { cashier: 'alice' });
  await hub.post(`/cases/${ret.body.caseId}/resolve`, { by: 'alice', action: 'confirm_return', planId: 'plan-r' });
  const confirmed = await hub.post(`/cases/${ret.body.caseId}/confirm`, { supervisor: 'boss', evidence: '银行退汇通知书扫描件' });
  assert.equal(confirmed.status, 200);

  const bal = await hub.get('/balance');
  assert.equal(bal.body.cash.USD, 0);
  const plan = await hub.get('/plans/plan-r');
  assert.equal(plan.body.status, '退汇');
  const day = await hub.get('/days/2026-09-06');
  assert.equal(day.body.plans[0].status, '退汇');
});

test('人工调整入账，撤销通过追加冲销分录完成', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());

  const adj = await hub.post('/adjustments', { currency: 'USD', amount: '50.00', reason: '账户利息', by: 'n1', occurredAt: '2026-09-10T00:00:00Z' });
  assert.equal(adj.status, 201);
  let bal = await hub.get('/balance');
  assert.equal(bal.body.cash.USD, 5000);

  const ledger = await hub.get('/ledger?account=cash');
  const entry = ledger.body.entries[0];
  const rev = await hub.post(`/entries/${entry.entryId}/reverse`, { by: 'n2', reason: '利息计错，冲销', occurredAt: '2026-09-11T00:00:00Z' });
  assert.equal(rev.status, 201);

  bal = await hub.get('/balance');
  assert.equal(bal.body.cash.USD, 0);

  // 原分录仍在（不可删除）且标记被冲销；冲销分录为追加的负数分录
  const ledger2 = await hub.get('/ledger?account=cash');
  assert.equal(ledger2.body.entries.length, 2);
  assert.equal(ledger2.body.entries[0].reversedBy, rev.body.entryId);
  assert.equal(ledger2.body.entries[1].amountMinor, -5000);
  assert.equal(ledger2.body.entries[1].reversesEntryId, entry.entryId);

  // 同一分录不能重复冲销；调整必须填写原因
  assert.equal((await hub.post(`/entries/${entry.entryId}/reverse`, { by: 'n2', reason: 'x' })).status, 409);
  assert.equal((await hub.post('/adjustments', { currency: 'USD', amount: '1.00', by: 'n1' })).status, 400);
});

test('无法匹配的款项按等级进入人工队列', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());

  // 高：完全无同币种计划，资金来源不明
  const high = await hub.post('/receipts', { bank: 'A', externalRef: 'H-1', currency: 'EUR', amount: '10.00', occurredAt: '2026-09-01T00:00:00Z' });
  assert.equal(high.body.grade, 'high');

  // 中：有同币种计划但金额不符（疑似部分结算）
  await hub.post('/plans', { planId: 'p-eur', contractId: 'HT-E', currency: 'EUR', expected: '100.00', expectedDate: '2026-09-30' });
  const medium = await hub.post('/receipts', { bank: 'A', externalRef: 'M-1', currency: 'EUR', amount: '70.00', occurredAt: '2026-09-02T00:00:00Z' });
  assert.equal(medium.body.grade, 'medium');

  // 低：多个金额相同的候选计划，指向不明
  await hub.post('/plans', { planId: 'p-gbp-1', contractId: 'HT-G1', currency: 'GBP', expected: '200.00', expectedDate: '2026-09-30' });
  await hub.post('/plans', { planId: 'p-gbp-2', contractId: 'HT-G2', currency: 'GBP', expected: '200.00', expectedDate: '2026-09-30' });
  const low = await hub.post('/receipts', { bank: 'B', externalRef: 'L-1', currency: 'GBP', amount: '200.00', occurredAt: '2026-09-03T00:00:00Z' });
  assert.equal(low.body.grade, 'low');

  const queue = await hub.get('/cases?status=open');
  assert.deepEqual(queue.body.cases.map((c) => c.grade), ['high', 'medium', 'low']);
});

test('计划后到：自动撮合等待中的回单并关闭案件，重传仍得原结果', async (t) => {
  const hub = await startHub();
  t.after(() => hub.close());

  const r = await hub.post('/receipts', { bank: 'A', externalRef: 'W-1', currency: 'USD', amount: '888.00', occurredAt: '2026-09-04T00:00:00Z' });
  assert.equal(r.body.status, 'queued');

  const p = await hub.post('/plans', { planId: 'p-late', contractId: 'HT-L', currency: 'USD', expected: '888.00', expectedDate: '2026-09-30' });
  assert.equal(p.body.autoMatch.receiptId, r.body.receiptId);

  const bal = await hub.get('/balance');
  assert.equal(bal.body.cash.USD, 88800);
  const open = await hub.get('/cases?status=open');
  assert.equal(open.body.cases.length, 0);

  // 重传回单仍返回首次的 queued 结果，但回单当前状态已结算
  const again = await hub.post('/receipts', { bank: 'A', externalRef: 'W-1', currency: 'USD', amount: '888.00', occurredAt: '2026-09-04T00:00:00Z' });
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.status, 'queued');
  const receipt = await hub.get(`/receipts/${r.body.receiptId}`);
  assert.equal(receipt.body.matched, true);
});
