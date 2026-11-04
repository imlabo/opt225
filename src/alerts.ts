/**
 * 天井・大底候補アラート(Worker の Cron で 5 分ごと)。
 *
 * 日経225先物(CME NKD=F, Yahoo Finance)の 5分足・15分足・60分足で、
 *  - 出来高を伴った大きな下落足(セリング・クライマックス)が、プット売り手の損益分岐の近くで出た → 大底候補
 *  - 出来高を伴った大きな上昇足(バイイング・クライマックス)が、コール売り手の損益分岐の近くで出た → 天井候補
 * を検出し、メール(Resend)で通知する。同じ時間足・同じ向きのアラートは一定時間(COOLDOWN_MIN)あけて再通知。
 *
 * 判定(直近の確定足 1 本):
 *   出来高 ≥ VOL_MULT × 直近 LOOKBACK 本の平均出来高
 *   値幅(高値−安値) ≥ RANGE_MULT × 直近 LOOKBACK 本の平均値幅、かつ終値が足の下 1/3(上昇なら上 1/3)
 *   損益分岐(先物換算 = 日経平均ベースの損益分岐 + ベーシス)との距離 ≤ LEVEL_PCT、または足がその水準をまたいだ
 */
import type { DailyAnalysis, DailyStrike } from "./daily";

export const TIMEFRAMES = [
  { tf: "5m", label: "5分足", range: "2d" },
  { tf: "15m", label: "15分足", range: "5d" },
  { tf: "60m", label: "60分足", range: "1mo" },
] as const;
export type Tf = (typeof TIMEFRAMES)[number]["tf"];

export const VOL_MULT = 2.0;
export const RANGE_MULT = 1.5;
export const LEVEL_PCT = 0.008; // 損益分岐との距離 0.8% 以内
export const LOOKBACK = 20;
export const COOLDOWN_MIN = 120;
export const SYMBOL = "NKD=F";

export interface IBar { t: number; open: number; high: number; low: number; close: number; volume: number }

export function parseIntraday(json: unknown): IBar[] {
  const r = (json as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] } }[]; error?: { description?: string } } }).chart;
  if (r?.error) throw new Error(`Yahoo: ${r.error.description ?? "error"}`);
  const res = r?.result?.[0], q = res?.indicators?.quote?.[0];
  if (!res?.timestamp || !q) throw new Error("Yahoo: unexpected response");
  const out: IBar[] = [];
  res.timestamp.forEach((t, i) => {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i], v = q.volume?.[i];
    if (o == null || h == null || l == null || c == null || !(h > 0) || !(l > 0)) return;
    out.push({ t, open: o, high: h, low: l, close: c, volume: v ?? 0 });
  });
  return out;
}

export interface Levels { putLevel: number | null; callLevel: number | null; basis: number; tradeDate: string; putBreakeven: number | null; callBreakeven: number | null }

/** 最新の日次分析から先物換算の損益分岐を取る */
export function levelsFrom(a: DailyAnalysis | undefined): Levels | null {
  if (!a?.seller) return null;
  const basis = a.fut ? a.fut.price - a.spot : 0;
  return {
    tradeDate: a.tradeDate, basis,
    putBreakeven: a.seller.putBreakeven, callBreakeven: a.seller.callBreakeven,
    putLevel: a.seller.putBreakeven != null ? a.seller.putBreakeven + basis : null,
    callLevel: a.seller.callBreakeven != null ? a.seller.callBreakeven + basis : null,
  };
}

export interface Signal {
  tf: Tf; label: string;
  side: "bottom" | "top";
  bar: IBar;
  volRatio: number; rangeRatio: number;
  level: number; distPct: number; crossed: boolean;
  stats: { avgVol: number; avgRange: number };
}

