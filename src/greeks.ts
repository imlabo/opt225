/**
 * オプション売り手のデルタヘッジ・ガンマ・セータ(建玉ベースの推定)。
 *
 * 前提: 建玉はすべて「売り手がショート、買い手がロング」。買い手はヘッジせず、売り手が先物でデルタヘッジすると仮定する
 * (実際には買い手側のヘッジや、売り手がヘッジしないケースもあるため目安)。
 * 価格モデルは Black-Scholes(金利・配当 0)。IV は JPX 清算値段 CSV の行使価格別ボラティリティを使い、
 * 価格が動いても各行使価格の IV は変わらない(スティッキー・ストライク)とする。
 *
 * 単位: 日経225オプション(ラージ)1枚 = 指数 × 1,000円。先物ラージ 1枚 = 指数 × 1,000円(ミニは 100円)なので、
 * オプションのデルタ合計はそのまま「ラージ先物の枚数」になる。
 */
import type { DailyStrike } from "./daily";

export const OPT_MULT = 1000;

const SQ2PI = Math.sqrt(2 * Math.PI);
const pdf = (x: number) => Math.exp(-0.5 * x * x) / SQ2PI;
/** 標準正規分布の累積(Abramowitz-Stegun 7.1.26, 誤差 1.5e-7) */
export function cdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Black-Scholes(r=q=0)。theta は 1 日(暦日)あたり、指数ポイント */
export function bs(S: number, K: number, T: number, iv: number) {
  const sT = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + 0.5 * iv * iv * T) / sT;
  const nd = pdf(d1);
  return { callDelta: cdf(d1), putDelta: cdf(d1) - 1, gamma: nd / (S * sT), thetaDay: -(S * nd * iv) / (2 * Math.sqrt(T)) / 365 };
}

interface Leg { month: string; strike: number; T: number; iv: number; callOi: number; putOi: number }

/** 行使価格ごとに IV を決める: その側の IV → 反対側の IV → 同じ限月の近い行使価格の IV → fallback */
function legs(strikes: DailyStrike[], months: { month: string; days: number }[], fallbackIv: number): Leg[] {
  const days = new Map(months.map((m) => [m.month, m.days]));
  const out: Leg[] = [];
  const byMonth = new Map<string, DailyStrike[]>();
  for (const s of strikes) byMonth.set(s.month, [...(byMonth.get(s.month) ?? []), s]);
  for (const [month, rows] of byMonth) {
    const d = days.get(month) ?? 0;
    if (d < 1) continue; // SQ 当日・満期済みは除外
    const T = d / 365;
    const withIv = rows.filter((r) => r.putIv || r.callIv).map((r) => ({ k: r.strike, iv: ((r.putIv || r.callIv)! as number) }));
    const near = (k: number) => withIv.length ? withIv.reduce((b, x) => (Math.abs(x.k - k) < Math.abs(b.k - k) ? x : b)).iv : fallbackIv;
    for (const r of rows) {
      const callOi = r.callOi ?? 0, putOi = r.putOi ?? 0;
      if (callOi + putOi <= 0) continue;
      // コールとプットで IV が違う場合は建玉で加重(同じ行使価格なら理論上ほぼ同じ)
      const ivC = r.callIv || r.putIv || near(r.strike), ivP = r.putIv || r.callIv || near(r.strike);
      const iv = (callOi * ivC + putOi * ivP) / (callOi + putOi) / 100;
      if (!(iv > 0)) continue;
      out.push({ month, strike: r.strike, T, iv, callOi, putOi });
    }
  }
  return out;
}

/** 価格 S での売り手全体のヘッジ先物(ラージ枚数)とガンマ(100円あたりのヘッジ変化枚数) */
function at(ls: Leg[], S: number) {
  let callHedge = 0, putHedge = 0, gamma = 0, theta = 0;
  for (const l of ls) {
    const g = bs(S, l.strike, l.T, l.iv);
    callHedge += l.callOi * g.callDelta; // コール売り → 先物買いでヘッジ
    putHedge += l.putOi * g.putDelta; // プット売り → 先物売りでヘッジ(putDelta < 0)
    gamma += (l.callOi + l.putOi) * g.gamma;
    theta += (l.callOi + l.putOi) * g.thetaDay;
  }
  return { callHedge, putHedge, hedge: callHedge + putHedge, gamma100: gamma * 100, thetaYen: -theta * OPT_MULT };
}

export interface Greeks {
  hedge: number; // 売り手のデルタヘッジ先物ポジション(ラージ枚数、+ = 先物買い越し)
  callHedge: number; putHedge: number;
  gamma100: number; // 日経平均が 100 円動いたときに売り手が先物を売買する枚数(上昇で買い・下落で売り)
  gamma1pct: number; // 1% 動いたとき
  thetaYen: number; // 売り手が 1 日(暦日)に受け取る時間価値(円)
  thetaFrontYen: number; // うち期近
  frontDays: number;
  topGamma: { strike: number; month: string; gamma100: number }[]; // ガンマが集中する行使価格(100円あたりの枚数)
  profile: { price: number; hedge: number; gamma100: number }[]; // 価格ごとの売り手ヘッジとガンマ(IV・残日数は現在のまま)
  months: string[];
}

export function computeGreeks(strikes: DailyStrike[], months: { month: string; days: number }[], spot: number, frontMonth: string, atmIv: number | null): Greeks | undefined {
  const ls = legs(strikes, months, atmIv ?? 25);
  if (!ls.length) return undefined;
  const now = at(ls, spot);
  const front = at(ls.filter((l) => l.month === frontMonth), spot);
  const perStrike = new Map<string, { strike: number; month: string; gamma100: number }>();
  for (const l of ls) {
    const g = bs(spot, l.strike, l.T, l.iv).gamma * (l.callOi + l.putOi) * 100;
    const k = `${l.month}:${l.strike}`;
    perStrike.set(k, { strike: l.strike, month: l.month, gamma100: (perStrike.get(k)?.gamma100 ?? 0) + g });
  }
  const step = 250, lo = Math.floor((spot * 0.93) / step) * step, hi = Math.ceil((spot * 1.07) / step) * step;
  const profile: Greeks["profile"] = [];
  for (let S = lo; S <= hi; S += step) {
    const p = at(ls, S);
    profile.push({ price: S, hedge: p.hedge, gamma100: p.gamma100 });
  }
  return {
    hedge: now.hedge, callHedge: now.callHedge, putHedge: now.putHedge,
    gamma100: now.gamma100, gamma1pct: (now.gamma100 * spot) / 10000,
    thetaYen: now.thetaYen, thetaFrontYen: front.thetaYen, frontDays: months.find((m) => m.month === frontMonth)?.days ?? 0,
    topGamma: [...perStrike.values()].sort((a, b) => b.gamma100 - a.gamma100).slice(0, 3),
    profile, months: [...new Set(ls.map((l) => l.month))].sort(),
  };
}
