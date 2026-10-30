# VIKTOR - one-time Hermes API setup. Runs locally on YOUR PC and changes only two files:
# your Hermes .env and VIKTOR's own settings file. It never prints your key and sends nothing anywhere.
#   1. Finds the home of your RUNNING Hermes gateway (gateway.pid whose record names its own
#      home, with a live gateway process behind it).
#   2. Refuses to touch anything if the API server was explicitly disabled (config.yaml or .env).
#   3. Backs up .env, then makes sure it has a strong API_SERVER_KEY (keeps an existing good
#      one; creates a random one only if missing or too short). Writes are atomic (temp + rename).
#   4. Writes that key into VIKTOR's settings (%APPDATA%\viktor\config.json) so the app can connect.
# It does NOT restart Hermes. When you are ready:
#   hermes gateway restart     (Telegram pauses for a few seconds)
$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "[viktor] $msg" }
function Fail($msg) { Write-Host "[viktor] STOPPED - nothing was changed. $msg"; exit 1 }

# --- 1. locate the live gateway home (strict: record must name the dir it lives in) ---
$candidates = @()
if ($env:HERMES_HOME) { $candidates += $env:HERMES_HOME }
if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'hermes') }
$candidates += 'D:\hermes'

$hermesHome = $null
foreach ($cand in ($candidates | Select-Object -Unique)) {
    $pidFile = Join-Path $cand 'gateway.pid'
    if (-not (Test-Path $pidFile)) { continue }
    try {
        $rec = Get-Content $pidFile -Raw | ConvertFrom-Json
        $recHome = [string]$rec.hermes_home
        if (-not $recHome) { continue }
        $sameHome = ([IO.Path]::GetFullPath($recHome).TrimEnd('\') -ieq [IO.Path]::GetFullPath($cand).TrimEnd('\'))
        if (-not $sameHome) { continue }   # stale/copied record (e.g. left over from a move)
        $procId = [int]$rec.pid
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        try {
            $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction Stop
            if ($cim.CommandLine -notmatch 'hermes_cli' -or $cim.CommandLine -notmatch 'gateway') { continue }
        } catch { }  # if the identity query itself is blocked, the live PID + matching home already passed
        $hermesHome = [IO.Path]::GetFullPath($recHome).TrimEnd('\')
        Write-Step "Found running Hermes gateway (PID $procId); home: $hermesHome"
        break
    } catch { }
}
if (-not $hermesHome) {
    Fail "Could not confirm a RUNNING Hermes gateway home. Start Hermes the way you normally do, then re-run this script."
}

# --- 2. refuse when the API server was explicitly disabled ---
$cfgYaml = Join-Path $hermesHome 'config.yaml'
if (Test-Path $cfgYaml) {
    $ylines = @(Get-Content $cfgYaml)
    $inBlock = $false; $blockIndent = -1
    foreach ($l in $ylines) {
        if ($l -match '^(\s*)api_server:\s*$') { $inBlock = $true; $blockIndent = $Matches[1].Length; continue }
        if ($inBlock) {
            if ($l -match '^\s*$' -or $l -match '^\s*#') { continue }
            $indent = ($l -replace '^(\s*).*$', '$1').Length
            if ($indent -le $blockIndent) { $inBlock = $false; continue }
            if ($l -match '^\s*enabled:\s*false\s*$') {
                Fail "config.yaml has gateway api_server enabled:false (a deliberate disable). Tell VIKTOR support before changing this."
            }
        }
    }
}

$envPath = Join-Path $hermesHome '.env'
$lines = @()
if (Test-Path $envPath) { $lines = @(Get-Content $envPath) }

foreach ($l in $lines) {
    if ($l -match '^\s*API_SERVER_ENABLED\s*=\s*(.*)$') {
        $v = $Matches[1].Trim().Trim('"').Trim("'")
        if ($v -match '^(false|0|no|off)$') {
            Fail ".env has API_SERVER_ENABLED=$v (a deliberate disable). Tell VIKTOR support before changing this."
        }
    }
}

# --- 3. ensure a usable API_SERVER_KEY (Hermes requires 16+ chars) ---
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
    $tmpEnv = "$envPath.viktor-tmp"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($tmpEnv, [string[]]$lines, $utf8NoBom)
    Move-Item -Force $tmpEnv $envPath
    Write-Step "Created a new API_SERVER_KEY ($($key.Length) chars) in $envPath"
}

# --- 4. write the key into VIKTOR's own settings (so you never paste it) ---
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
$tmpCfg = "$viktorCfg.viktor-tmp"
$utf8NoBom2 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tmpCfg, $json, $utf8NoBom2)
Move-Item -Force $tmpCfg $viktorCfg
Write-Step "VIKTOR settings updated (key stored, never shown)"

Write-Host ""
Write-Step "DONE. Two steps left, whenever you are ready:"
Write-Host "  1. Restart Hermes:   hermes gateway restart    (Telegram pauses a few seconds)"
Write-Host "  2. Open VIKTOR > SETTINGS > press TEST - it should say LIVE"