/** 直近の確定足(最後の足は進行中なので除く)でクライマックスと水準接近を判定 */
export function detect(tf: Tf, label: string, bars: IBar[], lv: Levels, now = Date.now()): { signal: Signal | null; checked: IBar | null } {
  const done = bars.filter((b) => b.volume > 0);
  if (done.length < LOOKBACK + 2) return { signal: null, checked: null };
  // 最後の足はまだ進行中とみなす(足の開始から tf 分経っていなければ)
  const tfMin = tf === "5m" ? 5 : tf === "15m" ? 15 : 60;
  const last = done[done.length - 1];
  const idx = now - last.t * 1000 >= tfMin * 60 * 1000 ? done.length - 1 : done.length - 2;
  const bar = done[idx];
  const prev = done.slice(Math.max(0, idx - LOOKBACK), idx);
  if (prev.length < LOOKBACK / 2) return { signal: null, checked: bar };
  const avgVol = prev.reduce((s, b) => s + b.volume, 0) / prev.length;
  const avgRange = prev.reduce((s, b) => s + (b.high - b.low), 0) / prev.length;
  if (!(avgVol > 0) || !(avgRange > 0)) return { signal: null, checked: bar };
  const range = bar.high - bar.low;
  const volRatio = bar.volume / avgVol, rangeRatio = range / avgRange;
  if (volRatio < VOL_MULT || rangeRatio < RANGE_MULT) return { signal: null, checked: bar };
  const pos = (bar.close - bar.low) / (range || 1); // 0 = 安値引け、1 = 高値引け
  const near = (level: number) => {
    const crossed = bar.low <= level && level <= bar.high;
    const dist = Math.min(Math.abs(bar.low - level), Math.abs(bar.close - level), Math.abs(bar.high - level)) / bar.close;
    return { crossed, distPct: crossed ? 0 : dist };
  };
  const stats = { avgVol, avgRange };
  if (bar.close < bar.open && pos <= 0.34 && lv.putLevel != null) {
    const n = near(lv.putLevel);
    if (n.crossed || n.distPct <= LEVEL_PCT) return { signal: { tf, label, side: "bottom", bar, volRatio, rangeRatio, level: lv.putLevel, ...n, stats }, checked: bar };
  }
  if (bar.close > bar.open && pos >= 0.66 && lv.callLevel != null) {
    const n = near(lv.callLevel);
    if (n.crossed || n.distPct <= LEVEL_PCT) return { signal: { tf, label, side: "top", bar, volRatio, rangeRatio, level: lv.callLevel, ...n, stats }, checked: bar };
  }
  return { signal: null, checked: bar };
}

const jst = (t: number) => new Date(t * 1000 + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(5, 16) + " JST";
const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");

export function composeMail(signals: Signal[], lv: Levels, siteUrl: string): { subject: string; text: string } {
  const s0 = signals[0];
  const kind = (s: Signal) => (s.side === "bottom" ? "大底候補" : "天井候補");
  const subject = `【opt225】${kind(s0)}: ${signals.map((s) => s.label).join("・")} 出来高急増の${s0.side === "bottom" ? "下落" : "上昇"} @ ${yen(s0.bar.close)}`;
  const body = signals.map((s) => [
    `■ ${kind(s)}(${s.label}) ${jst(s.bar.t)} の足`,
    `  日経225先物(CME ${SYMBOL}) 始${yen(s.bar.open)} 高${yen(s.bar.high)} 安${yen(s.bar.low)} 終${yen(s.bar.close)}`,
    `  出来高 ${yen(s.bar.volume)}(直近${LOOKBACK}本平均の ${s.volRatio.toFixed(1)}倍)、値幅 ${yen(s.bar.high - s.bar.low)}(平均の ${s.rangeRatio.toFixed(1)}倍)`,
    `  ${s.side === "bottom" ? "プット売り手の損益分岐" : "コール売り手の損益分岐"} ${yen(s.level)}(先物換算、日経平均ベース ${yen(s.side === "bottom" ? lv.putBreakeven! : lv.callBreakeven!)} + ベーシス ${lv.basis >= 0 ? "+" : ""}${yen(lv.basis)})`,
    `  ${s.crossed ? "この足で損益分岐をまたぎました" : `損益分岐まで ${(s.distPct * 100).toFixed(2)}%`}`,
  ].join("\n")).join("\n\n");
  const text = `${body}

出来高を伴う大きな${s0.side === "bottom" ? "下落" : "上昇"}足が、オプション売り手全体が損失に転じる水準の近くで出ました。
売り手の投げ(${s0.side === "bottom" ? "プットの買い戻し・先物売り" : "コールの買い戻し・先物買い"})が一巡すると反転しやすい局面の目安です。
損益分岐は ${lv.tradeDate} の建玉から計算した値です。

${siteUrl}

※機械的な検出です。投資助言ではありません。`;
  return { subject, text };
}

export interface AlertState { lastSent: Record<string, number>; lastRun?: { at: number; ok: boolean; note: string; checked: Record<string, { t: number; close: number; volRatio: number } | null> } }
export interface AlertLogItem { at: number; tf: Tf | "daily"; side: Signal["side"] | "far-up" | "far-down"; close: number; level: number; volRatio: number; sent: boolean; text?: string }

/** 期間内のすべての足についてクライマックス判定(チャートのマーカー用)。level に近いものは near=true */
export function scanClimax(bars: IBar[], lv: Levels | null): { t: number; side: "bottom" | "top"; near: boolean; volRatio: number }[] {
  const out: { t: number; side: "bottom" | "top"; near: boolean; volRatio: number }[] = [];
  const done = bars.filter((b) => b.volume > 0);
  for (let i = LOOKBACK; i < done.length; i++) {
    const bar = done[i], prev = done.slice(i - LOOKBACK, i);
    const avgVol = prev.reduce((s, b) => s + b.volume, 0) / prev.length, avgRange = prev.reduce((s, b) => s + (b.high - b.low), 0) / prev.length;
    if (!(avgVol > 0) || !(avgRange > 0)) continue;
    const range = bar.high - bar.low, volRatio = bar.volume / avgVol;
    if (volRatio < VOL_MULT || range / avgRange < RANGE_MULT) continue;
    const pos = (bar.close - bar.low) / (range || 1);
    const nearLv = (level: number | null | undefined) => level != null && ((bar.low <= level && level <= bar.high) || Math.min(Math.abs(bar.low - level), Math.abs(bar.high - level), Math.abs(bar.close - level)) / bar.close <= LEVEL_PCT);
    if (bar.close < bar.open && pos <= 0.34) out.push({ t: bar.t, side: "bottom", near: nearLv(lv?.putLevel), volRatio });
    else if (bar.close > bar.open && pos >= 0.66) out.push({ t: bar.t, side: "top", near: nearLv(lv?.callLevel), volRatio });
  }
  return out;
}

/** Resend でメール送信 */
export async function sendMail(apiKey: string, to: string, subject: string, text: string): Promise<{ ok: boolean; status: number; body: string }> {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "opt225 <onboarding@resend.dev>", to: [to], subject, text }),
  });
  return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 300) };
}

