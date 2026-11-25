import { describe, it, expect } from "vitest";
import { tickVolumeSaturated, substituteVolume } from "../src/alerts";

const mk = (n: number, vol: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ t: 1_700_000_000 + i * 300, open: 100, high: 101 + (i % 3), low: 99, close: 100, volume: vol(i) }));

describe("tick volume saturation", () => {
  it("flags flat tick volume and not normal volume", () => {
    expect(tickVolumeSaturated(mk(80, (i) => 1950 + (i % 5) * 5))).toBe(true);
    expect(tickVolumeSaturated(mk(80, (i) => 800 + (i % 7) * 300))).toBe(false);
  });
  it("replaces volume with CME volume and estimates the newest bars from range", () => {
    const mt5 = mk(30, () => 1950);
    const cme = mk(27, (i) => (i === 20 ? 5000 : 1000)); // 最後の 3 本は CME がまだない
    const r = substituteVolume(mt5, cme);
    expect(r.matched).toBe(27);
    expect(r.estimated).toBe(3);
    expect(r.bars[20].volume).toBe(5000);
    expect(r.bars[29].volume).toBeGreaterThan(0);
  });
});
