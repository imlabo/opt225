/**
 * 一目均衡表(日足)の計算: 五線(転換線・基準線・先行スパン1/2・遅行スパン)、
 * 波動論(3波動: I/V/N と P/Y)、計算値(N/V/E/NT)、時間論(基本数値)、相場水準(支持・抵抗)。
 * 入力は日足の 4 本値(日経平均)。先物換算はベーシス(先物−現物)を加えて表示側で行う。
 */

export interface Bar { date: string; open: number; high: number; low: number; close: number }

export const BASIC_NUMBERS = [9, 17, 26, 33, 42, 51, 65, 76, 83, 97, 101, 129, 172, 200, 257];

const hl = (bars: Bar[], end: number, n: number) => {
  let hi = -Infinity, lo = Infinity;
  for (let i = Math.max(0, end - n + 1); i <= end; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
  return (hi + lo) / 2;
};

export interface Lines { tenkan: number; kijun: number; spanA: number; spanB: number } // spanA/B: その日に描かれる雲(26日前に計算)

/** i 日目の五線。先行スパンは 26 本前の値が当日に表示される */
export function linesAt(bars: Bar[], i: number): Lines | null {
  if (i < 77) return null;
  const tenkan = hl(bars, i, 9), kijun = hl(bars, i, 26);
  const j = i - 26;
  const spanA = (hl(bars, j, 9) + hl(bars, j, 26)) / 2, spanB = hl(bars, j, 52);
  return { tenkan, kijun, spanA, spanB };
}

/** i 日目に計算され 26 本先に描かれる雲 */
export function futureCloudAt(bars: Bar[], i: number) {
  return { spanA: (hl(bars, i, 9) + hl(bars, i, 26)) / 2, spanB: hl(bars, i, 52) };
}

export interface Pivot { i: number; date: string; price: number; type: "high" | "low"; confirmed: boolean }

/** ジグザグで高値・安値の転換点を抽出。反転幅は max(3%, 2.5×ATR14) */
export function pivots(bars: Bar[], end = bars.length - 1): Pivot[] {
  const out: Pivot[] = [];
  if (end < 20) return out;
  const atr = (k: number) => {
    let s = 0, n = 0;
    for (let i = Math.max(1, k - 13); i <= k; i++) {
      s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)); n++;
    }
    return s / n;
  };
  let dir: 1 | -1 = bars[1].close >= bars[0].close ? 1 : -1;
  let ext = dir === 1 ? { i: 0, p: bars[0].high } : { i: 0, p: bars[0].low };
  for (let i = 1; i <= end; i++) {
    const th = Math.max(0.03 * bars[i].close, 2.5 * atr(i));
    if (dir === 1) {
      if (bars[i].high >= ext.p) ext = { i, p: bars[i].high };
      else if (ext.p - bars[i].low >= th) {
        out.push({ i: ext.i, date: bars[ext.i].date, price: ext.p, type: "high", confirmed: true });
        dir = -1; ext = { i, p: bars[i].low };
      }
    } else {
      if (bars[i].low <= ext.p) ext = { i, p: bars[i].low };
      else if (bars[i].high - ext.p >= th) {
        out.push({ i: ext.i, date: bars[ext.i].date, price: ext.p, type: "low", confirmed: true });
        dir = 1; ext = { i, p: bars[i].high };
      }
    }
  }
  // 未確定の直近の極値
  out.push({ i: ext.i, date: bars[ext.i].date, price: ext.p, type: dir === 1 ? "high" : "low", confirmed: false });
  return out;
}

export type Wave = "上昇N波動" | "下落N波動" | "Y波動(拡大)" | "P波動(収束)" | "V波動" | "I波動";

