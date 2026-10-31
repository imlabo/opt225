import type { DailyAnalysis, DailyStrike } from "./daily";
import { MIN_HISTORY, SQ_KEYS, SQ_LABEL, type Side, type SqKey, type SqueezeHist, type SqueezeSide } from "./squeeze";

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

/** 売り手のヘッジ先物(線)とガンマ(棒)を価格ごとに */
function greeksChart(a: DailyAnalysis): string {
  const g = a.greeks!;
  const pts = g.profile;
  if (pts.length < 3) return "";
  const W = 720, H = 240, P = 44;
  const hs = pts.map((p) => p.hedge), hmax = Math.max(...hs.map(Math.abs), 1);
  const gmax = Math.max(...pts.map((p) => p.gamma100), 1);
  const x = (v: number) => P + ((v - pts[0].price) / (pts[pts.length - 1].price - pts[0].price)) * (W - 2 * P);
  const yh = (v: number) => 14 + ((hmax - v) / (2 * hmax)) * (H - 48);
  const yg = (v: number) => H - 34 - (v / gmax) * (H - 70) * 0.9;
  const bw = Math.max(2, ((W - 2 * P) / pts.length) * 0.6);
  const bars = pts.map((p) => `<rect x="${(x(p.price) - bw / 2).toFixed(1)}" y="${yg(p.gamma100).toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - 34 - yg(p.gamma100)).toFixed(1)}" class="gx-bar"><title>${yen(p.price)}: ガンマ 100円あたり ${yen(p.gamma100)}枚 / ヘッジ ${signed(p.hedge)}枚</title></rect>`).join("");
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.price).toFixed(1)},${yh(p.hedge).toFixed(1)}`).join("");
  const ticks = pts.filter((_, i) => i % Math.ceil(pts.length / 7) === 0).map((p) => `<text x="${x(p.price)}" y="${H - 18}" text-anchor="middle">${(p.price / 1000).toFixed(1)}k</text>`).join("");
  const sp = a.spot >= pts[0].price && a.spot <= pts[pts.length - 1].price ? `<line x1="${x(a.spot)}" x2="${x(a.spot)}" y1="10" y2="${H - 34}" class="spot"/><text x="${x(a.spot) + 4}" y="20" class="spot-t">現値 ${yen(a.spot)}</text>` : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="売り手のヘッジとガンマ">
    ${bars}<line x1="${P}" x2="${W - P}" y1="${yh(0)}" y2="${yh(0)}" class="axis"/><text x="2" y="${yh(0) + 4}">0枚</text>
    <text x="2" y="${yh(hmax) + 10}">+${yen(hmax)}</text><text x="2" y="${yh(-hmax)}">−${yen(hmax)}</text>
    <path d="${line}" class="gx-line"/>${sp}${ticks}
    <text x="${W - P}" y="${H - 2}" text-anchor="end"><tspan class="gx-line-t">━ 売り手のヘッジ先物(枚)</tspan>　<tspan class="gx-bar-t">■ ガンマ(100円あたりの売買枚数)</tspan></text></svg>`;
}

