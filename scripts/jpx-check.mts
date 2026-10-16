// JPX の週次ファイルを取得し、リンク抽出 → 解析 → 主要値を出力する診断スクリプト
// usage: npx tsx scripts/jpx-check.mts [indexUrl]
import { mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { decodeJpx, extractWeeklyLinks, parseWeeklyCsv, weekFromFileName } from "../src/jpx.ts";

const indexUrl = process.argv[2] ?? "https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html";
const UA = "Mozilla/5.0 (compatible; opt225/1.0)";

const html = await (await fetch(indexUrl, { headers: { "User-Agent": UA } })).text();
mkdirSync("jpx-files", { recursive: true });
writeFileSync("jpx-files/index.html", html);

const allHrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => /\.(xlsx?|pdf|csv)$/i.test(h));
console.log(`== index: ${indexUrl}\n== file links on page: ${allHrefs.length}`);
for (const h of allHrefs) console.log("  ", h);

for (const sub of ["01.html", "02.html", "03.html"]) {
  const u = new URL(sub, indexUrl).toString();
  const h = await (await fetch(u, { headers: { "User-Agent": UA } })).text();
  const t = h.match(/<title>([^<]*)/)?.[1];
  const l = extractWeeklyLinks(h, u);
  console.log(`\n== sub page ${sub}: ${t} / weekly csv: ${l.length}`, l.length ? `${l[l.length - 1].split("/").pop()} .. ${l[0].split("/").pop()}` : "");
  console.log("   other files:", [...new Set([...h.matchAll(/href="([^"]+\.(?:csv|zip|xlsx?))"/g)].map((m) => m[1].split("/").pop()))].slice(0, 12).join(" "));
}

const links = extractWeeklyLinks(html, indexUrl);
console.log(`\n== extracted weekly links: ${links.length}`);
for (const l of links) console.log("  ", l, JSON.stringify(weekFromFileName(l)));
if (!links.length) process.exit(1);

const url = links[0];
const buf = await (await fetch(url, { headers: { "User-Agent": UA } })).arrayBuffer();
writeFileSync(`jpx-files/${url.split("/").pop()}`, Buffer.from(buf));
const text = decodeJpx(buf);
console.log(`\n== file: ${url} (${buf.byteLength} bytes)`);
const lines = text.split(/\r?\n/);
lines.slice(0, 3).forEach((l, i) => console.log(String(i).padStart(3), l));
// 商品コードごとの要約(数量行 & 投資部門コード一覧)
const by = new Map<string, string[][]>();
for (const l of lines.slice(1)) {
  const c = l.split(",").map((x) => x.replace(/"/g, ""));
  if (c.length < 12 || c[6] !== "1") continue;
  by.set(c[0], [...(by.get(c[0]) ?? []), c]);
}
console.log("\n== product codes (volume rows): code -> investor:sell/buy");
for (const [code, rows] of by) console.log(code, rows.map((r) => `${r[5]}:${r[7]}/${r[9]}`).join(" "));

// 同じ週の PDF をテキスト化して照合用に出力
const pdfHref = allHrefs.find((h) => h.includes(`Tousi_DV_pdf_W_${url.match(/_(\d{8}_\d{8})\.csv$/)?.[1]}`));
if (pdfHref) {
  const pdf = Buffer.from(await (await fetch(new URL(pdfHref, indexUrl), { headers: { "User-Agent": UA } })).arrayBuffer());
  writeFileSync("jpx-files/week.pdf", pdf);
  try {
    execSync("pdftotext -layout jpx-files/week.pdf jpx-files/week.txt");
    console.log("\n== PDF text saved: jpx-files/week.txt");
  } catch (e) { console.log("pdftotext failed", e); }
}

try {
  const parsed = parseWeeklyCsv(text);
  console.log(`\n== parsed: ${parsed.weekStart}..${parsed.weekEnd}, ${parsed.flows.length} rows`);
  console.table(parsed.flows);
} catch (e) {
  console.log("parse error:", e);
}
