/**
 * 分足のテクニカル判定: 急落・急騰が「投げ(含み損を抱えた人が一気に手放す)→ 反転」なのか、
 * 「ブレイク → 続落・続伸」なのかを、複数の指標の点数で比べる。あわせて売り圧・買い圧の「たまり具合」を出す。
 *
 * 使う指標(すべて分足の OHLCV から):
 *  - 出来高急増(時間帯ごとの平常出来高・直近平均の大きい方との比)と値幅の拡大
 *  - 含み損の滞留: 直近 N 本で現値より上で出来た出来高の割合(上で買って含み損の人)/下で出来た割合(売り方の含み損)
 *  - 行き過ぎ: 20本EMA からの乖離(ATR 何本分か)、連続陰線・陽線の本数
 *  - ヒゲ: 下ヒゲ(安値からの戻し)= 吸収、ヒゲなしの安値引け = 継続
 *  - RSI(14)の売られ過ぎ・買われ過ぎと、価格との逆行(ダイバージェンス)
 *  - ATR の拡大(14本 / 50本)、ボリンジャーバンド幅の収縮(スクイーズ)からのバンド外への放れ
 *  - OBV(出来高を伴う方向)の傾き
 */
import { LOOKBACK, slotOf, type IBar, type Tf, type VolProfile } from "./alerts";

