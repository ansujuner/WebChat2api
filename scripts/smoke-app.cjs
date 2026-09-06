/**
 * Isolated production Electron smoke. No real provider requests, credentials or profiles.
 * Account liveness uses synthetic credentials and a loopback-only HTTP fixture.
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
  const builtPreload = fs.readFileSync(path.join(root, 'out/preload/index.js'), 'utf8')
  assert.match(builtPreload, /getRuntimeInfo/, 'Rebuild the production preload first')
  assert.match(builtPreload, /livenessStart/, 'Rebuild the account liveness preload before running this smoke')
  assert.match(fs.readFileSync(path.join(root, 'out/main/index.js'), 'utf8'), /accounts:livenessStart/, 'Rebuild the account liveness backend before running this smoke')
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
  const { app, session, ipcMain } = require('electron')
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

  async function verifyAccountLiveness() {
    const records = [], accountIds = []
    const tokens = { fail: 'smoke-liveness-fail-only', pass: 'smoke-liveness-pass-only' }
    const privateReply = 'smoke-liveness-private-upstream-reply'
    const model = 'fixture-basic'
    let providerId, activeJobId, fixtureFailure, holdNext = false, heldResponse
    const server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.method, 'POST')
        assert.equal(req.url, '/v1/chat/completions')
        req.setEncoding('utf8')
        let text = ''
        for await (const chunk of req) {
          text += chunk
          assert.ok(Buffer.byteLength(text) <= 8192, 'Only a tiny local liveness request is allowed')
        }
        const body = JSON.parse(text)
        assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'stream'])
        assert.equal(body.model, model)
        assert.equal(body.stream, false)
        assert.equal(body.max_tokens, 32)
        assert.deepEqual(body.messages, [{ role: 'user', content: '你好，请只回复 OK。' }])
        // Keep only a synthetic account label, never raw authorization headers.
        const account = req.headers.authorization === `Bearer ${tokens.fail}` ? 'fail'
          : req.headers.authorization === `Bearer ${tokens.pass}` ? 'pass' : undefined
        assert.ok(account, 'The exact synthetic account credential must reach the loopback sink')
        records.push({ account, minimalUserRequest: true })
        const respond = () => {
          res.writeHead(account === 'fail' ? 401 : 200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(account === 'fail' ? { error: { message: privateReply } } : {
            id: 'fixture-completion', object: 'chat.completion', created: 1, model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
          }))
        }
        if (holdNext) { holdNext = false; heldResponse = respond }
        else respond()
      } catch (error) {
        fixtureFailure = error
        if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Local liveness fixture rejected the request' } }))
      }
    })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const fixturePort = server.address().port
    const accounts = (method, ...args) => invoke(`window.electronAPI.accounts.${method}(${args.map(value => JSON.stringify(value)).join(',')})`)
    const waitForJob = async (id, validateFixture = true) => {
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        const current = await accounts('livenessGet')
        if (current?.id === id && ['completed', 'cancelled'].includes(current.state)) {
          if (validateFixture && fixtureFailure) throw fixtureFailure
          return current
        }
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      throw new Error('The isolated account liveness job did not settle')
    }
    const start = async input => {
      const initial = await accounts('livenessStart', input)
      activeJobId = initial.id
      return initial
    }
    try {
      assert.equal((await invoke('window.electronAPI.proxy.getStatus()')).isRunning, false)
      assert.equal(await accounts('livenessGet'), null, 'No account test may start automatically')
      const api = await invoke(`({start:typeof window.electronAPI.accounts.livenessStart,get:typeof window.electronAPI.accounts.livenessGet,cancel:typeof window.electronAPI.accounts.livenessCancel,changed:typeof window.electronAPI.accounts.onLivenessChanged})`)
      assert.ok(Object.values(api).every(value => value === 'function'))
      check('liveness-real-ipc-available-with-proxy-stopped-and-no-auto-job')
      const provider = await invoke(`window.electronAPI.providers.add(${JSON.stringify({
        name: 'Isolated Liveness Fixture', authType: 'token', apiEndpoint: `http://127.0.0.1:${fixturePort}/v1`, supportedModels: [model],
        credentialFields: [{ name: 'token', label: 'Fixture token', type: 'password', required: true }],
      })})`)
      providerId = provider.id
      for (const account of ['fail', 'pass']) {
        const created = await accounts('add', { providerId, name: `isolated-liveness-${account}`, credentials: { token: tokens[account] } })
        accountIds.push(created.id)
      }
      await invoke(`window.__livenessSmokeEvents = []; window.__livenessSmokeUnsubscribe = window.electronAPI.accounts.onLivenessChanged(job => { if(window.__livenessSmokeEvents.length<100) window.__livenessSmokeEvents.push(job); }); void 0`)
      const failed = await waitForJob((await start({ accountIds: [accountIds[0]] })).id)
      assert.equal(failed.results.length, 1)
      assert.equal(failed.results[0].accountId, accountIds[0])
      assert.equal(failed.results[0].status, 'failed')
      assert.equal(failed.results[0].reason, 'auth_required')
      assert.deepEqual(records.map(record => record.account), ['fail'], 'Failure must never retry or rotate to the successful account')
      check('liveness-single-failure-does-not-rotate-or-retry-another-account')

      await accounts('setEnabled', accountIds[1], false)
      const passed = await waitForJob((await start({ accountIds: [accountIds[1]] })).id)
      assert.equal(passed.results[0].accountId, accountIds[1])
      assert.equal(passed.results[0].status, 'passed')
      assert.equal((await accounts('getById', accountIds[1])).enabled, false)
      assert.deepEqual(records.map(record => record.account), ['fail', 'pass'])
      assert.equal((await invoke('window.electronAPI.proxy.getStatus()')).isRunning, false)
      check('liveness-explicit-disabled-account-test-passes-without-enabling-or-starting-proxy')

      await accounts('update', accountIds[0], { cooldownReason: 'temporary_ban', cooldownUntil: Date.now() + 60000 })
      const skipped = await waitForJob((await start({ providerId })).id)
      assert.equal(skipped.mode, 'batch')
      assert.deepEqual(skipped.results.map(result => [result.status, result.reason]), [['skipped', 'cooldown'], ['skipped', 'disabled']])
      assert.equal(records.length, 2, 'Batch skips must not submit any request')
      check('liveness-batch-skips-disabled-and-cooling-accounts-before-submission')

      await accounts('clearSuspension', accountIds[0]); await accounts('setEnabled', accountIds[1], true)
      const batch = await waitForJob((await start({ providerId })).id)
      assert.deepEqual(batch.results.map(result => [result.accountId, result.status]), [[accountIds[0], 'failed'], [accountIds[1], 'passed']])
      assert.deepEqual(records.map(record => record.account), ['fail', 'pass', 'fail', 'pass'])
      check('liveness-batch-keeps-each-account-result-and-continues-after-fixed-failure')
      assert.ok(records.every(record => record.minimalUserRequest))
      check('liveness-provider-wire-is-one-user-message-without-system-tools-or-history')

      holdNext = true
      const cancellable = await start({ providerId })
      const requestDeadline = Date.now() + 5000
      while (!heldResponse && Date.now() < requestDeadline) await new Promise(resolve => setTimeout(resolve, 20))
      assert.ok(heldResponse, 'The cancellation fixture must observe an in-flight local request')
      assert.equal(records.length, 5)
      const cancelling = await accounts('livenessCancel', cancellable.id)
      assert.equal(cancelling.state, 'cancelling')
      assert.equal(cancelling.results[1].status, 'cancelled')
      await assert.rejects(accounts('livenessStart', { accountIds: [accountIds[1]] }), /already running/)
      assert.equal(records.length, 5, 'Cancelling must retain the job lock until its owned request settles')
      check('liveness-cancelling-retains-lock-and-rejects-overlapping-test')
      const release = heldResponse; heldResponse = undefined; release()
      const cancelled = await waitForJob(cancellable.id)
      assert.equal(cancelled.state, 'cancelled')
      assert.equal(cancelled.results[1].status, 'cancelled')
      assert.equal(records.length, 5, 'Cancelled queued accounts must never be submitted')
      check('liveness-cancel-stops-remaining-accounts-without-replaying-current-request')

      const events = await invoke('window.__livenessSmokeEvents')
      assert.ok(events.some(event => event.id === failed.id && event.state === 'completed'))
      assert.ok(events.some(event => event.id === cancelled.id && event.state === 'cancelled'))
      const serialized = JSON.stringify(events)
      for (const marker of [...Object.values(tokens), privateReply, 'Bearer ', 'credentials', 'Authorization']) {
        assert.ok(!serialized.includes(marker), 'Liveness events must not expose credentials or raw upstream details')
      }
      check('liveness-real-renderer-events-contain-safe-progress-and-terminal-results')

      // Render the actual production page, without clicking a test button or generating again.
      const labels = ['zh-CN', 'en-US'].map(language => JSON.parse(fs.readFileSync(path.join(root,
        `src/renderer/src/i18n/locales/${language}.json`), 'utf8')).accountLiveness)
      await invoke("window.location.hash = '#/providers'; void 0")
      const uiDeadline = Date.now() + 8000
      let rendered
      while (Date.now() < uiDeadline) {
        rendered = await invoke(`(() => {
          const titles=${JSON.stringify(labels.map(label => label.title))}, buttons=${JSON.stringify(labels.map(label => label.allAccounts))};
          const section=Array.from(document.querySelectorAll('section[aria-label]')).find(node=>titles.includes(node.getAttribute('aria-label')));
          const content=section?.textContent || '';
          return {allButton:Array.from(document.querySelectorAll('button')).some(node=>buttons.includes(node.textContent.trim())),
            panel:!!section?.querySelector('[role="status"][aria-live="polite"]'),
            results:['isolated-liveness-fail','isolated-liveness-pass'].every(name=>content.includes(name)),
            safe:${JSON.stringify([...Object.values(tokens), privateReply])}.every(marker=>!content.includes(marker))};
        })()`)
        if (rendered.allButton && rendered.panel && rendered.results) break
        await new Promise(resolve => setTimeout(resolve, 40))
      }
      assert.deepEqual(rendered, { allButton: true, panel: true, results: true, safe: true })
      if (fixtureFailure) throw fixtureFailure
      assert.equal(records.length, 5, 'Rendering the results page must not trigger another generation')
      check('liveness-production-providers-page-renders-all-test-button-and-safe-results')
    } finally {
      let cleanupFailed = false
      const cleanup = async operation => { try { await operation() } catch { cleanupFailed = true } }
      if (activeJobId) {
        await cleanup(() => accounts('livenessCancel', activeJobId))
        if (heldResponse) { const release = heldResponse; heldResponse = undefined; release() }
        await cleanup(() => waitForJob(activeJobId, false))
      }
      await cleanup(() => invoke('window.__livenessSmokeUnsubscribe?.(); delete window.__livenessSmokeUnsubscribe; delete window.__livenessSmokeEvents; void 0'))
      for (const id of accountIds) await cleanup(() => accounts('delete', id))
      if (providerId) await cleanup(() => invoke(`window.electronAPI.providers.delete(${JSON.stringify(providerId)})`))
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
      if (cleanupFailed) throw new Error('The isolated liveness fixtures could not be fully cleaned up')
    }
    assert.equal(await invoke('window.electronAPI.accounts.getAll().then(accounts => accounts.length)'), 0)
    assert.equal((await invoke('window.electronAPI.proxy.getStatus()')).isRunning, false)
    check('liveness-loopback-accounts-provider-listener-and-server-cleaned-in-isolated-profile')
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

    await require('./smoke-custom-tools.cjs')({ invoke, check, port })
    await require('./smoke-account-relogin.cjs')({ invoke, check, ipcMain })

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
    await verifyAccountLiveness()
    assert.ok(inside(os.homedir(), fixture) && inside(app.getPath('userData'), fixture))
    check('profile-boundary-retained')
  }
}
