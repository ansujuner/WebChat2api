const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { installLauncherSecurityFixture } = require('./helpers/local-launch-fixture.cjs')

const root = path.resolve(__dirname, '../..')
const fixtureParent = path.join(root, 'logs', 'launcher-tests')
const windowsTest = process.platform === 'win32' ? test : test.skip
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`

function fixture(t, { runtime = true, build = true } = {}) {
  fs.mkdirSync(fixtureParent, { recursive: true })
  const dir = fs.mkdtempSync(path.join(fixtureParent, 'app-'))
  const script = path.join(dir, 'scripts', 'start-local.ps1')
  fs.mkdirSync(path.dirname(script), { recursive: true })
  fs.copyFileSync(path.join(root, 'scripts', 'start-local.ps1'), script)
  installLauncherSecurityFixture(root, dir)
  const electron = path.join(dir, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (runtime) {
    fs.mkdirSync(path.dirname(electron), { recursive: true })
    fs.writeFileSync(electron, 'fixture: never executed')
  }
  if (build) {
    for (const relative of ['package.json', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      const file = path.join(dir, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, '{}')
    }
  }
  t.after(() => {
    const resolved = fs.realpathSync(dir)
    const allowed = fs.realpathSync(fixtureParent) + path.sep
    assert.ok(resolved.startsWith(allowed), 'cleanup target remains in the project fixture directory')
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return { dir, script, electron }
}

function runPowerShell(f, { arguments: args = '-Preflight', processes = [], setup = '', command, executable = 'powershell.exe' } = {}) {
  // A private PowerShell child uses mocked process APIs: tests never start a
  // desktop application, inspect user account files, or kill any process.
  const source = `
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
function Get-CimInstance { param($ClassName, $Filter) foreach ($item in (${psQuote(JSON.stringify(processes))} | ConvertFrom-Json)) { $item } }
function Start-Process { throw 'Unexpected process launch during test' }
${setup}
${command || `& ${psQuote(f.script)} ${args} | ConvertTo-Json -Compress -Depth 5`}
`
  return spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', source], {
    encoding: 'utf8', cwd: root, windowsHide: true, timeout: 30000,
  })
}

windowsTest('local deployment preflight is read-only and filters renderer/diagnostic processes', (t) => {
  const f = fixture(t)
  const processes = [
    { ProcessId: 123, ExecutablePath: f.electron, CommandLine: `"${f.electron}" "${f.dir}"` },
    { ProcessId: 124, ExecutablePath: f.electron, CommandLine: `"${f.electron}" --type=renderer` },
    { ProcessId: 125, ExecutablePath: f.electron, CommandLine: `"${f.electron}" --version` },
    { ProcessId: 126, ExecutablePath: f.electron, CommandLine: `"${f.electron}" --help` },
    { ProcessId: 127, ExecutablePath: 'C:\\OtherApp\\electron.exe', CommandLine: 'C:\\OtherApp\\electron.exe app' },
  ]
  const result = runPowerShell(f, { processes })
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.equal(data.BuildReady, true)
  assert.deepEqual(data.RunningProcessIds, [123])
  assert.deepEqual(data.MissingFiles, [])
  assert.equal(data.SavedSettings, 'Not read or changed')
  assert.equal(fs.existsSync(path.join(f.dir, 'logs')), false)
})

windowsTest('local deployment preflight reports missing build files without writing or launching', (t) => {
  const f = fixture(t, { build: false })
  const result = runPowerShell(f)
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.equal(data.BuildReady, false)
  assert.equal(data.MissingFiles.length, 4)
  assert.equal(fs.existsSync(path.join(f.dir, 'logs')), false)
})

windowsTest('local deployment rejects missing Electron and conflicting preflight/build options', (t) => {
  const f = fixture(t, { runtime: false })
  const missing = runPowerShell(f)
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /local Electron runtime is missing/)
  const conflict = runPowerShell(f, { arguments: '-Build -Preflight' })
  assert.notEqual(conflict.status, 0)
  assert.match(conflict.stderr, /mutually exclusive/)
})

windowsTest('local deployment does not restart an already running project app', (t) => {
  const f = fixture(t)
  const result = runPowerShell(f, {
    arguments: '-Build',
    processes: [{ ProcessId: 321, ExecutablePath: f.electron, CommandLine: `"${f.electron}" .` }],
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { Started: false, AlreadyRunning: true, ProcessIds: [321] })
  assert.equal(fs.existsSync(path.join(f.dir, 'logs')), false)
})

windowsTest('local deployment restores inherited environment after a failed child launch', (t) => {
  const f = fixture(t)
  const result = runPowerShell(f, {
    setup: `
