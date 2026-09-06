/**
 * CI-only smoke of the actual packaged executable, using a disposable profile.
 * Usage: node scripts/smoke-packaged-app.cjs --executable <absolute binary>
 *        [--source <source checkout>] [--report <source artifacts JSON path>]
 * No provider requests, credentials, existing profiles, or runtime logs are exported.
 */
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')

const workspace = path.resolve(__dirname, '..')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

function inside(target, directory) {
  const relative = path.relative(directory, path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function options(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    assert.ok(['--source', '--executable', '--report'].includes(name), `Unknown option: ${name}`)
    assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--'), `Missing value: ${name}`)
    assert.equal(parsed[name], undefined, `Duplicate option: ${name}`)
    parsed[name] = argv[index + 1]
  }
  assert.ok(parsed['--executable'] && path.isAbsolute(parsed['--executable']), '--executable must be an absolute packaged binary path')
  return parsed
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

function childProcess(executable, args, env, cwd) {
  const process = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: 'ignore' })
  const state = { process, settled: false, result: null }
  state.completion = new Promise(resolve => {
    const finish = result => {
      if (state.settled) return
      state.settled = true
      state.result = result
      resolve(result)
    }
    process.once('error', error => finish({ code: null, signal: null, error: error.message }))
    process.once('exit', (code, signal) => finish({ code, signal }))
  })
  return state
}

async function waitExit(child, timeout) {
  const end = Date.now() + timeout
  while (!child.settled && Date.now() < end) await delay(100)
  if (!child.settled) throw new Error('Packaged executable did not exit before the deadline')
  return child.result
}

