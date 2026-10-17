import type { SentimentView } from "./db";
import { COMPONENTS, RATING_LABEL, ratingOf, type ComponentKey } from "./sentiment";

const BANDS = [
  { to: 25, cls: "fg-ef", label: "極度の恐怖" }, { to: 45, cls: "fg-f", label: "恐怖" }, { to: 55, cls: "fg-n", label: "中立" },
  { to: 75, cls: "fg-g", label: "強欲" }, { to: 100, cls: "fg-eg", label: "極度の強欲" },
];

/** CNN 風の半円ゲージ */
function gauge(score: number, title: string): string {
  const cx = 150, cy = 140, r = 110, rw = 26;
  const pt = (v: number, rad: number) => {
    const a = Math.PI * (1 - v / 100);
    return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)];
  };
  let from = 0;
  const arcs = BANDS.map((b) => {
    const [x1, y1] = pt(from, r), [x2, y2] = pt(b.to, r), [x3, y3] = pt(b.to, r - rw), [x4, y4] = pt(from, r - rw);
    const active = score >= from && (score < b.to || b.to === 100);
    const d = `M${x1},${y1} A${r},${r} 0 0 1 ${x2},${y2} L${x3},${y3} A${r - rw},${r - rw} 0 0 0 ${x4},${y4} Z`;
    from = b.to;
    return `<path d="${d}" class="${b.cls}${active ? " fg-on" : ""}"/>`;
  }).join("");
  const [nx, ny] = pt(score, r - rw - 8);
  return `<svg viewBox="0 0 300 175" role="img" aria-label="${title} ${Math.round(score)}">
    ${arcs}<line x1="${cx}" y1="${cy}" x2="${nx}" y2="${ny}" class="fg-needle"/><circle cx="${cx}" cy="${cy}" r="6" class="fg-hub"/>
    <text x="${cx}" y="${cy + 30}" text-anchor="middle" class="fg-score">${Math.round(score)}</text>
    <text x="22" y="${cy + 18}" class="fg-end">0</text><text x="270" y="${cy + 18}" class="fg-end">100</text></svg>`;
}

