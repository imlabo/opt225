import type { ModelLog, PredictionRow } from "./db";
import { FEATURES, FEATURE_LABEL, PRIOR, type Prediction } from "./model";
import { GROUPS, GROUP_KEYS, MIN_SAMPLES, configLabel, type ModelConfig, type TuningReport } from "./tuning";

const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");
const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const callLabel = (c: string) => (c === "up" ? "買い" : c === "down" ? "売り" : "様子見");

/** 自動改善の記録 */
function tuningBlock(cfg: ModelConfig | undefined, log: TuningReport[]): string {
  if (!cfg) return "";
  const last = log[log.length - 1];
  const changes = log.filter((r) => r.changed).slice(-8).reverse();
  const md = (d: string) => d.slice(5).replace("-", "/");
  const ll = (v: number) => v.toFixed(4);
  const head = `<p class="small">現在の設定: <b>${configLabel(cfg)}・しきい値 ${Math.round(cfg.threshold * 100)}%</b>${cfg.since ? `(${md(cfg.since)}から)` : "(初期設定)"}。使用中の特徴量: ${GROUP_KEYS.filter((g) => !cfg.off.includes(g) && g !== "ichimoku").map((g) => GROUPS[g].label.replace(/\(.*\)/, "")).join("・")}。</p>`;
  if (!last) return `${head}<p class="small muted">答え合わせが始まると、毎日ここに見直しの結果が載ります。</p>`;
  const cands = last.candidates.map((c, i) => `<tr><td>${i + 1}</td><td>${c.label}</td><td>${ll(c.logloss)}</td><td>${c.brier.toFixed(3)}</td><td>${c.hitRate == null ? "—" : `${Math.round(c.hitRate * 100)}%(${c.calls}件)`}</td></tr>`).join("");
  const groups = [...last.groups].filter((g) => g.group !== "ichimoku").sort((a, b) => b.delta - a.delta).map((g) => `<tr><td>${g.label}</td><td class="${g.delta > 0.001 ? "up" : g.delta < -0.001 ? "down" : ""}">${g.delta >= 0 ? "+" : ""}${g.delta.toFixed(4)}</td><td>${g.delta > 0.001 ? "役に立っている" : g.delta < -0.001 ? "今は逆効果" : "ほぼ影響なし"}${cfg.off.includes(g.group) ? "(除外中)" : ""}</td></tr>`).join("");
  const feats = last.features.filter((f) => f.n >= 3 && !f.feature.startsWith("ichi")).sort((a, b) => Math.abs((b.hitRate ?? 0.5) - 0.5) - Math.abs((a.hitRate ?? 0.5) - 0.5)).slice(0, 8)
    .map((f) => `<tr><td>${f.label}</td><td>${f.hitRate == null ? "—" : `${Math.round(f.hitRate * 100)}%`}</td><td>${f.n}件</td></tr>`).join("");
  const ths = last.thresholds.map((t) => `<tr><td>${Math.round(t.threshold * 100)}%</td><td>${t.calls}件</td><td>${t.hitRate == null ? "—" : `${Math.round(t.hitRate * 100)}%`}</td><td>${(t.pnlPerDay * 100).toFixed(3)}%</td></tr>`).join("");
  return `${head}
    <p class="comment">${md(last.date)} の見直し(検証済み ${last.n}件): ${last.note}。</p>
    ${changes.length ? `<h5>設定変更の履歴</h5><ul class="small">${changes.map((r) => `<li>${md(r.date)}: ${r.note}</li>`).join("")}</ul>` : ""}
    <h5>候補の成績(ウォークフォワード検証、上位)</h5>
    <div class="table-wrap"><table><thead><tr><th></th><th>設定</th><th>対数損失</th><th>ブライア</th><th>方向的中</th></tr></thead><tbody>${cands}</tbody></table></div>
    <h5>特徴量グループの貢献(外すと対数損失がどれだけ悪化するか)</h5>
    <div class="table-wrap"><table><thead><tr><th>グループ</th><th>悪化幅</th><th>評価</th></tr></thead><tbody>${groups}</tbody></table></div>
    ${feats ? `<h5>特徴量単体の当たり方(値の向きどおりに翌日動いた割合、50%から遠いものほど効いている)</h5><div class="table-wrap"><table><thead><tr><th>特徴量</th><th>向きどおり</th><th>件数</th></tr></thead><tbody>${feats}</tbody></table></div>` : ""}
    <h5>しきい値ごとの成績</h5>
    <div class="table-wrap"><table><thead><tr><th>しきい値</th><th>明示した件数</th><th>方向的中</th><th>1日あたり損益(変化率)</th></tr></thead><tbody>${ths}</tbody></table></div>
    <p class="small muted">毎日の答え合わせの後、過去の判断を「その日より前のデータだけで学習 → その日を予測」で順に再現(ウォークフォワード検証)し、正則化の強さ(リッジ: 事前仮説への寄せ具合)、使う特徴量グループ、方向を明示するしきい値の組み合わせを比べています。対数損失(確率予測のずれ、0.693 がコイン投げ相当で小さいほど良い)が今の設定より 0.004 以上良い候補が見つかったときだけ切り替えます。検証済みが ${MIN_SAMPLES}件たまるまでは切り替えず、しきい値の変更は 20件以上たまってから実績の損益で判断します。</p>`;
}

