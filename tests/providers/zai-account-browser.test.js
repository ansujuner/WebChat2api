const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const ts = require('typescript')

const ROOT = path.join(__dirname, '../..')
const ORIGIN = 'https://chat.z.ai'
const plain = value => JSON.parse(JSON.stringify(value))
const tick = async () => { for (let index = 0; index < 80; index++) await Promise.resolve() }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function load(file, imports = {}, globals = {}) {
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync(path.join(ROOT, file), 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText
  vm.runInNewContext(source, {
    module, exports: module.exports, URL, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() { throw new Error('No browser credential logs') }, warn() { throw new Error('No raw upstream logs') }, error() { throw new Error('No raw upstream errors') } },
    require(name) { if (Object.hasOwn(imports, name)) return imports[name]; if (name.startsWith('.') || name === 'electron') throw new Error(`Unmocked ${name}`); return require(name) },
    ...globals,
  }, { filename: file })
  return module.exports
}

/** Execute production injected JS against synthetic page storage and same-origin auth fetch. No network/profile access. */
function fixture(options = {}) {
  const windows = [], sessions = [], requests = [], intervals = new Set(), timeouts = new Map(), events = []
  let sequence = 0
  const timerGlobals = {
    setTimeout(fn, ms) { const id = ++sequence; timeouts.set(id, { fn, ms }); return id }, clearTimeout(id) { timeouts.delete(id) },
    setInterval(fn) { const id = { fn }; intervals.add(id); return id }, clearInterval(id) { intervals.delete(id) },
  }
  class Window extends EventEmitter {
    constructor(config) {
      super(); this.config = config; this.destroyed = false; this.focuses = 0; this.loads = []; this.url = ''
      this.webContents = new EventEmitter()
      const contents = this.webContents
      contents.getURL = () => this.url
      contents.isDestroyed = () => this.destroyed
      contents.setWindowOpenHandler = handler => { contents.openHandler = handler }
      contents.executeJavaScript = async script => {
        const thisWindow = this
        if (options.beforeExecute) await options.beforeExecute(this, script)
        const isolated = config.webPreferences.session
        const storageForOrigin = () => {
          const origin = new URL(this.url).origin
          if (!isolated.storage.has(origin)) isolated.storage.set(origin, new Map())
          return isolated.storage.get(origin)
        }
        const value = vm.runInNewContext(script, {
          get location() { return new URL(thisWindow.url) }, URL, AbortController,
          setTimeout: timerGlobals.setTimeout, clearTimeout: timerGlobals.clearTimeout,
          localStorage: { getItem(key) { return storageForOrigin().get(key) ?? null }, setItem(key, value) { storageForOrigin().set(key, value) } },
          fetch: async (url, init) => {
            const request = { session: isolated, url: new URL(url, this.url).href, init: plain({ ...init, signal: undefined }) }
            requests.push(request)
            assert.equal(request.url, `${ORIGIN}/api/v1/auths/`)
            const token = init.headers.Authorization.slice(7)
            const reply = options.respond ? await options.respond(token, request) : { status: 200, body: { id: 'user-1', email: 'one@example.test', token } }
            const status = reply.status ?? 200
            return { status, ok: status >= 200 && status < 300, url: reply.url ?? request.url, text: async () => reply.text ?? JSON.stringify(reply.body) }
          },
        })
        return value
      }
      windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    restore() {}
    show() { this.visible = true }
    focus() { this.focuses++ }
    async loadURL(url) {
      this.url = options.navigate ? options.navigate(url, this.loads.length) : url
      this.loads.push(this.url); events.push(['load', this.config.webPreferences.session.partition])
      this.emit('ready-to-show'); this.webContents.emit('did-finish-load')
      if (options.afterLoad) await options.afterLoad(this)
    }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed') } }
  }
  const electron = { BrowserWindow: Window, session: { fromPartition(partition) {
    const isolated = { partition, storage: new Map(), cookieWrites: [], clears: 0, connections: 0,
      cookies: { async set(cookie) { if (options.cookieError) throw options.cookieError; isolated.cookieWrites.push(plain(cookie)) } },
      async clearStorageData() { isolated.clears++; isolated.storage.clear() },
      async closeAllConnections() { isolated.connections++ },
    }
    sessions.push(isolated); return isolated
  } } }
  const identity = load('src/shared/accountIdentity.ts')
  const { ZaiAccountBrowserManager } = load('src/main/oauth/zaiAccountBrowser.ts', {
    electron, '../../shared/accountIdentity': identity,
    '../network/proxy': { async applyProxyToSession(session, mode) { events.push(['proxy', session.partition, mode]); if (options.proxyWait) await options.proxyWait } },
  }, timerGlobals)
  const manager = new ZaiAccountBrowserManager()
  return { manager, windows, sessions, requests, events, timeouts, intervals,
    async poll() { for (const timer of [...intervals]) timer.fn(); await tick() },
    async timeout() { for (const [id, timer] of [...timeouts]) if (timer.ms === 300000) { timeouts.delete(id); timer.fn() }; await tick() },
    setToken(index, token, origin = ORIGIN) { const isolated = sessions[index]; if (!isolated.storage.has(origin)) isolated.storage.set(origin, new Map()); isolated.storage.get(origin).set('token', token) },
  }
}

const config = (accountId = 'account-1', token = 'fixture-token-1', expectedIdentity = { userId: 'user-1', email: 'one@example.test' }) => ({ accountId, credentials: { token }, expectedIdentity })

test('restores only token into an isolated official-origin session and verifies actual auth endpoint', async () => {
  const f = fixture()
  const result = f.manager.authenticate(config())
  await tick()
  assert.deepEqual(plain(await result), { success: true, credentials: { token: 'fixture-token-1' }, accountInfo: { userId: 'user-1', email: 'one@example.test' } })
  const session = f.sessions[0], window = f.windows[0]
  assert.ok(!session.partition.startsWith('persist:'))
  assert.deepEqual(window.loads, [`${ORIGIN}/`, `${ORIGIN}/`])
  assert.deepEqual(session.cookieWrites, [{ url: `${ORIGIN}/`, name: 'token', value: 'fixture-token-1', path: '/', secure: true, httpOnly: false, sameSite: 'lax' }])
  assert.deepEqual(plain(window.config.webPreferences), { session: plain(session), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false })
  assert.equal(f.events[0][0], 'proxy'); assert.equal(f.events[0][2], 'system')
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].init.credentials, 'omit')
  assert.equal(f.requests[0].init.redirect, 'error')
  assert.equal(f.requests[0].init.method, 'GET')
  assert.deepEqual(plain(f.manager.getAccountState('account-1')), { windowOpen: true, authenticated: true, exactOrigin: true, stage: 'ready' })
  assert.equal(session.clears, 0); assert.equal(window.destroyed, false)
  await f.manager.destroy()
})

