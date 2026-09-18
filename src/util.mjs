import { createHash, randomUUID } from 'node:crypto';

export const GENESIS = 'GENESIS';

// 稳定序列化（键排序），保证同一对象哈希可重算
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// 事件哈希链：hash = sha256(prevHash + 规范化正文)
export function eventHash(prevHash, body) {
  return sha256(prevHash + '|' + canonical(body));
}

export function newId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export function toIso(t) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) throw new Error(`时间非法: ${t}`);
  return d.toISOString();
}

// 日界一律按 UTC 的 YYYY-MM-DD 划分
export function endOfDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式应为 YYYY-MM-DD: ${date}`);
  return `${date}T23:59:59.999Z`;
}
