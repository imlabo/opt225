import type { ModelLog, PredictionRow } from "./db";
import { FEATURES, FEATURE_LABEL, PRIOR, type Prediction } from "./model";

const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const callLabel = (c: string) => (c === "up" ? "買い" : c === "down" ? "売り" : "様子見");

export function renderModelSection(p: Prediction | null, recent: PredictionRow[], logs: ModelLog[]): string {
  if (!p) return "";
  const m = logs[logs.length - 1];
  const w = m?.weights ?? PRIOR;
  const met = m?.metrics;
  const record = recent.slice(-10).reverse().map((e) => {
    const up = e.actualSpot > e.spot;
    const dirHit = e.call === "flat" ? "—" : (e.call === "up") === up ? "◯" : "×";
    const inRange = e.actualSpot >= e.rangeLo && e.actualSpot <= e.rangeHi ? "◯" : "×";
    return `<tr><td>${e.tradeDate.slice(5).replace("-", "/")}</td><td>${callLabel(e.call)} ${Math.round(e.pUp * 100)}%</td><td class="${up ? "up" : "down"}">${yen(e.actualSpot)} (${up ? "+" : ""}${yen(e.actualSpot - e.spot)})</td><td>${dirHit}</td><td>${inRange}</td></tr>`;
  }).join("");
  const prior = m?.prior ?? PRIOR;
  const weightsRows = FEATURES.map((f) => {
    const cur = w[f] ?? 0, pri = prior[f] ?? 0, d = cur - pri;
    return `<tr><td>${FEATURE_LABEL[f]}</td><td>${pri.toFixed(2)}</td><td>${cur.toFixed(2)}</td><td class="${d > 0.005 ? "up" : d < -0.005 ? "down" : ""}">${d >= 0 ? "+" : ""}${d.toFixed(2)}</td></tr>`;
  }).join("");
  const top = p.contributions.filter((c) => Math.abs(c.value) > 0.01).slice(0, 3)
    .map((c) => `${c.label}(${c.value > 0 ? "上昇" : "下落"}寄与)`).join("、");
  return `
  <section class="card">
    <p class="eyebrow">${p.tradeDate} 引け時点のデータから / 学習済みサンプル ${p.modelN} 件</p>
    <h2>売買判断(日経平均先物・翌営業日): <span class="${p.call === "up" ? "up" : p.call === "down" ? "down" : ""}">${callLabel(p.call)}</span></h2>
    <div class="kpis">
      <div class="kpi"><span>上昇確率</span><strong>${Math.round(p.pUp * 100)}%</strong><small>55%以上で買い・45%以下で売り・その間は様子見</small></div>
      <div class="kpi"><span>予想レンジ(1σ)</span><strong>${yen(p.rangeLo)} 〜 ${yen(p.rangeHi)}</strong><small>±${yen(p.rangeHi - p.spot)}円 (係数 k=${p.k.toFixed(2)})</small></div>
      <div class="kpi"><span>これまでの成績</span><strong>${met && met.n ? `判断 ${pct(met.hitRate)} / レンジ ${pct(met.rangeRate)}` : "検証待ち"}</strong><small>${met && met.n ? `検証${met.n}件・売買判断${met.calls}件・実際の上昇率${pct(met.upRate)}${met.ichi?.calls ? `・一目単体 ${pct(met.ichi.hitRate)}(${met.ichi.calls}件)` : ""}` : "翌営業日から答え合わせを開始"}</small></div>
    </div>
    ${top ? `<p class="comment">主な根拠: ${top}。オプション建玉・投資部門別フロー・市場心理・一目均衡表を1つのモデルで総合しています。</p>` : ""}
    ${record ? `<h4>答え合わせ(直近10件)</h4><div class="table-wrap"><table><thead><tr><th>判断日</th><th>判断(上昇確率)</th><th>翌営業日の実績</th><th>方向</th><th>レンジ内</th></tr></thead><tbody>${record}</tbody></table></div>` : ""}
    <details><summary><b>学習による補正(重みの変化)</b></summary>
      <p class="small muted">一目均衡表の重みは2023年以降の過去データのバックテストで学習した値を、その他は仮説の値を起点(学習前)にしています。検証済みの判断が増えるたびに、そこから実績に合わせて重みを毎日再計算しています。サンプルが少ない間は事前仮説に近い値に留まります。予想レンジの係数 k は、実績で約68%がレンジ内に収まるよう調整されます。${met?.brier != null ? `確率の精度(ブライアスコア)は ${met.brier.toFixed(3)}(0.250 がコイン投げ相当、小さいほど良い)。` : ""}</p>
      <div class="table-wrap"><table><thead><tr><th>特徴量</th><th>学習前</th><th>現在</th><th>補正</th></tr></thead><tbody>${weightsRows}</tbody></table></div>
    </details>
  </section>`;
}
