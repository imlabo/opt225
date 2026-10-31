import { describe, expect, it } from "vitest";
import { PRIOR, FEATURES, type Features } from "../src/model";
import { DEFAULT_CONFIG, mask, tune, walkForward, thresholdStats, type Sample } from "../src/tuning";

const zero = Object.fromEntries(FEATURES.map((f) => [f, 0])) as Features;
let seed = 11;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
// momentum が効き、その他はノイズ。一目はわざと逆向き
const mkSamples = (n: number): Sample[] => Array.from({ length: n }, (_, i) => {
  const m = rnd() * 2 - 1, noise = rnd() * 2 - 1;
  const y: 0 | 1 = m + 0.4 * (rnd() - 0.5) > 0 ? 1 : 0;
  return { date: `2026-01-${String(i + 1).padStart(3, "0")}`, x: { ...zero, momentum: m, pain: noise, ichiTk: y ? -1 : 1 }, y, ret: (y ? 1 : -1) * 0.005 };
});

describe("tuning", () => {
  it("masks feature groups", () => {
    const x = mask({ ...zero, momentum: 1, pain: 1, sqPut: 2 }, ["options", "squeeze"]);
    expect(x.pain).toBe(0); expect(x.sqPut).toBe(0); expect(x.momentum).toBe(1);
  });
  it("walk-forward never uses the sample it predicts", () => {
    const s = mkSamples(30);
    const a = walkForward(s, { ridge: 4, off: [] }, PRIOR);
    const b = walkForward([...s.slice(0, 10), { ...s[10], y: (1 - s[10].y) as 0 | 1 }, ...s.slice(11)], { ridge: 4, off: [] }, PRIOR);
    expect(a.probs[10]).toBeCloseTo(b.probs[10], 12);
  });
  it("keeps the current config while samples are few", () => {
    const r = tune(mkSamples(6), PRIOR, DEFAULT_CONFIG, "2026-11-01");
    expect(r.report.changed).toBe(false);
    expect(r.config).toEqual(DEFAULT_CONFIG);
  });
  it("finds a better config with enough samples and reports group contributions", () => {
    const s = mkSamples(60);
    const r = tune(s, PRIOR, DEFAULT_CONFIG, "2026-11-01");
    expect(r.report.chosen.logloss).toBeLessThanOrEqual(r.report.current.logloss);
    expect(r.report.candidates.length).toBeGreaterThan(3);
    const mom = r.report.groups.find((g) => g.group === "momentum")!;
    expect(mom.delta).toBeGreaterThan(0); // 勢いは役に立っている
    expect(r.report.features.find((f) => f.feature === "momentum")!.hitRate!).toBeGreaterThan(0.7);
    if (r.report.changed) expect(r.config.since).toBe("2026-11-01");
    const t = thresholdStats(s, s.map(() => 0.6), 0.55);
    expect(t.calls).toBe(60);
  });
});
