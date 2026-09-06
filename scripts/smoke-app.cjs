/**
 * Isolated production Electron smoke. No account requests, credentials or real profiles.
 * Usage: node scripts/smoke-app.cjs [--electron <absolute electron executable>]
 * Builds must be current before running. The generated profile remains under .audit-cache.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')

function inside(target, directory) {
  const relative = path.relative(directory, path.resolve(target))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const option = process.argv.indexOf('--electron')
  const executable = option >= 0 ? path.resolve(process.argv[option + 1])
    : path.join(root, '.audit-cache/electron-44.2.0/node_modules/electron/dist/electron.exe')
  assert.ok(fs.existsSync(executable), 'Electron executable missing')
  assert.ok(fs.existsSync(path.join(root, 'out/main/index.js')), 'Run npm run build first')
  assert.match(fs.readFileSync(path.join(root, 'out/preload/index.js'), 'utf8'), /getRuntimeInfo/, 'Rebuild the production preload first')
  const cache = path.join(root, '.audit-cache')
  fs.mkdirSync(cache, { recursive: true })
  const fixture = fs.mkdtempSync(path.join(cache, 'app-runtime-smoke-'))
  const dirs = Object.fromEntries(['home', 'roaming', 'local', 'userData', 'sessionData', 'temp', 'logs'].map(name => [name, path.join(fixture, name)]))
  Object.values(dirs).forEach(directory => fs.mkdirSync(directory, { recursive: true }))
  const env = { ...process.env, USERPROFILE: dirs.home, HOME: dirs.home, APPDATA: dirs.roaming,
    LOCALAPPDATA: dirs.local, TEMP: dirs.temp, TMP: dirs.temp, NODE_ENV: 'production', CHAT2API_SMOKE_ROOT: fixture }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS']) delete env[key]
  // Electron loads a real fixture package, not the user's installed application package.
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'chat2api-isolated-smoke', version: '1.0.0', main: __filename }))
  const child = spawnSync(executable, [fixture], { cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024 })
  fs.writeFileSync(path.join(fixture, 'stdout.log'), child.stdout || '')
  fs.writeFileSync(path.join(fixture, 'stderr.log'), child.stderr || '')
  const reportFile = path.join(fixture, 'report.json')
  const result = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    : { passed: false, error: child.error?.message || 'Smoke child exited before producing a report' }
  const report = { ...result, childExitCode: child.status, fixtureRoot: fixture, productionProfileUsed: false }
  report.passed = report.passed === true && child.status === 0
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'artifacts/runtime-app-smoke.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.passed ? 0 : 1)
} else {
  runChild()
}

function runChild() {
  const { app, session } = require('electron')
  const os = require('node:os')
  const http = require('node:http')
  const net = require('node:net')
  const fixture = process.env.CHAT2API_SMOKE_ROOT
  assert.ok(fixture && inside(fixture, path.join(root, '.audit-cache')), 'Refusing a non-workspace smoke profile')
  const home = path.join(fixture, 'home')
  assert.equal(path.resolve(os.homedir()), home, 'Operating system home is not isolated')
  for (const [name, directory] of Object.entries({ home, appData: path.join(fixture, 'roaming'), userData: path.join(fixture, 'userData'), sessionData: path.join(fixture, 'sessionData'), temp: path.join(fixture, 'temp') })) {
    app.setPath(name, directory)
    assert.ok(inside(app.getPath(name), fixture), `${name} path escaped the fixture`)
  }
  app.setAppLogsPath(path.join(fixture, 'logs'))
  const report = { passed: false, versions: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node }, checks: [] }
  const managementRequests = []
  let win, finishing = false
  const check = name => report.checks.push(name)
  const write = () => fs.writeFileSync(path.join(fixture, 'report.json'), JSON.stringify(report, null, 2))
  const finish = async error => {
    if (finishing) return
    finishing = true
    clearTimeout(watchdog)
    if (error) report.error = error instanceof Error ? error.message : String(error)
    try {
      if (win && !win.isDestroyed()) await win.webContents.executeJavaScript('window.electronAPI?.proxy?.stop()')
    } catch (stopError) { report.stopError = stopError.message }
    report.passed = !report.error && !report.stopError
    write()
    app.isQuitting = true
    app.quit()
  }
  const watchdog = setTimeout(() => {
    report.error = 'Isolated application smoke exceeded 60 seconds'
    write()
    app.exit(1)
  }, 60000)
  app.once('quit', () => {
    report.cleanQuit = true
    write()
  })
  const isolateRequests = target => target.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, callback) => {
      const url = new URL(details.url)
      if (url.hostname === '127.0.0.1' && url.pathname === '/v0/management/tool-calling/status') {
        // Record only the local address, never headers or any credential value.
        managementRequests.push({ host: url.hostname, port: Number(url.port), path: url.pathname })
      }
      callback({ cancel: url.hostname !== '127.0.0.1' })
    },
  )
  app.on('session-created', isolateRequests)
  app.on('browser-window-created', (_, window) => {
    // Test fixture only: keep the real production renderer hidden, not disabled.
    window.show = () => {}
    window.showInactive = () => {}
    window.focus = () => {}
    // The app also creates a tray renderer. Only the first main window drives IPC.
    if (win) return
    win = window
    window.webContents.once('did-fail-load', (_, code, description) => void finish(new Error(`Renderer load failed: ${code} ${description}`)))
    window.webContents.once('did-finish-load', () => void verify(window).then(() => finish(), finish))
  })
  app.whenReady().then(() => isolateRequests(session.defaultSession))
  try { require(path.join(root, 'out/main/index.js')) } catch (error) { void finish(error) }

  async function invoke(expression) { return win.webContents.executeJavaScript(expression) }
  async function freePort() {
    const server = net.createServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    await new Promise(resolve => server.close(resolve))
    return port
  }
  async function request(port, pathname, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined
      const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: body ? 'POST' : 'GET',
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'anthropic-version': '2023-06-01' } : {},
      }, response => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { text += chunk })
        response.on('end', () => {
          try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }) } catch (error) { reject(error) }
        })
      })
      req.once('error', reject)
      req.setTimeout(8000, () => req.destroy(new Error('Loopback endpoint timed out')))
      req.end(data)
    })
  }
  async function verify(window) {
    assert.ok(window.webContents.getURL().startsWith('file://'), 'Production file renderer was not loaded')
    const ui = await invoke(`({ bridge: !!window.electronAPI, root: !!document.getElementById('root'), nodeExposed: typeof window.require !== 'undefined' })`)
    assert.equal(ui.bridge, true)
    assert.equal(ui.root, true)
    assert.equal(ui.nodeExposed, false)
    check('production-renderer-and-preload')
    const runtime = await invoke('window.electronAPI.app.getRuntimeInfo()')
    assert.equal(runtime.electron, process.versions.electron)
    assert.equal(runtime.chromium, process.versions.chrome)
    check('real-runtime-versions-via-ipc')
    const count = await invoke('window.electronAPI.accounts.getAll().then(accounts => accounts.length)')
    assert.equal(count, 0, 'The fixture must contain no accounts')
    check('isolated-empty-account-store')
    const port = await freePort()
    for (const mode of ['none', 'system', 'none']) {
      assert.equal(await invoke(`window.electronAPI.config.update(${JSON.stringify({ oauthProxyMode: mode, proxyHost: '127.0.0.1', proxyPort: port, autoStartProxy: false, enableApiKey: false, apiKeys: [], minimizeToTray: false })})`), true)
      assert.equal(await invoke('window.electronAPI.config.get().then(config => config.oauthProxyMode)'), mode)
    }
    check('network-mode-none-system-none-via-ipc')
    assert.equal(await invoke(`window.electronAPI.proxy.start(${port})`), true)
    const status = await invoke('window.electronAPI.proxy.getStatus()')
    assert.equal(status.isRunning, true)
    assert.equal(status.host, '127.0.0.1')
    assert.equal(status.port, port)
    report.port = port
    check('isolated-loopback-proxy-start-via-ipc')
    const health = await request(port, '/health')
    assert.equal(health.status, 200)
    assert.equal(health.body.status, 'running')
    check('health-http-200')
    let configuredPort = await freePort()
    while (configuredPort === port) configuredPort = await freePort()
    assert.equal(await invoke(`window.electronAPI.config.update(${JSON.stringify({
      proxyPort: configuredPort,
      managementApi: { enableManagementApi: false, managementApiSecret: '' },
    })})`), true)
    assert.equal(await invoke('window.electronAPI.config.get().then(config => config.proxyPort)'), configuredPort)
    const changedConfigStatus = await invoke('window.electronAPI.proxy.getStatus()')
    assert.equal(changedConfigStatus.isRunning, true)
    assert.equal(changedConfigStatus.port, port, 'A saved port change must not pretend the active listener moved')
    assert.equal(changedConfigStatus.host, '127.0.0.1')
    check('saved-port-change-does-not-overwrite-running-ipc-port')
    const activeHealth = await request(port, '/health')
    assert.equal(activeHealth.status, 200)
    assert.equal(activeHealth.body.port, port)
    assert.equal(activeHealth.body.host, '127.0.0.1')
    assert.equal(activeHealth.body.localBaseUrl, `http://127.0.0.1:${port}`)
    assert.equal(activeHealth.body.modelsUrl, `http://127.0.0.1:${port}/v1/models`)
    check('health-address-remains-bound-port-after-settings-change')
    const toolStatus = await invoke('window.electronAPI.toolCalling.getStatus()')
    assert.deepEqual(toolStatus.models, [], 'An isolated empty account store must not invent available models')
    const noAccountSmoke = await invoke('window.electronAPI.toolCalling.runSmoke({clientAdapterId:"standard-openai-tools"})')
    assert.equal(noAccountSmoke.success, false, 'No provider was called; never report a fake pass')
    assert.equal(noAccountSmoke.failureCode, 'no_available_model')
    assert.equal(managementRequests.length, 0, 'Desktop test must not call the disabled HTTP management API')
    check('tool-smoke-ipc-with-management-disabled-and-no-fake-pass')
    const tokens = await request(port, '/v1/messages/count_tokens', { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'local smoke only' }] })
    assert.equal(tokens.status, 200)
    assert.ok(Number.isInteger(tokens.body.input_tokens) && tokens.body.input_tokens > 0)
    assert.equal(tokens.headers['x-chat2api-token-count'], 'estimated')
    check('anthropic-count-tokens-http-200-estimated')

    // Fake account in the isolated profile only. Never validate it against a provider.
    const account = await invoke('window.electronAPI.accounts.add({providerId:"deepseek", name:"isolated-scheduling-fixture", credentials:{token:"fixture-not-a-real-token"}})')
    const accountId = JSON.stringify(account.id)
    await invoke(`window.electronAPI.accounts.setEnabled(${accountId}, false)`)
    assert.equal(await invoke(`window.electronAPI.accounts.getById(${accountId}).then(value => value.enabled)`), false)
    assert.equal((await request(port, '/v1/models')).body.data.length, 0)
    const disabledReply = await request(port, '/v1/chat/completions', { model:'deepseek-v4-flash', messages:[{role:'user',content:'must not leave this fixture'}] })
    assert.equal(disabledReply.status, 503)
    check('disabled-account-excluded-before-forwarding-via-real-ipc')
    await invoke(`window.electronAPI.accounts.setEnabled(${accountId}, true)`)
    assert.ok((await request(port, '/v1/models')).body.data.some(model => model.id === 'deepseek-v4-flash'))
    check('enabled-account-restored-to-model-discovery-via-real-ipc')
    const recovery = Date.now() + 1200
    await invoke(`window.electronAPI.accounts.update(${accountId}, {cooldownReason:'temporary_ban',cooldownUntil:${recovery}})`)
    assert.equal((await request(port, '/v1/models')).body.data.length, 0)
    await invoke(`window.electronAPI.accounts.setEnabled(${accountId}, false)`)
    await invoke('window.__accountTimerEvents = 0; window.__accountTimerUnsubscribe = window.electronAPI.accounts.onChanged(() => {window.__accountTimerEvents++}); void 0')
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.ok(await invoke('window.__accountTimerEvents > 0'), 'Expiry must notify the real renderer without a polling read')
    const recovered = await invoke(`window.electronAPI.accounts.getById(${accountId})`)
    assert.equal(recovered.cooldownUntil, undefined)
    assert.equal(recovered.cooldownReason, undefined)
    assert.equal(recovered.enabled, false, 'Automatic recovery must preserve manual disable')
    assert.equal((await request(port, '/v1/models')).body.data.length, 0)
    check('automatic-cooldown-expiry-notifies-ui-and-preserves-manual-disable')
    await invoke(`window.electronAPI.accounts.setEnabled(${accountId}, true)`)
    assert.ok((await request(port, '/v1/models')).body.data.length > 0)
    await invoke(`window.electronAPI.accounts.delete(${accountId})`)
    await invoke('window.__accountTimerUnsubscribe(); delete window.__accountTimerUnsubscribe; delete window.__accountTimerEvents')
    assert.equal(await invoke('window.electronAPI.accounts.getAll().then(accounts => accounts.length)'), 0)
    check('isolated-scheduling-fixture-cleaned-up-without-provider-call')
    assert.equal(await invoke('window.electronAPI.proxy.stop()'), true)
    const stoppedStatus = await invoke('window.electronAPI.proxy.getStatus()')
    assert.equal(stoppedStatus.isRunning, false)
    assert.equal(stoppedStatus.port, configuredPort, 'Stopped status must show the next configured start port')
    assert.equal(stoppedStatus.host, '127.0.0.1')
    check('proxy-stop-via-ipc')
    check('stopped-ipc-status-shows-new-configured-port')
    assert.ok(inside(os.homedir(), fixture) && inside(app.getPath('userData'), fixture))
    check('profile-boundary-retained')
  }
}
