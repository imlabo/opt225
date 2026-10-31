/**
 * 予測モデルの自動改善(毎日の答え合わせの後に GitHub Actions で実行)。
 *
 * 検証済みの判断を「その日より前のデータだけで学習 → その日を予測」で順に再現するウォークフォワード検証で、
 * 次の候補を比べ、成績(対数損失)が今の設定より十分良いものに切り替える。
 *  - 正則化の強さ(リッジ): 事前仮説にどれだけ寄せるか
 *  - 特徴量グループの使用/不使用: 効いていないグループは外す
 *  - 方向を明示するしきい値: 上昇確率が何%以上(以下)なら買い(売り)と言うか(実績の損益で選ぶ)
 * サンプルが少ないうちは過剰適合を避けるため、件数と改善幅の条件を満たすまで切り替えない。
 */
import { CALL_THRESHOLD, FEATURES, FEATURE_LABEL, ICHI_FEATURES, PRIOR, RIDGE, SQ_FEATURES, fit, predictProb, type FeatureName, type Features, type Weights } from "./model";

export const GROUPS = {
  options: { label: "オプション建玉(苦痛価格・P/C・IV・スキュー・壁・先物)", features: ["pain", "dPcr", "dIv", "skew", "wallPos", "basis"] },
  flow: { label: "週次の部門別フロー", features: ["weekly"] },
  momentum: { label: "前日比の勢い", features: ["momentum"] },
  sentiment: { label: "Fear & Greed", features: ["fgNikkei", "fgCnn"] },
  ichimoku: { label: "一目均衡表", features: [...ICHI_FEATURES] },
  squeeze: { label: "踏み上げ恐怖指数", features: [...SQ_FEATURES] },
} as const satisfies Record<string, { label: string; features: readonly FeatureName[] }>;
export type Group = keyof typeof GROUPS;
export const GROUP_KEYS = Object.keys(GROUPS) as Group[];

export interface ModelConfig {
  ridge: number;
  off: Group[]; // 使わない特徴量グループ
  threshold: number;
  since?: string; // この設定にした日
  reason?: string;
}
export const DEFAULT_CONFIG: ModelConfig = { ridge: RIDGE, off: [], threshold: CALL_THRESHOLD };

/** 表示用のラベル(一目均衡表は画面に出さないため除外の表記からも省く) */
export const configLabel = (c: Pick<ModelConfig, "ridge" | "off">) => {
  const off = c.off.filter((g) => g !== "ichimoku");
  return `リッジ${c.ridge}${off.length ? `・${off.map((g) => GROUPS[g].label.replace(/\(.*\)/, "")).join("/")}を除外` : "・全特徴量"}`;
};
const sameModel = (a: Pick<ModelConfig, "ridge" | "off">, b: Pick<ModelConfig, "ridge" | "off">) =>
  a.ridge === b.ridge && [...a.off].sort().join() === [...b.off].sort().join();

/** 使わないグループの特徴量を 0 にする(重みは事前仮説のまま、寄与は 0) */
export function mask(x: Features, off: Group[]): Features {
  if (!off.length) return x;
  const y = { ...x };
  for (const g of off) for (const f of GROUPS[g].features) y[f as FeatureName] = 0;
  return y;
}

export interface Sample { date: string; x: Features; y: 0 | 1; ret: number } // ret = 翌営業日の変化率

export interface WfResult { n: number; logloss: number; brier: number; probs: number[] }

/** ウォークフォワード: 各サンプルをそれより前のサンプルだけで学習したモデルで予測 */
export function walkForward(samples: Sample[], cfg: Pick<ModelConfig, "ridge" | "off">, prior: Weights): WfResult {
  const n = samples.length;
  const step = Math.max(1, Math.floor(n / 40)); // 件数が多いときは数件ごとに再学習
  const xs = samples.map((s) => ({ x: mask(s.x, cfg.off), y: s.y }));
  let w = prior;
  const probs: number[] = [];
  let ll = 0, br = 0;
  for (let t = 0; t < n; t++) {
    if (t > 0 && t % step === 0) w = fit(xs.slice(0, t), prior, cfg.ridge);
    const p = Math.min(1 - 1e-6, Math.max(1e-6, predictProb(w, xs[t].x)));
    probs.push(p);
    ll += -(xs[t].y ? Math.log(p) : Math.log(1 - p));
    br += (p - xs[t].y) ** 2;
  }
  return { n, logloss: n ? ll / n : Math.log(2), brier: n ? br / n : 0.25, probs };
}

/** しきい値ごとの成績: 明示した日の方向的中率と、1 日あたりの損益(変化率、方向どおりなら +|変化|) */
export function thresholdStats(samples: Sample[], probs: number[], th: number) {
  let calls = 0, hits = 0, pnl = 0;
  samples.forEach((s, i) => {
    const p = probs[i];
    const call = p >= th ? 1 : p <= 1 - th ? -1 : 0;
    if (!call) return;
    calls++;
    if ((call > 0) === (s.y === 1)) hits++;
    pnl += call * s.ret;
  });
  return { threshold: th, calls, hits, hitRate: calls ? hits / calls : null, pnlPerDay: samples.length ? pnl / samples.length : 0 };
}

export interface Candidate { label: string; ridge: number; off: Group[]; logloss: number; brier: number; hitRate: number | null; calls: number }

