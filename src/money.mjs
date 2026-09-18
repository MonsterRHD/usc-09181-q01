// 金额一律以最小货币单位（整数）存储与运算，杜绝浮点误差；
// 汇率以十进制字符串解析为分数，换算结果可逐笔重算。

export function parseAmount(value, scale = 2) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`金额非法: ${value}`);
    value = String(value);
  }
  if (typeof value !== 'string') throw new Error('金额必须是字符串或数字');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`金额格式非法: ${value}`);
  const [, sign, intPart, fracPart = ''] = m;
  if (fracPart.length > scale) throw new Error(`金额超出精度（${scale} 位小数）: ${value}`);
  const frac = (fracPart + '0'.repeat(scale)).slice(0, scale);
  const minor = BigInt(intPart) * 10n ** BigInt(scale) + BigInt(frac || '0');
  return Number(sign === '-' ? -minor : minor);
}

export function formatAmount(minor, scale = 2) {
  const neg = minor < 0;
  const abs = BigInt(Math.abs(minor));
  const base = 10n ** BigInt(scale);
  const frac = String(abs % base).padStart(scale, '0');
  return `${neg ? '-' : ''}${abs / base}.${frac}`;
}

// 十进制字符串 → 分数 { num, den }
export function parseRate(text) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m) throw new Error(`汇率格式非法: ${text}`);
  const frac = m[2] || '';
  return { num: BigInt(m[1] + frac), den: 10n ** BigInt(frac.length) };
}

// minor × rate，四舍五入（远离零）到最小单位，全程整数运算
export function convert(minor, rate) {
  const { num, den } = typeof rate === 'string' ? parseRate(rate) : rate;
  const n = BigInt(minor) * num;
  const sign = n < 0n ? -1n : 1n;
  const abs = n < 0n ? -n : n;
  const q = (abs * 2n + den) / (2n * den);
  return Number(sign * q);
}
