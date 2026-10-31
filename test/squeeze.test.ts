import { describe, expect, it } from "vitest";
import { squeezeRaw, squeezeScore, upsertHist, MIN_HISTORY, type SqueezeRaw } from "../src/squeeze";
import type { DailyAnalysis } from "../src/daily";

const base = (o: Partial<DailyAnalysis>): DailyAnalysis => ({
  tradeDate: "2026-10-30", spot: 40000, front: { month: "202611", days: 14 }, atmStrike: 40000, atmIv: 20, expectedMove: 1200, skew: 5,
  putOi: 0, callOi: 0, pcr: 1, putOiAll: 0, callOiAll: 0, pcrAll: 1, putChg: 0, callChg: 0, putWall: null, callWall: null, maxPain: null,
  topPutAdds: [], topCallAdds: [], comment: "",
  seller: { curve: [], putPremium: 100e8, callPremium: 50e8, putBreakeven: 39000, callBreakeven: 43000, putAtDown5: 0, putAtDown10: 0, callAtUp5: 0, callAtUp10: 0 },
  ...o,
});

describe("squeeze", () => {
  const prev = base({ tradeDate: "2026-10-29", spot: 41000, atmIv: 18, skew: 4 });
  const today = base({ seller: { ...prev.seller!, putPremium: 130e8, callPremium: 40e8, putBreakeven: 39500, callBreakeven: 44000 } });
  const rows = [
    { month: "202611", strike: 39000, putOi: 3000, putChg: -300, callOi: 100 },
    { month: "202611", strike: 40000, putOi: 2000, putChg: -100, callOi: 1000 },
    { month: "202611", strike: 44000, putOi: 100, callOi: 2000 },
    { month: "202611", strike: 35000, putOi: 5000, callOi: 0 },
  ];
  const raw = squeezeRaw(today, prev, rows);
  it("puts fear on the put side after a drop with rising premium, IV and buybacks", () => {
    expect(raw.put.dist!.value).toBeCloseTo(500 / 1200, 6);
    expect(raw.put.loss!.value).toBeCloseTo(0.3, 6);
    expect(raw.call.loss!.value).toBeCloseTo(-0.2, 6);
    expect(raw.put.vol!.value).toBeCloseTo(3, 6); // IV +2 + スキュー +1
    expect(raw.call.vol!.value).toBeCloseTo(1, 6);
    expect(raw.put.cover!.value).toBeCloseTo(400 / 5400, 6); // ±1σ(38,800〜41,200)の前日建玉 5,400 から 400 減
    expect(raw.call.cover!.value).toBe(0); // 下げた日はコール側の買い戻しは見ない
    const sq = squeezeScore(raw, []);
    expect(sq.put.index).toBeGreaterThan(70);
    expect(sq.call.index).toBeLessThan(sq.put.index);
    expect(sq.put.comps.dist!.mode).toBe("fixed");
  });
  it("switches to percentiles with enough history", () => {
    const hist: SqueezeRaw[] = Array.from({ length: MIN_HISTORY }, (_, i) => ({ ...raw, date: `d${i}`, put: { ...raw.put, dist: { value: 0, x: i / 10 - 3 } } }));
    const sq = squeezeScore(raw, hist);
    expect(sq.put.comps.dist!.mode).toBe("percentile");
    expect(sq.put.comps.loss!.mode).toBe("percentile");
    const h = upsertHist(upsertHist([], raw, sq), raw, sq);
    expect(h.length).toBe(1);
  });
});