const clip01 = (x: number) => Math.max(0, Math.min(1, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function ema(xs: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  xs.forEach((x, i) => out.push(i ? out[i - 1] + k * (x - out[i - 1]) : x));
  return out;
}
function rsiSeries(close: number[], n = 14): number[] {
  const out: number[] = new Array(close.length).fill(50);
  let g = 0, l = 0;
  for (let i = 1; i < close.length; i++) {
    const d = close[i] - close[i - 1];
    const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function atrSeries(b: IBar[], n: number): number[] {
  const tr = b.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low));
  const out: number[] = [];
  tr.forEach((t, i) => out.push(i ? (out[i - 1] * (n - 1) + t) / n : t));
  return out;
}

export interface Tech {
  volRatio: number; rangeRatio: number;
  underwaterLong: number; // 直近の出来高のうち、現値より上で出来た割合(買い方の含み損)
  underwaterShort: number; // 現値より下で出来た割合(売り方の含み損)
  stretch: number; // (終値 − EMA20) / ATR14
  consecDown: number; consecUp: number;
  lowerWick: number; upperWick: number; // ヒゲの長さ / 値幅
  closePos: number; // 0 = 安値引け、1 = 高値引け
  rsi: number;
  divergence: "bull" | "bear" | null; // 価格は安値(高値)更新、RSI は切り上げ(切り下げ)
  atrRatio: number; // ATR14 / ATR50
  bbWidthPct: number; // ボリンジャーバンド幅の、直近 100 本での位置(低いほど収縮 = エネルギーがたまっている)
  squeezeRelease: "down" | "up" | null; // 直前まで収縮していたバンドから外へ放れた
  obvSlope: number; // OBV の直近 20 本の傾き(出来高で正規化、−1..1)
  atr: number; // ATR14(値幅の平均)
  trend: number; // 大きな流れ: (EMA20 − 長期EMA) / ATR。+ は上昇トレンド
  newHigh: boolean; newLow: boolean; // 直近(約1日〜5日)の高値・安値を更新した足か(= ブレイクの初動)
  priorUp: number; priorDown: number; // 直近の同じ期間に出ていた上昇・下落クライマックスの本数(2回目以降は息切れのサイン)
}

const UW_BARS: Record<Tf, number> = { "5m": 288, "15m": 192, "60m": 120 }; // 含み損を見る期間(約1日・2日・5日)
const TREND_EMA: Record<Tf, number> = { "5m": 144, "15m": 96, "60m": 50 }; // 大きな流れを見る長期EMA(約12時間・1日・2日)

/**
 * 足の配列ごとに一度だけ計算する系列(EMA・ATR・RSI・ボリンジャー・クライマックス足の印)。
 * Worker の CPU 制限(1 回 10ms 程度)に収めるため、同じ配列で何度も判定するときは使い回す
 */
interface Series { sig: string; tf: Tf; profile?: VolProfile; e20: number[]; eLong: number[]; atr14: number[]; atr50: number[]; rsi: number[]; bbM: number[]; bbSd: number[]; bbW: number[]; climax: Int8Array; base: number[]; avgRange: number[] }
const seriesCache = new WeakMap<IBar[], Series>();
function seriesOf(bars: IBar[], tf: Tf, profile?: VolProfile): Series {
  const last = bars[bars.length - 1];
  const sig = `${bars.length}:${last?.t}:${last?.close}:${last?.volume}:${last?.high}:${last?.low}`;
  const c = seriesCache.get(bars);
  if (c && c.sig === sig && c.tf === tf && c.profile === profile) return c;
  const close = bars.map((x) => x.close);
  const n = bars.length;
  const bbM: number[] = new Array(n).fill(0), bbSd: number[] = new Array(n).fill(0), bbW: number[] = new Array(n).fill(0);
  let s1 = 0, s2 = 0;
  for (let k = 0; k < n; k++) {
    s1 += close[k]; s2 += close[k] * close[k];
    if (k >= 20) { s1 -= close[k - 20]; s2 -= close[k - 20] * close[k - 20]; }
    const cnt = Math.min(20, k + 1), m = s1 / cnt, sd = Math.sqrt(Math.max(0, s2 / cnt - m * m));
    bbM[k] = m; bbSd[k] = sd; bbW[k] = m ? (4 * sd) / m : 0;
  }
  const base: number[] = new Array(n).fill(0), avgRange: number[] = new Array(n).fill(0);
  const climax = new Int8Array(n);
  let vSum = 0, rSum = 0;
  for (let k = 0; k < n; k++) {
    if (k > 0) { vSum += bars[k - 1].volume; rSum += bars[k - 1].high - bars[k - 1].low; }
    if (k > LOOKBACK) { vSum -= bars[k - 1 - LOOKBACK].volume; rSum -= bars[k - 1 - LOOKBACK].high - bars[k - 1 - LOOKBACK].low; }
    const cnt = Math.min(LOOKBACK, k);
    if (!cnt) continue;
    const avg = vSum / cnt;
    const slot = profile?.[slotOf(bars[k].t, tf)];
    base[k] = slot && slot > avg ? slot : avg;
    avgRange[k] = rSum / cnt;
    const x = bars[k];
    if (k >= LOOKBACK && base[k] > 0 && avgRange[k] > 0 && x.volume >= 2 * base[k] && x.high - x.low >= 1.5 * avgRange[k]) {
      const pos = (x.close - x.low) / (x.high - x.low || 1);
      climax[k] = x.close > x.open && pos >= 0.66 ? 1 : x.close < x.open && pos <= 0.34 ? -1 : 0;
    }
  }
  const out: Series = { sig, tf, profile, e20: ema(close, 20), eLong: ema(close, TREND_EMA[tf]), atr14: atrSeries(bars, 14), atr50: atrSeries(bars, 50), rsi: rsiSeries(close), bbM, bbSd, bbW, climax, base, avgRange };
  seriesCache.set(bars, out);
  return out;
}

export function techAt(bars: IBar[], i: number, tf: Tf, profile?: VolProfile, elapsed = 1): Tech | null {
  if (i < 30) return null;
  const S = seriesOf(bars, tf, profile);
  const b = bars[i];
  const e20 = S.e20[i];
  const atr = S.atr14[i] || 1;
  const base = S.base[i] || 1;
  const avgRange = S.avgRange[i] || 1;
  const range = b.high - b.low || 1;
  // 含み損の滞留(出来高を各足の終値に置く近似)と、直近の高値・安値、同じ向きのクライマックス回数
  const w0 = Math.max(0, i - UW_BARS[tf]);
  let vAll = 0, vAbove = 0, vBelow = 0, hiW = -Infinity, loW = Infinity, priorUp = 0, priorDown = 0;
  for (let k = w0; k < i; k++) {
    const x = bars[k];
    vAll += x.volume;
    if (x.close > b.close) vAbove += x.volume; else if (x.close < b.close) vBelow += x.volume;
    if (x.high > hiW) hiW = x.high;
    if (x.low < loW) loW = x.low;
    if (k < i - 1) { if (S.climax[k] === 1) priorUp++; else if (S.climax[k] === -1) priorDown++; }
  }
  vAll = vAll || 1;
  if (hiW === -Infinity) { hiW = b.high; loW = b.low; }
  let cd = 0, cu = 0;
  for (let k = i; k >= 0 && bars[k].close < bars[k].open; k--) cd++;
  for (let k = i; k >= 0 && bars[k].close > bars[k].open; k--) cu++;
  const rsi = S.rsi;
  // ダイバージェンス: 直近 5 本の安値(高値)が、その前 6〜30 本の安値(高値)を更新し、RSI は前の谷(山)より上(下)
  let rL = i - 4, rH = i - 4, eL = Math.max(0, i - 30), eH = eL;
  for (let k = i - 4; k <= i; k++) { if (bars[k].low < bars[rL].low) rL = k; if (bars[k].high > bars[rH].high) rH = k; }
  const eEnd = i - 5;
  for (let k = eL; k < eEnd; k++) { if (bars[k].low < bars[eL].low) eL = k; if (bars[k].high > bars[eH].high) eH = k; }
  let divergence: Tech["divergence"] = null;
  if (eEnd > Math.max(0, i - 30)) {
    if (bars[rL].low < bars[eL].low && rsi[rL] > rsi[eL] + 3) divergence = "bull";
    else if (bars[rH].high > bars[eH].high && rsi[rH] < rsi[eH] - 3) divergence = "bear";
  }
  // ボリンジャーバンド幅の、直近 100 本での位置
  const k0 = Math.max(20, i - 100);
  const cnt = i - k0 + 1;
  let below = 0, prevMin = Infinity;
  for (let k = k0; k <= i; k++) { if (S.bbW[k] < S.bbW[i]) below++; if (k >= i - 5 && k < i && S.bbW[k] < prevMin) prevMin = S.bbW[k]; }
  const bbWidthPct = cnt > 0 ? (below / cnt) * 100 : 50;
  let belowPrev = 0;
  if (prevMin !== Infinity) for (let k = k0; k <= i; k++) if (S.bbW[k] < prevMin) belowPrev++;
  const prevPct = prevMin === Infinity ? 50 : (belowPrev / cnt) * 100;
  const m = S.bbM[i], sd = S.bbSd[i];
  const squeezeRelease: Tech["squeezeRelease"] = prevPct <= 20 ? (b.close < m - 2 * sd ? "down" : b.close > m + 2 * sd ? "up" : null) : null;
  // OBV の傾き
  let obv = 0, vol20 = bars[Math.max(0, i - 20)].volume;
  for (let k = Math.max(1, i - 20); k <= i; k++) { obv += Math.sign(bars[k].close - bars[k - 1].close) * bars[k].volume; if (k > Math.max(0, i - 20)) vol20 += bars[k].volume; }
  const firstObv = Math.sign(bars[Math.max(1, i - 20)].close - bars[Math.max(1, i - 20) - 1].close) * bars[Math.max(1, i - 20)].volume;
  return {
    volRatio: b.volume / (base * elapsed), rangeRatio: range / (avgRange * Math.sqrt(elapsed)),
    underwaterLong: vAbove / vAll, underwaterShort: vBelow / vAll,
    stretch: (b.close - e20) / atr,
    consecDown: cd, consecUp: cu,
    lowerWick: (Math.min(b.open, b.close) - b.low) / range, upperWick: (b.high - Math.max(b.open, b.close)) / range,
    closePos: (b.close - b.low) / range,
    rsi: rsi[i], divergence,
    atrRatio: atr / (S.atr50[i] || atr),
    bbWidthPct, squeezeRelease,
    obvSlope: Math.max(-1, Math.min(1, (obv - firstObv) / (vol20 || 1))),
    atr,
    trend: Math.max(-6, Math.min(6, (e20 - S.eLong[i]) / atr)),
    newHigh: b.high >= hiW, newLow: b.low <= loW,
    priorUp, priorDown,
  };
}

export interface Judge {
  dir: "down" | "up"; // 判定している動きの向き(下落局面なら down)
  capitulation: number; // 投げ度(含み損の人が一気に手放している度合い)0..100
  reversal: number; // 反転の材料 0..100
  continuation: number; // ブレイク継続の材料 0..100
  verdict: "capitulation" | "reversal" | "breakout" | "undecided";
  reasons: string[];
  tech: Tech;
  learned?: number; // 学習モデルの混ぜ具合(0..1)
}

// ---- 学習(src/judge-learn.ts で当たりはずれから推定し、ここで使う) ----

/** 判定の特徴量(向き dir にそろえる。+ は「その向きに行き過ぎ・強い」) */
export const FEATURE_NAMES = ["出来高(log)", "値幅", "含み損の出来高", "EMA乖離", "連続足", "戻しヒゲ", "引けの位置", "RSI", "ダイバージェンス", "ATR拡大", "バンド幅", "スクイーズ放れ", "OBV", "大きな流れ", "高値安値更新", "クライマックス回数"] as const;
export function featureVec(t: Tech, dir: "down" | "up"): number[] {
  const dn = dir === "down";
  return [
    Math.log(Math.max(0.1, t.volRatio)),
    Math.min(5, t.rangeRatio) - 1,
    (dn ? t.underwaterLong : t.underwaterShort) - 0.5,
    Math.max(-3, Math.min(3, (dn ? -t.stretch : t.stretch) / 2)),
    Math.min(10, dn ? t.consecDown : t.consecUp) / 8,
    dn ? t.lowerWick : t.upperWick,
    (dn ? 1 - t.closePos : t.closePos) - 0.5,
    (dn ? 50 - t.rsi : t.rsi - 50) / 50,
    (dn && t.divergence === "bull") || (!dn && t.divergence === "bear") ? 1 : 0,
    Math.min(2, t.atrRatio) - 1,
    t.bbWidthPct / 100 - 0.5,
    t.squeezeRelease === dir ? 1 : 0,
    dn ? -t.obvSlope : t.obvSlope,
    Math.max(-2, Math.min(2, (dn ? -t.trend : t.trend) / 3)),
    (dn ? t.newLow : t.newHigh) ? 1 : 0,
    Math.min(3, dn ? t.priorDown : t.priorUp) / 2,
  ];
}
export interface JudgeModel {
  v?: number;
  n: number; // 学習に使った件数
  wRev: number[]; wCon: number[]; // ロジスティック回帰の重み(先頭が切片)
  adj: { climax: number; confirm: number; break: number }; // 通知の厳しさの上乗せ(当たりが悪いほど大きい)
  stats: Record<string, { n: number; hit: number }>; // 種類別の直近の当たり
  base: { rev: number; con: number; none: number }; // 全体の結果の割合
  updatedAt: number;
}
export const LEARN_MIN_N = 40;
export const learnWeight = (n: number) => Math.min(0.7, n / (n + 200));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
export const prob = (w: number[], x: number[]) => sigmoid(w[0] + x.reduce((s, xi, i) => s + xi * (w[i + 1] ?? 0), 0));
let learned: JudgeModel | null = null;
export function setJudgeModel(m: JudgeModel | null) { learned = m; }
export const judgeAdj = () => learned?.adj ?? { climax: 0, confirm: 0, break: 0 };

/** 向き dir の動きについて、投げ・反転・継続の点数をつける */
export function judgeAt(bars: IBar[], i: number, tf: Tf, dir: "down" | "up", profile?: VolProfile, elapsed = 1): Judge | null {
  const t = techAt(bars, i, tf, profile, elapsed);
  if (!t) return null;
  const dn = dir === "down";
  const uw = dn ? t.underwaterLong : t.underwaterShort; // 含み損で投げる側
  const stretch = dn ? -t.stretch : t.stretch;
  const consec = dn ? t.consecDown : t.consecUp;
  const wickBack = dn ? t.lowerWick : t.upperWick; // 戻しのヒゲ
  const extreme = dn ? (30 - t.rsi) / 15 : (t.rsi - 70) / 15; // 売られ過ぎ・買われ過ぎ
  const div = (dn && t.divergence === "bull") || (!dn && t.divergence === "bear");
  const closeAtExtreme = dn ? 1 - t.closePos : t.closePos; // 1 = 安値(高値)引け
  const obvConfirm = dn ? -t.obvSlope : t.obvSlope;
  const release = t.squeezeRelease === dir;
  const reasons: string[] = [];

  const capParts = [
    [25, clip01((t.volRatio - 1.5) / 2.5), `出来高 ${t.volRatio.toFixed(1)}倍`],
    [25, clip01((uw - 0.5) / 0.4), `含み損の${dn ? "買い方" : "売り方"}の出来高 ${Math.round(uw * 100)}%`],
    [20, clip01((stretch - 1) / 2), `20EMAから ${stretch.toFixed(1)}ATR 乖離`],
    [15, clip01((t.rangeRatio - 1) / 2), `値幅 ${t.rangeRatio.toFixed(1)}倍`],
    [15, clip01(consec / 8), `連続${dn ? "陰線" : "陽線"} ${consec}本`],
  ] as const;
  const capitulation = capParts.reduce((s, [w, v]) => s + w * v, 0);
  for (const [w, v, label] of capParts) if (w * v >= w * 0.6) reasons.push(`投げ: ${label}`);

  const trendWith = clip01((dn ? -t.trend : t.trend) / 3); // 動きと同じ向きの大きな流れ
  const prior = dn ? t.priorDown : t.priorUp; // それまでの同じ向きのクライマックス回数
  const fresh = dn ? t.newLow : t.newHigh; // 高値(安値)更新
  const revParts = [
    [25, clip01((wickBack - 0.2) / 0.4), `${dn ? "下" : "上"}ヒゲ ${Math.round(wickBack * 100)}%`],
    [15, clip01(extreme), `RSI ${t.rsi.toFixed(0)}`],
    [25, div ? 1 : 0, `RSI ダイバージェンス`],
    [15, clip01((stretch - 2) / 2), `行き過ぎ ${stretch.toFixed(1)}ATR`],
    [20, clip01(prior / 2), `同じ向きのクライマックス ${prior + 1}回目(息切れ)`],
  ] as const;
  const reversal = revParts.reduce((s, [w, v]) => s + w * v, 0);
  for (const [w, v, label] of revParts) if (w * v >= w * 0.6) reasons.push(`反転: ${label}`);

  const conParts = [
    [20, clip01((closeAtExtreme - 0.7) / 0.3), `${dn ? "安値" : "高値"}引け`],
    [10, clip01((t.atrRatio - 1) / 0.6), `ATR 拡大 ${t.atrRatio.toFixed(2)}倍`],
    [10, release ? 1 : 0, `収縮(スクイーズ)からのバンド放れ`],
    [15, clip01(obvConfirm / 0.6), `OBV が${dn ? "下向き" : "上向き"}`],
    [10, div || extreme > 0.5 ? 0 : 1, `RSI に過熱・逆行なし`],
    [20, trendWith, `大きな流れが${dn ? "下向き" : "上向き"}`],
    [15, fresh && prior === 0 ? 1 : 0, `${dn ? "安値" : "高値"}更新の初動(1回目のクライマックス)`],
  ] as const;
  const continuation = conParts.reduce((s, [w, v]) => s + w * v, 0);
  for (const [w, v, label] of conParts) if (w * v >= w * 0.6) reasons.push(`継続: ${label}`);

  // 学習済みモデル(実際の値動きで当たりはずれを学習)があれば、手作りの点数と混ぜる
  let revS = reversal, conS = continuation;
  const m = learned;
  if (m && m.n >= LEARN_MIN_N) {
    const x = featureVec(t, dir);
    const a = learnWeight(m.n);
    revS = (1 - a) * reversal + a * 100 * prob(m.wRev, x);
    conS = (1 - a) * continuation + a * 100 * prob(m.wCon, x);
  }
  const reversal2 = revS, continuation2 = conS;
  let verdict: Judge["verdict"] = "undecided";
  if (capitulation >= 60 && reversal2 >= continuation2) verdict = "capitulation";
  else if (reversal2 >= 50 && reversal2 >= continuation2 + 15) verdict = "reversal";
  else if (continuation2 >= 60 && continuation2 >= reversal2 + 15) verdict = "breakout";
  return { dir, capitulation: Math.round(capitulation), reversal: Math.round(reversal2), continuation: Math.round(continuation2), verdict, reasons, tech: t, learned: m && m.n >= LEARN_MIN_N ? learnWeight(m.n) : 0 };
}

/** 売り圧・買い圧のたまり具合: バンド収縮(エネルギー)× OBV の向き、含み損の滞留 */
export interface Energy { compression: number; sell: number; buy: number; trappedLong: number; trappedShort: number; note: string }
export function energyAt(bars: IBar[], i: number, tf: Tf, profile?: VolProfile): Energy | null {
  const t = techAt(bars, i, tf, profile);
  if (!t) return null;
  const compression = Math.round(100 - t.bbWidthPct);
  const sell = Math.round(compression * clip01(-t.obvSlope / 0.5) * 0.6 + 40 * clip01((t.underwaterLong - 0.5) / 0.4));
  const buy = Math.round(compression * clip01(t.obvSlope / 0.5) * 0.6 + 40 * clip01((t.underwaterShort - 0.5) / 0.4));
  const note = compression >= 70 ? `値幅が収縮してエネルギーがたまっています(${sell > buy ? "売り圧" : buy > sell ? "買い圧" : "方向感なし"}優勢)` : compression <= 30 ? "値幅が広がり、エネルギーを放出中" : "平常";
  return { compression, sell, buy, trappedLong: Math.round(t.underwaterLong * 100), trappedShort: Math.round(t.underwaterShort * 100), note };
}

export const VERDICT_LABEL: Record<Judge["verdict"], string> = {
  capitulation: "投げ(含み損の一斉手放し)→ 反転含み",
  reversal: "反転の兆し",
  breakout: "ブレイク(継続)優勢",
  undecided: "判定保留(材料が拮抗)",
};
/**
 * 天井・大底として通知してよいか(慎重判定): 反転 ≥ 継続 + 5 + 上乗せ、かつ「反転の決め手」が 1 つ以上
 * 決め手 = 戻しのヒゲ 30% 以上 / RSI ダイバージェンス / 2 回目以降のクライマックスで RSI が過熱
 * 大きな流れと同じ向きの、高値(安値)更新の初動は、決め手があっても継続を優先(通知しない)
 */
export interface GateCtx {
  beyond?: boolean; // 売り手の損益分岐の外(売り手が損失圏 = ヘッジの先物買い・売りで動きが加速しやすい)
  htf?: Tech | null; // 上位足(60分足)の最新の状態
}
export function reversalOk(j: Judge, extra = 0, ctx: GateCtx = {}): { ok: boolean; why: string } {
  const t = j.tech, dn = j.dir === "down";
  // 上位足が同じ向きのトレンドで、まだ過熱していない → 下位足の天井・大底は押し目・戻りにすぎないことが多い
  const h = ctx.htf;
  if (h) {
    const hTrend = dn ? -h.trend : h.trend, hHot = dn ? h.rsi <= 30 : h.rsi >= 70;
    const hDiv = (dn && h.divergence === "bull") || (!dn && h.divergence === "bear");
    if (hTrend >= 1 && !hHot && !hDiv) return { ok: false, why: `60分足が${dn ? "下降" : "上昇"}トレンドで過熱なし(RSI ${h.rsi.toFixed(0)})` };
  }
  const wick = dn ? t.lowerWick : t.upperWick, prior = dn ? t.priorDown : t.priorUp;
  const div = (dn && t.divergence === "bull") || (!dn && t.divergence === "bear");
  const hot = dn ? t.rsi <= 30 : t.rsi >= 70;
  const decisive = wick >= 0.3 || div || (prior >= 1 && hot);
  const freshTrend = (dn ? t.newLow : t.newHigh) && prior === 0 && (dn ? -t.trend : t.trend) >= 1.5 && !div;
  if (freshTrend) return { ok: false, why: "流れと同じ向きの高値(安値)更新の初動(ブレイク優勢)" };
  // 損益分岐の外では、売り手のヘッジ(踏み上げ・投げ)で走りやすいので、より強い反転材料を求める
  const need = 5 + extra + (ctx.beyond ? 10 : 0);
  if (j.reversal < j.continuation + need) return { ok: false, why: `反転 ${j.reversal} < 継続 ${j.continuation} + ${need}${ctx.beyond ? "(損益分岐の外)" : ""}` };
  if (!decisive) return { ok: false, why: "反転の決め手(ヒゲ・ダイバージェンス・2回目以降の過熱)なし" };
  if (ctx.beyond && !div && prior === 0) return { ok: false, why: "損益分岐の外で1回目のクライマックス(ダイバージェンスなし)" };
  return { ok: true, why: "" };
}

/** 投げ度による強さ: 高(60以上)・中(40以上)・低 */
export const tierOf = (cap: number): "高" | "中" | "低" => (cap >= 60 ? "高" : cap >= 40 ? "中" : "低");
export function judgeText(j: Judge): string {
  const t = j.tech;
  return [
    `  テクニカル判定: ${VERDICT_LABEL[j.verdict]} / 投げ度 ${j.capitulation}(${tierOf(j.capitulation)}) 反転 ${j.reversal} 継続 ${j.continuation}`,
    `  RSI ${t.rsi.toFixed(0)}${t.divergence ? `(${t.divergence === "bull" ? "強気" : "弱気"}ダイバージェンス)` : ""} / 20EMA乖離 ${t.stretch.toFixed(1)}ATR / 含み損の出来高 買い方 ${Math.round(t.underwaterLong * 100)}%・売り方 ${Math.round(t.underwaterShort * 100)}%`,
    j.reasons.length ? `  根拠: ${j.reasons.slice(0, 6).join("、")}` : "",
  ].filter(Boolean).join("\n");
}
