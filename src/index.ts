import { judgeAt, energyAt, VERDICT_LABEL, setJudgeModel, judgeAdj, reversalOk, type JudgeModel } from "./technicals";
import { collectAndResolve, fitJudgeModel, watchFrom, LEARN_EVERY_MS, MAX_SAMPLES, REFIT_MS, current, outcome, type Watch, type Sample } from "./judge-learn";
import { Hono } from "hono";
import { analyze } from "./analysis";
import { loadAnalyses, saveAnalysis, loadDailyAnalyses, loadDailyStrikes, loadEvaluated, loadHistory, loadLatestPrediction, loadMeta, loadModelLogs, loadSentiment, saveMeta, saveSentiment, updateDailyIchimoku, type SentimentPayload } from "./db";
import type { DailyInput, IchimokuPayload } from "./daily";

/** /admin/ingest-ichimoku のボディ・fg_meta "ichimoku_latest" の中身 */
interface IchimokuLatest { tradeDate: string; close: number; ichimoku: IchimokuPayload }
import { decodeJpx, parseWeeklyCsv } from "./jpx";
import { analyzeAndPost, ingestDaily, ingestManual, rebuildSqueeze, runPipeline, tryTweet, weeklyWeights } from "./pipeline";
import { composeAlertTweet, composeFollowTweet } from "./x";
import type { ViPoint } from "./vi";
import type { WeeklyReport, WeeklyWeights } from "./weekly-tuning";
import { COOLDOWN_BY_TF, LOOKBACK, FOLLOW_LABEL, composeFollowMail, detectLevelBreak, followUp, composeMail, detect, levelsFrom, parseIntraday, scanClimax, sendMail, SYMBOL, TIMEFRAMES, type AlertLogItem, type AlertState, type FollowSignal, type IBar, type Levels, type Pending, type Signal, type Tf, type VolProfile } from "./alerts";
import type { SqueezeHist } from "./squeeze";
import { DEFAULT_CONFIG, type ModelConfig, type TuningReport } from "./tuning";
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
  // JPX 未公表の日でも一目均衡表は最新足(Yahoo 補完)で更新されている場合がある
  const [latestIchi, squeezeHist, modelConfig, tuningLog] = await Promise.all([
    loadMeta<IchimokuLatest>(c.env, "ichimoku_latest"), loadMeta<SqueezeHist[]>(c.env, "squeeze_hist"),
    loadMeta<ModelConfig>(c.env, "model_config"), loadMeta<TuningReport[]>(c.env, "model_tuning_log"),
  ]);
  const weeklyReport = await loadMeta<WeeklyReport>(c.env, "weekly_tuning");
  const alertLog = (await loadMeta<AlertLogItem[]>(c.env, "alert_log")) ?? [];
  const viHist = (await loadMeta<ViPoint[]>(c.env, "vi_hist")) ?? [];
  const judgeModel = await loadMeta<JudgeModel>(c.env, "judge_model");
  const ichimoku = latestIchi && (!dl?.ichimoku || latestIchi.tradeDate > dl.ichimoku.result.date)
    ? { ...latestIchi.ichimoku, basis: dl?.ichimoku?.basis ?? 0 }
    : dl?.ichimoku;
  c.header("Cache-Control", "public, max-age=300");
  return c.html(renderPage({
    latest: history[history.length - 1], history, week: weeks[0], siteUrl: c.env.SITE_URL,
    daily: { latest: dl, history: dailyHistory, strikes, squeezeHist: squeezeHist ?? [], alertLog, viHist, judgeModel }, ichimoku,
    model: { prediction, recent, logs, config: modelConfig ?? DEFAULT_CONFIG, tuning: tuningLog ?? [] },
    weekly: weeklyReport ?? undefined,
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
app.get("/api/model/config", async (c) => {
  const [config, log] = await Promise.all([loadMeta<ModelConfig>(c.env, "model_config"), loadMeta<TuningReport[]>(c.env, "model_tuning_log")]);
  return c.json({ config: config ?? DEFAULT_CONFIG, log: log ?? [] });
});
app.get("/api/vi", async (c) => c.json((await loadMeta<ViPoint[]>(c.env, "vi_hist")) ?? []));
app.get("/api/squeeze", async (c) => c.json((await loadMeta<SqueezeHist[]>(c.env, "squeeze_hist")) ?? []));
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
  const w = await weeklyWeights(c.env);
  for (let i = 0; i < history.length; i++) await saveAnalysis(c.env, analyze(history.slice(0, i + 1), w));
  return c.json({ weeks: history.length, weights: w });
});

/** 週次スコアの答え合わせ結果と学習した重みを保存し、全週を再分析(GitHub Actions の scripts/daily-fetch.mts から) */
app.post("/admin/weekly-config", async (c) => {
  const b = await c.req.json<{ weights: WeeklyWeights; report: WeeklyReport }>();
  if (!b.weights || !INVESTORS.every((i) => Number.isFinite(b.weights[i]))) return c.json({ error: "invalid body" }, 400);
  await saveMeta(c.env, "weekly_weights", b.weights);
  if (b.report) await saveMeta(c.env, "weekly_tuning", b.report);
  const history = await loadHistory(c.env, undefined, 500);
  for (let i = 0; i < history.length; i++) await saveAnalysis(c.env, analyze(history.slice(0, i + 1), b.weights));
  return c.json({ ok: true, weeks: history.length, changed: b.report?.changed ?? false, note: b.report?.note });
});
app.get("/api/weekly/config", async (c) => c.json({ weights: await weeklyWeights(c.env), report: await loadMeta<WeeklyReport>(c.env, "weekly_tuning") }));

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

/** 一目均衡表だけの更新(JPX 日次が未公表のとき daily-fetch から)。同日の日次データがあればそちらも差し替える */
app.post("/admin/ingest-ichimoku", async (c) => {
  const b = await c.req.json<IchimokuLatest>();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.tradeDate ?? "") || !b.ichimoku?.result || b.ichimoku.result.date !== b.tradeDate) return c.json({ error: "invalid body" }, 400);
  await saveMeta(c.env, "ichimoku_latest", b);
  if (b.ichimoku.prior) await saveMeta(c.env, "ichimoku_prior", b.ichimoku.prior);
  const updated = await updateDailyIchimoku(c.env, b.tradeDate, b.ichimoku);
  return c.json({ tradeDate: b.tradeDate, judgment: b.ichimoku.result.judgment, score: b.ichimoku.result.score, barsSource: b.ichimoku.barsSource, filled: b.ichimoku.filled ?? [], dailyUpdated: updated });
});

