// 对账核心：所有业务状态都由「追加事件」推导（event sourcing）。
// 命令只做校验 + 追加事件；投影在重放时重建。进程重启 = 重放日志。
import { createHash } from 'node:crypto';
import { FxRegistry } from './fx.mjs';
import { FileEventStore, Mutex } from './store.mjs';
import { applyRate, formatAmount, genId, parseAmount } from './util.mjs';

// 常见币种最小单位精度；未知币种默认 2 位，可用 registerCurrency 覆盖。
const DEFAULT_EXPONENT = 2;
const CURRENCY_EXPONENT = new Map([
  ['JPY', 0], ['KRW', 0], ['VND', 0], ['IDR', 0],
]);

export function exponentOf(currency, overrides = new Map()) {
  if (overrides.has(currency)) return overrides.get(currency);
  if (CURRENCY_EXPONENT.has(currency)) return CURRENCY_EXPONENT.get(currency);
  return DEFAULT_EXPONENT;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function iso(s, field) {
  if (typeof s !== 'string' || !ISO.test(s)) throw new Error(`${field} 必须是 UTC ISO-8601 时刻，如 2026-04-01T08:00:00Z`);
  return s;
}
function bn(v) { return BigInt(v); }

// 队列分级
export const TIER = {
  L1_PROBABLE: 'L1_PROBABLE',   // 系统建议：合同号相符，差额在容差内（疑似手续费/尾差），主管确认即可
  L2_MISMATCH: 'L2_MISMATCH',   // 金额/币种严重不符、缺汇率、退汇待处置
  L3_ORPHAN: 'L3_ORPHAN',       // 完全无法匹配（无合同号、找不到合同）
};

export class Ledger {
  constructor({ file, tolerance = {}, clock = () => Date.now() } = {}) {
    this.store = new FileEventStore(file);
    this.fx = new FxRegistry();
    this._exponents = new Map();
    // 容差按合同币种配置：L1 与 L2 之间的门槛，0 表示必须完全一致
    this._tolerance = new Map(Object.entries(tolerance));
    this._lock = new Mutex();
    this._clock = clock;
    this._rebuild();
  }

  get recordedAt() { return new Date(this._clock()).toISOString(); }

  // ---------- 重放/投影 ----------
  _rebuild() {
    const s = this._state = {
      contracts: new Map(),
      receipts: new Map(),
      matches: new Map(),
      corrections: [],
      entries: new Map(),
      queue: new Map(),
      freezes: [],
      // 幂等索引：自然键 -> 首次处理产生的事件/结果
      dedupe: new Map(),
    };
    for (const e of this.store.events) this._apply(e);
  }

  _apply(e) {
    const s = this._state;
    switch (e.type) {
      case 'currencyRegistered':
        this._exponents.set(e.currency, e.exponent);
        break;
      case 'fxQuoteRegistered':
        this.fx._apply(e);
        break;
      case 'contractScheduled': {
        s.contracts.set(e.contractId, { ...e, settledMinor: 0n, correctionsMinor: 0n, status: 'OPEN' });
        s.dedupe.set(`contract:${e.contractId}`, e);
        break;
      }
      case 'receiptImported': {
        s.receipts.set(e.receiptId, {
          ...e,
          lifecycle: [{
            status: e.status,
            amountMinor: e.status === 'partial' ? e.partialAmountMinor : e.amountMinor,
            occurredAt: e.occurredAt, notificationId: null, seq: e.seq,
          }],
          knownSettled: e.status === 'arrived' ? bn(e.amountMinor)
            : e.status === 'partial' ? bn(e.partialAmountMinor) : 0n,
          knownReturned: e.status === 'returned' ? bn(e.amountMinor) : 0n,
        });
        s.dedupe.set(`receipt:${e.bank}|${e.bankReference}`, e);
        break;
      }
      case 'receiptNotified': {
        const r = s.receipts.get(e.receiptId);
        r.lifecycle.push({ status: e.status, amountMinor: e.amountMinor ?? null, occurredAt: e.occurredAt, notificationId: e.notificationId, reason: e.reason, seq: e.seq });
        r.lifecycle.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.seq - b.seq);
        if (e.status === 'arrived') r.knownSettled = bn(e.amountMinor ?? r.amountMinor);
        if (e.status === 'partial') r.knownSettled = BigInt(e.amountMinor);
        if (e.status === 'returned') r.knownReturned += bn(e.amountMinor ?? r.amountMinor);
        s.dedupe.set(`notif:${e.notificationId}`, e);
        break;
      }
      case 'matchRecorded': {
        s.matches.set(e.matchId, e);
        const c = s.contracts.get(e.contractId);
        c.settledMinor += bn(e.convertedAmountMinor);
        c.status = c.settledMinor + c.correctionsMinor >= bn(c.expectedAmountMinor) ? 'SETTLED' : 'PARTIAL_SETTLED';
        s.dedupe.set(`match:${e.receiptId}:${e.notificationId ?? 'import'}:${e.srcAmountMinor}`, e);
        break;
      }
      case 'matchCorrectionRecorded': {
        s.corrections.push(e);
        const c = s.contracts.get(e.contractId);
        c.correctionsMinor += bn(e.deltaMinor);
        const total = c.settledMinor + c.correctionsMinor;
        c.status = total === 0n ? 'OPEN' : total >= bn(c.expectedAmountMinor) ? 'SETTLED' : 'PARTIAL_SETTLED';
        s.dedupe.set(`correction:${e.clientCorrectionId || e.matchCorrectionId}`, e);
        break;
      }
      case 'manualEntryRecorded': {
        s.entries.set(e.entryId, e);
        s.dedupe.set(`entry:${e.clientEntryId || e.entryId}`, e);
        break;
      }
      case 'queueItemRaised':
        s.queue.set(e.itemId, { ...e, status: 'OPEN', claimedBy: null, claimHistory: [], resolution: null });
        break;
      case 'queueItemClaimed': {
        const q = s.queue.get(e.itemId);
        q.status = 'CLAIMED'; q.claimedBy = e.by;
        q.claimHistory.push({ by: e.by, at: e.at });
        break;
      }
      case 'queueItemResolved': {
        const q = s.queue.get(e.itemId);
        q.status = 'RESOLVED';
        q.resolution = e;
        break;
      }
      case 'reportFrozen':
        s.freezes.push(e);
        break;
      default:
        throw new Error(`未知事件类型: ${e.type}`);
    }
  }

  // 所有写命令都经过同一把锁：并发调用可保持检查与追加的原子性。
  _command(fn) { return this._lock.run(fn.bind(this)); }

  // ---------- 命令 ----------
  registerCurrency(currency, exponent) {
    return this._command(() => {
      if (!Number.isInteger(exponent) || exponent < 0 || exponent > 18) throw new Error('币种精度非法');
      if (this._exponents.has(currency) && this._exponents.get(currency) !== exponent) {
        throw new Error(`币种 ${currency} 精度已登记为 ${this._exponents.get(currency)}，不可更改（请用追加分录更正）`);
      }
      if (this._exponents.has(currency)) return { duplicated: true };
      const e = this.store.append({ type: 'currencyRegistered', currency, exponent, at: this.recordedAt });
      this._apply(e);
      return { ok: true };
    });
  }

  registerFxQuote(q) {
    return this._command(() => {
      iso(q.effectiveAt, 'effectiveAt');
      const event = this.fx.register({ ...q, recordedAt: this.recordedAt });
      this.store.append(event);
      return { ok: true, quoteId: event.quoteId };
    });
  }

  // 合同收款计划
  scheduleContract(input) {
    return this._command(() => {
      const contractId = input.contractId;
      const dup = this._state.dedupe.get(`contract:${contractId}`);
      if (dup) return { duplicated: true, contractId, originalSeq: dup.seq };
      if (!contractId || !input.externalRef) throw new Error('contractId 与 externalRef 必填');
      iso(input.dueAt, 'dueAt');
      const exponent = exponentOf(input.currency, this._exponents);
      const expectedAmountMinor = parseAmount(input.expectedAmount, exponent);
      const e = this.store.append({
        type: 'contractScheduled',
        contractId, externalRef: input.externalRef,
        counterparty: input.counterparty ?? null,
        currency: input.currency, exponent,
        expectedAmount: input.expectedAmount,
        expectedAmountMinor: expectedAmountMinor.toString(),
        dueAt: input.dueAt,
        plannedBy: input.by ?? null,
        recordedAt: this.recordedAt,
      });
      this._apply(e);
      return { ok: true, contractId, seq: e.seq };
    });
  }

  // 导入银行回单（幂等：同银行+同回单号重传只返回原结果）。
  // 金额单位为回单币种十进制字符串；occurredAt 是回单上的原始发生时间，不是系统时间。
  importReceipt(input) {
    return this._command(() => {
      const { bank, bankReference } = input;
      if (!bank || !bankReference) throw new Error('bank 与 bankReference 必填');
      const dedupeKey = `receipt:${bank}|${bankReference}`;
      const dup = this._state.dedupe.get(dedupeKey);
      if (dup) {
        return { duplicated: true, receiptId: dup.receiptId, originalSeq: dup.seq, view: this._receiptView(dup.receiptId) };
      }
      iso(input.occurredAt, 'occurredAt');
      const status = input.status ?? 'arrived';
      if (!['in_transit', 'arrived', 'partial', 'returned'].includes(status)) throw new Error('回单初始状态非法');
      const exponent = exponentOf(input.currency, this._exponents);
      const amountMinor = parseAmount(input.amount, exponent);
      if (amountMinor <= 0n) throw new Error('回单金额必须为正');
      let partialAmountMinor = null;
      if (status === 'partial') {
        partialAmountMinor = parseAmount(input.partialAmount ?? '0', exponent).toString();
        if (BigInt(partialAmountMinor) <= 0n || BigInt(partialAmountMinor) >= amountMinor) throw new Error('部分结算金额必须在 0 与全额之间');
      }
      const receiptId = input.receiptId ?? genId('rcpt');
      const e = this.store.append({
        type: 'receiptImported',
        receiptId, bank, bankReference,
        externalRef: input.externalRef ?? null,
        currency: input.currency, exponent,
        amount: input.amount, amountMinor: amountMinor.toString(),
        fee: input.fee ?? null,
        feeCurrency: input.feeCurrency ?? input.currency,
        status,
        partialAmountMinor,
        occurredAt: input.occurredAt,
        importedBy: input.by ?? null,
        recordedAt: this.recordedAt,
      });
      this._apply(e);
      const settle = status === 'arrived' ? amountMinor : status === 'partial' ? BigInt(partialAmountMinor) : 0n;
      const auto = settle > 0n ? this._autoMatch(e, settle, 'import') : null;
      const queueItemId = status === 'returned' ? this._raiseReturned(e) : (auto?.queued ?? null);
      return { ok: true, receiptId, seq: e.seq, autoMatch: auto, queueItemId, view: this._receiptView(receiptId) };
    });
  }

  // 后续生命周期通知：在途/到账/部分结算/退汇；可乱序到达、可重复推送（幂等）。
  pushNotification(input) {
    return this._command(() => {
      const dup = this._state.dedupe.get(`notif:${input.notificationId}`);
      if (dup) return { duplicated: true, notificationId: dup.notificationId, originalSeq: dup.seq, view: this._receiptView(dup.receiptId) };
      if (!input.notificationId) throw new Error('notificationId 必填');
      const r = this._state.receipts.get(input.receiptId);
      if (!r) throw new Error(`回单不存在: ${input.receiptId}`);
      iso(input.occurredAt, 'occurredAt');
      if (!['in_transit', 'arrived', 'partial', 'returned'].includes(input.status)) throw new Error('通知状态非法');
      let amountMinor = null;
      if (input.status === 'arrived') amountMinor = (input.amount ? parseAmount(input.amount, r.exponent) : bn(r.amountMinor)).toString();
      if (input.status === 'partial') {
        amountMinor = parseAmount(input.amount ?? '0', r.exponent).toString();
        if (BigInt(amountMinor) <= 0n || BigInt(amountMinor) > bn(r.amountMinor)) throw new Error('部分结算累计金额超出回单全额');
      }
      if (input.status === 'returned') amountMinor = (input.amount ? parseAmount(input.amount, r.exponent) : bn(r.amountMinor)).toString();
      const prevSettled = r.knownSettled;
      const e = this.store.append({
        type: 'receiptNotified',
        notificationId: input.notificationId,
        receiptId: r.receiptId, bank: r.bank, bankReference: r.bankReference,
        status: input.status, amountMinor,
        occurredAt: input.occurredAt,
        reason: input.reason ?? null,
        notifiedBy: input.by ?? null,
        recordedAt: this.recordedAt,
      });
      this._apply(e);
      // 增量核销：与通知到达顺序无关，按「本次事件后已知累计到账」减去事件前的累计。
      let increment = 0n;
      if (input.status === 'arrived') increment = bn(amountMinor) - prevSettled;
      if (input.status === 'partial') increment = BigInt(amountMinor) - prevSettled;
      let auto = null;
      const hasOpenQueue = [...this._state.queue.values()].some((q) => q.receiptId === r.receiptId && q.status !== 'RESOLVED');
      if (input.status === 'returned' && !hasOpenQueue) {
        // 退汇必须有人处置：抬入 L2 队列。
        this._raise(r, TIER.L2_MISMATCH, input.reason ? `退汇：${input.reason}` : '退汇通知，待主管确认处置', input.notificationId);
      } else if (increment > 0n) {
        // 已进队列未闭环，或曾发生退汇又来钱（通常应是新回单）——不自动核销，等主管处置。
        if (hasOpenQueue || r.knownReturned > 0n) {
          if (!hasOpenQueue) this._raise(r, TIER.L2_MISMATCH, '退汇后又收到到账通知，需人工核实是否为重汇', input.notificationId);
        } else {
          auto = this._autoMatch(r, increment, input.notificationId, input.occurredAt);
        }
      }
      return { ok: true, seq: e.seq, autoMatch: auto, view: this._receiptView(r.receiptId) };
    });
  }

  // 自动匹配尝试；失败按分级抬入人工队列。返回 {matched}|{queued:itemId}|null
  _autoMatch(receipt, srcIncrementMinor, notificationId, occurredAt = receipt.occurredAt) {
    const s = this._state;
    if (!receipt.externalRef) {
      return { queued: this._raise(receipt, TIER.L3_ORPHAN, '回单未带合同/业务参考号', notificationId) };
    }
    const contract = [...s.contracts.values()].find((c) => c.externalRef === receipt.externalRef);
    if (!contract) {
      return { queued: this._raise(receipt, TIER.L3_ORPHAN, `找不到参考号 ${receipt.externalRef} 对应的合同`, notificationId) };
    }
    // 换算快照：使用该笔款项「原始发生时刻」生效的报价。
    let convertedMinor, fx = null;
    if (receipt.currency === contract.currency) {
      convertedMinor = srcIncrementMinor;
    } else {
      let quote;
      try { quote = this.fx.quoteAt(receipt.currency, contract.currency, occurredAt); }
      catch (err) {
        return { queued: this._raise(receipt, TIER.L2_MISMATCH, `缺可用汇率: ${err.message}`, notificationId) };
      }
      convertedMinor = applyRate(srcIncrementMinor, bn(quote.rateMinor), receipt.exponent, contract.exponent);
      fx = { quoteId: quote.quoteId, rate: quote.rate, source: quote.source, effectiveAt: quote.effectiveAt };
    }
    const outstanding = bn(contract.expectedAmountMinor) - contract.settledMinor - contract.correctionsMinor;
    if (convertedMinor > outstanding) {
      const tol = parseAmount(this._tolerance.get(contract.currency) ?? '0', contract.exponent);
      const over = convertedMinor - outstanding;
      if (tol > 0n && over <= tol) {
        return { queued: this._raise(receipt, TIER.L1_PROBABLE, `到账超出待收 ${formatAmount(over, contract.exponent)}，在容差内，疑似尾差`, notificationId, { suggestedContractId: contract.contractId, fx }) };
      }
      return { queued: this._raise(receipt, TIER.L2_MISMATCH, `金额超出合同待收（溢缴 ${formatAmount(over, contract.exponent)}）`, notificationId, { suggestedContractId: contract.contractId, fx }) };
    }
    const matchId = genId('mtch');
    const e = this.store.append({
      type: 'matchRecorded',
      matchId,
      receiptId: receipt.receiptId,
      contractId: contract.contractId,
      notificationId: notificationId === 'import' ? null : notificationId,
      srcCurrency: receipt.currency,
      srcAmountMinor: srcIncrementMinor.toString(),
      occurredAt,                       // 用原始发生时间入账，保证跨日报表正确
      fx,
      convertedCurrency: contract.currency,
      convertedAmountMinor: convertedMinor.toString(),
      recordedAt: this.recordedAt,
    });
    this._apply(e);
    return { matched: matchId, contractId: contract.contractId, fx };
  }

  _raise(receipt, tier, reason, notificationId, extra = {}) {
    const e = this.store.append({
      type: 'queueItemRaised',
      itemId: genId('qi'),
      tier, reason,
      receiptId: receipt.receiptId,
      bank: receipt.bank, bankReference: receipt.bankReference,
      currency: receipt.currency, amountMinor: receipt.amountMinor,
      externalRef: receipt.externalRef,
      notificationId: notificationId === 'import' ? null : notificationId ?? null,
      suggestion: extra,
      raisedAt: this.recordedAt,
    });
    this._apply(e);
    return e.itemId;
  }

  _raiseReturned(receipt) {
    return this._raise(receipt, TIER.L2_MISMATCH, '退汇回单，待主管确认处置（原路退回/重汇/挂账）', 'import');
  }

  // 人工队列：出纳认领（两人同时认领只可能一人成功）
  claimItem(itemId, by) {
    return this._command(() => {
      const q = this._state.queue.get(itemId);
      if (!q) throw new Error('队列项不存在');
      if (q.status === 'RESOLVED') throw new Error('队列项已由主管闭环');
      if (q.status === 'CLAIMED') {
        if (q.claimedBy === by) return { duplicated: true, itemId, claimedBy: by };
        const err = new Error(`已被 ${q.claimedBy} 认领`); err.statusCode = 409; throw err;
      }
      const e = this.store.append({ type: 'queueItemClaimed', itemId, by, at: this.recordedAt });
      this._apply(e);
      return { ok: true, itemId, claimedBy: by };
    });
  }

  // 主管闭环：决策与依据（回单/通知/事件序号）一并固化，之后不可删除。
  resolveItem(itemId, input) {
    return this._command(() => {
      if (input.role !== 'supervisor') { const err = new Error('仅主管可以闭环人工队列'); err.statusCode = 403; throw err; }
      const q = this._state.queue.get(itemId);
      if (!q) throw new Error('队列项不存在');
      if (q.status === 'RESOLVED') {
        if (q.resolution.decision === input.decision && q.resolution.contractId === (input.contractId ?? null)) {
          return { duplicated: true, itemId, resolutionSeq: q.resolution.seq };
        }
        throw new Error('队列项已闭环且决策不同；如需更改请追加更正分录');
      }
      if (!['match', 'suspense', 'return'].includes(input.decision)) throw new Error('决策非法：match | suspense | return');
      let matchId = null;
      if (input.decision === 'match') {
        const contract = this._state.contracts.get(input.contractId);
        if (!contract) throw new Error('指定的合同不存在');
        const receipt = this._state.receipts.get(q.receiptId);
        // 主管确认时按建议（或重新换算）核销当前仍未核销部分
        const alreadyMatched = [...this._state.matches.values()]
          .filter((m) => m.receiptId === receipt.receiptId)
          .reduce((acc, m) => acc + bn(m.srcAmountMinor), 0n);
        const remaining = bn(receipt.amountMinor) - alreadyMatched - receipt.knownReturned;
        let me = null;
        if (remaining > 0n) {
          const fxAsOf = q.notificationId ? this._notifOccurredAt(receipt, q.notificationId) : receipt.occurredAt;
          let fx = null;
          let converted = remaining;
          if (receipt.currency !== contract.currency) {
            const quote = this.fx.quoteAt(receipt.currency, contract.currency, fxAsOf);
            fx = { quoteId: quote.quoteId, rate: quote.rate, source: quote.source, effectiveAt: quote.effectiveAt };
            converted = applyRate(remaining, bn(quote.rateMinor), receipt.exponent, contract.exponent);
          }
          me = this.store.append({
            type: 'matchRecorded',
            matchId: genId('mtch'),
            receiptId: receipt.receiptId, contractId: contract.contractId, notificationId: q.notificationId,
            srcCurrency: receipt.currency, srcAmountMinor: remaining.toString(),
            occurredAt: fxAsOf,
            fx, convertedCurrency: contract.currency, convertedAmountMinor: converted.toString(),
            supervisorApproved: true,
            recordedAt: this.recordedAt,
          });
          this._apply(me);
        } else if (!this._state.matches.values().some((m) => m.receiptId === receipt.receiptId && m.contractId === contract.contractId)) {
          throw new Error('该回单对指定合同没有任何核销记录，且已无剩余金额可确认');
        }
        matchId = me?.matchId ?? [...this._state.matches.values()].reverse()
          .find((m) => m.receiptId === receipt.receiptId && m.contractId === contract.contractId).matchId;
      }
      const receipt = this._state.receipts.get(q.receiptId);
      const e = this.store.append({
        type: 'queueItemResolved',
        itemId,
        decision: input.decision,
        contractId: input.contractId ?? null,
        matchId,
        memo: input.memo ?? '',
        by: input.by,
        // 不可删除的依据：原始回单、通知、导入事件序号都在；事件本身也永远无法删除。
        evidence: {
          receiptId: q.receiptId, bank: q.bank, bankReference: q.bankReference,
          notificationId: q.notificationId,
          receiptImportedRef: this._state.dedupe.get(`receipt:${q.bank}|${q.bankReference}`)?.seq ?? null,
          receiptOccurredAt: receipt.occurredAt, amount: receipt.amount, currency: receipt.currency,
        },
        at: this.recordedAt,
      });
      this._apply(e);
      return { ok: true, itemId, decision: input.decision, matchId };
    });
  }

  _notifOccurredAt(receipt, notificationId) {
    return receipt.lifecycle.find((l) => l.notificationId === notificationId)?.occurredAt ?? receipt.occurredAt;
  }

  // 补匹配：例如补齐历史生效的汇率后，对未决队列项重跑自动匹配
  retryItem(itemId, by) {
    return this._command(() => {
      const q = this._state.queue.get(itemId);
      if (!q) throw new Error('队列项不存在');
      if (q.status === 'RESOLVED') throw new Error('队列项已闭环');
      const receipt = this._state.receipts.get(q.receiptId);
      const alreadyMatched = [...this._state.matches.values()]
        .filter((m) => m.receiptId === receipt.receiptId)
        .reduce((acc, m) => acc + bn(m.srcAmountMinor), 0n);
      const remaining = bn(receipt.amountMinor) - alreadyMatched - receipt.knownReturned;
      if (remaining <= 0n) throw new Error('该回单已无待匹配金额');
      const result = this._autoMatch(receipt, remaining, q.notificationId ?? 'import');
      // retry 路径若成功会生成一个新的队列项之外的 match；原来的队列项需主管闭环（保留痕迹）。
      return result;
    });
  }

  // 人工分录：调整 / 撤销 / 更正 —— 永远追加，不删除原分录。
  postEntry(input) {
    return this._command(() => {
      const idem = input.clientEntryId ? `entry:${input.clientEntryId}` : null;
      if (idem && this._state.dedupe.has(idem)) {
        const orig = this._state.dedupe.get(idem);
        return { duplicated: true, entryId: orig.entryId, originalSeq: orig.seq };
      }
      iso(input.occurredAt, 'occurredAt');
      if (!['adjustment', 'reversal', 'matchCorrection'].includes(input.kind)) throw new Error('分录种类非法');
      const recordedAt = this.recordedAt;

      if (input.kind === 'matchCorrection') {
        const idemC = input.clientEntryId ? `correction:${input.clientEntryId}` : null;
        if (idemC && this._state.dedupe.has(idemC)) {
          const orig = this._state.dedupe.get(idemC);
          return { duplicated: true, correctionId: orig.matchCorrectionId, originalSeq: orig.seq };
        }
        const match = this._state.matches.get(input.refMatchId);
        if (!match) throw new Error('被更正的匹配不存在');
        const exponent = exponentOf(match.convertedCurrency, this._exponents);
        const deltaMinor = parseAmount(input.delta, exponent); // 带符号：冲减为负
        const e = this.store.append({
          type: 'matchCorrectionRecorded',
          matchCorrectionId: genId('corr'),
          clientCorrectionId: input.clientEntryId ?? null,
          refMatchId: match.matchId,
          contractId: match.contractId, receiptId: match.receiptId,
          currency: match.convertedCurrency, exponent,
          delta: input.delta, deltaMinor: deltaMinor.toString(),
          reason: input.reason ?? '',
          occurredAt: input.occurredAt, by: input.by ?? null, recordedAt,
        });
        this._apply(e);
        return { ok: true, correctionId: e.matchCorrectionId };
      }

      let refEntryId = null;
      let amountMinor;
      let currency;
      let account;
      if (input.kind === 'reversal') {
        const orig = this._state.entries.get(input.refEntryId);
        if (!orig) throw new Error('被撤销的分录不存在');
        if (orig.kind !== 'adjustment') throw new Error('只能撤销人工调整分录；更正匹配请用 matchCorrection');
        if (input.currency && input.currency !== orig.currency) throw new Error('撤销分录币种必须与原分录一致');
        currency = orig.currency;
        account = orig.account;
        amountMinor = -bn(orig.amountMinor);
        refEntryId = orig.entryId;
      } else {
        currency = input.currency;
        account = input.account ?? 'MANUAL';
        amountMinor = parseAmount(input.amount, exponentOf(currency, this._exponents));
      }
      if (amountMinor === 0n) throw new Error('分录金额不能为零');
      const exponent = exponentOf(currency, this._exponents);
      const e = this.store.append({
        type: 'manualEntryRecorded',
        entryId: genId('ent'),
        clientEntryId: input.clientEntryId ?? null,
        kind: input.kind, refEntryId,
        account,
        currency, exponent,
        amount: input.kind === 'reversal' ? null : (input.amount ?? null),
        amountMinor: amountMinor.toString(),
        reason: input.reason ?? '',
        occurredAt: input.occurredAt,
        by: input.by ?? null,
        recordedAt,
      });
      this._apply(e);
      return { ok: true, entryId: e.entryId };
    });
  }

  // ---------- 查询 / 重算 ----------
  _receiptView(id) {
    const r = this._state.receipts.get(id);
    if (!r) return null;
    const settled = r.knownSettled - (r.knownReturned > r.knownSettled ? r.knownSettled : r.knownReturned);
    let state;
    if (r.knownReturned > 0n) state = 'RETURNED';
    else if (r.knownSettled === 0n) state = 'IN_TRANSIT';
    else if (r.knownSettled < bn(r.amountMinor)) state = 'PARTIALLY_SETTLED';
    else state = 'ARRIVED';
    return {
      receiptId: r.receiptId, bank: r.bank, bankReference: r.bankReference,
      externalRef: r.externalRef, currency: r.currency,
      amount: formatAmount(bn(r.amountMinor), r.exponent),
      settled: formatAmount(settled < 0n ? 0n : settled, r.exponent),
      returned: formatAmount(r.knownReturned, r.exponent),
      state,
      lifecycle: r.lifecycle.map((l) => ({ status: l.status, occurredAt: l.occurredAt, notificationId: l.notificationId })),
    };
  }

  // 截至 asOf（含）的账面快照：跨日到账不会改动前一日的判断。
  report(asOf) {
    iso(asOf, 'asOf');
    const s = this._state;
    // 每个账户/币种的现金：回单按「原始发生时刻」累计到账/退回，人工分录按其 occurredAt。
    const cash = new Map();
    const addCash = (account, currency, exponent, delta) => {
      const k = `${account}|${currency}`;
      const row = cash.get(k) ?? { account, currency, exponent, minor: 0n };
      row.minor += delta; cash.set(k, row);
    };
    for (const r of s.receipts.values()) {
      let settled = 0n, returned = 0n;
      for (const l of r.lifecycle) {
        if (l.occurredAt > asOf) continue;
        if (l.status === 'arrived') settled = bn(l.amountMinor ?? r.amountMinor);
        if (l.status === 'partial') settled = BigInt(l.amountMinor);
        if (l.status === 'returned') returned += bn(l.amountMinor ?? r.amountMinor);
      }
      const net = settled - (returned > settled ? settled : returned);
      if (net !== 0n) addCash(r.bank, r.currency, r.exponent, net);
    }
    for (const en of s.entries.values()) {
      if (en.occurredAt <= asOf) addCash(en.account, en.currency, en.exponent, bn(en.amountMinor));
    }

    // 合同核销：匹配/更正都按 occurredAt 计入。
    const contracts = [];
    for (const c of s.contracts.values()) {
      let settledMinor = 0n;
      const fxUsed = [];
      for (const m of s.matches.values()) {
        if (m.contractId === c.contractId && m.occurredAt <= asOf) {
          settledMinor += bn(m.convertedAmountMinor);
          if (m.fx) fxUsed.push({ matchId: m.matchId, ...m.fx, convertedAmountMinor: m.convertedAmountMinor });
        }
      }
      for (const cr of s.corrections) {
        if (cr.contractId === c.contractId && cr.occurredAt <= asOf) settledMinor += bn(cr.deltaMinor);
      }
      const expected = bn(c.expectedAmountMinor);
      let status = 'OPEN';
      if (settledMinor !== 0n) status = settledMinor >= expected ? 'SETTLED' : 'PARTIAL_SETTLED';
      contracts.push({
        contractId: c.contractId, externalRef: c.externalRef, currency: c.currency,
        expected: formatAmount(expected, c.exponent),
        settled: formatAmount(settledMinor, c.exponent),
        outstanding: formatAmount(expected - settledMinor, c.exponent),
        status, fxUsed,
      });
    }

    const queue = [...s.queue.values()].map((q) => ({
      itemId: q.itemId, tier: q.tier, status: q.status, claimedBy: q.claimedBy,
      reason: q.reason, receiptId: q.receiptId, externalRef: q.externalRef,
      resolution: q.resolution ? { decision: q.resolution.decision, by: q.resolution.by, at: q.resolution.at, evidence: q.resolution.evidence } : null,
    }));

    return {
      asOf,
      cash: [...cash.values()].map((r) => ({ account: r.account, currency: r.currency, balance: formatAmount(r.minor, r.exponent) })),
      contracts,
      queue: {
        open: queue.filter((q) => q.status !== 'RESOLVED').length,
        claimed: queue.filter((q) => q.status === 'CLAIMED').length,
        resolved: queue.filter((q) => q.status === 'RESOLVED').length,
        byTier: {
          L1: queue.filter((q) => q.tier === TIER.L1_PROBABLE && q.status !== 'RESOLVED').length,
          L2: queue.filter((q) => q.tier === TIER.L2_MISMATCH && q.status !== 'RESOLVED').length,
          L3: queue.filter((q) => q.tier === TIER.L3_ORPHAN && q.status !== 'RESOLVED').length,
        },
        items: queue,
      },
    };
  }

  // 固化某期截止时刻的对账结论（之后跨日到账只影响新期间，无法改写此结论）。
  freeze(asOf, by) {
    return this._command(() => {
      iso(asOf, 'asOf');
      const r = this.report(asOf);
      const totals = {
        cash: r.cash.map((c) => `${c.account}:${c.currency}:${c.balance}`).sort(),
        contracts: r.contracts.map((c) => `${c.contractId}:${c.settled}:${c.status}`).sort(),
        openQueue: r.queue.open,
      };
      const e = this.store.append({
        type: 'reportFrozen',
        periodEnd: asOf, by: by ?? null,
        totalsHash: hashJson(totals), totals,
        recordedAt: this.recordedAt,
      });
      this._apply(e);
      return { ok: true, frozenSeq: e.seq, totalsHash: e.totalsHash };
    });
  }

  verifyFreeze(frozenSeq) {
    const f = this.store.events.find((e) => e.seq === frozenSeq && e.type === 'reportFrozen');
    if (!f) throw new Error('冻结记录不存在');
    const r = this.report(f.periodEnd);
    const totals = {
      cash: r.cash.map((c) => `${c.account}:${c.currency}:${c.balance}`).sort(),
      contracts: r.contracts.map((c) => `${c.contractId}:${c.settled}:${c.status}`).sort(),
      openQueue: r.queue.open,
    };
    return { ok: hashJson(totals) === f.totalsHash, periodEnd: f.periodEnd };
  }

  verifyChain() { return this.store.verifyChain(); }
  get events() { return this.store.events; }
}

function hashJson(obj) {
  return createHash('sha256').update(JSON.stringify(obj, Object.keys(obj).sort())).digest('hex');
}
