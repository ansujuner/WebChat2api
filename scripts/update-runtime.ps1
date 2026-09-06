#Requires -Version 5.1
<#
.SYNOPSIS
Install this checkout's pinned Electron runtime after Chat2API has exited.
.DESCRIPTION
Preserves accounts/settings. Refuses to overwrite a running runtime and never
kills an application, changes proxy/certificate policies, or enables debugging.
#>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
# Windows PowerShell 5.1 ConvertFrom-Json is case-insensitive on property
# names and fails on large lockfiles; extract the pinned version directly.
$lockText = Get-Content -LiteralPath (Join-Path $root 'package-lock.json') -Raw -Encoding UTF8
$lockElectronVersion = if ($lockText -match '"node_modules/electron":\s*\{\s*"version":\s*"([^"]+)"') { $Matches[1] } else { '' }
$expected = $package.devDependencies.electron
if ($expected -notmatch '^\d+\.\d+\.\d+$') { throw 'Electron must be pinned to an exact stable version in package.json.' }
if ($lockElectronVersion -ne $expected) { throw 'The Electron version in package-lock.json does not match package.json.' }

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$running = @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.Equals($electron, [StringComparison]::OrdinalIgnoreCase)
})
if ($running.Count -gt 0) {
    throw 'Chat2API is still running. Finish/cancel login, then choose Exit from its tray menu and run this script again. Nothing was changed.'
}

$npm = Get-Command npm.cmd -ErrorAction Stop
$node = Get-Command node.exe -ErrorAction Stop
Push-Location -LiteralPath $root
try {
    # Use the committed dependency lock, skip unrelated/native lifecycle scripts.
    & $npm.Source install --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed (exit $LASTEXITCODE)." }
    # Only the official Electron package installer is run. It verifies the download.
    & $node.Source (Join-Path $root 'node_modules\electron\install.js')
    if ($LASTEXITCODE -ne 0) { throw "Electron installation failed (exit $LASTEXITCODE)." }
} finally { Pop-Location }

$installed = (Get-Content -LiteralPath (Join-Path $root 'node_modules\electron\dist\version') -Raw).Trim()
if ($installed -ne $expected -or -not (Test-Path -LiteralPath $electron -PathType Leaf)) {
    throw "Electron runtime verification failed. Expected $expected; do not start the application yet."
}
[pscustomobject]@{ Updated = $true; Electron = $installed; SavedSettings = 'Not read or changed'; NextStep = '.\scripts\start-local.ps1 -Build' }
