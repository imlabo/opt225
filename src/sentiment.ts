/**
 * 市場心理指数。
 *  - CNN Fear & Greed Index(米国株): CNN のデータをそのまま取り込み表示する。
 *  - 日経225 Fear & Greed(本サイト独自): CNN と同じ考え方で、各指標の当日値が過去 2 年の中で
 *    どの位置にあるか(パーセンタイル)を 0〜100 に換算し、その平均を指数とする。
 */

export type Rating = "extreme fear" | "fear" | "neutral" | "greed" | "extreme greed";
export const RATING_LABEL: Record<Rating, string> = {
  "extreme fear": "極度の恐怖", fear: "恐怖", neutral: "中立", greed: "強欲", "extreme greed": "極度の強欲",
};
export function ratingOf(score: number): Rating {
  if (score < 25) return "extreme fear";
  if (score < 45) return "fear";
  if (score <= 55) return "neutral";
  if (score <= 75) return "greed";
  return "extreme greed";
}

export interface Point { date: string; value: number }

export const COMPONENTS = {
  momentum: { label: "株価の勢い(125日線乖離)", greedWhenHigh: true },
  strength: { label: "株価の強さ(52週レンジ内の位置)", greedWhenHigh: true },
  volatility: { label: "ボラティリティ(VI の50日線乖離)", greedWhenHigh: false },
  viLevel: { label: "日経平均VIの水準", greedWhenHigh: false },
  pcr: { label: "P/C建玉比(期近)", greedWhenHigh: false },
  skew: { label: "プットスキュー", greedWhenHigh: false },
} as const;
export type ComponentKey = keyof typeof COMPONENTS;

export interface FgPoint {
  date: string;
  score: number;
  rating: Rating;
  components: Partial<Record<ComponentKey, { value: number; score: number }>>;
}

const WINDOW = 500; // パーセンタイルの母集団(約2年)
const MIN_HISTORY = 120; // 価格系の最低履歴
const MIN_OWN_HISTORY = 20; // 本サイトで蓄積する P/C比・スキューの最低履歴

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** 母集団の中で x 以下の割合(0〜100) */
export function percentile(x: number, pop: number[]): number {
  if (!pop.length) return 50;
  let below = 0, equal = 0;
  for (const v of pop) { if (v < x) below++; else if (v === x) equal++; }
  return ((below + equal / 2) / pop.length) * 100;
}

/** 価格系列から派生指標の系列を作る(日付昇順) */
function derived(prices: Point[], vi: Point[]) {
  const viMap = new Map(vi.map((p) => [p.date, p.value]));
  const out: { date: string; momentum?: number; strength?: number; volatility?: number; viLevel?: number }[] = [];
  const viSeries: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const row: (typeof out)[number] = { date: p.date };
    if (i >= 124) row.momentum = p.value / mean(prices.slice(i - 124, i + 1).map((x) => x.value)) - 1;
    if (i >= 251) {
      const w = prices.slice(i - 251, i + 1).map((x) => x.value);
      const lo = Math.min(...w), hi = Math.max(...w);
      row.strength = hi > lo ? (p.value - lo) / (hi - lo) : 0.5;
    }
    const v = viMap.get(p.date);
    if (v !== undefined) {
      viSeries.push(v);
      row.viLevel = v;
      if (viSeries.length >= 50) row.volatility = v / mean(viSeries.slice(-50)) - 1;
    }
    out.push(row);
  }
  return out;
}

/**
 * 日経225 Fear & Greed の系列を計算する。
 * own: 本サイト蓄積の P/C比・スキュー(日付→値)。履歴が MIN_OWN_HISTORY 未満の間は指数に含めない。
 */
export function computeNikkeiFg(prices: Point[], vi: Point[], own: { pcr: Point[]; skew: Point[] } = { pcr: [], skew: [] }, since?: string): FgPoint[] {
  const d = derived(prices, vi);
  const hist: Record<ComponentKey, number[]> = { momentum: [], strength: [], volatility: [], viLevel: [], pcr: [], skew: [] };
  const ownMap = { pcr: new Map(own.pcr.map((p) => [p.date, p.value])), skew: new Map(own.skew.map((p) => [p.date, p.value])) };
  const result: FgPoint[] = [];
  for (const row of d) {
    const values: Partial<Record<ComponentKey, number>> = {
      momentum: row.momentum, strength: row.strength, volatility: row.volatility, viLevel: row.viLevel,
      pcr: ownMap.pcr.get(row.date), skew: ownMap.skew.get(row.date),
    };
    const components: FgPoint["components"] = {};
    for (const key of Object.keys(COMPONENTS) as ComponentKey[]) {
      const v = values[key];
      if (v === undefined || !Number.isFinite(v)) continue;
      const h = hist[key];
      h.push(v);
      if (h.length > WINDOW) h.shift();
      const need = key === "pcr" || key === "skew" ? MIN_OWN_HISTORY : MIN_HISTORY;
      if (h.length < need) continue;
      const pctl = percentile(v, h);
      components[key] = { value: v, score: COMPONENTS[key].greedWhenHigh ? pctl : 100 - pctl };
    }
    const scores = Object.values(components).map((c) => c!.score);
    if (scores.length >= 3 && (!since || row.date >= since)) {
      const score = mean(scores);
      result.push({ date: row.date, score, rating: ratingOf(score), components });
    }
  }
  return result;
}

/** 日経公式 CSV(データ日付,終値,始値,高値,安値)。Shift_JIS 想定だが数値列のみ使う */
export function parseNikkeiCsv(text: string): Point[] {
  const out: Point[] = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(",").map((s) => s.replace(/"/g, "").trim());
    const m = c[0]?.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    const v = Number(c[1]);
    if (m && Number.isFinite(v) && v > 0) out.push({ date: `${m[1]}-${m[2]}-${m[3]}`, value: v });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface CnnFg {
  date: string; score: number; rating: Rating;
  previousClose?: number; previous1Week?: number; previous1Month?: number; previous1Year?: number;
  history: Point[];
}

/** CNN の graphdata JSON から現在値と日次履歴を取り出す */
export function parseCnn(json: unknown): CnnFg {
  const j = json as {
    fear_and_greed: { score: number; rating: string; timestamp: string; previous_close?: number; previous_1_week?: number; previous_1_month?: number; previous_1_year?: number };
    fear_and_greed_historical?: { data?: { x: number; y: number }[] };
  };
  const f = j.fear_and_greed;
  if (!f || typeof f.score !== "number") throw new Error("unexpected CNN response");
  const byDate = new Map<string, number>();
  for (const p of j.fear_and_greed_historical?.data ?? []) byDate.set(new Date(p.x).toISOString().slice(0, 10), p.y);
  return {
    date: f.timestamp.slice(0, 10), score: f.score, rating: ratingOf(f.score),
    previousClose: f.previous_close, previous1Week: f.previous_1_week, previous1Month: f.previous_1_month, previous1Year: f.previous_1_year,
    history: [...byDate].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
