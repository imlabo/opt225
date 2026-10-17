/**
 * 翌営業日の方向予測と、その答え合わせによる自己補正。
 *
 * - 予測: 日次指標(+最新の週次スコア)を特徴量とするロジスティック回帰で「翌営業日に日経平均が上がる確率」を出す。
 * - 検証: 次の営業日のデータが届いたら、実際の終値(原資産価格)で的中/外れを記録する。
 * - 補正: 検証済みの全サンプルで重みを毎回フィットし直す。重みは事前仮説 PRIOR に向けた
 *   L2 正則化(リッジ)付きなので、サンプルが少ないうちは仮説どおり、増えるほど実績に合わせて修正される。
 * - レンジ: 1日の 1σ(ATM IV ベース)× 係数 k。実績で 1σ 内に収まる割合が 68% になるよう k を較正する。
 */
import type { DailyAnalysis } from "./daily";

export const FEATURES = ["pain", "dPcr", "dIv", "skew", "wallPos", "basis", "weekly", "momentum"] as const;
export type FeatureName = (typeof FEATURES)[number];
export type Features = Record<FeatureName, number>;

export const FEATURE_LABEL: Record<FeatureName, string> = {
  pain: "最大苦痛価格への引力",
  dPcr: "P/C建玉比の変化",
  dIv: "ATM IV の変化",
  skew: "プット偏重スキュー",
  wallPos: "壁の間の位置(上寄り)",
  basis: "先物プレミアム",
  weekly: "週次スコア(個人・法人)",
  momentum: "前日比の勢い",
};

/** 事前仮説(学習前の重み)。切片 + 各特徴量 */
export const PRIOR: { bias: number } & Features = {
  bias: 0,
  pain: 0.3, // 最大苦痛価格の方向へ引き寄せられる(SQ 接近で強い)
  dPcr: 0,
  dIv: -0.15, // IV 上昇は下落と同時に起きやすい
  skew: 0,
  wallPos: -0.2, // 上の壁に近いほど上値が重い
  basis: 0,
  weekly: 0.3, // 週次スコアの方向
  momentum: 0,
};
export const RIDGE = 4; // 事前仮説への引き戻しの強さ
export const TRADING_DAYS = 245;
export const CALL_THRESHOLD = 0.55; // 上昇確率がこれ以上/1−これ以下なら方向を明示

const clip = (x: number, a = 3) => Math.max(-a, Math.min(a, Number.isFinite(x) ? x : 0));
export const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** 1 営業日の 1σ 変動幅(円) */
export const oneDaySigma = (a: DailyAnalysis) => (a.atmIv ? a.spot * (a.atmIv / 100) * Math.sqrt(1 / TRADING_DAYS) : a.spot * 0.012);

export function features(a: DailyAnalysis, weeklyScore: number | null): Features {
  const em = a.expectedMove || a.spot * 0.05;
  const gravity = a.front.days <= 10 ? 1 : 0.3;
  const span = a.putWall && a.callWall ? a.callWall.strike - a.putWall.strike : 0;
  return {
    pain: clip(a.maxPain ? ((a.maxPain - a.spot) / em) * gravity : 0),
    dPcr: clip(a.prev ? (a.pcr - a.prev.pcr) / 0.1 : 0),
    dIv: clip(a.prev?.atmIv != null && a.atmIv != null ? a.atmIv - a.prev.atmIv : 0),
    skew: clip(a.skew != null ? (a.skew - 4) / 2 : 0),
    wallPos: clip(span > 0 ? ((a.spot - a.putWall!.strike) / span - 0.5) * 2 : 0),
    basis: clip(a.fut ? ((a.fut.price - a.spot) / a.spot) * 100 : 0),
    weekly: clip(weeklyScore != null ? weeklyScore / 100 : 0, 1),
    momentum: clip(a.prev ? (a.spot - a.prev.spot) / oneDaySigma(a) : 0),
  };
}

export type Weights = typeof PRIOR;
const vec = (w: Weights) => [w.bias, ...FEATURES.map((f) => w[f])];
const unvec = (v: number[]): Weights => Object.fromEntries([["bias", v[0]], ...FEATURES.map((f, i) => [f, v[i + 1]])]) as Weights;
const row = (x: Features) => [1, ...FEATURES.map((f) => x[f])];

