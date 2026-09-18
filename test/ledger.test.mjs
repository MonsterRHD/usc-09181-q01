import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, TIER } from '../src/domain/ledger.mjs';

function newLedger(tolerance = { USD: '1.00', CNY: '0.05' }) {
  const dir = mkdtempSync(join(tmpdir(), 'recon-'));
  return { ledger: new Ledger({ file: join(dir, 'ledger.jsonl'), tolerance }), dir };
}

const D1 = '2026-03-31T23:00:00Z';
const D2 = '2026-04-01T08:00:00Z';
const D3 = '2026-04-02T08:00:00Z';
const D4 = '2026-04-03T08:00:00Z';

async function setupUsdContract(l, { amount = '1098.00', ref = 'INV-1' } = {}) {
  return l.scheduleContract({
    contractId: 'C1', externalRef: ref, counterparty: 'ACME',
    currency: 'USD', expectedAmount: amount, dueAt: D4, by: 'planner',
  });
}

test('回单重传幂等：同银行同回单号只得到原处理结果，不重复入账', async () => {
  const { ledger } = newLedger();
  await setupUsdContract(ledger);
  const r1 = await ledger.importReceipt({
    bank: 'HSBC', bankReference: 'BK-001', externalRef: 'INV-1',
    currency: 'USD', amount: '1098.00', status: 'arrived', occurredAt: D3, by: 'cashier-a',
  });
  const r2 = await ledger.importReceipt({
    bank: 'HSBC', bankReference: 'BK-001', externalRef: 'INV-1',
    currency: 'USD', amount: '1098.00', status: 'arrived', occurredAt: D3, by: 'cashier-a',
  });
  assert.equal(r1.ok, true);
  assert.equal(r2.duplicated, true);
  assert.equal(r2.receiptId, r1.receiptId);
  assert.equal(r2.originalSeq, r1.seq);
  const report = ledger.report(D4);
  const c = report.contracts.find((x) => x.contractId === 'C1');
  assert.equal(c.settled, '1098.00');
  assert.equal(c.status, 'SETTLED');
  assert.equal(report.cash.length, 1);
  assert.equal(report.cash[0].balance, '1098.00');
});

test('生命周期以原始发生时间区分在途/到账；乱序推送也得到一致账面', async () => {
  const { ledger } = newLedger();
  await setupUsdContract(ledger, { amount: '1000.00' });
  // 先导入在途回单（发生在 3/31 晚），系统到 4/1 才收到
  const imp = await ledger.importReceipt({
    bank: 'BOA', bankReference: 'BK-002', externalRef: 'INV-1',
    currency: 'USD', amount: '1000.00', status: 'in_transit', occurredAt: D1, by: 'cashier-b',
  });
  // 乱序：先收到到账通知（发生在 4/1 凌晨），随后又补推一条更早的在途通知
  await ledger.pushNotification({
    receiptId: imp.receiptId, notificationId: 'N-ARRIVE', status: 'arrived',
    occurredAt: '2026-04-01T02:10:00Z', by: 'cashier-b',
  });
  await ledger.pushNotification({
    receiptId: imp.receiptId, notificationId: 'N-TRANSIT-LATE', status: 'in_transit',
    occurredAt: '2026-03-31T22:00:00Z', by: 'cashier-b',
  });
  // 重复推送同一条通知：幂等
  const dup = await ledger.pushNotification({
    receiptId: imp.receiptId, notificationId: 'N-ARRIVE', status: 'arrived',
    occurredAt: '2026-04-01T02:10:00Z', by: 'cashier-b',
  });
  assert.equal(dup.duplicated, true);

  const before = ledger.report('2026-03-31T23:59:59Z');
  assert.deepEqual(before.cash, []); // 跨日到账不能覆盖前一日判断
  const after = ledger.report('2026-04-01T03:00:00Z');
  assert.equal(after.cash[0].balance, '1000.00');

  const view = ledger._receiptView(imp.receiptId);
  assert.equal(view.state, 'ARRIVED');
  assert.equal(view.lifecycle.length, 3);
  // 时间线按原始发生时间排序，而不是推送顺序
  assert.equal(view.lifecycle[0].status, 'in_transit');
  assert.equal(view.lifecycle[1].status, 'in_transit');
  assert.equal(view.lifecycle[2].status, 'arrived');
});

