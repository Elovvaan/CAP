$ErrorActionPreference = "Stop"
$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Destination = "D:\CAP"

Write-Host "Installing CAP to $Destination" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Copy-Item -Path "$Source\*" -Destination $Destination -Recurse -Force
Set-Location $Destination

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js is required. Install Node.js LTS, then run this script again."
}

npm install
Write-Host "CAP source installed at D:\CAP" -ForegroundColor Green
Write-Host "Run the browser preview with: npm run dev" -ForegroundColor Yellow
Write-Host "Run the desktop app after installing Rust and Tauri prerequisites with: npm run tauri dev" -ForegroundColor Yellow
