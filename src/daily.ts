/**
 * 日次: 日経225オプションの行使価格別 建玉(JPX 当日取引高等「建玉残高状況」別紙1)と
 * 清算値段・IV(JPX「先物・オプション清算値段等」rbYYYYMMDD.csv)から、
 * 建玉の偏り・壁・最大苦痛価格・想定変動幅を算出する。
 * 投資部門別(個人/法人)の内訳は日次では公表されないため含まない。
 */

export interface DailyStrike {
  month: string; // YYYYMM
  strike: number;
  putOi?: number; putChg?: number; putVol?: number; putPx?: number; putIv?: number;
  callOi?: number; callChg?: number; callVol?: number; callPx?: number; callIv?: number;
}

import type { Backtest, Ichimoku } from "./ichimoku";

/** 一目均衡表(GitHub Actions で計算して日次データに同梱) */
export interface IchimokuPayload {
  result: Ichimoku; // 日経平均(現物)ベース
  barsSource: "nikkei" | "nikkei+yahoo" | "nikkei+jpx" | "cme-niy"; // 日経平均(公式 CSV / Yahoo 補完 / JPX 終値仮置き)または CME 日経225先物(円建て、Yahoo Finance)
  series?: "nikkei" | "futures"; // 計算のベース。未設定は nikkei
  filled?: string[]; // Yahoo で補った日付
  inProgress?: string; // 最後の足が取引中(ナイトセッション中など)ならその日付
  symbol?: string; // 先物の銘柄(NIY=F / NKD=F)
  repaired?: number; // 4本値が欠けていて前日終値から補った足の本数(表示期間内)
  backtest: Backtest;
  prior: Record<string, number>; // バックテストで学習した一目特徴量の重み(予測モデルの事前仮説)
  chart: { date: string; high: number; low: number; open: number; close: number; tenkan?: number; kijun?: number; spanA?: number; spanB?: number }[];
  futureCloud: { date: string; spanA: number; spanB: number }[]; // 26 本先まで
}

export interface DailyInput {
  tradeDate: string; // YYYY-MM-DD
  spot: number; // 日経平均(原資産価格)
  futures: { month: string; price: number; days: number }[];
  months: { month: string; days: number }[]; // オプション限月と SQ までの残日数
  strikes: DailyStrike[];
  sources?: string[];
  ichimoku?: IchimokuPayload;
}

export interface DailyAnalysis {
  tradeDate: string;
  spot: number;
  fut?: { month: string; price: number };
  front: { month: string; days: number };
  atmStrike: number;
  atmIv: number | null; // %
  expectedMove: number | null; // SQ までの 1σ 変動幅(円)
  skew: number | null; // 95% プット IV − 105% コール IV (pt)
  putOi: number; callOi: number; pcr: number; // 期近
  putOiAll: number; callOiAll: number; pcrAll: number;
  putChg: number; callChg: number; // 期近 前日比
  putWall: { strike: number; oi: number } | null; // spot 以下で最大のプット建玉
  callWall: { strike: number; oi: number } | null; // spot 以上で最大のコール建玉
  maxPain: number | null;
  topPutAdds: { strike: number; chg: number }[];
  topCallAdds: { strike: number; chg: number }[];
  prev?: { tradeDate: string; pcr: number; atmIv: number | null; spot: number };
  seller?: SellerPnl;
  ichimoku?: IchimokuPayload & { basis: number }; // basis = 先物 − 現物(先物換算用)
  comment: string;
}

/** 期近の売り手全体の SQ 時点損益(円)。現時点の清算価格で売ったとみなした値 */
export interface SellerPnl {
  curve: { price: number; put: number; call: number }[];
  putPremium: number; callPremium: number; // 現時点のプレミアム総額(=売り手の最大利益)
  putBreakeven: number | null; // これを下回るとプット売り手全体が損失
  callBreakeven: number | null; // これを上回るとコール売り手全体が損失
  putAtDown5: number; putAtDown10: number; // 現値から −5% / −10% での プット売り手損益
  callAtUp5: number; callAtUp10: number;
}