/** 予測モデルの自動改善の結果を保存(GitHub Actions の scripts/daily-fetch.mts から、日次データ投入の直前に) */
app.post("/admin/model-config", async (c) => {
  const b = await c.req.json<{ config: ModelConfig; report: TuningReport }>();
  if (!b.config || !(b.config.ridge > 0) || !(b.config.threshold > 0.5 && b.config.threshold < 1) || !Array.isArray(b.config.off)) return c.json({ error: "invalid body" }, 400);
  await saveMeta(c.env, "model_config", b.config);
  if (b.report) {
    const log = (await loadMeta<TuningReport[]>(c.env, "model_tuning_log")) ?? [];
    await saveMeta(c.env, "model_tuning_log", [...log.filter((r) => r.date !== b.report.date), b.report].sort((x, y) => x.date.localeCompare(y.date)).slice(-120));
  }
  return c.json({ ok: true, changed: b.report?.changed ?? false, note: b.report?.note });
});

/** 踏み上げ恐怖指数の履歴を保存済み日次データから作り直す(デプロイ時に自動実行) */
app.post("/admin/rebuild-squeeze", async (c) => c.json(await rebuildSqueeze(c.env)));

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

/** MT5(XS)から VPS のスクリプトで送られてくる足。tf ごとに fg_meta "mt5_bars_<tf>" */
interface PushedBars { symbol: string; receivedAt: number; bars: IBar[] }
const MT5_FRESH_MS = 3 * 60 * 1000; // これより古ければ Yahoo に切り替え

