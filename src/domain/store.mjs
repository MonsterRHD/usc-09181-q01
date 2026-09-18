// 追加式事件存储：事件只增不改；每条事件带 seq 与 SHA-256 哈希链。
// 进程重启后重放整条日志即可重算队列与余额；任何删除/篡改都会在 verifyChain 暴露。
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, appendFileSync, readFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export function canonicalHash(prevHash, payload) {
  const h = createHash('sha256');
  h.update(prevHash);
  h.update(JSON.stringify(payload, Object.keys(payload).sort()));
  return h.digest('hex');
}

export class FileEventStore {
  constructor(file) {
    this.file = file;
    this.events = [];
    if (file) {
      if (existsSync(file)) {
        const text = readFileSync(file, 'utf8');
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          this.events.push(JSON.parse(line));
        }
      } else {
        mkdirSync(dirname(file), { recursive: true });
      }
    }
  }

  get seq() { return this.events.length; }

  // 在互斥锁内调用；payload 为不含 seq/hash 的事件内容。
  append(payload) {
    const seq = this.events.length + 1;
    const prevHash = this.events.length ? this.events[this.events.length - 1].hash : '0'.repeat(64);
    const event = { ...payload, seq, prevHash, hash: canonicalHash(prevHash, payload) };
    if (this.file) {
      appendFileSync(this.file, JSON.stringify(event) + '\n');
    }
    this.events.push(event);
    return event;
  }

  appendMany(payloads) { return payloads.map((p) => this.append(p)); }

  // 校验：哈希链连续且事件体未被改动；返回 {ok, brokenAt}。
  verifyChain() {
    let prev = '0'.repeat(64);
    for (const e of this.events) {
      if (e.prevHash !== prev) return { ok: false, brokenAt: e.seq, reason: '链断裂（可能有事件被删除或插入）' };
      const { seq, prevHash, hash, ...payload } = e;
      if (canonicalHash(prev, payload) !== hash) return { ok: false, brokenAt: e.seq, reason: '事件内容与哈希不一致（可能被篡改）' };
      prev = hash;
    }
    return { ok: true, count: this.events.length };
  }

  // 仅供测试：清空落盘日志。
  reset() {
    this.events = [];
    if (this.file && existsSync(this.file)) {
      renameSync(this.file, `${this.file}.trash-${Date.now()}`);
    }
  }
}

// 简单的异步互斥：所有写命令串行化，保证两名出纳并发认领时判定是原子的。
export class Mutex {
  constructor() { this._tail = Promise.resolve(); }
  run(fn) {
    // fn 必须等上一个任务（无论成败）彻底结束后才启动；新任务排队成为新的队尾。
    const result = this._tail.then(() => fn());
    this._tail = result.then(() => {}, () => {});
    return result;
  }
}
