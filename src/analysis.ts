import { INVESTORS, INVESTOR_LABEL, type FlowRow, type Investor, type WeekData } from "./types";

/**
 * 投資部門別のオプション売買から「方向性(デルタ)の偏り」を週次で推定する。
 *
 * 公表データは建玉ではなく売買枚数なので、
 *   方向性フロー D = (コール買い − コール売り) − (プット買い − プット売り)
 * を「その週に積み上がった強気ポジション量の近似」とし、
 * 直近 N 週の累積を「推定ポジション」として扱う。
 *
 * 部門ごとの解釈(重みは WEIGHTS で調整可能):
 *  - 個人: 逆張りシグナル。個人の強気偏重は天井圏、弱気偏重は底値圏になりやすい。
 *  - 法人: 順張りシグナル(機関のヘッジ/方向性ポジション)。
 *  - 海外投資家: 順張りシグナル(参考として小さめの重み)。
 * さらに、個人のオプション純売り(ショート・ボラ)の膨張は急変動リスクとして別指標化する。
 */
export const WEIGHTS: Record<"individual" | "corporate" | "foreign", number> = {
  individual: -0.45,
  corporate: 0.35,
  foreign: 0.2,
};
export const POSITION_WINDOW = 4; // 推定ポジションの累積週数
export const Z_WINDOW = 26; // z スコアの母集団(週)

export interface InvestorMetrics {
  investor: Investor;
  label: string;
  netCall: number; // コール 買い−売り
  netPut: number; // プット 買い−売り
  directional: number; // netCall − netPut
  optionNetSell: number; // (売り−買い) コール+プット。正ならオプション売り越し(ショート・ボラ)
  position: number; // 直近 POSITION_WINDOW 週の directional 累積
  z: number; // position の z スコア
  short: ShortEstimate; // 売りポジションの推定
}

/** 売りポジションの推定(週次の売買から) */
export interface ShortEstimate {
  callSell: number; callBuy: number; putSell: number; putBuy: number; // 当週の枚数
  estCallShort: number; // 直近 POSITION_WINDOW 週の (コール売り−買い) 累計。正なら売り越し
  estPutShort: number; // 同 プット
  callPremiumNet: number | null; // 直近 POSITION_WINDOW 週の (売り代金−買い代金) 円。正ならプレミアム受け取り超
  putPremiumNet: number | null;
}