test('same account focuses/reuses pending operation; separate accounts never share session or tokens', async () => {
  const f = fixture({ respond: () => ({ status: 401 }) })
  const first = f.manager.authenticate(config())
  assert.equal(f.manager.authenticate(config()), first)
  const second = f.manager.authenticate(config('account-2', 'fixture-token-2'))
  await tick()
  assert.equal(f.manager.authenticate(config()), first)
  assert.equal(f.windows.length, 2); assert.notEqual(f.sessions[0].partition, f.sessions[1].partition)
  assert.equal(f.sessions[0].storage.get(ORIGIN).get('token'), 'fixture-token-1')
  assert.equal(f.sessions[1].storage.get(ORIGIN).get('token'), 'fixture-token-2')
  assert.ok(f.windows[0].focuses >= 3)
  await f.manager.clearAccount('account-1')
  assert.equal((await first).errorCode, 'cancelled')
  assert.equal(f.sessions[0].clears, 1); assert.equal(f.sessions[1].clears, 0)
  assert.equal(f.windows[1].destroyed, false)
  await f.manager.destroy(); assert.equal((await second).errorCode, 'cancelled')
})

test('HTTP200 guest is not authenticated; manual login requires real non-guest server identity', async () => {
  const f = fixture({ respond: token => ({ body: { id: token === 'manual-fixture-token' ? 'user-1' : 'guest-1', email: token === 'manual-fixture-token' ? 'one@example.test' : 'anonymous@guest.com', token } }) })
  const pending = f.manager.authenticate(config())
  await tick()
  assert.deepEqual(plain(f.manager.getAccountState('account-1')), { windowOpen: true, authenticated: false, exactOrigin: true, stage: 'waiting_login', verificationFailure: 'login_required' })
  assert.equal(f.intervals.size, 1)
  f.setToken(0, 'manual-fixture-token')
  await f.poll(); assert.equal(f.windows[0].loads.length, 2)
  assert.equal((await pending).credentials.token, 'manual-fixture-token')
  assert.equal(f.windows[0].destroyed, false)
  await f.manager.destroy()
})

