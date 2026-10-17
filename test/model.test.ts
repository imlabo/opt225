import { describe, expect, it } from "vitest";
import { calibrateK, FEATURES, fit, metrics, PRIOR, predictProb, type Features } from "../src/model";

const zero = (): Features => Object.fromEntries(FEATURES.map((f) => [f, 0])) as Features;

describe("self-correcting model", () => {
  it("stays at the prior without evidence", () => {
    const w = fit([]);
    for (const f of FEATURES) expect(w[f]).toBeCloseTo(PRIOR[f], 6);
  });

  it("learns a predictive feature and drops a useless prior", () => {
    // dPcr が正のとき上昇、weekly(事前 +0.3)は実際には無関係
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const samples = Array.from({ length: 3000 }, () => {
      const x = zero();
      x.dPcr = rnd() * 4 - 2;
      x.weekly = rnd() * 2 - 1;
      const y = (rnd() < 1 / (1 + Math.exp(-1.5 * x.dPcr)) ? 1 : 0) as 0 | 1;
      return { x, y };
    });
    const few = fit(samples.slice(0, 10));
    const many = fit(samples);
    expect(Math.abs(few.dPcr - PRIOR.dPcr)).toBeLessThan(Math.abs(many.dPcr - PRIOR.dPcr)); // データが増えるほど大きく補正
    expect(many.dPcr).toBeGreaterThan(0.8);
    expect(Math.abs(many.weekly)).toBeLessThan(PRIOR.weekly); // 効かない仮説は弱まる
    const x = zero(); x.dPcr = 1.5;
    expect(predictProb(many, x)).toBeGreaterThan(0.7);
  });

  it("calibrates range multiplier toward observed 68% coverage", () => {
    expect(calibrateK([])).toBe(1);
    const wide = Array.from({ length: 200 }, (_, i) => (i / 200) * 3); // 68%点 ≈ 2.04
    expect(calibrateK(wide)).toBeGreaterThan(1.8);
    expect(calibrateK(wide.slice(0, 5).map(() => 2))).toBeLessThan(1.3); // 少数サンプルは 1 に寄せる
  });

  it("scores direction only when a call was made", () => {
    const m = metrics([
      { tradeDate: "a", pUp: 0.7, call: "up", spot: 100, actualSpot: 101, rangeLo: 99, rangeHi: 102, sigma1d: 1 },
      { tradeDate: "b", pUp: 0.3, call: "down", spot: 100, actualSpot: 103, rangeLo: 99, rangeHi: 102, sigma1d: 1 },
      { tradeDate: "c", pUp: 0.5, call: "flat", spot: 100, actualSpot: 99.5, rangeLo: 99, rangeHi: 101, sigma1d: 1 },
    ]);
    expect(m).toMatchObject({ n: 3, calls: 2, hits: 1, hitRate: 0.5 });
    expect(m.rangeRate).toBeCloseTo(2 / 3);
    expect(m.brier).toBeCloseTo((0.09 + 0.49 + 0.25) / 3);
  });
});
