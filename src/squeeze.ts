/**
 * 踏み上げ恐怖指数: オプション売り手が「踏まれる」恐怖を、プット売り手(下落で踏まれる)と
 * コール売り手(上昇で踏まれる)の別に 0〜100 で表す。50 = 平常、高いほど恐怖。
 *
 * 要素(期近限月、x は「大きいほど恐怖」に向きをそろえた標準化値。±1 で目立つ水準):
 *  dist  損益分岐までの距離: 現値から売り手全体の損益分岐までが SQ までの 1σ の何倍か。1.5σ を平常とし、近いほど恐怖
 *  loss  含み損: 建玉全体の時価(= 売り手の負債)の前日比。15% 増で x = 1
 *  near  現値近辺の建玉: 現値から 1σ 以内(踏まれる側)にある建玉の比率。20% を平常、10pt 増で x = 1
 *  vol   ボラ追い打ち: ATM IV とスキューの前日比。プット側は IV + スキュー、コール側は IV − スキュー、2pt で x = 1
 *  cover 買い戻しの痕跡: 踏まれる方向に動いた日に、現値近辺の建玉が減った割合(損切りの買い戻し)。3% 減で x = 1
 *
 * 点数: 各要素の過去 60 日以上の履歴がたまるまでは 50 + 50·tanh(x)、たまったら過去(最大 250 日)の中での
 * パーセンタイル。指数は使える要素の平均。
 */
import type { DailyAnalysis, DailyStrike } from "./daily";

export const SQ_KEYS = ["dist", "loss", "near", "vol", "cover"] as const;
export type SqKey = (typeof SQ_KEYS)[number];
export type Side = "put" | "call";
export const SQ_LABEL: Record<SqKey, string> = {
  dist: "損益分岐までの距離",
  loss: "含み損(建玉時価の前日比)",
  near: "現値近辺の建玉",
  vol: "ボラ追い打ち(IV・スキュー)",
  cover: "買い戻しの痕跡",
};

export interface CompVal { value: number; x: number }
export interface SqueezeRaw { date: string; spot: number; put: Partial<Record<SqKey, CompVal>>; call: Partial<Record<SqKey, CompVal>> }
export interface SqueezeHist extends SqueezeRaw { putIndex: number; callIndex: number }

