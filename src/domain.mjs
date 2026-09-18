import { canonical, sha256, newId, toIso, endOfDay } from './util.mjs';
import { parseAmount, parseRate, convert } from './money.mjs';

// ---------------------------------------------------------------------------
// 领域错误：HTTP 层据此映射状态码
// ---------------------------------------------------------------------------
export class DomainError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}
const bad = (code, msg) => new DomainError(400, code, msg);
const conflict = (code, msg) => new DomainError(409, code, msg);
const notFound = (code, msg) => new DomainError(404, code, msg);

const parseMoney = (v) => { try { return parseAmount(v); } catch (e) { throw bad('AMOUNT_INVALID', e.message); } };
const parseTime = (v) => { try { return toIso(v); } catch (e) { throw bad('TIME_INVALID', e.message); } };
const parseDay = (v) => { try { return endOfDay(v); } catch (e) { throw bad('DATE_INVALID', e.message); } };

const GRADE_ORDER = { high: 0, medium: 1, low: 2 };
const ACTIVE_CASE = ['open', 'claimed', 'resolved'];

// ---------------------------------------------------------------------------
// 状态：全部由事件回放推导，进程重启后可完整重算
// ---------------------------------------------------------------------------
export function initialState() {
  return {
    receipts: new Map(),      // receiptId -> 回单
    receiptRefs: new Map(),   // "bank|externalRef" -> receiptId（幂等键）
    importResults: new Map(), // 幂等键 -> 首次处理结果（重传只能拿到它）
    plans: new Map(),         // planId -> 合同收款计划
    quotes: [],               // 汇率报价（含来源与生效时刻）
    matches: new Map(),       // matchId -> 结算记录
    returns: [],              // 退汇确认记录
    cases: new Map(),         // caseId -> 人工队列案件
    entries: [],              // 分录（追加式，撤销只能追加冲销）
    days: new Map(),          // date -> 已封存的日快照
    seq: 0,
    headHash: 'GENESIS',
  };
}

const refKey = (bank, externalRef) => `${bank}|${externalRef}`;

// ---------------------------------------------------------------------------
// 事件还原（reducer）：回放与实时共用同一套逻辑
// ---------------------------------------------------------------------------
export function apply(state, event) {
  const p = event.payload;
  switch (event.type) {
    case 'receipt_imported':
      state.receipts.set(p.receiptId, { ...p, matched: false, matchId: null, seq: event.seq });
      state.receiptRefs.set(refKey(p.bank, p.externalRef), p.receiptId);
      break;
    case 'receipt_processed': {
      const r = state.receipts.get(p.receiptId);
      if (r) state.importResults.set(refKey(r.bank, r.externalRef), p.result);
      break;
    }
    case 'plan_registered':
      state.plans.set(p.planId, { ...p, seq: event.seq });
      break;
    case 'fx_quote_added':
      state.quotes.push({ ...p, seq: event.seq });
      state.quotes.sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : a.effectiveAt > b.effectiveAt ? 1 : a.seq - b.seq));
      break;
    case 'adjustment_recorded':
      break; // 财务效果体现在关联分录
    case 'receipt_matched': {
      state.matches.set(p.matchId, { ...p, seq: event.seq });
      const r = state.receipts.get(p.receiptId);
      if (r) { r.matched = true; r.matchId = p.matchId; }
      break;
    }
    case 'return_confirmed': {
      state.returns.push({ ...p, seq: event.seq });
      const r = state.receipts.get(p.receiptId);
      if (r) { r.matched = true; r.matchId = p.returnId; }
      break;
    }
    case 'receipt_written_off': {
      const r = state.receipts.get(p.receiptId);
      if (r) { r.matched = true; r.matchId = p.writeoffId; }
      break;
    }
    case 'entry_posted': {
      state.entries.push({ ...p, seq: event.seq, reversedBy: null });
      if (p.reversesEntryId) {
        const orig = state.entries.find((x) => x.entryId === p.reversesEntryId);
        if (orig) orig.reversedBy = p.entryId;
      }
      break;
    }
    case 'case_opened':
      state.cases.set(p.caseId, {
        ...p, status: 'open', claimedBy: null, resolution: null,
        confirmedBy: null, evidence: null, resolutionHash: null, corrections: [], seq: event.seq,
      });
      break;
    case 'case_claimed': {
      const c = state.cases.get(p.caseId);
      if (c) { c.status = 'claimed'; c.claimedBy = p.cashier; }
      break;
    }
    case 'case_resolved': {
      const c = state.cases.get(p.caseId);
      if (c) { c.status = 'resolved'; c.resolution = { action: p.action, params: p.params, by: p.by, at: p.occurredAt }; }
      break;
    }
    case 'case_confirmed': {
      const c = state.cases.get(p.caseId);
      if (c) { c.status = 'confirmed'; c.confirmedBy = p.supervisor; c.evidence = p.evidence; c.resolutionHash = p.resolutionHash; }
      break;
    }
    case 'case_corrected': {
      const c = state.cases.get(p.caseId);
      if (c) c.corrections.push({ by: p.by, correction: p.correction, occurredAt: p.occurredAt });
      break;
    }
    case 'case_closed': {
      const c = state.cases.get(p.caseId);
      if (c) { c.status = 'closed'; c.closeReason = p.how; }
      break;
    }
    case 'day_closed':
      state.days.set(p.date, p.snapshot);
      break;
    default:
      throw new Error(`未知事件类型: ${event.type}`);
  }
}

