import type { Analysis } from "./analysis";
import type { DailyAnalysis } from "./daily";
import type { Prediction } from "./model";

/** RFC3986 percent-encode (OAuth 1.0a) */
export const pct = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

async function hmacSha1(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return btoa(String.fromCharCode(...sig));
}

export interface OAuthCreds {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

export async function oauthHeader(
  method: string,
  url: string,
  creds: OAuthCreds,
  extraParams: Record<string, string> = {},
  nonce = crypto.randomUUID().replace(/-/g, ""),
  timestamp = Math.floor(Date.now() / 1000).toString(),
): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const all = { ...extraParams, ...oauth };
  const paramStr = Object.keys(all)
    .sort()
    .map((k) => `${pct(k)}=${pct(all[k])}`)
    .join("&");
  const base = `${method.toUpperCase()}&${pct(url)}&${pct(paramStr)}`;
  const signature = await hmacSha1(`${pct(creds.apiSecret)}&${pct(creds.accessSecret)}`, base);
  const h = { ...oauth, oauth_signature: signature };
  return "OAuth " + Object.keys(h).sort().map((k) => `${pct(k)}="${pct(h[k as keyof typeof h])}"`).join(", ");
}

/** X v2 POST /2/tweets (JSON ボディは署名対象外) */
export async function postTweet(text: string, creds: OAuthCreds): Promise<string> {
  const url = "https://api.x.com/2/tweets";
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: await oauthHeader("POST", url, creds), "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`X API ${res.status}: ${body.slice(0, 300)}`);
  return (JSON.parse(body) as { data: { id: string } }).data.id;
}

/** X の重み付き文字数(CJK等=2, URL=23)。上限 280。 */
export function weightedLength(text: string): number {
  let n = 0;
  const urlRe = /https?:\/\/\S+/g;
  const stripped = text.replace(urlRe, () => {
    n += 23;
    return "";
  });
  for (const ch of stripped) {
    const cp = ch.codePointAt(0)!;
    const light =
      (cp >= 0 && cp <= 0x10ff) || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

const sign = (n: number) => (n > 0 ? "+" : "") + n.toLocaleString("ja-JP");

export function composeTweet(a: Analysis, siteUrl: string): string {
  const ind = a.investors.find((i) => i.investor === "individual")!;
  const corp = a.investors.find((i) => i.investor === "corporate")!;
  const lines = [
    `【日経225OP 部門別フロー ${a.weekEnd.slice(5).replace("-", "/")}週】`,
    `先物見通し: ${a.bias}(${a.score > 0 ? "+" : ""}${a.score})`,
    `個人 C${sign(ind.netCall)} P${sign(ind.netPut)}`,
    `法人 C${sign(corp.netCall)} P${sign(corp.netPut)}`,
    `ボラ: ${a.volSignal}`,
    "※機械的推計・投資助言ではありません",
    "#日経平均 #日経225オプション",
    siteUrl,
  ];
  let text = lines.join("\n");
  // 念のため上限超過時はハッシュタグから削る
  if (weightedLength(text) > 280) text = lines.filter((l) => !l.startsWith("#")).join("\n");
  return text;
}

const yen = (n: number) => Math.round(n).toLocaleString("ja-JP");

export interface LastResult { tradeDate: string; call: "up" | "down" | "flat"; up: boolean; change: number }

export function composeDailyTweet(a: DailyAnalysis, siteUrl: string, p?: Prediction, last?: LastResult, fg?: { nikkei?: number | null; cnn?: number | null }): string {
  const callLabel = (c: string) => (c === "up" ? "上昇" : c === "down" ? "下落" : "中立");
  const m = `${Number(a.front.month.slice(4))}月限`;
  const lines = [
    `【日経225OP 日次 ${a.tradeDate.slice(5).replace("-", "/")}】`,
    `日経平均 ${yen(a.spot)}${a.fut ? ` / 先物${Number(a.fut.month.slice(4))}月 ${yen(a.fut.price)}` : ""}`,
    `${m}(SQまで${a.front.days}日)`,
    a.putWall && a.callWall ? `建玉の壁 下${yen(a.putWall.strike)} / 上${yen(a.callWall.strike)}` : "",
    a.maxPain ? `最大苦痛 ${yen(a.maxPain)} / P/C比 ${a.pcr.toFixed(2)}` : `P/C比 ${a.pcr.toFixed(2)}`,
    fg && (fg.nikkei != null || fg.cnn != null) ? `F&G 日経${fg.nikkei != null ? Math.round(fg.nikkei) : "—"} / 米国${fg.cnn != null ? Math.round(fg.cnn) : "—"}` : "",
    p ? `翌営業日: ${callLabel(p.call)}(上昇確率${Math.round(p.pUp * 100)}%) ${yen(p.rangeLo)}〜${yen(p.rangeHi)}` : "",
    last && last.call !== "flat" ? `前回予測: ${callLabel(last.call)}→${last.up ? "上昇" : "下落"}${(last.call === "up") === last.up ? "◯" : "×"}` : "",
    "※機械的推計・投資助言ではありません",
    "#日経225オプション",
    siteUrl,
  ].filter(Boolean);
  let text = lines.join("\n");
  if (weightedLength(text) > 280) text = lines.filter((l) => !l.startsWith("#")).join("\n");
  return text;
}