test('expired token and transient errors keep window open until timeout without raw errors', async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture({ respond: () => ({ status, body: { error: 'private-fixture-token' } }) })
    const pending = f.manager.authenticate(config())
    await tick(); await f.timeout()
    assert.deepEqual(plain(await pending), { success: false, errorCode: 'timeout' })
    assert.equal(f.windows[0].destroyed, false)
    assert.equal(f.sessions[0].clears, 0)
    assert.equal(f.intervals.size, 0)
    await f.manager.destroy()
  }
})

test('different or missing known identity cannot replace an account', async () => {
  for (const body of [{ id: 'different-user', email: 'one@example.test' }, { id: 'user-1', email: 'different@example.test' }, { email: 'one@example.test' }, { id: 'user-1' }, {}]) {
    const f = fixture({ respond: token => ({ body: { ...body, token } }) })
    const pending = f.manager.authenticate(config()); await tick()
    const result = await pending
    assert.equal(result.success, false)
    assert.ok(['identity_mismatch', 'identity_unverified'].includes(result.errorCode))
    assert.equal(result.credentials, undefined); assert.equal(f.windows[0].destroyed, false)
    await f.manager.destroy()
  }
})

test('ignore response refresh tokens and retain only the current source token accepted by the server', async () => {
  const f = fixture({ respond: () => ({ body: { id: 'user-1', email: 'ONE@example.test', token: 'refreshed-fixture-token' } }) })
  const pending = f.manager.authenticate(config()); await tick()
  assert.equal(f.sessions[0].storage.get(ORIGIN).get('token'), 'fixture-token-1')
  assert.equal(f.requests.length, 1)
  assert.equal((await pending).credentials.token, 'fixture-token-1')
  const again = f.manager.authenticate(config())
  await tick(); assert.equal((await again).success, true)
  assert.equal(f.windows.length, 1); assert.equal(f.windows[0].loads.length, 2)
  await f.manager.destroy()
})

test('per-request rotating server tokens do not cause an endless refresh/reload loop', async () => {
  let generation = 0
  const f = fixture({ respond: () => ({ body: { id: 'user-1', email: 'one@example.test', token: `rotating-fixture-token-${++generation}` } }) })
  const pending = f.manager.authenticate(config()); await tick(); await f.poll()
  assert.equal((await pending).credentials.token, 'fixture-token-1')
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer fixture-token-1')
  assert.equal(f.sessions[0].storage.get(ORIGIN).get('token'), 'fixture-token-1')
  assert.equal(f.windows[0].loads.length, 2)
  assert.equal(f.manager.getAccountState('account-1').authenticated, true)
  await f.manager.destroy()
})

test('no stored credential still permits manual login without accepting token claims alone', async () => {
  const f = fixture()
  const pending = f.manager.authenticate({ ...config(), credentials: {} }); await tick()
  assert.equal(f.requests.length, 0)
  assert.equal(f.sessions[0].cookieWrites.length, 0)
  f.setToken(0, 'manual-fixture-token'); await f.poll(); await f.poll()
  assert.equal((await pending).success, true)
  assert.equal(f.requests.length, 1)
  await f.manager.destroy()
})

test('official page rotation of localStorage on every load is not overwritten or chased', async () => {
  const f = fixture({ afterLoad(window) {
    const storage = window.config.webPreferences.session.storage
    if (!storage.has(ORIGIN)) storage.set(ORIGIN, new Map())
    storage.get(ORIGIN).set('token', `page-owned-fixture-token-${window.loads.length}`)
  }, respond: token => ({ body: { id: 'user-1', email: 'one@example.test', token: `${token}-response-refresh` } }) })
  const pending = f.manager.authenticate(config()); await tick()
  assert.equal((await pending).credentials.token, 'page-owned-fixture-token-2')
  assert.equal(f.windows[0].loads.length, 2)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer page-owned-fixture-token-2')
  assert.equal(f.requests[0].init.credentials, 'omit', 'the explicit verified Bearer must not be overridden by cookies')
  assert.equal(f.sessions[0].storage.get(ORIGIN).get('token'), 'page-owned-fixture-token-2')
  assert.equal(f.manager.getAccountState('account-1').authenticated, true)
  await f.manager.destroy()
})

test('malformed, redirected and oversized auth bodies cannot verify a session', async () => {
  for (const reply of [{ text: '{not-json' }, { body: [], status: 200 }, { body: { id: 'user-1', email: 'one@example.test' }, url: 'https://idp.example.test/' }, { text: ' '.repeat(65537) }, { body: { id: 'user-1', email: 'one@example.test', role: 'guest' } }]) {
    const f = fixture({ respond: () => reply })
    const pending = f.manager.authenticate(config()); await tick(); await f.timeout()
    assert.equal((await pending).success, false)
    assert.equal(f.manager.getAccountState('account-1').authenticated, false)
    await f.manager.destroy()
  }
})

