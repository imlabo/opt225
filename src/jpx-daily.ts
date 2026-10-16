/**
 * JPX 日次ファイルの取得・解析(GitHub Actions 上の Node で実行)。
 * Workers の CPU 制限(無料枠 10ms)では 4MB の CSV / 170KB の xlsx の解析が収まらないため、
 * ここで必要な行だけに絞った JSON を作り Worker の /admin/ingest-daily に送る。
 *
 *  建玉: https://www.jpx.co.jp/markets/derivatives/trading-volume/index.html
 *        → …-att/YYYYMMDDopen_interest.xlsx シート「別紙1」(日経225オプション プット/コール)
 *  清算: https://www.jpx.co.jp/markets/derivatives/settlement-price/index.html
 *        → …-att/rbYYYYMMDD.csv (Shift_JIS)
 */
import * as XLSX from "xlsx";
import type { DailyInput, DailyStrike } from "./daily";

export const OI_PAGE = "https://www.jpx.co.jp/markets/derivatives/trading-volume/index.html";
export const RB_PAGE = "https://www.jpx.co.jp/markets/derivatives/settlement-price/index.html";

export function findLink(html: string, base: string, re: RegExp): { url: string; date: string } | null {
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const d = m[1].match(re);
    if (d) return { url: new URL(m[1], base).toString(), date: `${d[1]}-${d[2]}-${d[3]}` };
  }
  return null;
}
export const OI_RE = /(\d{4})(\d{2})(\d{2})open_interest\.xlsx$/;
export const RB_RE = /rb(\d{4})(\d{2})(\d{2})\.csv$/;

const excelDate = (serial: number) => new Date(Date.UTC(1899, 11, 30) + serial * 864e5).toISOString().slice(0, 10);

export interface OiRow { month: string; strike: number; oi: number; chg: number; vol: number }

/** 別紙1: 左列にプット、右列にコールの銘柄が独立に並ぶ。 [銘柄, 取引高, 当日建玉, 前日比, 前日建玉] */
export function parseOiRows(rows: unknown[][]): { date?: string; put: OiRow[]; call: OiRow[] } {
  const put: OiRow[] = [], call: OiRow[] = [];
  let date: string | undefined;
  const sym = /^NIKKEI 225 ([PC])(\d{2})(\d{2})-(\d+)$/;
  for (const r of rows) {
    if (!date && typeof r[0] === "number" && r[0] > 40000 && r[0] < 60000) date = excelDate(r[0]);
    for (const off of [0, 6]) {
      const m = String(r[off] ?? "").trim().match(sym);
      if (!m) continue;
      const row = { month: `20${m[2]}${m[3]}`, strike: Number(m[4]), vol: Number(r[off + 1]) || 0, oi: Number(r[off + 2]) || 0, chg: Number(r[off + 3]) || 0 };
      (m[1] === "P" ? put : call).push(row);
    }
  }
  return { date, put, call };
}

export function parseOiWorkbook(buf: ArrayBuffer | Uint8Array) {
  const wb = XLSX.read(buf instanceof Uint8Array ? buf : new Uint8Array(buf), { type: "array" });
  // シート名が変わっても「日経225オプション（プット）」見出しのあるシートを探す
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" }) as unknown[][];
    if (rows.some((r) => r.some((c) => /日経225オプション（プット）/.test(String(c))))) return parseOiRows(rows);
  }
  throw new Error("Nikkei 225 options OI sheet not found");
}

export interface RbData {
  spot?: number;
  futures: { month: string; price: number; days: number }[];
  options: { month: string; strike: number; type: "P" | "C"; px: number; iv?: number; days: number }[];
}

/** 清算値段 CSV: 銘柄コード,銘柄名称,PUT/CAL,限月,権利行使価格,清算価格,理論価格,原資産価格,ボラティリティ,金利,残日数,原資産名称 */
export function parseSettlementCsv(text: string): RbData {
  const out: RbData = { futures: [], options: [] };
  for (const line of text.split(/\r?\n/)) {
    const c = line.split(",");
    const name = c[1] ?? "";
    const isOpt = name.startsWith("PUT_225_") || name.startsWith("CAL_225_");
    if (!isOpt && !name.startsWith("FUT_225_")) continue; // mini は PUT_225M_ / FUT_225M_ 等で除外
    const days = Number(c[10]);
    if (out.spot === undefined && c[7]) out.spot = Number(c[7]);
    if (isOpt) {
      const iv = Number(c[8]);
      out.options.push({ month: c[3], strike: Number(c[4]), type: c[2] === "PUT" ? "P" : "C", px: Number(c[5]), iv: iv > 0 ? iv : undefined, days });
    } else out.futures.push({ month: c[3], price: Number(c[5]), days });
  }
  return out;
}

/** UTF-8 でデコードしても対象行(英数字のみの列)は壊れないが、念のため Shift_JIS を優先 */
export function decodeSjis(buf: ArrayBuffer | Uint8Array): string {
  try { return new TextDecoder("shift_jis").decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}

export function buildDailyInput(tradeDate: string, oi: ReturnType<typeof parseOiRows>, rb: RbData, sources: string[] = []): DailyInput {
  if (!rb.spot) throw new Error("spot price not found in settlement CSV");
  const key = (m: string, k: number) => `${m}:${k}`;
  const map = new Map<string, DailyStrike>();
  const get = (month: string, strike: number) => {
    const k = key(month, strike);
    let s = map.get(k);
    if (!s) map.set(k, (s = { month, strike }));
    return s;
  };
  for (const r of oi.put) Object.assign(get(r.month, r.strike), { putOi: r.oi, putChg: r.chg, putVol: r.vol });
  for (const r of oi.call) Object.assign(get(r.month, r.strike), { callOi: r.oi, callChg: r.chg, callVol: r.vol });
  const oiMonths = new Set([...oi.put, ...oi.call].map((r) => r.month));
  const days = new Map<string, number>();
  for (const o of rb.options) {
    if (!oiMonths.has(o.month)) continue; // 建玉ファイルにある限月(期近3限月)に限定
    days.set(o.month, o.days);
    const s = get(o.month, o.strike);
    if (o.type === "P") Object.assign(s, { putPx: o.px, putIv: o.iv });
    else Object.assign(s, { callPx: o.px, callIv: o.iv });
  }
  return {
    tradeDate, spot: rb.spot, futures: rb.futures,
    months: [...oiMonths].sort().map((m) => ({ month: m, days: days.get(m) ?? 0 })),
    strikes: [...map.values()].sort((a, b) => a.month.localeCompare(b.month) || a.strike - b.strike),
    sources,
  };
}
