import { describe, expect, it } from "vitest";
import { analyze } from "../src/analysis";
import { decodeJpx, extractWeeklyLinks, parseWeeklyCsv, weekFromFileName } from "../src/jpx";
import { composeTweet, oauthHeader, weightedLength } from "../src/x";
import type { WeekData } from "../src/types";

describe("OAuth 1.0a", () => {
  it("matches X docs signature example", async () => {
    // https://developer.x.com/en/docs/authentication/oauth-1-0a/creating-a-signature
    const h = await oauthHeader(
      "POST",
      "https://api.twitter.com/1.1/statuses/update.json",
      { apiKey: "xvz1evFS4wEEPTGEFPHBog", apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
        accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE" },
      { include_entities: "true", status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      "1318622958",
    );
    expect(h).toContain(`oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"`);
  });
});

// 2026-10-05〜09 週の実データ抜粋(PDF 版と突合済み)
const CSV = `"帳票種別 Product type","サイクル区分 Cycle","年月週 Year, Month, Week","報告年月日（自）Period covered - from","報告年月日（至）Period covered - to","投資部門コード Type of Investor","数量金額区分 Volume/Value","売 Sales","売-差引 Balance","買 Purchases","買-差引 Balance","合計 Total"
"301","1","2026101","20261005","20261009","11","1",20654,-2,20652,0,41306
"301","1","2026101","20261005","20261009","51","1",12980,0,13892,912,26872
${[["11", 19229, 20494], ["21", 0, 0], ["22", 1127, 3000], ["23", 65, 40], ["24", 0, 0], ["31", 0, 50], ["32", 788, 1485], ["33", 223, 215], ["41", 330, 350], ["51", 21172, 18377], ["60", 123328, 123651]]
  .map(([k, s, b]) => `"303","1","2026101","20261005","20261009","${k}","1",${s},0,${b},0,${Number(s) + Number(b)}`).join("\n")}
"303","1","2026101","20261005","20261009","51","2",2257712750,-414614850,1843097900,0,4100810650
"304","1","2026101","20261005","20261009","51","1",18739,0,19403,664,38142
"332","1","2026101","20261005","20261009","51","1",41678,-6224,35454,0,77132
`;

describe("JPX parser", () => {
  it("parses weekly CSV by product / investor codes", () => {
    const r = parseWeeklyCsv(CSV);
    expect(r.weekStart).toBe("2026-10-05");
    expect(r.weekEnd).toBe("2026-10-09");
    const get = (p: string, i: string) => r.flows.find((x) => x.product === p && x.investor === i);
    // PDF: 日経225オプションプット 法人 売 2,203 / 買 4,790、個人 21,172 / 18,377、海外 123,328 / 123,651
    expect(get("put", "corporate")).toMatchObject({ sell: 2203, buy: 4790 });
    expect(get("put", "individual")).toMatchObject({ sell: 21172, buy: 18377, sellValue: 2257712750, buyValue: 1843097900 });
    expect(get("put", "foreign")).toMatchObject({ sell: 123328, buy: 123651 });
    expect(get("put", "proprietary")).toMatchObject({ sell: 19229, buy: 20494 });
    expect(get("call", "individual")).toMatchObject({ sell: 18739, buy: 19403 });
    expect(get("fut", "individual")).toMatchObject({ sell: 12980, buy: 13892 });
    expect(r.flows.length).toBe(8); // mini オプション(332)は除外
  });
  it("extracts weekly CSV links newest first", () => {
    const html = `<a href="a-att/Tousi_DV_pdf_W_20261005_20261009.pdf"></a><a href="a-att/Tousi_DV_W_20261005_20261009.csv"></a><a href="b-att/Tousi_DV_W_20260928_20261002.csv"></a><a href="c-att/Tategyoku_W_20260413_20260417.xlsx"></a>`;
    const links = extractWeeklyLinks(html, "https://www.jpx.co.jp/x/");
    expect(links).toEqual(["https://www.jpx.co.jp/x/a-att/Tousi_DV_W_20261005_20261009.csv", "https://www.jpx.co.jp/x/b-att/Tousi_DV_W_20260928_20261002.csv"]);
    expect(weekFromFileName(links[0])).toEqual({ weekStart: "2026-10-05", weekEnd: "2026-10-09" });
  });
  it("decodes Shift_JIS", () => {
    const sjis = new Uint8Array([0x93, 0xfa, 0x8c, 0x6f]); // "日経"
    expect(decodeJpx(sjis.buffer)).toBe("日経");
  });
});

describe("analysis & tweet", () => {
  const mk = (i: number, indTilt: number, corpTilt: number): WeekData => ({
    weekStart: `2026-01-${String(i + 1).padStart(2, "0")}`, weekEnd: `2026-01-${String(i + 5).padStart(2, "0")}`,
    flows: [
      { product: "call", investor: "individual", sell: 1000, buy: 1000 + indTilt },
      { product: "put", investor: "individual", sell: 1000 + indTilt, buy: 1000 },
      { product: "call", investor: "corporate", sell: 500, buy: 500 + corpTilt },
      { product: "put", investor: "corporate", sell: 500, buy: 500 },
    ],
  });
  it("retail euphoria → bearish, corporate bullish → bullish", () => {
    const base = Array.from({ length: 20 }, (_, i) => mk(i, (i % 3) * 10 - 10, (i % 2) * 10 - 5));
    const euphoria = analyze([...base, mk(20, 2000, 0), mk(21, 2000, 0)]);
    expect(euphoria.score).toBeLessThan(-15);
    const corp = analyze([...base, mk(20, 0, 1000), mk(21, 0, 1000)]);
    expect(corp.score).toBeGreaterThan(15);
    const t = composeTweet(euphoria, "https://example.com");
    expect(weightedLength(t)).toBeLessThanOrEqual(280);
    console.log(t, weightedLength(t));
  });
});
