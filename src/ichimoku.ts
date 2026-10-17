/**
 * 一目均衡表(日足)の計算: 五線(転換線・基準線・先行スパン1/2・遅行スパン)、
 * 波動論(3波動: I/V/N と P/Y)、計算値(N/V/E/NT)、時間論(基本数値)、相場水準(支持・抵抗)。
 * 入力は日足の 4 本値(日経平均)。先物換算はベーシス(先物−現物)を加えて表示側で行う。
 */

export interface Bar { date: string; open: number; high: number; low: number; close: number }

export const BASIC_NUMBERS = [9, 17, 26, 33, 42, 51, 65, 76, 83, 97, 101, 129, 172, 200, 257];

const hl = (bars: Bar[], end: number, n: number) => {
  let hi = -Infinity, lo = Infinity;
  for (let i = Math.max(0, end - n + 1); i <= end; i++) { hi = Math.max(hi, bars[i].high); lo = Math.min(lo, bars[i].low); }
  return (hi + lo) / 2;
};

export interface Lines { tenkan: number; kijun: number; spanA: number; spanB: number } // spanA/B: その日に描かれる雲(26日前に計算)

/** i 日目の五線。先行スパンは 26 本前の値が当日に表示される */
export function linesAt(bars: Bar[], i: number): Lines | null {
  if (i < 77) return null;
  const tenkan = hl(bars, i, 9), kijun = hl(bars, i, 26);
  const j = i - 26;
  const spanA = (hl(bars, j, 9) + hl(bars, j, 26)) / 2, spanB = hl(bars, j, 52);
  return { tenkan, kijun, spanA, spanB };
}

/** i 日目に計算され 26 本先に描かれる雲 */
export function futureCloudAt(bars: Bar[], i: number) {
  return { spanA: (hl(bars, i, 9) + hl(bars, i, 26)) / 2, spanB: hl(bars, i, 52) };
}

export interface Pivot { i: number; date: string; price: number; type: "high" | "low"; confirmed: boolean }

/** ジグザグの反転幅: max(3%, 2.5×ATR14) */
export function reversalThreshold(bars: Bar[], k: number): number {
  let s = 0, n = 0;
  for (let i = Math.max(1, k - 13); i <= k; i++) {
    s += Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)); n++;
  }
  return Math.max(0.03 * bars[k].close, 2.5 * (n ? s / n : 0));
}

/** ジグザグで高値・安値の転換点を抽出。反転幅は max(3%, 2.5×ATR14) × scale(大きな波を見るときは scale > 1) */
export function pivots(bars: Bar[], end = bars.length - 1, scale = 1): Pivot[] {
  const out: Pivot[] = [];
  if (end < 20) return out;
  let dir: 1 | -1 = bars[1].close >= bars[0].close ? 1 : -1;
  let ext = dir === 1 ? { i: 0, p: bars[0].high } : { i: 0, p: bars[0].low };
  for (let i = 1; i <= end; i++) {
    const th = reversalThreshold(bars, i) * scale;
    if (dir === 1) {
      if (bars[i].high >= ext.p) ext = { i, p: bars[i].high };
      else if (ext.p - bars[i].low >= th) {
        out.push({ i: ext.i, date: bars[ext.i].date, price: ext.p, type: "high", confirmed: true });
        dir = -1; ext = { i, p: bars[i].low };
      }
    } else {
      if (bars[i].low <= ext.p) ext = { i, p: bars[i].low };
      else if (bars[i].high - ext.p >= th) {
        out.push({ i: ext.i, date: bars[ext.i].date, price: ext.p, type: "low", confirmed: true });
        dir = 1; ext = { i, p: bars[i].high };
      }
    }
  }
  // 未確定の直近の極値
  out.push({ i: ext.i, date: bars[ext.i].date, price: ext.p, type: dir === 1 ? "high" : "low", confirmed: false });
  return out;
}

