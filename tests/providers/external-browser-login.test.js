const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { PassThrough, Writable } = require('node:stream')
const ts = require('typescript')

const root = path.join(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function load(relative, overrides = {}, globals = {}) {
  const fileName = path.join(root, relative)
  const code = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    process: { platform: 'win32', env: {} },
    console: { log() { throw new Error('Login must not log credentials') }, error() { throw new Error('Login must not log raw errors') }, warn() {} },
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      if (name === '../network/providerContext.ts') return require('../../src/main/network/providerContext.ts')
      if (name === '../../shared/providerNetwork') return require('../../src/shared/providerNetwork.ts')
      if (name.startsWith('.') || name === 'electron') throw new Error(`Unmocked dependency ${name}`)
      return require(name)
    }, ...globals,
  }, { filename: fileName })
  return module.exports
}

const { CdpPipe } = load('src/main/oauth/cdpPipe.ts')
const policy = load('src/main/oauth/loginPolicy.ts')
const discovery = load('src/main/oauth/browserDiscovery.ts', {
  'node:child_process': { execFile() { throw new Error('No real signature command in tests') } },
  'node:fs/promises': { stat() { throw new Error('No real browser access in tests') }, realpath() { throw new Error('No real browser access in tests') } },
})

function pipeFixture() {
  const writes = [], output = new PassThrough()
  const input = new Writable({ write(chunk, _encoding, done) { writes.push(Buffer.from(chunk)); done() } })
  return { pipe: new CdpPipe(input, output), input, output, writes,
    answer(value) { output.write(Buffer.from(JSON.stringify(value) + '\0')) } }
}

test('private CDP pipe handles split UTF-8 frames, concurrent responses and flat sessions', async () => {
  const f = pipeFixture()
  const first = f.pipe.send('Browser.getVersion')
  const second = f.pipe.send('Runtime.evaluate', { expression: 'fixture-only' }, 'isolated-session')
  assert.ok(f.writes.every(value => value.at(-1) === 0))
  assert.deepEqual(JSON.parse(f.writes[1].toString().slice(0, -1)), { id: 2, method: 'Runtime.evaluate', params: { expression: 'fixture-only' }, sessionId: 'isolated-session' })
  const combined = Buffer.from(JSON.stringify({ id: 2, result: { value: '你好' } }) + '\0' + JSON.stringify({ id: 1, result: { product: 'Chrome/152' } }) + '\0')
  const split = combined.indexOf(Buffer.from('你好')) + 1
  f.output.write(combined.subarray(0, split)); f.output.write(combined.subarray(split))
  assert.deepEqual(plain(await first), { product: 'Chrome/152' })
  assert.deepEqual(plain(await second), { value: '你好' })
  f.pipe.close()
})

test('CDP errors are bounded and redact raw remote error content', async () => {
  const f = pipeFixture()
  const pending = f.pipe.send('Runtime.evaluate')
  f.answer({ id: 1, error: { message: 'secret-token-and-private-url' } })
  await assert.rejects(pending, error => /could not be completed/.test(error.message) && !error.message.includes('secret'))
  await assert.rejects(f.pipe.send('Target.getTargets', {}, undefined, 1), /did not respond/)
  const disconnected = f.pipe.send('Browser.getVersion')
  f.output.end()
  await assert.rejects(disconnected, /connection is closed/)
  await assert.rejects(f.pipe.send('Browser.getVersion'), /connection is closed/)
  f.pipe.close()
})

test('CDP pipe rejects malformed or oversized frames without exposing payloads', async () => {
  for (const data of [Buffer.from('not-json\0'), Buffer.alloc(2 * 1024 * 1024 + 1)]) {
    const f = pipeFixture()
    const pending = f.pipe.send('Browser.getVersion')
    f.output.write(data)
    await assert.rejects(pending, /connection is closed/)
    f.pipe.close()
  }
})