export interface Analysis {
  weekEnd: string;
  score: number; // -100..100
  bias: string;
  volSignal: string;
  investors: InvestorMetrics[];
  contributions: { investor: Investor; label: string; value: number }[];
  futNet: Partial<Record<Investor, number>>;
  comment: string;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function weekMetrics(flows: FlowRow[], investor: Investor) {
  const f = (p: "call" | "put") => flows.find((r) => r.product === p && r.investor === investor);
  const c = f("call");
  const p = f("put");
  const netCall = c ? c.buy - c.sell : 0;
  const netPut = p ? p.buy - p.sell : 0;
  const optionNetSell = (c ? c.sell - c.buy : 0) + (p ? p.sell - p.buy : 0);
  return { netCall, netPut, directional: netCall - netPut, optionNetSell };
}

function zscore(x: number, xs: number[]): number {
  if (xs.length < 3) return 0;
  const m = sum(xs) / xs.length;
  const sd = Math.sqrt(sum(xs.map((v) => (v - m) ** 2)) / (xs.length - 1));
  return sd === 0 ? 0 : (x - m) / sd;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export function biasLabel(score: number): string {
  if (score >= 40) return "上昇優勢";
  if (score >= 15) return "やや上昇";
  if (score > -15) return "中立";
  if (score > -40) return "やや下落";
  return "下落優勢";
}

/** history は古い順。最後の要素が分析対象の週。 */
export function analyze(history: WeekData[]): Analysis {
  if (history.length === 0) throw new Error("no data");
  const target = history[history.length - 1];
  const idx = history.length - 1;

  // 各週の推定ポジション(rolling sum)系列
  const rolling = (inv: Investor) =>
    history.map((_, i) =>
      sum(history.slice(Math.max(0, i - POSITION_WINDOW + 1), i + 1).map((w) => weekMetrics(w.flows, inv).directional)),
    );

  const investors: InvestorMetrics[] = INVESTORS.map((inv) => {
    const series = rolling(inv);
    const pop = series.slice(Math.max(0, idx - Z_WINDOW + 1), idx + 1);
    const m = weekMetrics(target.flows, inv);
    return { investor: inv, label: INVESTOR_LABEL[inv], ...m, position: series[idx], z: zscore(series[idx], pop), short: undefined as unknown as ShortEstimate };
  });

  for (const m of investors) m.short = shortEstimate(history, m.investor);

  const byInv = (inv: Investor) => investors.find((m) => m.investor === inv)!;
  const contributions = (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).map((inv) => ({
    investor: inv as Investor,
    label: INVESTOR_LABEL[inv],
    value: WEIGHTS[inv] * clamp(byInv(inv).z, -3, 3) * (100 / 3),
  }));
  const score = Math.round(clamp(sum(contributions.map((c) => c.value)) / sum(Object.values(WEIGHTS).map(Math.abs)), -100, 100));

  // 個人のショート・ボラ偏重(z)で急変動リスクを判定
  const indSell = history.map((w) => weekMetrics(w.flows, "individual").optionNetSell);
  const volZ = zscore(indSell[idx], indSell.slice(Math.max(0, idx - Z_WINDOW + 1), idx + 1));
  const volSignal = volZ >= 1.5 ? "急変動警戒" : volZ >= 0.75 ? "変動拡大注意" : volZ <= -1 ? "変動縮小気味" : "平常";

  const futNet: Partial<Record<Investor, number>> = {};
  for (const r of target.flows.filter((r) => r.product === "fut")) futNet[r.investor] = r.buy - r.sell;

  const bias = biasLabel(score);
  const ind = byInv("individual");
  const corp = byInv("corporate");
  const dir = (v: number) => (v > 0 ? "強気" : v < 0 ? "弱気" : "中立");
  const comment =
    `個人は推定ポジション${dir(ind.position)}(z=${ind.z.toFixed(2)})で逆張り的に${ind.z > 0 ? "上値の重さ" : ind.z < 0 ? "下値の堅さ" : "影響小"}を示唆。` +
    `法人は${dir(corp.position)}(z=${corp.z.toFixed(2)})。総合スコア${score > 0 ? "+" : ""}${score}で「${bias}」、ボラ環境は「${volSignal}」。`;

  return { weekEnd: target.weekEnd, score, bias, volSignal, investors, contributions, futNet, comment };
}

/** 直近 POSITION_WINDOW 週の売り越しを累計し、投資部門別の売りポジションを推定する */
export function shortEstimate(history: WeekData[], investor: Investor): ShortEstimate {
  const recent = history.slice(-POSITION_WINDOW);
  const get = (w: WeekData, p: "call" | "put") => w.flows.find((r) => r.product === p && r.investor === investor);
  const cur = history[history.length - 1];
  const c = get(cur, "call"), p = get(cur, "put");
  const acc = (prod: "call" | "put", f: (r: FlowRow) => number) => sum(recent.map((w) => { const r = get(w, prod); return r ? f(r) : 0; }));
  const hasValue = (prod: "call" | "put") => recent.every((w) => { const r = get(w, prod); return !r || (r.sellValue != null && r.buyValue != null); });
  return {
    callSell: c?.sell ?? 0, callBuy: c?.buy ?? 0, putSell: p?.sell ?? 0, putBuy: p?.buy ?? 0,
    estCallShort: acc("call", (r) => r.sell - r.buy),
    estPutShort: acc("put", (r) => r.sell - r.buy),
    callPremiumNet: hasValue("call") ? acc("call", (r) => (r.sellValue ?? 0) - (r.buyValue ?? 0)) : null,
    putPremiumNet: hasValue("put") ? acc("put", (r) => (r.sellValue ?? 0) - (r.buyValue ?? 0)) : null,
  };
}
