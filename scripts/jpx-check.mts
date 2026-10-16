// JPX の週次ファイルを取得し、リンク抽出 → 解析 → 主要値を出力する診断スクリプト
// usage: npx tsx scripts/jpx-check.mts [indexUrl]
import { mkdirSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { extractExcelLinks, parseWorkbook, weekFromFileName } from "../src/jpx.ts";

const indexUrl = process.argv[2] ?? "https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html";
const UA = "Mozilla/5.0 (compatible; opt225/1.0)";

const html = await (await fetch(indexUrl, { headers: { "User-Agent": UA } })).text();
mkdirSync("jpx-files", { recursive: true });
writeFileSync("jpx-files/index.html", html);

const allHrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]).filter((h) => /\.(xlsx?|pdf|csv)$/i.test(h));
console.log(`== index: ${indexUrl}\n== file links on page: ${allHrefs.length}`);
for (const h of allHrefs.slice(0, 15)) console.log("  ", h);

const links = extractExcelLinks(html, indexUrl);
console.log(`\n== extracted excel links: ${links.length}`);
for (const l of links.slice(0, 5)) console.log("  ", l, JSON.stringify(weekFromFileName(l)));
if (!links.length) process.exit(1);

const url = links[0];
const buf = await (await fetch(url, { headers: { "User-Agent": UA } })).arrayBuffer();
writeFileSync(`jpx-files/${url.split("/").pop()}`, Buffer.from(buf));

const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
console.log(`\n== workbook: ${url}\n   sheets: ${wb.SheetNames.join(", ")}`);
for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" }) as unknown[][];
  console.log(`\n--- sheet "${name}" (${rows.length} rows, first 80 non-empty) ---`);
  rows.filter((r) => r.some((c) => c !== "")).slice(0, 80).forEach((r, i) => console.log(String(i).padStart(3), JSON.stringify(r)));
}

const flows = parseWorkbook(buf);
console.log(`\n== parsed rows: ${flows.length}`);
console.table(flows);