// ---- ファーOTM(遠い行使価格)のプット・コールの価格変化(日次) ----

export const FAR_PCTS = [0.07, 0.10]; // 現値から 7% / 10% 離れた行使価格
export const FAR_UP = 2.0; // 前日比 2 倍以上で急騰
export const FAR_DOWN = 0.5; // 前日比 半分以下で急落
export const FAR_MIN_PX = 5; // これ未満の価格は対象外(ノイズ)

export interface FarQuote { side: "put" | "call"; pct: number; strike: number; px: number; prevPx: number | null; ratio: number | null; iv: number | null; oi: number }

const nearestStrike = <T extends { strike: number }>(rows: T[], target: number) => rows.reduce((b, r) => (Math.abs(r.strike - target) < Math.abs(b.strike - target) ? r : b));

/** 期近の行使価格別データから、現値 ±7%/10% のプット・コールの清算価格と前日比を出す */
export function farQuotes(rows: DailyStrike[], prevRows: DailyStrike[], spot: number): FarQuote[] {
  const out: FarQuote[] = [];
  const puts = rows.filter((r) => r.putPx != null), calls = rows.filter((r) => r.callPx != null);
  for (const pct of FAR_PCTS) {
    if (puts.length) {
      const r = nearestStrike(puts, spot * (1 - pct));
      const p = prevRows.find((x) => x.strike === r.strike && x.month === r.month)?.putPx ?? null;
      out.push({ side: "put", pct, strike: r.strike, px: r.putPx!, prevPx: p, ratio: p && p > 0 ? r.putPx! / p : null, iv: r.putIv ?? null, oi: r.putOi ?? 0 });
    }
    if (calls.length) {
      const r = nearestStrike(calls, spot * (1 + pct));
      const p = prevRows.find((x) => x.strike === r.strike && x.month === r.month)?.callPx ?? null;
      out.push({ side: "call", pct, strike: r.strike, px: r.callPx!, prevPx: p, ratio: p && p > 0 ? r.callPx! / p : null, iv: r.callIv ?? null, oi: r.callOi ?? 0 });
    }
  }
  return out;
}

export function farSignals(q: FarQuote[]): FarQuote[] {
  return q.filter((x) => x.ratio != null && Math.max(x.px, x.prevPx ?? 0) >= FAR_MIN_PX && (x.ratio >= FAR_UP || x.ratio <= FAR_DOWN));
}

export function composeFarMail(sig: FarQuote[], tradeDate: string, spot: number, month: string, siteUrl: string): { subject: string; text: string } {
  const f = (x: FarQuote) => `${x.side === "put" ? "プット" : "コール"} ${yen(x.strike)}(${Math.round(x.pct * 100)}%${x.side === "put" ? "下" : "上"})`;
  const head = sig.map((x) => `${f(x)} ${x.ratio! >= 1 ? "急騰" : "急落"} ${yen(x.prevPx!)}→${yen(x.px)}円(${x.ratio!.toFixed(1)}倍)`).join(" / ");
  const subject = `【opt225】ファーOTM ${sig.some((x) => x.ratio! >= 1) ? "急騰" : "急落"}: ${head}`.slice(0, 120);
  const text = `${tradeDate} 引け(${Number(month.slice(4))}月限、日経平均 ${yen(spot)})\n\n` +
    sig.map((x) => `■ ${f(x)}\n  清算価格 ${yen(x.prevPx!)} → ${yen(x.px)} 円(前日比 ${x.ratio!.toFixed(2)}倍)${x.iv != null ? ` / IV ${x.iv.toFixed(1)}%` : ""} / 建玉 ${yen(x.oi)}枚`).join("\n\n") +
    `\n\n遠い行使価格のオプションが前日比 ${FAR_UP}倍以上(急騰)または ${FAR_DOWN}倍以下(急落)になりました。\n急騰は急変動への備え(ヘッジ買い)か売り手の踏み上げ、急落は警戒の後退を示唆します。\n\n${siteUrl}\n\n※JPX の日次清算値段に基づく判定(場中の価格ではありません)。投資助言ではありません。`;
  return { subject, text };
}
