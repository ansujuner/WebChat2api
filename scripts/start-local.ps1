#Requires -Version 5.1
<#
.SYNOPSIS
Build (optionally) and open this checkout's production Chat2API desktop app.
.DESCRIPTION
Uses the project-local Electron runtime. Does not read or rewrite saved accounts,
change proxy settings, enable a development/debugging port, or stop other apps.
The window is intentionally visible so the user can log in to providers.
#>
[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$UpdateRuntime,
    [switch]$Preflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'This launcher is for Windows. On macOS/Linux, use npm run build and npm start.'
}
if (($Build -or $UpdateRuntime) -and $Preflight) {
    throw '-Build/-UpdateRuntime and -Preflight are mutually exclusive. Preflight is read-only.'
}

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
$requiredFiles = @('package.json', 'out\main\index.js', 'out\preload\index.js', 'out\renderer\index.html')

if (-not $UpdateRuntime -and -not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
    throw 'The local Electron runtime is missing. In the project directory, run: node node_modules/electron/install.js (or install dependencies with npm ci). Then retry this launcher.'
}

# Only inspect Electron processes using this checkout's executable. Do not act on
# unrelated Electron-based applications or inspect their command lines.
$localElectronProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($electronPath, [StringComparison]::OrdinalIgnoreCase) })
$existingApp = @($localElectronProcesses | Where-Object {
    $_.CommandLine -and
    $_.CommandLine.IndexOf($projectRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
    $_.CommandLine -notmatch '(?i)(?:^|\s)--(?:type(?:=|\s)|version(?:\s|$)|help(?:\s|$))'
})

if ($Preflight) {
    $missingFiles = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $projectRoot $_) -PathType Leaf) })
    [pscustomobject]@{
        Project = $projectRoot
        Electron = $electronPath
        BuildReady = ($missingFiles.Count -eq 0)
        MissingFiles = $missingFiles
        RunningProcessIds = @($existingApp | ForEach-Object { $_.ProcessId })
        SavedSettings = 'Not read or changed'
    }
    return
}

if ($existingApp.Count -gt 0) {
    Write-Warning 'This checkout is already running. Use its existing window. After a rebuild, choose Exit from the Chat2API tray menu and launch again; closing the window may only minimize it to the tray.'
    [pscustomobject]@{
        Started = $false
        AlreadyRunning = $true
        ProcessIds = @($existingApp | ForEach-Object { $_.ProcessId })
    }
    return
}

if ($UpdateRuntime) {
    & (Join-Path $PSScriptRoot 'update-runtime.ps1') | Out-Host
}

# An existing binary is not proof that the requested runtime has been installed.
$projectPackage = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$electronDependency = $projectPackage.PSObject.Properties['devDependencies']
if ($electronDependency -and $electronDependency.Value.PSObject.Properties['electron']) {
    $expectedRuntime = [string]$electronDependency.Value.electron
    $runtimeVersionPath = Join-Path $projectRoot 'node_modules\electron\dist\version'
    if ($expectedRuntime -match '^\d+\.\d+\.\d+$') {
        $actualRuntime = if (Test-Path -LiteralPath $runtimeVersionPath) { (Get-Content -LiteralPath $runtimeVersionPath -Raw).Trim() } else { '' }
        if ($actualRuntime -ne $expectedRuntime) {
            throw "The installed browser engine is not Electron $expectedRuntime. Run scripts/start-local.ps1 -UpdateRuntime -Build after exiting the app."
        }
    }
}

if ($Build) {
    $npm = Get-Command npm.cmd -ErrorAction Stop
    Push-Location -LiteralPath $projectRoot
    try {
        & $npm.Source run build
        if ($LASTEXITCODE -ne 0) {
            throw "Production build failed (exit code $LASTEXITCODE); app was not started."
        }
    } finally {
        Pop-Location
    }
}

foreach ($relativePath in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $relativePath) -PathType Leaf)) {
        throw "Missing build file: $relativePath. Run this launcher with -Build first."
    }
}

$logDirectory = Join-Path $projectRoot 'logs\local-deployment'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$stdoutLog = Join-Path $logDirectory "$timestamp.stdout.log"
$stderrLog = Join-Path $logDirectory "$timestamp.stderr.log"