$env:ELECTRON_RUN_AS_NODE = 'test-node-mode'
$env:NODE_ENV = 'test-development'
$env:ELECTRON_RENDERER_URL = 'http://fixture.invalid'
function Start-Process { throw 'simulated launch failure' }
`,
    command: `
try { & ${psQuote(f.script)} } catch {
  [pscustomobject]@{
    Error = $_.Exception.Message
    ElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
    NodeEnvironment = $env:NODE_ENV
    RendererUrl = $env:ELECTRON_RENDERER_URL
  } | ConvertTo-Json -Compress
}
`,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    Error: 'simulated launch failure',
    ElectronRunAsNode: 'test-node-mode',
    NodeEnvironment: 'test-development',
    RendererUrl: 'http://fixture.invalid',
  })
})

windowsTest('local deployment opens a visible production app with no debug/security flags', (t) => {
  const f = fixture(t)
  const result = runPowerShell(f, {
    setup: `
$env:ELECTRON_RUN_AS_NODE = 'test-node-mode'
$env:NODE_ENV = 'test-development'
$env:ELECTRON_RENDERER_URL = 'http://fixture.invalid'
function Start-Sleep { param($Seconds) }
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
  $global:observed = [pscustomobject]@{
    FilePath = $FilePath; Arguments = $ArgumentList; WorkingDirectory = $WorkingDirectory; WindowStyle = $WindowStyle
    ElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE; NodeEnvironment = $env:NODE_ENV; RendererUrl = $env:ELECTRON_RENDERER_URL
  }
  $fakeProcess = [pscustomobject]@{ HasExited = $false; MainWindowHandle = [IntPtr]1; Id = 456 }
  $fakeProcess | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
  return $fakeProcess
}
`,
    command: `
$launchResult = & ${psQuote(f.script)}
[pscustomobject]@{ Result = $launchResult; Observed = $observed; RestoredNodeMode = $env:ELECTRON_RUN_AS_NODE } | ConvertTo-Json -Compress -Depth 5
`,
  })
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.equal(data.Result.Started, true)
  assert.equal(data.Result.WindowDetected, true)
  assert.equal(data.Result.ProcessId, 456)
  assert.equal(data.Observed.FilePath, f.electron)
  assert.equal(data.Observed.Arguments, `"${f.dir}"`)
  assert.equal(data.Observed.WorkingDirectory, f.dir)
  assert.equal(data.Observed.WindowStyle, 'Normal')
  assert.equal(data.Observed.NodeEnvironment, 'production')
  assert.equal(data.Observed.ElectronRunAsNode, null)
  assert.equal(data.Observed.RendererUrl, null)
  assert.equal(data.RestoredNodeMode, 'test-node-mode')
})

const hasPowerShell7 = process.platform === 'win32' && spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], {
  windowsHide: true, timeout: 10000,
}).status === 0

test('PowerShell 7 launch removes empty Node-mode keys and preserves absent parent variables', { skip: !hasPowerShell7 }, (t) => {
  const f = fixture(t)
  const result = runPowerShell(f, {
    executable: 'pwsh.exe',
    setup: `
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue
function Start-Sleep { param($Seconds) }
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
  $global:observed = [pscustomobject]@{
    NodeKeyPresent = Test-Path Env:ELECTRON_RUN_AS_NODE
    RendererKeyPresent = Test-Path Env:ELECTRON_RENDERER_URL
    NodeEnvironment = $env:NODE_ENV
  }
  $fakeProcess = [pscustomobject]@{ HasExited = $false; MainWindowHandle = [IntPtr]1; Id = 789 }
  $fakeProcess | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
  return $fakeProcess
}
`,
    command: `
& ${psQuote(f.script)} | Out-Null
[pscustomobject]@{
  Observed = $observed
  RestoredNodeKey = Test-Path Env:ELECTRON_RUN_AS_NODE
  RestoredEnvironmentKey = Test-Path Env:NODE_ENV
  RestoredRendererKey = Test-Path Env:ELECTRON_RENDERER_URL
} | ConvertTo-Json -Compress -Depth 5
`,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    Observed: { NodeKeyPresent: false, RendererKeyPresent: false, NodeEnvironment: 'production' },
    RestoredNodeKey: false, RestoredEnvironmentKey: false, RestoredRendererKey: false,
  })
})

test('PowerShell 7 launch temporarily removes an inherited empty Node-mode key', { skip: !hasPowerShell7 }, (t) => {
  const f = fixture(t)
  const result = runPowerShell(f, {
    executable: 'pwsh.exe',
    setup: `
