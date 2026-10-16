// JPX の日次ファイル(建玉・清算値段)を取得・解析し、Worker に送る
// usage: npx tsx scripts/daily-fetch.mts [--dry] [--out file.json]
//   env: SITE_URL, ADMIN_TOKEN
import { writeFileSync } from "node:fs";
import { OI_PAGE, OI_RE, RB_PAGE, RB_RE, buildDailyInput, decodeSjis, findLink, parseOiWorkbook, parseSettlementCsv } from "../src/jpx-daily.ts";

const UA = "Mozilla/5.0 (compatible; opt225/1.0)";
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
const get = async (u: string) => {
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`${u} HTTP ${r.status}`);
  return r;
};

const oiLink = findLink(await (await get(OI_PAGE)).text(), OI_PAGE, OI_RE);
const rbLink = findLink(await (await get(RB_PAGE)).text(), RB_PAGE, RB_RE);
console.log("OI:", oiLink, "\nRB:", rbLink);
if (!oiLink || !rbLink) throw new Error("daily file link not found");
if (oiLink.date !== rbLink.date) {
  console.log(`::notice::dates differ (OI ${oiLink.date} / RB ${rbLink.date}) — not yet published, skip`);
  process.exit(0);
}

const oi = parseOiWorkbook(new Uint8Array(await (await get(oiLink.url)).arrayBuffer()));
const rb = parseSettlementCsv(decodeSjis(new Uint8Array(await (await get(rbLink.url)).arrayBuffer())));
if (oi.date && oi.date !== oiLink.date) console.log(`::warning::OI sheet date ${oi.date} != file date ${oiLink.date}`);
const input = buildDailyInput(oiLink.date, oi, rb, [oiLink.url, rbLink.url]);
console.log(`trade ${input.tradeDate} spot ${input.spot} months ${input.months.map((m) => `${m.month}(${m.days}d)`).join(",")} strikes ${input.strikes.length} (put ${oi.put.length} / call ${oi.call.length})`);
if (outFile) writeFileSync(outFile, JSON.stringify(input));
if (dry) process.exit(0);

const site = process.env.SITE_URL, token = process.env.ADMIN_TOKEN;
if (!site || !token) throw new Error("SITE_URL / ADMIN_TOKEN not set");
const res = await fetch(`${site}/admin/ingest-daily`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(input),
});
const body = await res.text();
console.log(`::notice title=ingest-daily ${res.status}::${body.slice(0, 900)}`);
if (!res.ok) process.exit(1);