export function classifyWave(pv: Pivot[]): Wave {
  const c = pv.filter((p) => p.confirmed);
  if (c.length < 2) return "I波動";
  if (c.length < 4) return "V波動";
  const highs = c.filter((p) => p.type === "high").slice(-2), lows = c.filter((p) => p.type === "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "V波動";
  const hh = highs[1].price > highs[0].price, hlw = lows[1].price > lows[0].price;
  if (hh && hlw) return "上昇N波動";
  if (!hh && !hlw) return "下落N波動";
  if (hh && !hlw) return "Y波動(拡大)";
  return "P波動(収束)";
}

export interface Targets { direction: "up" | "down"; a: Pivot; b: Pivot; c: Pivot; N: number; V: number; E: number; NT: number }

/** 計算値: 直近の確定転換点 A→B→C から次の波の目標値 */
export function targets(pv: Pivot[]): Targets | null {
  const c = pv.filter((p) => p.confirmed);
  if (c.length < 3) return null;
  const [A, B, C] = c.slice(-3);
  const direction = C.type === "low" ? "up" : "down";
  const s = direction === "up" ? 1 : -1;
  return {
    direction, a: A, b: B, c: C,
    N: C.price + s * Math.abs(B.price - A.price),
    V: B.price + s * Math.abs(B.price - C.price),
    E: B.price + s * Math.abs(B.price - A.price),
    NT: C.price + s * Math.abs(C.price - A.price),
  };
}

export interface TimeSignal { from: string; fromType: "high" | "low"; bars: number; number: number }

/** 時間論: 主要転換点からの経過本数が基本数値(±1)に当たるか */
export function timeSignals(pv: Pivot[], end: number, bars: Bar[]): { hits: TimeSignal[]; upcoming: { from: string; number: number; inBars: number }[] } {
  const hits: TimeSignal[] = [], upcoming: { from: string; number: number; inBars: number }[] = [];
  for (const p of pv.filter((x) => x.confirmed).slice(-4)) {
    const n = end - p.i;
    for (const b of BASIC_NUMBERS) {
      if (Math.abs(n - b) <= 1) hits.push({ from: p.date, fromType: p.type, bars: n, number: b });
      else if (b > n && b - n <= 10) upcoming.push({ from: bars[p.i].date, number: b, inBars: b - n });
    }
  }
  return { hits, upcoming: upcoming.sort((a, b) => a.inBars - b.inBars).slice(0, 3) };
}

export interface IchimokuSignal {
  tk: number; // 転換線 > 基準線: +1
  cloud: number; // 雲の上 +1 / 中 0 / 下 −1
  chikou: number; // 遅行スパンが 26 本前の高値より上 +1 / 安値より下 −1
  future: number; // 26 本先の雲が陽転(先行1>先行2) +1
  slope: number; // 基準線が 5 本前より上 +1
  wave: number; // 上昇N +1 / 下落N −1
}
export const SIGNAL_KEYS = ["tk", "cloud", "chikou", "future", "slope", "wave"] as const;

export interface Ichimoku {
  date: string;
  close: number;
  lines: Lines;
  futureCloud: { spanA: number; spanB: number };
  chikouRef: { high: number; low: number; close: number }; // 26 本前のローソク
  signal: IchimokuSignal;
  score: number; // −100..100
  judgment: "買い" | "売り" | "様子見";
  sanyaku: "三役好転" | "三役逆転" | null;
  wave: Wave;
  pivots: Pivot[];
  targets: Targets | null;
  time: ReturnType<typeof timeSignals>;
  levels: { price: number; label: string }[]; // 相場水準(価格順)
  support: { price: number; label: string } | null;
  resistance: { price: number; label: string } | null;
}

export function signalAt(bars: Bar[], i: number, pv?: Pivot[]): IchimokuSignal | null {
  const L = linesAt(bars, i);
  if (!L) return null;
  const c = bars[i].close;
  const top = Math.max(L.spanA, L.spanB), bot = Math.min(L.spanA, L.spanB);
  const ref = bars[i - 26];
  const fc = futureCloudAt(bars, i);
  const kijun5 = hl(bars, i - 5, 26);
  const w = classifyWave(pv ?? pivots(bars, i));
  return {
    tk: L.tenkan > L.kijun ? 1 : L.tenkan < L.kijun ? -1 : 0,
    cloud: c > top ? 1 : c < bot ? -1 : 0,
    chikou: c > ref.high ? 1 : c < ref.low ? -1 : 0,
    future: fc.spanA > fc.spanB ? 1 : fc.spanA < fc.spanB ? -1 : 0,
    slope: L.kijun > kijun5 ? 1 : L.kijun < kijun5 ? -1 : 0,
    wave: w === "上昇N波動" ? 1 : w === "下落N波動" ? -1 : 0,
  };
}

export const scoreOf = (s: IchimokuSignal) => (SIGNAL_KEYS.reduce((a, k) => a + s[k], 0) / SIGNAL_KEYS.length) * 100;
export const judgmentOf = (score: number): Ichimoku["judgment"] => (score >= 40 ? "買い" : score <= -40 ? "売り" : "様子見");

export function ichimoku(bars: Bar[]): Ichimoku | null {
  const i = bars.length - 1;
  const L = linesAt(bars, i);
  if (!L) return null;
  const pv = pivots(bars, i);
  const signal = signalAt(bars, i, pv)!;
  const score = scoreOf(signal);
  const close = bars[i].close;
  const t = targets(pv);
  const top = Math.max(L.spanA, L.spanB), bot = Math.min(L.spanA, L.spanB);
  const levels: Ichimoku["levels"] = [
    { price: L.tenkan, label: "転換線" }, { price: L.kijun, label: "基準線(26日半値)" },
    { price: top, label: "雲の上限" }, { price: bot, label: "雲の下限" },
    { price: hl(bars, i, 52), label: "52日半値" },
    ...pv.filter((p) => p.confirmed).slice(-4).map((p) => ({ price: p.price, label: `${p.type === "high" ? "高値" : "安値"} ${p.date.slice(5).replace("-", "/")}` })),
    ...(t ? (["N", "V", "E", "NT"] as const).map((k) => ({ price: t[k], label: `${k}計算値` })) : []),
  ].sort((a, b) => a.price - b.price);
  const below = levels.filter((l) => l.price < close), above = levels.filter((l) => l.price > close);
  const ref = bars[i - 26];
  return {
    date: bars[i].date, close, lines: L, futureCloud: futureCloudAt(bars, i),
    chikouRef: { high: ref.high, low: ref.low, close: ref.close },
    signal, score, judgment: judgmentOf(score),
    sanyaku: signal.tk > 0 && signal.cloud > 0 && signal.chikou > 0 ? "三役好転" : signal.tk < 0 && signal.cloud < 0 && signal.chikou < 0 ? "三役逆転" : null,
    wave: classifyWave(pv), pivots: pv.slice(-6), targets: t, time: timeSignals(pv, i, bars),
    levels, support: below[below.length - 1] ?? null, resistance: above[0] ?? null,
  };
}

export interface Backtest {
  from: string; to: string; n: number;
  buy: { n: number; hit: number }; sell: { n: number; hit: number };
  buy5: { n: number; hit: number }; sell5: { n: number; hit: number }; // 5 営業日後
  perSignal: Record<(typeof SIGNAL_KEYS)[number], { pos: number; posUp: number; neg: number; negUp: number }>;
  upRate: number; upRate5: number;
}

/** 過去データで「判断 → 翌営業日 / 5営業日後」の的中を検証 */
export function backtest(bars: Bar[]): { stats: Backtest; samples: { date: string; signal: IchimokuSignal; timeHit: boolean; up: 0 | 1 }[] } {
  const samples: { date: string; signal: IchimokuSignal; timeHit: boolean; up: 0 | 1 }[] = [];
  const stats: Backtest = {
    from: "", to: "", n: 0, buy: { n: 0, hit: 0 }, sell: { n: 0, hit: 0 }, buy5: { n: 0, hit: 0 }, sell5: { n: 0, hit: 0 },
    perSignal: Object.fromEntries(SIGNAL_KEYS.map((k) => [k, { pos: 0, posUp: 0, neg: 0, negUp: 0 }])) as Backtest["perSignal"], upRate: 0, upRate5: 0,
  };
  let ups = 0, ups5 = 0, n5 = 0;
  for (let i = 78; i < bars.length - 1; i++) {
    const pv = pivots(bars, i);
    const s = signalAt(bars, i, pv);
    if (!s) continue;
    const up = bars[i + 1].close > bars[i].close ? 1 : 0;
    samples.push({ date: bars[i].date, signal: s, timeHit: timeSignals(pv, i, bars).hits.length > 0, up });
    stats.from ||= bars[i].date; stats.to = bars[i].date; stats.n++; ups += up;
    const j = judgmentOf(scoreOf(s));
    if (j === "買い") { stats.buy.n++; stats.buy.hit += up; }
    if (j === "売り") { stats.sell.n++; stats.sell.hit += 1 - up; }
    if (i + 5 < bars.length) {
      const up5 = bars[i + 5].close > bars[i].close ? 1 : 0;
      ups5 += up5; n5++;
      if (j === "買い") { stats.buy5.n++; stats.buy5.hit += up5; }
      if (j === "売り") { stats.sell5.n++; stats.sell5.hit += 1 - up5; }
    }
    for (const k of SIGNAL_KEYS) {
      const ps = stats.perSignal[k];
      if (s[k] > 0) { ps.pos++; ps.posUp += up; } else if (s[k] < 0) { ps.neg++; ps.negUp += up; }
    }
  }
  stats.upRate = stats.n ? ups / stats.n : 0;
  stats.upRate5 = n5 ? ups5 / n5 : 0;
  return { stats, samples };
}

/** 日経公式 CSV(データ日付,終値,始値,高値,安値)→ 日足 */
export function parseNikkeiOhlc(text: string): Bar[] {
  const out: Bar[] = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(",").map((s) => s.replace(/"/g, "").trim());
    const m = c[0]?.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    const [close, open, high, low] = [c[1], c[2], c[3], c[4]].map(Number);
    if (m && close > 0 && high > 0 && low > 0) out.push({ date: `${m[1]}-${m[2]}-${m[3]}`, open: open || close, high, low, close });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