// ---------------------------------------------------------------------------
// 查询辅助
// ---------------------------------------------------------------------------
const mustReceipt = (state, id) => {
  const r = state.receipts.get(id);
  if (!r) throw notFound('RECEIPT_NOT_FOUND', `回单不存在: ${id}`);
  return r;
};
const mustPlan = (state, id) => {
  const p = state.plans.get(id);
  if (!p) throw notFound('PLAN_NOT_FOUND', `收款计划不存在: ${id}`);
  return p;
};
const mustCase = (state, id) => {
  const c = state.cases.get(id);
  if (!c) throw notFound('CASE_NOT_FOUND', `案件不存在: ${id}`);
  return c;
};

// 计划累计结算/退汇；end 不为空时只统计原始发生时间 <= end 的部分
function planTotals(state, planId, end = null) {
  let settled = 0;
  let returned = 0;
  for (const m of state.matches.values()) {
    if (m.planId === planId && (!end || m.occurredAt <= end)) settled += m.settledMinor;
  }
  for (const r of state.returns) {
    if (r.planId === planId && (!end || r.occurredAt <= end)) returned += r.amountMinor;
  }
  return { settled, returned };
}

// 取 at 时刻生效的最新报价（保留来源与生效时刻）
export function findQuote(quotes, from, to, at) {
  let best = null;
  for (const q of quotes) {
    if (q.from !== from || q.to !== to || q.effectiveAt > at) continue;
    if (!best || q.effectiveAt > best.effectiveAt || (q.effectiveAt === best.effectiveAt && q.seq > best.seq)) best = q;
  }
  return best;
}

const entryEvent = (account, currency, amountMinor, refType, refId, occurredAt, memo, reversesEntryId = null) => ({
  type: 'entry_posted',
  payload: { entryId: newId('entry'), account, currency, amountMinor, refType, refId, occurredAt, memo, reversesEntryId },
});

// 结算事件 + 现金/手续费分录；跨币种时按回单原始发生时刻的生效报价换算并留痕
function buildMatchEvents(state, { receipt, plan, amountMinor, auto, by, occurredAt }) {
  const receiptCcy = receipt.currency;
  const planCcy = plan.currency;
  let settledMinor;
  let quote = null;
  if (receiptCcy === planCcy) {
    settledMinor = amountMinor;
  } else {
    const q = findQuote(state.quotes, receiptCcy, planCcy, occurredAt);
    if (!q) throw bad('QUOTE_MISSING', `缺少 ${receiptCcy}→${planCcy} 于 ${occurredAt} 前生效的报价`);
    quote = { rate: q.rate, source: q.source, effectiveAt: q.effectiveAt };
    settledMinor = convert(amountMinor, q.rate);
  }
  if (settledMinor <= 0) throw bad('MATCH_AMOUNT_INVALID', '结算金额必须为正');
  const t = planTotals(state, plan.planId);
  const remaining = plan.expectedMinor - t.settled + t.returned;
  if (settledMinor > remaining) throw conflict('MATCH_EXCEEDS_PLAN', `结算金额 ${settledMinor} 超出计划剩余 ${remaining}`);
  const settlement = settledMinor === remaining ? 'full' : 'partial';
  const matchId = newId('match');
  const events = [
    {
      type: 'receipt_matched',
      payload: {
        matchId, receiptId: receipt.receiptId, planId: plan.planId,
        receiptCurrency: receiptCcy, receiptMinor: amountMinor,
        planCurrency: planCcy, settledMinor, settlement, quote, auto, by, occurredAt,
      },
    },
    entryEvent('cash', receiptCcy, amountMinor - receipt.feeMinor, 'match', matchId, occurredAt, `回单 ${receipt.receiptId} 到账`),
  ];
  if (receipt.feeMinor > 0) {
    events.push(entryEvent('fee_expense', receiptCcy, receipt.feeMinor, 'match', matchId, occurredAt, `回单 ${receipt.receiptId} 手续费`));
  }
  return { events, matchId, settlement, settledMinor, quote };
}

