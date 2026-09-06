const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const parent = path.join(root, '.audit-cache', 'restart-local-tests')
const ps = value => `'${String(value).replaceAll("'", "''")}'`
const windowsTest = process.platform === 'win32' ? test : test.skip
function fixture(t) {
  fs.mkdirSync(parent, { recursive: true })
  const dir = fs.mkdtempSync(path.join(parent, 'app-'))
  const script = path.join(dir, 'scripts/restart-local.ps1'), electron = path.join(dir, 'node_modules/electron/dist/electron.exe')
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.mkdirSync(path.dirname(electron), { recursive: true })
  fs.copyFileSync(path.join(root, 'scripts/restart-local.ps1'), script)
  fs.writeFileSync(electron, 'fixture: never executed')
  fs.writeFileSync(path.join(dir, 'scripts/start-local.ps1'), `param([switch]$Build)\n$global:starts++; $global:built = [bool]$Build\n[pscustomobject]@{ Started = $true; Fixture = $true }\n`)
  t.after(() => { const canonical = fs.realpathSync(dir); assert.ok(canonical.startsWith(fs.realpathSync(parent) + path.sep)); fs.rmSync(canonical, { recursive: true, force: true }) })
  const main = { ProcessId: 100001, ParentProcessId: 99999, CreationDate: '2026-09-06T01:00:00.000Z', ExecutablePath: electron, CommandLine: `"${electron}" "${dir}"` }
  const child = (id, parentId, suffix = '--type=renderer') => ({ ProcessId: id, ParentProcessId: parentId, CreationDate: '2026-09-06T01:00:01.000Z', ExecutablePath: electron, CommandLine: `"${electron}" ${suffix}` })
  return { dir, script, electron, main, child }
}
function run(f, { records = [f.main], scenario = 'graceful', setup = '', args = '', executable = 'powershell.exe' } = {}) {
  const source = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$parsedRecords = ${ps(JSON.stringify(records))} | ConvertFrom-Json
$global:records = @(); foreach($record in $parsedRecords){ $global:records += $record }
$global:dispatches = 0; $global:starts = 0; $global:built = $false; $global:stops = @(); $global:sleeps = 0; $global:queries = 0
function Get-CimInstance {
  param($ClassName,$Filter)
  if ($ClassName -ne 'Win32_Process' -or $Filter -ne "Name = 'electron.exe'") { throw 'Invalid metadata query' }
  $global:queries++
  foreach($entry in $global:records){ $entry }
}
function Start-Process {
  param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru)
  $global:dispatches++
  $global:observed = @{ file=$FilePath; arguments=$ArgumentList; window=$WindowStyle; node=(Test-Path Env:ELECTRON_RUN_AS_NODE); renderer=(Test-Path Env:ELECTRON_RENDERER_URL); environment=$env:NODE_ENV }
  if (${ps(scenario)} -eq 'dispatch-error') { throw 'fixture dispatch failure' }
  if (${ps(scenario)} -eq 'graceful') { $global:records = @($global:records | Where-Object { $_.ProcessId -ne 100001 }) }
  return [pscustomobject]@{ Id=199999 }
}
function Start-Sleep {
  param($Milliseconds)
  if($Milliseconds -ne 250){throw 'Invalid polling interval'}
  $global:sleeps++
  if (${ps(scenario)} -eq 'root-reuse' -and $global:sleeps -eq 1) { $global:records[0].CreationDate='2026-09-06T02:00:00.000Z' }
}
function Stop-Process {
  param($Id,[switch]$Force,$ErrorAction)
  if(-not $Force){throw 'Expected explicit forced stop after grace period'}
  $global:stops += [long]$Id
  $global:records = @($global:records | Where-Object { $_.ProcessId -ne $Id })
  if (${ps(scenario)} -eq 'child-reuse' -and $Id -eq 100001) {
    foreach($entry in $global:records){ if($entry.ProcessId -eq 100002){$entry.CreationDate='2026-09-06T02:00:00.000Z'} }
  }
}
${setup}
$errorText=$null; $result=$null
try { $result = @(& ${ps(f.script)} ${args}) } catch { $errorText=$_.Exception.Message }
@{ error=$errorText; result=$result; starts=$starts; built=$built; dispatches=$dispatches; stops=@($stops); sleeps=$sleeps; queries=$queries;
 observed=$(if(Get-Variable observed -ErrorAction SilentlyContinue){$observed}else{$null}); nodePresent=(Test-Path Env:ELECTRON_RUN_AS_NODE); node=$env:ELECTRON_RUN_AS_NODE; environment=$env:NODE_ENV; renderer=$env:ELECTRON_RENDERER_URL } | ConvertTo-Json -Compress -Depth 6