test('browser selection uses only known Chrome/Edge paths, no executable or profile PATH lookup', () => {
  const candidates = discovery.windowsBrowserCandidates({ ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files', LOCALAPPDATA: 'C:\\Fixture\\Local', PATH: 'C:\\Malicious', CHROME_PATH: 'C:\\Malicious\\chrome.exe' })
  assert.equal(candidates.length, 4)
  assert.deepEqual(plain(candidates).map(value => value.name), ['Chrome', 'Chrome', 'Edge', 'Edge'])
  assert.ok(candidates.every(value => !value.executable.includes('Malicious') && !value.executable.includes('User Data')))
  assert.deepEqual(plain(discovery.windowsBrowserCandidates({ ProgramFiles: 'relative-root' })), [])
})

test('browser arguments preserve native identity, full security, isolated profiles and explicit proxy mode', () => {
  const profile = path.join(root, '.audit-cache', 'fixture-profile-not-created')
  for (const mode of ['system', 'none']) {
    const args = discovery.loginBrowserArguments(profile, mode)
    assert.ok(args.includes(`--user-data-dir=${profile}`))
    assert.ok(args.includes('--remote-debugging-pipe'))
    assert.equal(args.includes('--no-proxy-server'), mode === 'none')
    assert.equal(args.at(-1), 'https://chat.deepseek.com/')
    assert.ok(!args.some(value => /remote-debugging-port|enable-automation|headless|user-agent|disable-blink|disable-web-security|no-sandbox|ignore-certificate|load-extension|profile-directory/.test(value)))
  }
  assert.throws(() => discovery.loginBrowserArguments('relative-profile', 'system'), /absolute/)
  assert.throws(() => discovery.loginBrowserArguments(profile, 'auto'), /Invalid network proxy configuration/)
  const input = { HTTPS_PROXY: 'fixture-secret', http_proxy: 'fixture-secret', ALL_PROXY: 'fixture-secret', NO_PROXY: '*', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', NODE_EXTRA_CA_CERTS: 'fixture', SSLKEYLOGFILE: 'fixture', PSModulePath: 'incompatible-parent-shell-modules', PATH: 'keep', HOME: 'keep' }
  assert.deepEqual(plain(discovery.browserChildEnvironment(input)), { PATH: 'keep', HOME: 'keep' })
  assert.equal(input.HTTPS_PROXY, 'fixture-secret')
})

test('external browser custom proxy is an explicit validated route, never an insecure flag or authenticated URL', () => {
  const profile = path.join(root, '.audit-cache', 'fixture-profile-not-created')
  for (const scheme of ['http', 'https', 'socks5']) {
    const url = `${scheme}://127.0.0.1:18421`
    const args = discovery.loginBrowserArguments(profile, { mode: 'custom', url })
    assert.ok(args.includes(`--proxy-server=${url}`))
    assert.ok(args.includes('--proxy-bypass-list=<-loopback>'))
    assert.ok(!args.includes('--no-proxy-server'))
    assert.ok(!args.some(arg => /disable-web-security|ignore-certificate|no-sandbox/.test(arg)))
  }
  for (const url of ['http://user:private@127.0.0.1:18421', 'http://127.0.0.1', 'http://127.0.0.1:18421/--no-sandbox']) {
    assert.throws(() => discovery.loginBrowserArguments(profile, { mode: 'custom', url }))
  }
})

function discoveryFixture({ status = 'Valid', subject = 'CN=Google LLC, O=Google LLC, C=US', canonical, file = true, signatureError } = {}) {
  const calls = []
  const env = { ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows', PSMODULEPATH: 'C:\\Program Files\\PowerShell\\7\\Modules' }
  const module = load('src/main/oauth/browserDiscovery.ts', {
    'node:fs/promises': { stat: async () => ({ isFile: () => file }), realpath: async value => canonical || value },
    'node:child_process': { execFile(executable, args, options, done) { calls.push({ executable, args, options }); done(signatureError, JSON.stringify({ status, subject })) } },
  }, { process: { platform: 'win32', env } })
  return { ...module, calls }
}

test('browser executable requires valid expected publisher signature and canonical installation path', async () => {
  const f = discoveryFixture()
  const browser = await f.findInstalledLoginBrowser()
  assert.equal(browser.name, 'Chrome')
  assert.equal(f.calls.length, 1)
  assert.ok(f.calls[0].executable.endsWith('System32\\WindowsPowerShell\\v1.0\\powershell.exe'))
  assert.equal(f.calls[0].options.windowsHide, true)
  assert.equal(f.calls[0].options.env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
  assert.equal(f.calls[0].options.env.PSMODULEPATH, undefined)
  assert.equal(f.calls[0].options.env.CHAT2API_BROWSER_VERIFY_PATH, browser.executable)
  assert.ok(f.calls[0].args.at(-1).includes('-LiteralPath $env:CHAT2API_BROWSER_VERIFY_PATH'))
  assert.ok(!f.calls[0].args.at(-1).includes(browser.executable))
  for (const config of [{ status: 'NotSigned' }, { subject: 'CN=Google LLC, O=Other Publisher, C=US' }, { canonical: 'C:\\Other\\chrome.exe' }, { signatureError: new Error('fixture private command output') }, { file: false }]) {
    await assert.rejects(discoveryFixture(config).findInstalledLoginBrowser(), /No verified/)
  }
  assert.equal((await discoveryFixture({ subject: 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US' }).findInstalledLoginBrowser()).name, 'Edge')
  const controller = new AbortController(); controller.abort()
  const cancelled = discoveryFixture()
  await assert.rejects(cancelled.findInstalledLoginBrowser(controller.signal), /cancelled/)
  assert.equal(cancelled.calls.length, 0)
})

function browserFixture(options = {}) {
  const files = [], removed = [], children = [], commands = [], timeouts = new Map(), intervals = new Map()
  const userData = path.join(root, '.audit-cache', 'mock-user-data-never-created')
  let now = 1000, nextTimer = 0, nextProfile = 0, discoverySignal
  const targets = options.targets || [{ type: 'page', targetId: 'deepseek', url: 'https://chat.deepseek.com/' }]
  class Clock extends Date { static now() { return now } }
  class FakePipe extends EventEmitter {
    constructor() { super(); this.closed = false; this.whenClosed = new Promise(resolve => { this.resolveClosed = resolve }) }
    async send(method, params = {}, sessionId) {
      commands.push({ method, params, sessionId })
      if (this.closed) throw new Error('connection is closed')
      if (method === 'Browser.close') {
        if (options.exitOnClose !== false) children.at(-1).emit('exit', 0)
        return {}
      }
      if (method === 'Browser.getVersion') {
        if (options.readiness) await Promise.race([options.readiness.promise, this.whenClosed])
        if (this.closed) throw new Error('connection is closed')
        return { userAgent: 'Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36' }
      }
      if (method === 'Target.getTargets') return { targetInfos: targets }
      if (method === 'Target.attachToTarget') return { sessionId: params.targetId }
      if (method === 'Target.getTargetInfo') return { targetInfo: { url: options.navigationRace || targets.find(value => value.targetId === params.targetId).url } }
      if (method === 'Runtime.evaluate') {
        if (options.evaluation) await options.evaluation.promise
        if (params.expression.includes('unsafeWarningVisible')) return { result: { value: { electron: false, tauri: false, unsafeWarningVisible: false, secret: 'must-not-return' } } }
        return { result: { value: options.token ?? 'fixture-deepseek-token-0123456789' } }
      }
      return {}
    }
    close() { this.closed = true; this.resolveClosed(); this.emit('close') }
  }
  const module = load('src/main/oauth/externalBrowserLogin.ts', {
    electron: { app: { getPath(name) { assert.equal(name, 'userData'); return userData } } },
    './loginPolicy': policy, './cdpPipe': { CdpPipe: FakePipe },
    './browserDiscovery': { ...discovery, async findInstalledLoginBrowser(signal) {
      discoverySignal = signal
      if (options.discovery) await options.discovery.promise
      if (options.missingBrowser) throw new Error('private-path-never-echoed')
      return { name: 'Chrome', executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }
    } },
    'node:fs/promises': {
      async mkdir(value) { files.push(['mkdir', value]) },
      async realpath(value) { files.push(['realpath', value]); return options.rootEscape && value.endsWith('oauth-browser-profiles') ? path.join(root, '.audit-cache', 'outside') : value },
      async mkdtemp(prefix) { files.push(['mkdtemp', prefix]); if (options.profileCreation) await options.profileCreation.promise; return prefix + (++nextProfile) },
      async rm(value, config) { removed.push({ value, config, exited: children.at(-1)?.didExit ?? true }) },
    },
    'node:child_process': { spawn(executable, args, config) {
      const child = new EventEmitter()
      child.stdio = [null, null, null, new PassThrough(), new PassThrough()]
      child.kill = () => { throw new Error('No browser process kills permitted') }
      child.on('exit', () => { child.didExit = true })
      child.executable = executable; child.args = args; child.config = config
      children.push(child)
      return child
    } },
  }, { Date: Clock,
    setTimeout(fn, ms) { const id = ++nextTimer; timeouts.set(id, { fn, ms }); return id }, clearTimeout(id) { timeouts.delete(id) },
    setInterval(fn, ms) { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id }, clearInterval(id) { intervals.delete(id) },
  })
  const manager = new module.ExternalBrowserLoginManager()
  return { ...module, manager, files, removed, children, commands, timeouts, intervals, targets,
    get discoverySignal() { return discoverySignal }, advance(ms) { now += ms },
    async poll() { for (const { fn } of [...intervals.values()]) fn(); await tick() },
    async timeout(ms) { for (const { fn, ms: duration } of [...timeouts.values()]) if (ms === undefined || duration === ms) fn(); await tick() },
  }
}
const startOptions = { providerId: 'deepseek', providerType: 'deepseek', proxyMode: 'system' }

test('external login exact-origin policy rejects HTTP, foreign IdPs, siblings, credentials and lookalikes', () => {
  const f = browserFixture()
  for (const value of ['https://chat.deepseek.com/', 'https://chat.deepseek.com/a/chat/s/id', 'https://chat.deepseek.com:443/sign_in']) assert.equal(f.isDeepSeekLoginPage(value), true)
  for (const value of ['http://chat.deepseek.com/', 'https://api.deepseek.com/', 'https://chat.deepseek.com.evil.test/', 'https://accounts.google.com/', 'https://user:pass@chat.deepseek.com/', 'https://chat.deepseek.com:9443/', 'file:///fixture', null]) assert.equal(f.isDeepSeekLoginPage(value), false)
})

test('system-browser launch uses only new app-owned profile, private pipe and no inherited proxy flags', async () => {
  const f = browserFixture()
  const result = f.manager.startLogin(startOptions)
  await tick()
  assert.equal(f.children.length, 1)
  const child = f.children[0]
  assert.deepEqual(plain(child.config.stdio), ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'])
  assert.equal(child.config.shell, false)
  assert.equal(child.config.detached, false)
  assert.ok(child.args.some(value => value.includes('oauth-browser-profiles') && value.includes('login-1')))
  assert.ok(f.files.every(([, value]) => value.includes('.audit-cache') && !value.includes('User Data')))
  assert.equal(f.commands.filter(value => value.method === 'Runtime.evaluate').length, 0)
  f.manager.cancel()
  assert.equal((await result).success, false)
  assert.equal(f.removed.length, 1)
  assert.equal(f.removed[0].exited, true)
  assert.equal(f.timeouts.size, 0)
  assert.equal(f.intervals.size, 0)
})

test('token extraction reads only userToken from exact DeepSeek page and waits for parent validation', async () => {
  const f = browserFixture({ targets: [
    { type: 'page', targetId: 'idp', url: 'https://accounts.google.com/' },
    { type: 'service_worker', targetId: 'worker', url: 'https://chat.deepseek.com/' },
    { type: 'page', targetId: 'lookalike', url: 'https://chat.deepseek.com.evil.test/' },
    { type: 'page', targetId: 'deepseek', url: 'https://chat.deepseek.com/a/chat/s/fixture' },
  ] })
  const tokens = []
  f.manager.on('tokenFound', value => tokens.push(plain(value)))
  const result = f.manager.startLogin(startOptions)
  await tick(); f.advance(5001); await f.poll()
  assert.deepEqual(tokens, [{ key: 'userToken', value: 'fixture-deepseek-token-0123456789' }])
  assert.ok(f.commands.filter(value => value.method === 'Target.attachToTarget').every(value => value.params.targetId === 'deepseek'))
  const evaluations = f.commands.filter(value => value.method === 'Runtime.evaluate')
  assert.equal(evaluations.length, 1)
  assert.equal(evaluations[0].sessionId, 'deepseek')
  assert.equal(evaluations[0].params.expression, `location.origin === "https://chat.deepseek.com" ? localStorage.getItem('userToken') : null`)
  assert.equal(f.manager.isWindowOpen(), true)
  const credentials = { userToken: 'fixture-validated-token' }
  f.manager.completeWithSuccess(credentials)
  const completed = await result
  assert.deepEqual(plain(completed), { success: true, credentials })
  assert.notEqual(completed.credentials, credentials)
})

test('navigation to IdP between target listing and read prevents token evaluation', async () => {
  const f = browserFixture({ navigationRace: 'https://accounts.google.com/' })
  const result = f.manager.startLogin(startOptions)
  await tick(); f.advance(5001); await f.poll()
  assert.equal(f.commands.filter(value => value.method === 'Runtime.evaluate').length, 0)
  assert.ok(f.commands.some(value => value.method === 'Target.detachFromTarget'))
  f.manager.cancel(); await result
})

test('invalid tokens never complete login and read-only environment diagnostics return no secrets or URLs', async () => {
  const f = browserFixture({ token: '{"value":""}' })
  const tokens = []
  f.manager.on('tokenFound', value => tokens.push(value))
  const result = f.manager.startLogin(startOptions)
  await tick(); f.advance(5001); await f.poll()
  assert.equal(tokens.length, 0)
  const environment = plain(await f.manager.getBrowserEnvironment())
  assert.deepEqual(environment, { browser: 'Chrome', userAgent: 'Mozilla/5.0 Chrome/152.0.0.0 Safari/537.36', providerPages: [{ electron: false, tauri: false, unsafeWarningVisible: false }] })
  assert.ok(!JSON.stringify(environment).includes('secret'))
  f.manager.cancel(); await result
  assert.equal(await f.manager.getBrowserEnvironment(), null)
})

test('environment diagnostic returns null when successful login closes its in-flight pipe', async () => {
  const options = {}, f = browserFixture(options)
  const result = f.manager.startLogin(startOptions)
  await tick()
  options.readiness = deferred()
  const environment = f.manager.getBrowserEnvironment()
  await tick()
  f.manager.completeWithSuccess({ userToken: 'fixture-validated-token' })
  assert.equal(await environment, null)
  assert.equal((await result).success, true)
  assert.equal(f.removed.length, 1)
})

test('environment diagnostic preserves transport errors while the same login remains active', async () => {
  const options = {}, f = browserFixture(options)
  const result = f.manager.startLogin(startOptions)
  await tick()
  options.readiness = deferred()
  const environment = f.manager.getBrowserEnvironment()
  const rejected = assert.rejects(environment, /fixture active transport error/)
  options.readiness.reject(new Error('fixture active transport error'))
  await rejected
  assert.equal(f.manager.isWindowOpen(), true)
  f.manager.cancel()
  await result
})

test('cancellation during discovery aborts verification and cannot spawn or allocate a later browser', async () => {
  const discovery = deferred(), f = browserFixture({ discovery })
  const result = f.manager.startLogin(startOptions)
  const concurrent = await f.manager.startLogin(startOptions)
  assert.equal(concurrent.success, false)
  f.manager.cancel()
  assert.equal(f.discoverySignal.aborted, true)
  discovery.resolve()
  await result
  assert.equal(f.children.length, 0)
  assert.equal(f.files.length, 0)
  assert.equal(f.manager.isWindowOpen(), false)
})

test('cancellation during profile creation removes only the late owned profile without spawning', async () => {
  const profileCreation = deferred(), f = browserFixture({ profileCreation })
  const result = f.manager.startLogin(startOptions)
  await tick()
  assert.ok(f.files.some(([operation]) => operation === 'mkdtemp'))
  f.manager.cancel(); profileCreation.resolve()
  await result
  assert.equal(f.children.length, 0)
  assert.equal(f.removed.length, 1)
})

test('cancellation during browser readiness closes pipe instead of waiting for readiness timeout', async () => {
  const readiness = deferred(), f = browserFixture({ readiness })
  const result = f.manager.startLogin(startOptions)
  await tick()
  assert.equal(f.children.length, 1)
  assert.equal(f.intervals.size, 0)
  f.manager.cancel()
  assert.match((await result).error, /cancelled/)
  assert.equal(f.removed.length, 1)
  assert.equal(f.timeouts.size, 0)
  readiness.resolve(); await tick()
  assert.equal(f.intervals.size, 0)
})

test('browser crash or spawn error completes once and prevents stale success', async () => {
  for (const event of ['exit', 'error']) {
    const f = browserFixture()
    const completes = []
    f.manager.on('complete', value => completes.push(value))
    const result = f.manager.startLogin(startOptions)
    await tick()
    f.children[0].emit(event, event === 'error' ? new Error('private spawn error must not leak') : 1)
    const value = await result
    assert.equal(value.success, false)
    assert.ok(!value.error.includes('private'))
    f.manager.completeWithSuccess({ userToken: 'late-fixture-token' })
    assert.equal(completes.length, 1)
    assert.equal(f.removed.length, 1)
  }
})

test('timeout and late token response cannot report success after cancelled attempt', async () => {
  const evaluation = deferred(), f = browserFixture({ evaluation })
  const tokens = []
  f.manager.on('tokenFound', value => tokens.push(value))
  const result = f.manager.startLogin({ ...startOptions, timeout: 1000 })
  await tick(); f.advance(5001); await f.poll()
  await f.timeout(1000)
  assert.match((await result).error, /timeout/)
  evaluation.resolve(); await tick()
  assert.equal(tokens.length, 0)
  assert.equal(f.removed.length, 1)
})

test('slow graceful browser exit retains profile until exact owned child exits; no process killing', async () => {
  const f = browserFixture({ exitOnClose: false })
  const warnings = []
  f.manager.on('cleanupWarning', value => warnings.push(value))
  const result = f.manager.startLogin(startOptions)
  await tick(); f.manager.cancel(); await tick()
  assert.equal(f.removed.length, 0)
  await f.timeout(5000); await result
  assert.equal(f.removed.length, 0)
  assert.ok(warnings.some(value => value.includes('still closing')))
  f.children[0].emit('exit', 0); await tick()
  assert.equal(f.removed.length, 1)
  assert.equal(f.removed[0].exited, true)
})

test('async cancellation waits for the same owned browser cleanup and is safe when idle or repeated', async () => {
  const f = browserFixture({ exitOnClose: false })
  assert.equal(await f.manager.cancelAndWait(), undefined)
  assert.equal(f.timeouts.size, 0)
  const result = f.manager.startLogin(startOptions)
  await tick()
  let settled = false
  const firstWait = f.manager.cancelAndWait().then(() => { settled = true })
  const secondWait = f.manager.cancelAndWait()
  await tick()
  assert.equal(settled, false)
  assert.equal(f.manager.isWindowOpen(), true)
  assert.equal(f.commands.filter(value => value.method === 'Browser.close').length, 1)
  assert.equal(f.removed.length, 0)
  f.children[0].emit('exit', 0)
  await Promise.all([firstWait, secondWait])
  assert.match((await result).error, /cancelled/)
  assert.equal(f.removed.length, 1)
  assert.equal(f.manager.isWindowOpen(), false)
  assert.equal(f.timeouts.size, 0)
})

test('async cancellation awaits a pending successful closure without changing the validated result', async () => {
  const f = browserFixture({ exitOnClose: false })
  const result = f.manager.startLogin(startOptions)
  await tick()
  f.manager.completeWithSuccess({ userToken: 'fixture-validated-token' })
  const shutdown = f.manager.cancelAndWait()
  await tick()
  f.children[0].emit('exit', 0)
  await shutdown
  assert.deepEqual(plain(await result), { success: true, credentials: { userToken: 'fixture-validated-token' } })
  assert.equal(f.removed.length, 1)
  assert.equal(f.timeouts.size, 0)
})

test('async cancellation has a ten-second hard wait limit without unsafe cleanup of pending resources', async () => {
  const profileCreation = deferred(), f = browserFixture({ profileCreation })
  const warnings = []
  f.manager.on('cleanupWarning', value => warnings.push(value))
  const result = f.manager.startLogin(startOptions)
  await tick()
  const shutdown = f.manager.cancelAndWait()
  await f.timeout(10000)
  assert.equal(await shutdown, undefined)
  assert.equal(f.children.length, 0)
  assert.equal(f.removed.length, 0)
  assert.ok(warnings.some(value => value.includes('longer than expected')))
  assert.equal(f.manager.isWindowOpen(), true)
  profileCreation.resolve()
  await result
  assert.equal(f.children.length, 0)
  assert.equal(f.removed.length, 1)
  assert.equal(f.timeouts.size, 0)
})

test('successive accounts receive distinct profiles and stale child exit cannot cancel next attempt', async () => {
  const f = browserFixture()
  const first = f.manager.startLogin(startOptions)
  await tick(); f.manager.cancel(); await first
  const second = f.manager.startLogin({ ...startOptions, proxyMode: 'none' })
  await tick()
  assert.notEqual(f.children[0].args[0], f.children[1].args[0])
  assert.ok(f.children[1].args.includes('--no-proxy-server'))
  f.children[0].emit('exit', 0)
  assert.equal(f.manager.isWindowOpen(), true)
  f.manager.cancel(); await second
})

test('missing browser, unsafe profile root and invalid options fail before process launch', async () => {
  for (const options of [{ missingBrowser: true }, { rootEscape: true }]) {
    const f = browserFixture(options)
    const result = await f.manager.startLogin(startOptions)
    assert.equal(result.success, false)
    assert.ok(!result.error.includes('private-path'))
    assert.equal(f.children.length, 0)
  }
  const f = browserFixture()
  for (const options of [{ ...startOptions, providerType: 'kimi' }, { ...startOptions, proxyMode: 'auto' }, { ...startOptions, timeout: 999 }, { ...startOptions, timeout: Infinity }]) {
    assert.equal((await f.manager.startLogin(options)).success, false)
  }
  assert.equal(f.files.length, 0)
})

test('profile recursive cleanup rejects root, siblings, nested paths and substituted canonical destinations', async () => {
  const removed = [], owner = path.join(root, '.audit-cache', 'owned-profiles')
  let substituted
  const module = load('src/main/oauth/externalBrowserLogin.ts', {
    electron: {}, './loginPolicy': policy, './cdpPipe': { CdpPipe }, './browserDiscovery': discovery,
    'node:fs/promises': { async realpath(value) { return substituted && value !== owner ? substituted : value }, async rm(value) { removed.push(value) } },
    'node:child_process': { spawn() { throw new Error('Must not spawn') } },
  })
  for (const profile of [owner, path.join(root, '.audit-cache', 'outside', 'login-1'), path.join(owner, 'nested', 'login-1'), path.join(owner, 'Default')]) {
    await assert.rejects(module.removeOwnedLoginProfile(owner, profile), /ownership check/)
  }
  substituted = path.join(root, '.audit-cache', 'outside', 'login-2')
  await assert.rejects(module.removeOwnedLoginProfile(owner, path.join(owner, 'login-1')), /ownership check/)
  substituted = path.join(owner, 'login-2')
  await assert.rejects(module.removeOwnedLoginProfile(owner, path.join(owner, 'login-1')), /path changed/)
  substituted = undefined
  await module.removeOwnedLoginProfile(owner, path.join(owner, 'login-valid'))
  assert.deepEqual(removed, [path.join(owner, 'login-valid')])
})