async function yahooBars(tf: Tf, range: string): Promise<IBar[]> {
  const r = await fetch(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL)}?interval=${tf}&range=${range}`, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", Accept: "application/json" } });
  if (!r.ok) throw new Error(`Yahoo HTTP ${r.status}`);
  return parseIntraday(await r.json());
}

/** MT5 の価格と先物(Yahoo NKD=F)の差: 同じ時刻の 5分足終値の差の中央値。CFD が現物連動でも先物連動でも損益分岐を合わせるため */
async function mt5Offset(env: Env, mt5: IBar[]): Promise<number> {
  const cached = await loadMeta<{ at: number; offset: number }>(env, "mt5_offset");
  if (cached && Date.now() - cached.at < 30 * 60 * 1000) return cached.offset;
  try {
    const y = new Map((await yahooBars("5m", "2d")).map((b) => [b.t, b.close]));
    const diffs = mt5.filter((b) => y.has(b.t)).map((b) => b.close - y.get(b.t)!).sort((a, b) => a - b);
    if (diffs.length >= 5) {
      const offset = diffs[Math.floor(diffs.length / 2)];
      await saveMeta(env, "mt5_offset", { at: Date.now(), offset, n: diffs.length });
      return offset;
    }
  } catch { /* Yahoo が取れなければ前回値 */ }
  return cached?.offset ?? 0;
}

/** 足の取得: MT5 から新しい足が届いていればそれ(リアルタイム)、なければ Yahoo(10〜20 分遅れのことがある) */
async function getBars(env: Env, tf: Tf, range: string): Promise<{ bars: IBar[]; source: "mt5" | "yahoo"; symbol: string; offset: number; profile?: VolProfile }> {
  const p = await loadMeta<PushedBars>(env, `mt5_bars_${tf}`);
  if (p && Date.now() - p.receivedAt < MT5_FRESH_MS && p.bars.length > LOOKBACK + 2) {
    const m5 = tf === "5m" ? p.bars : (await loadMeta<PushedBars>(env, "mt5_bars_5m"))?.bars ?? p.bars;
    const profile = (await loadMeta<{ profile: VolProfile }>(env, `mt5_vprof_${tf}`))?.profile;
    return { bars: p.bars, source: "mt5", symbol: p.symbol, offset: await mt5Offset(env, m5), profile };
  }
  return { bars: await yahooBars(tf, range), source: "yahoo", symbol: SYMBOL, offset: 0 };
}

/** 損益分岐(先物換算)を MT5 の価格水準に合わせる */
const shiftLevels = (lv: Levels, offset: number): Levels => (offset ? { ...lv, putLevel: lv.putLevel != null ? lv.putLevel + offset : null, callLevel: lv.callLevel != null ? lv.callLevel + offset : null } : lv);

/** 天井・大底候補アラート: 先物の 5分/15分/60分足を取得して判定し、該当があればメール */
async function runAlerts(env: Env, opts: { send?: boolean; force?: boolean } = {}): Promise<{ signals: Signal[]; follows: FollowSignal[]; sent?: boolean; note: string; mail?: unknown }> {
  const send = opts.send ?? true;
  const state = (await loadMeta<AlertState>(env, "alert_state")) ?? { lastSent: {} };
  // メール設定が入った最初の実行で、テストメールを 1 通送って疎通を記録する
  if (send && env.RESEND_API_KEY && env.ALERT_TO && !(await loadMeta<unknown>(env, "alert_test_sent"))) {
    const r = await sendMail(env.RESEND_API_KEY, env.ALERT_TO, "【opt225】アラート送信テスト", `天井・大底候補アラートとファーOTMの急騰・急落アラートのメール送信が有効になりました。

