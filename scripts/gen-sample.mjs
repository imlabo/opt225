// デモ表示用のサンプルデータ(乱数・実データではない)を SQL で出力
// usage: node scripts/gen-sample.mjs > sample.sql && npx wrangler d1 execute opt225 --local --file sample.sql
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const inv = { individual: 60000, corporate: 25000, foreign: 180000, securities: 30000, proprietary: 120000 };
const out = [];
const end = new Date(Date.UTC(2026, 9, 9)); // 2026-10-09 (金)
for (let w = 29; w >= 0; w--) {
  const e = new Date(end - w * 7 * 864e5), s = new Date(e - 4 * 864e5);
  const d = (x) => x.toISOString().slice(0, 10);
  out.push(`INSERT OR REPLACE INTO weeks (week_end, week_start, source_url, is_sample) VALUES ('${d(e)}','${d(s)}',NULL,1);`);
  const drift = Math.sin(w / 4);
  for (const [k, base] of Object.entries(inv)) for (const p of ["call", "put", "fut"]) {
    const vol = Math.round(base * (p === "fut" ? 0.4 : 1) * (0.8 + rnd() * 0.4));
    const tilt = (k === "individual" ? -drift : drift) * 0.04 + (rnd() - 0.5) * 0.04 + (k === "individual" && p !== "fut" ? 0.02 : 0);
    out.push(`INSERT OR REPLACE INTO flows (week_end, product, investor, sell, buy) VALUES ('${d(e)}','${p}','${k}',${Math.round(vol * (1 + tilt))},${Math.round(vol * (1 - tilt))});`);
  }
}
console.log(out.join("\n"));
