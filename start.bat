@echo off
rem ---------------------------------------------------------------------------
rem  MineWeb launcher — starts the local server and opens the game in the browser.
rem ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [MineWeb] Node.js was not found on PATH.
  echo [MineWeb] Install Node.js 18+ ^(https://nodejs.org^) or open index.html
  echo [MineWeb] through any static file server.
  pause
  exit /b 1
)

set PORT=8137
echo [MineWeb] starting server on http://127.0.0.1:%PORT%/
start "" http://127.0.0.1:%PORT%/
node tools\serve.mjs %PORT%
