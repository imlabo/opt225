import { describe, it, expect } from "vitest";
import { buildNight, nightWindow } from "../src/night";

describe("night session", () => {
  it("cuts 16:30-06:00 JST and measures distance to breakevens", () => {
    const [from, to] = nightWindow("2026-11-20");
    expect(new Date(from * 1000).toISOString()).toBe("2026-11-20T07:30:00.000Z");
    expect(new Date(to * 1000).toISOString()).toBe("2026-11-20T21:00:00.000Z");
    const bars = [];
    for (let t = from - 6 * 3600; t < to + 3600; t += 900) bars.push({ t, open: 61000, high: 61050, low: 60950, close: t < from ? 61000 : 60500, volume: 10 });
    bars[bars.length - 10].low = 60000;
    const n = buildNight(bars, "2026-11-20", { tradeDate: "2026-11-20", basis: 0, putBreakeven: 60100, callBreakeven: 62000, putLevel: 60100, callLevel: 62000 })!;
    expect(n.dayClose).toBe(61000);
    expect(n.close).toBe(60500);
    expect(n.change).toBe(-500);
    expect(n.brokePut).toBe(true);
    expect(n.putDist!).toBeCloseTo(((60500 - 60100) / 60500) * 100, 5);
  });
});