${env.SITE_URL}`);
    await saveMeta(env, "alert_test_sent", { at: Date.now(), ok: r.ok, status: r.status, body: r.body });
  }
  const [dl] = (await loadDailyAnalyses(env, 1)).slice(-1);
  const lv = levelsFrom(dl);
  // 判定の自己改善: 学習済みモデルを読み込み、15 分ごとに答え合わせと学習をする
  let model = await loadMeta<JudgeModel>(env, "judge_model");
  setJudgeModel(model);
  const learnNow = send && Date.now() - (state.lastLearn ?? 0) > LEARN_EVERY_MS;
  let watch = learnNow ? current((await loadMeta<Watch[]>(env, "judge_watch")) ?? []) : [];
  const samples = learnNow ? current((await loadMeta<Sample[]>(env, "judge_samples")) ?? []) : [];
  if (model && (model as { v?: number }).v !== 3) { model = null; setJudgeModel(null); } // 定義を変えたので学習し直す
  let newSamples = 0;
  const checked: NonNullable<AlertState["lastRun"]>["checked"] = {};
  const signals: Signal[] = [];
  const follows: FollowSignal[] = [];
  let pending = state.pending ?? [];
  let note = "";
  if (!lv) note = "no daily analysis";
  else {
    for (const { tf, label, range } of TIMEFRAMES) {
      try {
        const src = await getBars(env, tf, range);
        const lab = src.source === "mt5" ? `${label}(MT5)` : label;
        const lvx = shiftLevels(lv, src.offset);
        const d = detect(tf, lab, src.bars, lvx, Date.now(), src.profile);
        if (src.source === "mt5" && !note.includes("mt5")) note += "src mt5; ";
        checked[tf] = d.checked && { t: d.checked.t, close: d.checked.close, volRatio: 0 };
        if (d.signal) {
          signals.push(d.signal);
          // 大底候補・天井候補は、その後の足で「反転」か「ブレイク」かを判定するため記録(進行中の足は確定してから)
          const b = d.signal.bar;
          if (!d.signal.inProgress && !pending.some((p) => p.tf === tf && p.side === d.signal!.side && p.t === b.t))
            pending.push({ tf, side: d.signal.side, t: b.t, open: b.open, high: b.high, low: b.low, close: b.close, level: d.signal.level, label: lab });
        }
        // 判定待ちの決着
        const keep: Pending[] = [];
        for (const p of pending) {
          if (p.tf !== tf) { keep.push(p); continue; }
          const f = followUp(p, src.bars, Date.now(), src.profile);
          if (f.signal) follows.push(f.signal);
          else if (!f.expired) keep.push(p);
        }
        pending = keep;
        // 損益分岐ブレイク
        const lb = detectLevelBreak(tf, lab, src.bars, lvx, Date.now(), src.profile);
        if (lb) follows.push(lb);
        if (learnNow) {
          const r = collectAndResolve(tf, src.bars, src.profile, watch, samples);
          watch = r.watch; samples.push(...r.resolved); newSamples += r.resolved.length;
        }
      } catch (e) { note += `${tf}: ${String(e).slice(0, 80)}; `; checked[tf] = null; }
    }
  }
  state.pending = pending.slice(-30);
  if (learnNow) {
    state.lastLearn = Date.now();
    const keepS = samples.slice(-MAX_SAMPLES);
    if (newSamples) await saveMeta(env, "judge_samples", keepS);
    // 学習(重い計算)は 1 時間に 1 回まで。Worker の CPU 制限に収めるため直近 FIT_ROWS 件で当てる
    if ((newSamples || state.learnDirty) && Date.now() - (model?.updatedAt ?? 0) > REFIT_MS || !model) {
      model = fitJudgeModel(keepS);
      setJudgeModel(model);
      await saveMeta(env, "judge_model", model);
      state.learnDirty = false;
    } else if (newSamples) state.learnDirty = true;
  }
  const addWatch = (w: Watch | null) => { if (w && !watch.some((x) => x.tf === w.tf && x.t === w.t && x.kind === w.kind)) watch.push(w); };
  // 同じ時間足・向きは時間足ごとの間隔をあけ、同じ足は二度送らない
  const now = Date.now();
  // 投げ度「低」(含み損の投げ・行き過ぎの材料が乏しい)は送らず、記録だけ残す
  // しきい値は 40 + 当たり率に応じた上乗せ(当たりが悪いほど厳しく)
  const capMin = 40 + judgeAdj().climax;
  // 天井・大底は「反転の決め手」があり、反転が継続を上回るときだけ(流れに乗ったブレイクの初動は送らない)
  const whyNot = (s: Signal) => (!s.judge ? "" : s.judge.capitulation < capMin ? `投げ度 ${s.judge.capitulation}(基準 ${capMin} 未満)` : reversalOk(s.judge, judgeAdj().climax).why);
  const isWeak = (s: Signal) => !!whyNot(s);
  const weak = signals.filter((s) => isWeak(s) && !opts.force);
  const fresh = signals.filter((s) => (opts.force || !isWeak(s)) && (opts.force || (now - (state.lastSent[`${s.tf}:${s.side}`] ?? 0) > COOLDOWN_BY_TF[s.tf] * 60 * 1000 && !state.lastSent[`${s.tf}:${s.side}:${s.bar.t}`])));
  const weakNew = weak.filter((s) => !s.inProgress && !state.lastSent[`${s.tf}:${s.side}:${s.bar.t}:weak`]);
  if (weakNew.length && send) {
    for (const s of weakNew) state.lastSent[`${s.tf}:${s.side}:${s.bar.t}:weak`] = now;
    const log = (await loadMeta<AlertLogItem[]>(env, "alert_log")) ?? [];
    await saveMeta(env, "alert_log", [...log, ...weakNew.map((s) => ({ at: now, tf: s.tf, side: s.side, close: s.bar.close, level: s.level, volRatio: s.volRatio, sent: false, text: `通知せず: ${whyNot(s)}(反転${s.judge?.reversal ?? "-"}/継続${s.judge?.continuation ?? "-"})` }))].slice(-100));
  }
  let sent: boolean | undefined, mail: unknown;
  if (fresh.length && send && lv) {
    if (!env.RESEND_API_KEY || !env.ALERT_TO) { note += "RESEND_API_KEY/ALERT_TO not set; "; sent = false; }
    else {
      const m = composeMail(fresh, lv, env.SITE_URL);
      mail = await sendMail(env.RESEND_API_KEY, env.ALERT_TO, m.subject, m.text);
      sent = (mail as { ok: boolean }).ok;
    }
    const tweetId = await tryTweet(env, composeAlertTweet(fresh, env.SITE_URL));
    if (sent || tweetId) for (const s of fresh) { state.lastSent[`${s.tf}:${s.side}`] = now; state.lastSent[`${s.tf}:${s.side}:${s.bar.t}`] = now; }
    for (const s of fresh) if (!s.inProgress) addWatch(watchFrom(s.tf, s.bar.t, `alert-${s.side}`, s.judge, s.bar.close, !!(sent || tweetId), s.side === "top" ? s.bar.high : s.bar.low));
    // 古い足のキーは掃除
    for (const k of Object.keys(state.lastSent)) if (k.split(":").length >= 3 && now - state.lastSent[k] > 864e5) delete state.lastSent[k];
    const log = (await loadMeta<AlertLogItem[]>(env, "alert_log")) ?? [];
    await saveMeta(env, "alert_log", [...log, ...fresh.map((s) => ({ at: now, tf: s.tf, side: s.side, close: s.bar.close, level: s.level, volRatio: s.volRatio, sent: !!sent, text: s.judge ? `投げ度${s.judge.capitulation}(${s.tier}) 反転${s.judge.reversal} 継続${s.judge.continuation}` : undefined }))].slice(-100));
  }
  // ブレイク・反転確認(同じ時間足・種類は時間足ごとの間隔をあけ、同じ足は一度だけ)
  const freshF = follows.filter((s) => opts.force || (now - (state.lastSent[`${s.tf}:${s.kind}`] ?? 0) > COOLDOWN_BY_TF[s.tf] * 60 * 1000 && !state.lastSent[`${s.tf}:${s.kind}:${s.bar.t}`]));
  if (freshF.length && send && lv) {
    let ok = false;
    if (env.RESEND_API_KEY && env.ALERT_TO) {
      const m = composeFollowMail(freshF, lv, env.SITE_URL);
      ok = (await sendMail(env.RESEND_API_KEY, env.ALERT_TO, m.subject, m.text)).ok;
    }
    const tid = await tryTweet(env, composeFollowTweet(freshF));
    if (ok || tid) for (const s of freshF) { state.lastSent[`${s.tf}:${s.kind}`] = now; state.lastSent[`${s.tf}:${s.kind}:${s.bar.t}`] = now; }
    for (const s of freshF) addWatch(watchFrom(s.tf, s.bar.t, s.kind, s.judge, s.bar.close, !!(ok || tid), s.ref ? (s.ref.side === "top" ? s.ref.high : s.ref.low) : undefined));
    const log = (await loadMeta<AlertLogItem[]>(env, "alert_log")) ?? [];
    await saveMeta(env, "alert_log", [...log, ...freshF.map((s) => ({ at: now, tf: s.tf, side: s.kind, close: s.bar.close, level: s.level, volRatio: s.volRatio, sent: ok, text: `${FOLLOW_LABEL[s.kind]} 終${s.bar.close.toLocaleString("ja-JP", { maximumFractionDigits: 0 })}${s.judge ? ` 反転${s.judge.reversal}/継続${s.judge.continuation}` : ""}` }))].slice(-100));
  }
  state.lastRun = { at: now, ok: !note, note: note || `ok (${signals.length} climax, ${follows.length} follow/break, ${pending.length} pending)`, checked };
  // 見張り(答え合わせ待ち)を保存。通知があったときは学習の回でなくても読み直して足す
  if (learnNow) await saveMeta(env, "judge_watch", watch);
  else if (watch.length) {
    const cur = (await loadMeta<Watch[]>(env, "judge_watch")) ?? [];
    for (const w of watch) if (!cur.some((x) => x.tf === w.tf && x.t === w.t && x.kind === w.kind)) cur.push(w);
    await saveMeta(env, "judge_watch", cur.slice(-300));
  }
  await saveMeta(env, "alert_state", state);
  return { signals: fresh, follows: freshF, sent, note: state.lastRun.note, mail };
}

/** テクニカル判定の学習状況(当たり率・通知の厳しさ・件数) */
app.get("/api/judge/model", async (c) => {
  const [m, w, smp] = await Promise.all([loadMeta<JudgeModel>(c.env, "judge_model"), loadMeta<Watch[]>(c.env, "judge_watch"), loadMeta<Sample[]>(c.env, "judge_samples")]);
  c.header("Cache-Control", "no-store");
  return c.json({ model: m, watching: w?.length ?? 0, samples: smp?.length ?? 0, recent: (smp ?? []).filter((s) => s.kind !== "climax").slice(-20).map(({ x: _x, ...r }) => r) });
});
/** 今の分足で、天井・大底候補を新しい慎重判定に通した場合の答え合わせ(検証用) */
app.get("/api/judge/backtest", async (c) => {
  const tf = (TIMEFRAMES.find((t) => t.tf === c.req.query("tf")) ?? TIMEFRAMES[0]);
  const src = await getBars(c.env, tf.tf, tf.range);
  const [dl] = (await loadDailyAnalyses(c.env, 1)).slice(-1);
  const base = levelsFrom(dl);
  const lv = base && shiftLevels(base, src.offset);
  const done = src.bars.filter((b) => b.volume > 0);
  const rows = scanClimax(done, lv, tf.tf, src.profile).map((x) => {
    const i = done.findIndex((b) => b.t === x.t);
    const j = judgeAt(done, i, tf.tf, x.side === "bottom" ? "down" : "up", src.profile);
    const y = j ? outcome(done, i, j.dir, tf.tf, done[i].close, j.tech.atr) : null; // 極値はその足の高値・安値
    const gate = j ? (j.capitulation < 40 ? `投げ度${j.capitulation}` : reversalOk(j).why) : "no data";
    return { t: x.t, side: x.side, near: x.near, close: done[i].close, cap: j?.capitulation, rev: j?.reversal, con: j?.continuation, send: !gate, why: gate, y };
  });
  const sum = (xs: typeof rows) => ({ n: xs.length, rev: xs.filter((r) => r.y === "rev").length, con: xs.filter((r) => r.y === "con").length, none: xs.filter((r) => r.y === "none").length, open: xs.filter((r) => r.y == null).length });
  c.header("Cache-Control", "no-store");
  return c.json({ tf: tf.tf, source: src.source, sendable: sum(rows.filter((r) => r.send)), suppressed: sum(rows.filter((r) => !r.send)), rows });
});
/** 判定だけ実行(送信しない)。Yahoo からの取得や判定が動いているかの確認用 */
app.get("/api/alerts/check", async (c) => {
  try { const r = await runAlerts(c.env, { send: false }); return c.json({ note: r.note, signals: r.signals.map((s) => ({ tf: s.tf, side: s.side, close: s.bar.close, level: s.level, volRatio: s.volRatio })) }); }
  catch (e) { return c.json({ error: String(e).slice(0, 300) }, 500); }
});
/** 先物の分足(Yahoo Finance NKD=F)+損益分岐+クライマックス判定。ページのチャート用。60 秒キャッシュ */
app.get("/api/intraday", async (c) => {
  const tf = (TIMEFRAMES.find((t) => t.tf === c.req.query("tf")) ?? TIMEFRAMES[0]);
  try {
    const src = await getBars(c.env, tf.tf, tf.range);
    const [dl] = (await loadDailyAnalyses(c.env, 1)).slice(-1);
    const base = levelsFrom(dl);
    const lv = base && shiftLevels(base, src.offset);
    c.header("Cache-Control", `public, max-age=${src.source === "mt5" ? 20 : 60}`);
    setJudgeModel(await loadMeta<JudgeModel>(c.env, "judge_model"));
    const done = src.bars.filter((b) => b.volume > 0);
    const li = done.length - 1;
    const pick = (j: ReturnType<typeof judgeAt>) => j && { verdict: j.verdict, label: VERDICT_LABEL[j.verdict], capitulation: j.capitulation, reversal: j.reversal, continuation: j.continuation, reasons: j.reasons, rsi: Math.round(j.tech.rsi), stretch: +j.tech.stretch.toFixed(2), divergence: j.tech.divergence };
    const climax = scanClimax(src.bars, lv, tf.tf, src.profile).map((x) => {
      const i = done.findIndex((b) => b.t === x.t);
      const j = i >= 0 ? judgeAt(done, i, tf.tf, x.side === "bottom" ? "down" : "up", src.profile) : null;
      return { ...x, verdict: j?.verdict ?? null, capitulation: j?.capitulation ?? null };
    });
    const judge = li >= 30 ? { t: done[li].t, down: pick(judgeAt(done, li, tf.tf, "down", src.profile)), up: pick(judgeAt(done, li, tf.tf, "up", src.profile)), energy: energyAt(done, li, tf.tf, src.profile) } : null;
    return c.json({ symbol: src.symbol, source: src.source, tf: tf.tf, label: tf.label, bars: src.bars.slice(-400), levels: lv, climax, judge });
  } catch (e) { return c.json({ error: String(e).slice(0, 200) }, 500); }
});
/**
 * MT5(XS)の足を受け取る(VPS の scripts/mt5_push.py から 20 秒ごと)。
 * body: { symbol, bars: { "5m": [[t, o, h, l, c, v], ...], "15m": [...], "60m": [...] } }(t は UTC の UNIX 秒、v はティック出来高)
 * 受け取ったらその場でアラート判定も行う(Cron の毎分を待たない)
 */
app.post("/admin/mt5-push", async (c) => {
  const b = await c.req.json<{ symbol: string; bars: Partial<Record<Tf, number[][]>>; profile?: Partial<Record<Tf, VolProfile>> }>();
  if (!b?.symbol || !b.bars) return c.json({ error: "invalid body" }, 400);
  const now = Date.now();
  const saved: Record<string, number> = {};
  for (const { tf } of TIMEFRAMES) {
    const rows = b.bars[tf];
    if (!Array.isArray(rows) || !rows.length) continue;
    const bars: IBar[] = rows.slice(-400).map(([t, open, high, low, close, volume]) => ({ t, open, high, low, close, volume }))
      .filter((x) => Number.isFinite(x.t) && x.high > 0 && x.low > 0);
    // 時刻のずれ(サーバー時間のまま送られた等)を検出: 最新足が未来なら拒否
    if (bars.length && bars[bars.length - 1].t * 1000 > now + 10 * 60 * 1000) return c.json({ error: `bar time is in the future (${tf}); send UTC epoch seconds` }, 400);
    await saveMeta(c.env, `mt5_bars_${tf}`, { symbol: b.symbol, receivedAt: now, bars } satisfies PushedBars);
    saved[tf] = bars.length;
  }
  // 時間帯ごとの平常出来高(10 分ごとに送られてくる)
  for (const { tf } of TIMEFRAMES) {
    const prof = b.profile?.[tf];
    if (prof && Object.keys(prof).length) await saveMeta(c.env, `mt5_vprof_${tf}`, { at: now, profile: prof });
  }
  c.executionCtx.waitUntil(runAlerts(c.env).then(() => undefined).catch(() => undefined));
  return c.json({ ok: true, saved });
});

/** MT5 からの受信状況 */
app.get("/api/mt5/status", async (c) => {
  c.header("Cache-Control", "no-store");
  const out: Record<string, unknown> = { now: Date.now(), offset: await loadMeta(c.env, "mt5_offset") };
  for (const { tf } of TIMEFRAMES) {
    const p = await loadMeta<PushedBars>(c.env, `mt5_bars_${tf}`);
    const last = p?.bars[p.bars.length - 1];
    const prof = await loadMeta<{ at: number; profile: VolProfile }>(c.env, `mt5_vprof_${tf}`);
    out[tf] = p ? { symbol: p.symbol, receivedAgoSec: Math.round((Date.now() - p.receivedAt) / 1000), bars: p.bars.length, last, profileSlots: prof ? Object.keys(prof.profile).length : 0, profileAgoMin: prof ? Math.round((Date.now() - prof.at) / 60000) : null } : null;
  }
  return c.json(out);
});

/** X 投稿の記録(直近。本文・状態・エラー) */
app.get("/api/posts", async (c) => {
  const d = await c.env.DB.prepare("SELECT trade_date AS key, tweet_id, text, status, error, posted_at FROM daily_posts ORDER BY trade_date DESC LIMIT 5").all();
  const w = await c.env.DB.prepare("SELECT week_end AS key, tweet_id, text, status, error, posted_at FROM posts ORDER BY week_end DESC LIMIT 3").all();
  return c.json({ daily: d.results, weekly: w.results });
});
app.get("/api/alerts", async (c) => c.json({ cron: ((await loadMeta<unknown[]>(c.env, "cron_log")) ?? []).slice(-5), mail: await loadMeta<unknown>(c.env, "alert_test_sent"), state: await loadMeta<AlertState>(c.env, "alert_state"), log: ((await loadMeta<AlertLogItem[]>(c.env, "alert_log")) ?? []).slice(-20) }));
/** 手動で判定(?send=1 で送信、?force=1 でクールダウン無視) */
app.post("/admin/alert-check", async (c) => c.json(await runAlerts(c.env, { send: c.req.query("send") === "1", force: c.req.query("force") === "1" })));
/** テストメール */
app.post("/admin/alert-test", async (c) => {
  if (!c.env.RESEND_API_KEY || !c.env.ALERT_TO) return c.json({ error: "RESEND_API_KEY / ALERT_TO not set" }, 400);
  return c.json(await sendMail(c.env.RESEND_API_KEY, c.env.ALERT_TO, "【opt225】テストメール", `アラートの送信テストです。
