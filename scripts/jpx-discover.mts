// JPX のデリバティブ関連ページを巡回し、ページとファイルリンクを一覧化する調査用スクリプト
// usage: npx tsx scripts/jpx-discover.mts [startUrl...]  → out/ に結果
import { mkdirSync, writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (compatible; opt225/1.0)";
const starts = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "https://www.jpx.co.jp/markets/derivatives/index.html",
      "https://www.jpx.co.jp/markets/statistics-derivatives/index.html",
      "https://www.jpx.co.jp/markets/statistics-derivatives/daily/index.html",
      "https://www.jpx.co.jp/markets/derivatives/participant-volume/index.html",
      "https://www.jpx.co.jp/markets/derivatives/open-interest/index.html",
    ];
const MAX_PAGES = 60;
mkdirSync("out/pages", { recursive: true });

const seen = new Set<string>();
const queue = [...starts];
const report: string[] = [];
while (queue.length && seen.size < MAX_PAGES) {
  const url = queue.shift()!;
  if (seen.has(url)) continue;
  seen.add(url);
  let html = "";
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA } });
    html = await r.text();
    report.push(`\n### ${url} [${r.status}] ${html.match(/<title>([^<]*)/)?.[1]?.trim() ?? ""}`);
  } catch (e) {
    report.push(`\n### ${url} [ERR ${e}]`);
    continue;
  }
  writeFileSync(`out/pages/${url.replace(/^https:\/\/www\.jpx\.co\.jp\//, "").replace(/\//g, "_")}`, html);
  const hrefs = [...new Set([...html.matchAll(/href="([^"#]+)"/g)].map((m) => new URL(m[1], url).toString()))];
  const files = hrefs.filter((h) => /\.(csv|xlsx?|zip|pdf|txt)$/i.test(h));
  report.push(`files (${files.length}):`, ...files.slice(0, 40).map((f) => "  " + f));
  for (const h of hrefs) {
    // デリバティブの日次・手口・建玉に関係しそうなページだけ辿る
    if (!h.startsWith("https://www.jpx.co.jp/markets/")) continue;
    if (!/\.html$/.test(h)) continue;
    if (/derivatives\/(participant|open-interest|trading-volume|daily|index)|statistics-derivatives\/(daily|index)/.test(h)) queue.push(h);
  }
}
writeFileSync("out/discover.txt", report.join("\n"));
console.log(report.join("\n"));
