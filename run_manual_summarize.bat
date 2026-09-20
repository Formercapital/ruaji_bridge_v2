@echo off
chcp 65001 > nul
cd /d "%~dp0"
"astr\unified_astrbot_host\.venv\Scripts\python.exe" scripts\manual_summarize.py %*
echo.
pause