${c.env.SITE_URL}`));
});

/** GitHub Actions の daily ワークフローを workflow_dispatch(mode=wait)で起動 */
async function dispatchDaily(env: Env): Promise<{ dispatched: boolean; status?: number; reason?: string }> {
  if (!env.GH_DISPATCH_TOKEN) return { dispatched: false, reason: "GH_DISPATCH_TOKEN not set" };
  const repo = env.GH_REPO ?? "imlabo/opt225";
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/daily.yml/dispatches`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GH_DISPATCH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "opt225-worker", "X-GitHub-Api-Version": "2022-11-28" },
    body: JSON.stringify({ ref: "main", inputs: { mode: "wait" } }),
  });
  return { dispatched: r.status === 204, status: r.status, reason: r.status === 204 ? undefined : (await r.text()).slice(0, 200) };
}

/** 手動で日次ワークフローを起動(動作確認用) */
app.post("/admin/dispatch-daily", async (c) => c.json(await dispatchDaily(c.env)));

export default {
  fetch: app.fetch,
  async scheduled(ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    // 週次(木・金 16:30 JST)は JPX 取得→分析→投稿。毎分はアラート。それ以外(平日 16:40 / 20:10 JST)は GitHub Actions の日次取り込みを起動
    const cron = ctrl.cron ?? "";
    const kind = /^\*(\/5)?\s/.test(cron) ? "alerts" : /^30 7\b/.test(cron) ? "weekly" : "dispatch";
    ctx.waitUntil((async () => {
      const log = (await loadMeta<{ cron: string; kind: string; at: number; result?: string }[]>(env, "cron_log")) ?? [];
      let result = "";
      try {
        if (kind === "weekly") result = JSON.stringify(await runPipeline(env)).slice(0, 200);
        else if (kind === "alerts") {
          // MT5 から足が届いている間は、受信時に判定しているので Cron 側は休む(二重判定を避ける)
          const p = await loadMeta<PushedBars>(env, "mt5_bars_5m");
          if (p && Date.now() - p.receivedAt < MT5_FRESH_MS) result = "skip (mt5 push active)";
          else { const r = await runAlerts(env); result = JSON.stringify({ alerts: r.signals.length, sent: r.sent, note: r.note }); }
        }
        else result = JSON.stringify(await dispatchDaily(env));
      } catch (e) {
        result = `error: ${String(e).slice(0, 200)}`;
        if (kind === "alerts") await saveMeta(env, "alert_state", { lastSent: {}, lastRun: { at: Date.now(), ok: false, note: result, checked: {} } });
      }
      await saveMeta(env, "cron_log", [...log, { cron, kind, at: Date.now(), result }].slice(-50));
      console.log(JSON.stringify({ cron, kind, result }));
    })());
  },
} satisfies ExportedHandler<Env>;
