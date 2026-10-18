import { describe, expect, it } from "vitest";
import { latestTradingDate, mergeBars, parseYahooChart, tokyoDate, tokyoNow } from "../src/yahoo";

const ts = (d: string, h = 9) => Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10), h - 9) / 1000); // JST h 時
const json = (dates: string[], closes: number[]) => ({
  chart: { result: [{ timestamp: dates.map((d) => ts(d)), indicators: { quote: [{ open: closes, high: closes.map((c) => c + 10), low: closes.map((c) => c - 10), close: closes }] } }] },
});

describe("yahoo", () => {
  it("converts timestamps to Tokyo dates", () => {
    expect(tokyoDate(ts("2026-10-16"))).toBe("2026-10-16");
    expect(tokyoNow(Date.UTC(2026, 9, 16, 7, 30)).minutes).toBe(16 * 60 + 30);
  });
  it("parses bars and drops nulls and the in-progress session", () => {
    const j = json(["2026-10-14", "2026-10-15", "2026-10-16"], [100, 110, 120]);
    (j.chart.result[0].indicators.quote[0].close as (number | null)[])[1] = null;
    // 10/16 12:00 JST: 当日足は取引中なので除外
    expect(parseYahooChart(j, Date.UTC(2026, 9, 16, 3, 0)).map((b) => b.date)).toEqual(["2026-10-14"]);
    // 10/16 16:00 JST: 当日足も採用
    expect(parseYahooChart(j, Date.UTC(2026, 9, 16, 7, 0)).map((b) => b.date)).toEqual(["2026-10-14", "2026-10-16"]);
  });
  it("throws on error payloads", () => {
    expect(() => parseYahooChart({ chart: { result: null, error: { description: "Not Found" } } })).toThrow(/Not Found/);
  });
  it("merges only newer bars up to the target date", () => {
    const nk = [{ date: "2026-10-14", open: 1, high: 2, low: 0, close: 1 }, { date: "2026-10-15", open: 1, high: 2, low: 0, close: 1 }];
    const y = [{ date: "2026-10-15", open: 9, high: 9, low: 9, close: 9 }, { date: "2026-10-16", open: 5, high: 6, low: 4, close: 5 }, { date: "2026-10-19", open: 7, high: 8, low: 6, close: 7 }];
    const m = mergeBars(nk, y, "2026-10-16");
    expect(m.added).toEqual(["2026-10-16"]);
    expect(m.bars.map((b) => b.close)).toEqual([1, 1, 5]);
    expect(mergeBars([], y).bars.length).toBe(3);
  });
  it("latestTradingDate skips weekends and the current session", () => {
    expect(latestTradingDate(Date.UTC(2026, 9, 17, 13, 0))).toBe("2026-10-16"); // 土曜
    expect(latestTradingDate(Date.UTC(2026, 9, 16, 3, 0))).toBe("2026-10-15"); // 金曜 12:00 JST
    expect(latestTradingDate(Date.UTC(2026, 9, 16, 8, 0))).toBe("2026-10-16"); // 金曜 17:00 JST
  });
});

describe("yahoo futures (CME)", () => {
  it("labels CME bars by Chicago trade date whichever open convention Yahoo uses", () => {
    // 取引日 2026-10-16(金): 開始 10/15 17:00 CDT = 22:00 UTC、または 10/16 0:00 CDT = 05:00 UTC
    const open1 = Date.UTC(2026, 9, 15, 22) / 1000, open2 = Date.UTC(2026, 9, 16, 5) / 1000;
    const j = (ts: number) => ({ chart: { result: [{ timestamp: [ts], indicators: { quote: [{ open: [1], high: [2], low: [0.5], close: [1.5] }] } }] } });
    const later = Date.UTC(2026, 9, 18);
    expect(parseYahooChart(j(open1), later, "cme")[0].date).toBe("2026-10-16");
    expect(parseYahooChart(j(open2), later, "cme")[0].date).toBe("2026-10-16");
    // 取引中(10/16 12:00 JST = 03:00 UTC)なら inProgress
    const b = parseYahooChart(j(open1), Date.UTC(2026, 9, 16, 3), "cme");
    expect(b.inProgress).toBe("2026-10-16");
    expect(parseYahooChart(j(open1), later, "cme").inProgress).toBeUndefined();
  });
});
