import type { DailyAnalysis, DailyInput, DailyStrike } from "./daily";
import type { Analysis } from "./analysis";
import type { Env, FlowRow, Product, Investor, WeekData } from "./types";

export async function hasWeek(env: Env, weekEnd: string) {
  return !!(await env.DB.prepare("SELECT 1 FROM weeks WHERE week_end = ? AND is_sample = 0").bind(weekEnd).first());
}

export async function saveWeek(env: Env, w: WeekData) {
  const stmts = [
    env.DB.prepare(
      `INSERT INTO weeks (week_end, week_start, source_url, is_sample) VALUES (?, ?, ?, ?)
       ON CONFLICT(week_end) DO UPDATE SET week_start=excluded.week_start, source_url=excluded.source_url,
         is_sample=excluded.is_sample, fetched_at=datetime('now')`,
    ).bind(w.weekEnd, w.weekStart, w.sourceUrl ?? null, w.isSample ? 1 : 0),
    env.DB.prepare("DELETE FROM flows WHERE week_end = ?").bind(w.weekEnd),
    ...w.flows.map((f) =>
      env.DB.prepare(
        "INSERT INTO flows (week_end, product, investor, sell, buy, sell_value, buy_value) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(w.weekEnd, f.product, f.investor, Math.round(f.sell), Math.round(f.buy), f.sellValue ?? null, f.buyValue ?? null),
    ),
  ];
  await env.DB.batch(stmts);
}

export async function loadHistory(env: Env, upTo?: string, limit = 60): Promise<WeekData[]> {
  const weeks = await env.DB.prepare(
    `SELECT week_end, week_start, source_url, is_sample FROM weeks
     WHERE (?1 IS NULL OR week_end <= ?1) ORDER BY week_end DESC LIMIT ?2`,
  ).bind(upTo ?? null, limit).all<{ week_end: string; week_start: string; source_url: string | null; is_sample: number }>();
  const list = weeks.results.reverse();
  if (list.length === 0) return [];
  const flows = await env.DB.prepare(
    `SELECT week_end, product, investor, sell, buy, sell_value, buy_value FROM flows WHERE week_end >= ? AND week_end <= ?`,
  ).bind(list[0].week_end, list[list.length - 1].week_end).all<{ week_end: string; product: string; investor: string; sell: number; buy: number; sell_value: number | null; buy_value: number | null }>();
  const byWeek = new Map<string, FlowRow[]>();
  for (const r of flows.results) {
    const arr = byWeek.get(r.week_end) ?? [];
    arr.push({
      product: r.product as Product, investor: r.investor as Investor, sell: r.sell, buy: r.buy,
      sellValue: r.sell_value ?? undefined, buyValue: r.buy_value ?? undefined,
    });
    byWeek.set(r.week_end, arr);
  }
  return list.map((w) => ({
    weekEnd: w.week_end, weekStart: w.week_start, sourceUrl: w.source_url ?? undefined,
    isSample: !!w.is_sample, flows: byWeek.get(w.week_end) ?? [],
  }));
}

export async function saveAnalysis(env: Env, a: Analysis) {
  await env.DB.prepare(
    `INSERT INTO analyses (week_end, score, bias, vol_signal, detail_json) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(week_end) DO UPDATE SET score=excluded.score, bias=excluded.bias,
       vol_signal=excluded.vol_signal, detail_json=excluded.detail_json, created_at=datetime('now')`,
  ).bind(a.weekEnd, a.score, a.bias, a.volSignal, JSON.stringify(a)).run();
}

export async function loadAnalyses(env: Env, limit = 52): Promise<Analysis[]> {
  const r = await env.DB.prepare("SELECT detail_json FROM analyses ORDER BY week_end DESC LIMIT ?").bind(limit).all<{ detail_json: string }>();
  return r.results.map((x) => JSON.parse(x.detail_json) as Analysis).reverse();
}

export async function wasPosted(env: Env, weekEnd: string) {
  return !!(await env.DB.prepare("SELECT 1 FROM posts WHERE week_end = ? AND status = 'posted'").bind(weekEnd).first());
}

export async function logPost(env: Env, weekEnd: string, text: string, status: string, tweetId?: string, error?: string) {
  await env.DB.prepare(
    `INSERT INTO posts (week_end, tweet_id, text, status, error) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(week_end) DO UPDATE SET tweet_id=excluded.tweet_id, text=excluded.text, status=excluded.status,
       error=excluded.error, posted_at=datetime('now')`,
  ).bind(weekEnd, tweetId ?? null, text, status, error ?? null).run();
}

// ---- 日次 ----

export async function saveDaily(env: Env, d: DailyInput, a: DailyAnalysis) {
  const ins = env.DB.prepare(
    `INSERT INTO daily_strikes (trade_date, month, strike, put_oi, put_chg, put_vol, put_px, put_iv, call_oi, call_chg, call_vol, call_px, call_iv)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const n = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? null : v);
  const stmts = [
    env.DB.prepare("DELETE FROM daily_strikes WHERE trade_date = ?").bind(d.tradeDate),
    ...d.strikes.map((s) =>
      ins.bind(d.tradeDate, s.month, s.strike, n(s.putOi), n(s.putChg), n(s.putVol), n(s.putPx), n(s.putIv),
        n(s.callOi), n(s.callChg), n(s.callVol), n(s.callPx), n(s.callIv)),
    ),
    env.DB.prepare(
      `INSERT INTO daily_snapshots (trade_date, spot, detail_json) VALUES (?, ?, ?)
       ON CONFLICT(trade_date) DO UPDATE SET spot=excluded.spot, detail_json=excluded.detail_json, created_at=datetime('now')`,
    ).bind(d.tradeDate, d.spot, JSON.stringify(a)),
  ];
  // D1 の batch は 1 回あたりの文数に上限があるため分割
  for (let i = 0; i < stmts.length; i += 400) await env.DB.batch(stmts.slice(i, i + 400));
}

export async function loadDailyAnalyses(env: Env, limit = 60, before?: string): Promise<DailyAnalysis[]> {
  const r = await env.DB.prepare(
    "SELECT detail_json FROM daily_snapshots WHERE (?1 IS NULL OR trade_date < ?1) ORDER BY trade_date DESC LIMIT ?2",
  ).bind(before ?? null, limit).all<{ detail_json: string }>();
  return r.results.map((x) => JSON.parse(x.detail_json) as DailyAnalysis).reverse();
}

export async function loadDailyStrikes(env: Env, tradeDate: string, month: string): Promise<DailyStrike[]> {
  const r = await env.DB.prepare(
    `SELECT month, strike, put_oi, put_chg, put_iv, call_oi, call_chg, call_iv FROM daily_strikes
     WHERE trade_date = ? AND month = ? ORDER BY strike`,
  ).bind(tradeDate, month).all<Record<string, number | string | null>>();
  return r.results.map((x) => ({
    month: String(x.month), strike: Number(x.strike),
    putOi: (x.put_oi as number) ?? undefined, putChg: (x.put_chg as number) ?? undefined, putIv: (x.put_iv as number) ?? undefined,
    callOi: (x.call_oi as number) ?? undefined, callChg: (x.call_chg as number) ?? undefined, callIv: (x.call_iv as number) ?? undefined,
  }));
}

export async function wasDailyPosted(env: Env, tradeDate: string) {
  return !!(await env.DB.prepare("SELECT 1 FROM daily_posts WHERE trade_date = ? AND status = 'posted'").bind(tradeDate).first());
}

export async function logDailyPost(env: Env, tradeDate: string, text: string, status: string, tweetId?: string, error?: string) {
  await env.DB.prepare(
    `INSERT INTO daily_posts (trade_date, tweet_id, text, status, error) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(trade_date) DO UPDATE SET tweet_id=excluded.tweet_id, text=excluded.text, status=excluded.status,
       error=excluded.error, posted_at=datetime('now')`,
  ).bind(tradeDate, tweetId ?? null, text, status, error ?? null).run();
}
