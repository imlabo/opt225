// 引け後、JPX の当日分(建玉 xlsx・清算値段 CSV)が公表されたらすぐ取り込む待機ループ(GitHub Actions のスケジュール実行用)
//  1) 開始直後に 1 回 daily-fetch を実行(JPX 未公表でも一目均衡表は先に更新される)
//  2) 以後 POLL_SEC ごとに JPX の一覧ページを確認し、当日分の 2 ファイルがそろった時点で daily-fetch を実行
//  3) サイトの最新日次が当日になったら終了。期限(JST の DEADLINE)を過ぎたら終了(祝日など)
// usage: npx tsx scripts/wait-and-fetch.mts   env: SITE_URL, ADMIN_TOKEN, POLL_SEC(既定 120), DEADLINE(既定 "23:45")
import { spawnSync } from "node:child_process";
import { OI_PAGE, OI_RE, RB_PAGE, RB_RE, findLink } from "../src/jpx-daily.ts";
import { tokyoNow } from "../src/yahoo.ts";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const site = process.env.SITE_URL;
const POLL = Number(process.env.POLL_SEC ?? 120) * 1000;
const [dh, dm] = (process.env.DEADLINE ?? "23:45").split(":").map(Number);
const deadlineMin = dh * 60 + dm;

const t0 = tokyoNow();
const today = t0.date;
if (t0.dow === 0 || t0.dow === 6) { console.log(`${today} is a weekend in Tokyo — nothing to do`); process.exit(0); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => { const t = tokyoNow(); return `${String(Math.floor(t.minutes / 60)).padStart(2, "0")}:${String(t.minutes % 60).padStart(2, "0")} JST`; };

async function siteLatest(): Promise<string | null> {
  if (!site) return null;
  try {
    const r = await fetch(`${site}/api/daily/latest?t=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } });
    if (!r.ok) return null;
    return ((await r.json()) as { tradeDate?: string }).tradeDate ?? null;
  } catch { return null; }
}

async function jpxDates(): Promise<{ oi: string | null; rb: string | null }> {
  const page = async (u: string, re: RegExp) => {
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA, "Cache-Control": "no-cache" } });
      return r.ok ? findLink(await r.text(), u, re)?.date ?? null : null;
    } catch { return null; }
  };
  const [oi, rb] = await Promise.all([page(OI_PAGE, OI_RE), page(RB_PAGE, RB_RE)]);
  return { oi, rb };
}

function runFetch(label: string): boolean {
  console.log(`::group::daily-fetch (${label}) ${stamp()}`);
  const r = spawnSync("npx", ["tsx", "scripts/daily-fetch.mts"], { stdio: "inherit", env: process.env });
  console.log("::endgroup::");
  return r.status === 0;
}

if ((await siteLatest()) === today) { console.log(`${stamp()} site already has ${today} — done`); process.exit(0); }

// 1) まず 1 回(一目均衡表を引け値で先行更新)
runFetch("initial");
let lastSeen = "";
while (true) {
  if ((await siteLatest()) === today) { console.log(`::notice title=Daily::${today} ingested at ${stamp()}`); process.exit(0); }
  const now = tokyoNow();
  if (now.date !== today || now.minutes >= deadlineMin) {
    console.log(`::warning title=Daily::JPX files for ${today} not published by ${stamp()} (holiday?) — giving up`);
    process.exit(0);
  }
  const d = await jpxDates();
  const seen = `OI ${d.oi ?? "-"} / RB ${d.rb ?? "-"}`;
  if (seen !== lastSeen) { console.log(`${stamp()} JPX: ${seen}`); lastSeen = seen; }
  if (d.oi === today && d.rb === today) {
    console.log(`${stamp()} both files for ${today} are out — ingesting`);
    runFetch("published");
    // 取り込みに失敗した場合(公表直後でファイルが不完全など)は次のポーリングで再試行
  }
  await sleep(POLL);
}