export function renderModelSection(p: Prediction | null, recent: PredictionRow[], logs: ModelLog[], cfg?: ModelConfig, tuning: TuningReport[] = []): string {
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
  const weightsRows = FEATURES.filter((f) => !f.startsWith("ichi")).map((f) => {
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
      <div class="kpi"><span>上昇確率</span><strong>${Math.round(p.pUp * 100)}%</strong><small>${Math.round((p.threshold ?? 0.55) * 100)}%以上で買い・${Math.round((1 - (p.threshold ?? 0.55)) * 100)}%以下で売り・その間は様子見</small></div>
      <div class="kpi"><span>予想レンジ(1σ)</span><strong>${yen(p.rangeLo)} 〜 ${yen(p.rangeHi)}</strong><small>±${yen(p.rangeHi - p.spot)}円 (係数 k=${p.k.toFixed(2)})</small></div>
      <div class="kpi"><span>これまでの成績</span><strong>${met && met.n ? `判断 ${pct(met.hitRate)} / レンジ ${pct(met.rangeRate)}` : "検証待ち"}</strong><small>${met && met.n ? `検証${met.n}件・売買判断${met.calls}件・実際の上昇率${pct(met.upRate)}` : "翌営業日から答え合わせを開始"}</small></div>
    </div>
    ${top ? `<p class="comment">主な根拠: ${top}。オプション建玉・投資部門別フロー・市場心理などを1つのモデルで総合しています。</p>` : ""}
    ${record ? `<h4>答え合わせ(直近10件)</h4><div class="table-wrap"><table><thead><tr><th>判断日</th><th>判断(上昇確率)</th><th>翌営業日の実績</th><th>方向</th><th>レンジ内</th></tr></thead><tbody>${record}</tbody></table></div>` : ""}
    <details open><summary><b>予測ロジックの自動改善(毎日の見直し)</b></summary>${tuningBlock(cfg, tuning)}</details>
    <details><summary><b>学習による補正(重みの変化)</b></summary>
      <p class="small muted">仮説の値を起点(学習前)にしています。検証済みの判断が増えるたびに、そこから実績に合わせて重みを毎日再計算しています。サンプルが少ない間は事前仮説に近い値に留まります。予想レンジの係数 k は、実績で約68%がレンジ内に収まるよう調整されます。${met?.brier != null ? `確率の精度(ブライアスコア)は ${met.brier.toFixed(3)}(0.250 がコイン投げ相当、小さいほど良い)。` : ""}</p>
      <div class="table-wrap"><table><thead><tr><th>特徴量</th><th>学習前</th><th>現在</th><th>補正</th></tr></thead><tbody>${weightsRows}</tbody></table></div>
    </details>
  </section>`;
}