export const MULTIPLIER = 1000; // 日経225オプション(ラージ)の取引単位

export function sellerPnl(rows: DailyStrike[], spot: number): SellerPnl | undefined {
  const puts = rows.filter((r) => (r.putOi ?? 0) > 0 && r.putPx != null);
  const calls = rows.filter((r) => (r.callOi ?? 0) > 0 && r.callPx != null);
  if (!puts.length && !calls.length) return undefined;
  const putAt = (S: number) => MULTIPLIER * puts.reduce((acc, r) => acc + r.putOi! * (r.putPx! - Math.max(0, r.strike - S)), 0);
  const callAt = (S: number) => MULTIPLIER * calls.reduce((acc, r) => acc + r.callOi! * (r.callPx! - Math.max(0, S - r.strike)), 0);
  const step = 250, lo = Math.floor((spot * 0.8) / step) * step, hi = Math.ceil((spot * 1.2) / step) * step;
  const curve: SellerPnl["curve"] = [];
  for (let S = lo; S <= hi; S += step) curve.push({ price: S, put: putAt(S), call: callAt(S) });
  // 損益分岐: 現値から外側へ向かって初めて負になる価格(線形補間)
  const cross = (f: (S: number) => number, dir: 1 | -1) => {
    let prevS = spot, prevV = f(spot);
    if (prevV < 0) return spot;
    for (let k = 1; k <= 400; k++) {
      const S = spot + dir * k * 50, v = f(S);
      if (v < 0) return prevS + ((S - prevS) * prevV) / (prevV - v);
      prevS = S; prevV = v;
    }
    return null;
  };
  return {
    curve, putPremium: putAt(1e9), callPremium: callAt(0),
    putBreakeven: puts.length ? cross(putAt, -1) : null,
    callBreakeven: calls.length ? cross(callAt, 1) : null,
    putAtDown5: putAt(spot * 0.95), putAtDown10: putAt(spot * 0.9),
    callAtUp5: callAt(spot * 1.05), callAtUp10: callAt(spot * 1.1),
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const nearest = <T extends { strike: number }>(xs: T[], target: number) =>
  xs.reduce((best, x) => (Math.abs(x.strike - target) < Math.abs(best.strike - target) ? x : best), xs[0]);

export function computeMaxPain(rows: DailyStrike[]): number | null {
  const ks = rows.filter((r) => (r.putOi ?? 0) + (r.callOi ?? 0) > 0);
  if (!ks.length) return null;
  let best: number | null = null, bestPain = Infinity;
  for (const { strike: K } of ks) {
    let pain = 0;
    for (const r of ks) {
      pain += (r.callOi ?? 0) * Math.max(0, K - r.strike) + (r.putOi ?? 0) * Math.max(0, r.strike - K);
    }
    if (pain < bestPain) { bestPain = pain; best = K; }
  }
  return best;
}

export function analyzeDaily(d: DailyInput, prev?: DailyAnalysis): DailyAnalysis {
  // 期近: SQ まで 3 日以上ある最も近い限月(直前は次限月へ切替)
  const months = [...d.months].sort((a, b) => a.month.localeCompare(b.month));
  const front = months.find((m) => m.days >= 3) ?? months[0];
  if (!front) throw new Error("no option months");
  const rows = d.strikes.filter((s) => s.month === front.month).sort((a, b) => a.strike - b.strike);
  if (!rows.length) throw new Error(`no strikes for ${front.month}`);

  const putOi = sum(rows.map((r) => r.putOi ?? 0));
  const callOi = sum(rows.map((r) => r.callOi ?? 0));
  const putOiAll = sum(d.strikes.map((r) => r.putOi ?? 0));
  const callOiAll = sum(d.strikes.map((r) => r.callOi ?? 0));

  const withIv = rows.filter((r) => r.putIv || r.callIv);
  const atm = nearest(withIv.length ? withIv : rows, d.spot);
  const ivs = [atm.putIv, atm.callIv].filter((v): v is number => !!v);
  const atmIv = ivs.length ? sum(ivs) / ivs.length : null;
  const expectedMove = atmIv ? d.spot * (atmIv / 100) * Math.sqrt(front.days / 365) : null;

  const putSide = rows.filter((r) => r.putIv);
  const callSide = rows.filter((r) => r.callIv);
  const skew = putSide.length && callSide.length
    ? nearest(putSide, d.spot * 0.95).putIv! - nearest(callSide, d.spot * 1.05).callIv!
    : null;

  const below = rows.filter((r) => r.strike <= d.spot && (r.putOi ?? 0) > 0);
  const above = rows.filter((r) => r.strike >= d.spot && (r.callOi ?? 0) > 0);
  const putWall = below.length ? below.reduce((a, b) => ((b.putOi ?? 0) > (a.putOi ?? 0) ? b : a)) : null;
  const callWall = above.length ? above.reduce((a, b) => ((b.callOi ?? 0) > (a.callOi ?? 0) ? b : a)) : null;

  const top = (key: "putChg" | "callChg") =>
    rows.filter((r) => (r[key] ?? 0) > 0).sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, 3).map((r) => ({ strike: r.strike, chg: r[key]! }));

  const fut = [...d.futures].sort((a, b) => a.month.localeCompare(b.month)).find((f) => f.days >= 1);
  const pcr = callOi ? putOi / callOi : 0;
  const maxPain = computeMaxPain(rows);

  const a: DailyAnalysis = {
    tradeDate: d.tradeDate, spot: d.spot, fut: fut && { month: fut.month, price: fut.price },
    front: { month: front.month, days: front.days },
    atmStrike: atm.strike, atmIv, expectedMove, skew,
    putOi, callOi, pcr, putOiAll, callOiAll, pcrAll: callOiAll ? putOiAll / callOiAll : 0,
    putChg: sum(rows.map((r) => r.putChg ?? 0)), callChg: sum(rows.map((r) => r.callChg ?? 0)),
    putWall: putWall && { strike: putWall.strike, oi: putWall.putOi! },
    callWall: callWall && { strike: callWall.strike, oi: callWall.callOi! },
    maxPain, topPutAdds: top("putChg"), topCallAdds: top("callChg"),
    seller: sellerPnl(rows, d.spot),
    ichimoku: d.ichimoku && { ...d.ichimoku, basis: fut ? fut.price - d.spot : 0 },
    prev: prev && { tradeDate: prev.tradeDate, pcr: prev.pcr, atmIv: prev.atmIv, spot: prev.spot },
    comment: "",
  };
  a.comment = dailyComment(a);
  return a;
}

const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");

export function dailyComment(a: DailyAnalysis): string {
  const parts: string[] = [];
  if (a.putWall && a.callWall) parts.push(`建玉の壁は下${yen(a.putWall.strike)}円(プット)・上${yen(a.callWall.strike)}円(コール)。`);
  if (a.maxPain) {
    const gap = a.maxPain - a.spot;
    const pull = a.front.days <= 10 ? "SQ接近で引き寄せられやすい局面" : "SQまで日数があり影響は限定的";
    parts.push(`最大苦痛価格${yen(a.maxPain)}円は現値より${gap >= 0 ? "上" : "下"}に${yen(Math.abs(gap))}円(${pull})。`);
  }
  if (a.prev) {
    const d = a.pcr - a.prev.pcr;
    if (Math.abs(d) >= 0.02) parts.push(`期近P/C建玉比は${a.pcr.toFixed(2)}(前日比${d > 0 ? "+" : ""}${d.toFixed(2)})で${d > 0 ? "プット(下落ヘッジ)" : "コール"}側の積み増し。`);
  }
  if (a.seller?.putBreakeven) parts.push(`プット売り手全体はSQ時に${yen(a.seller.putBreakeven)}円を割ると損失に転じる計算。`);
  if (a.atmIv && a.expectedMove) parts.push(`ATM IV ${a.atmIv.toFixed(1)}%から、SQまでの1σ変動幅は±${yen(a.expectedMove)}円。`);
  return parts.join("");
}
