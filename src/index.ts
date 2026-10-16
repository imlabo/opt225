import { Hono } from "hono";
import { loadAnalyses, loadHistory } from "./db";
import { parseWorkbook } from "./jpx";
import { analyzeAndPost, ingestManual, runPipeline } from "./pipeline";
import { renderPage } from "./page";
import { INVESTORS, type Env, type WeekData } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.get("/", async (c) => {
  const [history, weeks] = await Promise.all([loadAnalyses(c.env), loadHistory(c.env, undefined, 1)]);
  c.header("Cache-Control", "public, max-age=300");
  return c.html(renderPage({ latest: history[history.length - 1], history, week: weeks[0], siteUrl: c.env.SITE_URL }));
});

app.get("/api/latest", async (c) => {
  const list = await loadAnalyses(c.env, 1);
  return list.length ? c.json(list[0]) : c.json({ error: "no data" }, 404);
});
app.get("/api/history", async (c) => c.json(await loadAnalyses(c.env, 104)));

// ---- 管理 API (Authorization: Bearer ADMIN_TOKEN) ----
app.use("/admin/*", async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token || c.req.header("Authorization") !== `Bearer ${token}`) return c.json({ error: "unauthorized" }, 401);
  await next();
});

/** JPX 取得→分析→投稿を手動実行。?force=1 で再取得・再投稿, ?backfill=N で過去N週分 */
app.post("/admin/run", async (c) =>
  c.json(await runPipeline(c.env, { force: c.req.query("force") === "1", backfill: Number(c.req.query("backfill") ?? 1) })),
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

/** Excel をアップロードして解析結果だけ確認(保存しない) */
app.post("/admin/parse-preview", async (c) => c.json(parseWorkbook(await c.req.arrayBuffer())));

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