test('cleared accounts ignore in-flight auth replies and cannot resurrect a closed window', async () => {
  const waiting = deferred()
  const f = fixture({ respond: async token => { await waiting.promise; return { body: { id: 'user-1', email: 'one@example.test', token } } } })
  const pending = f.manager.authenticate(config()); await tick()
  const clearing = f.manager.clearAccount('account-1'); waiting.resolve(); await clearing
  assert.deepEqual(plain(await pending), { success: false, errorCode: 'cancelled' })
  assert.equal(f.windows[0].destroyed, true); assert.equal(f.sessions[0].clears, 1)
  assert.equal(f.manager.hasOpenBrowsers(), false)
})

test('reopening an explicitly changed encrypted credential reuses only its own account window', async () => {
  const f = fixture()
  const first = f.manager.authenticate(config()); await tick(); assert.equal((await first).success, true)
  const second = f.manager.authenticate(config('account-1', 'changed-fixture-token')); await tick()
  assert.equal((await second).credentials.token, 'changed-fixture-token')
  assert.equal(f.windows.length, 1); assert.equal(f.sessions.length, 1)
  assert.equal(f.windows[0].loads.length, 3)
  assert.equal(f.sessions[0].cookieWrites.at(-1).value, 'changed-fixture-token')
  await f.manager.destroy()
})

test('never seeds or checks credentials after initial cross-origin navigation', async () => {
  const f = fixture({ navigate: () => 'https://login.example.test/' })
  const pending = f.manager.authenticate(config()); await tick(); await f.poll()
  assert.equal(f.requests.length, 0); assert.equal(f.sessions[0].cookieWrites.length, 0)
  assert.equal(f.sessions[0].storage.size, 0)
  await f.manager.destroy(); assert.equal((await pending).errorCode, 'cancelled')
})

test('inner origin guard blocks an executeJavaScript navigation race', async () => {
  const f = fixture({ beforeExecute(window, script) { if (script.includes("localStorage.setItem")) window.url = 'https://idp.example.test/' } })
  const pending = f.manager.authenticate(config()); await tick()
  assert.equal(f.sessions[0].storage.size, 0); assert.equal(f.sessions[0].cookieWrites.length, 0)
  await f.manager.destroy(); assert.equal((await pending).success, false)
})

test('token changing during auth fetch is not saved as a stale success', async () => {
  const waiting = deferred()
  const f = fixture({ respond: async token => { await waiting.promise; return { body: { id: 'user-1', email: 'one@example.test', token } } } })
  const pending = f.manager.authenticate(config()); await tick()
  f.setToken(0, 'another-fixture-token'); waiting.resolve(); await tick()
  assert.equal(f.manager.getAccountState('account-1').authenticated, false)
  await f.manager.destroy(); assert.equal((await pending).success, false)
})

test('clear during initialization creates no orphan window and clears only owned session', async () => {
  const waiting = deferred(), f = fixture({ proxyWait: waiting.promise })
  const pending = f.manager.authenticate(config()); await tick()
  assert.equal(f.manager.hasOpenBrowsers(), true, 'shutdown must await owned session even before BrowserWindow exists')
  const clearing = f.manager.clearAccount('account-1'); waiting.resolve(); await clearing
  assert.equal((await pending).errorCode, 'cancelled')
  assert.equal(f.windows.length, 0); assert.equal(f.sessions[0].clears, 1)
  assert.equal(f.manager.hasOpenBrowsers(), false)
})

test('window close settles pending operation and exact-session cleanup; secure IdP popups are allowed', async () => {
  const f = fixture({ respond: () => ({ status: 401 }) })
  const pending = f.manager.authenticate({ ...config(), proxyMode: 'none' }); await tick()
  const window = f.windows[0], handler = window.webContents.openHandler
  assert.equal(f.events[0][2], 'none')
  assert.equal(handler({ url: 'file:///etc/passwd' }).action, 'deny')
  assert.equal(handler({ url: 'http://login.example.test/' }).action, 'deny')
  const popup = handler({ url: 'https://login.example.test/' })
  assert.equal(popup.action, 'allow')
  assert.equal(popup.overrideBrowserWindowOptions.webPreferences.session, f.sessions[0])
  assert.equal(popup.overrideBrowserWindowOptions.webPreferences.sandbox, true)
  window.destroy(); await tick()
  assert.equal((await pending).errorCode, 'cancelled'); assert.equal(f.sessions[0].clears, 1)
  assert.deepEqual(plain(f.manager.getAccountState('account-1')), { windowOpen: false, authenticated: false, exactOrigin: false })
})