$env:ELECTRON_RUN_AS_NODE = ''
function Start-Process {
  $global:childNodeKey = Test-Path Env:ELECTRON_RUN_AS_NODE
  throw 'simulated launch failure'
}
`,
    command: `
$originalKey = Test-Path Env:ELECTRON_RUN_AS_NODE
try { & ${psQuote(f.script)} } catch {
  [pscustomobject]@{
    Error = $_.Exception.Message
    OriginalKey = $originalKey
    ChildNodeKey = $childNodeKey
    RestoredKey = Test-Path Env:ELECTRON_RUN_AS_NODE
    RestoredEmpty = ($env:ELECTRON_RUN_AS_NODE -ceq '')
  } | ConvertTo-Json -Compress
}
`,
  })
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.equal(data.Error, 'simulated launch failure')
  assert.equal(data.ChildNodeKey, false)
  // Older PowerShell 7 versions remove empty values; newer ones preserve them.
  assert.equal(data.RestoredKey, data.OriginalKey)
  if (data.OriginalKey) assert.equal(data.RestoredEmpty, true)
})

function handoffSetup(f, { result = 'started', child = '', process = '', dispatch = '' } = {}) {
  return `
$global:LauncherContextMock = {
  param($ProcessId)
  if ($ProcessId -eq $PID) { return [pscustomobject]@{ UserSid = 'S-1-5-21-fixture'; SessionId = 1; Integrity = 12288; Elevated = $true } }
  $identity = [pscustomobject]@{ UserSid = 'S-1-5-21-fixture'; SessionId = 1; Integrity = 8192; Elevated = $false }
  ${child}
  return $identity
}
function Start-Sleep { param($Seconds) }
function Get-CimInstance {
  param($ClassName, $Filter)
  if ($Filter -like 'Name*') { return }
  $process = [pscustomobject]@{ ProcessId = 456; ExecutablePath = ${psQuote(f.electron)}; CommandLine = ${psQuote(`"${f.electron}" "${f.dir}"`)}; CreationDate = [DateTime]::UtcNow }
  ${process}
  return $process
}
$global:DesktopShellMock = {
  param($ExpectedContext)
  $desktop = [pscustomobject]@{}
  $desktop | Add-Member -MemberType ScriptMethod -Name ShellExecute -Value {
    param($File, $Arguments, $Directory, $Verb, $Show)
    $global:observed = [pscustomobject]@{ File = $File; Arguments = $Arguments; Directory = $Directory; Verb = $Verb; Show = $Show }
    if ($Arguments -notmatch ' -LaunchId ([a-f0-9]{32})$') { throw 'invalid fixture dispatch' }
    $id = $Matches[1]
    $logDirectory = Join-Path $Directory 'logs/local-deployment'
    $global:request = Get-Content -LiteralPath (Join-Path $logDirectory "$id.request.json") -Raw | ConvertFrom-Json
    $launch = @{ Started = $true; AlreadyRunning = $false; ProcessId = 456; Fixture = $true }
    ${result === 'existing' ? '$launch = @{ Started = $false; AlreadyRunning = $true; ProcessIds = @(456) }' : ''}
    $response = @{ LaunchId = $id; Success = $true; StandardUser = $true; Result = $launch }
    ${dispatch}
    ${result === 'missing' ? 'return' : result === 'malformed' ? `'remote-sentinel-invalid' | Set-Content -LiteralPath (Join-Path $logDirectory "$id.result.json")` : '$response | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $logDirectory "$id.result.json")'}
  }
  return $desktop
}
`
}

windowsTest('elevated launcher dispatches only the fixed helper through mocked desktop COM and verifies returned process', t => {
  const f = fixture(t)
  const result = runPowerShell(f, {
    setup: handoffSetup(f),
    command: `$launch = & ${psQuote(f.script)}
