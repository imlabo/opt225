import type { DailyAnalysis, DailyStrike } from "./daily";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");
const signed = (n: number, d = 0) => (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n).toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** 行使価格別 建玉: コールを上、プットを下に描く。現値 ±12% を 500 円刻みに集計 */
function oiChart(a: DailyAnalysis, strikes: DailyStrike[]): string {
  const STEP = 500;
  const lo = a.spot * 0.88, hi = a.spot * 1.12;
  const buckets = new Map<number, { put: number; call: number }>();
  for (const s of strikes) {
    if (s.strike < lo || s.strike > hi) continue;
    const k = Math.round(s.strike / STEP) * STEP;
    const b = buckets.get(k) ?? { put: 0, call: 0 };
    b.put += s.putOi ?? 0;
    b.call += s.callOi ?? 0;
    buckets.set(k, b);
  }
  const ks = [...buckets.keys()].sort((x, y) => x - y);
  if (ks.length < 3) return `<p class="muted">表示できる建玉がありません。</p>`;
  const max = Math.max(...ks.flatMap((k) => [buckets.get(k)!.put, buckets.get(k)!.call]), 1);
  const W = 720, H = 260, P = 30, mid = H / 2;
  const x = (k: number) => P + ((k - ks[0]) / (ks[ks.length - 1] - ks[0])) * (W - 2 * P);
  const h = (v: number) => (v / max) * (mid - 22);
  const bw = Math.max(3, ((W - 2 * P) / ks.length) * 0.7);
  const bars = ks.map((k) => {
    const b = buckets.get(k)!;
    return `<rect x="${x(k) - bw / 2}" y="${mid - h(b.call)}" width="${bw}" height="${h(b.call)}" class="bar-up"><title>${yen(k)} コール ${yen(b.call)}枚</title></rect>` +
      `<rect x="${x(k) - bw / 2}" y="${mid}" width="${bw}" height="${h(b.put)}" class="bar-down"><title>${yen(k)} プット ${yen(b.put)}枚</title></rect>`;
  }).join("");
  const vline = (v: number, label: string, cls: string) =>
    v >= ks[0] && v <= ks[ks.length - 1]
      ? `<line x1="${x(v)}" x2="${x(v)}" y1="14" y2="${H - 18}" class="${cls}"/><text x="${x(v) + 4}" y="12" class="${cls}-t">${label}</text>`
      : "";
  const ticks = ks.filter((_, i) => i % Math.ceil(ks.length / 7) === 0)
    .map((k) => `<text x="${x(k)}" y="${H - 4}" text-anchor="middle">${(k / 1000).toFixed(1)}k</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="行使価格別建玉">
    <line x1="${P}" x2="${W - P}" y1="${mid}" y2="${mid}" class="axis"/>
    <text x="4" y="30">コール</text><text x="4" y="${H - 24}">プット</text>
    ${bars}${vline(a.spot, `現値 ${yen(a.spot)}`, "spot")}${a.maxPain ? vline(a.maxPain, `最大苦痛 ${yen(a.maxPain)}`, "pain") : ""}${ticks}</svg>`;
}

const oku = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v / 1e8).toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}億円`;

/** 売り手の SQ 時点損益カーブ(億円) */
function sellerChart(a: DailyAnalysis): string {
  const s = a.seller;
  if (!s || s.curve.length < 3) return "";
  const pts = s.curve;
  const W = 720, H = 240, P = 36;
  const vals = pts.flatMap((p) => [p.put, p.call]);
  const max = Math.max(...vals, 0), min = Math.max(Math.min(...vals), -Math.max(Math.abs(max) * 3, 1)); // 下方向は見やすい範囲で切る
  const x = (v: number) => P + ((v - pts[0].price) / (pts[pts.length - 1].price - pts[0].price)) * (W - 2 * P);
  const y = (v: number) => P / 2 + ((max - Math.max(v, min)) / (max - min || 1)) * (H - P * 1.5);
  const path = (k: "put" | "call") => pts.map((p, i) => `${i ? "L" : "M"}${x(p.price).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  const vline = (v: number | null, label: string, cls: string, dy = 0) =>
    v && v >= pts[0].price && v <= pts[pts.length - 1].price
      ? `<line x1="${x(v)}" x2="${x(v)}" y1="${P / 2}" y2="${H - P}" class="${cls}"/><text x="${x(v) + 4}" y="${P / 2 + 10 + dy}" class="${cls}-t">${label}</text>` : "";
  const ticks = pts.filter((_, i) => i % Math.ceil(pts.length / 7) === 0)
    .map((p) => `<text x="${x(p.price)}" y="${H - 18}" text-anchor="middle">${(p.price / 1000).toFixed(1)}k</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="売り手の損益">
    <line x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}" class="axis"/><text x="2" y="${y(0) + 4}">0</text>
    <path d="${path("put")}" class="sp-put"/><path d="${path("call")}" class="sp-call"/>
    ${vline(a.spot, `現値 ${yen(a.spot)}`, "spot")}${vline(s.putBreakeven, `プット損益分岐 ${s.putBreakeven ? yen(s.putBreakeven) : ""}`, "be", 14)}${vline(s.callBreakeven, `コール損益分岐 ${s.callBreakeven ? yen(s.callBreakeven) : ""}`, "be", 28)}
    ${ticks}<text x="${W - P}" y="${H - 2}" text-anchor="end"><tspan class="sp-put-t">━ プット売り手</tspan>　<tspan class="sp-call-t">━ コール売り手</tspan></text></svg>`;
}

function sellerSection(a: DailyAnalysis): string {
  const s = a.seller;
  if (!s) return "";
  const kpi = (label: string, value: string, sub = "") => `<div class="kpi"><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</div>`;
  return `<h4>売り手の損益(SQ時点, ${Number(a.front.month.slice(4))}月限全体)</h4>
    <div class="kpis">
      ${kpi("プット売り手が損失に転じる価格", s.putBreakeven ? yen(s.putBreakeven) : "—", s.putBreakeven ? `現値比 ${signed(s.putBreakeven - a.spot)}円 / 受取プレミアム ${oku(s.putPremium)}` : "")}
      ${kpi("コール売り手が損失に転じる価格", s.callBreakeven ? yen(s.callBreakeven) : "—", s.callBreakeven ? `現値比 ${signed(s.callBreakeven - a.spot)}円 / 受取プレミアム ${oku(s.callPremium)}` : "")}
      ${kpi("急落時のプット売り手損益", `−5%: ${oku(s.putAtDown5)}`, `−10%: ${oku(s.putAtDown10)} / 急騰+10%時のコール売り手: ${oku(s.callAtUp10)}`)}
    </div>
    ${sellerChart(a)}
    <p class="muted small">現時点の清算価格でオプションを売ったとみなし、SQ時の日経平均ごとに売り手全体の損益を計算(1枚=指数×1,000円)。損益分岐を割り込むと売り手のヘッジ(先物売り・プット買い戻し)が出やすく、下げが加速しやすい価格帯の目安になります。損失が大きい範囲はグラフ下端で省略しています。誰が売り手かの内訳は週次の投資部門別推定を参照。</p>`;
}

function trend(history: DailyAnalysis[]): string {
  const rows = history.slice(-10).reverse();
  if (rows.length < 2) return "";
  return `<h4>直近の推移</h4><div class="table-wrap"><table><thead><tr><th>日付</th><th>日経平均</th><th>期近P/C比</th><th>ATM IV</th><th>最大苦痛</th><th>壁(下/上)</th></tr></thead><tbody>${rows
    .map((d) => `<tr><td>${d.tradeDate.slice(5).replace("-", "/")}</td><td>${yen(d.spot)}</td><td>${d.pcr.toFixed(2)}</td><td>${d.atmIv ? d.atmIv.toFixed(1) + "%" : "—"}</td><td>${d.maxPain ? yen(d.maxPain) : "—"}</td><td>${d.putWall ? yen(d.putWall.strike) : "—"} / ${d.callWall ? yen(d.callWall.strike) : "—"}</td></tr>`)
    .join("")}</tbody></table></div>`;
}

export function renderDailySection(a: DailyAnalysis | undefined, history: DailyAnalysis[], strikes: DailyStrike[]): string {
  if (!a) return "";
  const m = `${a.front.month.slice(0, 4)}年${Number(a.front.month.slice(4))}月限`;
  const dPcr = a.prev ? a.pcr - a.prev.pcr : null;
  const dIv = a.prev?.atmIv != null && a.atmIv != null ? a.atmIv - a.prev.atmIv : null;
  const kpi = (label: string, value: string, sub = "") => `<div class="kpi"><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const range = a.expectedMove ? `${yen(a.spot - a.expectedMove)} 〜 ${yen(a.spot + a.expectedMove)}` : "—";
  return `
  <section class="card">
    <p class="eyebrow">日次 ${esc(a.tradeDate)} 引け時点 / ${esc(m)}(SQまで${a.front.days}日)</p>
    <h2>建玉から見た日経平均の節目</h2>
    <div class="kpis">
      ${kpi("日経平均", yen(a.spot), a.fut ? `先物${Number(a.fut.month.slice(4))}月 ${yen(a.fut.price)}` : "")}
      ${kpi("建玉の壁 下 / 上", `${a.putWall ? yen(a.putWall.strike) : "—"} / ${a.callWall ? yen(a.callWall.strike) : "—"}`, `プット ${a.putWall ? yen(a.putWall.oi) : "—"}枚 / コール ${a.callWall ? yen(a.callWall.oi) : "—"}枚`)}
      ${kpi("最大苦痛価格", a.maxPain ? yen(a.maxPain) : "—", a.maxPain ? `現値比 ${signed(a.maxPain - a.spot)}円` : "")}
      ${kpi("期近 P/C建玉比", a.pcr.toFixed(2), dPcr != null ? `前日比 ${signed(dPcr, 2)}` : "")}
      ${kpi("ATM IV", a.atmIv ? a.atmIv.toFixed(1) + "%" : "—", dIv != null ? `前日比 ${signed(dIv, 1)}pt` : a.skew != null ? `スキュー ${signed(a.skew, 1)}pt` : "")}
      ${kpi("SQまでの1σレンジ", range, a.expectedMove ? `±${yen(a.expectedMove)}円` : "")}
    </div>
    <p class="comment">${esc(a.comment)}</p>
    <h4>行使価格別 建玉(${esc(m)}, 500円刻み)</h4>
    ${oiChart(a, strikes)}
    ${sellerSection(a)}
    <p class="muted small">建玉が当日増えた行使価格: プット ${a.topPutAdds.map((t) => `${yen(t.strike)}(+${yen(t.chg)})`).join("、") || "—"} / コール ${a.topCallAdds.map((t) => `${yen(t.strike)}(+${yen(t.chg)})`).join("、") || "—"}</p>
    ${trend(history)}
  </section>`;
}

export const DAILY_CSS = `
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}@media(max-width:720px){.kpis{grid-template-columns:repeat(2,1fr)}}
.kpi small{display:block;font-size:12px;color:var(--muted)}.small{font-size:12px}
.sp-put{fill:none;stroke:var(--down);stroke-width:2}.sp-call{fill:none;stroke:var(--up);stroke-width:2}
svg tspan.sp-put-t{fill:var(--down)}svg tspan.sp-call-t{fill:var(--up)}.be{stroke:#7c3aed;stroke-dasharray:4 3}.be-t{fill:#7c3aed!important;font-size:10px}
.spot{stroke:var(--fg);stroke-dasharray:3 3}.spot-t{fill:var(--fg)!important}.pain{stroke:#b7791f;stroke-dasharray:6 3}.pain-t{fill:#b7791f!important}
`;