function openCase(state, events, { receipt, grade, reason, detail, occurredAt }) {
  for (const c of state.cases.values()) {
    if (c.receiptId === receipt.receiptId && ACTIVE_CASE.includes(c.status)) return c.caseId;
  }
  const caseId = newId('case');
  events.push({ type: 'case_opened', payload: { caseId, grade, reason, receiptId: receipt.receiptId, detail, occurredAt } });
  return caseId;
}

function closeOpenCaseForReceipt(state, events, receiptId, occurredAt) {
  for (const c of state.cases.values()) {
    if (c.receiptId === receiptId && ACTIVE_CASE.includes(c.status)) {
      events.push({ type: 'case_closed', payload: { caseId: c.caseId, how: 'matched', occurredAt } });
    }
  }
}

// ---------------------------------------------------------------------------
// 命令：每个命令都是纯决策（返回事件或抛错），由外层统一落库，杜绝半状态
// ---------------------------------------------------------------------------

// 导入银行回单：按 (bank, externalRef) 幂等，重传只能得到首次处理结果
export function importReceipt(state, cmd) {
  const { bank, externalRef } = cmd;
  if (!bank || !externalRef) throw bad('RECEIPT_REF_REQUIRED', 'bank 与 externalRef 必填');
  if (cmd.amount == null) throw bad('AMOUNT_REQUIRED', 'amount 必填');
  if (!cmd.currency) throw bad('CURRENCY_REQUIRED', 'currency 必填');
  if (!cmd.occurredAt) throw bad('OCCURRED_AT_REQUIRED', 'occurredAt（原始发生时间）必填');
  const kind = cmd.kind || 'credit';
  if (!['credit', 'return'].includes(kind)) throw bad('KIND_INVALID', 'kind 仅支持 credit/return');
  const amountMinor = parseMoney(cmd.amount);
  if (amountMinor <= 0) throw bad('AMOUNT_INVALID', '金额必须为正');
  const feeMinor = cmd.fee != null ? parseMoney(cmd.fee) : 0;
  if (feeMinor < 0) throw bad('FEE_INVALID', '手续费不能为负');
  const occurredAt = parseTime(cmd.occurredAt);
  const currency = String(cmd.currency).toUpperCase();

  const key = refKey(bank, externalRef);
  const contentHash = sha256(canonical({ bank, externalRef, kind, currency, amountMinor, feeMinor, occurredAt }));
  const existingId = state.receiptRefs.get(key);
  if (existingId) {
    const existing = state.receipts.get(existingId);
    if (existing.contentHash !== contentHash) {
      throw conflict('RECEIPT_CONFLICT', '同一银行回单编号的内容与首次导入不一致');
    }
    return { events: [], result: { ...state.importResults.get(key), idempotent: true } };
  }

  const receiptId = cmd.receiptId || newId('rcpt');
  if (state.receipts.has(receiptId)) throw conflict('RECEIPT_ID_EXISTS', `receiptId 已存在: ${receiptId}`);
  const receipt = {
    receiptId, bank, externalRef, kind, currency, amountMinor, feeMinor,
    occurredAt, importedBy: cmd.importedBy || null, contentHash,
  };
  const events = [{ type: 'receipt_imported', payload: receipt }];

  let result;
  if (kind === 'return') {
    const caseId = openCase(state, events, { receipt, grade: 'high', reason: 'return_receipt', detail: '退汇回单须人工确认', occurredAt });
    result = { receiptId, status: 'queued', caseId, grade: 'high' };
  } else {
    const candidates = [...state.plans.values()].filter((p) => {
      if (p.currency !== currency) return false;
      const t = planTotals(state, p.planId);
      return p.expectedMinor - t.settled + t.returned > 0;
    });
    const exact = candidates.filter((p) => {
      const t = planTotals(state, p.planId);
      return p.expectedMinor - t.settled + t.returned === amountMinor;
    });
    if (exact.length === 1) {
      const m = buildMatchEvents(state, { receipt, plan: exact[0], amountMinor, auto: true, by: cmd.importedBy || 'system', occurredAt });
      events.push(...m.events);
      result = { receiptId, status: 'matched', matchId: m.matchId, planId: exact[0].planId, settlement: m.settlement };
    } else {
      let grade; let reason; let detail;
      if (candidates.length === 0) {
        grade = 'high'; reason = 'no_candidate'; detail = '无同币种待收计划，资金来源不明';
      } else if (exact.length > 1) {
        grade = 'low'; reason = 'ambiguous_candidates'; detail = `存在 ${exact.length} 个金额相同的候选计划`;
      } else {
        grade = 'medium'; reason = 'amount_mismatch'; detail = '有同币种计划但金额不一致，疑似部分结算或费用差异';
      }
      const dup = [...state.receipts.values()].find(
        (r) => r.currency === currency && r.amountMinor === amountMinor && r.occurredAt === occurredAt,
      );
      if (dup) detail += `；与回单 ${dup.receiptId} 币种金额时间相同，疑似重复通知`;
      const caseId = openCase(state, events, { receipt, grade, reason, detail, occurredAt });
      result = { receiptId, status: 'queued', caseId, grade };
    }
  }
  // 处理结果存证：重传时原样返回，且重启后仍可重放
  events.push({ type: 'receipt_processed', payload: { receiptId, result } });
  return { events, result };
}