test('malformed options and identities fail closed without opening a window', async () => {
  const f = fixture()
  for (const options of [null, { ...config(), accountId: '' }, { ...config(), proxyMode: 'bad' }, config('account-1', 'fixture-token', { email: 'not-email' })]) {
    assert.equal((await f.manager.authenticate(options)).success, false)
  }
  assert.equal(f.windows.length, 0)
})

test('diagnostic stages expose only bounded native codes and never error messages', async () => {
  const error = new Error('SecurityError: private-fixture-token https://secret.example.test/')
  const f = fixture({ beforeExecute() { throw error } })
  const pending = f.manager.authenticate(config()); await tick()
  assert.deepEqual(plain(await pending), { success: false, errorCode: 'browser_error' })
  assert.deepEqual(plain(f.manager.getAccountState('account-1')), { windowOpen: true, authenticated: false, exactOrigin: true, stage: 'seeding_storage', nativeErrorCode: 'SecurityError' })
  assert.ok(!JSON.stringify(f.manager.getAccountState('account-1')).includes('private'))
  await f.manager.destroy()
  const raw = fixture({ afterLoad() { throw Object.assign(new Error('private-error'), { code: 'private-token-value', name: 'CustomPrivateError' }) } })
  const failed = raw.manager.authenticate(config()); await tick()
  assert.equal((await failed).success, false)
  assert.equal(raw.manager.getAccountState('account-1').nativeErrorCode, undefined)
  await raw.manager.destroy()
})

test('ERR_ABORTED navigation handoff is tolerated but still requires a real identity response', async () => {
  const f = fixture({ afterLoad(window) { if (window.loads.length === 1) throw Object.assign(new Error('navigation replaced'), { errno: -3, code: 'ERR_ABORTED' }) } })
  const pending = f.manager.authenticate(config()); await tick()
  assert.equal((await pending).success, true)
  assert.equal(f.requests.length, 1)
  assert.equal(f.manager.getAccountState('account-1').nativeErrorCode, undefined)
  await f.manager.destroy()
})

test('optional token-cookie rejection cannot prevent a verified localStorage/Bearer session', async () => {
  const f = fixture({ cookieError: new Error('private-fixture-token: exceeds cookie size policy') })
  const pending = f.manager.authenticate(config()); await tick()
  assert.equal((await pending).success, true)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].init.headers.Authorization, 'Bearer fixture-token-1')
  assert.equal(f.sessions[0].storage.get(ORIGIN).get('token'), 'fixture-token-1')
  assert.equal(f.sessions[0].cookieWrites.length, 0)
  assert.equal(f.windows[0].loads.length, 2)
  assert.equal(f.manager.getAccountState('account-1').authenticated, true)
  await f.manager.destroy()
})

test('optional cookie failure never turns rejected or guest authentication into success', async () => {
  for (const reply of [{ status: 401 }, { body: { id: 'guest-1', email: 'anonymous@guest.com' } }]) {
    const f = fixture({ cookieError: new Error('private-cookie-error'), respond: () => reply })
    const pending = f.manager.authenticate(config()); await tick()
    assert.equal(f.manager.getAccountState('account-1').nativeErrorCode, 'cookie_unavailable')
    assert.equal(f.manager.getAccountState('account-1').authenticated, false)
    assert.equal(f.windows[0].destroyed, false)
    await f.timeout()
    assert.deepEqual(plain(await pending), { success: false, errorCode: 'timeout' })
    await f.manager.destroy()
  }
})

test('explicit anonymous flags and normalized guest role reject otherwise valid-looking identities', async () => {
  for (const marker of [{ is_guest: true }, { isGuest: true }, { is_anonymous: true }, { isAnonymous: true }, { guest: true }, { role: ' Guest ' }]) {
    const f = fixture({ respond: () => ({ body: { id: 'user-1', email: 'one@example.test', ...marker } }) })
    const pending = f.manager.authenticate(config()); await tick()
    assert.equal(f.manager.getAccountState('account-1').authenticated, false)
    assert.equal(f.manager.getAccountState('account-1').verificationFailure, 'login_required')
    await f.timeout(); assert.equal((await pending).success, false)
    await f.manager.destroy()
  }
})

test('diagnostics never claim authentication while an owned window is on another origin', async () => {
  const f = fixture()
  const pending = f.manager.authenticate(config()); await tick(); assert.equal((await pending).success, true)
  f.windows[0].url = 'https://idp.example.test/'
  assert.equal(f.manager.getAccountState('account-1').exactOrigin, false)
  assert.equal(f.manager.getAccountState('account-1').authenticated, false)
  await f.manager.destroy()
})
