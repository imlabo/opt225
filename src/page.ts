import type { Analysis } from "./analysis";
import { POSITION_WINDOW, WEIGHTS, Z_WINDOW } from "./analysis";
import type { WeekData } from "./types";
import type { DailyAnalysis, DailyStrike } from "./daily";
import { DAILY_CSS, renderDailySection } from "./page-daily";
import { renderModelSection } from "./page-model";
import { renderSentimentSection, SENTIMENT_CSS } from "./page-sentiment";
import { ICHIMOKU_CSS, renderIchimokuSection } from "./page-ichimoku";
import type { ModelLog, PredictionRow, SentimentView } from "./db";
import type { Prediction } from "./model";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (n: number) => (n > 0 ? "+" : "") + Math.round(n).toLocaleString("ja-JP");
const num = (n: number) => Math.round(n).toLocaleString("ja-JP");
const shortLabel = (n: number) => (n > 0 ? `${num(n)}枚 売り越し` : n < 0 ? `${num(-n)}枚 買い越し` : "0");
const okuS = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${(Math.abs(v) / 1e8).toFixed(1)}億`);
const cls = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "");

function scoreChart(list: Analysis[]): string {
  if (list.length < 2) return `<p class="muted">履歴が2週分以上たまるとチャートを表示します。</p>`;
  const W = 720, H = 220, P = 28;
  const x = (i: number) => P + (i * (W - 2 * P)) / (list.length - 1);
  const y = (v: number) => H / 2 - (v / 100) * (H / 2 - P);
  const bars = list
    .map((a, i) => {
      const bw = Math.max(3, ((W - 2 * P) / list.length) * 0.6);
      const y0 = y(0), y1 = y(a.score);
      return `<rect x="${x(i) - bw / 2}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.abs(y1 - y0) || 1}" class="${a.score >= 0 ? "bar-up" : "bar-down"}"><title>${a.weekEnd}: ${a.score} ${esc(a.bias)}</title></rect>`;
    })
    .join("");
  const labels = list
    .map((a, i) => (i % Math.ceil(list.length / 6) === 0 || i === list.length - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${a.weekEnd.slice(2).replace(/-/g, "/")}</text>` : ""))
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="総合スコア推移">
    <line x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}" class="axis"/>
    <line x1="${P}" x2="${W - P}" y1="${y(40)}" y2="${y(40)}" class="grid"/><line x1="${P}" x2="${W - P}" y1="${y(-40)}" y2="${y(-40)}" class="grid"/>
    <text x="4" y="${y(40) + 4}">+40</text><text x="4" y="${y(-40) + 4}">−40</text>
    ${bars}${labels}</svg>`;
}

function gauge(score: number): string {
  const pctPos = (score + 100) / 2;
  return `<div class="gauge"><div class="gauge-track"><span class="tick" style="left:${pctPos}%"></span></div>
    <div class="gauge-labels"><span>下落</span><span>中立</span><span>上昇</span></div></div>`;
}

export function renderPage(opts: {
  latest?: Analysis; history: Analysis[]; week?: WeekData; siteUrl: string;
  daily?: { latest?: DailyAnalysis; history: DailyAnalysis[]; strikes: DailyStrike[] };
  model?: { prediction: Prediction | null; recent: PredictionRow[]; logs: ModelLog[] };
  sentiment?: SentimentView;
}): string {
  const { latest, history, week } = opts;
  const body = !latest
    ? `<section class="card"><h2>データ未取得</h2><p>JPX の週次データ取得後に表示されます。</p></section>`
    : `
  <h2 class="section-title">週次: 個人・法人のポジション</h2>
  ${week?.isSample ? `<div class="banner">⚠ 表示中はサンプルデータです(実データではありません)。</div>` : ""}
  ${history.length < Z_WINDOW / 2 ? `<div class="banner">データ蓄積中(${history.length}週分)。比較対象の週が少ないため、${Math.ceil(Z_WINDOW / 2)}週分たまるまではスコアの信頼度が低めです。</div>` : ""}
  <section class="hero card">
    <div>
      <p class="eyebrow">${esc(week?.weekStart ?? "")} 〜 ${esc(latest.weekEnd)} 週の売買から推計</p>
      <h2>日経平均先物 見通し: <span class="${cls(latest.score)}">${esc(latest.bias)}</span></h2>
      <p class="score ${cls(latest.score)}">${latest.score > 0 ? "+" : ""}${latest.score}<small> / 100</small></p>
      ${gauge(latest.score)}
    </div>
    <div class="side">
      <div class="kpi"><span>ボラティリティ環境</span><strong>${esc(latest.volSignal)}</strong></div>
      <p class="comment">${esc(latest.comment)}</p>
    </div>
  </section>

  <section class="card">
    <h3>投資部門別 日経225オプション フロー(枚)</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>部門</th><th>コール 買−売</th><th>プット 買−売</th><th>方向性<br><small>C−P</small></th><th>推定ポジション<br><small>${POSITION_WINDOW}週累積</small></th><th>z</th><th>先物 買−売</th></tr></thead>
      <tbody>${latest.investors
        .map(
          (m) => `<tr class="${m.investor === "individual" || m.investor === "corporate" ? "focus" : ""}"><td>${esc(m.label)}</td>
          <td class="${cls(m.netCall)}">${fmt(m.netCall)}</td><td class="${cls(m.netPut)}">${fmt(m.netPut)}</td>
          <td class="${cls(m.directional)}">${fmt(m.directional)}</td><td class="${cls(m.position)}">${fmt(m.position)}</td>
          <td>${m.z.toFixed(2)}</td><td class="${cls(latest.futNet[m.investor] ?? 0)}">${latest.futNet[m.investor] != null ? fmt(latest.futNet[m.investor]!) : "—"}</td></tr>`,
        )
        .join("")}</tbody></table></div>
    <h4>推定売りポジション(直近${POSITION_WINDOW}週の売り越し累計)</h4>
    <div class="table-wrap"><table>
      <thead><tr><th>部門</th><th>コール 売 / 買<br><small>当週</small></th><th>プット 売 / 買<br><small>当週</small></th><th>コール<br>推定売り越し</th><th>プット<br>推定売り越し</th><th>受取プレミアム超過<br><small>コール / プット</small></th></tr></thead>
      <tbody>${latest.investors.filter((m) => m.short)
        .map((m) => `<tr class="${m.investor === "individual" || m.investor === "corporate" ? "focus" : ""}"><td>${esc(m.label)}</td>
          <td>${num(m.short.callSell)} / ${num(m.short.callBuy)}</td><td>${num(m.short.putSell)} / ${num(m.short.putBuy)}</td>
          <td class="${m.short.estCallShort > 0 ? "down" : m.short.estCallShort < 0 ? "up" : ""}">${shortLabel(m.short.estCallShort)}</td>
          <td class="${m.short.estPutShort > 0 ? "down" : m.short.estPutShort < 0 ? "up" : ""}">${shortLabel(m.short.estPutShort)}</td>
          <td>${okuS(m.short.callPremiumNet)} / ${okuS(m.short.putPremiumNet)}</td></tr>`)
        .join("")}</tbody></table></div>
    <p class="muted small">売り越し累計が正なら売りポジション(ショート)を積み上げている推定、負なら買い越し。JPX は部門別の建玉を公表していないため売買差の累計による推定値で、SQ による建玉消滅は考慮していません。受取プレミアム超過は売り代金−買い代金。</p>
    <h4>スコア寄与</h4>
    <ul class="contrib">${latest.contributions
      .map((c) => `<li><span>${esc(c.label)}</span><span class="bar"><i class="${c.value >= 0 ? "bar-up" : "bar-down"}" style="width:${Math.min(100, Math.abs(c.value))}%"></i></span><b class="${cls(c.value)}">${fmt(c.value)}</b></li>`)
      .join("")}</ul>
  </section>

  <section class="card"><h3>総合スコア推移</h3>${scoreChart(history)}</section>`;

  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>日経225 OPフロー観測</title>
<meta name="description" content="JPX公表の投資部門別取引状況から、日経225オプションの個人・法人ポジションを推計し日経平均先物の方向感を週次で分析します。">
<meta property="og:title" content="日経225 OPフロー観測"><meta property="og:url" content="${esc(opts.siteUrl)}">
${latest ? `<meta property="og:description" content="${esc(`先物見通し: ${latest.bias}(${latest.score}) / ボラ: ${latest.volSignal}`)}">` : ""}
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#14171c;--muted:#5d6672;--line:#e3e6ea;--up:#c62d2d;--down:#1f6fd1;--accent:#0f172a}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--card:#161b22;--fg:#e6edf3;--muted:#8b949e;--line:#2a313a;--up:#ff6b6b;--down:#58a6ff;--accent:#e6edf3}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}
header,main,footer{max-width:960px;margin:0 auto;padding:16px}
header h1{font-size:18px;margin:8px 0 0}header p{margin:0;color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin:16px 0}
.hero{display:grid;grid-template-columns:1.3fr 1fr;gap:24px}@media(max-width:720px){.hero{grid-template-columns:1fr}}
.eyebrow{color:var(--muted);font-size:13px;margin:0}h2{font-size:20px;margin:4px 0}h3{font-size:16px;margin:0 0 12px}h4{font-size:14px;margin:20px 0 8px;color:var(--muted)}
.score{font-size:48px;font-weight:700;margin:0;font-variant-numeric:tabular-nums}.score small{font-size:16px;color:var(--muted);font-weight:400}
.up{color:var(--up)}.down{color:var(--down)}.muted{color:var(--muted)}
.gauge-track{position:relative;height:8px;border-radius:4px;background:linear-gradient(90deg,var(--down),var(--line),var(--up))}
.tick{position:absolute;top:-5px;width:4px;height:18px;margin-left:-2px;background:var(--accent);border-radius:2px}
.gauge-labels{display:flex;justify-content:space-between;font-size:12px;color:var(--muted)}
.kpi{border:1px solid var(--line);border-radius:8px;padding:12px}.kpi span{display:block;font-size:12px;color:var(--muted)}.kpi strong{font-size:20px}
.comment{font-size:14px}
.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:14px}
th,td{padding:8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th:first-child,td:first-child{text-align:left}th{font-size:12px;color:var(--muted);font-weight:500}
tr.focus td:first-child{font-weight:700}
.contrib{list-style:none;padding:0;margin:0}.contrib li{display:grid;grid-template-columns:90px 1fr 60px;gap:8px;align-items:center;padding:4px 0}
.bar{height:8px;background:var(--line);border-radius:4px;overflow:hidden}.bar i{display:block;height:100%}
.bar-up{fill:var(--up);background:var(--up)}.bar-down{fill:var(--down);background:var(--down)}.contrib b{text-align:right}
svg{width:100%;height:auto}svg text{fill:var(--muted);font-size:11px}.axis{stroke:var(--muted)}.grid{stroke:var(--line);stroke-dasharray:4 4}
.banner{background:#fff3cd;color:#664d03;border-radius:8px;padding:10px 14px;margin-top:16px;font-size:14px}
details{font-size:14px}.section-title{font-size:16px;margin:28px 0 0}${DAILY_CSS}${SENTIMENT_CSS}${ICHIMOKU_CSS}footer{color:var(--muted);font-size:12px}
</style></head><body>
<header><h1>日経225 OPフロー観測</h1><p>日経225オプションの建玉(日次)と個人・法人の売買(週次)から日経平均先物の方向感を推計・X自動投稿</p></header>
<main>${opts.model ? renderModelSection(opts.model.prediction, opts.model.recent, opts.model.logs) : ""}${renderIchimokuSection(opts.daily?.latest)}${renderSentimentSection(opts.sentiment)}${opts.daily ? renderDailySection(opts.daily.latest, opts.daily.history, opts.daily.strikes) : ""}${body}
<section class="card"><details><summary><b>推計方法</b></summary>
<p>データ: JPX「投資部門別取引状況(先物・オプション/週間)」の日経225オプション(コール/プット)売買枚数。JPXは部門別の<em>建玉</em>を公表していないため、売買差引を累積して<em>推定ポジション</em>としています。</p>
<ol><li>方向性フロー = (コール買い−売り) − (プット買い−売り)</li>
<li>推定ポジション = 方向性フローの直近${POSITION_WINDOW}週累積。過去26週に対する z スコアで標準化</li>
<li>総合スコア = 個人(逆張り, 重み${WEIGHTS.individual}) + 法人(順張り, ${WEIGHTS.corporate}) + 海外(順張り, ${WEIGHTS.foreign}) を −100〜+100 に正規化</li>
<li>ボラ環境 = 個人のオプション純売り(売り−買い)の z スコア。売り越し膨張時はショート・ボラの巻き戻しによる急変動に警戒</li></ol>
<p>枚数ベースのためプレミアム・行使価格・限月の違いは考慮していません。</p>
<p><b>日次</b>: JPX「建玉残高状況」(行使価格別)と「清算値段等」(清算価格・IV)を毎営業日取得。期近(SQまで3日以上の最も近い限月)について、現値以下で最大のプット建玉を「下の壁」、現値以上で最大のコール建玉を「上の壁」、オプション買い手の満期価値合計が最小になる価格を「最大苦痛価格」、ATM IV×√(残日数/365) を SQ までの 1σ 変動幅としています。日次では投資部門別の内訳は公表されません。</p></details></section>
</main>
<footer><p>本サイトは公開統計を機械的に処理した参考情報であり、投資助言・売買推奨ではありません。投資判断はご自身の責任で行ってください。出典: 日本取引所グループ。</p>
<p><a href="/api/latest">API</a></p></footer>
</body></html>`;
}
