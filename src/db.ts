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
