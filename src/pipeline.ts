import { analyze } from "./analysis";
import { hasWeek, loadHistory, logPost, saveAnalysis, saveWeek, wasPosted } from "./db";
import { discoverLatestFiles, fetchWeek, weekFromFileName } from "./jpx";
import type { Env, WeekData } from "./types";
import { composeTweet, postTweet } from "./x";

export interface RunResult {
  ingested: string[];
  analyzed?: string;
  post?: { status: string; tweetId?: string; text?: string; error?: string };
  errors: string[];
}

/** 最新週を JPX から取得 → D1 保存 → 分析 → X 投稿。すべて冪等。 */
export async function runPipeline(env: Env, opts: { force?: boolean; backfill?: number } = {}): Promise<RunResult> {
  const result: RunResult = { ingested: [], errors: [] };
  try {
    const all = await discoverLatestFiles(env.JPX_INDEX_URL);
    // 一覧には飛び地の古い週が混ざることがあるので、最新週から 120 日以内に限る
    const newest = weekFromFileName(all[0] ?? "")?.weekEnd;
    const recent = all.filter((u) => {
      const w = weekFromFileName(u)?.weekEnd;
      return newest && w && Date.parse(newest) - Date.parse(w) <= 120 * 864e5;
    });
    // DB が空(初回)なら取得可能な週をすべて取り込む
    const empty = !(await env.DB.prepare("SELECT 1 FROM weeks WHERE is_sample = 0 LIMIT 1").first());
    const files = recent.slice(0, opts.backfill ?? (empty ? recent.length : 1));
    for (const url of files.reverse()) {
      const wk = weekFromFileName(url);
      if (wk && !opts.force && (await hasWeek(env, wk.weekEnd))) continue;
      try {
        const data = await fetchWeek(url);
        await saveWeek(env, data);
        result.ingested.push(data.weekEnd);
      } catch (e) {
        result.errors.push(String(e));
      }
    }
  } catch (e) {
    result.errors.push(String(e));
  }
  if (result.ingested.length || opts.force) {
    const r = await analyzeAndPost(env, opts.force);
    Object.assign(result, r);
  }
  return result;
}

export async function ingestManual(env: Env, w: WeekData) {
  await saveWeek(env, w);
}

export async function analyzeAndPost(env: Env, forcePost = false) {
  const history = await loadHistory(env);
  if (!history.length) return { analyzed: undefined, post: undefined };
  // 全週を再分析(重み変更時も履歴が整合する)
  for (let i = 0; i < history.length; i++) await saveAnalysis(env, analyze(history.slice(0, i + 1)));
  const latest = analyze(history);
  const week = history[history.length - 1];

  if (week.isSample) return { analyzed: latest.weekEnd, post: { status: "skipped_sample" } };
  if (!forcePost && (await wasPosted(env, latest.weekEnd))) return { analyzed: latest.weekEnd, post: { status: "already_posted" } };

  const text = composeTweet(latest, env.SITE_URL);
  const creds = env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET
    ? { apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessSecret: env.X_ACCESS_SECRET }
    : null;
  if (env.X_POST_ENABLED !== "true" || !creds) {
    await logPost(env, latest.weekEnd, text, "dry_run");
    return { analyzed: latest.weekEnd, post: { status: "dry_run", text } };
  }
  try {
    const id = await postTweet(text, creds);
    await logPost(env, latest.weekEnd, text, "posted", id);
    return { analyzed: latest.weekEnd, post: { status: "posted", tweetId: id, text } };
  } catch (e) {
    await logPost(env, latest.weekEnd, text, "failed", undefined, String(e));
    return { analyzed: latest.weekEnd, post: { status: "failed", text, error: String(e) } };
  }
}