. (Join-Path $PSScriptRoot 'local-launch-security.ps1')
$launchContext = Get-LocalLauncherContext
if ($launchContext.Elevated -or $launchContext.Integrity -ge 12288) {
    $launchId = [Guid]::NewGuid().ToString('N')
    $requestPath = Join-Path $logDirectory "$launchId.request.json"
    $resultPath = Join-Path $logDirectory "$launchId.result.json"
    $helperPath = Join-Path $PSScriptRoot 'start-local-user.ps1'
    $powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $helperPath -PathType Leaf) -or -not (Test-Path -LiteralPath $powershellPath -PathType Leaf)) {
        throw 'Standard-user launcher is unavailable. Open an ordinary, non-administrator PowerShell window and run scripts/start-local.ps1 there.'
    }
    $createdUtc = [DateTime]::UtcNow
    @{ LaunchId = $launchId; Project = $projectRoot; UserSid = $launchContext.UserSid; SessionId = $launchContext.SessionId;
        CreatedUtc = $createdUtc.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding UTF8
    try {
        $desktop = Get-LocalDesktopShell -ExpectedContext $launchContext
        # Explorer owns this dispatch. Only the fixed helper and an opaque nonce
        # are passed; no command, environment value, account data or URL is accepted.
        $helperArguments = '-NoLogo -NoProfile -NonInteractive -File "' + $helperPath + '" -LaunchId ' + $launchId
        [void]$desktop.ShellExecute($powershellPath, $helperArguments, $projectRoot, 'open', 0)
    } catch {
        throw 'Could not use the existing standard-user Explorer desktop. No elevated fallback was started. Open a non-administrator PowerShell window and run scripts/start-local.ps1 there.'
    }
    for ($attempt = 0; $attempt -lt 45 -and -not (Test-Path -LiteralPath $resultPath -PathType Leaf); $attempt++) { Start-Sleep -Seconds 1 }
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
        throw 'Standard-user launch was not confirmed. Do not launch an administrator copy. Check the app/taskbar and logs/local-deployment, or retry from a non-administrator PowerShell window.'
    }
    try {
        if ((Get-Item -LiteralPath $resultPath).Length -gt 16384) { throw 'launch_result_invalid' }
        $handoff = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($handoff.LaunchId -cne $launchId -or $handoff.Success -isnot [bool] -or -not $handoff.Success -or
            $handoff.StandardUser -isnot [bool] -or -not $handoff.StandardUser) { throw 'launch_result_invalid' }
        $launch = $handoff.Result
        if ($launch.Started -isnot [bool] -or $launch.AlreadyRunning -isnot [bool]) { throw 'launch_result_invalid' }
        if ($launch.Started -and -not $launch.AlreadyRunning) {
            $launchedIds = @([int]$launch.ProcessId)
        } elseif (-not $launch.Started -and $launch.AlreadyRunning) {
            $launchedIds = @($launch.ProcessIds)
            if ($launchedIds.Count -ne 1) { throw 'launch_result_invalid' }
        } else { throw 'launch_result_invalid' }
        foreach ($launchedId in $launchedIds) {
            Assert-LocalLaunchedProcess -ProcessId $launchedId -ElectronPath $electronPath -ProjectRoot $projectRoot `
                -ExpectedContext $launchContext -NotBeforeUtc $createdUtc
        }
    } catch {
        throw 'The standard-user helper did not confirm a safe launch. Open a non-administrator PowerShell window and run scripts/start-local.ps1; no elevated fallback was started.'
    }
    $launch
    return
}
if ($launchContext.Integrity -lt 8192) { throw 'Use an ordinary desktop PowerShell session to start this application.' }

# Codex and other Electron hosts may inherit ELECTRON_RUN_AS_NODE. Remove it
# only around child creation; never alter the user's persistent environment.
$environmentKeys = @('ELECTRON_RUN_AS_NODE', 'NODE_ENV', 'ELECTRON_RENDERER_URL')
$savedEnvironment = @{}
foreach ($key in $environmentKeys) {
    $savedEnvironment[$key] = @{
        Exists = (Test-Path -LiteralPath "Env:$key")
        Value = [Environment]::GetEnvironmentVariable($key, 'Process')
    }
}

try {
    # On PowerShell 7.5+/modern .NET, passing $null to SetEnvironmentVariable
    # can create an EMPTY variable instead of removing it. Electron treats the
    # presence of ELECTRON_RUN_AS_NODE (even empty) as Node mode. Remove the key.
    Remove-Item -LiteralPath Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $env:NODE_ENV = 'production'
    Remove-Item -LiteralPath Env:ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue
    # The user requested a visible application for interactive provider login.
    # No --no-sandbox, security bypass, or remote-debugging flags are added.
    $appProcess = Start-Process -FilePath $electronPath -ArgumentList ('"' + $projectRoot + '"') `
        -WorkingDirectory $projectRoot -WindowStyle Normal -PassThru `
        -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
} finally {
    foreach ($key in $environmentKeys) {
        if ($savedEnvironment[$key].Exists) {
            Set-Item -LiteralPath "Env:$key" -Value $savedEnvironment[$key].Value
        } else {
            Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
        }
    }
}

$windowFound = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Seconds 1
    $appProcess.Refresh()
    if ($appProcess.HasExited) {
        throw "Chat2API exited before its window was ready. Inspect local startup logs: $stdoutLog and $stderrLog"
    }
    if ($appProcess.MainWindowHandle -ne [IntPtr]::Zero) {
        $windowFound = $true
        break
    }
}

if (-not $windowFound) {
    Write-Warning 'Chat2API is running, but a main window was not confirmed within 20 seconds. Check its taskbar/tray and the local startup logs.'
}

[pscustomobject]@{
    Started = $true
    AlreadyRunning = $false
    ProcessId = $appProcess.Id
    WindowDetected = $windowFound
    Project = $projectRoot
    StdoutLog = $stdoutLog
    StderrLog = $stderrLog
    NextStep = 'Log in under Accounts, then start the proxy in the dashboard if it is not already running. Saved configuration is preserved.'
}