export interface SqueezeSide {
  index: number;
  rating: string;
  comps: Partial<Record<SqKey, CompVal & { score: number; mode: "fixed" | "percentile" }>>;
}
export interface Squeeze { put: SqueezeSide; call: SqueezeSide }

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** 期近の行使価格別建玉(rows)と当日・前日の分析から各要素の生値を出す */
export function squeezeRaw(a: DailyAnalysis, prev: DailyAnalysis | undefined, rows: DailyStrike[]): SqueezeRaw {
  const out: SqueezeRaw = { date: a.tradeDate, spot: a.spot, put: {}, call: {} };
  const em = a.expectedMove ?? a.spot * 0.04;
  const S = a.spot;
  const samePrev = prev && prev.front.month === a.front.month ? prev : undefined;

  // dist
  const dPut = a.seller?.putBreakeven != null ? (S - a.seller.putBreakeven) / em : 4;
  const dCall = a.seller?.callBreakeven != null ? (a.seller.callBreakeven - S) / em : 4;
  out.put.dist = { value: dPut, x: (1.5 - dPut) / 0.75 };
  out.call.dist = { value: dCall, x: (1.5 - dCall) / 0.75 };

  // loss
  if (samePrev?.seller && a.seller) {
    if (samePrev.seller.putPremium > 0) { const r = a.seller.putPremium / samePrev.seller.putPremium - 1; out.put.loss = { value: r, x: r / 0.15 }; }
    if (samePrev.seller.callPremium > 0) { const r = a.seller.callPremium / samePrev.seller.callPremium - 1; out.call.loss = { value: r, x: r / 0.15 }; }
  }

  // near
  const putAll = sum(rows.map((r) => r.putOi ?? 0)), callAll = sum(rows.map((r) => r.callOi ?? 0));
  const nearPut = rows.filter((r) => r.strike >= S - em && r.strike <= S + 0.25 * em);
  const nearCall = rows.filter((r) => r.strike >= S - 0.25 * em && r.strike <= S + em);
  const nPut = sum(nearPut.map((r) => r.putOi ?? 0)), nCall = sum(nearCall.map((r) => r.callOi ?? 0));
  if (putAll > 0) { const s = nPut / putAll; out.put.near = { value: s, x: (s - 0.2) / 0.1 }; }
  if (callAll > 0) { const s = nCall / callAll; out.call.near = { value: s, x: (s - 0.2) / 0.1 }; }

  // vol
  if (prev && ok(a.atmIv) && ok(prev.atmIv)) {
    const dIv = a.atmIv - prev.atmIv;
    const dSk = ok(a.skew) && ok(prev.skew) ? a.skew - prev.skew : 0;
    out.put.vol = { value: dIv + dSk, x: (dIv + dSk) / 2 };
    out.call.vol = { value: dIv - dSk, x: (dIv - dSk) / 2 };
  }

  // cover: 踏まれる方向に動いた日の、現値 ±1σ の建玉の減少率
  if (prev && prev.spot > 0) {
    const move = S / prev.spot - 1;
    const band = rows.filter((r) => Math.abs(r.strike - S) <= em);
    const pOi = sum(band.map((r) => r.putOi ?? 0)), cOi = sum(band.map((r) => r.callOi ?? 0));
    const pChg = sum(band.map((r) => r.putChg ?? 0)), cChg = sum(band.map((r) => r.callChg ?? 0));
    const putCover = move < 0 && pOi - pChg > 0 ? -pChg / (pOi - pChg) : 0; // 前日建玉比
    const callCover = move > 0 && cOi - cChg > 0 ? -cChg / (cOi - cChg) : 0;
    out.put.cover = { value: putCover, x: putCover / 0.03 };
    out.call.cover = { value: callCover, x: callCover / 0.03 };
  }
  return out;
}

export const MIN_HISTORY = 60;
const WINDOW = 250;

export function ratingOf(v: number): string {
  if (v >= 75) return "パニック";
  if (v >= 60) return "警戒";
  if (v > 40) return "平常";
  if (v > 25) return "落ち着き";
  return "楽観";
}

function percentile(x: number, pop: number[]): number {
  let below = 0, eq = 0;
  for (const v of pop) { if (v < x) below++; else if (v === x) eq++; }
  return ((below + eq / 2) / pop.length) * 100;
}

/** 生値を点数化。hist は当日より前の履歴(古い順) */
export function squeezeScore(raw: SqueezeRaw, hist: SqueezeRaw[]): Squeeze {
  const side = (s: Side): SqueezeSide => {
    const comps: SqueezeSide["comps"] = {};
    for (const k of SQ_KEYS) {
      const c = raw[s][k];
      if (!c || !Number.isFinite(c.x)) continue;
      const pop = hist.slice(-WINDOW).map((h) => h[s][k]?.x).filter((v): v is number => v != null && Number.isFinite(v));
      comps[k] = pop.length >= MIN_HISTORY
        ? { ...c, score: percentile(c.x, pop), mode: "percentile" }
        : { ...c, score: 50 + 50 * Math.tanh(c.x), mode: "fixed" };
    }
    const scores = Object.values(comps).map((c) => c!.score);
    const index = scores.length ? sum(scores) / scores.length : 50;
    return { index, rating: ratingOf(index), comps };
  };
  return { put: side("put"), call: side("call") };
}

/** 履歴に当日分を入れ替えて追加(古い順・最大 300 件) */
export function upsertHist(hist: SqueezeHist[], raw: SqueezeRaw, sq: Squeeze): SqueezeHist[] {
  return [...hist.filter((h) => h.date !== raw.date), { ...raw, putIndex: sq.put.index, callIndex: sq.call.index }]
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-300);
}
