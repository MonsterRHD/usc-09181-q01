import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { GENESIS, eventHash } from './util.mjs';

// 追加式事件日志：每个事件带前向哈希，构成不可篡改的审计链。
// 进程重启时整链校验并回放，未处理队列与已确认余额由此重算。
export class EventStore {
  constructor(file) {
    this.file = file;
    this.events = [];
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) this.events.push(JSON.parse(line));
    }
    const problem = verifyChain(this.events);
    if (problem) throw new Error(`事件链校验失败: ${problem}`);
  }

  get head() {
    return this.events.length ? this.events[this.events.length - 1] : null;
  }

  append(type, payload, at) {
    const seq = this.events.length + 1;
    const prevHash = this.head ? this.head.hash : GENESIS;
    const body = { seq, type, at, payload };
    const hash = eventHash(prevHash, body);
    const event = { ...body, prevHash, hash };
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(event) + '\n');
    this.events.push(event);
    return event;
  }
}

// 校验整条哈希链，返回问题描述或 null
export function verifyChain(events) {
  let prev = GENESIS;
  for (const e of events) {
    const { hash, prevHash, ...body } = e;
    if (prevHash !== prev) return `序号 ${e.seq} 的前向哈希不符`;
    if (eventHash(prev, body) !== hash) return `序号 ${e.seq} 的内容哈希不符`;
    prev = hash;
  }
  return null;
}