function line(series: { date: string; score: number }[][], names: string[]): string {
  const all = series.flat();
  if (all.length < 5) return "";
  const dates = [...new Set(all.map((p) => p.date))].sort();
  const W = 720, H = 180, P = 28;
  const x = (d: string) => P + (dates.indexOf(d) / Math.max(1, dates.length - 1)) * (W - 2 * P);
  const y = (v: number) => H - P - (v / 100) * (H - 2 * P);
  const paths = series.map((s, i) => s.length < 2 ? "" :
    `<path d="${s.map((p, j) => `${j ? "L" : "M"}${x(p.date).toFixed(1)},${y(p.score).toFixed(1)}`).join("")}" class="fg-line fg-line${i}"/>`).join("");
  const grid = [25, 50, 75].map((v) => `<line x1="${P}" x2="${W - P}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="2" y="${y(v) + 4}">${v}</text>`).join("");
  const ticks = dates.filter((_, i) => i % Math.ceil(dates.length / 6) === 0).map((d) => `<text x="${x(d)}" y="${H - 6}" text-anchor="middle">${d.slice(2, 7).replace("-", "/")}</text>`).join("");
  const legend = names.map((n, i) => `<tspan class="fg-leg${i}">━ ${n}</tspan>`).join("　");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="推移">${grid}${paths}${ticks}<text x="${W - P}" y="14" text-anchor="end">${legend}</text></svg>`;
}

const ago = (label: string, v?: number) => (v == null ? "" : `<li><span>${label}</span><b>${Math.round(v)}</b><small>${RATING_LABEL[ratingOf(v)]}</small></li>`);

export function renderSentimentSection(s: SentimentView | undefined): string {
  if (!s || (!s.nikkei && !s.cnn)) return "";
  const nk = s.nikkei;
  const comps = nk ? (Object.keys(COMPONENTS) as ComponentKey[]).map((k) => {
    const c = nk.components[k];
    return `<li><span>${COMPONENTS[k].label}</span><span class="bar"><i class="${c && c.score >= 50 ? "bar-up" : "bar-down"}" style="width:${c ? Math.round(c.score) : 0}%"></i></span><b>${c ? Math.round(c.score) : "—"}</b></li>`;
  }).join("") : "";
  const nkHist = s.nikkeiHistory;
  const nkAgo = (days: number) => {
    if (!nk) return undefined;
    const target = new Date(Date.parse(nk.date) - days * 864e5).toISOString().slice(0, 10);
    return [...nkHist].reverse().find((p) => p.date <= target)?.score;
  };
  return `
  <section class="card">
    <h2>市場心理: Fear &amp; Greed</h2>
    <div class="fg-grid">
      ${nk ? `<div class="fg-box"><h3>日経225 Fear &amp; Greed <small class="muted">(本サイト算出)</small></h3>${gauge(nk.score, "日経225")}
        <p class="fg-rating">${RATING_LABEL[nk.rating]}</p><p class="muted small center">${nk.date} 時点</p>
        <ul class="fg-ago">${ago("前日", nkHist[nkHist.length - 2]?.score)}${ago("1週間前", nkAgo(7))}${ago("1か月前", nkAgo(30))}${ago("1年前", nkAgo(365))}</ul></div>` : ""}
      ${s.cnn ? `<div class="fg-box"><h3>CNN Fear &amp; Greed <small class="muted">(米国株)</small></h3>${gauge(s.cnn.score, "CNN")}
        <p class="fg-rating">${RATING_LABEL[s.cnn.rating]}</p><p class="muted small center">${s.cnn.date} 時点 / 出典: <a href="https://edition.cnn.com/markets/fear-and-greed" rel="noopener">CNN Business</a></p>
        <ul class="fg-ago">${ago("前日", s.cnn.previousClose)}${ago("1週間前", s.cnn.previous1Week)}${ago("1か月前", s.cnn.previous1Month)}${ago("1年前", s.cnn.previous1Year)}</ul></div>` : ""}
    </div>
    ${comps ? `<h4>日経225 Fear &amp; Greed の内訳(0=恐怖 / 100=強欲)</h4><ul class="contrib fg-comps">${comps}</ul>` : ""}
    <h4>推移(1年)</h4>${line([s.nikkeiHistory, s.cnnHistory], ["日経225", "CNN(米国)"])}
    <p class="muted small">日経225 Fear &amp; Greed は CNN と同じ考え方で、各指標の当日値が過去約2年(500営業日)の中でどの位置にあるかを0〜100に換算し平均したものです。P/C建玉比とスキューは本サイトでの蓄積が20営業日に達してから算入します。</p>
  </section>`;
}

export const SENTIMENT_CSS = `
.fg-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:720px){.fg-grid{grid-template-columns:1fr}}
.fg-box{border:1px solid var(--line);border-radius:10px;padding:12px}.fg-box h3{margin:0 0 4px;font-size:15px}
.fg-ef{fill:#c0392b33}.fg-f{fill:#e67e2233}.fg-n{fill:#95a5a633}.fg-g{fill:#27ae6033}.fg-eg{fill:#16a08533}
.fg-ef.fg-on{fill:#c0392b}.fg-f.fg-on{fill:#e67e22}.fg-n.fg-on{fill:#95a5a6}.fg-g.fg-on{fill:#27ae60}.fg-eg.fg-on{fill:#16a085}
.fg-needle{stroke:var(--fg);stroke-width:4;stroke-linecap:round}.fg-hub{fill:var(--fg)}
svg text.fg-score{font-size:34px;font-weight:700;fill:var(--fg)}svg text.fg-end{font-size:11px}
.fg-rating{text-align:center;font-weight:700;font-size:18px;margin:0}.center{text-align:center}
.fg-ago{list-style:none;padding:0;margin:8px 0 0;display:grid;grid-template-columns:repeat(4,1fr);gap:6px;text-align:center;font-size:12px}
.fg-ago li{border:1px solid var(--line);border-radius:6px;padding:4px}.fg-ago span,.fg-ago small{display:block;color:var(--muted)}.fg-ago b{font-size:16px}
.fg-comps li{grid-template-columns:200px 1fr 40px}@media(max-width:720px){.fg-comps li{grid-template-columns:130px 1fr 32px;font-size:12px}}
.fg-line{fill:none;stroke-width:2}.fg-line0{stroke:#2563eb}.fg-line1{stroke:#e67e22}
svg tspan.fg-leg0{fill:#2563eb}svg tspan.fg-leg1{fill:#e67e22}
`;
