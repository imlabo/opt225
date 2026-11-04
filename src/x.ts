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
  const callLabel = (c: string) => (c === "up" ? "買い" : c === "down" ? "売り" : "様子見");
  const m = `${Number(a.front.month.slice(4))}月限`;
  const lines = [
    `【日経225OP 日次 ${a.tradeDate.slice(5).replace("-", "/")}】`,
    `日経平均 ${yen(a.spot)}${a.fut ? ` / 先物${Number(a.fut.month.slice(4))}月 ${yen(a.fut.price)}` : ""}`,
    `${m}(SQまで${a.front.days}日)`,
    a.putWall && a.callWall ? `建玉の壁 下${yen(a.putWall.strike)} / 上${yen(a.callWall.strike)}` : "",
    a.maxPain ? `最大苦痛 ${yen(a.maxPain)} / P/C比 ${a.pcr.toFixed(2)}` : `P/C比 ${a.pcr.toFixed(2)}`,
    fg && (fg.nikkei != null || fg.cnn != null) ? `F&G 日経${fg.nikkei != null ? Math.round(fg.nikkei) : "—"} / 米国${fg.cnn != null ? Math.round(fg.cnn) : "—"}` : "",
    a.squeeze ? `踏み上げ恐怖 P${Math.round(a.squeeze.put.index)} / C${Math.round(a.squeeze.call.index)}${a.greeks ? ` / 売り手ヘッジ ${a.greeks.hedge >= 0 ? "買" : "売"}${yen(Math.abs(a.greeks.hedge))}枚` : ""}` : "",
    p ? `総合判断: ${callLabel(p.call)}(上昇確率${Math.round(p.pUp * 100)}%) ${yen(p.rangeLo)}〜${yen(p.rangeHi)}` : "",
    last && last.call !== "flat" ? `前回: ${callLabel(last.call)}→${last.up ? "上昇" : "下落"}${(last.call === "up") === last.up ? "◯" : "×"}` : "",
    "※機械的推計・投資助言ではありません",
    "#日経225オプション",
    siteUrl,
  ].filter(Boolean);
  let text = lines.join("\n");
  if (weightedLength(text) > 280) text = lines.filter((l) => !l.startsWith("#")).join("\n");
  return text;
}

/** 天井・大底候補アラートの投稿文 */
export function composeAlertTweet(sig: { tf: string; label: string; side: "bottom" | "top"; bar: { t: number; close: number; volume: number }; volRatio: number; level: number; crossed: boolean; distPct: number; inProgress: boolean }[], siteUrl: string): string {
  const s0 = sig[0];
  const jst = (t: number) => { const d = new Date(t * 1000 + 9 * 3600 * 1000); return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`; };
  const lines = [
    `【${s0.side === "bottom" ? "大底候補" : "天井候補"}${s0.inProgress ? "(速報)" : ""}】${jst(s0.bar.t)} ${sig.map((x) => x.label).join("・")}`,
    `日経225先物 ${yen(s0.bar.close)} 出来高${s0.volRatio.toFixed(1)}倍の${s0.side === "bottom" ? "下落" : "上昇"}`,
    `${s0.side === "bottom" ? "プット" : "コール"}売り手の損益分岐 ${yen(s0.level)}${s0.crossed ? "をまたぐ" : `まで${(s0.distPct * 100).toFixed(1)}%`}`,
    "※機械的検出・投資助言ではありません",
    "#日経225先物",
    siteUrl,
  ];
  let text = lines.join("\n");
  if (weightedLength(text) > 280) text = lines.filter((l) => !l.startsWith("#")).join("\n");
  return text;
}

/** ファーOTM 急騰・急落の投稿文 */
export function composeFarTweet(sig: { side: "put" | "call"; pct: number; strike: number; px: number; prevPx: number | null; ratio: number | null }[], tradeDate: string, siteUrl: string): string {
  const lines = [
    `【ファーOTM ${sig.some((x) => x.ratio! >= 1) ? "急騰" : "急落"} ${tradeDate.slice(5).replace("-", "/")}】`,
    ...sig.slice(0, 3).map((x) => `${x.side === "put" ? "P" : "C"}${yen(x.strike)}(${Math.round(x.pct * 100)}%${x.side === "put" ? "下" : "上"}) ${yen(x.prevPx!)}→${yen(x.px)}円 ${x.ratio!.toFixed(1)}倍`),
    "※JPX清算値段・投資助言ではありません",
    "#日経225オプション",
    siteUrl,
  ];
  let text = lines.join("\n");
  if (weightedLength(text) > 280) text = lines.filter((l) => !l.startsWith("#")).join("\n");
  return text;
}
