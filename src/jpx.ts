import type { FlowRow, Investor, Product, WeekData } from "./types";

/**
 * JPX「投資部門別取引状況(先物・オプション/週間)」CSV の取得・解析。
 *
 * ファイル: Tousi_DV_W_YYYYMMDD_YYYYMMDD.csv (Shift_JIS の場合あり)
 * 列: 帳票種別, サイクル区分, 年月週, 報告年月日(自), 報告年月日(至), 投資部門コード,
 *     数量金額区分(1=数量, 2=金額), 売, 売-差引, 買, 買-差引, 合計
 *
 * コードは同週の PDF 版(Tousi_DV_pdf_W_...)と突合して確認済み (2026-10-05〜09 週)。
 */

/** 帳票種別 → 商品 */
export const PRODUCT_CODES: Record<string, Product> = {
  "301": "fut", // 日経225先物(ラージ)
  "303": "put", // 日経225オプション プット
  "304": "call", // 日経225オプション コール
};

/** 投資部門コード → 部門。法人は内訳(金融機関・投信・事業法人・その他法人)の合計 */
export const INVESTOR_CODES: Record<string, Investor> = {
  "11": "proprietary", // 自己
  "21": "corporate", // 生保・損保
  "22": "corporate", // 都銀・地銀等
  "23": "corporate", // 信託銀行
  "24": "corporate", // その他金融機関
  "31": "corporate", // 投資信託
  "32": "corporate", // 事業法人
  "33": "corporate", // その他法人
  "41": "securities", // 証券会社
  "51": "individual", // 個人
  "60": "foreign", // 海外投資家
};

const UA = "Mozilla/5.0 (compatible; opt225/1.0)";

export async function discoverLatestFiles(indexUrl: string): Promise<string[]> {
  const res = await fetch(indexUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`JPX index HTTP ${res.status}`);
  return extractWeeklyLinks(await res.text(), indexUrl);
}

/** 週次 CSV のリンクを新しい順に返す(PDF 版や建玉表は対象外) */
export function extractWeeklyLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  for (const m of html.matchAll(/href="([^"]*Tousi_DV_W_\d{8}_\d{8}\.csv)"/gi)) links.add(new URL(m[1], baseUrl).toString());
  const key = (u: string) => weekFromFileName(u)?.weekEnd ?? "";
  return [...links].sort((a, b) => key(b).localeCompare(key(a)));
}

export function weekFromFileName(url: string): { weekStart: string; weekEnd: string } | null {
  const m = url.match(/_(\d{4})(\d{2})(\d{2})_(\d{4})(\d{2})(\d{2})\.\w+$/);
  return m ? { weekStart: `${m[1]}-${m[2]}-${m[3]}`, weekEnd: `${m[4]}-${m[5]}-${m[6]}` } : null;
}

/** UTF-8 として不正なら Shift_JIS で読む */
export function decodeJpx(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf);
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

const ymd = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

export function parseWeeklyCsv(text: string): { weekStart: string; weekEnd: string; flows: FlowRow[] } {
  const acc = new Map<string, FlowRow>();
  let weekStart = "", weekEnd = "";
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
    if (c.length < 12 || !/^\d+$/.test(c[0])) continue; // ヘッダー・空行
    const product = PRODUCT_CODES[c[0]];
    const investor = INVESTOR_CODES[c[5]];
    if (!product || !investor) continue;
    weekStart ||= ymd(c[3]);
    weekEnd ||= ymd(c[4]);
    const key = `${product}:${investor}`;
    const row = acc.get(key) ?? { product, investor, sell: 0, buy: 0, sellValue: 0, buyValue: 0 };
    const sell = Number(c[7]), buy = Number(c[9]);
    if (c[6] === "1") { row.sell += sell; row.buy += buy; }
    else if (c[6] === "2") { row.sellValue! += sell; row.buyValue! += buy; }
    acc.set(key, row);
  }
  return { weekStart, weekEnd, flows: [...acc.values()] };
}

export async function fetchWeek(url: string): Promise<WeekData> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`JPX file HTTP ${res.status}`);
  const parsed = parseWeeklyCsv(decodeJpx(await res.arrayBuffer()));
  const fromName = weekFromFileName(url);
  const weekStart = parsed.weekStart || fromName?.weekStart;
  const weekEnd = parsed.weekEnd || fromName?.weekEnd;
  if (!weekStart || !weekEnd) throw new Error(`cannot infer week: ${url}`);
  const opt = parsed.flows.filter((f) => f.product !== "fut");
  if (!opt.some((f) => f.investor === "individual") || !opt.some((f) => f.investor === "corporate")) {
    throw new Error(`parse failed: Nikkei 225 option rows not found (${parsed.flows.length} rows) — CSV layout may have changed`);
  }
  return { weekStart, weekEnd, sourceUrl: url, flows: parsed.flows };
}
