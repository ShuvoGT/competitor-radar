@echo off
REM Removes the automatic start entry. Radar itself is not deleted.
setlocal
schtasks /Delete /TN "Competitor Radar" /F
echo.
echo Competitor Radar will no longer start automatically.
echo You can still start it any time with start-radar.cmd
echo.
pause