// 登记合同收款计划；计划后到时自动撮合等待中的回单
export function registerPlan(state, cmd) {
  if (!cmd.contractId) throw bad('CONTRACT_REQUIRED', 'contractId 必填');
  if (!cmd.currency) throw bad('CURRENCY_REQUIRED', 'currency 必填');
  if (cmd.expected == null) throw bad('EXPECTED_REQUIRED', 'expected 必填');
  if (!cmd.expectedDate) throw bad('EXPECTED_DATE_REQUIRED', 'expectedDate 必填');
  const expectedMinor = parseMoney(cmd.expected);
  if (expectedMinor <= 0) throw bad('EXPECTED_INVALID', '计划金额必须为正');
  const currency = String(cmd.currency).toUpperCase();
  const planId = cmd.planId || newId('plan');
  if (state.plans.has(planId)) {
    const existing = state.plans.get(planId);
    if (existing.contractId === cmd.contractId && existing.currency === currency && existing.expectedMinor === expectedMinor) {
      return { events: [], result: { planId, status: 'registered', idempotent: true } };
    }
    throw conflict('PLAN_CONFLICT', `planId 已存在且内容不同: ${planId}`);
  }
  const events = [{
    type: 'plan_registered',
    payload: { planId, contractId: cmd.contractId, counterparty: cmd.counterparty || null, currency, expectedMinor, expectedDate: cmd.expectedDate },
  }];
  const waiting = [...state.receipts.values()].filter(
    (r) => !r.matched && r.kind === 'credit' && r.currency === currency && r.amountMinor === expectedMinor,
  );
  let autoMatch = null;
  if (waiting.length === 1) {
    const receipt = waiting[0];
    const m = buildMatchEvents(state, {
      receipt, plan: { planId, currency, expectedMinor }, amountMinor: receipt.amountMinor, auto: true, by: 'system', occurredAt: receipt.occurredAt,
    });
    events.push(...m.events);
    closeOpenCaseForReceipt(state, events, receipt.receiptId, receipt.occurredAt);
    autoMatch = { receiptId: receipt.receiptId, matchId: m.matchId };
  }
  return { events, result: { planId, status: 'registered', autoMatch } };
}

// 登记汇率报价：来源与生效时刻必填，换算留痕的依据
export function addFxQuote(state, cmd) {
  if (!cmd.from || !cmd.to) throw bad('QUOTE_PAIR_REQUIRED', 'from/to 必填');
  const from = String(cmd.from).toUpperCase();
  const to = String(cmd.to).toUpperCase();
  if (from === to) throw bad('QUOTE_PAIR_INVALID', '报价币种对不能相同');
  if (!cmd.source) throw bad('QUOTE_SOURCE_REQUIRED', '必须保留报价来源 source');
  if (!cmd.effectiveAt) throw bad('QUOTE_EFFECTIVE_REQUIRED', '必须保留报价生效时刻 effectiveAt');
  try { parseRate(cmd.rate); } catch (e) { throw bad('RATE_INVALID', e.message); }
  const rate = String(cmd.rate);
  const effectiveAt = parseTime(cmd.effectiveAt);
  const quoteId = cmd.quoteId || newId('quote');
  const dup = state.quotes.find((q) => q.quoteId === quoteId);
  if (dup) {
    if (dup.from === from && dup.to === to && dup.rate === rate && dup.effectiveAt === effectiveAt && dup.source === cmd.source) {
      return { events: [], result: { quoteId, status: 'registered', idempotent: true } };
    }
    throw conflict('QUOTE_CONFLICT', `quoteId 已存在且内容不同: ${quoteId}`);
  }
  const events = [{ type: 'fx_quote_added', payload: { quoteId, from, to, rate, source: cmd.source, effectiveAt } }];
  return { events, result: { quoteId, status: 'registered' } };
}

