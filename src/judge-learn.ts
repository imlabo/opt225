/**
 * テクニカル判定の自己改善: 判定した足のその後の値動きで「反転したか・続いたか」を答え合わせし、
 *  1) 反転・継続の確率モデル(ロジスティック回帰)を学習して、手作りの点数に混ぜる(件数が増えるほど学習側の比重を上げる、最大 70%)
 *  2) 通知した種類ごとの当たり率から、通知の厳しさを自動で上げ下げする(当たりが悪い種類ほど条件を厳しく)
 *
 * 答え合わせ: 判定した足の終値から、HORIZON 本のうちに
 *   その向きに MOVE_ATR(1.5) × ATR 進んだのが先 → 継続(con)、逆向きに MOVE_ATR × ATR 戻したのが先 → 反転(rev)、どちらもなし → none
 * 学習データ: 分足のクライマックス足(損益分岐から遠いものも含む)すべてと、実際に通知した足
 */
import { type IBar, type Tf, type VolProfile, scanClimax } from "./alerts";
import { featureVec, techAt, LEARN_MIN_N, type Judge, type JudgeModel } from "./technicals";
import { fitLogistic } from "./model";

export const HORIZON: Record<Tf, number> = { "5m": 24, "15m": 16, "60m": 10 }; // 2時間・4時間・10時間
export const MOVE_ATR = 1.5; // 小さな戻しで「当たり」にしないよう ATR 1.5 本分
export const JUDGE_VERSION = 2; // 特徴量・答え合わせの定義を変えたら上げる(古いデータは捨てて取り直す)
export const LEARN_EVERY_MS = 15 * 60 * 1000;
export const MAX_SAMPLES = 1500;
export const MAX_WATCH = 300;
export const REFIT_MS = 60 * 60 * 1000; // 学習し直しは 1 時間に 1 回まで
export const FIT_ROWS = 500; // 学習に使う直近の件数(CPU 制限のため)

/** 種類: climax = 学習用の全クライマックス足、alert-bottom/top = 通知した天井・大底候補、ほかは FollowSignal の種類 */
export interface Watch { v?: number; tf: Tf; t: number; dir: "down" | "up"; kind: string; x: number[]; cap: number; rev: number; con: number; close: number; atr: number; sent?: boolean }
export interface Sample extends Watch { y: "rev" | "con" | "none"; at: number }

/** 当たりの定義: 反転を見込む種類は rev、続伸・続落を見込む種類は con が当たり */
export const expects = (kind: string): "rev" | "con" => (kind.startsWith("break") || kind.startsWith("level-break") ? "con" : "rev");
export const category = (kind: string): keyof JudgeModel["adj"] | null =>
  kind.startsWith("alert-") ? "climax" : kind.startsWith("confirm") ? "confirm" : kind.includes("break") ? "break" : null;
export const dirOfKind = (kind: string): "down" | "up" =>
  kind === "alert-bottom" || kind === "confirm-bottom" || kind.endsWith("down") ? "down" : "up";

export function watchFrom(tf: Tf, t: number, kind: string, j: Judge | null | undefined, close: number, sent: boolean): Watch | null {
  if (!j) return null;
  return { v: JUDGE_VERSION, tf, t, dir: j.dir, kind, x: featureVec(j.tech, j.dir), cap: j.capitulation, rev: j.reversal, con: j.continuation, close, atr: j.tech.atr, sent };
}

/** 答え合わせ。まだ HORIZON 本たっていなければ null */
export function outcome(bars: IBar[], i: number, dir: "down" | "up", tf: Tf, close: number, atr: number): Sample["y"] | null {
  const up = close + MOVE_ATR * atr, dn = close - MOVE_ATR * atr;
  const after = bars.slice(i + 1, i + 1 + HORIZON[tf]);
  for (const b of after) {
    const hitUp = b.high >= up, hitDn = b.low <= dn;
    if (hitUp && hitDn) return "none";
    if (hitUp) return dir === "up" ? "con" : "rev";
    if (hitDn) return dir === "down" ? "con" : "rev";
  }
  return after.length >= HORIZON[tf] ? "none" : null;
}

const key = (w: { tf: string; t: number; dir: string; kind: string }) => `${w.tf}:${w.t}:${w.dir}:${w.kind}`;

