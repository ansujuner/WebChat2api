/** CI-only asynchronous launcher for the released, otherwise unchanged 62-check fixture. */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const workspace = path.resolve(__dirname, '..')
const inside = (target, base) => {
  const relative = path.relative(base, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}
const safeLines = text => text.split(/\r?\n/)
  .filter(line => /error|assert|failed|timeout|timed out|keychain|securityagent|oscrypt|SecItem|SecKeychain/i.test(line))
  .filter(line => !/token|cookie|credential|authorization|bearer|password|secret|eyJ[A-Za-z0-9_-]{15}|https?:\/\//i.test(line))
  .slice(-20).map(line => line.slice(0, 350))

async function main() {
  assert.ok(/^(true|1)$/i.test(process.env.CI || ''), 'Platform smoke requires a disposable CI runner')
  assert.ok(['darwin', 'linux'].includes(process.platform), 'Platform smoke requires native macOS or Linux')
  assert.equal(process.argv.length, 4)
  assert.equal(process.argv[2], '--source')
  const source = fs.realpathSync(process.argv[3])
  assert.ok(inside(source, workspace), 'Source must remain inside the tools workspace')
  const harness = path.join(source, 'scripts/smoke-app.cjs')
  const original = fs.readFileSync(harness)
  const originalText = original.toString('utf8')
  const progressPoint = 'const check = name => report.checks.push(name)'
  const startPoint = "try { require(path.join(root, 'out/main/index.js')) }"
  assert.equal(originalText.split(progressPoint).length, 2, 'Unexpected source fixture progress callback')
  assert.equal(originalText.split(startPoint).length, 2, 'Unexpected source fixture startup')
  const observedText = originalText.replace(progressPoint,
    "const check = name => { report.checks.push(name); fs.writeFileSync(path.join(fixture, 'report.json'), JSON.stringify(report, null, 2)) }")
    .replace(startPoint, `write(); ${startPoint}`)
  const cache = path.join(source, '.audit-cache')
  fs.mkdirSync(cache, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(cache, 'app-runtime-smoke-'))
  const dirs = Object.fromEntries(['home', 'roaming', 'local', 'userData', 'sessionData', 'temp', 'logs'].map(name => [name, path.join(fixture, name)]))
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'chat2api-isolated-smoke', version: '1.0.0', main: harness }))
  const env = { ...process.env, USERPROFILE: dirs.home, HOME: dirs.home, APPDATA: dirs.roaming,
    LOCALAPPDATA: dirs.local, TEMP: dirs.temp, TMP: dirs.temp, TMPDIR: dirs.temp,
    XDG_CONFIG_HOME: dirs.roaming, XDG_CACHE_HOME: dirs.local, XDG_DATA_HOME: dirs.local,
    NODE_ENV: 'production', CHAT2API_SMOKE_ROOT: fixture }
  for (const key of Object.keys(env)) {
    if (/^(ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|SSLKEYLOGFILE)$/i.test(key)) delete env[key]
  }
  const executable = require(require.resolve('electron', { paths: [source] }))
  assert.ok(inside(fs.realpathSync(executable), source), 'Electron executable must belong to the source install')
  let child, timer, sampleTimer, sampler, timedOut = false, stderr = '', nativeDiagnostic = ''
  const killGroup = () => {
    if (!child?.pid) return
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  const reportFile = path.join(fixture, 'report.json')
  const output = path.join(source, 'artifacts/runtime-app-smoke.json')
  const bound = text => text.slice(-128 * 1024)
  try {
    fs.writeFileSync(harness, observedText)
    child = spawn(executable, [fixture], { cwd: source, env, shell: false, detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr.on('data', data => { stderr = bound(stderr + data.toString('utf8')) })
    timer = setTimeout(() => {
      timedOut = true
      killGroup()
    }, 150000)
    // sample is read-only and limited to this tracked fixture process. Export only
    // filtered stack symbols on failure, never a full process dump or environment.
    if (process.platform === 'darwin') {
      sampleTimer = setTimeout(() => {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
        sampler = spawn('/usr/bin/sample', [String(child.pid), '1', '1', '-file', '/dev/stdout'], {
          env, shell: false, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, killSignal: 'SIGKILL',
        })
        sampler.stdout.on('data', data => { nativeDiagnostic = bound(nativeDiagnostic + data.toString('utf8')) })
        sampler.on('error', () => { nativeDiagnostic = '' })
      }, 100000)
    }
    const exit = await new Promise(resolve => {
      child.once('error', error => resolve({ code: null, error: error.message }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    clearTimeout(timer)
    clearTimeout(sampleTimer)
    let inner = { passed: false, checks: [], error: 'Fixture exited before writing its first report' }
    if (fs.existsSync(reportFile)) {
      try { inner = JSON.parse(fs.readFileSync(reportFile, 'utf8')) }
      catch { inner = { passed: false, checks: [], error: 'Fixture report is incomplete' } }
    }
    const passed = !timedOut && inner.passed === true && inner.cleanQuit === true && exit.code === 0
    const errorText = typeof inner.error === 'string' ? safeLines(inner.error).join('\n') || 'Fixture failed before completing its checks' : undefined
    const stopErrorText = typeof inner.stopError === 'string' ? safeLines(inner.stopError).join('\n') || 'Fixture shutdown failed' : undefined
    const report = { ...inner, ...(errorText ? { error: errorText } : {}), ...(stopErrorText ? { stopError: stopErrorText } : {}),
      passed, childExitCode: exit.code, childSignal: exit.signal || null,
      productionProfileUsed: false, nativeLauncher: true, fixtureRoot: fixture, timedOut,
      ...(timedOut ? { error: 'Isolated application exceeded the external 150-second hard deadline' } : {}),
      ...(!passed ? { stderrDiagnostic: safeLines(stderr), nativeDiagnostic: safeLines(nativeDiagnostic) } : {}) }
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = passed ? 0 : 1
  } finally {
    clearTimeout(timer)
    clearTimeout(sampleTimer)
    if (sampler && sampler.exitCode === null && sampler.signalCode === null) sampler.kill('SIGKILL')
    killGroup()
    // This edits only fixture observability; restore the source bytes before packaging.
    assert.equal(fs.readFileSync(harness, 'utf8'), observedText, 'Fixture changed concurrently; refusing to replace unrelated edits')
    fs.writeFileSync(harness, original)
    assert.ok(fs.readFileSync(harness).equals(original), 'Released fixture was not restored byte-for-byte')
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
