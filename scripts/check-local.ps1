#Requires -Version 5.1
<#
.SYNOPSIS
Ask the already-running project app to check its real proxy address and model list.
.DESCRIPTION
Catalog checks do not generate chats. -Live explicitly requests one small real
conversation per supported provider; -Live -Stream requests Anthropic streaming.
-Live -ZaiLiveness checks only Z.ai accounts. -AccountStatus only reads the last
in-memory account check and never starts a new one.
This wrapper never reads account/profile files or keys, disables authentication,
guesses a port, starts a separate profile, or retries a generation.
#>
[CmdletBinding()]
param(
    [switch]$Live,
    [switch]$Stream,
    [switch]$DeepSeekAllModes,
    [switch]$DeepSeekLogin,
    [switch]$ZaiLogin,
    [switch]$Tools,
    [switch]$ArenaLogin,
    [switch]$Arena,
    [switch]$Accounts,
    [switch]$ZaiLiveness,
    [switch]$AccountStatus,
    [ValidateRange(0, 900)][int]$TimeoutSeconds = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This diagnostic launcher is for Windows.' }
if ($AccountStatus -and ($Live -or $Stream -or $DeepSeekAllModes -or $DeepSeekLogin -or $ZaiLogin -or $Tools -or $ArenaLogin -or $Arena -or $Accounts -or $ZaiLiveness)) { throw '-AccountStatus is read-only and cannot be combined with another mode.' }
if ($ZaiLiveness -and (-not $Live -or $Stream -or $DeepSeekAllModes -or $DeepSeekLogin -or $ZaiLogin -or $Tools -or $ArenaLogin -or $Arena -or $Accounts)) { throw '-ZaiLiveness requires -Live and cannot be combined with another diagnostic mode.' }
if ($ZaiLogin -and ($Live -or $Stream -or $DeepSeekAllModes -or $DeepSeekLogin -or $Tools -or $ArenaLogin -or $Arena -or $Accounts)) { throw '-ZaiLogin is an existing-account restore and cannot be combined with another mode.' }
if ($Accounts -and (-not $Live -or $Stream -or $DeepSeekAllModes -or $DeepSeekLogin -or $Tools -or $ArenaLogin -or $Arena)) { throw '-Accounts requires -Live and cannot be combined with another diagnostic mode.' }
if ($ArenaLogin -and ($Live -or $Stream -or $DeepSeekAllModes -or $DeepSeekLogin -or $Tools -or $Arena)) { throw '-ArenaLogin cannot be combined with generation checks or another login mode.' }
if ($Arena -and (-not $Live -or $Stream -or $DeepSeekAllModes -or $DeepSeekLogin -or $Tools)) { throw '-Arena requires -Live and cannot be combined with other diagnostic modes.' }
if ($Stream -and -not $Live) { throw '-Stream requires -Live because streaming checks generate real provider replies.' }
if ($DeepSeekAllModes -and (-not $Live -or $Stream)) { throw '-DeepSeekAllModes requires -Live and cannot be combined with -Stream.' }
if ($DeepSeekLogin -and ($Live -or $Stream -or $DeepSeekAllModes)) { throw '-DeepSeekLogin cannot be combined with generation checks.' }
if ($Tools -and (-not $Live -or $Stream -or $DeepSeekAllModes -or $DeepSeekLogin)) { throw '-Tools requires -Live and cannot be combined with other diagnostic modes.' }

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
$mode = if ($AccountStatus) { 'accounts-status' } elseif ($ZaiLiveness) { 'zai-liveness' } elseif ($ZaiLogin) { 'zai-login' } elseif ($Accounts) { 'accounts' } elseif ($ArenaLogin) { 'arena-login' } elseif ($Arena) { 'arena' } elseif ($Tools) { 'tools' } elseif ($DeepSeekLogin) { 'login' } elseif ($DeepSeekAllModes) { 'deepseek' } elseif ($Stream) { 'stream' } elseif ($Live) { 'live' } else { 'catalog' }
$reportPath = Join-Path $projectRoot "artifacts\proxy-$mode-probe.json"
if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) { throw 'The project-local Electron runtime is missing. Start the updated project app first.' }
if ($TimeoutSeconds -eq 0) { $TimeoutSeconds = if ($Accounts -or $ZaiLiveness) { 900 } elseif ($DeepSeekLogin -or $ArenaLogin -or $ZaiLogin) { 660 } elseif ($DeepSeekAllModes -or $Arena) { 660 } elseif ($Live) { 420 } else { 30 } }

