/**
 * ナイトセッション(夜間取引 16:30〜翌 6:00 JST)の更新。
 * 日次の分析(建玉・損益分岐)は日中の引け時点のデータなので、夜間に動いた分を朝 6:05 JST に反映する。
 * 価格は CME NKD=F(Yahoo Finance)の 15分足から、夜間の時間帯を切り出して使う(大阪の夜間取引とほぼ同じ時間帯)。
 */
import type { IBar, Levels } from "./alerts";

export interface NightSnap {
  tradeDate: string; // 日中の取引日(この日の 16:30 から翌朝 6:00 まで)
  from: number; to: number; // 対象時間(UNIX 秒)
  dayClose: number; // 日中の引け(15:45 JST 時点の先物)
  open: number; high: number; low: number; close: number;
  change: number; changePct: number;
  putLevel: number | null; callLevel: number | null; // 先物換算の損益分岐(日中の建玉から)
  putDist: number | null; callDist: number | null; // 夜間終値から損益分岐までの距離(%、マイナスは割れ・抜け)
  brokePut: boolean; brokeCall: boolean; // 夜間に一度でも損益分岐を割った・抜けたか
  bars: number; at: number; source: string;
}

const JST = 9 * 3600;
/** 取引日 YYYY-MM-DD の 16:30 JST 〜 翌日 6:00 JST(UNIX 秒)。翌日が休日でも夜間取引は翌朝 6:00 まで */
export function nightWindow(tradeDate: string): [number, number] {
  const d0 = Date.UTC(+tradeDate.slice(0, 4), +tradeDate.slice(5, 7) - 1, +tradeDate.slice(8, 10)) / 1000 - JST; // その日 0:00 JST
  return [d0 + 16.5 * 3600, d0 + 30 * 3600];
}

export function buildNight(bars: IBar[], tradeDate: string, lv: Levels | null, source = "CME NKD=F(Yahoo)", now = Date.now()): NightSnap | null {
  const [from, to] = nightWindow(tradeDate);
  const dayEnd = from - 45 * 60; // 15:45 JST
  const day = bars.filter((b) => b.t < dayEnd && b.t >= dayEnd - 8 * 3600 && b.volume > 0);
  const night = bars.filter((b) => b.t >= from && b.t < to && b.volume > 0);
  if (!day.length || night.length < 4) return null;
  const dayClose = day[day.length - 1].close;
  const close = night[night.length - 1].close;
  const high = Math.max(...night.map((b) => b.high)), low = Math.min(...night.map((b) => b.low));
  const putLevel = lv?.putLevel ?? null, callLevel = lv?.callLevel ?? null;
  return {
    tradeDate, from, to, dayClose, open: night[0].open, high, low, close,
    change: close - dayClose, changePct: ((close - dayClose) / dayClose) * 100,
    putLevel, callLevel,
    putDist: putLevel != null ? ((close - putLevel) / close) * 100 : null,
    callDist: callLevel != null ? ((callLevel - close) / close) * 100 : null,
    brokePut: putLevel != null && low < putLevel, brokeCall: callLevel != null && high > callLevel,
    bars: night.length, at: now, source,
  };
}
