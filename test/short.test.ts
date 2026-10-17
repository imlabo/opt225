import { describe, expect, it } from "vitest";
import { shortEstimate } from "../src/analysis";
import { sellerPnl } from "../src/daily";
import type { WeekData } from "../src/types";

describe("short position estimates", () => {
  it("accumulates weekly net sells by investor over the last 4 weeks", () => {
    const wk = (i: number, putSell: number, putBuy: number): WeekData => ({
      weekStart: `2026-09-0${i}`, weekEnd: `2026-09-0${i + 4}`,
      flows: [
        { product: "put", investor: "individual", sell: putSell, buy: putBuy, sellValue: putSell * 1e5, buyValue: putBuy * 1e5 },
        { product: "call", investor: "individual", sell: 100, buy: 150, sellValue: 1e7, buyValue: 1.5e7 },
      ],
    });
    const h = [wk(1, 9999, 0), wk(2, 300, 100), wk(3, 300, 100), wk(4, 300, 100), wk(5, 500, 100)];
    const s = shortEstimate(h, "individual");
    expect(s).toMatchObject({ putSell: 500, putBuy: 100, estPutShort: 200 * 3 + 400, estCallShort: -200 }); // 1週目は窓外
    expect(s.putPremiumNet).toBe((200 * 3 + 400) * 1e5);
  });

  it("computes seller P/L at expiry and breakevens", () => {
    // プット 10枚@60000 プレミアム100、コール 5枚@70000 プレミアム200
    const s = sellerPnl([
      { month: "202611", strike: 60000, putOi: 10, putPx: 100 },
      { month: "202611", strike: 70000, callOi: 5, callPx: 200 },
    ], 65000)!;
    expect(s.putPremium).toBe(10 * 100 * 1000);
    expect(s.callPremium).toBe(5 * 200 * 1000);
    expect(s.putBreakeven).toBeCloseTo(59900, 0); // 60000 − 100
    expect(s.callBreakeven).toBeCloseTo(70200, 0); // 70000 + 200
    expect(s.putAtDown10).toBe(10 * 1000 * (100 - (60000 - 58500)));
  });
});
