import { analyzeDaily, type DailyAnalysis, type DailyInput } from "./daily";
import { evaluatePending, loadAnalyses, loadMeta, saveMeta, loadSentiment, loadDailyAnalyses, loadDailyStrikes, loadEvaluated, logDailyPost, saveDaily, saveModelLog, savePrediction, wasDailyPosted } from "./db";
import { calibrateK, features, fit, ichiMetrics, makePrediction, metrics, PRIOR, sqFeatures, type Features, type Prediction } from "./model";
import { configLabel, DEFAULT_CONFIG, mask, type ModelConfig } from "./tuning";
import { composeDailyTweet, composeFarTweet } from "./x";
import { analyze, WEIGHTS } from "./analysis";
import type { WeeklyWeights } from "./weekly-tuning";
import { hasWeek, loadHistory, logPost, saveAnalysis, saveWeek, wasPosted } from "./db";
import { discoverLatestFiles, fetchWeek, weekFromFileName } from "./jpx";
import type { Env, WeekData } from "./types";
import { squeezeRaw, squeezeScore, upsertHist, type SqueezeHist } from "./squeeze";
import { composeFarMail, farQuotes, farSignals, sendMail, type AlertLogItem } from "./alerts";
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

/** 週次スコアの重み(学習済みがあればそれ、なければ事前仮説) */
export async function weeklyWeights(env: Env) {
  return (await loadMeta<WeeklyWeights>(env, "weekly_weights")) ?? WEIGHTS;
}

export async function analyzeAndPost(env: Env, forcePost = false) {
  const history = await loadHistory(env);
  if (!history.length) return { analyzed: undefined, post: undefined };
  const w = await weeklyWeights(env);
  // 全週を再分析(重み変更時も履歴が整合する)
  for (let i = 0; i < history.length; i++) await saveAnalysis(env, analyze(history.slice(0, i + 1), w));
  const latest = analyze(history, w);
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
  if (d.vi) a.vi = d.vi;
  if (d.viHist?.length) await saveMeta(env, "vi_hist", d.viHist);
  // 踏み上げ恐怖指数: 期近の建玉と前日分析から生値 → 過去の履歴と比べて点数化
  try {
    const raw = squeezeRaw(a, prev, d.strikes.filter((s) => s.month === a.front.month));
    const hist = (await loadMeta<SqueezeHist[]>(env, "squeeze_hist")) ?? [];
    a.squeeze = squeezeScore(raw, hist.filter((h) => h.date < a.tradeDate));
    await saveMeta(env, "squeeze_hist", upsertHist(hist, raw, a.squeeze));
  } catch (e) { console.log(`squeeze: ${e}`); }
  // ファーOTM のプット・コールの価格変化(前日比)。急騰・急落ならメール
  try {
    const rows = d.strikes.filter((s) => s.month === a.front.month);
    const prevRows = prev ? await loadDailyStrikes(env, prev.tradeDate, a.front.month) : [];
    a.far = farQuotes(rows, prevRows, a.spot);
    const sig = farSignals(a.far);
    if (sig.length && !(await loadMeta<string[]>(env, "far_alerted"))?.includes(a.tradeDate)) {
      const m = composeFarMail(sig, a.tradeDate, a.spot, a.front.month, env.SITE_URL);
      let ok = false;
      if (env.RESEND_API_KEY && env.ALERT_TO) ok = (await sendMail(env.RESEND_API_KEY, env.ALERT_TO, m.subject, m.text)).ok;
      await tryTweet(env, composeFarTweet(sig, a.tradeDate, env.SITE_URL));
      await saveMeta(env, "far_alerted", [...((await loadMeta<string[]>(env, "far_alerted")) ?? []), a.tradeDate].slice(-30));
      const log = (await loadMeta<AlertLogItem[]>(env, "alert_log")) ?? [];
      await saveMeta(env, "alert_log", [...log, ...sig.map((x) => ({ at: Date.now(), tf: "daily" as const, side: (x.ratio! >= 1 ? "far-up" : "far-down") as AlertLogItem["side"], close: x.px, level: x.strike, volRatio: x.ratio!, sent: ok, text: `${x.side === "put" ? "プット" : "コール"} ${x.strike.toLocaleString("ja-JP")} ${x.prevPx!.toLocaleString("ja-JP")}→${x.px.toLocaleString("ja-JP")}円(${x.ratio!.toFixed(1)}倍)` }))].slice(-100));
    }
  } catch (e) { console.log(`far: ${e}`); }
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
  // 自動改善で選ばれた設定(リッジ・使う特徴量・しきい値)。GitHub Actions が毎日見直す(src/tuning.ts)
  const cfg = (await loadMeta<ModelConfig>(env, "model_config")) ?? DEFAULT_CONFIG;
  // 踏み上げ恐怖指数の導入前に出した予測にも、履歴から特徴量を補う
  const sqHist = new Map(((await loadMeta<SqueezeHist[]>(env, "squeeze_hist")) ?? []).map((h) => [h.date, h]));
  const xOf = (e: { tradeDate: string; x: Features }) => {
    const h = sqHist.get(e.tradeDate);
    const x = { ...e.x, ...(e.x.sqPut == null && h ? sqFeatures({ put: h.putIndex, call: h.callIndex }) : {}) } as Features;
    return mask(x, cfg.off);
  };
  const weights = fit(ev.map((e) => ({ x: xOf(e), y: e.actualSpot > e.spot ? 1 : 0 })), prior, cfg.ridge);
  const k = calibrateK(ev.map((e) => Math.abs(e.actualSpot - e.spot) / e.sigma1d));
  const m = { ...metrics(ev), ichi: ichiMetrics(ev) }; // 各予測を出した時点の成績(後知恵なし)
  await saveModelLog(env, { tradeDate: a.tradeDate, n: ev.length, weights, prior, k, metrics: m });

  const [weekly] = (await loadAnalyses(env, 1)).slice(-1);
  const fg = await loadSentiment(env, 7, a.tradeDate);
  const fgSet = { nikkei: fg.nikkei?.score ?? null, cnn: fg.cnnHistory[fg.cnnHistory.length - 1]?.score ?? null };
  const ichiIn = a.ichimoku ? { signal: a.ichimoku.result.signal, timeHit: a.ichimoku.result.time.hits.length > 0 } : null;
  const prediction: Prediction = makePrediction(a, mask(features(a, weekly?.score ?? null, fgSet, ichiIn), cfg.off), weights, k, ev.length, cfg.threshold);
  prediction.threshold = cfg.threshold;
  prediction.config = configLabel(cfg);
  await savePrediction(env, prediction);

  const last = ev[ev.length - 1];
  const lastResult = last && last.actualDate === a.tradeDate
    ? { tradeDate: last.tradeDate, call: last.call, up: last.actualSpot > last.spot, change: last.actualSpot - last.spot }
    : undefined;
  return { prediction, metrics: m, weights, prior, k, evaluatedNow, lastResult, fg: fgSet };
}

