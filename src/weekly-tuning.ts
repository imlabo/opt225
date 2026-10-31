/**
 * 週次スコアの答え合わせと重みの自己補正。
 *
 * 週次データ(週末 F の売買)は翌週木曜 15:00 頃に公表され、サイトは 16:30 に取り込む。
 * そのため「公表日の終値 → 翌週の公表日の終値」の日経平均の変化を、その週のスコアの予想対象とみなす。
 * 検証済みの週がたまったら、各部門の z スコアを説明変数、翌週の上昇/下落を目的変数とするリッジ付き
 * ロジスティック回帰で重みを学習し(事前仮説 = WEEKLY_PRIOR に寄せる)、週次スコアの重みに使う。
 */
import type { Investor } from "./types";
import { INVESTORS, INVESTOR_LABEL } from "./types";
import { fitLogistic, sigmoid } from "./model";

export type WeeklyWeights = Record<Investor, number>;
/** 事前仮説: 個人 = 逆張り、法人 = 順張り、海外 = 弱い順張り、証券・自己 = 中立 */
export const WEEKLY_PRIOR: WeeklyWeights = { individual: -0.45, corporate: 0.35, foreign: 0.2, securities: 0, proprietary: 0 };
export const WEEKLY_RIDGE = 2; // 週は件数が少ないので事前仮説への引き戻しは強め
export const WEEKLY_MIN_SAMPLES = 8; // これ未満は事前仮説のまま
export const WEEKLY_MIN_GAIN = 0.01; // ウォークフォワードの対数損失がこれ以上改善しないと切り替えない

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** 週次スコア(−100..100): 重み × z(±3 で打ち止め)の合計を重みの絶対値合計で割る */
export function weeklyScore(weights: WeeklyWeights, z: Partial<Record<Investor, number>>): number {
  const denom = sum(INVESTORS.map((i) => Math.abs(weights[i] ?? 0))) || 1;
  const s = sum(INVESTORS.map((i) => (weights[i] ?? 0) * clamp(z[i] ?? 0, -3, 3) * (100 / 3)));
  return Math.round(clamp(s / denom, -100, 100));
}

export interface WeeklySample {
  weekEnd: string; // データの週末
  z: Record<Investor, number>;
  score: number; bias: string; // 当時表示したスコア
  from: string; to: string; c0: number; c1: number; // 評価区間(公表日の終値 → 翌週の公表日の終値)
  ret: number; y: 0 | 1;
}

export interface Point { date: string; value: number }

/** 週末 F の翌週木曜(F+6 日)以降で最初の取引日 */
function publishIndex(prices: Point[], weekEnd: string, offsetDays: number): number {
  const target = new Date(Date.parse(weekEnd) + offsetDays * 864e5).toISOString().slice(0, 10);
  return prices.findIndex((p) => p.date >= target);
}

/** 週次分析(古い順)と日経平均の日次終値から、答え合わせできる週を並べる */
export function weeklyOutcomes(analyses: { weekEnd: string; score: number; bias: string; investors: { investor: Investor; z: number }[] }[], prices: Point[]): WeeklySample[] {
  const out: WeeklySample[] = [];
  for (const a of analyses) {
    const i0 = publishIndex(prices, a.weekEnd, 6), i1 = publishIndex(prices, a.weekEnd, 13);
    if (i0 < 0 || i1 < 0 || i1 <= i0) continue;
    const z = Object.fromEntries(INVESTORS.map((i) => [i, a.investors.find((m) => m.investor === i)?.z ?? 0])) as Record<Investor, number>;
    const c0 = prices[i0].value, c1 = prices[i1].value;
    out.push({ weekEnd: a.weekEnd, z, score: a.score, bias: a.bias, from: prices[i0].date, to: prices[i1].date, c0, c1, ret: c1 / c0 - 1, y: c1 > c0 ? 1 : 0 });
  }
  return out;
}

const row = (s: WeeklySample) => INVESTORS.map((i) => clamp(s.z[i], -3, 3));

export function fitWeekly(samples: WeeklySample[], prior: WeeklyWeights = WEEKLY_PRIOR, ridge = WEEKLY_RIDGE): WeeklyWeights {
  const w0 = [0, ...INVESTORS.map((i) => prior[i])];
  const w = fitLogistic(samples.map((s) => [1, ...row(s)]), samples.map((s) => s.y), w0, ridge);
  return Object.fromEntries(INVESTORS.map((inv, k) => [inv, w[k + 1]])) as WeeklyWeights;
}