export type Wave = "上昇N波動" | "下落N波動" | "Y波動(拡大)" | "P波動(収束)" | "V波動" | "I波動";

export function classifyWave(pv: Pivot[]): Wave {
  const c = pv.filter((p) => p.confirmed);
  if (c.length < 2) return "I波動";
  if (c.length < 4) return "V波動";
  const highs = c.filter((p) => p.type === "high").slice(-2), lows = c.filter((p) => p.type === "low").slice(-2);
  if (highs.length < 2 || lows.length < 2) return "V波動";
  const hh = highs[1].price > highs[0].price, hlw = lows[1].price > lows[0].price;
  if (hh && hlw) return "上昇N波動";
  if (!hh && !hlw) return "下落N波動";
  if (hh && !hlw) return "Y波動(拡大)";
  return "P波動(収束)";
}

export interface Targets {
  direction: "up" | "down"; // C からの次の波の向き(C が安値なら上昇目標、高値なら下落目標)
  a: Pivot; b: Pivot; c: Pivot;
  cTentative: boolean; // C が未確定の極値(進行中の波)のとき true。波が伸びれば C と計算値も動く
  retrace: number; // B→C の押し(戻し)幅 ÷ A→B の幅
  N: number; V: number; E: number; NT: number;
}

/**
 * 計算値: A→B→C から次の波(C→D)の目標値。A→B が第1波、B→C が押し(戻し)、C→D が第3波。
 *  N = C + (B − A)  V = B + (B − C)  E = B + (B − A)  NT = C + (C − A)  (下落目標は符号を反転)
 * C は原則として直近の確定転換点だが、その後の進行中の波が反転幅(ジグザグのしきい値)以上動いていれば
 * 未確定の極値を C とみなし、そこからの次の波の目標を出す(例: 高値から 9% 下げた時点なら、その安値を押し目 C として上昇目標)。
 */
export function targets(pv: Pivot[], bars?: Bar[], end?: number): Targets | null {
  const conf = pv.filter((p) => p.confirmed);
  const tent = pv[pv.length - 1];
  let abc: Pivot[] | null = null;
  if (tent && !tent.confirmed && conf.length >= 2 && bars && end != null && end >= 20) {
    const last = conf[conf.length - 1];
    if (Math.abs(tent.price - last.price) >= reversalThreshold(bars, end)) abc = [conf[conf.length - 2], last, tent];
  }
  if (!abc) {
    if (conf.length < 3) return null;
    abc = conf.slice(-3);
  }
  const [A, B, C] = abc;
  const direction = C.type === "low" ? "up" : "down";
  const s = direction === "up" ? 1 : -1;
  const ab = Math.abs(B.price - A.price);
  return {
    direction, a: A, b: B, c: C, cTentative: !C.confirmed, retrace: ab ? Math.abs(B.price - C.price) / ab : 0,
    N: C.price + s * ab,
    V: B.price + s * Math.abs(B.price - C.price),
    E: B.price + s * ab,
    NT: C.price + s * Math.abs(C.price - A.price),
  };
}

/** 計算値の A→B→C を単純に当てはめる(選択ロジックなし) */
export function targetsOf(A: Pivot, B: Pivot, C: Pivot): Targets {
  const direction = C.type === "low" ? "up" : "down";
  const sg = direction === "up" ? 1 : -1;
  const ab = Math.abs(B.price - A.price);
  return {
    direction, a: A, b: B, c: C, cTentative: !C.confirmed, retrace: ab ? Math.abs(B.price - C.price) / ab : 0,
    N: C.price + sg * ab, V: B.price + sg * Math.abs(B.price - C.price), E: B.price + sg * ab, NT: C.price + sg * Math.abs(C.price - A.price),
  };
}

