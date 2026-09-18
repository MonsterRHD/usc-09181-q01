// 对账中枢 HTTP 服务。无外部依赖，仅用 node 内置模块。
import { createServer } from 'node:http';
import { Ledger } from './domain/ledger.mjs';

const LEDGER_FILE = process.env.LEDGER_FILE || './data/ledger.jsonl';
const TOLERANCE = process.env.L1_TOLERANCE
  ? Object.fromEntries(process.env.L1_TOLERANCE.split(',').map((pair) => {
      const [cur, v] = pair.split(':'); return [cur, v];
    }))
  : { USD: '0.01', CNY: '0.05', EUR: '0.01' };

let ledger;
function getLedger() {
  if (!ledger) ledger = new Ledger({ file: LEDGER_FILE, tolerance: TOLERANCE });
  return ledger;
}
// 测试可注入
export function setLedger(instance) { ledger = instance; }

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const err = new Error('请求体不是合法 JSON'); err.statusCode = 400; throw err; }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// 每条命令对应一个 ledger 方法；路径参数通过 routes 传入。
const routes = [
  ['POST', /^\/v1\/currencies$/, (l, b) => l.registerCurrency(b)],
  ['POST', /^\/v1\/fx-quotes$/, (l, b) => l.registerFxQuote(b)],
  ['POST', /^\/v1\/contracts$/, (l, b) => l.scheduleContract(b)],
  ['POST', /^\/v1\/receipts\/import$/, (l, b) => l.importReceipt(b)],
  ['POST', /^\/v1\/receipts\/([^/]+)\/notifications$/, (l, b, m) => l.pushNotification({ ...b, receiptId: m[1] })],
  ['GET', /^\/v1\/receipts\/([^/]+)$/, (l, b, m) => l._receiptView(m[1])],
  ['GET', /^\/v1\/queue$/, (l, b) => l.report(new Date().toISOString()).queue],
  ['POST', /^\/v1\/queue\/([^/]+)\/claim$/, (l, b, m) => l.claimItem(m[1], b.by)],
  ['POST', /^\/v1\/queue\/([^/]+)\/resolve$/, (l, b, m) => l.resolveItem(m[1], b)],
  ['POST', /^\/v1\/queue\/([^/]+)\/retry$/, (l, b, m) => l.retryItem(m[1], b.by)],
  ['POST', /^\/v1\/entries$/, (l, b) => l.postEntry(b)],
  ['GET', /^\/v1\/report$/, (l, b, m, url) => l.report(url.searchParams.get('asOf') || new Date().toISOString())],
  ['POST', /^\/v1\/freeze$/, (l, b) => l.freeze(b.asOf, b.by)],
  ['GET', /^\/v1\/verify$/, (l) => ({ chain: l.verifyChain() })],
];

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { status: 'ok' });
    return;
  }
  const route = routes.find(([method, re]) => req.method === method && re.test(url.pathname));
  if (!route) { send(res, 404, { error: 'not found' }); return; }
  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    const result = await route[2](getLedger(), body, url.pathname.match(route[1]), url);
    if (result == null) send(res, 404, { error: 'not found' });
    else send(res, 200, { result });
  } catch (err) {
    send(res, err.statusCode || 400, { error: err.message });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT || 3000;
  getLedger(); // 启动时即重放
  server.listen(port, () => console.log(`对账中枢已启动: http://localhost:${port}  台账: ${LEDGER_FILE}`));
}