export interface WeeklyReport {
  date: string;
  n: number;
  prior: WeeklyWeights;
  weights: WeeklyWeights; // 採用した重み
  changed: boolean;
  note: string;
  shown: { calls: number; hits: number; hitRate: number | null }; // 当時表示したスコアの的中(|score| >= 15 のみ)
  walkForward: { logloss: number; calls: number; hits: number; hitRate: number | null }; // 学習込み(その週より前だけで学習)
  priorOnly: { logloss: number; calls: number; hits: number; hitRate: number | null };
  upRate: number | null;
  investors: { investor: Investor; label: string; n: number; upWhenPositive: number | null }[]; // z > 0 の週に翌週上がった割合
  samples: WeeklySample[];
}

function evalProbs(samples: WeeklySample[], wf: (i: number) => WeeklyWeights) {
  let ll = 0, calls = 0, hits = 0;
  samples.forEach((s, i) => {
    const w = wf(i);
    const sc = weeklyScore(w, s.z);
    // 確率は重み×z のロジスティック(スコアとは別に対数損失用)
    const zsum = sum(INVESTORS.map((inv) => (w[inv] ?? 0) * clamp(s.z[inv], -3, 3)));
    const p = Math.min(1 - 1e-6, Math.max(1e-6, sigmoid(zsum)));
    ll += -(s.y ? Math.log(p) : Math.log(1 - p));
    if (Math.abs(sc) >= 15) { calls++; if ((sc > 0) === (s.y === 1)) hits++; }
  });
  const n = samples.length;
  return { logloss: n ? ll / n : Math.log(2), calls, hits, hitRate: calls ? hits / calls : null };
}

export function tuneWeekly(samples: WeeklySample[], current: WeeklyWeights, date: string, prior = WEEKLY_PRIOR, ridge = WEEKLY_RIDGE): { weights: WeeklyWeights; report: WeeklyReport } {
  const n = samples.length;
  const priorOnly = evalProbs(samples, () => prior);
  const walkForward = evalProbs(samples, (i) => (i >= WEEKLY_MIN_SAMPLES ? fitWeekly(samples.slice(0, i), prior, ridge) : prior));
  let weights = current, changed = false, note: string;
  if (n < WEEKLY_MIN_SAMPLES) note = `答え合わせできた週が${n}週で、${WEEKLY_MIN_SAMPLES}週たまるまでは仮説の重みのまま`;
  else if (priorOnly.logloss - walkForward.logloss < WEEKLY_MIN_GAIN && !changedFrom(current, prior)) note = `学習しても仮説より十分良くならない(対数損失 ${priorOnly.logloss.toFixed(3)} → ${walkForward.logloss.toFixed(3)})ため仮説の重みのまま`;
  else {
    const fitted = fitWeekly(samples, prior, ridge);
    changed = changedFrom(fitted, current);
    weights = fitted;
    note = changed
      ? `検証済み${n}週で学習した重みに更新(${INVESTORS.filter((i) => Math.abs(fitted[i] - current[i]) >= 0.02).map((i) => `${INVESTOR_LABEL[i]} ${current[i].toFixed(2)}→${fitted[i].toFixed(2)}`).join("、") || "微調整"})`
      : `検証済み${n}週で再学習。重みは前回とほぼ同じ`;
  }
  const shownCalls = samples.filter((s) => Math.abs(s.score) >= 15);
  const shownHits = shownCalls.filter((s) => (s.score > 0) === (s.y === 1)).length;
  const investors = INVESTORS.map((inv) => {
    const pos = samples.filter((s) => s.z[inv] > 0.25), neg = samples.filter((s) => s.z[inv] < -0.25);
    const k = pos.length + neg.length;
    return { investor: inv, label: INVESTOR_LABEL[inv], n: k, upWhenPositive: pos.length ? pos.filter((s) => s.y).length / pos.length : null };
  });
  return {
    weights,
    report: {
      date, n, prior, weights, changed, note,
      shown: { calls: shownCalls.length, hits: shownHits, hitRate: shownCalls.length ? shownHits / shownCalls.length : null },
      walkForward, priorOnly, upRate: n ? samples.filter((s) => s.y).length / n : null, investors, samples: samples.slice(-26),
    },
  };
}

const changedFrom = (a: WeeklyWeights, b: WeeklyWeights) => INVESTORS.some((i) => Math.abs((a[i] ?? 0) - (b[i] ?? 0)) >= 0.005);
