const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '../..')
const fixtureParent = path.join(root, 'logs', 'runtime-update-tests')
const windowsTest = process.platform === 'win32' ? test : test.skip
const quote = value => `'${String(value).replaceAll("'", "''")}'`

function fixture(t, options = {}) {
  fs.mkdirSync(fixtureParent, { recursive: true })
  const dir = fs.mkdtempSync(path.join(fixtureParent, 'app-'))
  const write = (relative, value) => {
    const file = path.join(dir, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
  }
  for (const script of ['update-runtime.ps1', 'start-local.ps1']) {
    write(`scripts/${script}`, fs.readFileSync(path.join(root, 'scripts', script)))
  }
  write('package.json', JSON.stringify({ devDependencies: { electron: options.pin ?? '44.2.0' } }))
  write('package-lock.json', JSON.stringify({ packages: { 'node_modules/electron': { version: options.lock ?? '44.2.0' } } }))
  write('node_modules/electron/dist/electron.exe', 'fixture only: never executable')
  write('node_modules/electron/dist/version', options.version ?? '33.4.11')
  for (const file of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) write(file, 'fixture only')
  // Sentinels are entirely synthetic. No real user account or settings files exist
  // in this process; mocked Get-Content additionally rejects outside-root reads.
  write('fixture-settings/config.json', '{"fixture":true,"unchanged":true}')
  write('fixture-settings/accounts.json', '[{"fixture":true}]')
  const sentinels = ['fixture-settings/config.json', 'fixture-settings/accounts.json'].map(relative => ({
    file: path.join(dir, relative), before: fs.readFileSync(path.join(dir, relative), 'utf8'),
  }))
  t.after(() => {
    for (const item of sentinels) assert.equal(fs.readFileSync(item.file, 'utf8'), item.before)
    const resolved = fs.realpathSync(dir)
    const allowed = fs.realpathSync(fixtureParent) + path.sep
    assert.ok(resolved.startsWith(allowed), 'recursive fixture cleanup stays inside this checkout')
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return { dir, electron: path.join(dir, 'node_modules/electron/dist/electron.exe') }
}

function run(f, options = {}) {
  const script = path.join(f.dir, 'scripts', options.launcher ? 'start-local.ps1' : 'update-runtime.ps1')
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$global:FixtureRoot = ${quote(f.dir)}
$global:FixtureCalls = @()
$global:FixtureLaunches = @()
$global:FixtureReads = @()
$global:FixtureError = $null
$global:FixtureResult = $null
$global:LASTEXITCODE = 0
function Get-CimInstance {
  param($ClassName, $Filter)
  foreach ($item in (${quote(JSON.stringify(options.processes || []))} | ConvertFrom-Json)) { $item }
}
function Get-Content {
  param([string]$LiteralPath, [switch]$Raw)
  $resolved = [IO.Path]::GetFullPath($LiteralPath)
  if (-not $resolved.StartsWith($global:FixtureRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Attempted read outside isolated runtime fixture' }
  if ($resolved -match 'fixture-settings') { throw 'Attempted read of account/settings sentinels' }
  $global:FixtureReads += $resolved
  Microsoft.PowerShell.Management\Get-Content -LiteralPath $resolved -Raw:$Raw
}
function Get-Command {
  param($Name, $ErrorAction)
  if ($Name -eq 'npm.cmd') { return [pscustomobject]@{ Source = 'Invoke-FixtureNpm' } }
  if ($Name -eq 'node.exe') { return [pscustomobject]@{ Source = 'Invoke-FixtureNode' } }
  throw 'Unexpected command lookup during fixture'
}
function Invoke-FixtureNpm {
  $global:FixtureCalls += [pscustomobject]@{ Kind = 'npm'; Arguments = @($args); Directory = (Get-Location).Path }
  $global:LASTEXITCODE = ${options.npmExit ?? 0}
}
function Invoke-FixtureNode {
  $global:FixtureCalls += [pscustomobject]@{ Kind = 'node'; Arguments = @($args); Directory = (Get-Location).Path }
  $global:LASTEXITCODE = ${options.nodeExit ?? 0}
  if ($global:LASTEXITCODE -eq 0) {
    [IO.File]::WriteAllText((Join-Path $global:FixtureRoot 'node_modules\electron\dist\version'), ${quote(options.installedVersion ?? '44.2.0')})
    ${options.removeRuntime ? "Remove-Item -LiteralPath (Join-Path $global:FixtureRoot 'node_modules\\electron\\dist\\electron.exe')" : ''}
  }
}
function Start-Process {
  param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru, $RedirectStandardOutput, $RedirectStandardError)
  $global:FixtureLaunches += [pscustomobject]@{ File = $FilePath; Arguments = $ArgumentList; Directory = $WorkingDirectory; WindowStyle = $WindowStyle }
  $fake = [pscustomobject]@{ HasExited = $false; MainWindowHandle = [IntPtr]1; Id = 987 }
  $fake | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
  return $fake
}
function Stop-Process { throw 'Process termination must never occur' }
function Start-Sleep { param($Seconds) }
function Out-Host { param([Parameter(ValueFromPipeline=$true)]$InputObject) process { } }
$beforeLocation = (Get-Location).Path
try { $global:FixtureResult = & ${quote(script)} ${options.args || ''} }
catch { $global:FixtureError = $_.Exception.Message }
[pscustomobject]@{
  Result = $global:FixtureResult
  Error = $global:FixtureError
  Calls = @($global:FixtureCalls)
  Launches = @($global:FixtureLaunches)
  Reads = @($global:FixtureReads)
  LocationRestored = ((Get-Location).Path -eq $beforeLocation)
} | ConvertTo-Json -Compress -Depth 8
`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return JSON.parse(result.stdout)
}

windowsTest('runtime updater refuses any running checkout runtime before installation or file changes', t => {
  const f = fixture(t)
  const packageBefore = fs.readFileSync(path.join(f.dir, 'package.json'), 'utf8')
  const lockBefore = fs.readFileSync(path.join(f.dir, 'package-lock.json'), 'utf8')
  const result = run(f, { processes: [{ ProcessId: 111, ExecutablePath: f.electron, CommandLine: `"${f.electron}" --type=renderer` }] })
  assert.match(result.Error, /still running/)
  assert.deepEqual(result.Calls, [])
  assert.deepEqual(result.Launches, [])
  assert.equal(fs.readFileSync(path.join(f.dir, 'package.json'), 'utf8'), packageBefore)
  assert.equal(fs.readFileSync(path.join(f.dir, 'package-lock.json'), 'utf8'), lockBefore)
  assert.equal(fs.readFileSync(path.join(f.dir, 'node_modules/electron/dist/version'), 'utf8'), '33.4.11')
})

windowsTest('runtime updater requires an exact stable pin and matching lock before commands', t => {
  for (const options of [{ pin: '^44.2.0' }, { pin: '44.2.0-beta.1' }, { lock: '43.1.0' }]) {
    const f = fixture(t, options)
    const result = run(f)
    assert.match(result.Error, /exact stable version|does not match/)
    assert.deepEqual(result.Calls, [])
    assert.deepEqual(result.Launches, [])
  }
})

windowsTest('runtime updater uses only mocked package and official installer commands, then verifies version', t => {
  const f = fixture(t)
  const result = run(f, { processes: [{ ProcessId: 222, ExecutablePath: 'C:\\Unrelated\\electron.exe' }] })
  assert.equal(result.Error, null)
  assert.deepEqual(result.Result, {
    Updated: true, Electron: '44.2.0', SavedSettings: 'Not read or changed', NextStep: '.\\scripts\\start-local.ps1 -Build',
  })
  assert.deepEqual(result.Calls, [
    { Kind: 'npm', Arguments: ['install', '--ignore-scripts', '--no-audit', '--no-fund'], Directory: f.dir },
    { Kind: 'node', Arguments: [path.join(f.dir, 'node_modules/electron/install.js')], Directory: f.dir },
  ])
  assert.deepEqual(result.Launches, [])
  assert.equal(result.LocationRestored, true)
})

windowsTest('launcher stops after dependency installation fails and never starts an old runtime', t => {
  const f = fixture(t)
  const result = run(f, { launcher: true, args: '-UpdateRuntime -Build', npmExit: 7 })
  assert.match(result.Error, /Dependency installation failed \(exit 7\)/)
  assert.deepEqual(result.Calls.map(call => call.Kind), ['npm'])
  assert.deepEqual(result.Launches, [])
  assert.equal(result.LocationRestored, true)
})

windowsTest('launcher stops after Electron installer failure and does not build or launch', t => {
  const f = fixture(t)
  const result = run(f, { launcher: true, args: '-UpdateRuntime -Build', nodeExit: 9 })
  assert.match(result.Error, /Electron installation failed \(exit 9\)/)
  assert.deepEqual(result.Calls.map(call => call.Kind), ['npm', 'node'])
  assert.deepEqual(result.Launches, [])
  assert.equal(result.LocationRestored, true)
})

windowsTest('runtime updater rejects mismatched installed version or missing executable after fake installer success', t => {
  for (const options of [{ installedVersion: '43.0.0' }, { removeRuntime: true }]) {
    const f = fixture(t)
    const result = run(f, { ...options, launcher: true, args: '-UpdateRuntime -Build' })
    assert.match(result.Error, /runtime verification failed/)
    assert.deepEqual(result.Calls.map(call => call.Kind), ['npm', 'node'])
    assert.deepEqual(result.Launches, [])
  }
})

windowsTest('launcher refuses a mismatched pinned runtime without an explicit update', t => {
  const f = fixture(t)
  const result = run(f, { launcher: true, args: '-Build' })
  assert.match(result.Error, /installed browser engine is not Electron 44\.2\.0/)
  assert.deepEqual(result.Calls, [])
  assert.deepEqual(result.Launches, [])
})

windowsTest('launcher preflight cannot be combined with runtime updates and stays read-only', t => {
  const f = fixture(t)
  const result = run(f, { launcher: true, args: '-Preflight -UpdateRuntime' })
  assert.match(result.Error, /mutually exclusive.*read-only/)
  assert.deepEqual(result.Calls, [])
  assert.deepEqual(result.Launches, [])
  assert.deepEqual(result.Reads, [])
  assert.equal(fs.existsSync(path.join(f.dir, 'logs')), false)
})

windowsTest('launcher with update refuses running child runtime even when no main window was identified', t => {
  const f = fixture(t)
  const result = run(f, { launcher: true, args: '-UpdateRuntime -Build', processes: [{ ProcessId: 333, ExecutablePath: f.electron, CommandLine: `"${f.electron}" --type=gpu-process` }] })
  assert.match(result.Error, /still running/)
  assert.deepEqual(result.Calls, [])
  assert.deepEqual(result.Launches, [])
})

windowsTest('launcher fake upgrade verifies new runtime before building and opening visible app', t => {
  const f = fixture(t)
  const result = run(f, { launcher: true, args: '-UpdateRuntime -Build' })
  assert.equal(result.Error, null)
  assert.equal(result.Result.Started, true)
  assert.deepEqual(result.Calls.map(call => [call.Kind, ...call.Arguments]), [
    ['npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund'],
    ['node', path.join(f.dir, 'node_modules/electron/install.js')],
    ['npm', 'run', 'build'],
  ])
  assert.deepEqual(result.Launches, [{ File: f.electron, Arguments: `"${f.dir}"`, Directory: f.dir, WindowStyle: 'Normal' }])
  assert.equal(result.LocationRestored, true)
})