`
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', source], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000 })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

windowsTest('restart requests graceful quit once with hidden command-only helper and restores environment', t => {
  const f = fixture(t), result = run(f, { setup: "$env:ELECTRON_RUN_AS_NODE='inherited';$env:NODE_ENV='development';$env:ELECTRON_RENDERER_URL='fixture-url'", args: '-Build' })
  assert.equal(result.error, null)
  assert.equal(result.dispatches, 1)
  assert.equal(result.starts, 1)
  assert.equal(result.built, true)
  assert.deepEqual(result.stops, [])
  assert.deepEqual(result.observed, { file: f.electron, arguments: `"${f.dir}" --chat2api-quit`, window: 'Hidden', node: false, renderer: false, environment: 'production' })
  assert.equal(result.node, 'inherited'); assert.equal(result.environment, 'development'); assert.equal(result.renderer, 'fixture-url')
})

windowsTest('restart starts normally when no main exists and never dispatches quit or kills another app', t => {
  const f = fixture(t)
  const result = run(f, { records: [{ ...f.main, ExecutablePath: 'C:\\unrelated\\electron.exe' }, { ...f.main, ExecutablePath: 'C:\\Chrome\\chrome.exe' }] })
  assert.equal(result.error, null); assert.equal(result.starts, 1); assert.equal(result.dispatches, 0); assert.deepEqual(result.stops, [])
})

windowsTest('forced restart waits twenty seconds and stops only freshly verified root and Electron descendants', t => {
  const f = fixture(t)
  const result = run(f, { scenario: 'force', records: [f.main, f.child(100002, 100001), f.child(100003, 100002, '--type=utility'),
    f.child(100004, 99998), { ...f.child(100005, 100001), ExecutablePath: 'C:\\Chrome\\chrome.exe' },
    { ...f.child(100006, 100001), CreationDate: '2026-09-05T00:00:00.000Z' }] })
  assert.equal(result.error, null)
  assert.equal(result.sleeps, 80)
  assert.deepEqual(result.stops, [100001, 100003, 100002])
  assert.equal(result.starts, 1)
  assert.ok(result.queries > 80)
})

windowsTest('restart refuses ambiguous or nonexact root commands before dispatch or stopping anything', t => {
  const f = fixture(t)
  for (const records of [[f.main, { ...f.main, ProcessId: 100007 }], [{ ...f.main, CommandLine: f.main.CommandLine + ' --unknown-flag' }],
    [{ ...f.main, CreationDate: null }], [{ ...f.main, CommandLine: `"${f.electron}" "${f.dir}-lookalike"` }]]) {
    const result = run(f, { records })
    assert.match(result.error, /Ambiguous|identity|creation time/)
    assert.equal(result.dispatches, 0); assert.equal(result.starts, 0); assert.deepEqual(result.stops, [])
  }
})

windowsTest('restart never stops a root or descendant PID whose creation time changed', t => {
  const f = fixture(t)
  const rootReuse = run(f, { scenario: 'root-reuse' })
  assert.match(rootReuse.error, /identity changed|PID was reused/)
  assert.deepEqual(rootReuse.stops, []); assert.equal(rootReuse.starts, 0)
  const childReuse = run(f, { scenario: 'child-reuse', records: [f.main, f.child(100002, 100001)] })
  assert.match(childReuse.error, /identity changed|PID was reused/)
  assert.deepEqual(childReuse.stops, [100001]); assert.equal(childReuse.starts, 0)
})

windowsTest('quit dispatch failure restores environment and never escalates to a forced kill', t => {
  const f = fixture(t), result = run(f, { scenario: 'dispatch-error', setup: "$env:ELECTRON_RUN_AS_NODE='parent';$env:NODE_ENV='development';$env:ELECTRON_RENDERER_URL='parent-url'" })
  assert.equal(result.error, 'fixture dispatch failure')
  assert.equal(result.node, 'parent'); assert.equal(result.environment, 'development'); assert.equal(result.renderer, 'parent-url')
  assert.deepEqual(result.stops, []); assert.equal(result.starts, 0)
})

const hasPwsh = process.platform === 'win32' && spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true, timeout: 10000 }).status === 0
test('restart preserves absent and empty inherited Node-mode variables on PowerShell 7', { skip: !hasPwsh }, t => {
  const f = fixture(t)
  for (const present of [false, true]) {
    const result = run(f, { executable: 'pwsh.exe', setup: present ? "$env:ELECTRON_RUN_AS_NODE=''" : 'Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue' })
    assert.equal(result.error, null); assert.equal(result.nodePresent, present); assert.equal(result.node, present ? '' : null)
    assert.equal(result.observed.node, false); assert.equal(result.starts, 1)
  }
})
