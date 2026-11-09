"""
XS の MT5 から日経225 CFD の 5分・15分・60分足を取り、opt225 サイトへ 30 秒ごとに送る。
サイト側はこれを受け取った瞬間に天井・大底候補の判定をし、分足チャートもこのデータで描く
(Yahoo の 10〜20 分遅れを解消)。

使い方(Windows VPS、MT5 を起動・ログインした状態で):
  py -3.12 -m pip install MetaTrader5 requests
  set OPT225_ADMIN_TOKEN=(GitHub の ADMIN_TOKEN と同じ値)
  py -3.12 mt5_push.py                 # 銘柄名を自動で探す
  py -3.12 mt5_push.py JP225s          # 銘柄名を指定する場合

常駐させるときは、ボットと同じくタスクスケジューラ等で起動してください。
"""
import os
import sys
import time

import MetaTrader5 as mt5
import requests

SITE = os.environ.get("OPT225_SITE", "https://opt225.imlabosns.workers.dev")
TOKEN = os.environ.get("OPT225_ADMIN_TOKEN", "")
INTERVAL_SEC = int(os.environ.get("OPT225_INTERVAL", "30"))
N_BARS = 300
TFS = {"5m": mt5.TIMEFRAME_M5, "15m": mt5.TIMEFRAME_M15, "60m": mt5.TIMEFRAME_H1}
TF_MIN = {"5m": 5, "15m": 15, "60m": 60}
PROFILE_DAYS = 20  # 時間帯ごとの平常出来高を何日分の中央値で作るか
PROFILE_EVERY_SEC = 600
CANDIDATES = ["JP225s", "JP225", "JPN225s", "JPN225", "JP225Cash", "NIKKEI225", "N225", "JPN225.cash"]


def find_symbol(arg):
    if arg:
        return arg
    names = {s.name for s in (mt5.symbols_get() or [])}
    for c in CANDIDATES:
        if c in names:
            return c
    hits = sorted(n for n in names if "225" in n or "NIK" in n.upper() or "JPN" in n.upper())
    if hits:
        print("候補:", ", ".join(hits), "→", hits[0])
        return hits[0]
    sys.exit("日経225 の銘柄が見つかりません。銘柄名を引数で指定してください(例: py -3.12 mt5_push.py JP225s)")


def server_offset_sec(symbol):
    """MT5 の足の時刻はサーバー時間(XS は GMT+2/+3 など)。UTC との差を最新ティックから求める(30 分単位に丸める)"""
    tick = mt5.symbol_info_tick(symbol)
    if not tick or not tick.time:
        return 0
    diff = tick.time - time.time()
    return int(round(diff / 1800.0)) * 1800


def volume_profile(symbol, offset):
    """時間帯(UTC の時刻の枠)ごとの平常出来高 = 過去 PROFILE_DAYS 日の同じ枠のティック出来高の中央値。
    早朝・寄り付きなど毎日決まって出来高が膨らむ時間帯を「急増」と誤判定しないための基準"""
    out = {}
    for key, tf in TFS.items():
        n = PROFILE_DAYS * 24 * 60 // TF_MIN[key]
        rates = mt5.copy_rates_from_pos(symbol, tf, 1, n)
        if rates is None or len(rates) == 0:
            continue
        slots = {}
        for r in rates:
            t = int(r["time"]) - offset
            slot = (t % 86400) // 60 // TF_MIN[key]
            slots.setdefault(slot, []).append(float(r["tick_volume"]))
        prof = {}
        for slot, vols in slots.items():
            vols.sort()
            if len(vols) >= 5:
                prof[str(slot)] = vols[len(vols) // 2]
        out[key] = prof
    return out


def main():
    if not TOKEN:
        sys.exit("環境変数 OPT225_ADMIN_TOKEN を設定してください")
    if not mt5.initialize():
        sys.exit(f"MT5 に接続できません: {mt5.last_error()}")
    symbol = find_symbol(sys.argv[1] if len(sys.argv) > 1 else None)
    mt5.symbol_select(symbol, True)
    print(f"{symbol} を {INTERVAL_SEC} 秒ごとに {SITE} へ送信します")
    offset = server_offset_sec(symbol)
    last_offset_check = time.time()
    last_profile = 0.0
    while True:
        try:
            if time.time() - last_offset_check > 600:  # 夏時間の切り替えに備えて 10 分ごとに再計算
                offset = server_offset_sec(symbol) or offset
                last_offset_check = time.time()
            payload = {"symbol": symbol, "bars": {}}
            if time.time() - last_profile > PROFILE_EVERY_SEC:
                payload["profile"] = volume_profile(symbol, offset)
                last_profile = time.time()
            for key, tf in TFS.items():
                rates = mt5.copy_rates_from_pos(symbol, tf, 0, N_BARS)
                if rates is None or len(rates) == 0:
                    continue
                payload["bars"][key] = [
                    [int(r["time"]) - offset, float(r["open"]), float(r["high"]), float(r["low"]), float(r["close"]), float(r["tick_volume"])]
                    for r in rates
                ]
            if payload["bars"]:
                r = requests.post(f"{SITE}/admin/mt5-push", json=payload, headers={"Authorization": f"Bearer {TOKEN}"}, timeout=20)
                if r.status_code != 200:
                    print(time.strftime("%H:%M:%S"), "送信エラー", r.status_code, r.text[:200])
            else:
                print(time.strftime("%H:%M:%S"), "足が取れません(MT5 のログイン・銘柄を確認)")
        except Exception as e:  # 通信エラー等は続行
            print(time.strftime("%H:%M:%S"), "エラー", e)
            if not mt5.terminal_info():
                mt5.initialize()
        time.sleep(INTERVAL_SEC)


if __name__ == "__main__":
    main()