/** X 投稿が有効なら投稿して tweet id を返す。無効・失敗は null */
export async function tryTweet(env: Env, text: string): Promise<string | null> {
  const creds = xCreds(env);
  if (env.X_POST_ENABLED !== "true" || !creds) return null;
  try { return await postTweet(text, creds); } catch (e) { console.log(`tweet failed: ${String(e).slice(0, 200)}`); return null; }
}

function xCreds(env: Env) {
  return env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET
    ? { apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessSecret: env.X_ACCESS_SECRET }
    : null;
}

/** 保存済みの日次データから踏み上げ恐怖指数の履歴を作り直し、各日の分析にも書き戻す */
export async function rebuildSqueeze(env: Env) {
  const dates = (await env.DB.prepare("SELECT trade_date FROM daily_snapshots ORDER BY trade_date").all<{ trade_date: string }>()).results.map((r) => r.trade_date);
  let hist: SqueezeHist[] = [];
  let prev: DailyAnalysis | undefined;
  for (const date of dates) {
    const row = await env.DB.prepare("SELECT detail_json FROM daily_snapshots WHERE trade_date = ?").bind(date).first<{ detail_json: string }>();
    if (!row) continue;
    const a = JSON.parse(row.detail_json) as DailyAnalysis;
    const strikes = await loadDailyStrikes(env, date, a.front.month);
    const raw = squeezeRaw(a, prev, strikes);
    a.squeeze = squeezeScore(raw, hist);
    hist = upsertHist(hist, raw, a.squeeze);
    await env.DB.prepare("UPDATE daily_snapshots SET detail_json = ? WHERE trade_date = ?").bind(JSON.stringify(a), date).run();
    prev = a;
  }
  await saveMeta(env, "squeeze_hist", hist);
  const last = hist[hist.length - 1];
  return { days: hist.length, last: last && { date: last.date, put: Math.round(last.putIndex), call: Math.round(last.callIndex) } };
}
