import type { DailyAnalysis } from "./daily";
import { BASIC_NUMBERS, SIGNAL_KEYS, type Targets } from "./ichimoku";

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
  const bars = ic.chart.slice(-110), fut = ic.futureCloud;
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
  const t = scenarioTargets(ic);
  const tline = (v: number, label: string) => v >= min && v <= max ? `<line x1="${x(bars.length - 1)}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" class="ic-target"/><text x="${W - 12}" y="${y(v) - 3}" text-anchor="end" class="ic-target-t">${label} ${yen(v)}</text>` : "";
  // 波動論(3波動): 転換点を結ぶジグザグ(細線)+ 読み方の候補ごとの A→B→C(第1候補は太線・ラベル付き、他は破線)
  const idx = new Map(bars.map((b, i) => [b.date, i]));
  const pvIn = ic.result.pivots.map((p) => ({ ...p, k: idx.get(p.date) })).filter((p): p is typeof p & { k: number } => p.k != null);
  let wave = "";
  for (let k = 1; k < pvIn.length; k++) {
    const p = pvIn[k - 1], q = pvIn[k];
    wave += `<line x1="${x(p.k).toFixed(1)}" y1="${y(p.price).toFixed(1)}" x2="${x(q.k).toFixed(1)}" y2="${y(q.price).toFixed(1)}" class="${!q.confirmed ? "ic-wave-tmp" : "ic-wave"}"/>`;
  }
  wave += pvIn.map((p) => `<circle cx="${x(p.k).toFixed(1)}" cy="${y(p.price).toFixed(1)}" r="2.5" class="ic-pv"><title>${p.date} ${p.type === "high" ? "高値" : "安値"} ${yen(p.price)}${p.confirmed ? "" : "(未確定)"}</title></circle>`).join("");
  const scen = (ic.result.scenarios ?? []).slice(0, 4);
  scen.forEach((sc, n) => {
    const pts = [sc.t.a, sc.t.b, sc.t.c].map((p) => ({ ...p, k: idx.get(p.date) }));
    if (pts.some((p) => p.k == null)) return;
    const d = pts.map((p) => `${x(p.k!).toFixed(1)},${y(p.price).toFixed(1)}`).join("L");
    const title = `${sc.t.direction === "up" ? "上昇" : "下落"}3波動の読み${n + 1}: A ${pts[0].date} → B ${pts[1].date} → C ${pts[2].date} / N計算値 ${yen(sc.t.N)}`;
    wave += `<path d="M${d}" class="${n === 0 ? "ic-sc-main" : "ic-sc"}"><title>${title}</title></path>`;
    if (n === 0) wave += pts.map((p, j) => `<circle cx="${x(p.k!).toFixed(1)}" cy="${y(p.price).toFixed(1)}" r="3.5" class="ic-pv-abc"/><text x="${x(p.k!).toFixed(1)}" y="${(y(p.price) + (p.type === "high" ? -7 : 14)).toFixed(1)}" text-anchor="middle" class="ic-pv-t">${"ABC"[j]}</text>`).join("");
    else { // ラベルは A→B の中点に(B は他の読みの C と重なりやすい)
      const mx = (x(pts[0].k!) + x(pts[1].k!)) / 2, my = (y(pts[0].price) + y(pts[1].price)) / 2;
      wave += `<text x="${(mx + 6).toFixed(1)}" y="${(my - 4).toFixed(1)}" class="ic-sc-t">読み${n + 1}</text>`;
    }
  });
  // 時間論: 変化日の候補を縦線で表示(当日の該当と 10 営業日以内の次候補、同じ日はまとめる)。基準日は tooltip に
  const tm = ic.result.time;
  const md = (d: string) => d.slice(5).replace("-", "/");
  const basis = (u: { from: string; fromType: "high" | "low"; number: number }) => `${md(u.from)}${u.fromType === "high" ? "高値" : "安値"}から${u.number}日目`;
  let vn = 0; // ラベルが重ならないよう 3 段に振り分け
  const vline = (k: number, label: string, cls: string, title: string) =>
    `<line x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="32" y2="${H - 22}" class="${cls}"><title>${title}</title></line><text x="${x(k).toFixed(1)}" y="${[9, 19, 29][vn++ % 3]}" text-anchor="middle" class="ic-time-t">${label}</text>`;
  const byDay = new Map<number, typeof tm.upcoming>();
  for (const u of tm.upcoming) byDay.set(u.inBars, [...(byDay.get(u.inBars) ?? []), u]);
  const changeDays = (tm.hits.length ? vline(bars.length - 1, "変化日", "ic-time-hit", `本日: ${tm.hits.map(basis).join(" / ")}`) : "") +
    [...byDay].map(([inBars, us]) => vline(bars.length - 1 + inBars, us.map((u) => u.number).join("·"), "ic-time", `${md(us[0].date)}: ${us.map(basis).join(" / ")}`)).join("");
  const yt = [0, 0.25, 0.5, 0.75, 1].map((r) => min + (max - min) * r).map((v) => `<text x="2" y="${y(v) + 4}">${(v / 1000).toFixed(1)}k</text>`).join("");
  const xt = bars.filter((_, i) => i % 20 === 0).map((b) => `<text x="${x(bars.indexOf(b))}" y="${H - 8}" text-anchor="middle">${b.date.slice(5).replace("-", "/")}</text>`).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="一目均衡表 日足${ic.series === "futures" ? "(日経225先物)" : "(日経平均)"}">${yt}${xt}${cloud}${candles}${line("tenkan", "ic-tenkan")}${line("kijun", "ic-kijun")}
    ${chikou.length > 1 ? `<path d="M${chikou.join("L")}" class="ic-chikou"/>` : ""}
    ${t ? tline(t.N, "N") + tline(t.NT, "NT") + tline(t.V, "V") : ""}${changeDays}${wave}
    <text x="${W - 12}" y="${H - 8}" text-anchor="end"><tspan class="ic-tenkan-t">━ 転換線</tspan> <tspan class="ic-kijun-t">━ 基準線</tspan> <tspan class="ic-chikou-t">━ 遅行スパン</tspan> <tspan class="ic-wave-t">━ 3波動の読み(A→B→C)</tspan> <tspan class="ic-time-t">┆ 変化日</tspan></text></svg>`;
}

const DOW = ["日", "月", "火", "水", "木", "金", "土"];
const md = (d: string) => d.slice(5).replace("-", "/");

/** 支持・抵抗の候補: 上下それぞれ現値に近い順に 5 つ、根拠を列挙 */
/** 換算表示: 先物ベースなら「現物 xx」、現物ベースなら「先物 xx」 */
let CONV: (v: number) => string = (v) => yen(v);
function candidatesBlock(r: IchiView["result"], basis: number): string {
  const cs = r.candidates;
  if (!cs?.length) return `<p class="small muted">候補は次回の更新から表示されます。</p>`;
  const KIND: Record<string, string> = { line: "線", cloud: "雲", futureCloud: "先行", chikou: "遅行", pivot: "高安", target: "計算値", half: "半値", round: "大台" };
  // 近い順に 5 つ + 根拠の重なる強い候補(★★以上)を加えて最大 7 つ、距離順に
  const pick = (s: "support" | "resistance") => {
    const all = cs.filter((c) => c.side === s);
    const sel = new Set([...all.slice(0, 5), ...all.filter((c) => c.strength >= 2).slice(0, 4)]);
    return [...sel].slice(0, 7).sort((a, b) => Math.abs(a.price - r.close) - Math.abs(b.price - r.close));
  };
  const side = (s: "support" | "resistance") => pick(s).map((c) => {
    const stars = c.strength >= 3 ? "★★★" : c.strength >= 2 ? "★★" : "★";
    const range = c.hi - c.lo > 1 ? `${yen(c.lo)}〜${yen(c.hi)}` : yen(c.price);
    return `<tr><td><strong>${range}</strong><br><small class="muted">${CONV(c.price)} / 現値比 ${c.price >= r.close ? "+" : "−"}${yen(Math.abs(c.price - r.close))}</small></td>
      <td class="${c.strength >= 3 ? (s === "support" ? "up" : "down") : ""}">${stars}</td>
      <td class="wrap">${c.reasons.map((x) => `<span class="lv-kind">${KIND[x.kind] ?? x.kind}</span> ${x.label} ${yen(x.price)}`).join("<br>")}</td></tr>`;
  }).join("");
  const head = `<thead><tr><th>水準</th><th>強さ</th><th>根拠</th></tr></thead>`;
  return `<p class="small muted">現値 ${yen(r.close)} の上下 12% にある水準(五線・雲・先行スパン・遅行スパンの目安・転換点・各読みの計算値と半値・大台)を集め、±0.4% 以内で重なるものを 1 つの候補にまとめています。根拠の種類が多いほど★が多く、意識されやすい水準です。</p>
    <h5>上値の候補(抵抗)</h5><div class="table-wrap"><table>${head}<tbody>${side("resistance") || `<tr><td colspan="3" class="muted">なし</td></tr>`}</tbody></table></div>
    <h5>下値の候補(支持)</h5><div class="table-wrap"><table>${head}<tbody>${side("support") || `<tr><td colspan="3" class="muted">なし</td></tr>`}</tbody></table></div>`;
}

/** チャートに引く計算値: 進行中の第3波の読みがあればそれ、なければ次の波の第1候補 */
function scenarioTargets(ic: IchiView): Targets | null {
  return ic.result.scenarios?.[0]?.t ?? ic.result.targets;
}

/** 3波動の読み方の候補を順に表示 */
function scenariosBlock(ic: IchiView, basis: number): string {
  const r = ic.result;
  const list = r.scenarios ?? (r.targets ? [{ t: r.targets, inProgress: false, progress: null, extreme: null, waveSize: 0 }] : []);
  if (!list.length) return `<h4>計算値(3波動)</h4><p class="small">転換点がそろうと表示します。</p>`;
  const blocks = list.map((sc, n) => {
    const t = sc.t, up = t.direction === "up";
    const status = sc.inProgress
      ? `<span class="${up ? "up" : "down"}">第3波が進行中</span>: 現在の極値 ${yen(sc.extreme!)} は C から N計算値までの <strong>${Math.round((sc.progress ?? 0) * 100)}%</strong> の位置${t.direction === "down" ? "(下げ余地 N まで " + yen(Math.max(0, sc.extreme! - t.N)) + "円)" : "(上げ余地 N まで " + yen(Math.max(0, t.N - sc.extreme!)) + "円)"}`
      : t.cTentative ? `C は反転が未確定の進行中の極値。${up ? "下落" : "上昇"}が続けば C と計算値は更新されます` : "C 確定後の次の波の目標";
    return `<div class="scenario${n === 0 ? " scenario-main" : ""}"><p class="small"><strong>読み${n + 1}: ${up ? "上昇" : "下落"}3波動</strong> — ${status}</p>${targetsBlock(t, r.close, basis)}</div>`;
  });
  return `<h4>計算値(3波動の読み方 ${list.length} 通り)</h4>
    <p class="small muted">転換点の組み合わせから「A→B = 第1波、B→C = ${"押し・戻し"}、C→D = 第3波」として成り立つ読みをすべて挙げています(小さな波を戻しの一部とみなす大きな読みも含む)。どの読みが本線かは相場の進み方で決まります。</p>${blocks.join("")}`;
}

/** 計算値: 基準の A・B・C と算式を明示する */
function targetsBlock(t: Targets, close: number, basis: number): string {
  const up = t.direction === "up";
  const pt = (p: Targets["a"], name: string) => `<strong>${name}</strong> ${md(p.date)} ${p.type === "high" ? "高値" : "安値"} ${yen(p.price)}${p.confirmed ? "" : "<small class=\"muted\">(未確定・進行中)</small>"}`;
  const ab = Math.abs(t.b.price - t.a.price), bc = Math.abs(t.b.price - t.c.price), ac = Math.abs(t.c.price - t.a.price);
  const sgn = up ? "+" : "−";
  const rows: [string, number, string][] = [
    ["N", t.N, `C ${sgn} (B − A) = ${yen(t.c.price)} ${sgn} ${yen(ab)}`],
    ["V", t.V, `B ${sgn} (B − C) = ${yen(t.b.price)} ${sgn} ${yen(bc)}`],
    ["E", t.E, `B ${sgn} (B − A) = ${yen(t.b.price)} ${sgn} ${yen(ab)}`],
    ["NT", t.NT, `C ${sgn} (C − A) = ${yen(t.c.price)} ${sgn} ${yen(ac)}`],
  ];
  return `<p class="small">基準: ${pt(t.a, "A")} → ${pt(t.b, "B")} → ${pt(t.c, "C")}。A→B が第1波(${yen(ab)}円)、B→C が${up ? "押し" : "戻し"}(${yen(bc)}円 = 第1波の ${Math.round(t.retrace * 100)}%)、C からの第3波の到達目標を計算。${t.cTentative ? `C は反転が未確定の進行中の極値です。${up ? "下落" : "上昇"}が続けば C と計算値は更新されます。` : ""}</p>
    <div class="kpis">${rows.map(([k, v, f]) => `<div class="kpi"><span>${k}計算値</span><strong>${yen(v)}</strong><small>${f}<br>${CONV(v)} / 現値比 ${v >= close ? "+" : "−"}${yen(Math.abs(v - close))}</small></div>`).join("")}</div>`;
}

export function renderIchimokuSection(ic: IchiView | undefined): string {
  if (!ic) return "";
  const r = ic.result, bt = ic.backtest, basis = ic.basis;
  const fut = ic.series === "futures";
  CONV = fut ? (v) => `現物換算 ${yen(v - basis)}` : (v) => `先物換算 ${yen(v + basis)}`;
  const f = (v: number) => `${yen(v)}<small class="muted"> (${CONV(v)})</small>`;
  const srcNote = fut
    ? `日経225先物ベース(CME 円建て NIY=F 継続足, Yahoo Finance)${ic.inProgress ? `・${md(ic.inProgress)} の足は取引中(ナイトセッション含む暫定)` : ""}・現物換算はベーシス ${basis >= 0 ? "−" : "+"}${yen(Math.abs(basis))}円`
    : `日経平均ベース${ic.barsSource === "nikkei+jpx" ? "(当日足は終値のみで仮計算)" : ic.barsSource === "nikkei+yahoo" ? `(${(ic.filled ?? []).map(md).join("・")} の足は Yahoo Finance で補完)` : ""}・先物換算はベーシス ${basis >= 0 ? "+" : ""}${yen(basis)}円`;
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
    <p class="eyebrow">一目均衡表(日足) ${r.date} / ${srcNote}</p>
    <h2>一目均衡表の判断: <span class="${r.judgment === "買い" ? "up" : r.judgment === "売り" ? "down" : ""}">${r.judgment}</span> <small class="muted">スコア ${r.score >= 0 ? "+" : ""}${Math.round(r.score)}${r.sanyaku ? ` / ${r.sanyaku}` : ""}</small></h2>
    ${chart(ic)}
    <div class="table-wrap"><table><thead><tr><th>要素</th><th>現在</th><th>過去の翌日上昇率<br><small>同じ状態だった日</small></th></tr></thead><tbody>${sig}
      <tr><td>五線の値</td><td colspan="2" class="wrap">転換線 ${f(r.lines.tenkan)} / 基準線 ${f(r.lines.kijun)} / 雲 ${yen(Math.min(r.lines.spanA, r.lines.spanB))}〜${yen(Math.max(r.lines.spanA, r.lines.spanB))} / 遅行スパン 26日前 高${yen(r.chikouRef.high)} 安${yen(r.chikouRef.low)}</td></tr>
    </tbody></table></div>
    <h4>波動論(3波動): ${r.wave}</h4><p class="small">転換点: ${pv}</p>
    ${scenariosBlock(ic, basis)}
    <h4>時間論(基本数値)</h4>
    <p class="small">${r.time.hits.length
      ? `<strong>本日 ${md(r.date)} は変化日の候補</strong>: ${r.time.hits.map((h) => `${md(h.from)}の${h.fromType === "high" ? "高値" : "安値"}(${yen(h.fromPrice)})を 1 日目として ${h.bars} 日目 = 基本数値 ${h.number}${h.offset ? "(前日がちょうど)" : ""}`).join("、")}`
      : `本日 ${md(r.date)} は基本数値に該当なし`}。</p>
    ${r.time.upcoming.length ? `<div class="table-wrap"><table><thead><tr><th>次の変化日候補</th><th>基準日(起算日)</th><th>基本数値</th></tr></thead><tbody>${r.time.upcoming.map((u) => `<tr><td>${md(u.date)}(${DOW[new Date(u.date + "T00:00:00Z").getUTCDay()]}) <small class="muted">${u.inBars}営業日後</small></td><td>${md(u.from)} ${u.fromType === "high" ? "高値" : "安値"} ${yen(u.fromPrice)}</td><td>${u.number}日目</td></tr>`).join("")}</tbody></table></div>` : ""}
    <p class="small muted">日数は基準日を 1 日目として営業日(ローソク足の本数)で数え、基本数値 ${BASIC_NUMBERS.slice(0, 8).join("・")}… に当たる日(前日がちょうどの場合も含む)を候補とします。候補日の日付は土日のみ除いた概算で、祝日は考慮していません。</p>
    <h4>相場水準(支持・抵抗の候補)</h4>
    ${candidatesBlock(r, basis)}
    <details class="small"><summary>すべての水準を価格順に見る</summary>
    <div class="table-wrap"><table><thead><tr><th>水準</th><th>${fut ? "先物(現物換算)" : "日経平均(先物換算)"}</th><th>現値との差</th></tr></thead><tbody>${levels}</tbody></table></div></details>
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
.ic-sc-main{fill:none;stroke:#0ea5e9;stroke-width:2.4}.ic-sc{fill:none;stroke:#f59e0b;stroke-width:1.4;stroke-dasharray:6 3;opacity:.85}svg text.ic-sc-t{fill:#f59e0b;font-size:10px}
.scenario{border-left:3px solid #f59e0b55;padding-left:10px;margin:8px 0}.scenario-main{border-left-color:#0ea5e9}
.lv-kind{display:inline-block;font-size:10px;padding:0 5px;border-radius:8px;background:#88888833;margin-right:2px}
h5{margin:10px 0 4px;font-size:13px}details.small summary{cursor:pointer;color:#888;margin-top:8px}
.ic-pv{fill:#0ea5e9}.ic-pv-abc{fill:#0ea5e9;stroke:#fff;stroke-width:1}svg text.ic-pv-t{fill:#0ea5e9;font-size:11px;font-weight:700}svg tspan.ic-wave-t{fill:#0ea5e9}
.ic-time{stroke:#d946ef;stroke-dasharray:2 3;opacity:.8}.ic-time-hit{stroke:#d946ef;stroke-width:1.5;stroke-dasharray:4 2}svg text.ic-time-t,svg tspan.ic-time-t{fill:#d946ef;font-size:9px}
`;
