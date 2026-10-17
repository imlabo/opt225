/** 一目均衡表の計算結果・バックテスト・学習済み事前重みをまとめる(GitHub Actions 上で実行) */
import type { IchimokuPayload } from "./daily";
import { backtest, futureCloudAt, ichimoku, linesAt, type Bar } from "./ichimoku";
import { fit, ICHI_FEATURES, ichiFeatures, PRIOR, type Features } from "./model";

/**
 * @param bars  日経公式 CSV の日足(必要なら Yahoo で補った後のもの)
 * @param tradeDate 対象日
 * @param spot  対象日の終値(JPX 原資産価格など)。日足に対象日が無い場合の仮置きに使う。null なら仮置きしない
 * @param filled Yahoo で補った日付(表示用)
 */
export function buildIchimoku(bars: Bar[], tradeDate: string, spot: number | null, filled: string[] = []): IchimokuPayload {
  let barsSource: IchimokuPayload["barsSource"] = filled.length ? "nikkei+yahoo" : "nikkei";
  bars = bars.filter((b) => b.date <= tradeDate);
  if (!bars.length || bars[bars.length - 1].date < tradeDate) {
    if (spot == null) throw new Error(`no bar for ${tradeDate}`);
    // 日経 CSV も Yahoo も未更新: 当日足を JPX の終値で仮置き(次回の実行で上書き)
    bars.push({ date: tradeDate, open: spot, high: spot, low: spot, close: spot });
    barsSource = "nikkei+jpx";
  }
  const result = ichimoku(bars);
  if (!result) throw new Error("not enough bars for ichimoku");
  const bt = backtest(bars);
  // バックテストの全サンプルで一目特徴量の重みを学習 → 予測モデルの事前仮説に使う
  const zero = Object.fromEntries(Object.keys(PRIOR).filter((k) => k !== "bias").map((k) => [k, 0])) as Features;
  const w = fit(bt.samples.map((s) => ({ x: { ...zero, ...ichiFeatures({ signal: s.signal, timeHit: s.timeHit }) }, y: s.up })));
  const prior = Object.fromEntries(ICHI_FEATURES.map((k) => [k, w[k]]));
  const n = bars.length - 1, from = Math.max(77, n - 119);
  const chart = bars.slice(from).map((b, k) => {
    const L = linesAt(bars, from + k);
    return { ...b, tenkan: L?.tenkan, kijun: L?.kijun, spanA: L?.spanA, spanB: L?.spanB };
  });
  const futureCloud: IchimokuPayload["futureCloud"] = [];
  const d = new Date(tradeDate + "T00:00:00Z");
  for (let k = 1; k <= 26; k++) {
    do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    futureCloud.push({ date: d.toISOString().slice(0, 10), ...futureCloudAt(bars, n - 26 + k) });
  }
  const st = bt.stats;
  console.log(`Ichimoku ${result.date} ${result.judgment} score ${result.score.toFixed(0)} wave ${result.wave} (src ${barsSource}) / backtest buy ${st.buy.hit}/${st.buy.n} sell ${st.sell.hit}/${st.sell.n} / prior ${JSON.stringify(prior)}`);
  return { result, barsSource, filled, backtest: st, prior, chart, futureCloud };
}
