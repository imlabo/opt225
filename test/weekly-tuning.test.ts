import { describe, expect, it } from "vitest";
import { fitWeekly, tuneWeekly, weeklyOutcomes, weeklyScore, WEEKLY_PRIOR, type WeeklySample } from "../src/weekly-tuning";
import { INVESTORS } from "../src/types";

const z = (o: Partial<Record<string, number>>) => Object.fromEntries(INVESTORS.map((i) => [i, o[i] ?? 0])) as WeeklySample["z"];

describe("weekly tuning", () => {
  it("scores like the weekly analysis", () => {
    expect(weeklyScore(WEEKLY_PRIOR, z({ individual: 3 }))).toBe(-45); // −0.45×100 / (0.45+0.35+0.2)
    expect(weeklyScore(WEEKLY_PRIOR, z({ corporate: 3, individual: -3 }))).toBe(80);
  });
  it("pairs each week with the publication-day to next-publication-day move", () => {
    // 週末 10/02(金) → 公表 10/08(木) → 翌公表 10/15(木)。10/09 が祝日でも木曜があれば使う
    const prices = ["2026-10-07", "2026-10-08", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"].map((d, i) => ({ date: d, value: 100 + i }));
    const a = [{ weekEnd: "2026-10-02", score: 20, bias: "やや上昇", investors: INVESTORS.map((i) => ({ investor: i, z: 0 })) },
      { weekEnd: "2026-10-09", score: -20, bias: "やや下落", investors: [] }];
    const s = weeklyOutcomes(a, prices);
    expect(s.length).toBe(1); // 10/09 週は翌公表日(10/22)の終値がまだない
    expect(s[0]).toMatchObject({ from: "2026-10-08", to: "2026-10-15", c0: 101, c1: 104, y: 1 });
  });
  it("keeps the prior until enough weeks, then learns", () => {
    // 法人の z と翌週の方向が一致するデータ
    const mk = (n: number): WeeklySample[] => Array.from({ length: n }, (_, i) => {
      const c = ((i * 7) % 5) - 2, y: 0 | 1 = c > 0 ? 1 : 0;
      return { weekEnd: `w${i}`, z: z({ corporate: c, individual: -c * 0.5 }), score: 0, bias: "", from: "", to: "", c0: 1, c1: 1, ret: y ? 0.01 : -0.01, y };
    });
    const few = tuneWeekly(mk(5), WEEKLY_PRIOR, "2026-11-01");
    expect(few.report.changed).toBe(false);
    expect(few.weights).toEqual(WEEKLY_PRIOR);
    const many = tuneWeekly(mk(30), WEEKLY_PRIOR, "2026-11-01");
    expect(many.weights.corporate).toBeGreaterThan(WEEKLY_PRIOR.corporate);
    expect(many.report.walkForward.logloss).toBeLessThan(many.report.priorOnly.logloss + 1e-9);
    const w = fitWeekly(mk(30));
    expect(w.corporate).toBeGreaterThan(0);
  });
});