// 人工调整：必须留原因，直接落现金分录
export function recordAdjustment(state, cmd, ctx) {
  if (!cmd.currency) throw bad('CURRENCY_REQUIRED', 'currency 必填');
  if (cmd.amount == null) throw bad('AMOUNT_REQUIRED', 'amount 必填');
  if (!cmd.reason || !String(cmd.reason).trim()) throw bad('REASON_REQUIRED', '人工调整必须填写原因');
  if (!cmd.by) throw bad('OPERATOR_REQUIRED', 'by 必填');
  const amountMinor = parseMoney(cmd.amount);
  if (amountMinor === 0) throw bad('AMOUNT_INVALID', '调整金额不能为零');
  const currency = String(cmd.currency).toUpperCase();
  const occurredAt = cmd.occurredAt ? parseTime(cmd.occurredAt) : ctx.now;
  const adjustmentId = cmd.adjustmentId || newId('adj');
  const events = [
    { type: 'adjustment_recorded', payload: { adjustmentId, currency, amountMinor, reason: cmd.reason, by: cmd.by, occurredAt } },
    entryEvent('cash', currency, amountMinor, 'adjustment', adjustmentId, occurredAt, `人工调整: ${cmd.reason}`),
  ];
  return { events, result: { adjustmentId, status: 'recorded' } };
}

// 出纳手工撮合回单与计划；按回单原始发生时间入账
export function matchReceipt(state, cmd) {
  const receipt = mustReceipt(state, cmd.receiptId);
  if (receipt.matched) throw conflict('RECEIPT_ALREADY_MATCHED', `回单已结算: ${cmd.receiptId}`);
  if (receipt.kind !== 'credit') throw bad('RETURN_NEEDS_REVIEW', '退汇回单须通过人工队列确认');
  const plan = mustPlan(state, cmd.planId);
  if (!cmd.by) throw bad('OPERATOR_REQUIRED', 'by 必填');
  const amountMinor = cmd.amount != null ? parseMoney(cmd.amount) : receipt.amountMinor;
  if (amountMinor <= 0 || amountMinor > receipt.amountMinor) throw bad('MATCH_AMOUNT_INVALID', '结算金额必须为正且不超过回单金额');
  const occurredAt = receipt.occurredAt; // 以原始发生时间区分在途/到账
  const m = buildMatchEvents(state, { receipt, plan, amountMinor, auto: false, by: cmd.by, occurredAt });
  const events = [...m.events];
  closeOpenCaseForReceipt(state, events, receipt.receiptId, occurredAt);
  return {
    events,
    result: { matchId: m.matchId, receiptId: receipt.receiptId, planId: plan.planId, settlement: m.settlement, settledMinor: m.settledMinor, quote: m.quote },
  };
}

// 认领案件：状态机保证两名出纳同时认领时只有一人成功
export function claimCase(state, cmd, ctx) {
  const c = mustCase(state, cmd.caseId);
  if (!cmd.cashier) throw bad('CASHIER_REQUIRED', 'cashier 必填');
  if (c.status !== 'open') throw conflict('CASE_NOT_OPEN', `案件当前状态为 ${c.status}，无法认领`);
  const events = [{ type: 'case_claimed', payload: { caseId: c.caseId, cashier: cmd.cashier, occurredAt: ctx.now } }];
  return { events, result: { caseId: c.caseId, claimedBy: cmd.cashier } };
}

