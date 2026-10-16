import { describe, expect, it } from "vitest";
import { analyze } from "../src/analysis";
import { extractExcelLinks, parseRows, weekFromFileName } from "../src/jpx";
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

describe("JPX parser", () => {
  it("parses single-row layout", () => {
    const rows = [
      ["日経225先物"], ["区分", "売り", "買い"], ["個人", 1000, 1200], ["法人", 500, 400],
      ["日経225mini"], ["個人", 99999, 1],
      ["日経225オプション プット"], ["区分", "売り", "買い"], ["自己計", 9, 9], ["法人", 3000, 3500], ["個人", "12,000", "10,000"], ["海外投資家", 50000, 52000],
      ["日経225オプション コール"], ["個人", 8000, 9000], ["法人", 2000, 1500],
      ["TOPIX先物"], ["個人", 7, 7],
    ];
    const r = parseRows(rows);
    const get = (p: string, i: string) => r.find((x) => x.product === p && x.investor === i);
    expect(get("fut", "individual")).toMatchObject({ sell: 1000, buy: 1200 });
    expect(get("put", "individual")).toMatchObject({ sell: 12000, buy: 10000 });
    expect(get("put", "corporate")).toMatchObject({ sell: 3000, buy: 3500 });
    expect(get("call", "individual")).toMatchObject({ sell: 8000, buy: 9000 });
    expect(get("call", "corporate")).toMatchObject({ sell: 2000, buy: 1500 });
    expect(get("put", "proprietary")).toMatchObject({ sell: 9, buy: 9 });
    expect(r.length).toBe(8);
  });
  it("parses two-row layout", () => {
    const rows = [["日経225オプション"], ["プット"], ["個人", "売り", 100], ["", "買い", 80], ["コール"], ["個人", "売り", 50], ["", "買い", 70]];
    const r = parseRows(rows);
    expect(r).toContainEqual({ product: "put", investor: "individual", sell: 100, buy: 80 });
    expect(r).toContainEqual({ product: "call", investor: "individual", sell: 50, buy: 70 });
  });
  it("extracts links and weeks", () => {
    const html = `<a href="/x/abc-att/Tousi_DV_W_202609_4_0921_0925.xls">a</a><a href="/x/def-att/Tousi_DV_W_202610_1_0928_1002.xls">b</a><a href="/y.pdf">c</a>`;
    const links = extractExcelLinks(html, "https://www.jpx.co.jp/markets/statistics-derivatives/sector/index.html");
    expect(links[0]).toBe("https://www.jpx.co.jp/x/def-att/Tousi_DV_W_202610_1_0928_1002.xls");
    expect(weekFromFileName(links[0])).toEqual({ weekStart: "2026-09-28", weekEnd: "2026-10-02" });
    expect(weekFromFileName("Tousi_DV_W_202612_5_1228_0101.xls")).toEqual({ weekStart: "2026-12-28", weekEnd: "2027-01-01" });
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
