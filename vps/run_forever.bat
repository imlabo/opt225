@echo off
rem 指定した Python スクリプトを動かし続ける(止まったら 30 秒後に再起動)。例: run_forever.bat mt5_push.py
cd /d "%~dp0"
:loop
echo [%date% %time%] start %1
py -3.12 %*
echo [%date% %time%] %1 stopped (exit %errorlevel%). restart in 30 sec...
timeout /t 30 /nobreak >nul
goto loop