# Metadata only: inspect only this checkout's executable, never any saved profile.
$existingApp = @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.Equals($electronPath, [StringComparison]::OrdinalIgnoreCase) -and
    $_.CommandLine -and $_.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine -notmatch '(?i)(?:^|\s)--(?:type(?:=|\s)|version(?:\s|$)|help(?:\s|$)|chat2api-(?:probe|quit))'
})
if ($existingApp.Count -ne 1) {
    throw 'Exactly one running main app from this checkout is required. Open the updated Chat2API app first; this check will not start a separate instance.'
}

$environmentKeys = @('ELECTRON_RUN_AS_NODE', 'NODE_ENV', 'ELECTRON_RENDERER_URL')
$savedEnvironment = @{}
foreach ($key in $environmentKeys) {
    $savedEnvironment[$key] = @{
        Exists = (Test-Path -LiteralPath "Env:$key")
        Value = [Environment]::GetEnvironmentVariable($key, 'Process')
    }
}
$dispatchTime = [DateTimeOffset]::UtcNow
try {
    Remove-Item -LiteralPath Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath Env:ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue
    $env:NODE_ENV = 'production'
    # The app's command-only guard quits if the primary instance disappeared.
    # A normal second-instance message delivers the flag; no debugging is enabled.
    $commandProcess = Start-Process -FilePath $electronPath `
        -ArgumentList ('"' + $projectRoot + '" --chat2api-probe=' + $mode) `
        -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
} finally {
    foreach ($key in $environmentKeys) {
        if ($savedEnvironment[$key].Exists) {
            Set-Item -LiteralPath "Env:$key" -Value $savedEnvironment[$key].Value
        } else {
            Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
        }
    }
}

$timer = [Diagnostics.Stopwatch]::StartNew()
while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds) {
    if (Test-Path -LiteralPath $reportPath -PathType Leaf) {
        $file = Get-Item -LiteralPath $reportPath
        if ($file.LastWriteTimeUtc -ge $dispatchTime.UtcDateTime -and $file.Length -le 65536) {
            $report = $null
            try {
                # The application exports a redacted report, never a profile dump.
                $candidate = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
                $checkedAt = [DateTimeOffset]::MinValue
                $hasTimestamp = $false
                if ($candidate.PSObject.Properties['checkedAt']) {
                    if ($candidate.checkedAt -is [DateTimeOffset]) {
                        $checkedAt = $candidate.checkedAt
                        $hasTimestamp = $true
                    } elseif ($candidate.checkedAt -is [DateTime]) {
                        # PowerShell 7.5+ parses JSON ISO timestamps as DateTime.
                        # Do not stringify it: that drops timezone and milliseconds.
                        $checkedAt = [DateTimeOffset]$candidate.checkedAt
                        $hasTimestamp = $true
                    } else {
                        $hasTimestamp = [DateTimeOffset]::TryParse([string]$candidate.checkedAt,
                            [Globalization.CultureInfo]::InvariantCulture,
                            [Globalization.DateTimeStyles]::RoundtripKind, [ref]$checkedAt)
                    }
                }
                if ($hasTimestamp -and
                    $checkedAt -ge $dispatchTime -and $checkedAt -le [DateTimeOffset]::UtcNow.AddSeconds(10) -and
                    $candidate.status -notin @('running', 'awaiting_login') -and
                    $candidate.live -eq [bool]$Live -and $candidate.stream -eq [bool]$Stream -and
                    $candidate.protocol -eq $(if ($Stream) { 'anthropic' } else { 'openai' })) {
                    $report = $candidate
                }
            } catch {
                # A report can be observed during its write. Poll only; never resend.
            }
            if ($report) {
                [pscustomobject]@{
                    Mode = $mode
                    Status = $report.status
                    CheckedAt = $report.checkedAt
                    Report = $reportPath
                    NextStep = 'Read the redacted report for the actual running port, model HTTP status and provider results. No automatic retry was performed.'
                }
                return
            }
        }
    }
    Start-Sleep -Milliseconds 250
}
throw "No fresh completed $mode report arrived within $TimeoutSeconds seconds. The operation may still be running; do not immediately repeat a live check. Existing reports were not treated as a new result. Check the app, then inspect: $reportPath"
