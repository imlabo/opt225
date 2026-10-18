/**
 * Yahoo Finance のチャート API(^N225)から日足 4 本値を取り、日経公式 CSV の不足分(最新足)を補う。
 * 日経公式 CSV は当日分の反映が遅れることがあるため、公式 CSV を正とし、それより新しい日だけ Yahoo で埋める。
 * 公式 API ではないため仕様変更で取れなくなる可能性がある(取れない場合は従来どおり JPX 終値の仮置きにフォールバック)。
 */
import type { Bar } from "./ichimoku";

/** 日経225先物(CME 円建て NIY=F, 継続足)。大阪取引所の先物日足は無料の公開データがないため CME を使う */
export const YAHOO_FUTURES_URLS = [
  "https://query2.finance.yahoo.com/v8/finance/chart/NIY%3DF?interval=1d&range=5y",
  "https://query1.finance.yahoo.com/v8/finance/chart/NIY%3DF?interval=1d&range=5y",
];
/** 代替: CME ドル建て日経225先物(NKD=F)。価格は同じ指数ポイントで、出来高が多くデータ欠けが少ないことがある */
export const YAHOO_FUTURES_ALT_URLS = [
  "https://query2.finance.yahoo.com/v8/finance/chart/NKD%3DF?interval=1d&range=5y",
  "https://query1.finance.yahoo.com/v8/finance/chart/NKD%3DF?interval=1d&range=5y",
];

/** 4 本値が欠けている足(高値 = 安値、または値幅が 0.05% 未満。Yahoo の先物データは終値だけの日がある) */
export const isDegenerate = (b: Bar) => b.high - b.low < b.close * 0.0005;

/**
 * 欠けている足を前日終値から補う: 始値 = 前日終値、高値・安値 = 当日終値と前日終値の範囲。
 * 実際の値幅より小さい控えめな推定で、点になっていたローソク足を最低限の形にする。戻り値は補った本数
 */
export function repairDegenerate(bars: Bar[]): { bars: Bar[]; repaired: string[] } {
  const out = bars.map((b) => ({ ...b }));
  const repaired: string[] = [];
  for (let i = 1; i < out.length; i++) {
    const b = out[i];
    if (!isDegenerate(b)) continue;
    const pc = out[i - 1].close;
    out[i] = { date: b.date, open: pc, close: b.close, high: Math.max(pc, b.close, b.high), low: Math.min(pc, b.close, b.low) };
    repaired.push(b.date);
  }
  return { bars: out, repaired };
}

export const YAHOO_URLS = [
  "https://query2.finance.yahoo.com/v8/finance/chart/%5EN225?interval=1d&range=3mo",
  "https://query1.finance.yahoo.com/v8/finance/chart/%5EN225?interval=1d&range=3mo",
];

/** UNIX 秒 → 東京時間の YYYY-MM-DD */
export function tokyoDate(unixSec: number): string {
  return new Date((unixSec + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

/** UNIX 秒 → シカゴ時間の YYYY-MM-DD(夏時間対応) */
export function chicagoDate(unixSec: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(unixSec * 1000));
}

/** 現在の東京時間 (date, 分単位の時刻) */
export function tokyoNow(now = Date.now()) {
  const d = new Date(now + 9 * 3600 * 1000);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}

/**
 * Yahoo chart JSON → 日足。欠損(null)は除外。
 * mode "tokyo": 日付は東京時間、取引中の当日足(15:45 JST 前)は除外(日経平均用)
 * mode "cme": 日付はシカゴの取引日(NIY=F の日足 D は JST で D 07:00〜翌 06:00 ≒ 大阪の D 日中+ナイト)。
 *             最後の足は進行中でも採用し、inProgress で返す
 */
export function parseYahooChart(json: unknown, now = Date.now(), mode: "tokyo" | "cme" = "tokyo"): Bar[] & { inProgress?: string } {
  const r = (json as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[] }[] } }[]; error?: { description?: string } } }).chart;
  if (r?.error) throw new Error(`Yahoo: ${r.error.description ?? "error"}`);
  const res = r?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  if (!res?.timestamp || !q) throw new Error("Yahoo: unexpected response");
  const t = tokyoNow(now);
  const out: Bar[] = [];
  let inProgress: string | undefined;
  res.timestamp.forEach((ts, i) => {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if (o == null || h == null || l == null || c == null || !(h > 0) || !(l > 0) || !(c > 0)) return;
    if (mode === "cme") {
      // CME の取引日 D は前日 17:00 CT に始まり D 16:00 CT に終わる。Yahoo の日足タイムスタンプは取引日の開始
      // (= D−1 17:00 CT)か D 0:00 CT のどちらか。+8 時間したシカゴ時間の日付を取ればどちらでも D になる
      const date = chicagoDate(ts + 8 * 3600);
      if (i === res.timestamp!.length - 1 && now < (ts + 23 * 3600) * 1000) inProgress = date; // 最後の足がまだ取引中
      out.push({ date, open: o, high: h, low: l, close: c });
      return;
    }
    const date = tokyoDate(ts);
    if (date > t.date || (date === t.date && t.minutes < 15 * 60 + 45)) return; // 取引中の足は使わない
    out.push({ date, open: o, high: h, low: l, close: c });
  });
  // 同日重複は後勝ち
  const m = new Map(out.map((b) => [b.date, b]));
  const bars = [...m.values()].sort((a, b) => a.date.localeCompare(b.date)) as Bar[] & { inProgress?: string };
  if (inProgress) bars.inProgress = inProgress;
  return bars;
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
