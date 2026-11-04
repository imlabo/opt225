import { describe, expect, it } from "vitest";
import { composeMail, detect, levelsFrom, parseIntraday, type IBar, type Levels } from "../src/alerts";

const mk = (n: number, base = 64000): IBar[] => Array.from({ length: n }, (_, i) => ({ t: 1_700_000_000 + i * 300, open: base, high: base + 40, low: base - 40, close: base + (i % 2 ? 10 : -10), volume: 1000 }));
const lv: Levels = { tradeDate: "2026-11-02", basis: 200, putBreakeven: 61506, callBreakeven: 65981, putLevel: 61706, callLevel: 66181 };

describe("alerts", () => {
  it("parses intraday bars with volume", () => {
    const j = { chart: { result: [{ timestamp: [1, 2], indicators: { quote: [{ open: [1, 2], high: [2, 3], low: [0.5, 1], close: [1.5, 2.5], volume: [10, null] }] } }] } };
    const b = parseIntraday(j);
    expect(b.length).toBe(2); expect(b[0].volume).toBe(10); expect(b[1].volume).toBe(0);
  });
  it("converts breakevens to futures levels", () => {
    const l = levelsFrom({ tradeDate: "d", spot: 63000, fut: { month: "202612", price: 63200 }, seller: { putBreakeven: 61506, callBreakeven: 65981 } } as never)!;
    expect(l.putLevel).toBe(61706); expect(l.basis).toBe(200);
  });
  it("flags a high-volume wide down bar near the put sellers' breakeven as a bottom candidate", () => {
    const bars = mk(30, 62100);
    const climax: IBar = { t: bars[28].t + 300, open: 62100, high: 62110, low: 61650, close: 61700, volume: 3000 }; // 値幅 460 = 平均 80 の 5.7 倍、出来高 3 倍
    bars[29] = climax;
    const now = (climax.t + 300 + 60) * 1000; // クライマックス足の確定直後
    const d = detect("5m", "5分足", bars, lv, now);
    expect(d.signal?.side).toBe("bottom");
    expect(d.signal?.inProgress).toBe(false);
    expect(d.signal?.crossed).toBe(true);
    expect(d.signal?.volRatio).toBeCloseTo(3, 6);
    const m = composeMail([d.signal!], lv, "https://x");
    expect(m.subject).toContain("大底候補");
    expect(m.text).toContain("61,706");
    // 損益分岐から遠ければ出さない
    expect(detect("5m", "5分足", mk(30, 64000).map((b, i) => (i === 29 ? { ...b, open: 64100, high: 64110, low: 63650, close: 63700, volume: 3000 } : b)), lv, now).signal).toBeNull();
  });
  it("fires early on an in-progress bar and ignores stale bars", () => {
    const bars = mk(30, 62100);
    const t = bars[29].t;
    // 進行中(2分経過 = 40%)で出来高 1,500(按分後 3.75倍)、値幅 460
    bars[29] = { t, open: 62100, high: 62110, low: 61650, close: 61700, volume: 1500 };
    const d = detect("5m", "5分足", bars, lv, (t + 120) * 1000);
    expect(d.signal?.side).toBe("bottom");
    expect(d.signal?.inProgress).toBe(true);
    expect(d.signal?.elapsed).toBeCloseTo(0.4, 6);
    // 経過 30% 未満は判定しない
    expect(detect("5m", "5分足", bars, lv, (t + 30) * 1000).signal).toBeNull();
    // 最後の足が 2 本分より古ければ判定しない(出来高未反映など)
    expect(detect("5m", "5分足", bars, lv, (t + 15 * 60) * 1000).signal).toBeNull();
    const m = composeMail([d.signal!], lv, "https://x");
    expect(m.subject).toContain("速報");
  });
  it("flags a high-volume up bar near the call sellers' breakeven as a top candidate", () => {
    const bars = mk(30, 65800);
    bars[29] = { t: bars[28].t + 300, open: 65800, high: 66250, low: 65790, close: 66200, volume: 2500 };
    const d = detect("15m", "15分足", bars, lv, (bars[29].t + 15 * 60 + 5) * 1000);
    expect(d.signal?.side).toBe("top");
  });
});

describe("far OTM", () => {
  it("picks 7%/10% OTM strikes and flags doubling / halving", async () => {
    const { farQuotes, farSignals } = await import("../src/alerts");
    const rows = [57000, 58000, 59000, 60000, 64000, 68000, 69000, 70000].map((k) => ({ month: "202611", strike: k, putPx: k < 64000 ? 20 : undefined, callPx: k > 64000 ? 30 : undefined, putOi: 100, callOi: 100 }));
    const prev = rows.map((r) => ({ ...r, putPx: r.putPx && 5, callPx: r.callPx && 60 }));
    const q = farQuotes(rows, prev, 64000);
    expect(q.map((x) => `${x.side}${x.strike}`)).toEqual(["put59500".replace("59500", "60000"), "call68000", "put58000", "call70000"].map((s) => s)); // 7%下=59,520→60,000、7%上=68,480→68,000、10%下=57,600→58,000、10%上=70,400→70,000
    const sig = farSignals(q);
    expect(sig.filter((x) => x.side === "put").every((x) => x.ratio === 4)).toBe(true);
    expect(sig.filter((x) => x.side === "call").every((x) => x.ratio === 0.5)).toBe(true);
  });
});
