import { describe, expect, it } from "vitest";
import { computeNikkeiFg, parseCnn, parseNikkeiCsv, percentile, ratingOf } from "../src/sentiment";

const days = (n: number, f: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({ date: new Date(Date.UTC(2024, 0, 1) + i * 864e5).toISOString().slice(0, 10), value: f(i) }));

describe("Fear & Greed", () => {
  it("rates like CNN", () => {
    expect(ratingOf(10)).toBe("extreme fear");
    expect(ratingOf(30)).toBe("fear");
    expect(ratingOf(50)).toBe("neutral");
    expect(ratingOf(60)).toBe("greed");
    expect(ratingOf(90)).toBe("extreme greed");
    expect(percentile(5, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(45);
  });

  it("scores a rally with falling VI as greed and a crash with VI spike as fear", () => {
    const n = 400;
    const up = computeNikkeiFg(days(n, (i) => (i < 340 ? 30000 + Math.sin(i / 7) * 800 : 30000 + (i - 340) * 120)), days(n, (i) => (i < 340 ? 22 + Math.sin(i / 5) * 3 : 22 - (i - 340) * 0.15)));
    expect(up[up.length - 1].score).toBeGreaterThan(75);
    const crash = computeNikkeiFg(days(n, (i) => (i < 380 ? 30000 + i * 10 : 33800 - (i - 380) * 400)), days(n, (i) => (i < 380 ? 18 : 18 + (i - 380) * 2)));
    expect(crash[crash.length - 1].score).toBeLessThan(25);
    expect(Object.keys(crash[crash.length - 1].components).sort()).toEqual(["momentum", "strength", "viLevel", "volatility"]);
  });

  it("adds own P/C ratio only after 20 observations", () => {
    const n = 300;
    const p = days(n, (i) => 30000 + Math.sin(i / 10) * 1000), v = days(n, () => 20);
    const pcr10 = days(n, (i) => 2 + (i % 7) * 0.1).slice(-10);
    const pcr30 = days(n, (i) => 2 + (i % 7) * 0.1).slice(-30);
    expect(computeNikkeiFg(p, v, { pcr: pcr10, skew: [] }).at(-1)!.components.pcr).toBeUndefined();
    expect(computeNikkeiFg(p, v, { pcr: pcr30, skew: [] }).at(-1)!.components.pcr).toBeDefined();
  });

  it("parses Nikkei CSV and CNN JSON", () => {
    expect(parseNikkeiCsv('header\r\n"2023/01/05","25820.80","25825.50","25947.10","25750.46"\r\n"2023/01/04","25716.86","1","1","1"\r\n'))
      .toEqual([{ date: "2023-01-04", value: 25716.86 }, { date: "2023-01-05", value: 25820.8 }]);
    const c = parseCnn({
      fear_and_greed: { score: 17.9, rating: "extreme fear", timestamp: "2026-10-16T23:59:49+00:00", previous_close: 31.5, previous_1_week: 46.5 },
      fear_and_greed_historical: { data: [{ x: Date.UTC(2026, 9, 15), y: 31.5 }, { x: Date.UTC(2026, 9, 16), y: 17.9 }] },
    });
    expect(c).toMatchObject({ date: "2026-10-16", score: 17.9, rating: "extreme fear", previousClose: 31.5 });
    expect(c.history).toEqual([{ date: "2026-10-15", value: 31.5 }, { date: "2026-10-16", value: 17.9 }]);
  });
});
