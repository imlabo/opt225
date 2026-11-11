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
import { judgeAdj, judgeAt, judgeText, tierOf, type Judge } from "./technicals";

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
export const COOLDOWN_MIN = 120; // 既定(時間足ごとは COOLDOWN_BY_TF)
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
  level: number; distPct: number; crossed: boolean; beyond?: boolean; // beyond = 足全体が損益分岐の外(売り手が損失圏)
  stats: { avgVol: number; avgRange: number };
  inProgress: boolean; elapsed: number; // 進行中の足での速報か(経過割合)
  judge?: Judge | null; // テクニカル判定(投げ度・反転・継続)
  tier?: "高" | "中" | "低"; // 投げ度による強さ。低はメール・X に送らない
}

/** 判定対象にする足の古さの上限(分)。Yahoo の 5分足・15分足は 10〜20 分遅れて届くことがあるため余裕を持たせる */
export const MAX_AGE_MIN: Record<Tf, number> = { "5m": 30, "15m": 60, "60m": 150 };
/** 同じ時間足・向きの再通知までの間隔(分) */
export const COOLDOWN_BY_TF: Record<Tf, number> = { "5m": 30, "15m": 60, "60m": 120 };
export const MIN_ELAPSED = 0.3; // 進行中の足は、時間足の 30% 以上経過してから判定

/**
 * 直近の足(MAX_AGE_MIN 以内)を新しい順に見て、最初に条件を満たした足を返す。
 *  - 進行中の足は経過時間で按分して「速報」として判定(出来高は経過割合で、値幅はその平方根で割る)
 *  - データが遅れて届いた確定足も、MAX_AGE_MIN 以内なら拾う(1本だけ見ていると取りこぼすため)
 *  - 水準: 大底候補はプット売り手の損益分岐の 0.8% 以内か、それより下(売り手が損失圏)。天井候補はその逆
 */
/** 時間帯ごとの平常出来高(UTC の時刻の枠 → 過去 20 日の中央値)。MT5 から送られてくる */
export type VolProfile = Record<string, number>;
export const tfMinutes = (tf: Tf) => (tf === "5m" ? 5 : tf === "15m" ? 15 : 60);
export const slotOf = (t: number, tf: Tf) => String(Math.floor((t % 86400) / 60 / tfMinutes(tf)));
/** 取引の中断(30 分以上の空白)の直後の何本かは判定しない(寄り付きの出来高急増を除外) */
export const SKIP_AFTER_BREAK = 3;
const afterBreak = (done: IBar[], idx: number) => {
  for (let k = 0; k < SKIP_AFTER_BREAK && idx - k - 1 >= 0; k++) if (done[idx - k].t - done[idx - k - 1].t > 30 * 60) return true;
  return false;
};
/**
 * 出来高の比較基準: 直近 LOOKBACK 本の平均と、同じ時間帯の平常出来高(過去 20 日の中央値)の大きい方。
 * 早朝・寄り付きなど毎日決まって出来高が膨らむ時間帯で、直近の静かな足と比べて「急増」と誤判定しないため
 */
export const baseVolume = (prev: IBar[], bar: IBar, tf: Tf, profile?: VolProfile) => {
  const avg = prev.reduce((s, b) => s + b.volume, 0) / prev.length;
  const slot = profile?.[slotOf(bar.t, tf)];
  return slot && slot > avg ? slot : avg;
};

function withJudge(sig: Signal, done: IBar[], idx: number, profile?: VolProfile): Signal {
  const j = judgeAt(done, idx, sig.tf, sig.side === "bottom" ? "down" : "up", profile, sig.elapsed);
  return { ...sig, judge: j, tier: j ? tierOf(j.capitulation) : "中" };
}

