/**
 * Yahoo Finance のチャート API(^N225)から日足 4 本値を取り、日経公式 CSV の不足分(最新足)を補う。
 * 日経公式 CSV は当日分の反映が遅れることがあるため、公式 CSV を正とし、それより新しい日だけ Yahoo で埋める。
 * 公式 API ではないため仕様変更で取れなくなる可能性がある(取れない場合は従来どおり JPX 終値の仮置きにフォールバック)。
 */
import type { Bar } from "./ichimoku";

export const YAHOO_URLS = [
  "https://query2.finance.yahoo.com/v8/finance/chart/%5EN225?interval=1d&range=3mo",
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?interval=1d&range=3mo",
];

/** UNIX 秒 → 東京時間の YYYY-MM-DD */
export function tokyoDate(unixSec: number): string {
  return new Date((unixSec + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

/** 現在の東京時間 (date, 分単位の時刻) */
export function tokyoNow(now = Date.now()) {
  const d = new Date(now + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}

/** Yahoo chart JSON → 日足。欠損(null)や未確定の当日足(15:45 JST 前)は除外 */
export function parseYahooChart(json: unknown, now = Date.now()): Bar[] {
  const r = (json as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[] }[] } }[]; error?: { description?: string } } }).chart;
  if (r?.error) throw new Error(`Yahoo: ${r.error.description ?? "error"}`);
  const res = r?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  if (!res?.timestamp || !q) throw new Error("Yahoo: unexpected response");
  const t = tokyoNow(now);
  const out: Bar[] = [];
  res.timestamp.forEach((ts, i) => {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null || !(h > 0) || !(l > 0) || !(c > 0)) return;
    const date = tokyoDate(ts);
    if (date > t.date || (date === t.date && t.minutes < 15 * 60 + 45)) return; // 取引中の足は使わない
    out.push({ date, open: o, high: h, low: l, close: c });
  });
  // 同日重複は後勝ち
  const m = new Map(out.map((b) => [b.date, b]));
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 公式 CSV の日足を正として、それより新しい日の足を補助ソースから追加する(upTo まで)。
 * 戻り値の added は補った日付。
 */
export function mergeBars(primary: Bar[], extra: Bar[], upTo?: string): { bars: Bar[]; added: string[] } {
  const bars = [...primary].sort((a, b) => a.date.localeCompare(b.date));
  const last = bars[bars.length - 1]?.date ?? "";
  const added: string[] = [];
  for (const b of [...extra].sort((a, b) => a.date.localeCompare(b.date))) {
    if (b.date <= last) continue;
    if (upTo && b.date > upTo) continue;
    bars.push({ ...b });
    added.push(b.date);
  }
  return { bars, added };
}

/** 直近の取引日(東京時間、土日除く。平日 15:45 前なら前営業日) */
export function latestTradingDate(now = Date.now()): string {
  const t = tokyoNow(now);
  const d = new Date(t.date + "T00:00:00Z");
  if (t.minutes < 15 * 60 + 45) d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
