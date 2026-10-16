# Downloads the Piper voice Gnosis speaks with (British English, "Alan", about 60 MB).
# Run from the repo root:  .\scripts\get_voice.ps1
$ErrorActionPreference = "Stop"
$dir = Join-Path $env:USERPROFILE ".gnosis\voices"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/medium"
foreach ($f in @("en_GB-alan-medium.onnx", "en_GB-alan-medium.onnx.json")) {
    $out = Join-Path $dir $f
    if (-not (Test-Path $out)) {
        Write-Host "Downloading $f..."
        Invoke-WebRequest -Uri "$base/$f" -OutFile $out
    }
}
Write-Host "Voice ready in $dir" -ForegroundColor Cyan
