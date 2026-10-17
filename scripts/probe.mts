// URL ごとにステータス・Content-Type・先頭を記録する調査用スクリプト
import { mkdirSync, writeFileSync } from "node:fs";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
mkdirSync("out/probe", { recursive: true });
const lines: string[] = [];
let i = 0;
for (const u of process.argv.slice(2)) {
  try {
    const r = await fetch(u, { headers: { "User-Agent": UA, Accept: "*/*", Referer: new URL(u).origin + "/" } });
    const buf = Buffer.from(await r.arrayBuffer());
    writeFileSync(`out/probe/${i}.bin`, buf);
    lines.push(`## [${i}] ${u}\nstatus ${r.status} type ${r.headers.get("content-type")} bytes ${buf.length}\n${buf.subarray(0, 600).toString("utf8")}\n`);
  } catch (e) {
    lines.push(`## [${i}] ${u}\nERR ${e}\n`);
  }
  i++;
}
writeFileSync("out/probe.txt", lines.join("\n"));
console.log(lines.join("\n"));