async function connect(url) {
  const parsed = new URL(url)
  assert.equal(parsed.protocol, 'ws:')
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname), 'CDP must be loopback-only')
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Loopback CDP connection timed out')) }, 10000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Loopback CDP connection failed')) }, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(message.error.message))
    else request.resolve(message.result)
  })
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Loopback CDP connection closed'))
    }
    pending.clear()
  })
  return {
    close: () => socket.close(),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP command timed out: ${method}`)) }, 25000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    }),
  }
}

async function main() {
  // CI is required even when callers supply an otherwise valid executable.
  assert.ok(/^(1|true)$/i.test(process.env.CI || ''), 'Packaged smoke is restricted to CI disposable runners')
  assert.ok(['darwin', 'linux'].includes(process.platform), 'This smoke targets native macOS and Linux runners')
  const parsed = options(process.argv.slice(2))
  const root = fs.realpathSync(parsed['--source'] || workspace)
  assert.ok(inside(root, workspace), 'Source checkout must remain inside the tools workspace')
  const executable = fs.realpathSync(parsed['--executable'])
  assert.ok(inside(executable, root), 'Packaged executable must remain inside the checkout')
  assert.ok(fs.statSync(executable).isFile(), 'Packaged executable is not a file')
  const reportFile = path.resolve(parsed['--report'] || path.join(root, 'artifacts/runtime-packaged-smoke.json'))
  assert.ok(inside(reportFile, path.join(root, 'artifacts')), 'Report must remain under workspace artifacts')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const cache = path.join(root, '.audit-cache')
  fs.mkdirSync(cache, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(cache, 'packaged-app-smoke-'))
  const directories = Object.fromEntries(['home', 'userData', 'config', 'cache', 'data', 'runtime', 'temp'].map(name => [name, path.join(fixture, name)]))
  for (const directory of Object.values(directories)) fs.mkdirSync(directory, { mode: 0o700 })
  const env = {
    ...process.env,
    HOME: directories.home, USERPROFILE: directories.home,
    APPDATA: directories.config, LOCALAPPDATA: directories.data,
    XDG_CONFIG_HOME: directories.config, XDG_CACHE_HOME: directories.cache,
    XDG_DATA_HOME: directories.data, XDG_RUNTIME_DIR: directories.runtime,
    TMPDIR: directories.temp, TMP: directories.temp, TEMP: directories.temp,
    NODE_ENV: 'production',
  }
  for (const key of Object.keys(env)) {
    if (/^(ELECTRON_RUN_AS_NODE|ELECTRON_RENDERER_URL|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|SSLKEYLOGFILE|https?_proxy|all_proxy|no_proxy)$/i.test(key)) delete env[key]
  }
  const port = await freePort()
  const profileFlag = `--user-data-dir=${directories.userData}`
  const report = {
    passed: false, version: manifest.version, platform: process.platform, arch: process.arch,
    productionProfileUsed: false, providerRequestsSubmitted: false, checks: [],
  }
  let app, client
  try {
    app = childProcess(executable, [profileFlag, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`], env, root)
    let target
    const deadline = Date.now() + 45000
    while (!target && Date.now() < deadline) {
      assert.equal(app.settled, false, 'Packaged executable exited before loading its renderer')
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
        assert.equal(response.ok, true)
        const targets = await response.json()
        target = targets.find(item => item.type === 'page' && item.url.startsWith('file:') && /[\\/]renderer[\\/]index\.html(?:[?#]|$)/.test(item.url))
      } catch { /* Startup can precede the loopback debugger endpoint. */ }
      if (!target) await delay(200)
    }
    assert.ok(target?.webSocketDebuggerUrl, 'Packaged production renderer was not discovered')
    assert.match(target.url, /app\.asar[\\/]out[\\/]renderer[\\/]index\.html/, 'Renderer must come from the packaged ASAR')
    report.checks.push('actual-packaged-asar-renderer')
    client = await connect(target.webSocketDebuggerUrl)
    const result = await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const deadline = Date.now() + 15000;
        while ((!window.electronAPI || !document.getElementById('root')?.children.length) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        const api = window.electronAPI;
        if (!api) throw new Error('Packaged preload bridge is missing');
        return {
          version: await api.app.getVersion(), runtime: await api.app.getRuntimeInfo(),
          accountCount: (await api.accounts.getAll()).length,
          proxyRunning: (await api.proxy.getStatus()).isRunning,
          rendererReady: !!document.getElementById('root')?.children.length,
          nodeExposed: typeof window.require !== 'undefined',
          contentLoaded: document.body.innerText.trim().length > 40
        };
      })()`,
      awaitPromise: true, returnByValue: true,
    })
    assert.ok(!result.exceptionDetails, 'Packaged UI/IPC evaluation failed')
    const state = result.result.value
    assert.equal(state.version, manifest.version)
    assert.equal(state.runtime.electron, manifest.devDependencies.electron)
    assert.equal(state.runtime.platform, process.platform)
    assert.equal(state.runtime.arch, process.arch)
    report.runtime = state.runtime
    report.checks.push('native-platform-architecture-version-via-packaged-ipc')
    assert.equal(state.rendererReady, true)
    assert.equal(state.contentLoaded, true)
    assert.equal(state.nodeExposed, false)
    report.checks.push('rendered-ui-preload-and-node-isolation')
    assert.equal(state.accountCount, 0, 'Disposable package must contain no accounts')
    assert.equal(state.proxyRunning, false, 'Disposable package must not auto-start the proxy')
    report.checks.push('fresh-empty-accounts-and-stopped-proxy')
    assert.ok(fs.existsSync(path.join(directories.home, '.chat2api')), 'Application storage must initialize inside the disposable HOME')
    client.close()
    client = null
    const quit = childProcess(executable, [profileFlag, '--chat2api-quit'], env, root)
    const quitResult = await waitExit(quit, 15000)
    assert.equal(quitResult.code, 0, 'Single-instance quit helper failed')
    const exit = await waitExit(app, 20000)
    assert.equal(exit.code, 0, 'Packaged application failed clean shutdown')
    // Chromium may defer writing profile preferences until orderly shutdown.
    assert.ok(fs.existsSync(path.join(directories.userData, 'Local State')) || fs.existsSync(path.join(directories.userData, 'Preferences')), 'Chromium profile must initialize inside disposable user-data-dir')
    report.checks.push('home-and-chromium-profile-isolation')
    report.childExitCode = exit.code
    report.cleanQuit = true
    report.checks.push('single-instance-command-and-clean-quit')
    report.passed = true
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    client?.close()
    if (app && !app.settled) {
      const quit = childProcess(executable, [profileFlag, '--chat2api-quit'], env, root)
      await waitExit(quit, 5000).catch(() => { if (!quit.settled) quit.process.kill('SIGKILL') })
      await waitExit(app, 5000).catch(() => app.process.kill('SIGTERM'))
      await waitExit(app, 5000).catch(() => app.process.kill('SIGKILL'))
    }
    fs.mkdirSync(path.dirname(reportFile), { recursive: true })
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report, null, 2))
  }
  process.exitCode = report.passed ? 0 : 1
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
