# Sets up Gnosis on Windows: creates .venv and installs the package with its dependencies.
# Run from the repo root:  .\scripts\install.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

# Prefer the Python launcher (py -3); fall back to python on PATH.
function Invoke-Python { if (Get-Command py -ErrorAction SilentlyContinue) { & py -3 @args } else { & python @args } }

$version = Invoke-Python -c "import sys; print('%d.%d' % sys.version_info[:2])"
if ([version]$version -lt [version]"3.11") {
    throw "Gnosis needs Python 3.11 or newer (found $version). Install it from https://www.python.org/downloads/"
}

if (-not (Test-Path ".venv")) {
    Invoke-Python -m venv .venv
}
& .\.venv\Scripts\python -m pip install --upgrade pip
& .\.venv\Scripts\python -m pip install -e ".[dev]" psutil

if (-not (Test-Path "config\gnosis.yaml")) {
    Copy-Item "config\gnosis.example.yaml" "config\gnosis.yaml"
}

Write-Host ""
Write-Host "Gnosis is installed. Next:" -ForegroundColor Cyan
Write-Host '  $env:NEBIUS_API_KEY = "<your key>"'
Write-Host "  .\.venv\Scripts\python -m gnosis models"
Write-Host "  .\.venv\Scripts\python -m gnosis serve"
