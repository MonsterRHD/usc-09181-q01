// 金额工具：以字符串/整数最小币种单位参与运算，避免 JS 浮点误差。
// 对外 API 接收十进制字符串（如 "100.50"），内部统一保存为整数 minor units。

export function parseAmount(decimal, exponent) {
  if (typeof decimal === 'number') decimal = String(decimal);
  if (typeof decimal !== 'string') throw new Error(`金额必须是字符串: ${decimal}`);
  if (!/^-?\d+(\.\d+)?$/.test(decimal)) throw new Error(`非法金额: ${decimal}`);
  if (!Number.isInteger(exponent) || exponent < 0 || exponent > 18) {
    throw new Error(`非法币种精度: ${exponent}`);
  }
  const neg = decimal.startsWith('-');
  const body = neg ? decimal.slice(1) : decimal;
  const [intPart, fracPartRaw = ''] = body.split('.');
  if (fracPartRaw.length > exponent) {
    throw new Error(`金额 ${decimal} 超过币种允许的 ${exponent} 位小数`);
  }
  const fracPart = fracPartRaw.padEnd(exponent, '0');
  const minor = BigInt(intPart || '0') * 10n ** BigInt(exponent) + BigInt(fracPart || '0');
  return neg ? -minor : minor;
}

export function formatAmount(minor, exponent) {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const divisor = 10n ** BigInt(exponent);
  const intPart = abs / divisor;
  const fracPart = abs % divisor;
  let s = intPart.toString();
  if (exponent > 0) s += '.' + fracPart.toString().padStart(exponent, '0'); // 保留币种全部小数位
  return (neg && abs !== 0n ? '-' : '') + s;
}

// 汇率为正的定点数十进制字符串，精度固定 8 位。
export function parseRate(rate) {
  if (typeof rate !== 'string' || !/^\d+(\.\d+)?$/.test(rate) || !(Number(rate) > 0)) {
    throw new Error(`非法汇率: ${rate}`);
  }
  return parseAmount(rate, RATE_EXPONENT);
}

export const RATE_EXPONENT = 8;

export function applyRate(minorAmount, rateMinor, srcExponent, dstExponent) {
  // dstMinor = srcMinor * rate * 10^dstExp / (10^RATE_EXP * 10^srcExp)
  // 分子分母一次性计算并四舍五入，避免中间截断丢精度。
  const numFactor = 10n ** BigInt(dstExponent);
  const den = 10n ** BigInt(RATE_EXPONENT + srcExponent);
  const neg = minorAmount < 0n;
  const abs = neg ? -minorAmount : minorAmount;
  const rounded = (abs * rateMinor * numFactor + den / 2n) / den;
  return neg ? -rounded : rounded;
}

export function nowIso(clock) {
  return new Date(clock.now()).toISOString();
}

let counter = 0;
export function genId(prefix) {
  counter = (counter + 1) % 0xfffff;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(5, '0')}${Math.random().toString(36).slice(2, 8)}`;
}
