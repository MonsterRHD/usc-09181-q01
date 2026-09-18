import { join } from 'node:path';
import { EventStore, verifyChain } from './store.mjs';
import * as domain from './domain.mjs';

const send = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// 组装应用：加载事件日志 → 回放重建状态 → 返回 HTTP 处理函数。
// 命令统一走 dispatch：先纯函数决策出事件，再顺序落库并应用，失败不产生半状态。
export function createApp({ dataDir }) {
  const store = new EventStore(join(dataDir, 'events.jsonl'));
  const state = domain.initialState();
  for (const e of store.events) {
    domain.apply(state, e);
    state.seq = e.seq;
    state.headHash = e.hash;
  }

  const dispatch = (cmdFn, cmd) => {
    const ctx = { now: new Date().toISOString() };
    const { events, result } = cmdFn(state, cmd, ctx);
    for (const ev of events) {
      const stored = store.append(ev.type, ev.payload, ctx.now);
      domain.apply(state, stored);
      state.seq = stored.seq;
      state.headHash = stored.hash;
    }
    return result;
  };

  const routes = [];
  const on = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([a-zA-Z]+)/g, (m, k) => { keys.push(k); return '([^/]+)'; }) + '$',
    );
    routes.push({ method, re, keys, handler });
  };

  on('GET', '/health', () => [200, { status: 'ok', events: store.events.length, headHash: state.headHash }]);

  // 出纳导入：回单（幂等）、收款计划、汇率报价、人工调整
  on('POST', '/receipts', (p, b) => { const r = dispatch(domain.importReceipt, b); return [r.idempotent ? 200 : 201, r]; });
  on('GET', '/receipts/:id', (p) => [200, domain.receiptView(state, p.id)]);
  on('POST', '/receipts/:id/match', (p, b) => [201, dispatch(domain.matchReceipt, { ...b, receiptId: p.id })]);
  on('POST', '/plans', (p, b) => { const r = dispatch(domain.registerPlan, b); return [r.idempotent ? 200 : 201, r]; });
  on('GET', '/plans/:id', (p) => [200, domain.planView(state, p.id)]);
  on('POST', '/fx-quotes', (p, b) => { const r = dispatch(domain.addFxQuote, b); return [r.idempotent ? 200 : 201, r]; });
  on('POST', '/adjustments', (p, b) => [201, dispatch(domain.recordAdjustment, b)]);

  // 人工队列：认领 → 方案 → 主管确认 → （只能）追加更正
  on('GET', '/cases', (p, b, q) => [200, { cases: domain.queueView(state, q.get('status')) }]);
  on('POST', '/cases/:id/claim', (p, b) => [200, dispatch(domain.claimCase, { ...b, caseId: p.id })]);
  on('POST', '/cases/:id/resolve', (p, b) => [200, dispatch(domain.resolveCase, { ...b, caseId: p.id })]);
  on('POST', '/cases/:id/confirm', (p, b) => [200, dispatch(domain.confirmCase, { ...b, caseId: p.id })]);
  on('POST', '/cases/:id/correct', (p, b) => [200, dispatch(domain.correctCase, { ...b, caseId: p.id })]);

  // 账本与余额：撤销只能追加冲销分录
  on('GET', '/ledger', (p, b, q) => [200, { entries: domain.ledgerView(state, { account: q.get('account'), currency: q.get('currency') }) }]);
  on('POST', '/entries/:id/reverse', (p, b) => [201, dispatch(domain.reverseEntry, { ...b, entryId: p.id })]);
  on('GET', '/balance', (p, b, q) => [200, domain.balanceView(state, { date: q.get('date'), base: q.get('base') })]);

  // 日快照：封存后跨日到账不能覆盖前一日判断
  on('POST', '/days/close', (p, b) => { const r = dispatch(domain.closeDay, b); return [r.idempotent ? 200 : 201, r]; });
  on('GET', '/days/:date', (p) => [200, domain.dayView(state, p.date)]);

  // 审计链
  on('GET', '/audit/verify', () => [200, { valid: verifyChain(store.events) === null, length: store.events.length, headHash: state.headHash }]);
  on('GET', '/audit/events', () => [200, { events: store.events }]);

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      let body = {};
      if (req.method === 'POST') {
        const text = await readBody(req);
        if (text) {
          try { body = JSON.parse(text); } catch { return send(res, 400, { error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } }); }
        }
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const [status, payload] = r.handler(params, body, url.searchParams);
        return send(res, status, payload);
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: '路由不存在' } });
    } catch (err) {
      if (err instanceof domain.DomainError) {
        return send(res, err.status, { error: { code: err.code, message: err.message } });
      }
      send(res, 500, { error: { code: 'INTERNAL', message: String((err && err.message) || err) } });
    }
  };
}