/** 分足から、新しいクライマックス足を見張りに加え、時間のたった見張りを答え合わせする */
export function collectAndResolve(tf: Tf, bars: IBar[], profile: VolProfile | undefined, watch: Watch[], samples: Sample[], now = Date.now()): { watch: Watch[]; added: number; resolved: Sample[] } {
  const done = bars.filter((b) => b.volume > 0 && b.t * 1000 + (tf === "5m" ? 5 : tf === "15m" ? 15 : 60) * 60000 <= now);
  const idx = new Map(done.map((b, i) => [b.t, i] as const));
  const known = new Set([...watch, ...samples].map(key));
  let added = 0;
  for (const c of scanClimax(done, null, tf, profile)) {
    const dir = c.side === "bottom" ? "down" : "up";
    const k = key({ tf, t: c.t, dir, kind: "climax" });
    if (known.has(k)) continue;
    const i = idx.get(c.t)!;
    const tech = techAt(done, i, tf, profile);
    if (!tech) continue;
    watch.push({ v: JUDGE_VERSION, tf, t: c.t, dir, kind: "climax", x: featureVec(tech, dir), cap: 0, rev: 0, con: 0, close: done[i].close, atr: tech.atr });
    known.add(k); added++;
  }
  const keep: Watch[] = [], resolved: Sample[] = [];
  const first = done[0]?.t ?? 0;
  for (const w of watch) {
    if (w.tf !== tf) { keep.push(w); continue; }
    const i = idx.get(w.t);
    if (i == null) { if (w.t >= first) keep.push(w); continue; } // 窓から外れた(古すぎる)ものは捨てる
    const y = outcome(done, i, w.dir, tf, w.close, w.atr);
    if (y == null) keep.push(w);
    else resolved.push({ ...w, y, at: now });
  }
  return { watch: keep.slice(-MAX_WATCH), added, resolved };
}

/**
 * 学習: 同じ足(時間足・時刻・向き)は 1 件として、反転・継続それぞれの確率モデルを当てる。
 * 通知の厳しさ: 種類ごとの直近 30 件の当たり率が 55% を下回るほど上乗せ(5 点刻み、最大 20)。10 件未満は 0
 */
export function fitJudgeModel(samples: Sample[], now = Date.now()): JudgeModel {
  const uniq = new Map<string, Sample>();
  for (const s of samples) uniq.set(`${s.tf}:${s.t}:${s.dir}`, s);
  const data = [...uniq.values()].slice(-FIT_ROWS);
  const rows = data.map((s) => [1, ...s.x]);
  const d = rows[0]?.length ?? 14;
  const w0 = new Array(d).fill(0);
  const ridge = 2;
  const wRev = data.length >= LEARN_MIN_N ? fitLogistic(rows, data.map((s) => (s.y === "rev" ? 1 : 0)), w0, ridge) : w0;
  const wCon = data.length >= LEARN_MIN_N ? fitLogistic(rows, data.map((s) => (s.y === "con" ? 1 : 0)), w0, ridge) : w0;
  const stats: JudgeModel["stats"] = {};
  const adj: JudgeModel["adj"] = { climax: 0, confirm: 0, break: 0 };
  for (const cat of ["climax", "confirm", "break"] as const) {
    const xs = samples.filter((s) => category(s.kind) === cat).slice(-30);
    const hit = xs.filter((s) => s.y === expects(s.kind)).length;
    stats[cat] = { n: xs.length, hit };
    if (xs.length >= 10) adj[cat] = Math.max(0, Math.min(20, Math.round(((0.55 - hit / xs.length) * 100) / 5) * 5));
  }
  // 学習用クライマックス全体の、投げ度の代わりの目安(反転率)
  const cl = data.filter((s) => s.kind === "climax");
  stats.climaxAll = { n: cl.length, hit: cl.filter((s) => s.y === "rev").length };
  const cnt = (y: Sample["y"]) => data.filter((s) => s.y === y).length / (data.length || 1);
  return { v: JUDGE_VERSION, n: data.length, wRev, wCon, adj, stats, base: { rev: cnt("rev"), con: cnt("con"), none: cnt("none") }, updatedAt: now };
}

/** 今の定義のデータだけ残す */
export const current = <T extends { v?: number }>(xs: T[]) => xs.filter((x) => x.v === JUDGE_VERSION);