// 认领人提交处理方案（财务效果待主管确认后生效）
export function resolveCase(state, cmd, ctx) {
  const c = mustCase(state, cmd.caseId);
  if (c.status !== 'claimed') throw conflict('CASE_NOT_CLAIMED', `案件当前状态为 ${c.status}，须先认领`);
  if (c.claimedBy !== cmd.by) throw conflict('CASE_NOT_YOURS', '只能由认领人提交处理方案');
  const action = cmd.action;
  if (!['match', 'confirm_return', 'write_off'].includes(action)) {
    throw bad('ACTION_INVALID', 'action 仅支持 match/confirm_return/write_off');
  }
  const params = {};
  if (action === 'match') {
    if (!cmd.planId) throw bad('PLAN_REQUIRED', 'match 方案必须指定 planId');
    mustPlan(state, cmd.planId);
    params.planId = cmd.planId;
    if (cmd.amount != null) params.amountMinor = parseMoney(cmd.amount);
  }
  if (action === 'confirm_return' && cmd.planId) {
    mustPlan(state, cmd.planId);
    params.planId = cmd.planId;
  }
  if (action === 'write_off') {
    if (!cmd.note || !String(cmd.note).trim()) throw bad('NOTE_REQUIRED', 'write_off 必须说明去向');
    params.note = cmd.note;
  }
  const events = [{ type: 'case_resolved', payload: { caseId: c.caseId, by: cmd.by, action, params, occurredAt: ctx.now } }];
  return { events, result: { caseId: c.caseId, status: 'resolved', action } };
}

// 主管确认：留下不可删除的依据（证据 + 方案哈希），财务效果此时入账
export function confirmCase(state, cmd, ctx) {
  const c = mustCase(state, cmd.caseId);
  if (c.status === 'confirmed') throw conflict('CASE_ALREADY_CONFIRMED', '案件已确认，依据不可更改；如需更正请追加更正记录');
  if (c.status !== 'resolved') throw conflict('CASE_NOT_RESOLVED', `案件当前状态为 ${c.status}，须先提交处理方案`);
  if (!cmd.supervisor) throw bad('SUPERVISOR_REQUIRED', 'supervisor 必填');
  if (!cmd.evidence || !String(cmd.evidence).trim()) throw bad('EVIDENCE_REQUIRED', '主管确认必须留下不可删除的依据 evidence');
  if (cmd.supervisor === c.resolution.by) throw conflict('SELF_CONFIRM_FORBIDDEN', '处理人与确认人不得为同一人');
  const resolutionHash = sha256(canonical(c.resolution));
  const events = [{
    type: 'case_confirmed',
    payload: { caseId: c.caseId, supervisor: cmd.supervisor, evidence: cmd.evidence, resolutionHash, occurredAt: ctx.now },
  }];
  const receipt = state.receipts.get(c.receiptId);
  const { action, params } = c.resolution;
  let effect = null;
  if (action === 'match') {
    if (receipt.matched) throw conflict('RECEIPT_ALREADY_MATCHED', '回单在方案确认前已被结算');
    const plan = mustPlan(state, params.planId);
    const amountMinor = params.amountMinor ?? receipt.amountMinor;
    const m = buildMatchEvents(state, { receipt, plan, amountMinor, auto: false, by: c.resolution.by, occurredAt: receipt.occurredAt });
    events.push(...m.events);
    effect = { matchId: m.matchId, settlement: m.settlement };
  } else if (action === 'confirm_return') {
    if (receipt.matched) throw conflict('RECEIPT_ALREADY_PROCESSED', '回单已处理');
    const returnId = newId('ret');
    const planId = params.planId || null;
    events.push({
      type: 'return_confirmed',
      payload: { returnId, receiptId: receipt.receiptId, planId, currency: receipt.currency, amountMinor: receipt.amountMinor, occurredAt: receipt.occurredAt, by: c.resolution.by },
    });
    events.push(entryEvent('cash', receipt.currency, -(receipt.amountMinor + receipt.feeMinor), 'return', returnId, receipt.occurredAt, `退汇 ${receipt.receiptId}`));
    if (receipt.feeMinor > 0) {
      events.push(entryEvent('fee_expense', receipt.currency, receipt.feeMinor, 'return', returnId, receipt.occurredAt, '退汇手续费'));
    }
    effect = { returnId };
  } else if (action === 'write_off') {
    if (receipt.matched) throw conflict('RECEIPT_ALREADY_PROCESSED', '回单已处理');
    const writeoffId = newId('wo');
    events.push({ type: 'receipt_written_off', payload: { writeoffId, receiptId: receipt.receiptId, note: params.note, occurredAt: receipt.occurredAt } });
    events.push(entryEvent('cash', receipt.currency, receipt.amountMinor - receipt.feeMinor, 'writeoff', writeoffId, receipt.occurredAt, `无法匹配款项确认: ${params.note}`));
    if (receipt.feeMinor > 0) {
      events.push(entryEvent('fee_expense', receipt.currency, receipt.feeMinor, 'writeoff', writeoffId, receipt.occurredAt, '手续费'));
    }
    effect = { writeoffId };
  }
  return { events, result: { caseId: c.caseId, status: 'confirmed', resolutionHash, ...effect } };
}

