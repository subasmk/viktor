# VIKTOR voice setup - thin wrapper. Everything real happens in setup_voice.py.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File <repo>\voice\setup-voice.ps1
# Writes NOTHING outside D:\viktor-voice (no winget, no C: caches, no admin).
$ErrorActionPreference = 'Stop'
$home_dir = 'D:\viktor-voice'
$script = Join-Path $PSScriptRoot 'setup_voice.py'

# 1. Find an existing Python 3.10-3.12 (never touch Hermes's Python)
$pyExe = $null
foreach ($v in '3.12','3.11','3.10') {
    try { & py "-$v" -c "pass" 2>$null; if ($LASTEXITCODE -eq 0) { $pyExe = "py"; $pyArg = "-$v"; break } } catch {}
}

# 2. If none: fetch uv standalone zip INTO D: (no installer, no C: writes), have uv fetch its own Python 3.12
if (-not $pyExe) {
    Write-Host "No Python 3.10-3.12 found; bootstrapping uv + Python into $home_dir (D: only)"
    New-Item -ItemType Directory -Force $home_dir | Out-Null
    $zip = Join-Path $home_dir 'uv.zip'
    Invoke-WebRequest 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' -OutFile $zip
    Expand-Archive $zip -DestinationPath (Join-Path $home_dir 'uv') -Force
    Remove-Item $zip
    $uv = Join-Path $home_dir 'uv\uv.exe'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $home_dir 'python'
    $env:UV_CACHE_DIR = Join-Path $home_dir 'uv-cache'
    & $uv python install 3.12
    $pyExe = & $uv python find 3.12
    & $pyExe $script
    exit $LASTEXITCODE
}

Write-Host "Using system Python $pyArg"
& $pyExe $pyArg $script
exit $LASTEXITCODE
