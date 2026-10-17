# Downloads Android's platform-tools (adb, about 7 MB) into ~/.gnosis so Gnosis can control your phone.
# Run from the repo root:  .\scripts\get_adb.ps1
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE ".gnosis"
$adb = Join-Path $dir "platform-tools\adb.exe"
if (Test-Path $adb) {
    Write-Host "adb is already installed at $adb" -ForegroundColor Cyan
    exit 0
}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$zip = Join-Path $env:TEMP "platform-tools.zip"
Write-Host "Downloading Android platform-tools from Google..."
Invoke-WebRequest -Uri "https://dl.google.com/android/repository/platform-tools-latest-windows.zip" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $dir -Force
Remove-Item $zip
Write-Host "adb ready at $adb" -ForegroundColor Cyan
Write-Host ""
Write-Host "On your phone: Settings > About phone > tap Build number 7 times, then"
Write-Host "Settings > System > Developer options > Wireless debugging > Pair device with pairing code."
Write-Host "Then run:  .\.venv\Scripts\python -m gnosis phone pair <IP:port> <code>"