// 已确认案件的更正：只追加，不修改原确认记录
export function correctCase(state, cmd, ctx) {
  const c = mustCase(state, cmd.caseId);
  if (c.status !== 'confirmed') throw conflict('CASE_NOT_CONFIRMED', '仅已确认的案件可追加更正');
  if (!cmd.by) throw bad('OPERATOR_REQUIRED', 'by 必填');
  if (!cmd.correction || !String(cmd.correction).trim()) throw bad('CORRECTION_REQUIRED', '更正内容必填');
  const events = [{ type: 'case_corrected', payload: { caseId: c.caseId, by: cmd.by, correction: cmd.correction, occurredAt: ctx.now } }];
  return { events, result: { caseId: c.caseId, status: 'corrected', corrections: c.corrections.length + 1 } };
}

// 撤销分录：不删原分录，追加一笔等额反向的冲销分录
export function reverseEntry(state, cmd, ctx) {
  const e = state.entries.find((x) => x.entryId === cmd.entryId);
  if (!e) throw notFound('ENTRY_NOT_FOUND', `分录不存在: ${cmd.entryId}`);
  if (e.reversedBy) throw conflict('ENTRY_ALREADY_REVERSED', `分录已被 ${e.reversedBy} 冲销`);
  if (!cmd.by) throw bad('OPERATOR_REQUIRED', 'by 必填');
  if (!cmd.reason || !String(cmd.reason).trim()) throw bad('REASON_REQUIRED', '冲销必须填写原因');
  const occurredAt = cmd.occurredAt ? parseTime(cmd.occurredAt) : ctx.now;
  const events = [entryEvent(e.account, e.currency, -e.amountMinor, 'reversal', e.entryId, occurredAt, `冲销 ${e.entryId}: ${cmd.reason}`, e.entryId)];
  return { events, result: { entryId: events[0].payload.entryId, reversesEntryId: e.entryId } };
}

// 封存日快照：一经封存不可覆盖，跨日迟到的回单只影响后续日期
export function closeDay(state, cmd) {
  if (!cmd.date) throw bad('DATE_REQUIRED', 'date 必填（YYYY-MM-DD）');
  parseDay(cmd.date);
  const existing = state.days.get(cmd.date);
  if (existing) return { events: [], result: { ...existing, idempotent: true } };
  const snapshot = computeSnapshot(state, cmd.date);
  const events = [{ type: 'day_closed', payload: { date: cmd.date, snapshot } }];
  return { events, result: snapshot };
}

// ---------------------------------------------------------------------------
// 投影：余额、分日状态、人工队列、账本
// ---------------------------------------------------------------------------

// 截至某日（UTC）的快照：余额、在途/到账/退汇/部分结算、汇率留痕、跨日迟到项
export function computeSnapshot(state, date) {
  const end = endOfDay(date);
  const cash = {};
  const feeExpense = {};
  for (const e of state.entries) {
    if (e.occurredAt > end) continue;
    const book = e.account === 'cash' ? cash : e.account === 'fee_expense' ? feeExpense : null;
    if (!book) continue;
    book[e.currency] = (book[e.currency] || 0) + e.amountMinor;
  }
  const plans = [...state.plans.values()].map((p) => {
    const t = planTotals(state, p.planId, end);
    const net = t.settled - t.returned;
    let status;
    if (t.returned > 0 && net <= 0) status = '退汇';
    else if (net <= 0) status = '在途';
    else if (net < p.expectedMinor) status = '部分结算';
    else status = '到账';
    return { planId: p.planId, contractId: p.contractId, currency: p.currency, expectedMinor: p.expectedMinor, settledMinor: t.settled, returnedMinor: t.returned, status };
  });
  const unmatchedReceipts = [...state.receipts.values()]
    .filter((r) => !r.matched && r.occurredAt <= end)
    .map((r) => ({ receiptId: r.receiptId, kind: r.kind, currency: r.currency, amountMinor: r.amountMinor, occurredAt: r.occurredAt }));
  const quotesUsed = [];
  const seen = new Set();
  for (const m of state.matches.values()) {
    if (m.occurredAt > end || !m.quote) continue;
    const k = `${m.receiptCurrency}|${m.planCurrency}|${m.quote.rate}|${m.quote.source}|${m.quote.effectiveAt}`;
    if (seen.has(k)) continue;
    seen.add(k);
    quotesUsed.push({ from: m.receiptCurrency, to: m.planCurrency, ...m.quote });
  }
  return {
    date, sealed: true, cash, feeExpense, plans, unmatchedReceipts, quotesUsed,
    lateArrivals: findLateArrivals(state, date), headSeq: state.seq, headHash: state.headHash,
  };
}