export function detect(tf: Tf, label: string, bars: IBar[], lv: Levels, now = Date.now(), profile?: VolProfile): { signal: Signal | null; checked: IBar | null } {
  const done = bars.filter((b) => b.volume > 0);
  if (done.length < LOOKBACK + 2) return { signal: null, checked: null };
  const tfMs = tfMinutes(tf) * 60 * 1000;
  const checked = done[done.length - 1];
  for (let idx = done.length - 1; idx >= LOOKBACK; idx--) {
    const bar = done[idx];
    const age = now - bar.t * 1000;
    if (age > MAX_AGE_MIN[tf] * 60 * 1000) break;
    if (afterBreak(done, idx)) continue;
    const inProgress = age < tfMs;
    const elapsed = inProgress ? Math.max(0, Math.min(1, age / tfMs)) : 1;
    if (inProgress && elapsed < MIN_ELAPSED) continue;
    const prev = done.slice(idx - LOOKBACK, idx);
    const avgVol = baseVolume(prev, bar, tf, profile);
    const avgRange = prev.reduce((s, b) => s + (b.high - b.low), 0) / prev.length;
    if (!(avgVol > 0) || !(avgRange > 0)) continue;
    const range = bar.high - bar.low;
    const volRatio = bar.volume / (avgVol * elapsed), rangeRatio = range / (avgRange * Math.sqrt(elapsed));
    if (volRatio < VOL_MULT || rangeRatio < RANGE_MULT) continue;
    const pos = (bar.close - bar.low) / (range || 1); // 0 = 安値引け、1 = 高値引け
    const stats = { avgVol, avgRange };
    if (bar.close < bar.open && pos <= 0.34 && lv.putLevel != null) {
      const crossed = bar.low <= lv.putLevel && lv.putLevel <= bar.high;
      const beyond = bar.high < lv.putLevel; // 足全体が損益分岐より下(売り手が損失圏)
      const distPct = crossed || beyond ? 0 : (bar.low - lv.putLevel) / bar.close;
      if (crossed || beyond || distPct <= LEVEL_PCT) return { signal: withJudge({ tf, label, side: "bottom", bar, volRatio, rangeRatio, level: lv.putLevel, crossed, beyond, distPct, stats, inProgress, elapsed }, done, idx, profile), checked };
    }
    if (bar.close > bar.open && pos >= 0.66 && lv.callLevel != null) {
      const crossed = bar.low <= lv.callLevel && lv.callLevel <= bar.high;
      const beyond = bar.low > lv.callLevel;
      const distPct = crossed || beyond ? 0 : (lv.callLevel - bar.high) / bar.close;
      if (crossed || beyond || distPct <= LEVEL_PCT) return { signal: withJudge({ tf, label, side: "top", bar, volRatio, rangeRatio, level: lv.callLevel, crossed, beyond, distPct, stats, inProgress, elapsed }, done, idx, profile), checked };
    }
  }
  return { signal: null, checked };
}

/**
 * 損益分岐との位置関係の文言。余裕率 = プットは (現値 − 損益分岐) / 現値、コールは (損益分岐 − 現値) / 現値。
 * マイナスは損益分岐を割れた(上抜けた)状態 = 売り手が損失圏
 */
export function levelText(side: "bottom" | "top", level: number, close: number): string {
  const put = side === "bottom";
  const d = ((put ? close - level : level - close) / close) * 100;
  const who = put ? "プット売り手" : "コール売り手";
  if (d < 0) return `${who}の損益分岐 ${yen(level)} を${put ? "割れています" : "上抜けています"}(${d.toFixed(2)}%、売り手は損失圏)`;
  return `${who}の損益分岐 ${yen(level)} まで あと ${d.toFixed(2)}%(${put ? "下" : "上"}に)`;
}

