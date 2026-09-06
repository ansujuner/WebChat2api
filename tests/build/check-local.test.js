const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const parent = path.join(root, '.audit-cache', 'check-local-tests')
const ps = value => `'${String(value).replaceAll("'", "''")}'`
const windowsTest = process.platform === 'win32' ? test : test.skip

function fixture(t) {
  fs.mkdirSync(parent, { recursive: true })
  const dir = fs.mkdtempSync(path.join(parent, 'app-'))
  const script = path.join(dir, 'scripts/check-local.ps1')
  const electron = path.join(dir, 'node_modules/electron/dist/electron.exe')
  fs.mkdirSync(path.dirname(script), { recursive: true })
  fs.mkdirSync(path.dirname(electron), { recursive: true })
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true })
  fs.copyFileSync(path.join(root, 'scripts/check-local.ps1'), script)
  fs.writeFileSync(electron, 'fixture: never executed')
  t.after(() => {
    const resolved = fs.realpathSync(dir)
    assert.ok(resolved.startsWith(fs.realpathSync(parent) + path.sep))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return { dir, script, electron }
}

function run(f, { args = '', processes, setup = '', launch = '', command, executable = 'powershell.exe' } = {}) {
  const metadata = processes || [{ ExecutablePath: f.electron, CommandLine: `"${f.electron}" "${f.dir}"`, ProcessId: 111 }]
  const source = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
function Get-CimInstance { foreach ($item in (${ps(JSON.stringify(metadata))} | ConvertFrom-Json)) { $item } }
$global:launchCount = 0
function Write-FixtureReport {
    param($Mode, $Status = 'ok', $Timestamp = [DateTimeOffset]::UtcNow.ToString('o'))
    $body = @{ status = $Status; checkedAt = $Timestamp; live = ($Mode -notin @('catalog', 'login')); stream = ($Mode -eq 'stream'); protocol = $(if ($Mode -eq 'stream') { 'anthropic' } else { 'openai' }); untrustedExtra = 'fixture-not-for-output' }
    $body | ConvertTo-Json | Set-Content -LiteralPath (Join-Path ${ps(f.dir)} "artifacts\\proxy-$Mode-probe.json") -Encoding UTF8
}
function Start-Process {
    param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, [switch]$PassThru)
    $global:launchCount += 1
    $global:observed = @{ path = $FilePath; arguments = $ArgumentList; window = $WindowStyle; nodeKey = (Test-Path Env:ELECTRON_RUN_AS_NODE); nodeEnv = $env:NODE_ENV; rendererKey = (Test-Path Env:ELECTRON_RENDERER_URL) }
    ${launch || "Write-FixtureReport -Mode (($ArgumentList -split '--chat2api-probe=')[1])"}
    return [pscustomobject]@{ Id = 222 }
}
${setup}
${command || `& ${ps(f.script)} ${args} | ConvertTo-Json -Compress -Depth 4`}
`
  // Private shell + mocked process APIs: no real app dispatch/profile reads.
  return spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', source], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 20000 })
}

windowsTest('catalog checks target one existing app with a hidden command-only child and no secret output', t => {
  const f = fixture(t)
  const result = run(f, { command: `$result = & ${ps(f.script)}; @{ result = $result; observed = $observed; launchCount = $launchCount } | ConvertTo-Json -Compress -Depth 4` })
  assert.equal(result.status, 0, result.stderr)
  const value = JSON.parse(result.stdout)
  assert.equal(value.result.Mode, 'catalog')
  assert.equal(value.result.Status, 'ok')
  assert.equal(value.launchCount, 1)
  assert.equal(value.observed.window, 'Hidden')
  assert.equal(value.observed.arguments, `"${f.dir}" --chat2api-probe=catalog`)
  assert.equal(value.observed.nodeKey, false)
  assert.equal(value.observed.rendererKey, false)
  assert.equal(value.observed.nodeEnv, 'production')
  assert.doesNotMatch(result.stdout, /fixture-not-for-output/)
})

windowsTest('live generation is explicit and streaming requires the additional live opt-in', t => {
  const f = fixture(t)
  const invalid = run(f, { args: '-Stream' })
  assert.notEqual(invalid.status, 0)
  assert.match(invalid.stderr, /requires -Live/)
  for (const args of ['-Live', '-Live -Stream']) {
    const result = run(f, { args })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).Mode, args.includes('-Stream') ? 'stream' : 'live')
  }
})

windowsTest('no existing app or only renderer/command processes never launches another main app', t => {
  const f = fixture(t)
  for (const processes of [[], [
    { ExecutablePath: f.electron, CommandLine: `"${f.electron}" --type=renderer` },
    { ExecutablePath: f.electron, CommandLine: `"${f.electron}" "${f.dir}" --chat2api-probe=catalog` },
  ]]) {
    const result = run(f, { processes })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Exactly one running main app/)
  }
})

windowsTest('stale or pending reports cannot be reported as a fresh completed result and no command is retried', t => {
  const f = fixture(t)
  for (const launch of [
    "Write-FixtureReport -Mode catalog -Timestamp ([DateTimeOffset]::UtcNow.AddHours(-1).ToString('o'))",
    "Write-FixtureReport -Mode catalog -Status running",
  ]) {
    const result = run(f, { launch, command: `try { & ${ps(f.script)} -TimeoutSeconds 1 } catch { @{ error = $_.Exception.Message; launches = $launchCount } | ConvertTo-Json -Compress }` })
    assert.equal(result.status, 0, result.stderr)
    const value = JSON.parse(result.stdout)
    assert.equal(value.launches, 1)
    assert.match(value.error, /No fresh completed catalog report/)
  }
})

windowsTest('environment is restored after dispatch errors', t => {
  const f = fixture(t)
  const result = run(f, { setup: "$env:ELECTRON_RUN_AS_NODE = 'inherited'; $env:NODE_ENV = 'development'; $env:ELECTRON_RENDERER_URL = 'fixture-url'",
    launch: "throw 'fixture dispatch failure'",
    command: `try { & ${ps(f.script)} } catch { @{ error = $_.Exception.Message; node = $env:ELECTRON_RUN_AS_NODE; env = $env:NODE_ENV; url = $env:ELECTRON_RENDERER_URL } | ConvertTo-Json -Compress }`,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { error: 'fixture dispatch failure', node: 'inherited', env: 'development', url: 'fixture-url' })
})

const hasPwsh = process.platform === 'win32' && spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true, timeout: 10000 }).status === 0
test('PowerShell 7 preserves both absent and empty inherited Node-mode variables', { skip: !hasPwsh }, t => {
  const f = fixture(t)
  for (const present of [false, true]) {
    const result = run(f, { executable: 'pwsh.exe', setup: present ? "$env:ELECTRON_RUN_AS_NODE = ''" : 'Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
      command: `& ${ps(f.script)} -TimeoutSeconds 2 | Out-Null; @{ exists = (Test-Path Env:ELECTRON_RUN_AS_NODE); value = $env:ELECTRON_RUN_AS_NODE; child = $observed.nodeKey } | ConvertTo-Json -Compress`,
    })
    assert.equal(result.status, 0, result.stderr)
    const value = JSON.parse(result.stdout)
    assert.equal(value.exists, present)
    assert.equal(value.child, false)
    assert.equal(value.value, present ? '' : null)
  }
})

test('PowerShell 7 accepts fresh ISO timestamps parsed as DateTime without losing timezone or milliseconds', { skip: !hasPwsh }, t => {
  const f = fixture(t)
  const result = run(f, { executable: 'pwsh.exe', args: '-TimeoutSeconds 2' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).Mode, 'catalog')
  const stale = run(f, { executable: 'pwsh.exe', args: '-TimeoutSeconds 1',
    launch: "Write-FixtureReport -Mode catalog -Timestamp ([DateTimeOffset]::UtcNow.AddHours(-1).ToString('o'))",
  })
  assert.notEqual(stale.status, 0)
  assert.match(stale.stderr, /No fresh completed catalog report/)
})

windowsTest('new DeepSeek check modes dispatch once with exact report paths in PowerShell 5 and 7', t => {
  const f = fixture(t)
  for (const executable of ['powershell.exe', ...(hasPwsh ? ['pwsh.exe'] : [])]) {
    for (const [args, mode] of [['-Live -DeepSeekAllModes', 'deepseek'], ['-DeepSeekLogin', 'login']]) {
      const result = run(f, { executable,
        command: `$result = & ${ps(f.script)} ${args} -TimeoutSeconds 2; @{ result = $result; observed = $observed; launches = $launchCount } | ConvertTo-Json -Compress -Depth 4`,
      })
      assert.equal(result.status, 0, `${executable}: ${result.stderr}`)
      const value = JSON.parse(result.stdout)
      assert.equal(value.result.Mode, mode)
      assert.equal(value.result.Report, path.join(f.dir, `artifacts/proxy-${mode}-probe.json`))
      assert.equal(value.observed.arguments, `"${f.dir}" --chat2api-probe=${mode}`)
      assert.equal(value.observed.window, 'Hidden')
      assert.equal(value.launches, 1)
      assert.doesNotMatch(result.stdout, /fixture-not-for-output/)
    }
  }
})

windowsTest('DeepSeek modes reject ambiguous or missing generation opt-in before any child is launched', t => {
  const f = fixture(t)
  for (const args of ['-DeepSeekAllModes', '-DeepSeekAllModes -Stream -Live', '-DeepSeekLogin -Live', '-DeepSeekLogin -Live -Stream', '-DeepSeekLogin -Live -DeepSeekAllModes']) {
    const result = run(f, {
      command: `try { & ${ps(f.script)} ${args} } catch { @{ error = $_.Exception.Message; launches = $launchCount } | ConvertTo-Json -Compress }`,
    })
    assert.equal(result.status, 0, result.stderr)
    const value = JSON.parse(result.stdout)
    assert.equal(value.launches, 0)
    assert.match(value.error, /requires -Live|cannot be combined/)
  }
})

windowsTest('awaiting_login is progress only, and a fresh final result is awaited without redispatch', t => {
  const f = fixture(t)
  for (const executable of ['powershell.exe', ...(hasPwsh ? ['pwsh.exe'] : [])]) {
    const result = run(f, { executable,
      setup: '$global:polls = 0; function Start-Sleep { param($Milliseconds) $global:polls += 1; Write-FixtureReport -Mode login -Status passed }',
      launch: 'Write-FixtureReport -Mode login -Status awaiting_login',
      command: `$result = & ${ps(f.script)} -DeepSeekLogin -TimeoutSeconds 2; @{ result = $result; polls = $polls; launches = $launchCount } | ConvertTo-Json -Compress -Depth 3`,
    })
    assert.equal(result.status, 0, result.stderr)
    const value = JSON.parse(result.stdout)
    assert.equal(value.result.Status, 'passed')
    assert.equal(value.result.Mode, 'login')
    assert.equal(value.polls, 1)
    assert.equal(value.launches, 1)
  }
})

windowsTest('pending, stale, and mismatched login reports time out rather than imply login success', t => {
  const f = fixture(t)
  for (const launch of [
    'Write-FixtureReport -Mode login -Status awaiting_login',
    "Write-FixtureReport -Mode login -Timestamp ([DateTimeOffset]::UtcNow.AddHours(-1).ToString('o'))",
    `Write-FixtureReport -Mode deepseek; Copy-Item -LiteralPath (Join-Path ${ps(f.dir)} 'artifacts/proxy-deepseek-probe.json') -Destination (Join-Path ${ps(f.dir)} 'artifacts/proxy-login-probe.json')`,
  ]) {
    const result = run(f, { launch,
      command: `try { & ${ps(f.script)} -DeepSeekLogin -TimeoutSeconds 1 } catch { @{ error = $_.Exception.Message; launches = $launchCount } | ConvertTo-Json -Compress }`,
    })
    assert.equal(result.status, 0, result.stderr)
    const value = JSON.parse(result.stdout)
    assert.equal(value.launches, 1)
    assert.match(value.error, /No fresh completed login report/)
  }
})

windowsTest('tool smoke launcher requires explicit Live and rejects mixed diagnostic modes before dispatch', t => {
  const f = fixture(t)
  for (const args of ['-Tools', '-Tools -Live -Stream', '-Tools -Live -DeepSeekAllModes', '-Tools -DeepSeekLogin']) {
    const result = run(f, { args })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /requires -Live|cannot be combined/)
  }
  const result = run(f, { args: '-Tools -Live' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).Mode, 'tools')
  assert.doesNotMatch(result.stdout, /fixture-not-for-output/)
})
