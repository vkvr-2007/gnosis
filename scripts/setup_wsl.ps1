# Creates Gnosis's coding sandbox: a separate WSL2 Ubuntu called "Gnosis" with Node, git and the GitHub CLI.
# Windows drives are not mounted inside it and it can't start Windows programs, so code Gnosis writes and
# runs there can't reach your Windows files. Your own WSL distros (if any) are not touched.
# Run from the repo root:  .\scripts\setup_wsl.ps1      (about 1 GB download and disk)
$ErrorActionPreference = "Stop"
$name = "Gnosis"

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "WSL isn't installed. Run 'wsl --install --no-distribution' in an administrator PowerShell, restart, then run this again."
}
$existing = (wsl.exe --list --quiet) -replace "`0", "" | Where-Object { $_.Trim() -eq $name }
if ($existing) {
    Write-Host "The $name sandbox already exists. To rebuild it: wsl --unregister $name, then run this again." -ForegroundColor Cyan
    exit 0
}

$dir = Join-Path $env:USERPROFILE ".gnosis\wsl"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tar = Join-Path $env:TEMP "gnosis-ubuntu-24.04.tar.gz"
if (-not (Test-Path $tar)) {
    Write-Host "Downloading Ubuntu 24.04 for WSL..."
    Invoke-WebRequest -Uri "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz" -OutFile $tar
}
Write-Host "Creating the $name distro..."
wsl.exe --import $name $dir $tar --version 2
if ($LASTEXITCODE -ne 0) { throw "wsl --import failed" }

$setup = @'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl git gh python3 python3-venv build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -q nodejs
id gnosis >/dev/null 2>&1 || useradd -m -s /bin/bash gnosis
mkdir -p /home/gnosis/gnosis-workspace && chown -R gnosis:gnosis /home/gnosis/gnosis-workspace
cat > /etc/wsl.conf <<'CONF'
[user]
default=gnosis
[automount]
enabled=false
mountFsTab=false
[interop]
enabled=false
appendWindowsPath=false
CONF
'@
Write-Host "Installing Node, git and the GitHub CLI inside it..."
$setup -replace "`r", "" | wsl.exe -d $name -u root -- bash -s
if ($LASTEXITCODE -ne 0) { throw "Setting up the sandbox failed" }
wsl.exe --terminate $name | Out-Null

Write-Host ""
Write-Host "The $name sandbox is ready." -ForegroundColor Cyan
Write-Host "For publishing, set tokens once as user environment variables (never paste them in chat):"
Write-Host "  [Environment]::SetEnvironmentVariable('GH_TOKEN', '<GitHub token>', 'User')"
Write-Host "  [Environment]::SetEnvironmentVariable('VERCEL_TOKEN', '<Vercel token>', 'User')"
