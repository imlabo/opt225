import { describe, it, expect, afterEach } from "vitest";
import { outcome, collectAndResolve, fitJudgeModel, type Sample } from "../src/judge-learn";
import { judgeAt, setJudgeModel, judgeAdj } from "../src/technicals";

type B = { t: number; open: number; high: number; low: number; close: number; volume: number };
const flat = (n: number, px = 62000, t0 = 1_700_000_000): B[] => Array.from({ length: n }, (_, i) => ({ t: t0 + i * 300, open: px, high: px + 30, low: px - 30, close: px + (i % 2 ? 10 : -10), volume: 1000 }));

afterEach(() => setJudgeModel(null));

describe("outcome", () => {
  it("labels which way price moved one ATR first", () => {
    const b = flat(90);
    b[20] = { ...b[20], high: 62300 }; // 上へ 0.4% 以上
    expect(outcome(b, 10, "down", "5m", 62000, 100)).toBe("rev"); // 大底候補: 安値を割らずに +200 → 反転
    expect(outcome(b, 10, "up", "5m", 62000, 100)).toBe("con"); // 天井候補: 高値 62,030 を +100 以上更新 → 継続
    // 天井候補で、高値を少し更新してから下げた → 天井としては不正解(none)
    const c = flat(90); c[15] = { ...c[15], high: 62080 }; c[20] = { ...c[20], low: 61700 };
    expect(outcome(c, 10, "up", "5m", 62000, 100)).toBe("none");
    expect(outcome(flat(90), 10, "down", "5m", 62000, 100)).toBe("none");
    expect(outcome(flat(60), 10, "down", "5m", 62000, 100)).toBeNull(); // まだ 72 本たっていない
  });
});

describe("collect and resolve", () => {
  it("watches climax bars and grades them after the horizon", () => {
    const b = flat(170);
    b[50] = { ...b[50], open: 62000, high: 62010, low: 61400, close: 61450, volume: 6000 };
    for (let i = 51; i < 170; i++) b[i] = { ...b[i], open: 61500, high: 61900, low: 61480, close: 61850 };
    const now = (b[169].t + 600) * 1000;
    const r = collectAndResolve("5m", b, undefined, [], [], now);
    expect(r.added).toBeGreaterThanOrEqual(1);
    expect(r.resolved.find((s) => s.t === b[50].t)?.y).toBe("rev");
  });
});

describe("fit and adapt", () => {
  it("tightens alerts whose recent hit rate is poor and learns feature weights", () => {
    const mk = (i: number, kind: string, y: Sample["y"], x0: number): Sample => ({ tf: "5m", t: i * 300, dir: "down", kind, x: [x0, 0, 0, 0, 0, x0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], cap: 50, rev: 50, con: 50, close: 1, atr: 1, y, at: 0 });
    const samples: Sample[] = [];
    // 下ヒゲ・出来高が大きい足ほど反転する、というデータ
    for (let i = 0; i < 120; i++) samples.push(mk(i, "climax", i % 2 ? "rev" : "con", i % 2 ? 1 : -1));
    // 大底確認は 12 件中 3 件しか当たっていない、ブレイクは 10 件中 8 件
    for (let i = 0; i < 12; i++) samples.push(mk(1000 + i, "confirm-bottom", i < 3 ? "rev" : "con", 0));
    for (let i = 0; i < 10; i++) samples.push(mk(2000 + i, "break-down", i < 8 ? "con" : "rev", 0));
    const m = fitJudgeModel(samples);
    expect(m.adj.confirm).toBeGreaterThanOrEqual(20);
    expect(m.adj.break).toBe(0);
    expect(m.wRev[1]).toBeGreaterThan(0); // 出来高(log)が大きいほど反転
    setJudgeModel(m);
    expect(judgeAdj().confirm).toBe(m.adj.confirm);
    const bars = flat(60);
    const j = judgeAt(bars, 59, "5m", "down")!;
    expect(j.learned).toBeGreaterThan(0);
  });
});

describe("trend-aware gate", () => {
  it("does not call a top on the first climax of a fresh breakout in an uptrend", async () => {
    const { reversalOk } = await import("../src/technicals");
    // じり高の上昇トレンド → 高値更新の大陽線(高値引け)
    const bars: B[] = []; let px = 60000, t = 1_700_000_000;
    for (let i = 0; i < 200; i++) { const o = px; px += 8; bars.push({ t, open: o, high: px + 15, low: o - 15, close: px, volume: 1000 }); t += 300; }
    const o = px; bars.push({ t, open: o, high: o + 400, low: o - 5, close: o + 380, volume: 5000 });
    const j = judgeAt(bars, bars.length - 1, "5m", "up")!;
    expect(j.tech.newHigh).toBe(true);
    expect(j.tech.trend).toBeGreaterThan(1.5);
    expect(reversalOk(j).ok).toBe(false);
    expect(j.continuation).toBeGreaterThan(j.reversal);
    // 2 回目のクライマックスで長い上ヒゲ → 反転の決め手あり
    for (let i = 0; i < 6; i++) { const c = bars[bars.length - 1].close; t += 300; bars.push({ t, open: c, high: c + 20, low: c - 20, close: c + 5, volume: 1000 }); }
    const c = bars[bars.length - 1].close; t += 300;
    bars.push({ t, open: c, high: c + 500, low: c - 10, close: c + 60, volume: 6000 });
    const j2 = judgeAt(bars, bars.length - 1, "5m", "up")!;
    expect(j2.tech.priorUp).toBeGreaterThanOrEqual(1);
    expect(j2.reversal).toBeGreaterThan(j.reversal);
  });
});