export function predictProb(w: Weights, x: Features): number {
  const v = vec(w), r = row(x);
  return sigmoid(v.reduce((s, wi, i) => s + wi * r[i], 0));
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || M[c][c] === 0) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => (r[i] === 0 ? 0 : r[n] / r[i]));
}

/** リッジ付きロジスティック回帰(ニュートン法)。y=1 は上昇 */
export function fit(samples: { x: Features; y: 0 | 1 }[], prior: Weights = PRIOR, ridge = RIDGE): Weights {
  const w0 = vec(prior);
  let w = [...w0];
  const d = w.length;
  for (let it = 0; it < 25; it++) {
    const g = w.map((wi, i) => ridge * (wi - w0[i]));
    const H = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => (i === j ? ridge : 0)));
    for (const s of samples) {
      const r = row(s.x);
      const p = sigmoid(r.reduce((acc, ri, i) => acc + ri * w[i], 0));
      for (let i = 0; i < d; i++) {
        g[i] += (p - s.y) * r[i];
        for (let j = 0; j < d; j++) H[i][j] += p * (1 - p) * r[i] * r[j];
      }
    }
    const step = solve(H, g);
    w = w.map((wi, i) => wi - step[i]);
    if (Math.max(...step.map(Math.abs)) < 1e-6) break;
  }
  return unvec(w);
}

/** |実際の変動| / 1σ の分布から、68% が収まる係数 k を推定(サンプルが少ないうちは 1 に寄せる) */
export function calibrateK(ratios: number[]): number {
  if (!ratios.length) return 1;
  const s = [...ratios].sort((a, b) => a - b);
  const q = s[Math.min(s.length - 1, Math.floor(0.68 * s.length))];
  const n = s.length, shrink = n / (n + 20);
  return Math.max(0.5, Math.min(2.5, shrink * q + (1 - shrink) * 1));
}

export interface Prediction {
  tradeDate: string;
  spot: number;
  pUp: number;
  call: "up" | "down" | "flat";
  rangeLo: number;
  rangeHi: number;
  sigma1d: number;
  k: number;
  x: Features;
  contributions: { feature: FeatureName; label: string; value: number }[];
  modelN: number; // 学習に使った検証済みサンプル数
}

export function makePrediction(a: DailyAnalysis, x: Features, w: Weights, k: number, modelN: number): Prediction {
  const pUp = predictProb(w, x);
  const sigma1d = oneDaySigma(a);
  return {
    tradeDate: a.tradeDate, spot: a.spot, pUp,
    call: pUp >= CALL_THRESHOLD ? "up" : pUp <= 1 - CALL_THRESHOLD ? "down" : "flat",
    rangeLo: a.spot - k * sigma1d, rangeHi: a.spot + k * sigma1d, sigma1d, k, x,
    contributions: FEATURES.map((f) => ({ feature: f, label: FEATURE_LABEL[f], value: w[f] * x[f] }))
      .sort((p, q) => Math.abs(q.value) - Math.abs(p.value)),
    modelN,
  };
}

export interface Evaluated {
  tradeDate: string; pUp: number; call: Prediction["call"];
  spot: number; actualSpot: number; rangeLo: number; rangeHi: number; sigma1d: number;
}

export interface Metrics {
  n: number; // 検証済み
  calls: number; // 方向を明示した件数
  hits: number;
  hitRate: number | null; // 方向的中率(明示した件のみ)
  rangeRate: number | null; // 予想レンジ内に収まった割合
  brier: number | null; // 確率の二乗誤差(0.25 = コイン投げ)
  upRate: number | null; // 実際に上昇した割合(常に上昇と言う場合の的中率)
}

export function metrics(ev: Evaluated[]): Metrics {
  const n = ev.length;
  if (!n) return { n: 0, calls: 0, hits: 0, hitRate: null, rangeRate: null, brier: null, upRate: null };
  const up = (e: Evaluated) => (e.actualSpot > e.spot ? 1 : 0);
  const called = ev.filter((e) => e.call !== "flat");
  const hits = called.filter((e) => (e.call === "up") === (up(e) === 1)).length;
  return {
    n, calls: called.length, hits, hitRate: called.length ? hits / called.length : null,
    rangeRate: ev.filter((e) => e.actualSpot >= e.rangeLo && e.actualSpot <= e.rangeHi).length / n,
    brier: ev.reduce((s, e) => s + (e.pUp - up(e)) ** 2, 0) / n,
    upRate: ev.filter((e) => up(e) === 1).length / n,
  };
}
