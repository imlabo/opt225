// 日次の取得・解析・送信(GitHub Actions から実行)
//  1) JPX 日次ファイル(建玉・清算値段)を取得・解析
//  2) 市場心理指数: 日経公式 CSV(日経平均・日経平均VI)と CNN Fear & Greed を取得し、日経225 Fear & Greed を算出して送信
//  3) 日次データを送信(Worker 側で答え合わせ → 再学習 → 予測 → X 投稿)
// usage: npx tsx scripts/daily-fetch.mts [--dry] [--out file.json]   env: SITE_URL, ADMIN_TOKEN
import { writeFileSync } from "node:fs";
import { analyzeDaily, type DailyInput } from "../src/daily.ts";
import { OI_PAGE, OI_RE, RB_PAGE, RB_RE, buildDailyInput, decodeSjis, findLink, parseOiWorkbook, parseSettlementCsv } from "../src/jpx-daily.ts";
import { computeNikkeiFg, parseCnn, parseNikkeiCsv, type CnnFg, type Point } from "../src/sentiment.ts";
import { parseNikkeiOhlc, type Bar } from "../src/ichimoku.ts";
import { buildIchimoku } from "../src/ichimoku-payload.ts";
import { isDegenerate, latestTradingDate, mergeBars, parseYahooChart, repairDegenerate, YAHOO_FUTURES_ALT_URLS, YAHOO_FUTURES_URLS, YAHOO_URLS } from "../src/yahoo.ts";
import type { IchimokuPayload } from "../src/daily.ts";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const NK_CSV = "https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_daily_jp.csv";
const VI_CSV = "https://indexes.nikkei.co.jp/nkave/historical/nikkei_stock_average_vi_daily_jp.csv";
const CNN_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
const site = process.env.SITE_URL, token = process.env.ADMIN_TOKEN;
const get = async (u: string) => {
  const r = await fetch(u, { headers: { "User-Agent": UA, Referer: new URL(u).origin + "/" } });
  if (!r.ok) throw new Error(`${u} HTTP ${r.status}`);
  return r;
};
const post = async (path: string, body: unknown) => {
  if (dry) return console.log(`[dry] POST ${path}`);
  if (!site || !token) throw new Error("SITE_URL / ADMIN_TOKEN not set");
  const res = await fetch(`${site}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  console.log(`::notice title=${path} ${res.status}::${text.slice(0, 900)}`);
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
};

// ---- 1) JPX 日次 ----
let input: DailyInput | undefined;
try {
  const oiLink = findLink(await (await get(OI_PAGE)).text(), OI_PAGE, OI_RE);
  const rbLink = findLink(await (await get(RB_PAGE)).text(), RB_PAGE, RB_RE);
  console.log("OI:", oiLink, "\nRB:", rbLink);
  if (!oiLink || !rbLink) throw new Error("daily file link not found");
  if (oiLink.date !== rbLink.date) {
    console.log(`::notice::JPX dates differ (OI ${oiLink.date} / RB ${rbLink.date}) — not yet published`);
  } else {
    const oi = parseOiWorkbook(new Uint8Array(await (await get(oiLink.url)).arrayBuffer()));
    const rb = parseSettlementCsv(decodeSjis(new Uint8Array(await (await get(rbLink.url)).arrayBuffer())));
    if (oi.date && oi.date !== oiLink.date) console.log(`::warning::OI sheet date ${oi.date} != file date ${oiLink.date}`);
    input = buildDailyInput(oiLink.date, oi, rb, [oiLink.url, rbLink.url]);
    console.log(`trade ${input.tradeDate} spot ${input.spot} strikes ${input.strikes.length}`);
    if (outFile) writeFileSync(outFile, JSON.stringify(input));
  }
} catch (e) {
  console.log(`::error title=JPX daily::${e}`);
}

// ---- 2) 市場心理 / 一目均衡表 ----
let nkText = "";
try { nkText = decodeSjis(new Uint8Array(await (await get(NK_CSV)).arrayBuffer())); } catch (e) { console.log(`::error title=Nikkei CSV::${e}`); }

// 日経公式 CSV は当日分の反映が遅れるため、最新足は Yahoo Finance(^N225)で補う
let yahoo: Bar[] = [];
for (const u of YAHOO_URLS) {
  try { yahoo = parseYahooChart(await (await get(u)).json()); break; }
  catch (e) { console.log(`::warning title=Yahoo::${u} ${e}`); }
}
const asOf = input?.tradeDate ?? latestTradingDate(); // 対象日: JPX 公表済みならその日、未公表なら直近の取引日
const merged = mergeBars(parseNikkeiOhlc(nkText), yahoo, asOf);
const lastBar = merged.bars[merged.bars.length - 1];
console.log(`bars: nikkei last ${parseNikkeiOhlc(nkText).at(-1)?.date ?? "-"} / yahoo last ${yahoo.at(-1)?.date ?? "-"} / filled [${merged.added.join(",")}] / asOf ${asOf}`);

// 一目均衡表は日経225先物(CME 円建て NIY=F, Yahoo Finance)の日足で計算。取れなければ日経平均で代替
// NIY=F(円建て)と NKD=F(ドル建て、同じ指数ポイント)を取り、直近 250 本で 4 本値の欠け(点になる足)が少ない方を使う
type Fut = ReturnType<typeof parseYahooChart>;
const fetchFut = async (urls: string[]) => {
  for (const u of urls) {
    try { return parseYahooChart(await (await get(u)).json(), Date.now(), "cme"); }
    catch (e) { console.log(`::warning title=Yahoo futures::${u} ${e}`); }
  }
  return [] as unknown as Fut;
};
const cands: { symbol: string; bars: Fut; bad: number }[] = [];
for (const [symbol, urls] of [["NIY=F", YAHOO_FUTURES_URLS], ["NKD=F", YAHOO_FUTURES_ALT_URLS]] as const) {
  const b = await fetchFut([...urls]);
  const bad = b.slice(-250).filter(isDegenerate).length;
  console.log(`futures ${symbol}: ${b.length} bars, last ${b.at(-1)?.date ?? "-"} ${b.at(-1)?.close ?? ""}${b.inProgress ? ` (in progress ${b.inProgress})` : ""}, degenerate ${bad}/250`);
  if (b.length) cands.push({ symbol, bars: b, bad });
}
cands.sort((a, b) => a.bad - b.bad || b.bars.length - a.bars.length);
const best = cands[0];

let ichimoku: IchimokuPayload | undefined;
if (best && best.bars.length >= 200 && (best.bars.at(-1)?.date ?? "") >= asOf) {
  const { bars: fb, repaired } = repairDegenerate(best.bars);
  console.log(`futures: using ${best.symbol}, repaired ${repaired.length} bars${repaired.length ? ` (last: ${repaired.slice(-5).join(",")})` : ""}`);
  try { ichimoku = buildIchimoku(fb, fb[fb.length - 1].date, null, [], { series: "futures", inProgress: best.bars.inProgress, symbol: best.symbol, repairedDates: repaired }); }
  catch (e) { console.log(`::error title=Ichimoku futures::${e}`); }
}
if (!ichimoku && merged.bars.length) {
  try { ichimoku = buildIchimoku(merged.bars, asOf, input?.spot ?? null, merged.added); }
  catch (e) { console.log(`::error title=Ichimoku::${e}`); }
}
if (input) input.ichimoku = ichimoku;

try {
  const prices = parseNikkeiCsv(nkText);
  const vi = parseNikkeiCsv(decodeSjis(new Uint8Array(await (await get(VI_CSV)).arrayBuffer())));
  // 日経 CSV がまだ当日分を含まない場合は Yahoo の終値、無ければ JPX の原資産価格で補う
  for (const b of merged.bars) if (prices.length && b.date > prices[prices.length - 1].date) prices.push({ date: b.date, value: b.close });
  if (input && prices.length && prices[prices.length - 1].date < input.tradeDate) prices.push({ date: input.tradeDate, value: input.spot });

  // 本サイトで蓄積した P/C比・スキュー(公開 API)+ 当日分
  const own = { pcr: [] as Point[], skew: [] as Point[] };
  if (site) {
    try {
      const hist = (await (await fetch(`${site}/api/daily/history`)).json()) as { tradeDate: string; pcr: number; skew: number | null }[];
      for (const h of hist) { own.pcr.push({ date: h.tradeDate, value: h.pcr }); if (h.skew != null) own.skew.push({ date: h.tradeDate, value: h.skew }); }
    } catch (e) { console.log(`::warning::daily history fetch failed: ${e}`); }
  }
  if (input) {
    const a = analyzeDaily(input);
    own.pcr = own.pcr.filter((p) => p.date !== a.tradeDate).concat({ date: a.tradeDate, value: a.pcr });
    if (a.skew != null) own.skew = own.skew.filter((p) => p.date !== a.tradeDate).concat({ date: a.tradeDate, value: a.skew });
  }
  const since = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const nikkei = computeNikkeiFg(prices, vi, own, since);
  let cnn: CnnFg | undefined;
  try { cnn = parseCnn(await (await get(CNN_URL)).json()); } catch (e) { console.log(`::warning title=CNN::${e}`); }
  const last = nikkei[nikkei.length - 1];
  console.log(`Nikkei F&G ${last?.date} ${last?.score.toFixed(1)} ${last?.rating} (${nikkei.length} pts) / CNN ${cnn?.date} ${cnn?.score.toFixed(1)} ${cnn?.rating}`);
  await post("/admin/ingest-sentiment", { nikkei, cnn });
} catch (e) {
  console.log(`::error title=Sentiment::${e}`);
}

// ---- 3) 日次データ送信 ----
if (input) await post("/admin/ingest-daily", input);
// JPX 未公表でも一目均衡表だけは最新足で更新しておく(JPX 公表後の ingest-daily で同じ日付が上書きされる)
else if (ichimoku) await post("/admin/ingest-ichimoku", { tradeDate: ichimoku.result.date, close: ichimoku.result.close, ichimoku });
