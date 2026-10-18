# MineWeb launcher — starts the local server and opens the game in the default browser.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '[MineWeb] Node.js was not found on PATH.' -ForegroundColor Red
    Write-Host '[MineWeb] Install Node.js 18+ from https://nodejs.org/'
    exit 1
}

$port = 8137
Write-Host "[MineWeb] serving http://127.0.0.1:$port/" -ForegroundColor Green
Start-Process "http://127.0.0.1:$port/"
node tools/serve.mjs $port