test('汇率保留报价来源与生效时刻；结算间汇率变更只影响新结算', async () => {
  const { ledger } = newLedger();
  await setupUsdContract(ledger, { amount: '1098.00' });
  await ledger.registerFxQuote({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.10', source: 'BANK_A', effectiveAt: '2026-03-01T00:00:00Z' });
  await ledger.registerFxQuote({ fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.08', source: 'REUTERS', effectiveAt: D3 });

  // 4/1 到账 EUR 900 -> 用 1.10 = 990.00 USD
  const r1 = await ledger.importReceipt({
    bank: 'HSBC', bankReference: 'BK-EUR-1', externalRef: 'INV-1',
    currency: 'EUR', amount: '900.00', status: 'arrived', occurredAt: D2,
  });
  assert.match(r1.autoMatch.matched, /^mtch_/);
  assert.equal(r1.autoMatch.fx.source, 'BANK_A');
  assert.equal(r1.autoMatch.fx.rate, '1.10');

  // 4/3 到账 EUR 100 -> 用 1.08 = 108.00 USD
  const r2 = await ledger.importReceipt({
    bank: 'HSBC', bankReference: 'BK-EUR-2', externalRef: 'INV-1',
    currency: 'EUR', amount: '100.00', status: 'arrived', occurredAt: D4,
  });
  assert.equal(r2.autoMatch.fx.source, 'REUTERS');

  const rep = ledger.report(D4);
  const c = rep.contracts.find((x) => x.contractId === 'C1');
  assert.equal(c.settled, '1098.00');
  assert.equal(c.status, 'SETTLED');
  assert.deepEqual(c.fxUsed.map((f) => f.source).sort(), ['BANK_A', 'REUTERS']);
  assert.equal(c.fxUsed[0].effectiveAt, '2026-03-01T00:00:00Z');

  // 历史时点重算：4/2 只看到第一笔，且用旧汇率
  const hist = ledger.report('2026-04-02T00:00:00Z');
  assert.equal(hist.contracts[0].settled, '990.00');
});

test('部分结算：partial 回单按已到金额核销，到齐后结清', async () => {
  const { ledger } = newLedger();
  await setupUsdContract(ledger, { amount: '500.00' });
  const imp = await ledger.importReceipt({
    bank: 'SCB', bankReference: 'BK-P1', externalRef: 'INV-1',
    currency: 'USD', amount: '500.00', status: 'partial', partialAmount: '200.00',
    occurredAt: D2,
  });
  let c = ledger.report(D3).contracts[0];
  assert.equal(c.settled, '200.00');
  assert.equal(c.status, 'PARTIAL_SETTLED');
  assert.equal(imp.view.state, 'PARTIALLY_SETTLED');

  await ledger.pushNotification({ receiptId: imp.receiptId, notificationId: 'N-REST', status: 'arrived', occurredAt: D3 });
  c = ledger.report(D4).contracts[0];
  assert.equal(c.settled, '500.00');
  assert.equal(c.status, 'SETTLED');
});

test('无法匹配的款项分级进入队列：L3 孤儿 / L2 缺汇率 / L1 容差溢缴', async () => {
  const { ledger } = newLedger();
  await setupUsdContract(ledger, { amount: '1000.00' });

  // 无参考号 → L3
  const orphan = await ledger.importReceipt({ bank: 'HSBC', bankReference: 'BK-X1', currency: 'USD', amount: '50', status: 'arrived', occurredAt: D2 });
  assert.ok(orphan.autoMatch.queued);
  const q3 = ledger.report(D4).queue.items.find((i) => i.itemId === orphan.autoMatch.queued);
  assert.equal(q3.tier, TIER.L3_ORPHAN);

  // 有参考号但无合同 → L3
  const noContract = await ledger.importReceipt({ bank: 'HSBC', bankReference: 'BK-X2', externalRef: 'NOPE', currency: 'USD', amount: '50', status: 'arrived', occurredAt: D2 });
  assert.equal(ledger.report(D4).queue.items.find((i) => i.itemId === noContract.autoMatch.queued).tier, TIER.L3_ORPHAN);

  // 缺汇率 → L2
  const noFx = await ledger.importReceipt({ bank: 'HSBC', bankReference: 'BK-X3', externalRef: 'INV-1', currency: 'JPY', amount: '50000', status: 'arrived', occurredAt: D2 });
  const q2 = ledger.report(D4).queue.items.find((i) => i.itemId === noFx.autoMatch.queued);
  assert.equal(q2.tier, TIER.L2_MISMATCH);
  assert.match(q2.reason, /缺可用汇率/);

  // 补齐汇率后 retry → 自动核销（JPY 50000 × 0.0067 = 335.00 USD，合同仍欠 665）
  await ledger.registerFxQuote({ fromCurrency: 'JPY', toCurrency: 'USD', rate: '0.0067', source: 'BANK_B', effectiveAt: '2026-03-01T00:00:00Z' });
  const retried = await ledger.retryItem(noFx.autoMatch.queued, 'cashier-a');
  assert.match(retried.matched, /^mtch_/);
  assert.equal(retried.fx.source, 'BANK_B');
  assert.equal(ledger.report(D4).contracts[0].settled, '335.00');

  // 溢缴 0.50 在容差 1.00 内 → L1（注意上面已核销 335，合同欠 665；来 665.50 即溢 0.50）
  const over = await ledger.importReceipt({ bank: 'HSBC', bankReference: 'BK-X4', externalRef: 'INV-1', currency: 'USD', amount: '665.50', status: 'arrived', occurredAt: D2 });
  const q1 = ledger.report(D4).queue.items.find((i) => i.itemId === over.autoMatch.queued);
  assert.equal(q1.tier, TIER.L1_PROBABLE);
  assert.match(q1.reason, /容差/);
});

test('两名出纳同时认领：只有一人成功，另一人收到 409', async () => {
  const { ledger } = newLedger();
  const orphan = await ledger.importReceipt({ bank: 'HSBC', bankReference: 'BK-CONC', currency: 'USD', amount: '50', status: 'arrived', occurredAt: D2 });
  const itemId = orphan.autoMatch.queued;
  const [a, b] = await Promise.allSettled([
    ledger.claimItem(itemId, 'cashier-a'),
    ledger.claimItem(itemId, 'cashier-b'),
  ]);
  // 两人同时发起：恰好一人 ok，另一人 409
  const ok = [a, b].filter((r) => r.status === 'fulfilled' && r.value.ok);
  const conflict = [a, b].find((r) => r.status === 'rejected' && r.reason.statusCode === 409);
  assert.equal(ok.length, 1);
  assert.ok(conflict);
  const winner = ok[0].value.claimedBy;
  const loser = winner === 'cashier-a' ? 'cashier-b' : 'cashier-a';
  // 赢家重复认领自己 → 幂等；输家再认领 → 409（两次）
  assert.equal((await ledger.claimItem(itemId, winner)).duplicated, true);
  await Promise.all([ledger.claimItem(itemId, loser), ledger.claimItem(itemId, loser)].map((p) =>
    p.then(() => assert.fail('应当冲突')).catch((e) => assert.equal(e.statusCode, 409))));
  const q = ledger.report(D4).queue.items.find((i) => i.itemId === itemId);
  assert.equal(q.status, 'CLAIMED');
  assert.equal(q.claimedBy, winner);
});

test('主管闭环留下不可删除的依据；重复闭环与越权被拒；更正只能追加', async () => {
  const { ledger } = newLedger();
  await setupUsdContract(ledger, { amount: '50.00' });
  const orphan = await ledger.importReceipt({ bank: 'HSBC', bankReference: 'BK-SUP', currency: 'USD', amount: '50', status: 'arrived', occurredAt: D2 });
  const itemId = orphan.autoMatch.queued;

  await assert.rejects(
    ledger.resolveItem(itemId, { role: 'cashier', by: 'cashier-a', decision: 'suspense' }),
    /仅主管/,
  );
  const res = await ledger.resolveItem(itemId, { role: 'supervisor', by: 'boss', decision: 'match', contractId: 'C1', memo: '合同号手填，金额一致' });
  assert.match(res.matchId, /^mtch_/);

  const q = ledger.report(D4).queue.items.find((i) => i.itemId === itemId);
  assert.equal(q.status, 'RESOLVED');
  assert.equal(q.resolution.decision, 'match');
  assert.equal(q.resolution.evidence.bankReference, 'BK-SUP');
  assert.equal(q.resolution.evidence.receiptOccurredAt, D2);
  assert.ok(q.resolution.evidence.receiptImportedRef > 0);

  // 同决策重放 → 幂等；不同决策 → 拒绝
  const again = await ledger.resolveItem(itemId, { role: 'supervisor', by: 'boss', decision: 'match', contractId: 'C1' });
  assert.equal(again.duplicated, true);
  await assert.rejects(
    ledger.resolveItem(itemId, { role: 'supervisor', by: 'boss', decision: 'return' }),
    /已闭环/,
  );

  // 事后发现多认了 10 美元：只能追加分录冲减，原匹配与依据仍在
  const matchId = res.matchId;
  const corr = await ledger.postEntry({
    kind: 'matchCorrection', clientEntryId: 'FIX-1', refMatchId: matchId,
    delta: '-10.00', reason: '手续费误计入收入', occurredAt: D4, by: 'boss',
  });
  assert.match(corr.correctionId, /^corr_/);
  // 更正也幂等
  assert.equal((await ledger.postEntry({
    kind: 'matchCorrection', clientEntryId: 'FIX-1', refMatchId: matchId, delta: '-10.00', occurredAt: D4,
  })).duplicated, true);

  const c = ledger.report(D4).contracts.find((x) => x.contractId === 'C1');
  assert.equal(c.settled, '40.00');
  // 审计链里原始匹配、主管依据、更正分录全部存在，事件数只增不减
  const types = ledger.events.map((e) => e.type);
  assert.ok(types.includes('matchRecorded'));
  assert.ok(types.includes('queueItemResolved'));
  assert.ok(types.includes('matchCorrectionRecorded'));
});

test('人工调整与撤销：撤销以追加分录完成，不删除原分录', async () => {
  const { ledger } = newLedger();
  const adj = await ledger.postEntry({ kind: 'adjustment', clientEntryId: 'ADJ-1', account: 'CASH-HSBC', currency: 'USD', amount: '100.00', reason: '银行手续费补录', occurredAt: D2, by: 'cashier-a' });
  const rev = await ledger.postEntry({ kind: 'reversal', clientEntryId: 'REV-1', refEntryId: adj.entryId, reason: '录错账户', occurredAt: D3, by: 'boss' });
  assert.match(rev.entryId, /^ent_/);
  const rep = ledger.report(D4);
  assert.equal(rep.cash.find((x) => x.account === 'CASH-HSBC').balance, '0.00');
  const entries = ledger.events.filter((e) => e.type === 'manualEntryRecorded');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].refEntryId, entries[0].entryId); // 原分录仍在
});

test('退汇进入 L2 队列且不产生现金；在途回单不产生现金', async () => {
  const { ledger } = newLedger();
  await setupUsdContract(ledger, { amount: '100.00' });
  const ret = await ledger.importReceipt({ bank: 'HSBC', bankReference: 'BK-RET', externalRef: 'INV-1', currency: 'USD', amount: '100', status: 'returned', occurredAt: D2 });
  const q = ledger.report(D4).queue.items.find((i) => i.itemId === ret.queueItemId);
  assert.equal(q.tier, TIER.L2_MISMATCH);
  assert.match(q.reason, /退汇/);
  assert.deepEqual(ledger.report(D4).cash, []);
});

test('月末冻结后跨日到账不改变冻结结论，且可重新验证', async () => {
  const { ledger } = newLedger();
  await setupUsdContract(ledger, { amount: '1000.00' });
  // 3/31 在途
  const imp = await ledger.importReceipt({ bank: 'HSBC', bankReference: 'BK-FRZ', externalRef: 'INV-1', currency: 'USD', amount: '1000', status: 'in_transit', occurredAt: D1 });
  const frozen = await ledger.freeze('2026-03-31T23:59:59Z', 'boss');
  // 4/1 才到账
  await ledger.pushNotification({ receiptId: imp.receiptId, notificationId: 'N1', status: 'arrived', occurredAt: '2026-04-01T02:00:00Z' });
  const check = ledger.verifyFreeze(frozen.frozenSeq);
  assert.equal(check.ok, true); // 历史结论重算仍一致
  assert.equal(ledger.report('2026-03-31T23:59:59Z').cash.length, 0);
  assert.equal(ledger.report('2026-04-01T03:00:00Z').cash[0].balance, '1000.00');
});

test('进程重启后重放日志：队列、余额、幂等索引全部恢复且一致', async () => {
  const { ledger, dir } = newLedger();
  await setupUsdContract(ledger, { amount: '1000.00' });
  const imp = await ledger.importReceipt({ bank: 'HSBC', bankReference: 'BK-RST', externalRef: 'INV-1', currency: 'USD', amount: '1000', status: 'partial', partialAmount: '900', occurredAt: D2 });
  await ledger.importReceipt({ bank: 'HSBC', bankReference: 'BK-ORPHAN', currency: 'USD', amount: '30', status: 'arrived', occurredAt: D2 });
  await ledger.postEntry({ kind: 'adjustment', account: 'SUSPENSE', currency: 'USD', amount: '5.00', reason: '尾差挂账', occurredAt: D3, by: 'boss' });
  const before = ledger.report(D4);

  // 用同一文件重新构造 Ledger（模拟进程再次启动）
  const rebooted = new Ledger({ file: join(dir, 'ledger.jsonl'), tolerance: { USD: '1.00' } });
  assert.deepEqual(rebooted.report(D4), before);
  // 重启后重传仍是原结果
  const dup = await rebooted.importReceipt({ bank: 'HSBC', bankReference: 'BK-RST', externalRef: 'INV-1', currency: 'USD', amount: '1000', status: 'partial', partialAmount: '900', occurredAt: D2 });
  assert.equal(dup.duplicated, true);
  assert.equal(dup.receiptId, imp.receiptId);
  // 重启后未处理队列仍可认领/闭环
  const open = rebooted.report(D4).queue.items.filter((i) => i.status !== 'RESOLVED');
  assert.equal(open.length, 1);
  assert.equal(open[0].tier, TIER.L3_ORPHAN);
  await assert.doesNotReject(rebooted.claimItem(open[0].itemId, 'cashier-a'));
});

test('审计哈希链：篡改或删除任一事件都会被发现', async () => {
  const { ledger, dir } = newLedger();
  await setupUsdContract(ledger);
  await ledger.importReceipt({ bank: 'HSBC', bankReference: 'BK-TAMPER', externalRef: 'INV-1', currency: 'USD', amount: '100', status: 'arrived', occurredAt: D2 });
  assert.equal(ledger.verifyChain().ok, true);

  const file = join(dir, 'ledger.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  // 把回单金额从 100.00 改成 999.00（事件体里保存为 amountMinor 整数）
  const tampered = lines.map((line) => line.includes('BK-TAMPER') ? line.replace('"amountMinor":"10000"', '"amountMinor":"99900"') : line);
  writeFileSync(file, tampered.join('\n') + '\n');
  const hacked = new Ledger({ file, tolerance: { USD: '1.00' } });
  const result = hacked.verifyChain();
  assert.equal(result.ok, false);
  assert.ok(result.brokenAt > 0);

  // 删除中间事件 → 链断裂
  writeFileSync(file, lines.filter((_, i) => i !== 1).join('\n') + '\n');
  assert.equal(new Ledger({ file }).verifyChain().ok, false);
});
