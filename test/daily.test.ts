import { describe, expect, it } from "vitest";
import { analyzeDaily, computeMaxPain, type DailyInput } from "../src/daily";
import { buildDailyInput, findLink, OI_RE, parseOiRows, parseSettlementCsv, RB_RE } from "../src/jpx-daily";
import { composeDailyTweet, weightedLength } from "../src/x";

// 2026-10-16 の実ファイルの書式を再現した抜粋
const OI_ROWS = [
  ["JPX デリバティブ建玉残高状況（別紙1）"], [46311], [],
  ["＜日経225オプション（プット）＞", "", "", "", "", "", "＜日経225オプション（コール）＞"],
  ["限月取引", "取引高", "当日\r\n建玉残高", "前日比", "前日\r\n建玉残高", "", "限月取引", "取引高", "当日\r\n建玉残高", "前日比", "前日\r\n建玉残高"],
  ["NIKKEI 225 P2611-60000", 300, 8927, 120, 8807, "", "NIKKEI 225 C2611-65000", 900, 1500, 40, 1460],
  ["NIKKEI 225 P2611-65000", 800, 3000, 814, 2186, "", "NIKKEI 225 C2611-69000", 400, 4015, 100, 3915],
  ["NIKKEI 225 P2611-66000", 10, 500, 0, 500, "", "限月合計", 1300, 5515, 140, 5375],
  ["限月合計", 1110, 12427, 934, 11493, "", "NIKKEI 225 C2612-70000", 5, 2000, 0, 2000],
  ["NIKKEI 225 P2612-55000", 2, 2321, 1, 2320],
];
const RB = [
  "＊ 指数先物、国債先物、指数オプション…,,,,,,,,,,,",
  "銘柄コード,銘柄名称,PUT/CAL,限月,権利行使価格,清算価格,理論価格,原資産価格,ボラティリティ,金利,残日数,原資産名称",
  "161120018,FUT_225_261210,,202612,,65520,65520,65324.29,,1.3963,56,日経225",
  "131230018,PUT_225_261112_60000,PUT,202611,60000,600,592,65324.29,34.5215,1.3963,28,日経225",
  "131235018,PUT_225_261112_65000,PUT,202611,65000,1805,1825,65324.29,27.7402,1.3963,28,日経225",
  "141235018,CAL_225_261112_65000,CAL,202611,65000,2355,2355,65324.29,29.9177,1.3963,28,日経225",
  "141350018,CAL_225_261112_69000,CAL,202611,69000,700,690,65324.29,26.9383,1.3963,28,日経225",
  "999999999,PUT_225M_261023_65000,PUT,20261023,65000,500,500,65324.29,25,1.3963,7,日経225",
  "151350018,CAL_225_261211_70000,CAL,202612,70000,900,900,65324.29,25.5,1.3963,56,日経225",
].join("\r\n");

describe("JPX daily parsers", () => {
  it("parses OI sheet (put/call columns independent) and date", () => {
    const r = parseOiRows(OI_ROWS);
    expect(r.date).toBe("2026-10-16");
    expect(r.put).toContainEqual({ month: "202611", strike: 65000, vol: 800, oi: 3000, chg: 814 });
    expect(r.call).toContainEqual({ month: "202611", strike: 69000, vol: 400, oi: 4015, chg: 100 });
    expect(r.put).toHaveLength(4);
    expect(r.call).toHaveLength(3);
  });
  it("parses settlement CSV (excludes mini options)", () => {
    const r = parseSettlementCsv(RB);
    expect(r.spot).toBe(65324.29);
    expect(r.futures).toEqual([{ month: "202612", price: 65520, days: 56 }]);
    expect(r.options).toHaveLength(5);
    expect(r.options[0]).toEqual({ month: "202611", strike: 60000, type: "P", px: 600, iv: 34.5215, days: 28 });
  });
  it("finds daily file links", () => {
    const html = `<a href="/markets/derivatives/trading-volume/t13vrt0000026aes-att/20261016open_interest.xlsx">x</a><a href="/x/tvdivq00000014l6-att/rb20261016.csv">y</a>`;
    expect(findLink(html, "https://www.jpx.co.jp/", OI_RE)).toEqual({ url: "https://www.jpx.co.jp/markets/derivatives/trading-volume/t13vrt0000026aes-att/20261016open_interest.xlsx", date: "2026-10-16" });
    expect(findLink(html, "https://www.jpx.co.jp/", RB_RE)?.date).toBe("2026-10-16");
  });
});

describe("daily analysis", () => {
  const input = buildDailyInput("2026-10-16", parseOiRows(OI_ROWS), parseSettlementCsv(RB));
  it("merges OI and settlement by month/strike", () => {
    expect(input.months).toEqual([{ month: "202611", days: 28 }, { month: "202612", days: 56 }]);
    expect(input.strikes.find((s) => s.month === "202611" && s.strike === 65000)).toMatchObject({ putOi: 3000, callOi: 1500, putIv: 27.7402, callIv: 29.9177 });
  });
  it("computes walls, PCR, max pain, expected move", () => {
    const a = analyzeDaily(input);
    expect(a.front).toEqual({ month: "202611", days: 28 });
    expect(a.putWall).toEqual({ strike: 60000, oi: 8927 });
    expect(a.callWall).toEqual({ strike: 69000, oi: 4015 });
    expect(a.pcr).toBeCloseTo(12427 / 5515, 5);
    expect(a.atmStrike).toBe(65000);
    expect(a.atmIv).toBeCloseTo((27.7402 + 29.9177) / 2, 4);
    expect(a.expectedMove).toBeCloseTo(65324.29 * (a.atmIv! / 100) * Math.sqrt(28 / 365), 3);
    expect(a.topPutAdds[0]).toEqual({ strike: 65000, chg: 814 });
    const t = composeDailyTweet(a, "https://opt225.imlabosns.workers.dev");
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
  });
  it("max pain minimizes option holders' payout", () => {
    // 各候補 K で満期時に買い手へ支払う総額が最小になる行使価格
    expect(computeMaxPain([{ month: "x", strike: 100, callOi: 100 }, { month: "x", strike: 110, putOi: 10, callOi: 10 }, { month: "x", strike: 120, putOi: 100 }])).toBe(110);
  });
  it("rolls to next month within 3 days of SQ", () => {
    const d: DailyInput = { ...input, months: [{ month: "202611", days: 2 }, { month: "202612", days: 30 }] };
    expect(analyzeDaily(d).front.month).toBe("202612");
  });
});