/**
 * 3波動の読み方の候補。
 * 進行中の波の起点(直近の確定転換点)と、進行中の極値(反転幅以上動いていれば)を C として、
 * 「A→B が第1波、B→C が押し・戻し、C→D が第3波」になる A・B の組み合わせを転換点の中から列挙する。
 * 条件: A→B の間に A を超える値も B を割る値もない(きれいな 1 波)、B→C の間に B を割る値も C を超える値もない、
 * C は A を超えない(押し・戻しの範囲内)。小さな波(例: 8月高値→9月安値)を戻しの一部とみなす大きな読みも同時に出る。
 */
export interface Scenario {
  t: Targets;
  /** 進行中の波がこの読みの第3波(C→D)に当たる: C が確定していて、現在の極値が C から目標の向きに動いている */
  inProgress: boolean;
  progress: number | null; // 第3波の進捗: 現在の極値が C→N のどこまで来たか(1 = N 到達)
  extreme: number | null; // 進行中の波の極値
  waveSize: number; // 第1波 |B − A|
}

export function waveScenarios(bars: Bar[], end: number, pv = pivots(bars, end)): Scenario[] {
  const conf = pv.filter((p) => p.confirmed);
  const tent = pv[pv.length - 1];
  if (conf.length < 2 || !tent) return [];
  const last = conf[conf.length - 1];
  const tentOk = !tent.confirmed && tent.i > last.i && Math.abs(tent.price - last.price) >= reversalThreshold(bars, end);
  const maxH = (i0: number, i1: number) => { let m = -Infinity; for (let i = i0; i <= i1; i++) m = Math.max(m, bars[i].high); return m; };
  const minL = (i0: number, i1: number) => { let m = Infinity; for (let i = i0; i <= i1; i++) m = Math.min(m, bars[i].low); return m; };
  const LOOKBACK = 260;
  const out: Scenario[] = [];
  const seen = new Set<string>();
  const cands: { C: Pivot; inProgress: boolean }[] = [];
  if (tentOk) cands.push({ C: tent, inProgress: false }); // 進行中の極値を押し目・戻り高値とみなす → 次の波の目標
  if (tentOk || tent.i === last.i) cands.push({ C: last, inProgress: tentOk }); // 進行中の波を第3波とみなす
  for (const { C, inProgress } of cands) {
    const up = C.type === "low";
    for (const B of conf.filter((p) => p.type !== C.type && p.i < C.i && C.i - p.i <= LOOKBACK)) {
      // B→C: B を割らず(超えず)、C が B 以降の最高値(最安値)
      if (up ? maxH(B.i, C.i) !== B.price || minL(B.i, C.i) !== C.price : minL(B.i, C.i) !== B.price || maxH(B.i, C.i) !== C.price) continue;
      for (const A of conf.filter((p) => p.type === C.type && p.i < B.i && C.i - p.i <= LOOKBACK)) {
        // A→B: A が区間の最安値(最高値)、B が区間の最高値(最安値)
        if (up ? minL(A.i, B.i) !== A.price || maxH(A.i, B.i) !== B.price : maxH(A.i, B.i) !== A.price || minL(A.i, B.i) !== B.price) continue;
        const t = targetsOf(A, B, C);
        if (t.retrace >= 1) continue; // C が A を超えている = 押し・戻しではない
        const key = `${A.date}|${B.date}|${C.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let progress: number | null = null, extreme: number | null = null;
        if (inProgress) {
          extreme = tent.price;
          progress = (up ? tent.price - C.price : C.price - tent.price) / Math.abs(t.N - C.price);
        }
        out.push({ t, inProgress, progress, extreme, waveSize: Math.abs(B.price - A.price) });
      }
    }
  }
  // 進行中の第3波 → 次の波。同じ区分では大きな波から
  return out.sort((a, b) => Number(b.inProgress) - Number(a.inProgress) || b.waveSize - a.waveSize).slice(0, 8);
}

/** 基準日(転換点)からの日数が基本数値に当たる日。日数は基準日を 1 日目として営業日(本数)で数える */
export interface TimeSignal {
  from: string; fromType: "high" | "low"; fromPrice: number; // 基準日(起算日)
  bars: number; // 当日が基準日から何日目か(基準日 = 1 日目)
  number: number; // 該当する基本数値
  offset: number; // bars − number(0 ならちょうど、+1 は前日がちょうど)
}
export interface UpcomingTime { date: string; inBars: number; from: string; fromType: "high" | "low"; fromPrice: number; number: number }

/** 営業日(土日除く。祝日は未考慮)を n 本進めた日付 */
export function addTradingDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  for (let k = 0; k < n; k++) do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/**
 * 時間論: 直近 6 つの確定転換点を基準日とし、基準日を 1 日目として数えた日数が基本数値(±1)に当たる日を探す。
 * hits = 当日が該当、upcoming = 10 営業日以内に該当する日(日付は土日のみ除いた概算。祝日は未考慮)
 */
export function timeSignals(pv: Pivot[], end: number, bars: Bar[]): { hits: TimeSignal[]; upcoming: UpcomingTime[] } {
  const hits: TimeSignal[] = [], upcoming: UpcomingTime[] = [];
  for (const p of pv.filter((x) => x.confirmed).slice(-6)) {
    const n = end - p.i + 1; // 基準日を 1 日目とする
    for (const b of BASIC_NUMBERS) {
      // 当日がちょうど(offset 0)か前日がちょうど(offset +1)なら当日を候補に。ちょうどの日がまだ先なら upcoming に日付で示す
      if (n === b || n === b + 1) hits.push({ from: p.date, fromType: p.type, fromPrice: p.price, bars: n, number: b, offset: n - b });
      else if (b > n && b - n <= 10) upcoming.push({ date: addTradingDays(bars[end].date, b - n), inBars: b - n, from: p.date, fromType: p.type, fromPrice: p.price, number: b });
    }
  }
  hits.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset) || b.number - a.number);
  return { hits, upcoming: upcoming.sort((a, b) => a.inBars - b.inBars || b.number - a.number).slice(0, 6) };
}

export interface IchimokuSignal {
  tk: number; // 転換線 > 基準線: +1
  cloud: number; // 雲の上 +1 / 中 0 / 下 −1
  chikou: number; // 遅行スパンが 26 本前の高値より上 +1 / 安値より下 −1
  future: number; // 26 本先の雲が陽転(先行1>先行2) +1
  slope: number; // 基準線が 5 本前より上 +1
  wave: number; // 上昇N +1 / 下落N −1
}
export const SIGNAL_KEYS = ["tk", "cloud", "chikou", "future", "slope", "wave"] as const;

export interface Ichimoku {
  date: string;
  close: number;
  lines: Lines;
  futureCloud: { spanA: number; spanB: number };
  chikouRef: { high: number; low: number; close: number }; // 26 本前のローソク
  signal: IchimokuSignal;
  score: number; // −100..100
  judgment: "買い" | "売り" | "様子見";
  sanyaku: "三役好転" | "三役逆転" | null;
  wave: Wave;
  pivots: Pivot[];
  targets: Targets | null;
  scenarios?: Scenario[]; // 3波動の読み方の候補(複数)
  time: ReturnType<typeof timeSignals>;
  levels: { price: number; label: string }[]; // 相場水準(価格順)
  support: { price: number; label: string } | null;
  resistance: { price: number; label: string } | null;
  candidates?: LevelCandidate[]; // 根拠の重なりでまとめた支持・抵抗の候補
}

/** 支持・抵抗の候補: 近接する水準(±0.4%)を 1 つにまとめ、根拠の数を強さとする */
export interface LevelCandidate {
  side: "support" | "resistance";
  price: number; // 代表値(根拠の平均)
  lo: number; hi: number; // 含まれる水準の範囲
  reasons: { price: number; label: string; kind: LevelKind }[];
  strength: number; // 根拠の数(種類の重複は 1 つに数えない)
}
export type LevelKind = "line" | "cloud" | "futureCloud" | "chikou" | "pivot" | "target" | "half" | "round";

/** 相場水準の候補を列挙してまとめる */
export function levelCandidates(bars: Bar[], i: number, L: Lines, pv: Pivot[], scenarios: Scenario[]): LevelCandidate[] {
  const close = bars[i].close;
  const md = (d: string) => d.slice(5).replace("-", "/");
  const raw: LevelCandidate["reasons"] = [];
  const add = (price: number, label: string, kind: LevelKind) => { if (Number.isFinite(price) && price > 0) raw.push({ price, label, kind }); };
  // 五線
  add(L.tenkan, "転換線(9日半値)", "line"); add(L.kijun, "基準線(26日半値)", "line"); add(hl(bars, i, 52), "52日半値", "line");
  add(Math.max(L.spanA, L.spanB), "雲の上限", "cloud"); add(Math.min(L.spanA, L.spanB), "雲の下限", "cloud");
  // 26 日先の雲(先行スパン)
  const fc = futureCloudAt(bars, i);
  add(fc.spanA, "26日先の先行スパン1", "futureCloud"); add(fc.spanB, "26日先の先行スパン2", "futureCloud");
  // 遅行スパン: 26 日前のローソク(終値がここを抜けると遅行スパンの好転・逆転)
  const ref = bars[i - 26];
  add(ref.high, `26日前(${md(ref.date)})の高値 = 遅行スパン好転の目安`, "chikou"); add(ref.low, `26日前(${md(ref.date)})の安値 = 遅行スパン逆転の目安`, "chikou");
  // 転換点(直近 8)
  for (const p of pv.filter((x) => x.confirmed).slice(-8)) add(p.price, `${md(p.date)}${p.type === "high" ? "高値" : "安値"}`, "pivot");
  const tent = pv[pv.length - 1];
  if (tent && !tent.confirmed) add(tent.price, `${md(tent.date)}${tent.type === "high" ? "高値" : "安値"}(未確定)`, "pivot");
  // 各読みの計算値と半値
  scenarios.forEach((sc, n) => {
    const t = sc.t, tag = `読み${n + 1}`;
    for (const k of ["N", "V", "E", "NT"] as const) add(t[k], `${tag} ${k}計算値`, "target");
    const ab = [t.a.price, t.b.price], bc = [t.b.price, t.c.price];
    add((ab[0] + ab[1]) / 2, `${tag} A→B(${md(t.a.date)}→${md(t.b.date)})の半値`, "half");
    add((bc[0] + bc[1]) / 2, `${tag} B→C(${md(t.b.date)}→${md(t.c.date)})の半値`, "half");
    if (n === 0) {
      add(ab[1] + (ab[0] - ab[1]) / 3, `${tag} A→Bの1/3戻し`, "half"); add(ab[1] + ((ab[0] - ab[1]) * 2) / 3, `${tag} A→Bの2/3戻し`, "half");
      add(bc[1] + (bc[0] - bc[1]) / 3, `${tag} B→Cの1/3`, "half"); add(bc[1] + ((bc[0] - bc[1]) * 2) / 3, `${tag} B→Cの2/3`, "half");
    }
  });
  // 大台(5,000 円刻み、現値 ±12%)
  for (let r = Math.ceil((close * 0.88) / 5000) * 5000; r <= close * 1.12; r += 5000) add(r, "大台", "round");

  // 現値から ±12% の範囲に絞り、近接する水準をまとめる
  const within = raw.filter((x) => Math.abs(x.price - close) / close <= 0.12 && Math.abs(x.price - close) / close >= 0.001).sort((a, b) => a.price - b.price);
  const tol = close * 0.004;
  const groups: LevelCandidate[] = [];
  for (const x of within) {
    const g = groups[groups.length - 1];
    if (g && x.price - g.hi <= tol && (x.price > close) === (g.lo > close)) { g.reasons.push(x); g.hi = x.price; }
    else groups.push({ side: x.price > close ? "resistance" : "support", price: 0, lo: x.price, hi: x.price, reasons: [x], strength: 0 });
  }
  for (const g of groups) {
    g.price = g.reasons.reduce((a, r) => a + r.price, 0) / g.reasons.length;
    g.strength = new Set(g.reasons.map((r) => r.kind)).size + Math.max(0, g.reasons.length - 1) * 0.5;
    g.reasons.sort((a, b) => Math.abs(a.price - g.price) - Math.abs(b.price - g.price));
  }
  // 各サイド、現値に近い順に並べる(強さは表示側で)
  return groups.sort((a, b) => Math.abs(a.price - close) - Math.abs(b.price - close));
}

export function signalAt(bars: Bar[], i: number, pv?: Pivot[]): IchimokuSignal | null {
  const L = linesAt(bars, i);
  if (!L) return null;
  const c = bars[i].close;
  const top = Math.max(L.spanA, L.spanB), bot = Math.min(L.spanA, L.spanB);
  const ref = bars[i - 26];
  const fc = futureCloudAt(bars, i);
  const kijun5 = hl(bars, i - 5, 26);
  const w = classifyWave(pv ?? pivots(bars, i));
  return {
    tk: L.tenkan > L.kijun ? 1 : L.tenkan < L.kijun ? -1 : 0,
    cloud: c > top ? 1 : c < bot ? -1 : 0,
    chikou: c > ref.high ? 1 : c < ref.low ? -1 : 0,
    future: fc.spanA > fc.spanB ? 1 : fc.spanA < fc.spanB ? -1 : 0,
    slope: L.kijun > kijun5 ? 1 : L.kijun < kijun5 ? -1 : 0,
    wave: w === "上昇N波動" ? 1 : w === "下落N波動" ? -1 : 0,
  };
}

export const scoreOf = (s: IchimokuSignal) => (SIGNAL_KEYS.reduce((a, k) => a + s[k], 0) / SIGNAL_KEYS.length) * 100;
export const judgmentOf = (score: number): Ichimoku["judgment"] => (score >= 40 ? "買い" : score <= -40 ? "売り" : "様子見");

export function ichimoku(bars: Bar[]): Ichimoku | null {
  const i = bars.length - 1;
  const L = linesAt(bars, i);
  if (!L) return null;
  const pv = pivots(bars, i);
  const signal = signalAt(bars, i, pv)!;
  const score = scoreOf(signal);
  const close = bars[i].close;
  const t = targets(pv, bars, i);
  const scenarios = waveScenarios(bars, i, pv);
  const top = Math.max(L.spanA, L.spanB), bot = Math.min(L.spanA, L.spanB);
  const levels: Ichimoku["levels"] = [
    { price: L.tenkan, label: "転換線" }, { price: L.kijun, label: "基準線(26日半値)" },
    { price: top, label: "雲の上限" }, { price: bot, label: "雲の下限" },
    { price: hl(bars, i, 52), label: "52日半値" },
    ...pv.filter((p) => p.confirmed).slice(-4).map((p) => ({ price: p.price, label: `${p.type === "high" ? "高値" : "安値"} ${p.date.slice(5).replace("-", "/")}` })),
    ...(t ? (["N", "V", "E", "NT"] as const).map((k) => ({ price: t[k], label: `${k}計算値` })) : []),
  ].sort((a, b) => a.price - b.price);
  const below = levels.filter((l) => l.price < close), above = levels.filter((l) => l.price > close);
  const ref = bars[i - 26];
  return {
    date: bars[i].date, close, lines: L, futureCloud: futureCloudAt(bars, i),
    chikouRef: { high: ref.high, low: ref.low, close: ref.close },
    signal, score, judgment: judgmentOf(score),
    sanyaku: signal.tk > 0 && signal.cloud > 0 && signal.chikou > 0 ? "三役好転" : signal.tk < 0 && signal.cloud < 0 && signal.chikou < 0 ? "三役逆転" : null,
    wave: classifyWave(pv), pivots: pv.slice(-6), targets: t, scenarios, time: timeSignals(pv, i, bars),
    levels, support: below[below.length - 1] ?? null, resistance: above[0] ?? null,
    candidates: levelCandidates(bars, i, L, pv, scenarios),
  };
}

export interface Backtest {
  from: string; to: string; n: number;
  buy: { n: number; hit: number }; sell: { n: number; hit: number };
  buy5: { n: number; hit: number }; sell5: { n: number; hit: number }; // 5 営業日後
  perSignal: Record<(typeof SIGNAL_KEYS)[number], { pos: number; posUp: number; neg: number; negUp: number }>;
  upRate: number; upRate5: number;
}

/** 過去データで「判断 → 翌営業日 / 5営業日後」の的中を検証 */
export function backtest(bars: Bar[]): { stats: Backtest; samples: { date: string; signal: IchimokuSignal; timeHit: boolean; up: 0 | 1 }[] } {
  const samples: { date: string; signal: IchimokuSignal; timeHit: boolean; up: 0 | 1 }[] = [];
  const stats: Backtest = {
    from: "", to: "", n: 0, buy: { n: 0, hit: 0 }, sell: { n: 0, hit: 0 }, buy5: { n: 0, hit: 0 }, sell5: { n: 0, hit: 0 },
    perSignal: Object.fromEntries(SIGNAL_KEYS.map((k) => [k, { pos: 0, posUp: 0, neg: 0, negUp: 0 }])) as Backtest["perSignal"], upRate: 0, upRate5: 0,
  };
  let ups = 0, ups5 = 0, n5 = 0;
  for (let i = 78; i < bars.length - 1; i++) {
    const pv = pivots(bars, i);
    const s = signalAt(bars, i, pv);
    if (!s) continue;
    const up = bars[i + 1].close > bars[i].close ? 1 : 0;
    samples.push({ date: bars[i].date, signal: s, timeHit: timeSignals(pv, i, bars).hits.length > 0, up });
    stats.from ||= bars[i].date; stats.to = bars[i].date; stats.n++; ups += up;
    const j = judgmentOf(scoreOf(s));
    if (j === "買い") { stats.buy.n++; stats.buy.hit += up; }
    if (j === "売り") { stats.sell.n++; stats.sell.hit += 1 - up; }
    if (i + 5 < bars.length) {
      const up5 = bars[i + 5].close > bars[i].close ? 1 : 0;
      ups5 += up5; n5++;
      if (j === "買い") { stats.buy5.n++; stats.buy5.hit += up5; }
      if (j === "売り") { stats.sell5.n++; stats.sell5.hit += 1 - up5; }
    }
    for (const k of SIGNAL_KEYS) {
      const ps = stats.perSignal[k];
      if (s[k] > 0) { ps.pos++; ps.posUp += up; } else if (s[k] < 0) { ps.neg++; ps.negUp += up; }
    }
  }
  stats.upRate = stats.n ? ups / stats.n : 0;
  stats.upRate5 = n5 ? ups5 / n5 : 0;
  return { stats, samples };
}

/** 日経公式 CSV(データ日付,終値,始値,高値,安値)→ 日足 */
export function parseNikkeiOhlc(text: string): Bar[] {
  const out: Bar[] = [];
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(",").map((s) => s.replace(/"/g, "").trim());
    const m = c[0]?.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    const [close, open, high, low] = [c[1], c[2], c[3], c[4]].map(Number);
    if (m && close > 0 && high > 0 && low > 0) out.push({ date: `${m[1]}-${m[2]}-${m[3]}`, open: open || close, high, low, close });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