const jst = (t: number) => new Date(t * 1000 + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(5, 16) + " JST";
const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");

export function composeMail(signals: Signal[], lv: Levels, siteUrl: string): { subject: string; text: string } {
  const s0 = signals[0];
  const kind = (s: Signal) => (s.side === "bottom" ? "大底候補" : "天井候補");
  const subject = `【opt225】${s0.inProgress ? "速報 " : ""}${kind(s0)}${s0.tier ? `[投げ度${s0.tier}]` : ""}: ${signals.map((s) => s.label).join("・")} 出来高急増の${s0.side === "bottom" ? "下落" : "上昇"} @ ${yen(s0.bar.close)}(${jst(s0.bar.t).slice(6, 11)}〜)`;
  const body = signals.map((s) => [
    `■ ${kind(s)}(${s.label}) ${jst(s.bar.t)} の足${s.inProgress ? `(進行中・${Math.round(s.elapsed * 100)}%経過時点の速報。出来高・値幅は経過時間で按分して判定)` : ""}`,
    `  ${s.label.includes("MT5") ? "日経225 CFD(XS MT5)" : `日経225先物(CME ${SYMBOL})`} 始${yen(s.bar.open)} 高${yen(s.bar.high)} 安${yen(s.bar.low)} 終${yen(s.bar.close)}`,
    `  出来高 ${yen(s.bar.volume)}(直近${LOOKBACK}本平均の ${s.volRatio.toFixed(1)}倍${s.inProgress ? "・按分後" : ""})、値幅 ${yen(s.bar.high - s.bar.low)}(平均の ${s.rangeRatio.toFixed(1)}倍)`,
    `  ${s.side === "bottom" ? "プット売り手の損益分岐" : "コール売り手の損益分岐"} ${yen(s.level)}(先物換算、日経平均ベース ${yen(s.side === "bottom" ? lv.putBreakeven! : lv.callBreakeven!)} + ベーシス ${lv.basis >= 0 ? "+" : ""}${yen(lv.basis)})`,
    `  ${levelText(s.side, s.level, s.bar.close)}${s.crossed ? "。この足で損益分岐をまたぎました" : ""}`,
    s.judge ? judgeText(s.judge) : "",
  ].filter(Boolean).join("\n")).join("\n\n");
  const text = `${body}

出来高を伴う大きな${s0.side === "bottom" ? "下落" : "上昇"}足が、オプション売り手全体が損失に転じる水準の近くで出ました。
売り手の投げ(${s0.side === "bottom" ? "プットの買い戻し・先物売り" : "コールの買い戻し・先物買い"})が一巡すると反転しやすい局面の目安です。
損益分岐は ${lv.tradeDate} の建玉から計算した値です。

${siteUrl}

※機械的な検出です。投資助言ではありません。`;
  return { subject, text };
}

export interface AlertState { lastSent: Record<string, number>; pending?: Pending[]; lastLearn?: number; learnDirty?: boolean; lastRun?: { at: number; ok: boolean; note: string; checked: Record<string, { t: number; close: number; volRatio: number } | null> } }
export interface AlertLogItem { at: number; tf: Tf | "daily"; side: Signal["side"] | "far-up" | "far-down" | FollowSignal["kind"]; close: number; level: number; volRatio: number; sent: boolean; text?: string }

/** 期間内のすべての足についてクライマックス判定(チャートのマーカー用)。level に近いものは near=true */
export function scanClimax(bars: IBar[], lv: Levels | null, tf: Tf = "5m", profile?: VolProfile): { t: number; side: "bottom" | "top"; near: boolean; volRatio: number }[] {
  const out: { t: number; side: "bottom" | "top"; near: boolean; volRatio: number }[] = [];
  const done = bars.filter((b) => b.volume > 0);
  for (let i = LOOKBACK; i < done.length; i++) {
    if (afterBreak(done, i)) continue;
    const bar = done[i], prev = done.slice(i - LOOKBACK, i);
    const avgVol = baseVolume(prev, bar, tf, profile), avgRange = prev.reduce((s, b) => s + (b.high - b.low), 0) / prev.length;
    if (!(avgVol > 0) || !(avgRange > 0)) continue;
    const range = bar.high - bar.low, volRatio = bar.volume / avgVol;
    if (volRatio < VOL_MULT || range / avgRange < RANGE_MULT) continue;
    const pos = (bar.close - bar.low) / (range || 1);
    const put = lv?.putLevel, call = lv?.callLevel;
    if (bar.close < bar.open && pos <= 0.34) out.push({ t: bar.t, side: "bottom", near: put != null && bar.low <= put * (1 + LEVEL_PCT), volRatio });
    else if (bar.close > bar.open && pos >= 0.66) out.push({ t: bar.t, side: "top", near: call != null && bar.high >= call * (1 - LEVEL_PCT), volRatio });
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

// ---- ブレイク判定: クライマックス後の「反転」か「ブレイク(続落・続伸)」か、と損益分岐ブレイク ----

/** クライマックス足のあと、何本の確定足で決着を見るか */
export const FOLLOW_BARS: Record<Tf, number> = { "5m": 4, "15m": 3, "60m": 2 };
export const BREAK_VOL = 1.3; // ブレイク足に求める出来高(基準比)
export const BREAK_MARGIN = 0.002; // 損益分岐ブレイク: 終値が損益分岐を 0.2% 以上越えて引ける
export const BREAK_LOOKBACK = 6; // 損益分岐ブレイク: 直近 6 本のうちに反対側で引けた足がある(=今まさに越えた)

/** 判定待ちのクライマックス(大底候補・天井候補) */
export interface Pending { tf: Tf; side: "bottom" | "top"; t: number; open: number; high: number; low: number; close: number; level: number; label: string; contOnly?: boolean } // contOnly = 天井・大底として通知しなかったもの(確認は出さず、ブレイクだけ見る)

export type FollowKind = "confirm-bottom" | "confirm-top" | "break-down" | "break-up";
export interface FollowSignal {
  kind: FollowKind | "level-break-down" | "level-break-up";
  tf: Tf; label: string;
  bar: IBar; // 決め手になった足
  ref?: Pending; // 元のクライマックス
  level: number;
  volRatio: number;
  judge?: Judge | null;
}

const doneBars = (bars: IBar[], tf: Tf, now: number) => bars.filter((b) => b.volume > 0 && b.t * 1000 + tfMinutes(tf) * 60000 <= now);

/**
 * クライマックス後の決着(慎重版)。大底候補なら、FOLLOW_BARS 本の確定足のうちに:
 *  - 大底確認: 終値がクライマックス足の中値を上回り、その間にクライマックス足の安値を(0.05%超)更新しておらず、
 *    テクニカル判定で「反転」の点数が「継続」以上
 *  - 下落ブレイク: クライマックス足の安値を下回る終値が 2 本続いた(出来高 1.3 倍以上の足を含む)、
 *    または 1 本でも出来高 1.3 倍以上で、継続 60 点以上かつ反転より 10 点以上高い
 * 天井候補はその逆。どちらにも当たらなければ判定を打ち切る(通知しない)
 */
export const NEW_EXTREME_TOL = 0.0005;
export function followUp(p: Pending, bars: IBar[], now = Date.now(), profile?: VolProfile): { signal: FollowSignal | null; expired: boolean } {
  const done = doneBars(bars, p.tf, now);
  const i0 = done.findIndex((b) => b.t > p.t);
  if (i0 < 0) return { signal: null, expired: now - p.t * 1000 > (FOLLOW_BARS[p.tf] + 2) * tfMinutes(p.tf) * 60000 };
  const after = done.slice(i0, i0 + FOLLOW_BARS[p.tf]);
  const mid = (p.high + p.low) / 2;
  const bottom = p.side === "bottom";
  let newExtreme = false, beyondCount = 0, beyondVol = false;
  for (let k = 0; k < after.length; k++) {
    const b = after[k];
    const idx = i0 + k;
    const prev = done.slice(Math.max(0, idx - LOOKBACK), idx);
    const base = prev.length ? baseVolume(prev, b, p.tf, profile) : b.volume;
    const volRatio = base > 0 ? b.volume / base : 0;
    const j = judgeAt(done, idx, p.tf, bottom ? "down" : "up", profile);
    const mk = (kind: FollowKind): FollowSignal => ({ kind, tf: p.tf, label: p.label, bar: b, ref: p, level: p.level, volRatio, judge: j });
    if (bottom ? b.low < p.low * (1 - NEW_EXTREME_TOL) : b.high > p.high * (1 + NEW_EXTREME_TOL)) newExtreme = true;
    const beyond = bottom ? b.close < p.low : b.close > p.high;
    if (beyond) { beyondCount++; if (volRatio >= BREAK_VOL) beyondVol = true; } else beyondCount = 0;
    const adj = judgeAdj(); // 当たりが悪い種類ほど厳しく(src/judge-learn.ts)
    const strongCont = !!j && j.continuation >= 60 + adj.break && j.continuation >= j.reversal + 10;
    if (beyond && ((beyondCount >= 2 && beyondVol) || (volRatio >= BREAK_VOL && strongCont))) return { signal: mk(bottom ? "break-down" : "break-up"), expired: false };
    const back = bottom ? b.close > mid : b.close < mid;
    // 確認は慎重に: 反転が継続より 10 点以上(+上乗せ)高く、大きな流れが同じ向きならクライマックス足の始値まで戻すこと
    const engulf = bottom ? b.close > p.open : b.close < p.open;
    const trendWith = !!j && (bottom ? -j.tech.trend : j.tech.trend) >= 1.5;
    if (back && !p.contOnly && !newExtreme && (!j || (j.reversal >= j.continuation + 10 + adj.confirm && (engulf || !trendWith)))) return { signal: mk(bottom ? "confirm-bottom" : "confirm-top"), expired: false };
  }
  return { signal: null, expired: after.length >= FOLLOW_BARS[p.tf] };
}

/**
 * 損益分岐ブレイク(慎重版): 直近 2 本の確定足がどちらも損益分岐の外で引け(最新足は 0.2% 以上外)、
 * そのどちらかが出来高 1.3 倍以上、その前の 6 本のうちに反対側で引けた足があり(= いま越えた)、
 * テクニカル判定で継続 55 点以上かつ反転より高い
 *  - プット売り手の損益分岐を下抜け → 下落ブレイク(売り手のヘッジ売り・損切りで下げが加速しやすい)
 *  - コール売り手の損益分岐を上抜け → 上昇ブレイク(踏み上げ)
 */
export const LEVEL_BREAK_CONT = 55;
export function detectLevelBreak(tf: Tf, label: string, bars: IBar[], lv: Levels, now = Date.now(), profile?: VolProfile): FollowSignal | null {
  const done = doneBars(bars, tf, now);
  if (done.length < LOOKBACK + 3) return null;
  const idx = done.length - 1;
  const b = done[idx], b1 = done[idx - 1];
  if (now - b.t * 1000 > MAX_AGE_MIN[tf] * 60000) return null;
  const vr = (k: number) => done[k].volume / baseVolume(done.slice(k - LOOKBACK, k), done[k], tf, profile);
  const volRatio = Math.max(vr(idx), vr(idx - 1));
  if (volRatio < BREAK_VOL) return null;
  const recent = done.slice(Math.max(0, idx - 1 - BREAK_LOOKBACK), idx - 1);
  const check = (dir: "down" | "up", level: number): FollowSignal | null => {
    const out = dir === "down" ? b.close < level * (1 - BREAK_MARGIN) && b1.close < level : b.close > level * (1 + BREAK_MARGIN) && b1.close > level;
    if (!out || !recent.some((r) => (dir === "down" ? r.close > level : r.close < level))) return null;
    const j = judgeAt(done, idx, tf, dir, profile);
    if (j && (j.continuation < LEVEL_BREAK_CONT + judgeAdj().break || j.continuation <= j.reversal)) return null;
    return { kind: dir === "down" ? "level-break-down" : "level-break-up", tf, label, bar: b, level, volRatio, judge: j };
  };
  return (lv.putLevel != null ? check("down", lv.putLevel) : null) ?? (lv.callLevel != null ? check("up", lv.callLevel) : null);
}

export const FOLLOW_LABEL: Record<FollowSignal["kind"], string> = {
  "confirm-bottom": "大底確認(反発)",
  "confirm-top": "天井確認(反落)",
  "break-down": "下落ブレイク(大底候補を割って続落)",
  "break-up": "上昇ブレイク(天井候補を抜けて続伸)",
  "level-break-down": "下落ブレイク(プット売り手の損益分岐を割り込み)",
  "level-break-up": "上昇ブレイク(コール売り手の損益分岐を上抜け)",
};
const isDown = (k: FollowSignal["kind"]) => k === "break-down" || k === "level-break-down" || k === "confirm-top";

export function composeFollowMail(sigs: FollowSignal[], lv: Levels, siteUrl: string): { subject: string; text: string } {
  const s0 = sigs[0];
  const subject = `【opt225】${FOLLOW_LABEL[s0.kind]}: ${sigs.map((s) => s.label).join("・")} @ ${yen(s0.bar.close)}(${jst(s0.bar.t).slice(6, 11)})`;
  const side = (s: FollowSignal) => (s.kind.endsWith("down") || s.kind === "confirm-bottom" ? "bottom" : "top") as "bottom" | "top";
  const body = sigs.map((s) => {
    const lines = [
      `■ ${FOLLOW_LABEL[s.kind]}(${s.label}) ${jst(s.bar.t)} の足で確定`,
      `  始${yen(s.bar.open)} 高${yen(s.bar.high)} 安${yen(s.bar.low)} 終${yen(s.bar.close)} / 出来高 基準の ${s.volRatio.toFixed(1)}倍`,
    ];
    if (s.ref) lines.push(`  元の${s.ref.side === "bottom" ? "大底候補" : "天井候補"}: ${jst(s.ref.t)} の足(高${yen(s.ref.high)} 安${yen(s.ref.low)}、中値 ${yen((s.ref.high + s.ref.low) / 2)})`);
    lines.push(`  ${levelText(side(s), s.level, s.bar.close)}`);
    if (s.judge) lines.push(judgeText(s.judge));
    return lines.join("\n");
  }).join("\n\n");
  const why: Record<FollowSignal["kind"], string> = {
    "confirm-bottom": "大底候補の足のあと、安値を更新せずに終値がその足の中値を上回り、テクニカルも反転側が優勢です。含み損を抱えた買い方の投げが一巡して反発に転じた可能性があります。",
    "confirm-top": "天井候補の足のあと、高値を更新せずに終値がその足の中値を下回り、テクニカルも反転側が優勢です。売り方の買い戻しが一巡して反落に転じた可能性があります。",
    "break-down": "大底候補の足の安値を下回る引けが続き(または出来高を伴い継続側のテクニカルが強く)、投げが一巡していません。下げが続く(続落)可能性があります。",
    "break-up": "天井候補の足の高値を上回る引けが続き(または出来高を伴い継続側のテクニカルが強く)、踏み上げが一巡していません。続伸の可能性があります。",
    "level-break-down": "出来高を伴ってプット売り手全体の損益分岐を割り込みました。売り手のヘッジ売り・損切りで下げが加速しやすい局面です。",
    "level-break-up": "出来高を伴ってコール売り手全体の損益分岐を上抜けました。売り手の買い戻し(踏み上げ)で上げが加速しやすい局面です。",
  };
  return { subject, text: `${body}\n\n${why[s0.kind]}\n損益分岐は ${lv.tradeDate} の建玉から計算した値です。\n\n${siteUrl}\n\n※機械的な検出です。投資助言ではありません。` };
}
export const followIsDown = isDown;
