@echo off
REM ---------------------------------------------------------------
REM Competitor Radar - dashboard + daily scheduler, one command.
REM Leave this window open. Closing it stops the daily report.
REM
REM This ALWAYS restarts cleanly: it first stops any Radar that is
REM already running on port 7070, so new code is actually loaded.
REM Without this, a second launch could not bind the port and the
REM OLD process (old code) kept serving - so updates never took effect.
REM ---------------------------------------------------------------
cd /d "%~dp0"
title Competitor Radar

echo Stopping any Competitor Radar already running on port 7070...
set "KILLED="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7070" ^| findstr LISTENING') do (
  echo   stopping old process (PID %%a)
  taskkill /F /PID %%a >nul 2>&1
  set "KILLED=1"
)
if defined KILLED (
  echo   old process stopped.
  REM Give Windows a moment to release the port before rebinding.
  ping -n 3 127.0.0.1 >nul
) else (
  echo   nothing was running.
)
echo.

echo Starting Competitor Radar...
echo Dashboard: http://127.0.0.1:7070
echo.
call npm start

echo.
echo Competitor Radar stopped. Press any key to close this window.
pause >nul
