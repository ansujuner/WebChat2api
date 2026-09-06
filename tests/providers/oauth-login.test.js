const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const ts = require('typescript')

const root = join(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function load(relative, overrides = {}, globals = {}) {
  const fileName = join(root, relative)
  const code = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() { throw new Error('Login must not log credentials') }, error() { throw new Error('Login must not log raw errors') }, warn() {} },
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      if (name.startsWith('.')) throw new Error(`Unmocked dependency ${name}`)
      return require(name)
    }, ...globals,
  }, { filename: fileName })
  return module.exports
}
const policy = load('src/main/oauth/loginPolicy.ts')
const configs = load('src/main/oauth/tokenExtractionConfig.ts')

function browserFixture({ proxy, loadError } = {}) {
  const windows = [], sessions = [], order = [], timeouts = new Map(), intervals = new Map()
  let now = 1000, nextTimer = 0
  class Clock extends Date { static now() { return now } }
  class Contents extends EventEmitter {
    constructor() { super(); this.url = ''; this.storage = {}; this.scripts = [] }
    setWindowOpenHandler(handler) { this.openHandler = handler }
    isDestroyed() { return false }
    getURL() { return this.url }
    async executeJavaScript(script) {
      this.scripts.push(script)
      const key = JSON.parse(script.slice('localStorage.getItem('.length, -1))
      return this.storage[key] ?? null
    }
  }
  class Window extends EventEmitter {
    constructor(options) { super(); this.options = options; this.webContents = new Contents(); this.destroyed = false; windows.push(this); order.push('window') }
    async loadURL(url) { order.push('navigate'); assert.equal(typeof this.options.webPreferences.session.interceptor, 'function'); this.webContents.url = url; if (loadError) throw loadError }
    isDestroyed() { return this.destroyed }
    show() { this.shown = true }
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  const electron = { BrowserWindow: Window, session: { fromPartition(partition) {
    const cookies = new EventEmitter()
    const result = { partition, cookieValues: [], cookies,
      webRequest: { onBeforeSendHeaders(fn) { result.interceptor = fn; order.push(fn ? 'interception' : 'unhook') } },
      async clearStorageData() { result.cleared = true },
      async closeAllConnections() { result.closedConnections = true },
    }
    cookies.get = async () => result.cookieValues
    sessions.push(result)
    return result
  } } }
  const { InAppLoginManager } = load('src/main/oauth/inAppLogin.ts', {
    electron, './tokenExtractionConfig': configs, './loginPolicy': policy,
    '../network/proxy': { async applyProxyToSession(session, mode) { order.push('proxy-start'); session.mode = mode; if (proxy) await proxy.promise; order.push('proxy-ready') } },
  }, { Date: Clock,
    setTimeout(fn) { const id = ++nextTimer; timeouts.set(id, fn); return id }, clearTimeout(id) { timeouts.delete(id) },
    setInterval(fn) { const id = ++nextTimer; intervals.set(id, fn); return id }, clearInterval(id) { intervals.delete(id) },
  })
  const manager = new InAppLoginManager()
  return { manager, windows, sessions, order, timeouts, intervals, Window, advance(ms) { now += ms } }
}

test('login origin checks reject suffix tricks and foreign identity providers', () => {
  for (const host of ['kimi.com', '.kimi.com', 'www.kimi.com', 'api.kimi.com']) assert.equal(policy.isProviderHost(host, ['.kimi.com']), true)
  for (const host of ['evilkimi.com', 'kimi.com.evil.test', 'accounts.google.com']) assert.equal(policy.isProviderHost(host, ['.kimi.com']), false)
  assert.equal(policy.isProviderUrl('https://kimi.com.evil.test/path', ['kimi.com']), false)
  assert.equal(policy.isProviderUrl('file:///kimi.com', ['kimi.com']), false)
})

test('login allows normal HTTP(S) popups but not file/javascript/custom protocols', () => {
  for (const url of ['about:blank', 'https://accounts.google.com/login', 'http://localhost/callback']) assert.equal(policy.isBrowserLoginUrl(url), true)
  for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,hello', 'custom://app', 'https://user:password@example.com']) assert.equal(policy.isBrowserLoginUrl(url), false)
})

test('candidate checks do not accept expired/guest/malformed JWTs or treat local parsing as validation', () => {
  const jwt = payload => 'eyJhbGciOiJIUzI1NiJ9.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature'
  assert.equal(policy.isCredentialCandidate(jwt({ sub: 'fixture', exp: 1000 }), 1000001), false)
  assert.equal(policy.isCredentialCandidate(jwt({ email: 'x@guest.com' })), false)
  assert.equal(policy.isCredentialCandidate(jwt({ sub: 'fixture', guest: true })), false)
  assert.equal(policy.isCredentialCandidate(jwt({ sub: 'fixture', exp: 100000 }), 1000), true)
  assert.equal(policy.isCredentialCandidate('eyJinvalid.parts.only'), false)
  assert.equal(policy.isCredentialCandidate('has spaces'), false)
})

test('stored credentials handle configured JSON wrappers without executing content', () => {
  assert.equal(policy.storedCredential('{"value":"fixture-token"}'), 'fixture-token')
  assert.equal(policy.storedCredential('{broken'), undefined)
  assert.equal(policy.storedCredential({ value: 'token' }), undefined)
})

test('login awaits explicit proxy configuration before creating browser or navigating', async () => {
  const proxy = deferred()
  const f = browserFixture({ proxy })
  const result = f.manager.startLogin({ providerId: 'deepseek', providerType: 'deepseek', proxyMode: 'none' })
  assert.deepEqual(f.order, ['proxy-start'])
  assert.equal(f.manager.isWindowOpen(), true)
  proxy.resolve()
  await tick()
  assert.deepEqual(f.order.slice(0, 5), ['proxy-start', 'proxy-ready', 'window', 'interception', 'navigate'])
  assert.equal(f.sessions[0].mode, 'none')
  const prefs = f.windows[0].options.webPreferences
  assert.equal(prefs.nodeIntegration, false)
  assert.equal(prefs.contextIsolation, true)
  assert.equal(prefs.sandbox, true)
  assert.equal(prefs.webSecurity, true)
  assert.equal(prefs.allowRunningInsecureContent, false)
  assert.equal(prefs.userAgent, undefined)
  f.manager.cancel()
  assert.equal((await result).success, false)
})

test('login uses distinct ephemeral sessions for successive accounts and removes its hooks', async () => {
  const f = browserFixture()
  const first = f.manager.startLogin({ providerId: 'deepseek', providerType: 'deepseek' })
  await tick()
  f.manager.cancel()
  await first
  const second = f.manager.startLogin({ providerId: 'deepseek', providerType: 'deepseek' })
  await tick()
  assert.notEqual(f.sessions[0].partition, f.sessions[1].partition)
  assert.ok(f.sessions.every(item => !item.partition.startsWith('persist:')))
  assert.equal(f.sessions[0].interceptor, null)
  assert.equal(f.sessions[0].cleared, true)
  assert.equal(f.sessions[0].cookies.listenerCount('changed'), 0)
  assert.equal(f.sessions[1].mode, 'system')
  f.manager.cancel()
  await second
  assert.equal(f.timeouts.size, 0)
  assert.equal(f.intervals.size, 0)
})

test('login concurrent start rejected while proxy initialization still pending', async () => {
  const proxy = deferred()
  const f = browserFixture({ proxy })
  const first = f.manager.startLogin({ providerId: 'deepseek', providerType: 'deepseek' })
  const second = await f.manager.startLogin({ providerId: 'kimi', providerType: 'kimi' })
  assert.equal(second.success, false)
  assert.equal(f.sessions.length, 1)
  f.manager.cancel()
  proxy.resolve()
  await first
  await tick()
  assert.equal(f.windows.length, 0)
})

test('login proxy setup failure returns safe error without page navigation or raw secret logs', async () => {
  const proxy = deferred()
  const f = browserFixture({ proxy })
  const result = f.manager.startLogin({ providerId: 'deepseek', providerType: 'deepseek' })
  proxy.reject(Object.assign(new Error('http://user:SECRET@proxy.test'), { code: 'ERR_PROXY_CONNECTION_FAILED' }))
  const response = await result
  assert.equal(response.success, false)
  assert.match(response.error, /proxy/)
  assert.doesNotMatch(response.error, /SECRET/)
  assert.equal(f.windows.length, 0)
})

test('login popups retain opener browser session and secure browser defaults', async () => {
  const f = browserFixture()
  const result = f.manager.startLogin({ providerId: 'deepseek', providerType: 'deepseek' })
  await tick()
  const parent = f.windows[0]
  const options = parent.webContents.openHandler({ url: 'https://accounts.google.com/login' })
  assert.equal(options.action, 'allow')
  assert.equal(options.outlivesOpener, false)
  assert.equal(options.overrideBrowserWindowOptions.webPreferences.session, f.sessions[0])
  assert.equal(options.overrideBrowserWindowOptions.webPreferences.sandbox, true)
  assert.equal(parent.webContents.openHandler({ url: 'file:///secret' }).action, 'deny')
  const popup = new f.Window(options.overrideBrowserWindowOptions)
  parent.webContents.emit('did-create-window', popup)
  assert.equal(typeof popup.webContents.openHandler, 'function')
  f.manager.cancel()
  await result
  assert.equal(popup.isDestroyed(), true)
})

test('login observes only provider Authorization headers without changing browser headers', async () => {
  const f = browserFixture()
  const result = f.manager.startLogin({ providerId: 'kimi', providerType: 'kimi' })
  const found = []
  f.manager.on('tokenFound', event => found.push(event))
  await tick()
  f.advance(6000)
  const headers = { Authorization: 'Bearer fixture-token', 'User-Agent': 'actual-runtime' }
  for (const url of ['https://accounts.google.com/token', 'https://kimi.com.evil.test/token', 'https://www.kimi.com/api']) {
    f.sessions[0].interceptor({ url, requestHeaders: headers }, response => assert.equal(response.requestHeaders, headers))
  }
  assert.deepEqual(plain(found), [{ key: 'token', value: 'fixture-token' }])
  f.manager.cancel()
  await result
})

test('login retains early provider network token until settled and permits safe validation retries', async () => {
  const f = browserFixture()
  const result = f.manager.startLogin({ providerId: 'kimi', providerType: 'kimi' })
  const found = []
  f.manager.on('tokenFound', event => found.push(event))
  await tick()
  f.sessions[0].interceptor({ url: 'https://www.kimi.com/api', requestHeaders: { Authorization: 'Bearer early-fixture-token' } }, () => {})
  assert.equal(found.length, 0)
  f.advance(6000)
  await f.manager.checkForTokens()
  assert.equal(found[0].value, 'early-fixture-token')
  await f.manager.checkForTokens()
  assert.equal(found.length, 2)
  f.manager.cancel()
  await result
})

test('login reads configured localStorage on provider pages only, without injected logs or fingerprints', async () => {
  const f = browserFixture()
  const result = f.manager.startLogin({ providerId: 'deepseek', providerType: 'deepseek' })
  const found = []
  f.manager.on('tokenFound', event => found.push(event))
  await tick()
  f.advance(6000)
  const contents = f.windows[0].webContents
  contents.storage.userToken = '{"value":"fixture-user-token"}'
  contents.url = 'https://accounts.google.com/login'
  await f.manager.checkForTokens()
  assert.equal(found.length, 0)
  assert.equal(contents.scripts.length, 0)
  contents.url = 'https://chat.deepseek.com/'
  await f.manager.checkForTokens()
  assert.deepEqual(plain(found), [{ key: 'userToken', value: 'fixture-user-token' }])
  assert.deepEqual(contents.scripts, ['localStorage.getItem("userToken")'])
  f.manager.cancel()
  await result
})

test('login scopes HttpOnly cookies and saved cookie map to the target provider', async () => {
  const f = browserFixture()
  const result = f.manager.startLogin({ providerId: 'glm', providerType: 'glm' })
  const found = []
  f.manager.on('tokenFound', event => found.push(event))
  await tick()
  f.advance(6000)
  f.sessions[0].cookieValues = [
    { name: 'chatglm_refresh_token', value: 'foreign-token', domain: '.google.com', httpOnly: true },
    { name: 'chatglm_refresh_token', value: 'provider-token', domain: '.chatglm.cn', httpOnly: true },
    { name: 'preference', value: 'zh', domain: 'chatglm.cn' },
  ]
  await f.manager.checkForTokens()
  assert.deepEqual(plain(found), [{ key: 'chatglm_refresh_token', value: 'provider-token', allCookies: { chatglm_refresh_token: 'provider-token', preference: 'zh' } }])
  f.manager.cancel()
  await result
})

test('login timeout and browser close complete exactly once without leaked timers', async () => {
  const f = browserFixture()
  const completed = []
  f.manager.on('complete', event => completed.push(event))
  const result = f.manager.startLogin({ providerId: 'deepseek', providerType: 'deepseek' })
  await tick()
  f.timeouts.values().next().value()
  f.manager.cancel()
  assert.equal((await result).success, false)
  assert.equal(completed.length, 1)
  assert.equal(f.timeouts.size, 0)
  assert.equal(f.intervals.size, 0)
})

function oauthFixture(validateToken) {
  let lastBrowser
  const makeBrowser = () => {
    const browser = new EventEmitter()
    let pending
    browser.starts = []
    browser.completions = []
    browser.isWindowOpen = () => !!pending
    browser.startLogin = async options => {
      lastBrowser = browser
      browser.options = options
      browser.starts.push(plain(options))
      pending = deferred()
      return pending.promise
    }
    browser.completeWithSuccess = credentials => {
      browser.completions.push(plain(credentials))
      const flow = pending
      pending = null
      assert.ok(flow, 'Only the active browser may complete its login')
      flow.resolve({ success: true, credentials })
    }
    browser.cancel = () => { const flow = pending; pending = null; flow?.resolve({ success: false, error: 'cancelled' }) }
    browser.destroy = browser.cancel
    return browser
  }
  const embedded = makeBrowser()
  const external = makeBrowser()
  const adapter = { validateToken, setProgressCallback() {}, setMainWindow() {}, destroy() {} }
  const { OAuthManager } = load('src/main/oauth/manager.ts', {
    electron: { shell: { openExternal() {} } }, './adapters': { createAdapter: () => adapter },
    '../arena/browserManager': { arenaBrowserManager: { isWindowOpen: () => false, cancel() {} } },
    './inAppLogin': { inAppLoginManager: embedded }, './externalBrowserLogin': { externalBrowserLoginManager: external },
  })
  const manager = new OAuthManager()
  return { manager, embedded, external, get browser() { return lastBrowser } }
}

test('DeepSeek OAuth selects only external browser login, validates its token, and ignores embedded events', async () => {
  const seen = []
  const f = oauthFixture(async credentials => { seen.push(plain(credentials)); return { valid: true, accountInfo: { email: 'external@example.test' } } })
  assert.notEqual(f.embedded, f.external)
  const result = f.manager.startInAppLogin('fixture-deepseek-provider', 'deepseek', 120000, 'none')
  assert.deepEqual(f.external.starts, [{ providerId: 'fixture-deepseek-provider', providerType: 'deepseek', timeout: 120000, proxyMode: 'none' }])
  assert.equal(f.embedded.starts.length, 0)
  assert.equal(f.embedded.listenerCount('tokenFound'), 0)
  assert.equal(f.embedded.listenerCount('status'), 0)
  f.embedded.emit('tokenFound', { key: 'userToken', value: 'wrong-embedded-fixture' })
  assert.deepEqual(seen, [])
  f.external.emit('tokenFound', { key: 'userToken', value: 'external-fixture' })
  const response = await result
  assert.equal(response.success, true)
  assert.deepEqual(seen, [{ userToken: 'external-fixture' }])
  assert.equal(response.accountInfo.email, 'external@example.test')
  assert.equal(f.external.completions.length, 1)
  assert.equal(f.embedded.completions.length, 0)
  assert.equal(f.external.listenerCount('tokenFound'), 0)
  assert.equal(f.external.listenerCount('status'), 0)
})

test('non-DeepSeek providers retain embedded login and do not consume external-browser tokens', async () => {
  for (const providerType of ['glm', 'kimi', 'minimax', 'mimo', 'qwen', 'qwen-ai', 'zai', 'perplexity']) {
    const seen = []
    const f = oauthFixture(async credentials => { seen.push(credentials); return { valid: true } })
    const result = f.manager.startInAppLogin(`fixture-${providerType}`, providerType, 1000, 'system')
    assert.equal(f.embedded.starts.length, 1, providerType)
    assert.equal(f.external.starts.length, 0, providerType)
    assert.equal(f.external.listenerCount('tokenFound'), 0, providerType)
    assert.equal(f.external.listenerCount('status'), 0, providerType)
    f.external.emit('tokenFound', { key: 'token', value: 'wrong-external-fixture' })
    assert.deepEqual(seen, [])
    f.manager.cancelInAppLogin()
    assert.equal((await result).success, false)
    assert.equal(f.embedded.listenerCount('tokenFound'), 0)
  }
})

test('external DeepSeek startup failure does not fall back to the blocked embedded browser', async () => {
  const f = oauthFixture(async () => ({ valid: true }))
  f.external.startLogin = async () => { throw new Error('private browser startup fixture') }
  const response = await f.manager.startInAppLogin('deepseek', 'deepseek')
  assert.equal(response.success, false)
  assert.doesNotMatch(response.error, /private browser startup/)
  assert.equal(f.embedded.starts.length, 0)
  assert.equal(f.external.listenerCount('tokenFound'), 0)
  assert.equal(f.external.listenerCount('status'), 0)
  assert.equal(f.manager.getStatus(), 'idle')
})

test('OAuth manager preserves only successfully validated account identity and never logs tokens', async () => {
  const accountInfo = { email: 'fixture@example.test', userId: 'fixture-id', name: 'Fixture' }
  const f = oauthFixture(async credentials => {
    assert.deepEqual(plain(credentials), { userToken: 'fixture-secret' })
    return { valid: true, accountInfo }
  })
  const result = f.manager.startInAppLogin('deepseek', 'deepseek', undefined, 'none')
  f.browser.emit('tokenFound', { key: 'userToken', value: 'fixture-secret' })
  const response = await result
  assert.equal(response.success, true)
  assert.deepEqual(plain(response.accountInfo), accountInfo)
  assert.equal(f.browser.options.proxyMode, 'none')
  assert.equal(f.browser.listenerCount('tokenFound'), 0)
  assert.equal(f.browser.listenerCount('status'), 0)
  assert.equal(f.manager.getStatus(), 'idle')
})

test('OAuth manager prevents overlapping login listeners and cross-account completion', async () => {
  const validation = deferred()
  const f = oauthFixture(() => validation.promise)
  const first = f.manager.startInAppLogin('deepseek', 'deepseek')
  assert.equal((await f.manager.startInAppLogin('kimi', 'kimi')).success, false)
  assert.equal(f.browser.listenerCount('tokenFound'), 1)
  f.browser.emit('tokenFound', { key: 'userToken', value: 'fixture-token' })
  f.manager.cancelInAppLogin()
  assert.equal((await first).success, false)
  validation.resolve({ valid: true, accountInfo: { email: 'cancelled@example.test' } })
  await tick()
  assert.equal(f.browser.listenerCount('tokenFound'), 0)
})

test('OAuth manager stores provider cookie maps as strings, never foreign objects in credential fields', async () => {
  const f = oauthFixture(async () => ({ valid: true }))
  const result = f.manager.startInAppLogin('perplexity', 'perplexity')
  f.browser.emit('tokenFound', { key: 'sessionToken', value: 'fixture-session', allCookies: { sessionToken: 'fixture-session', preference: 'zh' } })
  const response = await result
  assert.equal(typeof response.credentials.cookies, 'string')
  assert.deepEqual(JSON.parse(response.credentials.cookies), { sessionToken: 'fixture-session', preference: 'zh' })
  assert.equal(response.accountInfo, undefined)
})

test('OAuth manager waits for all MiMo fields before any account validation', async () => {
  const seen = []
  const f = oauthFixture(async credentials => { seen.push(credentials); return { valid: true } })
  const result = f.manager.startInAppLogin('mimo', 'mimo')
  f.browser.emit('tokenFound', { key: 'serviceToken', value: 'fixture-service' })
  f.browser.emit('tokenFound', { key: 'userId', value: '123' })
  assert.equal(seen.length, 0)
  f.browser.emit('tokenFound', { key: 'xiaomichatbot_ph', value: 'fixture-ph' })
  assert.equal((await result).success, true)
  assert.deepEqual(plain(seen), [{ service_token: 'fixture-service', user_id: '123', ph_token: 'fixture-ph' }])
})

test('OAuth manager failed validation shows safe retry status, never a token-bearing upstream error', async () => {
  const f = oauthFixture(async () => { throw new Error('Bearer SECRET-FIXTURE') })
  const progress = []
  f.manager.sendProgressToRenderer = event => progress.push(event)
  const result = f.manager.startInAppLogin('deepseek', 'deepseek')
  f.browser.emit('tokenFound', { key: 'userToken', value: 'fixture-token' })
  await tick()
  assert.doesNotMatch(JSON.stringify(progress), /SECRET-FIXTURE/)
  f.manager.cancelInAppLogin()
  assert.equal((await result).success, false)
})

function qwenFixture(response) {
  const requests = []
  class Base { constructor(config) { this.config = config } emitProgress() {} }
  const { QwenAiAdapter } = load('src/main/oauth/adapters/qwen-ai.ts', {
    './base': { BaseOAuthAdapter: Base },
    axios: { default: { async get(url, options) { requests.push({ url, options }); if (response instanceof Error) throw response; return response } } },
  })
  return { requests, adapter: new QwenAiAdapter({ providerId: 'qwen-ai', providerType: 'qwen-ai', authMethods: [], callbackPort: 8311 }) }
}
const fixtureJwt = payload => 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.not-a-verified-signature'

test('Qwen AI cannot authenticate from an unsigned JWT when the profile API rejects it', async () => {
  for (const response of [{ status: 401, data: {} }, { status: 200, data: { success: false } }, new Error('SECRET-token-in-network-error')]) {
    const f = qwenFixture(response)
    const result = await f.adapter.validateToken({ token: fixtureJwt({ id: 'claimed-id', email: 'unverified@example.test' }) })
    assert.equal(result.valid, false)
    assert.equal(result.accountInfo, undefined)
    assert.doesNotMatch(result.error, /SECRET/)
    assert.equal(f.requests.length, 1)
  }
})

test('Qwen AI validates only a meaningful server account profile', async () => {
  for (const data of [null, {}, [], { success: true }, { arbitrary: 'field' }]) {
    const f = qwenFixture({ status: 200, data: { success: true, data } })
    const result = await f.adapter.validateToken({ token: fixtureJwt({ id: 'claimed-id', email: 'unverified@example.test' }) })
    assert.equal(result.valid, false)
    assert.equal(result.accountInfo, undefined)
  }
})

test('Qwen AI uses server identity rather than contradictory JWT email and name', async () => {
  const f = qwenFixture({ status: 200, data: { success: true, data: { id: 'server-id', email: 'server@example.test', name: 'Server Name' } } })
  const result = await f.adapter.validateToken({ token: fixtureJwt({ id: 'claimed-id', email: 'unverified@example.test', name: 'Unverified Name' }) })
  assert.equal(result.valid, true)
  assert.deepEqual(plain(result.accountInfo), { userId: 'server-id', email: 'server@example.test', name: 'Server Name' })
  const headers = f.requests[0].options.headers
  assert.equal(headers['User-Agent'], undefined)
  assert.equal(headers['Sec-Ch-Ua'], undefined)
})

test('Qwen AI never fills missing server email/name from JWT claims', async () => {
  const f = qwenFixture({ status: 200, data: { success: true, data: { id: 'server-id' } } })
  const result = await f.adapter.validateToken({ token: fixtureJwt({ id: 'claimed-id', email: 'unverified@example.test', name: 'Unverified Name' }) })
  assert.deepEqual(plain(result.accountInfo), { userId: 'server-id' })
})

test('Qwen AI rejects a remotely confirmed guest and obvious expired local credential', async () => {
  const guest = qwenFixture({ status: 200, data: { success: true, data: { id: 'guest-id', is_guest: true } } })
  assert.equal((await guest.adapter.validateToken({ token: fixtureJwt({ id: 'claimed-id' }) })).valid, false)
  const expired = qwenFixture({ status: 200, data: { success: true, data: { id: 'id' } } })
  assert.equal((await expired.adapter.validateToken({ token: fixtureJwt({ id: 'claimed-id', exp: 1 }) })).valid, false)
  assert.equal(expired.requests.length, 0)
})

test('Qwen AI accepts opaque tokens only after successful server verification', async () => {
  const f = qwenFixture({ status: 200, data: { success: true, data: { user_id: 123, email: 'profile@example.test' } } })
  const result = await f.adapter.loginWithToken('qwen-ai', 'opaque-fixture-token')
  assert.equal(result.success, true)
  assert.deepEqual(plain(result.accountInfo), { userId: '123', email: 'profile@example.test' })
})
