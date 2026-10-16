import * as XLSX from "xlsx";
import type { FlowRow, Investor, Product, WeekData } from "./types";

/**
 * JPX「投資部門別取引状況(先物・オプション/週間)」の取得・解析。
 *
 * JPX はレイアウトを予告なく変えることがあるため、セル位置ではなく
 * 「商品見出し」「部門ラベル」「売り/買い」の文字列を手掛かりに解析する。
 * 解析できなかった場合は /admin/ingest に JSON を手動投入できる。
 */

const UA = "Mozilla/5.0 (compatible; opt225/1.0)";

export async function discoverLatestFiles(indexUrl: string): Promise<string[]> {
  const res = await fetch(indexUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`JPX index HTTP ${res.status}`);
  return extractWeeklyLinks(await res.text(), indexUrl);
}

/**
 * 週次「投資部門別取引状況」ファイルのリンクを新しい順に返す。
 *   現行: Tousi_DV_W_20261005_20261009.csv
 *   旧  : Tousi_DV_W_202610_1_1005_1009.xls
 * PDF 版 (Tousi_DV_pdf_W_...) と建玉表 (Tategyoku_W_...) は対象外。
 */
export function extractWeeklyLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  for (const m of html.matchAll(/href="([^"]*Tousi_DV_W_[^"]+\.(?:csv|xlsx?))"/gi)) links.add(new URL(m[1], baseUrl).toString());
  const key = (u: string) => weekFromFileName(u)?.weekEnd ?? "";
  // 同じ週に CSV と Excel がある場合は CSV を優先
  return [...links].sort((a, b) => key(b).localeCompare(key(a)) || (b.endsWith(".csv") ? 1 : 0) - (a.endsWith(".csv") ? 1 : 0));
}

/** ファイル名から週の開始・終了日を推定 */
export function weekFromFileName(url: string): { weekStart: string; weekEnd: string } | null {
  const d8 = url.match(/_(\d{4})(\d{2})(\d{2})_(\d{4})(\d{2})(\d{2})\.\w+$/);
  if (d8) return { weekStart: `${d8[1]}-${d8[2]}-${d8[3]}`, weekEnd: `${d8[4]}-${d8[5]}-${d8[6]}` };
  const m = url.match(/(\d{4})(\d{2})_\d_(\d{2})(\d{2})_(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, , sm, sd, em, ed] = m;
  const year = Number(y);
  const endYear = Number(em) < Number(sm) ? year + 1 : year;
  return { weekStart: `${year}-${sm}-${sd}`, weekEnd: `${endYear}-${em}-${ed}` };
}

/** JPX の CSV は Shift_JIS のことが多い。UTF-8 として不正なら Shift_JIS で読む */
export function decodeJpx(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseWeeklyCsv(text: string): FlowRow[] {
  return parseRows(parseCsv(text));
}

const INVESTOR_PATTERNS: [RegExp, Investor][] = [
  [/^個\s*人/, "individual"],
  [/^法\s*人/, "corporate"],
  [/^海外投資家|^海\s*外/, "foreign"],
  [/^証券会社/, "securities"],
  [/^自\s*己\s*計?/, "proprietary"],
];

function detectProduct(text: string, current: Product | null): Product | null {
  const t = text.replace(/\s|　/g, "");
  if (/日経225|日経２２５|Nikkei225/i.test(t)) {
    if (/プット|Put/i.test(t)) return "put";
    if (/コール|Call/i.test(t)) return "call";
    if (/オプション|Options?/i.test(t)) return current === "put" || current === "call" ? current : "put";
    // ミニ・マイクロは除外し、ラージ先物のみ
    if (/先物|Futures?/i.test(t) && !/mini|ミニ|マイクロ|micro/i.test(t)) return "fut";
    return null;
  }
  if (current === "put" || current === "call") {
    if (/^プット|^Puts?$/i.test(t)) return "put";
    if (/^コール|^Calls?$/i.test(t)) return "call";
  }
  // 日経225 以外の商品見出しが出たらセクション終了
  if (/(TOPIX|JPX|マザーズ|グロース|ダウ|VI|REIT|先物|オプション)/i.test(t) && t.length < 40) return null;
  return current;
}

const toNum = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const s = v.replace(/[,，\s]/g, "");
    if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  }
  return null;
};

/**
 * シート上の行(セル配列)から日経225オプション(プット/コール)と日経225先物の部門別売買を抽出。
 * 対応レイアウト:
 *   (a) [部門, 売り, 買い, ...] が1行
 *   (b) [部門, "売り", 数量, ...] / ["", "買い", 数量, ...] の2行
 */
export function parseRows(rows: unknown[][]): FlowRow[] {
  const out = new Map<string, FlowRow>();
  let product: Product | null = null;

  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((c) => (c == null ? "" : c));
    const texts = cells.filter((c) => typeof c === "string" && c.trim()) as string[];

    // 見出し判定(数値の無い行 or 先頭セル)
    const nums = cells.map(toNum).filter((n): n is number => n !== null);
    for (const t of texts) {
      const next = detectProduct(t, product);
      if (next !== product && (nums.length === 0 || /日経|プット|コール/.test(t))) product = next;
    }
    if (!product) continue;

    const labelIdx = cells.findIndex((c) => typeof c === "string" && INVESTOR_PATTERNS.some(([re]) => re.test(c.trim())));
    if (labelIdx < 0) continue;
    const label = String(cells[labelIdx]).trim();
    const investor = INVESTOR_PATTERNS.find(([re]) => re.test(label))![1];
    const key = `${product}:${investor}`;
    if (out.has(key)) continue; // 最初に出現したもの(=数量)を採用

    const after = cells.slice(labelIdx + 1);
    const hasSellBuyWords = after.some((c) => typeof c === "string" && /売り?|買い?/.test(c));
    if (hasSellBuyWords) {
      // (b) 2行形式
      const pick = (r: unknown[], word: RegExp) => {
        const j = r.findIndex((c) => typeof c === "string" && word.test(c));
        if (j < 0) return null;
        return r.slice(j + 1).map(toNum).find((n) => n !== null) ?? null;
      };
      const sell = pick(cells, /^売/) ?? pick(rows[i + 1] ?? [], /^売/);
      const buy = pick(cells, /^買/) ?? pick(rows[i + 1] ?? [], /^買/);
      if (sell !== null && buy !== null) out.set(key, { product, investor, sell, buy });
    } else {
      const v = after.map(toNum).filter((n): n is number => n !== null);
      if (v.length >= 2) out.set(key, { product, investor, sell: v[0], buy: v[1] });
    }
  }
  return [...out.values()];
}

export function parseWorkbook(buf: ArrayBuffer): FlowRow[] {
  const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
  const rows: unknown[][] = [];
  for (const name of wb.SheetNames) {
    rows.push(...(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "" }) as unknown[][]));
  }
  return parseRows(rows);
}

export async function fetchWeek(url: string): Promise<WeekData> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`JPX file HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const flows = /\.csv$/i.test(url) ? parseWeeklyCsv(decodeJpx(buf)) : parseWorkbook(buf);
  const wk = weekFromFileName(url);
  if (!wk) throw new Error(`cannot infer week from file name: ${url}`);
  const opt = flows.filter((f) => f.product !== "fut");
  if (!opt.some((f) => f.investor === "individual") || !opt.some((f) => f.investor === "corporate")) {
    throw new Error(`parse failed: individual/corporate option rows not found (${flows.length} rows parsed)`);
  }
  return { ...wk, sourceUrl: url, flows };
}