function greeksSection(a: DailyAnalysis): string {
  const g = a.greeks;
  if (!g) return "";
  const kpi = (label: string, value: string, sub = "") => `<div class="kpi"><span>${label}</span><strong>${value}</strong>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const mm = (m: string) => `${Number(m.slice(4))}月`;
  const okuD = (v: number) => `${(v / 1e8).toFixed(1)}億円`;
  return `<h4>デルタヘッジ・ガンマ・セータ(売り手全体の推定, ${g.months.map(mm).join("・")}限)</h4>
    <div class="kpis">
      ${kpi("デルタヘッジ(先物)", `${g.hedge >= 0 ? "買い" : "売り"} ${yen(Math.abs(g.hedge))}枚`, `ラージ換算(ミニ ${yen(Math.abs(g.hedge) * 10)}枚)/ コール売りのヘッジ 買い${yen(g.callHedge)} ・ プット売りのヘッジ 売り${yen(-g.putHedge)}`)}
      ${kpi("ガンマ", `100円で ${yen(g.gamma100)}枚`, `日経平均が100円上がると先物を約${yen(g.gamma100)}枚買い増し、下がると売る(1%で約${yen(g.gamma1pct)}枚)`)}
      ${kpi("セータ", `1日 ${okuD(g.thetaYen)}`, `売り手が受け取る時間価値(暦日あたり)。うち期近 ${okuD(g.thetaFrontYen)}(SQまで${g.frontDays}日)`)}
    </div>
    ${greeksChart(a)}
    <p class="small">ガンマが集中する行使価格: ${g.topGamma.map((t) => `${yen(t.strike)}(${mm(t.month)}限, 100円あたり${yen(t.gamma100)}枚)`).join("、")}。この近辺では売り手のヘッジ売買が大きくなり、値動きが増幅されやすくなります(ショートガンマ)。</p>
    <details class="explain" open><summary>数字の読み方</summary><dl>
      <dt>デルタヘッジ(先物)</dt><dd><p>オプションの売り手が、価格変動の損失を打ち消すために持っているはずの先物の量。コールを売った人は上昇で損をするので先物を買い、プットを売った人は下落で損をするので先物を売ってヘッジします。その合計をラージ先物の枚数で表しています(ミニは10倍)。</p><p>「買い」なら売り手全体が先物を買い越している、「売り」なら売り越している状態。今日は${g.hedge >= 0 ? "買い" : "売り"} ${yen(Math.abs(g.hedge))}枚で、コール側の買い ${yen(g.callHedge)}枚とプット側の売り ${yen(-g.putHedge)}枚の差し引きです。</p></dd>
      <dt>ガンマ</dt><dd><p>日経平均が動いたときに、売り手がヘッジを保つために追加で売買しなければならない先物の量。売り手は「ショートガンマ」なので、上がれば買い増し、下がれば売り増しと、値動きと同じ方向に売買します(値動きを増幅する)。</p><p>今日は100円動くごとに約${yen(g.gamma100)}枚、1%(約${yen(a.spot / 100)}円)で約${yen(g.gamma1pct)}枚。大きいほど相場が走りやすい状態です。ガンマが集中する行使価格の近くでは特に大きくなります。</p></dd>
      <dt>セータ</dt><dd><p>時間がたつだけでオプションの価値が減る分。買い手が毎日払い、売り手が毎日受け取る「保険料の日割り」にあたります。</p><p>今日は1日あたり約${(g.thetaYen / 1e8).toFixed(1)}億円(うち期近 ${(g.thetaFrontYen / 1e8).toFixed(1)}億円)。SQが近づくほど期近のセータは大きくなり、売り手は「動かなければ毎日これだけ稼げる」ので、レンジ内に押さえ込む動きの動機になります。逆に、セータで稼ぐ分を超えて値が動くと、売り手は損失を避けるためにヘッジ売買を急ぎます。</p></dd>
      <dt>グラフ</dt><dd>横軸は日経平均の水準。線はその価格になったときの売り手のヘッジ先物の量、棒はその価格でのガンマ(100円あたりの売買枚数)。棒が高い価格帯ほど、そこを通過するときにヘッジ売買が大きくなります。</dd>
    </dl></details>
    <p class="muted small">建玉はすべて売り手がショートし、売り手だけが先物でデルタヘッジすると仮定した推定です(買い手のヘッジやヘッジしない売り手は考慮していません)。Black-Scholes(金利・配当0)で、IVは JPX 清算値段の行使価格別ボラティリティ、残日数は暦日。グラフは価格だけが動いた場合(IV・残日数は現在のまま)のヘッジ量とガンマです。オプション1枚 = 指数×1,000円 = 先物ラージ1枚相当。</p>`;
}

/** 踏み上げ恐怖指数 */
function sqGauge(label: string, sd: SqueezeSide, cls: string): string {
  const v = Math.max(0, Math.min(100, sd.index));
  return `<div class="sq-g"><div class="sq-g-head"><span>${label}</span><strong class="${v >= 60 ? "sq-hot" : v <= 40 ? "sq-calm" : ""}" data-side="${cls}">${Math.round(v)}</strong><em>${sd.rating}</em></div>
    <div class="sq-track"><span class="sq-tick" style="left:${v}%"></span></div><div class="sq-scale"><span>楽観</span><span>平常</span><span>パニック</span></div></div>`;
}

function sqValue(k: SqKey, s: Side, v: number, a: DailyAnalysis): string {
  const pct = (x: number, d = 1) => `${signed(x * 100, d)}%`;
  switch (k) {
    case "dist": {
      const be = s === "put" ? a.seller?.putBreakeven : a.seller?.callBreakeven;
      return be != null ? `${v.toFixed(2)}σ(損益分岐 ${yen(be)})` : "範囲外(4σ扱い)";
    }
    case "loss": return pct(v);
    case "near": return `${(v * 100).toFixed(0)}%`;
    case "vol": return `${signed(v, 1)}pt`;
    case "cover": return v === 0 ? "—(該当日でない)" : `${(v * 100).toFixed(1)}% 減`;
  }
}

function sqChart(hist: SqueezeHist[]): string {
  const h = hist.slice(-120);
  if (h.length < 2) return "";
  const W = 720, H = 200, P = 34;
  const x = (i: number) => P + (i / (h.length - 1)) * (W - 2 * P);
  const y = (v: number) => 10 + ((100 - v) / 100) * (H - 40);
  const sMin = Math.min(...h.map((r) => r.spot)), sMax = Math.max(...h.map((r) => r.spot));
  const ys = (v: number) => 10 + ((sMax - v) / (sMax - sMin || 1)) * (H - 40);
  const path = (f: (r: SqueezeHist) => number, yy: (v: number) => number) => h.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yy(f(r)).toFixed(1)}`).join("");
  const ticks = h.map((r, i) => (i % Math.ceil(h.length / 6) === 0 || i === h.length - 1 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${r.date.slice(5).replace("-", "/")}</text>` : "")).join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="踏み上げ恐怖指数の推移">
    <line x1="${P}" x2="${W - P}" y1="${y(50)}" y2="${y(50)}" class="grid"/><line x1="${P}" x2="${W - P}" y1="${y(75)}" y2="${y(75)}" class="grid"/>
    <text x="2" y="${y(75) + 4}">75</text><text x="2" y="${y(50) + 4}">50</text><text x="2" y="${y(25) + 4}">25</text>
    <path d="${path((r) => r.spot, ys)}" class="sq-spot"/>
    <path d="${path((r) => r.putIndex, y)}" class="sq-put"/><path d="${path((r) => r.callIndex, y)}" class="sq-call"/>
    ${ticks}<text x="${W - P}" y="${H - 22}" text-anchor="end"><tspan class="sq-put-t">━ プット売り手</tspan>　<tspan class="sq-call-t">━ コール売り手</tspan>　<tspan class="sq-spot-t">┄ 日経平均</tspan></text></svg>`;
}

/** 正規分布の片側確率(SQ 時点で損益分岐を越えている確率の目安) */
const tailProb = (z: number) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const p = 0.3989423 * Math.exp(-z * z / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? p : 1 - p;
};

/** 要素ごとの解説: 何を測っているか・数字の読み方・今日の読み */
function sqExplain(a: DailyAnalysis): string {
  const q = a.squeeze!;
  const em = a.expectedMove ?? a.spot * 0.04;
  const days = a.front.days;
  const lvl = (v: number, steps: [number, string][], last: string) => (steps.find(([t]) => v < t)?.[1] ?? last);
  const today = (k: SqKey): string => {
    const p = q.put.comps[k], c = q.call.comps[k];
    const side = (s: Side, v: typeof p) => {
      if (!v) return `${s === "put" ? "プット" : "コール"}側: データなし`;
      const who = s === "put" ? "プット" : "コール";
      switch (k) {
        case "dist": {
          const be = s === "put" ? a.seller?.putBreakeven : a.seller?.callBreakeven;
          if (be == null) return `${who}側: 損益分岐が計算範囲(現値±20%)の外にあり、当面は届かない距離`;
          const gap = Math.abs(be - a.spot);
          return `${who}側: 損益分岐 ${yen(be)} まで${s === "put" ? "下" : "上"}に ${yen(gap)}円 = ${v.value.toFixed(2)}σ(${lvl(v.value, [[0.5, "非常に近い"], [1, "近い"], [2, "平常"]], "遠い")})。SQ時点でここを${s === "put" ? "割っている" : "超えている"}確率は正規分布の目安で約${Math.round(tailProb(v.value) * 100)}%`;
        }
        case "loss": return `${who}側: ${signed(v.value * 100, 1)}%(${lvl(v.value, [[-0.05, "改善"], [0.05, "横ばい"], [0.15, "悪化"]], "大きく悪化")})`;
        case "near": return `${who}側: ${(v.value * 100).toFixed(0)}%(${lvl(v.value, [[0.12, "少ない"], [0.28, "平常"], [0.4, "多い"]], "非常に多い")})`;
        case "vol": return `${who}側: ${signed(v.value, 1)}pt(${lvl(v.value, [[-1, "売り手に有利"], [1, "横ばい"], [3, "追い打ち"]], "強い追い打ち")})`;
        case "cover": return v.value === 0 ? `${who}側: ${who === "プット" ? "上げた" : "下げた"}日なので対象外` : `${who}側: ${(v.value * 100).toFixed(1)}% 減(${lvl(v.value, [[0.01, "ほぼなし"], [0.03, "小さい"], [0.06, "目立つ"]], "大きい")})`;
      }
    };
    return `${side("put", p)} / ${side("call", c)}`;
  };
  const items: [SqKey, string, string][] = [
    ["dist", "売り手全体の損益分岐(SQ時点でその価格になると、受け取ったプレミアムを損失が上回る価格)が、現値からどれだけ離れているかを、SQまでの想定変動幅(1σ)の何倍かで表したもの。",
      `1σ = ±${yen(em)}円(ATM IV ${a.atmIv?.toFixed(1) ?? "—"}% から計算した、SQまで${days}日の標準的な値動きの幅)。0.5σ未満は「普通の値動きで届く」、1σ未満は「近い」、2σ以上は「遠い」。距離が近いほど売り手は守りに入り、ヘッジ売買や損切りが出やすくなります。点数は 1.5σ を平常(50点)とし、近いほど高くなります。`],
    ["loss", "期近の建玉すべてを当日の清算価格で評価した時価の合計(= 売り手が買い戻すのに必要な金額 = 売り手の負債)が、前日から何%増えたか。",
      "プラスは売り手の含み損が増えた(オプションが値上がりした)こと、マイナスは時間価値の減少などで売り手が得をしたことを表します。±5%程度は日常の範囲、+15%以上は大きな悪化。プットとコールで逆に動くのが普通です。"],
    ["near", "踏まれる側、つまり現値から1σ以内でこれから損失側(イン・ザ・マネー)に入りやすい行使価格にある建玉が、期近の建玉全体の何%か。プットは現値の1σ下〜少し上、コールは現値の少し下〜1σ上。",
      "20%前後が平常。多いほど、少し動いただけで多くの売り手が同時に損失側に入り、ヘッジ売買がまとまって出やすい状態です。"],
    ["vol", "ATM IV(オプションの価格に織り込まれた予想変動率)と、スキュー(下値プットの IV − 上値コールの IV)の前日からの変化。プット側は IV + スキュー、コール側は IV − スキューで見ます。",
      "プラスはオプションが割高になり、価格が動かなくても売り手の評価損が膨らむこと(ベガ損)を表します。単位は pt(IV の%ポイント)。±1pt は日常の範囲、+3pt以上は強い追い打ち。"],
    ["cover", "踏まれる方向に動いた日(プット側は下げた日、コール側は上げた日)に、現値±1σの建玉が前日から何%減ったか。",
      "売り手が損切りで買い戻すと建玉が減ります。数字が大きいほど「実際に投げが出ている」証拠。3%以上の減少で目立つ水準です。反対方向に動いた日は対象外(50点扱い)。"],
  ];
  const nHist = q.put.comps.dist?.mode === "percentile" ? "過去の履歴の中での順位(パーセンタイル)。80点なら過去の80%の日より恐怖が大きい" : "固定の目安(50 + 50 × tanh(標準化値))。標準化値 ±1 で約 88点/12点。60営業日たまると過去の中での順位に切り替わります";
  return `<details class="explain" open><summary>数字の読み方</summary>
    <dl>
      <dt>指数(0〜100)</dt><dd>5つの要素の点数の平均。50 = 平常、60以上 = 警戒、75以上 = パニック、40以下 = 落ち着き、25以下 = 楽観。プット売り手の指数が高い = 下落で踏まれる恐怖が強い(下げが加速しやすい)、コール売り手の指数が高い = 上昇で踏まれる恐怖が強い(踏み上げが起きやすい)。恐怖が極端に高まった後は、投げが一巡して反転することもあります。</dd>
      <dt>点(各要素)</dt><dd>${nHist}。</dd>
      ${items.map(([k, what, read]) => `<dt>${SQ_LABEL[k]}</dt><dd><p>${what}</p><p>${read}</p><p class="today">今日: ${today(k)}</p></dd>`).join("")}
    </dl></details>`;
}

function squeezeSection(a: DailyAnalysis, hist: SqueezeHist[]): string {
  const q = a.squeeze;
  if (!q) return "";
  const rows = SQ_KEYS.map((k) => {
    const p = q.put.comps[k], c = q.call.comps[k];
    const cell = (s: Side, v: typeof p) => v ? `<td>${sqValue(k, s, v.value, a)}</td><td class="${v.score >= 60 ? "sq-hot" : v.score <= 40 ? "sq-calm" : ""}">${Math.round(v.score)}</td>` : `<td class="muted">—</td><td></td>`;
    return `<tr><td>${SQ_LABEL[k]}</td>${cell("put", p)}${cell("call", c)}</tr>`;
  }).join("");
  const nHist = hist.filter((h) => h.date < a.tradeDate).length;
  const mode = nHist >= MIN_HISTORY ? `各要素は過去${Math.min(nHist, 250)}営業日の中での位置(パーセンタイル)で点数化` : `履歴が${MIN_HISTORY}営業日たまるまでは固定の目安で点数化(現在${nHist}日分、たまると過去との比較に自動で切り替え)`;
  return `<h4>踏み上げ恐怖指数</h4>
    <div class="sq-wrap">${sqGauge("プット売り手(下落で踏まれる)", q.put, "down")}${sqGauge("コール売り手(上昇で踏まれる)", q.call, "up")}</div>
    <div class="table-wrap"><table><thead><tr><th>要素</th><th>プット側</th><th>点</th><th>コール側</th><th>点</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${sqChart(hist)}
    ${sqExplain(a)}
    <p class="muted small">オプションの売り手が「踏まれる」恐怖を 0〜100 で表した本サイト独自の指数(50 = 平常、60以上 警戒、75以上 パニック)。期近限月について、①現値から売り手全体の損益分岐までが SQ までの 1σ の何倍か、②建玉全体の時価(売り手の負債)の前日比、③現値から 1σ 以内の踏まれる側にある建玉の比率、④ATM IV とスキューの前日比(プット側は IV+スキュー、コール側は IV−スキュー)、⑤踏まれる方向に動いた日の現値近辺の建玉の減少(損切りの買い戻し)を点数化して平均しています。${mode}。</p>`;
}

function trend(history: DailyAnalysis[]): string {
  const rows = history.slice(-10).reverse();
  if (rows.length < 2) return "";
  return `<h4>直近の推移</h4><div class="table-wrap"><table><thead><tr><th>日付</th><th>日経平均</th><th>期近P/C比</th><th>ATM IV</th><th>最大苦痛</th><th>壁(下/上)</th></tr></thead><tbody>${rows
    .map((d) => `<tr><td>${d.tradeDate.slice(5).replace("-", "/")}</td><td>${yen(d.spot)}</td><td>${d.pcr.toFixed(2)}</td><td>${d.atmIv ? d.atmIv.toFixed(1) + "%" : "—"}</td><td>${d.maxPain ? yen(d.maxPain) : "—"}</td><td>${d.putWall ? yen(d.putWall.strike) : "—"} / ${d.callWall ? yen(d.callWall.strike) : "—"}</td></tr>`)
    .join("")}</tbody></table></div>`;
}

export function renderDailySection(a: DailyAnalysis | undefined, history: DailyAnalysis[], strikes: DailyStrike[], squeezeHist: SqueezeHist[] = []): string {
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
    ${squeezeSection(a, squeezeHist)}
    ${greeksSection(a)}
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
details.explain{margin:10px 0;padding:8px 12px;border:1px solid var(--line,#8883);border-radius:10px;font-size:13px;line-height:1.7}
details.explain summary{cursor:pointer;font-weight:700}details.explain dt{font-weight:700;margin-top:10px}details.explain dd{margin:2px 0 0 0}
details.explain dd p{margin:2px 0}details.explain .today{color:var(--fg);background:#8881;border-radius:6px;padding:2px 6px}
.sq-hot{color:#dc2626!important;font-weight:700}.sq-calm{color:#16a34a!important}
.sq-wrap{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:10px 0}@media(max-width:720px){details.explain{margin:10px 0;padding:8px 12px;border:1px solid var(--line,#8883);border-radius:10px;font-size:13px;line-height:1.7}
details.explain summary{cursor:pointer;font-weight:700}details.explain dt{font-weight:700;margin-top:10px}details.explain dd{margin:2px 0 0 0}
details.explain dd p{margin:2px 0}details.explain .today{color:var(--fg);background:#8881;border-radius:6px;padding:2px 6px}
.sq-hot{color:#dc2626!important;font-weight:700}.sq-calm{color:#16a34a!important}
.sq-wrap{grid-template-columns:1fr}}
.sq-g{border:1px solid var(--line,#8883);border-radius:10px;padding:10px 12px}.sq-g-head{display:flex;align-items:baseline;gap:8px}.sq-g-head span{font-size:13px;flex:1}
.sq-g-head strong{font-size:28px}.sq-g-head em{font-style:normal;font-size:13px;color:var(--muted)}
.sq-track{position:relative;height:8px;border-radius:4px;margin:8px 0 4px;background:linear-gradient(90deg,#16a34a,#a3a3a3 50%,#f59e0b 70%,#dc2626)}
.sq-tick{position:absolute;top:-4px;width:4px;height:16px;margin-left:-2px;background:var(--fg);border-radius:2px}.sq-scale{display:flex;justify-content:space-between;font-size:11px;color:var(--muted)}
.sq-put{fill:none;stroke:var(--down);stroke-width:2}.sq-call{fill:none;stroke:var(--up);stroke-width:2}.sq-spot{fill:none;stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3}
svg tspan.sq-put-t{fill:var(--down)}svg tspan.sq-call-t{fill:var(--up)}svg tspan.sq-spot-t{fill:var(--muted)}
.gx-bar{fill:#d946ef44}.gx-line{fill:none;stroke:#0ea5e9;stroke-width:2}svg tspan.gx-line-t{fill:#0ea5e9}svg tspan.gx-bar-t{fill:#d946ef}
.spot{stroke:var(--fg);stroke-dasharray:3 3}.spot-t{fill:var(--fg)!important}.pain{stroke:#b7791f;stroke-dasharray:6 3}.pain-t{fill:#b7791f!important}
`;
