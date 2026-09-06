#Requires -Version 5.1
# Fixed medium-integrity entry point. It accepts a nonce, never a command/path.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$LaunchId)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$logDirectory = Join-Path $projectRoot 'logs\local-deployment'
$requestPath = Join-Path $logDirectory "$LaunchId.request.json"
$resultPath = Join-Path $logDirectory "$LaunchId.result.json"
$result = @{ LaunchId = $LaunchId; Success = $false; ErrorCode = 'standard_launch_failed' }
# Atomically consume each request once. Never launch twice if Explorer or a caller
# repeats dispatch, and never overwrite the first operation's eventual result.
$claimPath = Join-Path $logDirectory "$LaunchId.claim"
$claim = $null
try { $claim = [IO.File]::Open($claimPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
catch { return }
try {
    . (Join-Path $PSScriptRoot 'local-launch-security.ps1')
    $context = Get-LocalLauncherContext
    if ($context.Elevated -or $context.Integrity -lt 8192 -or $context.Integrity -ge 12288) { throw 'standard_user_required' }
    try {
        if ((Get-Item -LiteralPath $requestPath).Length -gt 8192) { throw 'launch_request_invalid' }
        $request = Get-Content -LiteralPath $requestPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (@($request.PSObject.Properties).Count -ne 5 -or
            $request.LaunchId -isnot [string] -or $request.LaunchId -cne $LaunchId -or
            $request.Project -isnot [string] -or $request.Project -cne $projectRoot -or
            $request.UserSid -isnot [string] -or $request.UserSid -cne $context.UserSid -or
            $request.SessionId -isnot [int] -or $request.SessionId -ne $context.SessionId -or
            $request.CreatedUtc -isnot [string]) { throw 'launch_request_invalid' }
        $createdUtc = [DateTime]::ParseExact($request.CreatedUtc, 'o', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
        $age = ([DateTime]::UtcNow - $createdUtc.ToUniversalTime()).TotalSeconds
        if ($createdUtc.Kind -ne [DateTimeKind]::Utc -or $age -lt 0 -or $age -gt 300) { throw 'launch_request_invalid' }
    } catch { throw 'launch_request_invalid' }
    $launch = & (Join-Path $PSScriptRoot 'start-local.ps1')
    if (-not $launch) { throw 'standard_launch_failed' }
    $result = @{ LaunchId = $LaunchId; Success = $true; StandardUser = $true; Result = $launch }
} catch {
    # Never persist exception text, inherited environment, tokens or arbitrary paths.
    if ($_.Exception.Message -in @('standard_user_required', 'launch_request_invalid')) { $result.ErrorCode = $_.Exception.Message }
} finally {
    $temporary = "$resultPath.tmp"
    $result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $temporary -Encoding UTF8
    try { Move-Item -LiteralPath $temporary -Destination $resultPath } finally { $claim.Dispose() }
}
