import { analyzeDaily, type DailyAnalysis, type DailyInput } from "./daily";
import { evaluatePending, loadAnalyses, loadMeta, saveMeta, loadSentiment, loadDailyAnalyses, loadEvaluated, logDailyPost, saveDaily, saveModelLog, savePrediction, wasDailyPosted } from "./db";
import { calibrateK, features, fit, ichiMetrics, makePrediction, metrics, PRIOR, type Prediction } from "./model";
import { composeDailyTweet } from "./x";
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
    // 掲載中の週のうち未取得のものをすべて取り込む(初回の backfill や取りこぼしの自動回復を兼ねる)
    const files = recent.slice(0, opts.backfill ?? recent.length);
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
  const creds = xCreds(env);
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

// ---- 日次 ----

export async function ingestDaily(env: Env, d: DailyInput, forcePost = false) {
  const [prev] = (await loadDailyAnalyses(env, 1, d.tradeDate)).slice(-1);
  const a = analyzeDaily(d, prev);
  await saveDaily(env, d, a);
  const learn = await learnAndPredict(env, a);

  const text = composeDailyTweet(a, env.SITE_URL, learn.prediction, learn.lastResult, learn.fg);
  if (!forcePost && (await wasDailyPosted(env, a.tradeDate))) return { analysis: a, learn, post: { status: "already_posted" } };
  const creds = xCreds(env);
  if (env.X_POST_ENABLED !== "true" || !creds) {
    await logDailyPost(env, a.tradeDate, text, "dry_run");
    return { analysis: a, learn, post: { status: "dry_run", text } };
  }
  try {
    const id = await postTweet(text, creds);
    await logDailyPost(env, a.tradeDate, text, "posted", id);
    return { analysis: a, learn, post: { status: "posted", tweetId: id, text } };
  } catch (e) {
    await logDailyPost(env, a.tradeDate, text, "failed", undefined, String(e));
    return { analysis: a, learn, post: { status: "failed", text, error: String(e) } };
  }
}

/**
 * 1) 前営業日までの予測を今日の終値で答え合わせ
 * 2) 検証済み全サンプルで重みとレンジ係数を再学習(自己補正)
 * 3) 補正後のモデルで翌営業日の予測を出して保存
 */
export async function learnAndPredict(env: Env, a: DailyAnalysis) {
  const evaluatedNow = await evaluatePending(env, a.tradeDate, a.spot);
  const ev = await loadEvaluated(env);
  // 一目均衡表の重みは過去データのバックテスト結果を事前仮説にする
  const ichiPrior = a.ichimoku?.prior ?? (await loadMeta<Record<string, number>>(env, "ichimoku_prior")) ?? {};
  if (a.ichimoku) await saveMeta(env, "ichimoku_prior", a.ichimoku.prior);
  const prior = { ...PRIOR, ...ichiPrior };
  const weights = fit(ev.map((e) => ({ x: e.x, y: e.actualSpot > e.spot ? 1 : 0 })), prior);
  const k = calibrateK(ev.map((e) => Math.abs(e.actualSpot - e.spot) / e.sigma1d));
  const m = { ...metrics(ev), ichi: ichiMetrics(ev) }; // 各予測を出した時点の成績(後知恵なし)
  await saveModelLog(env, { tradeDate: a.tradeDate, n: ev.length, weights, prior, k, metrics: m });

  const [weekly] = (await loadAnalyses(env, 1)).slice(-1);
  const fg = await loadSentiment(env, 7, a.tradeDate);
  const fgSet = { nikkei: fg.nikkei?.score ?? null, cnn: fg.cnnHistory[fg.cnnHistory.length - 1]?.score ?? null };
  const ichiIn = a.ichimoku ? { signal: a.ichimoku.result.signal, timeHit: a.ichimoku.result.time.hits.length > 0 } : null;
  const prediction: Prediction = makePrediction(a, features(a, weekly?.score ?? null, fgSet, ichiIn), weights, k, ev.length);
  await savePrediction(env, prediction);

  const last = ev[ev.length - 1];
  const lastResult = last && last.actualDate === a.tradeDate
    ? { tradeDate: last.tradeDate, call: last.call, up: last.actualSpot > last.spot, change: last.actualSpot - last.spot }
    : undefined;
  return { prediction, metrics: m, weights, prior, k, evaluatedNow, lastResult, fg: fgSet };
}

function xCreds(env: Env) {
  return env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET
    ? { apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessSecret: env.X_ACCESS_SECRET }
    : null;
}
