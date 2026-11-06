/** 日経平均ボラティリティー・インデックス(日経VI)の統計。日経公式 CSV(日次)から */
export interface ViPoint { date: string; vi: number; nk: number | null }
export interface ViStats {
  date: string;
  value: number;
  prev: number | null;
  chg: number | null; // 前日比(ポイント)
  ma50: number | null;
  z50: number | null; // (VI − 50日平均) / 50日標準偏差
  pct1y: number | null; // 過去1年(250日)の中での位置 0..100
  max1y: number | null; min1y: number | null;
}

export function viStats(vi: { date: string; value: number }[], upTo: string): ViStats | null {
  const s = vi.filter((p) => p.date <= upTo && p.value > 0);
  if (!s.length) return null;
  const last = s[s.length - 1];
  const prev = s.length > 1 ? s[s.length - 2].value : null;
  const w50 = s.slice(-51, -1).map((p) => p.value);
  const ma50 = w50.length >= 20 ? w50.reduce((a, b) => a + b, 0) / w50.length : null;
  const sd = ma50 != null ? Math.sqrt(w50.reduce((a, b) => a + (b - ma50) ** 2, 0) / w50.length) : null;
  const y = s.slice(-251, -1).map((p) => p.value);
  const below = y.filter((v) => v < last.value).length, eq = y.filter((v) => v === last.value).length;
  return {
    date: last.date, value: last.value, prev, chg: prev != null ? last.value - prev : null,
    ma50, z50: ma50 != null && sd ? (last.value - ma50) / sd : null,
    pct1y: y.length >= 60 ? ((below + eq / 2) / y.length) * 100 : null,
    max1y: y.length ? Math.max(...y, last.value) : null, min1y: y.length ? Math.min(...y, last.value) : null,
  };
}

/** チャート用の履歴(VI と日経平均の終値) */
export function viHistory(vi: { date: string; value: number }[], nk: { date: string; value: number }[], upTo: string, n = 260): ViPoint[] {
  const m = new Map(nk.map((p) => [p.date, p.value]));
  return vi.filter((p) => p.date <= upTo && p.value > 0).slice(-n).map((p) => ({ date: p.date, vi: p.value, nk: m.get(p.date) ?? null }));
}