export interface TuningReport {
  date: string;
  n: number;
  current: Candidate;
  chosen: Candidate & { threshold: number };
  changed: boolean;
  note: string;
  candidates: Candidate[]; // 成績上位
  thresholds: ReturnType<typeof thresholdStats>[];
  groups: { group: Group; label: string; delta: number }[]; // 外したときの対数損失の変化(+ = そのグループが役に立っている)
  features: { feature: FeatureName; label: string; n: number; hitRate: number | null }[]; // 特徴量の符号どおりに動いた割合
}

export const MIN_SAMPLES = 10; // これ未満は切り替えない
export const MIN_SAMPLES_THRESHOLD = 20;
export const MIN_GAIN = 0.004; // 対数損失の改善がこれ未満なら切り替えない(ノイズ対策)
const RIDGES = [1, 4, 16, 64];
const THRESHOLDS = [0.52, 0.55, 0.58, 0.6];

export function tune(samples: Sample[], prior: Weights, current: ModelConfig, date: string): { config: ModelConfig; report: TuningReport } {
  const evalCfg = (ridge: number, off: Group[]): Candidate & { probs: number[] } => {
    const r = walkForward(samples, { ridge, off }, prior);
    const ts = thresholdStats(samples, r.probs, current.threshold);
    return { label: configLabel({ ridge, off }), ridge, off, logloss: r.logloss, brier: r.brier, hitRate: ts.hitRate, calls: ts.calls, probs: r.probs };
  };
  const seen = new Map<string, Candidate & { probs: number[] }>();
  const run = (ridge: number, off: Group[]) => {
    const key = `${ridge}|${[...off].sort().join()}`;
    if (!seen.has(key)) seen.set(key, evalCfg(ridge, [...off].sort()));
    return seen.get(key)!;
  };
  const cur = run(current.ridge, current.off);
  // 1) リッジ × (全部 / 1 グループ外す) 2) 最良から更にもう 1 グループ外す
  for (const r of RIDGES) {
    run(r, []);
    for (const g of GROUP_KEYS) run(r, [g]);
  }
  let best = [...seen.values()].sort((a, b) => a.logloss - b.logloss)[0];
  for (const g of GROUP_KEYS) if (!best.off.includes(g) && best.off.length < GROUP_KEYS.length - 1) run(best.ridge, [...best.off, g]);
  for (const r of RIDGES) run(r, current.off);
  const all = [...seen.values()].sort((a, b) => a.logloss - b.logloss);
  best = all[0];

  // 切り替え判定
  const n = samples.length;
  let model: Candidate & { probs: number[] } = cur;
  let note: string;
  if (n < MIN_SAMPLES) note = `検証済みが${n}件で、${MIN_SAMPLES}件たまるまでは設定を変えずに様子を見ます`;
  else if (sameModel(best, current)) note = "今の設定が最も成績が良いため据え置き";
  else if (cur.logloss - best.logloss < MIN_GAIN) note = `より良い候補(${best.label})はあるが改善幅 ${(cur.logloss - best.logloss).toFixed(4)} が小さく、偶然の範囲として据え置き`;
  else { model = best; note = `「${best.label}」に切り替え(対数損失 ${cur.logloss.toFixed(4)} → ${best.logloss.toFixed(4)})`; }

  // しきい値: 実績の損益(1 日あたり)で選ぶ。明示が 3 割未満になるしきい値は除外
  const thresholds = THRESHOLDS.map((th) => thresholdStats(samples, model.probs, th));
  let threshold = current.threshold;
  if (n >= MIN_SAMPLES_THRESHOLD) {
    const ok = thresholds.filter((t) => t.calls >= n * 0.3);
    const bestTh = ok.sort((a, b) => b.pnlPerDay - a.pnlPerDay)[0];
    const curTh = thresholdStats(samples, model.probs, current.threshold);
    if (bestTh && bestTh.threshold !== current.threshold && bestTh.pnlPerDay - curTh.pnlPerDay > 0.0002) {
      threshold = bestTh.threshold;
      note += `。方向を明示するしきい値を ${Math.round(current.threshold * 100)}% → ${Math.round(threshold * 100)}% に変更`;
    }
  }

  const changed = model !== cur || threshold !== current.threshold;
  const config: ModelConfig = changed
    ? { ridge: model.ridge, off: model.off, threshold, since: date, reason: note }
    : { ...current };

  // グループごとの貢献(外したときの悪化幅)と、特徴量単体の当たり方
  const base = run(model.ridge, model.off.filter(() => true));
  const groups = GROUP_KEYS.map((g) => {
    const off = model.off.includes(g) ? model.off.filter((x) => x !== g) : [...model.off, g];
    const alt = run(model.ridge, off);
    const delta = model.off.includes(g) ? base.logloss - alt.logloss : alt.logloss - base.logloss;
    return { group: g, label: GROUPS[g].label, delta };
  });
  const features = FEATURES.map((f) => {
    let k = 0, h = 0;
    for (const s of samples) {
      const v = s.x[f] ?? 0;
      if (Math.abs(v) < 0.05) continue;
      k++;
      if ((v > 0) === (s.y === 1)) h++;
    }
    return { feature: f, label: FEATURE_LABEL[f], n: k, hitRate: k ? h / k : null };
  });
  const strip = ({ probs: _p, ...c }: Candidate & { probs: number[] }) => c;
  return {
    config,
    report: {
      date, n, current: strip(cur), chosen: { ...strip(model), threshold }, changed, note,
      candidates: all.slice(0, 6).map(strip), thresholds, groups, features,
    },
  };
}

/** 事前仮説: 既定の PRIOR に一目のバックテスト由来の重みを重ねたもの */
export const priorWith = (ichiPrior: Record<string, number> = {}): Weights => ({ ...PRIOR, ...ichiPrior }) as Weights;