// 原始发生时间属于已封存日期、却在封存后才导入的回单 → 跨日调整列示
function findLateArrivals(state, date) {
  let prev = null;
  for (const d of state.days.keys()) if (d < date && (!prev || d > prev)) prev = d;
  if (!prev) return [];
  const prevSnap = state.days.get(prev);
  const prevEnd = endOfDay(prev);
  return [...state.receipts.values()]
    .filter((r) => r.occurredAt <= prevEnd && r.seq > prevSnap.headSeq)
    .map((r) => ({ receiptId: r.receiptId, occurredAt: r.occurredAt, note: `发生时间属于已封存日期 ${prev}，以跨日调整列示` }));
}

// 日视图：已封存的返回封存结果（跨日到账不能覆盖前一日的判断）
export function dayView(state, date) {
  parseDay(date);
  const sealed = state.days.get(date);
  if (sealed) return { ...sealed, sealed: true };
  return { ...computeSnapshot(state, date), sealed: false };
}

// 账面余额：现金/手续费分币种；base 指定时逐笔按分录发生时刻的生效报价折本位币
export function balanceView(state, { date = null, base = null } = {}) {
  const end = date ? parseDay(date) : null;
  const cash = {};
  const feeExpense = {};
  const cashEntries = [];
  for (const e of state.entries) {
    if (end && e.occurredAt > end) continue;
    if (e.account === 'cash') {
      cash[e.currency] = (cash[e.currency] || 0) + e.amountMinor;
      cashEntries.push(e);
    } else if (e.account === 'fee_expense') {
      feeExpense[e.currency] = (feeExpense[e.currency] || 0) + e.amountMinor;
    }
  }
  const result = { asOf: end || 'now', cash, feeExpense };
  if (base) {
    const quotesUsed = [];
    const unconvertible = [];
    const seen = new Set();
    let total = 0;
    for (const e of cashEntries) {
      if (e.currency === base) { total += e.amountMinor; continue; }
      const q = findQuote(state.quotes, e.currency, base, e.occurredAt);
      if (!q) {
        if (!unconvertible.includes(e.currency)) unconvertible.push(e.currency);
        continue;
      }
      total += convert(e.amountMinor, q.rate);
      const k = `${e.currency}|${q.rate}|${q.source}|${q.effectiveAt}`;
      if (!seen.has(k)) {
        seen.add(k);
        quotesUsed.push({ from: e.currency, to: base, rate: q.rate, source: q.source, effectiveAt: q.effectiveAt });
      }
    }
    result.base = { currency: base, totalMinor: total, quotesUsed, unconvertible };
  }
  return result;
}

// 人工队列：按等级（高→低）与开立顺序排列
export function queueView(state, status = null) {
  let cases = [...state.cases.values()];
  if (status) cases = cases.filter((c) => c.status === status);
  return cases
    .map((c) => ({ ...c, receipt: summarizeReceipt(state.receipts.get(c.receiptId)) }))
    .sort((a, b) => (GRADE_ORDER[a.grade] ?? 9) - (GRADE_ORDER[b.grade] ?? 9) || a.seq - b.seq);
}

const summarizeReceipt = (r) => (r ? {
  receiptId: r.receiptId, kind: r.kind, currency: r.currency, amountMinor: r.amountMinor, feeMinor: r.feeMinor, occurredAt: r.occurredAt, matched: r.matched,
} : null);

export function receiptView(state, receiptId) {
  const r = mustReceipt(state, receiptId);
  const match = r.matchId ? state.matches.get(r.matchId) || null : null;
  const cases = [...state.cases.values()].filter((c) => c.receiptId === receiptId);
  return { ...r, match, cases };
}

export function planView(state, planId) {
  const p = mustPlan(state, planId);
  const t = planTotals(state, planId);
  const net = t.settled - t.returned;
  const status = t.returned > 0 && net <= 0 ? '退汇' : net <= 0 ? '在途' : net < p.expectedMinor ? '部分结算' : '到账';
  const matches = [...state.matches.values()].filter((m) => m.planId === planId);
  return { ...p, settledMinor: t.settled, returnedMinor: t.returned, status, matches };
}

export function ledgerView(state, { account = null, currency = null } = {}) {
  return state.entries.filter((e) => (!account || e.account === account) && (!currency || e.currency === currency));
}
