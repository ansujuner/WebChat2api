const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

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
function Get-CimInstance { param($Filter) foreach ($item in (${psQuote(JSON.stringify(processes))} | ConvertFrom-Json)) { $item } }
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
