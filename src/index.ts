import { Hono } from "hono";
import { analyze } from "./analysis";
import { loadAnalyses, saveAnalysis, loadDailyAnalyses, loadDailyStrikes, loadEvaluated, loadHistory, loadLatestPrediction, loadModelLogs, loadSentiment, saveSentiment, type SentimentPayload } from "./db";
import type { DailyInput } from "./daily";
import { decodeJpx, parseWeeklyCsv } from "./jpx";
import { analyzeAndPost, ingestDaily, ingestManual, runPipeline } from "./pipeline";
import { renderPage } from "./page";
import { INVESTORS, type Env, type WeekData } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const [history, weeks, dailyHistory, prediction, recent, logs] = await Promise.all([
    loadAnalyses(c.env), loadHistory(c.env, undefined, 1), loadDailyAnalyses(c.env, 30),
    loadLatestPrediction(c.env), loadEvaluated(c.env, 10), loadModelLogs(c.env, 1),
  ]);
  const sentiment = await loadSentiment(c.env, 400);
  const dl = dailyHistory[dailyHistory.length - 1];
  const strikes = dl ? await loadDailyStrikes(c.env, dl.tradeDate, dl.front.month) : [];
  c.header("Cache-Control", "public, max-age=300");
  return c.html(renderPage({
    latest: history[history.length - 1], history, week: weeks[0], siteUrl: c.env.SITE_URL,
    daily: { latest: dl, history: dailyHistory, strikes },
    model: { prediction, recent, logs },
    sentiment,
  }));
});

app.get("/api/latest", async (c) => {
  const list = await loadAnalyses(c.env, 1);
  return list.length ? c.json(list[0]) : c.json({ error: "no data" }, 404);
});
app.get("/api/history", async (c) => c.json(await loadAnalyses(c.env, 104)));
app.get("/api/daily/latest", async (c) => {
  const [a] = (await loadDailyAnalyses(c.env, 1)).slice(-1);
  return a ? c.json(a) : c.json({ error: "no data" }, 404);
});
app.get("/api/daily/history", async (c) => c.json(await loadDailyAnalyses(c.env, 250)));
app.get("/api/sentiment", async (c) => c.json(await loadSentiment(c.env, Number(c.req.query("days") ?? 365))));
app.get("/api/prediction/latest", async (c) => c.json(await loadLatestPrediction(c.env)));
app.get("/api/prediction/track-record", async (c) => {
  const [ev, logs] = await Promise.all([loadEvaluated(c.env, 1000), loadModelLogs(c.env, 1)]);
  return c.json({ metrics: logs[0]?.metrics ?? null, weights: logs[0]?.weights ?? null, k: logs[0]?.k ?? null, evaluated: ev });
});

// ---- 管理 API (Authorization: Bearer ADMIN_TOKEN) ----
app.use("/admin/*", async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token || c.req.header("Authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
  await next();
});

/** JPX 取得→分析→投稿を手動実行。?force=1 で再取得・再投稿, ?backfill=N で新しい順に N 週分まで(省略時は掲載中の未取得週すべて) */
app.post("/admin/run", async (c) =>
  c.json(await runPipeline(c.env, { force: c.req.query("force") === "1", backfill: c.req.query("backfill") ? Number(c.req.query("backfill")) : undefined })),
);

/** JPX のレイアウト変更時などに JSON で週データを直接投入 */
app.post("/admin/ingest", async (c) => {
  const w = await c.req.json<WeekData>();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.weekEnd ?? "") || !Array.isArray(w.flows)) return c.json({ error: "invalid body" }, 400);
  for (const f of w.flows) {
    if (!["call", "put", "fut"].includes(f.product) || !INVESTORS.includes(f.investor)) return c.json({ error: `invalid row ${JSON.stringify(f)}` }, 400);
  }
  await ingestManual(c.env, w);
  return c.json(c.req.query("post") === "1" ? await analyzeAndPost(c.env) : { ok: true });
});

/** 保存済みの週次データを再分析(投稿はしない)。分析ロジック変更後のデプロイ時に使用 */
app.post("/admin/reanalyze", async (c) => {
  const history = await loadHistory(c.env, undefined, 500);
  for (let i = 0; i < history.length; i++) await saveAnalysis(c.env, analyze(history.slice(0, i + 1)));
  return c.json({ weeks: history.length });
});

/** 市場心理指数の投入(GitHub Actions の scripts/daily-fetch.mts から) */
app.post("/admin/ingest-sentiment", async (c) => {
  const s = await c.req.json<SentimentPayload>();
  if (!Array.isArray(s.nikkei)) return c.json({ error: "invalid body" }, 400);
  const n = await saveSentiment(c.env, s);
  const last = s.nikkei[s.nikkei.length - 1];
  return c.json({ rows: n, nikkei: last && { date: last.date, score: last.score, rating: last.rating }, cnn: s.cnn && { date: s.cnn.date, score: s.cnn.score } });
});

/** 日次データ投入(GitHub Actions の scripts/daily-fetch.mts から)。?post=force で再投稿 */
app.post("/admin/ingest-daily", async (c) => {
  const d = await c.req.json<DailyInput>();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.tradeDate ?? "") || !(d.spot > 0) || !Array.isArray(d.strikes) || !d.strikes.length) {
    return c.json({ error: "invalid body" }, 400);
  }
  const r = await ingestDaily(c.env, d, c.req.query("post") === "force");
  const a = r.analysis;
  return c.json({
    tradeDate: a.tradeDate, spot: a.spot, pcr: a.pcr, maxPain: a.maxPain, putWall: a.putWall, callWall: a.callWall, atmIv: a.atmIv,
    prediction: { call: r.learn.prediction.call, pUp: r.learn.prediction.pUp, range: [r.learn.prediction.rangeLo, r.learn.prediction.rangeHi] },
    evaluatedNow: r.learn.evaluatedNow, model: { n: r.learn.metrics.n, hitRate: r.learn.metrics.hitRate, rangeRate: r.learn.metrics.rangeRate, k: r.learn.k },
    post: r.post.status,
  });
});

/** JPX の週次 CSV をボディで送って解析結果だけ確認(保存しない) */
app.post("/admin/parse-preview", async (c) => c.json(parseWeeklyCsv(decodeJpx(await c.req.arrayBuffer()))));

app.post("/admin/clear-sample", async (c) => {
  await c.env.DB.prepare("DELETE FROM weeks WHERE is_sample = 1").run();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM flows WHERE week_end NOT IN (SELECT week_end FROM weeks)"),
    c.env.DB.prepare("DELETE FROM analyses WHERE week_end NOT IN (SELECT week_end FROM weeks)"),
  ]);
  return c.json({ ok: true });
});

export default {
  fetch: app.fetch,
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runPipeline(env).then((r) => console.log(JSON.stringify(r))));
  },
} satisfies ExportedHandler<Env>;
