#Requires -Version 5.1
<#
.SYNOPSIS
Restart only this checkout's Chat2API app, optionally rebuilding after it exits.
.DESCRIPTION
Requests normal application shutdown first and waits 20 seconds. If it remains,
rechecks executable, exact root command, PID and creation time before stopping
only that app and its verified Electron descendants. Never stops Chrome, Edge,
other Electron applications, or PID-reused processes. No account files are read.
#>
[CmdletBinding()]
param([switch]$Build)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This restart launcher is for Windows.' }
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
$launcher = Join-Path $PSScriptRoot 'start-local.ps1'
if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf) -or -not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw 'The project-local Electron runtime or launcher is missing; nothing was stopped.'
}
function Get-ProjectElectron {
    @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'electron.exe'" | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.Equals($electronPath, [StringComparison]::OrdinalIgnoreCase)
    })
}
function Get-Identity($Record) {
    if (-not $Record.PSObject.Properties['CreationDate'] -or -not $Record.CreationDate -or
        -not $Record.CommandLine -or [long]$Record.ProcessId -le 0) { throw 'Process identity is incomplete; restart refused.' }
    $created = [DateTimeOffset]::MinValue
    if ($Record.CreationDate -is [DateTimeOffset]) { $created = $Record.CreationDate }
    elseif ($Record.CreationDate -is [DateTime]) { $created = [DateTimeOffset]$Record.CreationDate }
    elseif (-not [DateTimeOffset]::TryParse([string]$Record.CreationDate, [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind, [ref]$created)) { throw 'Process creation time could not be verified; restart refused.' }
    [pscustomobject]@{ ProcessId = [long]$Record.ProcessId; CreatedTicks = $created.UtcDateTime.Ticks;
        Executable = [string]$Record.ExecutablePath; CommandLine = [string]$Record.CommandLine }
}
function Same-Identity($Left, $Right) {
    $Left.ProcessId -eq $Right.ProcessId -and $Left.CreatedTicks -eq $Right.CreatedTicks -and
    $Left.Executable.Equals($Right.Executable, [StringComparison]::OrdinalIgnoreCase) -and
    $Left.CommandLine.Equals($Right.CommandLine, [StringComparison]::Ordinal)
}
function Test-ExactMainCommand($Record) {
    if (-not $Record.CommandLine) { return $false }
    $match = [regex]::Match($Record.CommandLine, '^\s*(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(\S+))\s*$')
    if (-not $match.Success) { return $false }
    $executableArgument = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    $rootArgument = if ($match.Groups[3].Success) { $match.Groups[3].Value } else { $match.Groups[4].Value }
    $executableArgument.Equals($electronPath, [StringComparison]::OrdinalIgnoreCase) -and
    $rootArgument.Equals($projectRoot, [StringComparison]::OrdinalIgnoreCase)
}
function Find-Main($Records) {
    $mains = @($Records | Where-Object { Test-ExactMainCommand $_ })
    $uncertain = @($Records | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -notmatch '(?i)(?:^|\s)--(?:type(?:=|\s)|chat2api-(?:probe|quit)(?:=|\s|$)|version(?:\s|$)|help(?:\s|$))' -and
        -not (Test-ExactMainCommand $_)
    })
    if ($mains.Count -gt 1 -or $uncertain.Count -gt 0) { throw 'Ambiguous project main processes; no restart or forced stop was performed.' }
    if ($mains.Count -eq 1) { return $mains[0] }
    return $null
}
function Get-CurrentIdentity($Expected) {
    $found = @(Get-ProjectElectron | Where-Object { [long]$_.ProcessId -eq $Expected.ProcessId })
    if ($found.Count -eq 0) { return $null }
    if ($found.Count -ne 1) { throw 'Ambiguous process identity; restart refused.' }
    $current = Get-Identity $found[0]
    if (-not (Same-Identity $Expected $current)) { throw 'A process identity changed or its PID was reused; restart refused without stopping it.' }
    return $current
}
function Get-OwnedTree($Main, $Records) {
    $owned = @{}
    $rootIdentity = Get-Identity $Main
    $owned[[string]$rootIdentity.ProcessId] = [pscustomobject]@{ Identity = $rootIdentity; Depth = 0 }
    do {
        $added = $false
        foreach ($record in $Records) {
            $key = [string]$record.ProcessId
            if ($owned.ContainsKey($key) -or -not $record.PSObject.Properties['ParentProcessId'] -or
                -not $owned.ContainsKey([string]$record.ParentProcessId) -or
                -not $record.CommandLine -or $record.CommandLine -notmatch '(?i)(?:^|\s)--type(?:=|\s)') { continue }
            $identity = Get-Identity $record
            $parent = $owned[[string]$record.ParentProcessId]
            if ($identity.CreatedTicks -lt $parent.Identity.CreatedTicks) { continue }
            $owned[$key] = [pscustomobject]@{ Identity = $identity; Depth = $parent.Depth + 1 }
            $added = $true
        }
    } while ($added)
    @($owned.Values)
}
$initial = @(Get-ProjectElectron)
$main = Find-Main $initial
$forced = 0
if ($main) {
    $identity = Get-Identity $main
    if (-not (Get-CurrentIdentity $identity)) { throw 'The app exited before shutdown dispatch. Run the launcher again; nothing was stopped.' }
    $environmentKeys = @('ELECTRON_RUN_AS_NODE', 'NODE_ENV', 'ELECTRON_RENDERER_URL')
    $savedEnvironment = @{}
    foreach ($key in $environmentKeys) {
        $savedEnvironment[$key] = @{ Exists = (Test-Path -LiteralPath "Env:$key"); Value = [Environment]::GetEnvironmentVariable($key, 'Process') }
    }
    try {
        Remove-Item -LiteralPath Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath Env:ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue
        $env:NODE_ENV = 'production'
        # Single-instance IPC command only. Its guard exits if the original app disappeared.
        Start-Process -FilePath $electronPath -ArgumentList ('"' + $projectRoot + '" --chat2api-quit') `
            -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru | Out-Null
    } finally {
        foreach ($key in $environmentKeys) {
            if ($savedEnvironment[$key].Exists) { Set-Item -LiteralPath "Env:$key" -Value $savedEnvironment[$key].Value }
            else { Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue }
        }
    }
    $alive = Get-CurrentIdentity $identity
    for ($attempt = 0; $alive -and $attempt -lt 80; $attempt++) {
        Start-Sleep -Milliseconds 250
        $alive = Get-CurrentIdentity $identity
    }
    if ($alive) {
        # Capture ancestry only while the original root identity is still verified.
        $snapshot = @(Get-ProjectElectron)
        $verifiedRoot = Find-Main $snapshot
        if (-not $verifiedRoot -or -not (Same-Identity $identity (Get-Identity $verifiedRoot))) { throw 'The app identity changed before forced shutdown; restart refused.' }
        $tree = @(Get-OwnedTree $verifiedRoot $snapshot)
        # Stop the root first so it cannot spawn replacements, then deepest known children.
        $ordered = @($tree | Where-Object { $_.Depth -eq 0 }) + @($tree | Where-Object { $_.Depth -gt 0 } | Sort-Object Depth -Descending)
        foreach ($entry in $ordered) {
            # Fresh metadata guard immediately before every stop, including each child PID.
            if (Get-CurrentIdentity $entry.Identity) {
                Stop-Process -Id $entry.Identity.ProcessId -Force -ErrorAction Stop
                $forced++
            }
        }
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            $remaining = @($tree | Where-Object { $null -ne (Get-CurrentIdentity $_.Identity) })
            if ($remaining.Count -eq 0) { break }
            Start-Sleep -Milliseconds 250
        }
        if ($remaining.Count -gt 0) { throw 'Verified app processes have not exited; no replacement was started.' }
    }
}
# Refuse a new concurrent main rather than rebuilding beneath it or starting twice.
if (Find-Main @(Get-ProjectElectron)) { throw 'Another project main appeared during restart; no replacement was started.' }
$launchArguments = @{}
if ($Build) { $launchArguments.Build = $true }
& $launcher @launchArguments
[pscustomobject]@{ Restarted = [bool]$main; ForcedProcessCount = $forced; Project = $projectRoot }