[pscustomobject]@{ Result = $launch; Observed = $observed; RequestKeys = @($request.PSObject.Properties.Name) } | ConvertTo-Json -Compress -Depth 5`,
  })
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.equal(data.Result.Started, true)
  assert.equal(data.Result.ProcessId, 456)
  assert.equal(data.Observed.File.toLowerCase(), path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe').toLowerCase())
  assert.match(data.Observed.Arguments, new RegExp(`^-NoLogo -NoProfile -NonInteractive -File "${path.join(f.dir, 'scripts/start-local-user.ps1').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" -LaunchId [a-f0-9]{32}$`))
  assert.equal(data.Observed.Directory, f.dir)
  assert.equal(data.Observed.Verb, 'open')
  assert.equal(data.Observed.Show, 0)
  assert.deepEqual(data.RequestKeys.sort(), ['CreatedUtc', 'LaunchId', 'Project', 'SessionId', 'UserSid'])
  assert.doesNotMatch(data.Observed.Arguments, /ExecutionPolicy|EncodedCommand|-Command|no-sandbox|enable-automation|do-not-de-elevate/i)
})

windowsTest('elevated launcher accepts a same-user medium app that raced the fixed helper', t => {
  const f = fixture(t)
  const result = runPowerShell(f, { arguments: '', setup: handoffSetup(f, { result: 'existing' }) })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { Started: false, AlreadyRunning: true, ProcessIds: [456] })
})

windowsTest('elevated launcher rejects malformed, stale, wrong-app or elevated handoffs without fallback', t => {
  const f = fixture(t)
  const cases = [
    { result: 'malformed' },
    { dispatch: "$response = @{ LaunchId = $id; Success = $false }" },
    { dispatch: "$response.Success = 'true'" },
    { dispatch: "$response.LaunchId = 'incorrect'" },
    { process: "$process.ExecutablePath = 'C:\\unrelated\\electron.exe'" },
    { process: "$process.CommandLine += ' --type=renderer'" },
    { process: "$process.CreationDate = [DateTime]::UtcNow.AddDays(-1)" },
    { child: '$identity.Elevated = $true' },
    { child: '$identity.Integrity = 12288' },
    { child: "$identity.UserSid = 'S-1-5-21-other'" },
    { child: '$identity.SessionId = 2' },
    { result: 'existing', child: '$identity.Elevated = $true' },
    { result: 'existing', dispatch: '$response.Result.ProcessIds = @(456, 789)' },
  ]
  for (const options of cases) {
    const result = runPowerShell(f, { arguments: '', setup: handoffSetup(f, options) })
    assert.notEqual(result.status, 0, JSON.stringify(options))
    assert.match(result.stderr, /helper did not confirm a safe launch/, JSON.stringify(options))
    assert.doesNotMatch(result.stderr, /remote-sentinel|Unexpected process launch/)
  }
})

windowsTest('missing desktop and missing confirmation fail closed with ordinary-session guidance', t => {
  const f = fixture(t)
  for (const setup of [
    handoffSetup(f) + "$global:DesktopShellMock = { throw 'raw-desktop-sentinel' }",
    handoffSetup(f, { result: 'missing' }),
  ]) {
    const result = runPowerShell(f, { arguments: '', setup })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /non-administrator PowerShell/)
    assert.doesNotMatch(result.stderr, /raw-desktop-sentinel|Unexpected process launch/)
  }
})

function runFixedHelper(f, { mutate = '', context = '', duplicate = false } = {}) {
  fs.writeFileSync(f.script, `$global:launchCount++
[pscustomobject]@{ Started = $true; AlreadyRunning = $false; ProcessId = 456; StdoutLog = 'fixture.stdout.log'; StderrLog = 'fixture.stderr.log' }`)
  return runPowerShell(f, {
    setup: `$global:launchCount = 0
${context ? `$global:LauncherContextMock = { [pscustomobject]@{ UserSid = 'S-1-5-21-fixture'; SessionId = 1; Integrity = 12288; Elevated = $true } }` : ''}`,
    command: `
