# VIKTOR - one-time Hermes API setup. Runs locally on YOUR PC and changes only two files:
# your Hermes .env and VIKTOR's own settings file. It never prints your key and sends nothing anywhere.
#   1. Finds the home of your RUNNING Hermes gateway (reads gateway.pid, checks the process is alive).
#   2. Backs up that home's .env, then makes sure it has a strong API_SERVER_KEY
#      (keeps an existing good one; creates a random one only if missing or too short).
#   3. Writes that key into VIKTOR's settings (%APPDATA%\viktor\config.json) so the app can connect.
# It does NOT restart Hermes. When you are ready:
#   hermes gateway restart     (Telegram pauses for a few seconds)
$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "[viktor] $msg" }

# --- 1. locate the live gateway home ---
$candidates = @()
if ($env:HERMES_HOME) { $candidates += $env:HERMES_HOME }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'hermes') }
$candidates += 'D:\hermes'

$home = $null
foreach ($cand in ($candidates | Select-Object -Unique)) {
    $pidFile = Join-Path $cand 'gateway.pid'
    if (-not (Test-Path $pidFile)) { continue }
    try {
        $rec = Get-Content $pidFile -Raw | ConvertFrom-Json
        $proc = Get-Process -Id ([int]$rec.pid) -ErrorAction SilentlyContinue
        if ($proc -and $rec.hermes_home) {
            $home = [string]$rec.hermes_home
            Write-Step "Found running Hermes gateway (PID $($rec.pid)); home: $home"
            break
        }
    } catch { }
}
if (-not $home) {
    if ($env:HERMES_HOME) { $home = $env:HERMES_HOME }
    elseif ($env:LOCALAPPDATA) { $home = Join-Path $env:LOCALAPPDATA 'hermes' }
    Write-Step "No running gateway detected; using home: $home"
}
if (-not (Test-Path $home)) { Write-Host "[viktor] ERROR: Hermes home not found: $home"; exit 1 }

# --- 2. make sure .env has a usable API_SERVER_KEY (Hermes requires 16+ chars) ---
$envPath = Join-Path $home '.env'
$lines = @()
if (Test-Path $envPath) {
    $lines = @(Get-Content $envPath)
} else {
    Write-Step ".env not found - a new one will be created"
}

$key = $null
$keyLineIdx = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*API_SERVER_KEY\s*=\s*(.*)$') {
        $keyLineIdx = $i
        $val = $Matches[1].Trim().Trim('"').Trim("'")
        if ($val.Length -ge 16 -and $val -notmatch 'your|change|xxx|placeholder') { $key = $val }
    }
}

if ($key) {
    Write-Step "Existing API_SERVER_KEY found ($($key.Length) chars) - keeping it"
} else {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $bytes = New-Object byte[] 24
    $rng.GetBytes($bytes)
    $key = ([Convert]::ToBase64String($bytes)).TrimEnd('=') -replace '\+','x' -replace '/','y'
    $rng.Dispose()
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    if (Test-Path $envPath) {
        Copy-Item $envPath "$envPath.viktor-backup-$stamp"
        Write-Step "Backed up .env to .env.viktor-backup-$stamp"
    }
    if ($keyLineIdx -ge 0) { $lines[$keyLineIdx] = "API_SERVER_KEY=$key" }
    else { $lines += "API_SERVER_KEY=$key" }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($envPath, [string[]]$lines, $utf8NoBom)
    Write-Step "Created a new API_SERVER_KEY ($($key.Length) chars) in $envPath"
}

# --- 3. write the key into VIKTOR's own settings (so you never paste it) ---
$viktorDir = Join-Path $env:APPDATA 'viktor'
$viktorCfg = Join-Path $viktorDir 'config.json'
$cfg = $null
if (Test-Path $viktorCfg) {
    try { $cfg = Get-Content $viktorCfg -Raw | ConvertFrom-Json } catch { $cfg = $null }
}
if ($null -eq $cfg) { $cfg = New-Object PSCustomObject }

function Set-CfgProp($obj, [string]$name, [string]$value, [bool]$always) {
    $prop = $obj.PSObject.Properties[$name]
    if ($always -or $null -eq $prop -or [string]::IsNullOrEmpty([string]$prop.Value)) {
        if ($null -eq $prop) { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
        else { $prop.Value = $value }
    }
}
Set-CfgProp $cfg 'endpoint' 'http://127.0.0.1:8642/v1' $false
Set-CfgProp $cfg 'apiKey' $key $true
Set-CfgProp $cfg 'sessionKey' 'desktop-console' $false
Set-CfgProp $cfg 'modelName' 'hermes-agent' $false

New-Item -ItemType Directory -Force -Path $viktorDir | Out-Null
$json = $cfg | ConvertTo-Json -Depth 10
$utf8NoBom2 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($viktorCfg, $json, $utf8NoBom2)
Write-Step "VIKTOR settings updated (key stored, never shown)"

Write-Host ""
Write-Step "DONE. Two steps left, whenever you are ready:"
Write-Host "  1. Restart Hermes:   hermes gateway restart    (Telegram pauses a few seconds)"
Write-Host "  2. Open VIKTOR > SETTINGS > press TEST - it should say LIVE"
