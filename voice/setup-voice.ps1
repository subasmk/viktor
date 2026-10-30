# VIKTOR voice setup - one-shot, D: drive only, Hermes untouched.
# Run:  powershell -ExecutionPolicy Bypass -File voice\setup-voice.ps1
# Stops with a clear message on: low disk, no installable Python 3.10-3.12, admin/paid requirement.
$ErrorActionPreference = 'Stop'
$root = 'D:\viktor-voice'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "== VIKTOR voice setup (D: only) =="

# 1. Disk check (needs ~12 GB free)
$free = (Get-PSDrive D).Free / 1GB
if ($free -lt 12) { Write-Host "STOP: D: has $([math]::Round($free,1)) GB free, need 12+ GB. Clear space and rerun."; exit 1 }
Write-Host "D: free: $([math]::Round($free,1)) GB - ok"

# 2. Python 3.10-3.12 (never touch Hermes's Python)
$py = $null
foreach ($v in '3.12','3.11','3.10') { try { py -$v -c "print()" 2>$null; if ($LASTEXITCODE -eq 0) { $py = "-$v"; break } } catch {} }
if (-not $py) {
    Write-Host "No Python 3.10-3.12 found; installing uv (manages its own Python, no admin)"
    winget install --id astral-sh.uv -e --accept-source-agreements --accept-package-agreements
    $env:Path = "$env:LOCALAPPDATA\Microsoft\WinGet\Links;$env:Path"
    $env:UV_PYTHON_INSTALL_DIR = "$root\python"
    $env:UV_CACHE_DIR = "$root\uv-cache"
    uv python install 3.12
    $pyCmd = "uv run --python 3.12"
    $useUv = $true
} else {
    Write-Host "Using existing Python $py"
    $useUv = $false
}

# 3. Caches on D:
$env:HF_HOME = "$root\hf"
New-Item -ItemType Directory -Force $root | Out-Null

# 4. Venv + packages
if ($useUv) {
    uv venv "$root\venv" --python 3.12
} else {
    py $py -m venv "$root\venv"
}
$pip = "$root\venv\Scripts\pip.exe"
$python = "$root\venv\Scripts\python.exe"
& $pip install --quiet --upgrade pip

# torch: try CUDA builds, fall back to CPU with a warning
$cudaOk = $false
foreach ($cu in 'cu126','cu121') {
    & $pip install --quiet torch torchaudio --index-url "https://download.pytorch.org/whl/$cu"
    if ($LASTEXITCODE -eq 0) { $cudaOk = $true; Write-Host "torch $cu installed"; break }
}
if (-not $cudaOk) {
    Write-Host "CUDA torch failed; installing CPU torch (slower, still works for audition)"
    & $pip install --quiet torch torchaudio
}
& $pip install --quiet chatterbox-tts==0.1.7

# 5. Generate audition samples with the SELECTED voice (downloads ~4 GB weights to D:\viktor-voice\hf)
Push-Location $repo
& $python voice\say.py "Yo, I'm up! What are we doing today?" "$root\sample-1.wav"
& $python voice\say.py "Right then! I'm up. What chaos are we causing today?" "$root\sample-2.wav"
& $python voice\say.py "Ha! Okay, that actually worked. What's next?" "$root\sample-3.wav"
Pop-Location

Write-Host ""
Write-Host "DONE. Samples in $root - play sample-1/2/3.wav"
Write-Host "Report the peak_gpu_memory line back."