$id = '0123456789abcdef0123456789abcdef'
$logs = Join-Path ${psQuote(f.dir)} 'logs/local-deployment'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$request = @{ LaunchId = $id; Project = ${psQuote(f.dir)}; UserSid = 'S-1-5-21-fixture'; SessionId = 1; CreatedUtc = [DateTime]::UtcNow.ToString('o') }
${mutate}
$request | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $logs "$id.request.json") -Encoding UTF8
& ${psQuote(path.join(f.dir, 'scripts/start-local-user.ps1'))} -LaunchId $id
${duplicate ? `& ${psQuote(path.join(f.dir, 'scripts/start-local-user.ps1'))} -LaunchId $id` : ''}
[pscustomobject]@{ Count = $launchCount; Result = (Get-Content -LiteralPath (Join-Path $logs "$id.result.json") -Raw | ConvertFrom-Json) } | ConvertTo-Json -Compress -Depth 6`,
  })
}

windowsTest('fixed medium helper consumes nonce once and preserves the normal launcher log result', t => {
  const f = fixture(t)
  const result = runFixedHelper(f, { duplicate: true })
  assert.equal(result.status, 0, result.stderr)
  const data = JSON.parse(result.stdout)
  assert.equal(data.Count, 1)
  assert.equal(data.Result.Success, true)
  assert.equal(data.Result.StandardUser, true)
  assert.equal(data.Result.Result.StdoutLog, 'fixture.stdout.log')
  assert.equal(data.Result.Result.StderrLog, 'fixture.stderr.log')
})

windowsTest('fixed helper refuses high integrity and invalid manifests before launching anything', t => {
  const cases = [
    { context: 'elevated', code: 'standard_user_required' },
    { mutate: "$request.Project = 'C:\\another-workspace'" },
    { mutate: "$request.UserSid = 'S-1-5-21-other'" },
    { mutate: '$request.SessionId = 2' },
    { mutate: "$request.SessionId = '1'" },
    { mutate: "$request.CreatedUtc = [DateTime]::UtcNow.AddMinutes(-6).ToString('o')" },
    { mutate: "$request.CreatedUtc = [DateTime]::UtcNow.AddMinutes(1).ToString('o')" },
    { mutate: "$request.CreatedUtc = 'raw-invalid-sentinel'" },
    { mutate: "$request.Command = 'never-run-sentinel'" },
    { mutate: "$request.Project = ('x' * 9000)" },
    { mutate: "$request.Remove('UserSid')" },
  ]
  for (const options of cases) {
    const f = fixture(t)
    const result = runFixedHelper(f, options)
    assert.equal(result.status, 0, result.stderr)
    const data = JSON.parse(result.stdout)
    assert.equal(data.Count, 0, JSON.stringify(options))
    assert.equal(data.Result.Success, false)
    assert.equal(data.Result.ErrorCode, options.code || 'launch_request_invalid')
    assert.doesNotMatch(JSON.stringify(data), /sentinel/)
  }
})

windowsTest('desktop locator binds a fully mocked existing Explorer window and rejects another window identity', t => {
  const f = fixture(t)
  const native = path.join(root, 'scripts/local-launch-security.ps1')
  for (const wrongWindow of [false, true]) {
    const result = runPowerShell(f, {
      setup: `
Add-Type -TypeDefinition @'
using System;
namespace Chat2Api { public static class LocalLaunchNative {
 public static IntPtr GetShellWindow() { return new IntPtr(1); }
 public static uint GetWindowThreadProcessId(IntPtr window, out int id) { id = window.ToInt32() == 1 ? 101 : 202; return 1; }
} }
'@
. ${psQuote(native)}
function Get-LocalLauncherContext { param($ProcessId) [pscustomobject]@{ UserSid = 'fixture'; SessionId = 1; Integrity = 8192; Elevated = $false } }
function Get-CimInstance { param($ClassName, $Filter) [pscustomobject]@{ ExecutablePath = (Join-Path $env:SystemRoot 'explorer.exe') } }
function New-Object {
  param($ComObject)
  if ($ComObject -ne 'Shell.Application') { throw 'unexpected COM class' }
  $windows = [pscustomobject]@{}
  $windows | Add-Member -MemberType ScriptMethod -Name FindWindowSW -Value {
    param([ref]$Location, [ref]$Root, $Class, [ref]$WindowHandle, $Options)
    if ($Location.Value -ne 0 -or $Root.Value -ne 0 -or $Class -ne 8 -or $Options -ne 1) { throw 'wrong desktop query' }
    $WindowHandle.Value = ${wrongWindow ? 2 : 1}
    [pscustomobject]@{ Document = [pscustomobject]@{ Application = [pscustomobject]@{ Fixture = $true } } }
  }
  $shell = [pscustomobject]@{ FixtureWindows = $windows }
  $shell | Add-Member -MemberType ScriptMethod -Name Windows -Value { $this.FixtureWindows }
  return $shell
}`,
      command: `Get-LocalDesktopShell -ExpectedContext ([pscustomobject]@{ UserSid = 'fixture'; SessionId = 1 }) | ConvertTo-Json -Compress`,
    })
    if (wrongWindow) {
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /desktop_identity_unverified/)
    } else {
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { Fixture: true })
    }
  }
})
