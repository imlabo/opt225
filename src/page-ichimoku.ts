import type { DailyAnalysis } from "./daily";
import { SIGNAL_KEYS } from "./ichimoku";

const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");
const pct = (h: number, n: number) => (n ? `${((h / n) * 100).toFixed(1)}%` : "—");
const SIGNAL_LABEL: Record<(typeof SIGNAL_KEYS)[number], [string, string, string]> = {
  tk: ["転換線と基準線", "転換線 > 基準線(好転)", "転換線 < 基準線(逆転)"],
  cloud: ["雲と価格", "雲の上", "雲の下"],
  chikou: ["遅行スパン", "26日前のローソクより上", "26日前のローソクより下"],
  future: ["先行スパン(26日先の雲)", "陽転(先行1 > 先行2)", "陰転(先行1 < 先行2)"],
  slope: ["基準線の向き", "上向き", "下向き"],
  wave: ["波動", "上昇N波動", "下落N波動"],
};

type IchiView = NonNullable<DailyAnalysis["ichimoku"]>;

function chart(ic: IchiView): string {
  const bars = ic.chart.slice(-90), fut = ic.futureCloud;
  const all = [...bars.flatMap((b) => [b.high, b.low, b.spanA ?? b.close, b.spanB ?? b.close]), ...fut.flatMap((f) => [f.spanA, f.spanB])];
  const max = Math.max(...all), min = Math.min(...all);
  const n = bars.length + fut.length;
  const W = 720, H = 300, P = 40;
  const x = (i: number) => P + (i / (n - 1)) * (W - P - 10);
  const y = (v: number) => 10 + ((max - v) / (max - min || 1)) * (H - 40);
  const cw = Math.max(2, ((W - P) / n) * 0.6);
  // 雲(当日分 + 26日先)
  const cloudPts = [
    ...bars.map((b, i) => (b.spanA != null && b.spanB != null ? { i, a: b.spanA, b: b.spanB } : null)).filter(Boolean),
    ...fut.map((f, k) => ({ i: bars.length + k, a: f.spanA, b: f.spanB })),
  ] as { i: number; a: number; b: number }[];
  const cloud = cloudPts.slice(1).map((p, k) => {
    const q = cloudPts[k];
    const up = (p.a + q.a) / 2 >= (p.b + q.b) / 2;
    return `<path d="M${x(q.i)},${y(q.a)}L${x(p.i)},${y(p.a)}L${x(p.i)},${y(p.b)}L${x(q.i)},${y(q.b)}Z" class="${up ? "ic-cloud-up" : "ic-cloud-dn"}"/>`;
  }).join("");
  const line = (key: "tenkan" | "kijun", cls: string) => {
    const pts = bars.map((b, i) => (b[key] != null ? `${x(i).toFixed(1)},${y(b[key]!).toFixed(1)}` : null)).filter(Boolean);
    return pts.length > 1 ? `<path d="M${pts.join("L")}" class="${cls}"/>` : "";
  };
  // 遅行スパン: 終値を 26 本前に描画
  const chikou = bars.map((b, i) => (i - 26 >= 0 ? `${x(i - 26).toFixed(1)},${y(b.close).toFixed(1)}` : null)).filter(Boolean);
  const candles = bars.map((b, i) => {
    const up = b.close >= b.open;
    return `<line x1="${x(i)}" x2="${x(i)}" y1="${y(b.high)}" y2="${y(b.low)}" class="${up ? "ic-up" : "ic-dn"}"/>` +
      `<rect x="${x(i) - cw / 2}" y="${y(Math.max(b.open, b.close))}" width="${cw}" height="${Math.max(1, Math.abs(y(b.open) - y(b.close)))}" class="${up ? "ic-up-b" : "ic-dn-b"}"><title>${b.date} 始${yen(b.open)} 高${yen(b.high)} 安${yen(b.low)} 終${yen(b.close)}</title></rect>`;
  }).join("");
  const t = ic.result.targets;
  const tline = (v: number, label: string) => v >= min && v <= max ? `<line x1="${x(bars.length - 1)}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" class="ic-target"/><text x="${W - 12}" y="${y(v) - 3}" text-anchor="end" class="ic-target-t">${label} ${yen(v)}</text>` : "";
  // 波動論(3波動): 転換点を結ぶジグザグ。A→B→C(計算値の基準)は太線でラベル付き、未確定の直近極値は破線
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  const pvIn = ic.result.pivots.map((p) => ({ ...p, k: idx.get(p.date) })).filter((p): p is typeof p & { k: number } => p.k != null);
  const abc = t ? new Map([[t.a.date, "A"], [t.b.date, "B"], [t.c.date, "C"]]) : new Map<string, string>();
  let wave = "";
  for (let k = 1; k < pvIn.length; k++) {
    const p = pvIn[k - 1], q = pvIn[k];
    const strong = abc.has(p.date) && abc.has(q.date);
    wave += `<line x1="${x(p.k).toFixed(1)}" y1="${y(p.price).toFixed(1)}" x2="${x(q.k).toFixed(1)}" y2="${y(q.price).toFixed(1)}" class="${!q.confirmed ? "ic-wave-tmp" : strong ? "ic-wave-abc" : "ic-wave"}"/>`;
  }
  wave += pvIn.map((p) => {
    const lab = abc.get(p.date), dy = p.type === "high" ? -7 : 14;
    return `<circle cx="${x(p.k).toFixed(1)}" cy="${y(p.price).toFixed(1)}" r="${lab ? 3.5 : 2.5}" class="${lab ? "ic-pv-abc" : "ic-pv"}"><title>${p.date} ${p.type === "high" ? "高値" : "安値"} ${yen(p.price)}${p.confirmed ? "" : "(未確定)"}</title></circle>` +
      (lab ? `<text x="${x(p.k).toFixed(1)}" y="${(y(p.price) + dy).toFixed(1)}" text-anchor="middle" class="ic-pv-t">${lab}</text>` : "");
  }).join("");
  // 時間論: 変化日の候補(当日の該当と、10営業日以内の次候補)を縦線で表示
  const tm = ic.result.time;
  const vline = (k: number, label: string, cls: string, title: string) =>
    `<line x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="12" y2="${H - 22}" class="${cls}"><title>${title}</title></line><text x="${x(k).toFixed(1)}" y="9" text-anchor="middle" class="ic-time-t">${label}</text>`;
  const changeDays = (tm.hits.length ? vline(bars.length - 1, "変化日", "ic-time-hit", tm.hits.map((h) => `${h.from}の${h.fromType === "high" ? "高値" : "安値"}から${h.bars}日目(基本数値${h.number})`).join(" / ")) : "") +
    tm.upcoming.map((u) => vline(bars.length - 1 + u.inBars, String(u.number), "ic-time", `${u.inBars}営業日後: ${u.from}から${u.number}日目`)).join("");
  const yt = [0, 0.25, 0.5, 0.75, 1].map((r) => min + (max - min) * r).map((v) => `<text x="2" y="${y(v) + 4}">${(v / 1000).toFixed(1)}k</text>`).join("");
  const xt = bars.filter((_, i) => i % 20 === 0).map((b) => `<text x="${x(bars.indexOf(b))}" y="${H - 8}" text-anchor="middle">${b.date.slice(5).replace("-", "/")}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="一目均衡表 日足">${yt}${xt}${cloud}${candles}${line("tenkan", "ic-tenkan")}${line("kijun", "ic-kijun")}
    ${chikou.length > 1 ? `<path d="M${chikou.join("L")}" class="ic-chikou"/>` : ""}
    ${t ? tline(t.N, "N") + tline(t.E, "E") + tline(t.V, "V") : ""}${changeDays}${wave}
    <text x="${W - 12}" y="${H - 8}" text-anchor="end"><tspan class="ic-tenkan-t">━ 転換線</tspan> <tspan class="ic-kijun-t">━ 基準線</tspan> <tspan class="ic-chikou-t">━ 遅行スパン</tspan> <tspan class="ic-wave-t">━ 波動(A→B→C)</tspan> <tspan class="ic-time-t">┆ 変化日</tspan></text></svg>`;
}

export function renderIchimokuSection(ic: IchiView | undefined): string {
  if (!ic) return "";
  const r = ic.result, bt = ic.backtest, basis = ic.basis;
  const f = (v: number) => `${yen(v)}<small class="muted"> (先物 ${yen(v + basis)})</small>`;
  const sig = SIGNAL_KEYS.map((k) => {
    const v = r.signal[k];
    const [name, pos, neg] = SIGNAL_LABEL[k];
    const ps = bt.perSignal[k];
    const hist = v > 0 ? `${pct(ps.posUp, ps.pos)}(${ps.pos}日)` : v < 0 ? `${pct(ps.negUp, ps.neg)}(${ps.neg}日)` : "—";
    return `<tr><td>${name}</td><td class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${v > 0 ? pos : v < 0 ? neg : "中立"}</td><td>${hist}</td></tr>`;
  }).join("");
  const t = r.targets;
  const levels = [...r.levels].reverse().map((l) => `<tr class="${l.price > r.close ? "" : "muted"}"><td>${l.label}</td><td>${f(l.price)}</td><td>${l.price > r.close ? "抵抗" : "支持"} ${l.price >= r.close ? "+" : "−"}${yen(Math.abs(l.price - r.close))}</td></tr>`).join("");
  const pv = r.pivots.map((p) => `${p.date.slice(5).replace("-", "/")} ${p.type === "high" ? "高値" : "安値"}${yen(p.price)}${p.confirmed ? "" : "(未確定)"}`).join(" → ");
  return `
  <section class="card">
    <p class="eyebrow">一目均衡表(日足) ${r.date} / 日経平均ベース${ic.barsSource === "nikkei+jpx" ? "(当日足は終値のみで仮計算)" : ic.barsSource === "nikkei+yahoo" ? `(${(ic.filled ?? []).map((d) => d.slice(5).replace("-", "/")).join("・")} の足は Yahoo Finance で補完)` : ""}・先物換算はベーシス ${basis >= 0 ? "+" : ""}${yen(basis)}円</p>
    <h2>一目均衡表の判断: <span class="${r.judgment === "買い" ? "up" : r.judgment === "売り" ? "down" : ""}">${r.judgment}</span> <small class="muted">スコア ${r.score >= 0 ? "+" : ""}${Math.round(r.score)}${r.sanyaku ? ` / ${r.sanyaku}` : ""}</small></h2>
    ${chart(ic)}
    <div class="table-wrap"><table><thead><tr><th>要素</th><th>現在</th><th>過去の翌日上昇率<br><small>同じ状態だった日</small></th></tr></thead><tbody>${sig}
      <tr><td>五線の値</td><td colspan="2" class="wrap">転換線 ${f(r.lines.tenkan)} / 基準線 ${f(r.lines.kijun)} / 雲 ${yen(Math.min(r.lines.spanA, r.lines.spanB))}〜${yen(Math.max(r.lines.spanA, r.lines.spanB))} / 遅行スパン 26日前 高${yen(r.chikouRef.high)} 安${yen(r.chikouRef.low)}</td></tr>
    </tbody></table></div>
    <h4>波動論(3波動): ${r.wave}</h4><p class="small">転換点: ${pv}</p>
    ${t ? `<h4>計算値(${t.direction === "up" ? "上昇" : "下落"}目標) A ${yen(t.a.price)} → B ${yen(t.b.price)} → C ${yen(t.c.price)}</h4>
    <div class="kpis">${(["N", "V", "E", "NT"] as const).map((k) => `<div class="kpi"><span>${k}計算値</span><strong>${yen(t[k])}</strong><small>先物 ${yen(t[k] + basis)} / 現値比 ${t[k] >= r.close ? "+" : "−"}${yen(Math.abs(t[k] - r.close))}</small></div>`).join("")}</div>` : ""}
    <h4>時間論(基本数値)</h4>
    <p class="small">${r.time.hits.length ? `本日は変化日の候補: ${r.time.hits.map((h) => `${h.from.slice(5).replace("-", "/")}の${h.fromType === "high" ? "高値" : "安値"}から${h.bars}日目(基本数値${h.number})`).join("、")}` : "本日は基本数値に該当なし"}。${r.time.upcoming.length ? `次の候補: ${r.time.upcoming.map((u) => `${u.inBars}営業日後(${u.from.slice(5).replace("-", "/")}から${u.number}日目)`).join("、")}` : ""}</p>
    <h4>相場水準(支持・抵抗)</h4>
    <div class="table-wrap"><table><thead><tr><th>水準</th><th>日経平均(先物換算)</th><th>現値との差</th></tr></thead><tbody>${levels}</tbody></table></div>
    <h4>バックテスト(${bt.from}〜${bt.to}, ${bt.n}日)</h4>
    <p class="small">一目の判断が「買い」だった日の翌日上昇率 ${pct(bt.buy.hit, bt.buy.n)}(${bt.buy.n}日)、5営業日後 ${pct(bt.buy5.hit, bt.buy5.n)} / 「売り」の翌日下落率 ${pct(bt.sell.hit, bt.sell.n)}(${bt.sell.n}日)、5営業日後 ${pct(bt.sell5.hit, bt.sell5.n)}。期間中の翌日上昇率は ${(bt.upRate * 100).toFixed(1)}%、5日後は ${(bt.upRate5 * 100).toFixed(1)}%。各要素の効き方はこの結果から学習した重みとして総合判断に反映し、日々の答え合わせで補正しています。</p>
  </section>`;
}

export const ICHIMOKU_CSS = `
td.wrap{white-space:normal;text-align:left;font-size:13px}
.ic-up{stroke:var(--up)}.ic-dn{stroke:var(--down)}.ic-up-b{fill:var(--up)}.ic-dn-b{fill:var(--down)}
.ic-cloud-up{fill:#27ae6033}.ic-cloud-dn{fill:#c0392b26}
.ic-tenkan{fill:none;stroke:#e67e22;stroke-width:1.5}.ic-kijun{fill:none;stroke:#2563eb;stroke-width:1.5}.ic-chikou{fill:none;stroke:#7c3aed;stroke-width:1;stroke-dasharray:3 2}
svg tspan.ic-tenkan-t{fill:#e67e22}svg tspan.ic-kijun-t{fill:#2563eb}svg tspan.ic-chikou-t{fill:#7c3aed}
.ic-target{stroke:#b7791f;stroke-dasharray:5 3}svg text.ic-target-t{fill:#b7791f;font-size:10px}
.ic-wave{stroke:#0ea5e9;stroke-width:1.2;opacity:.8}.ic-wave-abc{stroke:#0ea5e9;stroke-width:2.2}.ic-wave-tmp{stroke:#0ea5e9;stroke-width:1.2;stroke-dasharray:4 3;opacity:.7}
.ic-pv{fill:#0ea5e9}.ic-pv-abc{fill:#0ea5e9;stroke:#fff;stroke-width:1}svg text.ic-pv-t{fill:#0ea5e9;font-size:11px;font-weight:700}svg tspan.ic-wave-t{fill:#0ea5e9}
.ic-time{stroke:#d946ef;stroke-dasharray:2 3;opacity:.8}.ic-time-hit{stroke:#d946ef;stroke-width:1.5;stroke-dasharray:4 2}svg text.ic-time-t,svg tspan.ic-time-t{fill:#d946ef;font-size:10px}
`;
