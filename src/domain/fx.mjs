// FX 报价台账：每条报价带来源、登记时刻、生效起始时刻。
// 换算时按「业务原始发生时间」选取当时生效的最新报价——
// 结算之间汇率可以变更，但历史判断不会被后来的报价覆盖。
import { genId, parseRate } from './util.mjs';

export class FxRegistry {
  constructor() {
    // key: `${from}|${to}` -> 排序后的报价版本数组
    this._quotes = new Map();
  }

  static load(events) {
    const reg = new FxRegistry();
    for (const e of events) if (e.type === 'fxQuoteRegistered') reg._apply(e);
    return reg;
  }

  register({ fromCurrency, toCurrency, rate, source, effectiveAt, recordedAt }) {
    if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) {
      throw new Error('换汇币种对非法');
    }
    const rateMinor = parseRate(rate);
    const event = {
      type: 'fxQuoteRegistered',
      quoteId: genId('fx'),
      pair: `${fromCurrency}|${toCurrency}`,
      fromCurrency, toCurrency, rate, rateMinor: rateMinor.toString(),
      source,                               // 报价来源（银行/路透/央行……）
      effectiveAt,                          // 生效时刻（报价本身的有效起始）
      recordedAt,                           // 登记时刻（进入本系统的时间）
    };
    this._apply(event);
    return event;
  }

  _apply(e) {
    const list = this._quotes.get(e.pair) ?? [];
    list.push(e);
    list.sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt)
      || a.recordedAt.localeCompare(b.recordedAt));
    this._quotes.set(e.pair, list);
  }

  // 返回业务发生时刻 asOf 应使用的报价：effectiveAt <= asOf 中最新者，
  // 同一生效时刻取最早登记（不允许后来登记的报价覆盖历史）。
  quoteAt(fromCurrency, toCurrency, asOf) {
    if (fromCurrency === toCurrency) {
      return { rate: '1', rateMinor: (10n ** 8n).toString(), source: 'SAME_CURRENCY', effectiveAt: asOf, recordedAt: asOf };
    }
    const list = this._quotes.get(`${fromCurrency}|${toCurrency}`);
    if (!list) throw new Error(`无 ${fromCurrency}->${toCurrency} 报价`);
    let chosen;
    for (const q of list) if (q.effectiveAt <= asOf) chosen = q; else break;
    if (!chosen) throw new Error(`${asOf} 时尚无 ${fromCurrency}->${toCurrency} 生效报价`);
    return chosen;
  }
}
