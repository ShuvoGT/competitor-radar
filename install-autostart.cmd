@echo off
REM ---------------------------------------------------------------
REM Registers Competitor Radar to start automatically when you log in.
REM Run this once. Double-click is enough, no admin rights needed.
REM ---------------------------------------------------------------
setlocal
set "TASKNAME=Competitor Radar"

schtasks /Create /TN "%TASKNAME%" /TR "\"%~dp0start-radar.cmd\"" /SC ONLOGON /DELAY 0000:30 /RL LIMITED /F

if errorlevel 1 (
  echo.
  echo Could not register the task. You can do it by hand instead:
  echo   1. Press Win+R, type  shell:startup  and press Enter.
  echo   2. Copy start-radar.cmd into the folder that opens.
  echo.
) else (
  echo.
  echo Done. Competitor Radar will start 30 seconds after you log in.
  echo If the PC was off at report time, Radar sends the report as soon as it starts.
  echo.
  echo To stop this later, run uninstall-autostart.cmd
  echo.
)
pause
