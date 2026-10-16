// JPX の週次ファイルを取得し、リンク抽出 → 解析 → 主要値を出力する診断スクリプト
// usage: npx tsx scripts/jpx-check.mts [indexUrl]
import { mkdirSync, writeFileSync } from "node:fs";
import { decodeJpx, extractWeeklyLinks, parseWeeklyCsv, weekFromFileName } from "../src/jpx.ts";

const indexUrl = process.argv[2] ?? "https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html";
const UA = "Mozilla/5.0 (compatible; opt225/1.0)";

const html = await (await fetch(indexUrl, { headers: { "User-Agent": UA } })).text();
mkdirSync("jpx-files", { recursive: true });
writeFileSync("jpx-files/index.html", html);

const allHrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => /\.(xlsx?|pdf|csv)$/i.test(h));
console.log(`== index: ${indexUrl}\n== file links on page: ${allHrefs.length}`);
for (const h of allHrefs) console.log("  ", h);

const links = extractWeeklyLinks(html, indexUrl);
console.log(`\n== extracted weekly links: ${links.length}`);
for (const l of links) console.log("  ", l, JSON.stringify(weekFromFileName(l)));
if (!links.length) process.exit(1);

const url = links[0];
const buf = await (await fetch(url, { headers: { "User-Agent": UA } })).arrayBuffer();
writeFileSync(`jpx-files/${url.split("/").pop()}`, Buffer.from(buf));
const text = decodeJpx(buf);
console.log(`\n== file: ${url} (${buf.byteLength} bytes)`);
text.split(/\r?\n/).slice(0, 400).forEach((l, i) => console.log(String(i).padStart(3), l));

try {
  const flows = parseWeeklyCsv(text);
  console.log(`\n== parsed rows: ${flows.length}`);
  console.table(flows);
} catch (e) {
  console.log("parse error:", e);
}
