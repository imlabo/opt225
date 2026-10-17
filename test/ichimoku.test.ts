import { describe, expect, it } from "vitest";
import { backtest, classifyWave, ichimoku, linesAt, pivots, signalAt, targets, timeSignals, type Bar, type Pivot } from "../src/ichimoku";

const mk = (closes: number[]): Bar[] => closes.map((c, i) => ({
  date: new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10), open: c, high: c * 1.005, low: c * 0.995, close: c,
}));
// 上昇 N 波動: 安値を切り上げ高値を更新するジグザグ
const zig = (legs: number[], per = 15) => {
  const out: number[] = [];
  for (let k = 1; k < legs.length; k++) for (let j = 0; j < per; j++) out.push(legs[k - 1] + ((legs[k] - legs[k - 1]) * j) / per);
  out.push(legs[legs.length - 1]);
  return out;
};

describe("ichimoku lines", () => {
  it("computes tenkan/kijun as mid of high-low and spans shifted 26", () => {
    const bars = mk(Array.from({ length: 120 }, (_, i) => 100 + i));
    const L = linesAt(bars, 119)!;
    const hl = (a: number, n: number) => (bars[a].high + bars[a - n + 1].low) / 2; // 単調増加なので端点
    expect(L.tenkan).toBeCloseTo(hl(119, 9));
    expect(L.kijun).toBeCloseTo(hl(119, 26));
    expect(L.spanB).toBeCloseTo(hl(93, 52));
    expect(L.spanA).toBeCloseTo((hl(93, 9) + hl(93, 26)) / 2);
  });

  it("signals use no future data", () => {
    const bars = mk(zig([100, 130, 115, 150, 135, 170, 120], 20));
    for (const i of [90, 100, 110]) expect(signalAt(bars, i)).toEqual(signalAt(bars.slice(0, i + 1), i));
  });
});

describe("wave / targets / time", () => {
  const bars = mk(zig([100, 130, 115, 150, 135, 160], 20));
  const pv = pivots(bars);
  it("detects zigzag pivots and up N wave", () => {
    const c = pv.filter((p) => p.confirmed).map((p) => [p.type, Math.round(p.price)]);
    expect(c.map((x) => x[0])).toEqual(["high", "low", "high", "low"]);
    expect(classifyWave(pv)).toBe("上昇N波動");
  });
  it("computes N/V/E/NT targets from A-B-C", () => {
    const P = (type: "high" | "low", price: number, i: number): Pivot => ({ i, date: "d", price, type, confirmed: true });
    const t = targets([P("low", 100, 0), P("high", 130, 10), P("low", 115, 20)])!;
    expect(t).toMatchObject({ direction: "up", N: 145, V: 145, E: 160, NT: 130 });
    const d = targets([P("high", 200, 0), P("low", 170, 10), P("high", 190, 20)])!;
    expect(d).toMatchObject({ direction: "down", N: 160, V: 150, E: 140, NT: 180 });
  });
  it("flags basic numbers from pivots", () => {
    const last = pv.filter((p) => p.confirmed).at(-1)!;
    const end = last.i + 25; // 基準日を 1 日目として 26 日目
    const t = timeSignals(pv, end, mk(Array(end + 1).fill(100)));
    expect(t.hits.some((h) => h.number === 26 && h.bars === 26 && h.offset === 0 && h.from === last.date)).toBe(true);
    expect(t.upcoming.every((u) => u.date > t.hits[0].from && u.inBars >= 1)).toBe(true);
  });
  it("uses the in-progress extreme as C when the current leg is large enough", () => {
    const P = (type: "high" | "low", price: number, i: number, confirmed = true): Pivot => ({ i, date: `d${i}`, price, type, confirmed });
    const flat = mk(Array(60).fill(100));
    // 進行中の下落が 10% なら未確定の安値を C とした上昇目標
    const t = targets([P("high", 110, 0), P("low", 100, 10), P("high", 130, 20), P("low", 117, 30, false)], flat, 59)!;
    expect(t).toMatchObject({ direction: "up", cTentative: true, N: 147, V: 143, E: 160, NT: 134 });
    // 進行中の動きが小さければ確定済みの 3 点から
    const u = targets([P("high", 110, 0), P("low", 100, 10), P("high", 130, 20), P("low", 129, 30, false)], flat, 59)!;
    expect(u).toMatchObject({ direction: "down", cTentative: false, N: 120 });
  });
  it("produces full result and backtest", () => {
    const r = ichimoku(bars)!;
    expect(r.judgment).toBeDefined();
    expect(r.levels.length).toBeGreaterThan(4);
    const bt = backtest(bars);
    expect(bt.stats.n).toBe(bt.samples.length);
  });
});
