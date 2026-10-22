import { describe, expect, it } from "vitest";
import { bs, cdf, computeGreeks } from "../src/greeks";

describe("greeks", () => {
  it("normal cdf", () => {
    expect(cdf(0)).toBeCloseTo(0.5, 6);
    expect(cdf(1.96)).toBeCloseTo(0.975, 3);
    expect(cdf(-1.96)).toBeCloseTo(0.025, 3);
  });
  it("black-scholes greeks at the money", () => {
    const g = bs(40000, 40000, 30 / 365, 0.2);
    expect(g.callDelta).toBeGreaterThan(0.5);
    expect(g.callDelta - g.putDelta).toBeCloseTo(1, 9);
    // ATM ガンマ ≈ φ(0)/(Sσ√T)
    expect(g.gamma).toBeCloseTo(0.3989 / (40000 * 0.2 * Math.sqrt(30 / 365)), 6);
    // ATM セータ(1日) ≈ −Sσφ/(2√T)/365
    expect(g.thetaDay).toBeCloseTo(-(40000 * 0.2 * 0.3989) / (2 * Math.sqrt(30 / 365)) / 365, 0);
  });
  it("aggregates seller hedge, gamma and theta", () => {
    const strikes = [
      { month: "202611", strike: 39000, putOi: 1000, putIv: 22 },
      { month: "202611", strike: 41000, callOi: 500, callIv: 18 },
    ];
    const g = computeGreeks(strikes, [{ month: "202611", days: 20 }], 40000, "202611", 20)!;
    expect(g.putHedge).toBeLessThan(0); // プット売り → 先物売り
    expect(g.callHedge).toBeGreaterThan(0);
    expect(g.hedge).toBeCloseTo(g.callHedge + g.putHedge, 9);
    expect(g.gamma100).toBeGreaterThan(0);
    expect(g.thetaYen).toBeGreaterThan(0);
    expect(g.thetaFrontYen).toBeCloseTo(g.thetaYen, 6);
    // 価格が上がるとプット売りのヘッジ(売り)が減り、ヘッジは買い方向へ
    const lo = g.profile[0], hi = g.profile[g.profile.length - 1];
    expect(hi.hedge).toBeGreaterThan(lo.hedge);
    expect(computeGreeks(strikes, [{ month: "202611", days: 0 }], 40000, "202611", 20)).toBeUndefined();
  });
});
