@echo off
rem ============================================================
rem  VPS の起動時に MT5・送信スクリプト(mt5_push.py)・自動売買ボットを立ち上げる。
rem  スタートアップフォルダにショートカットを置いて使う。設定は下の 3 行だけ書き換え。
rem ============================================================
set "MT5_EXE=C:\Program Files\XS MT5 Terminal\terminal64.exe"
set "WORK_DIR=C:\vma_bot"
set "BOT_SCRIPT=bot.py"

rem ---- MT5 を起動(すでに起動していれば何もしない) ----
tasklist /FI "IMAGENAME eq terminal64.exe" | find /I "terminal64.exe" >nul
if errorlevel 1 (
  start "" "%MT5_EXE%"
  rem MT5 の起動とログインを待つ
  timeout /t 60 /nobreak >nul
)

cd /d "%WORK_DIR%"

rem ---- それぞれ別の窓で、止まったら 30 秒後に自動で再起動 ----
start "opt225 mt5_push" cmd /k call "%WORK_DIR%\run_forever.bat" mt5_push.py
start "vma_bot" cmd /k call "%WORK_DIR%\run_forever.bat" %BOT_SCRIPT%
