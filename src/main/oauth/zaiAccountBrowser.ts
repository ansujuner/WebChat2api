/** Account-owned, in-memory official-site browser. No fingerprint or security overrides. */
import { BrowserWindow, session, type Session } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { accountEmail, accountUserId } from '../../shared/accountIdentity'
import { getProviderProxyConfig, normalizeNetworkProxyConfig, type ProviderProxyConfig } from '../network/proxy'
import { OwnedSessionProxy } from '../network/sessionProxy'

const ORIGIN = 'https://chat.z.ai'
const AUTH_PATH = '/api/v1/auths/'
const LOGIN_TIMEOUT = 5 * 60 * 1000
const POLL_INTERVAL = 2000

export type ZaiAccountBrowserError = 'cancelled' | 'timeout' | 'identity_mismatch' | 'identity_unverified'
  | 'login_required' | 'network_error' | 'browser_error' | 'account_changed' | 'busy'
export interface ZaiAccountBrowserOptions {
  accountId: string
  credentials: Record<string, string>
  expectedIdentity: { userId?: string; email?: string }
  proxyMode?: 'system' | 'none'
  proxyConfig?: ProviderProxyConfig
  /** API requests verify silently and never wait for an interactive login. */
  interactive?: boolean
  signal?: AbortSignal
  /** Main-process snapshot guard, never accepted from website or renderer JSON. */
  isAccountCurrent?: () => boolean
}
export interface ZaiAccountBrowserResult {
  success: boolean
  credentials?: { token: string }
  accountInfo?: { userId?: string; email?: string }
  errorCode?: ZaiAccountBrowserError
}
interface Operation {
  promise: Promise<ZaiAccountBrowserResult>
  resolve: (result: ZaiAccountBrowserResult) => void
  expectedIdentity: { userId?: string; email?: string }
  timer?: ReturnType<typeof setTimeout>
  poll?: ReturnType<typeof setInterval>
  checking: boolean
  interactive: boolean
  removeAbort?: () => void
}
interface AccountBrowser {
  accountId: string
  session: Session
  network: OwnedSessionProxy
  proxyConfig?: ProviderProxyConfig
  window?: BrowserWindow
  chatWindow?: BrowserWindow
  canFocus: boolean
  children: Set<BrowserWindow>
  ready: Promise<void>
  operation?: Operation
  disposed: boolean
  initializing: boolean
  authenticated: boolean
  stage: 'opening' | 'loading' | 'seeding_storage' | 'seeding_cookie' | 'reloading' | 'checking' | 'waiting_login' | 'ready'
  nativeErrorCode?: string
  verificationFailure?: 'metadata_invalid' | 'source_changed' | 'identity_mismatch' | 'login_required' | 'network_error' | 'origin_changed' | 'browser_error'
  /** Last imported saved token; webpage refreshes must not cause re-import of an older saved token. */
  importedFingerprint?: string
}

function tokenValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length >= 8 && value.length <= 16384 && !/[\s\x00-\x1f\x7f]/.test(value)
    ? value : undefined
}
function fingerprint(value: string): string { return createHash('sha256').update(value).digest('hex') }
function nativeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = error as { code?: unknown; errno?: unknown; name?: unknown; message?: unknown }
  if (value.errno === -3) return 'ERR_ABORTED'
  if (typeof value.code === 'string' && /^ERR_[A-Z_]{1,48}$/.test(value.code)) return value.code
  if (typeof value.name === 'string' && ['SecurityError', 'QuotaExceededError', 'AbortError', 'NotAllowedError', 'InvalidStateError', 'NetworkError', 'TimeoutError', 'TypeError', 'SyntaxError'].includes(value.name)) return value.name
  // Electron can wrap DOM exceptions in Error. Extract only these fixed labels, never message prose.
  if (typeof value.message === 'string') {
    return /\b(SecurityError|QuotaExceededError|ERR_ABORTED|ERR_BLOCKED_BY_RESPONSE)\b/.exec(value.message)?.[1]
  }
  return undefined
}
function sameOrigin(url: string): boolean {
  try { const parsed = new URL(url); return parsed.origin === ORIGIN && !parsed.username && !parsed.password } catch { return false }
}
function loginNavigation(url: string): boolean {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && !parsed.username && !parsed.password } catch { return false }
}

/** Return only selected fields, never raw response prose, request headers, or unrelated storage. */
function verificationScript(): string {
  return `(async () => {
    const origin = ${JSON.stringify(ORIGIN)};
    const authPath = ${JSON.stringify(AUTH_PATH)};
    if (location.origin !== origin) return { state: 'login_required' };
    const token = localStorage.getItem('token');
    if (typeof token !== 'string' || token.length < 8 || token.length > 16384 || /[\\s\\x00-\\x1f\\x7f]/.test(token)) return { state: 'login_required' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(authPath, {
        method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal
      });
      if (location.origin !== origin) return { state: 'origin_changed' };
      if (localStorage.getItem('token') !== token) return { state: 'source_changed' };
      if (response.status === 401 || response.status === 403) return { state: 'login_required' };
      if (!response.ok) return { state: 'network_error' };
      const url = new URL(response.url);
      if (url.origin !== origin || url.pathname !== authPath) return { state: 'identity_unverified' };
      const text = await response.text();
      if (text.length > 65536) return { state: 'identity_unverified' };
      const body = JSON.parse(text);
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { state: 'identity_unverified' };
      if (location.origin !== origin) return { state: 'origin_changed' };
      if (localStorage.getItem('token') !== token) return { state: 'source_changed' };
      if ((typeof body.email === 'string' && /@guest\\.com$/i.test(body.email.trim()))
        || (typeof body.role === 'string' && body.role.trim().toLowerCase() === 'guest')
        || ['is_guest', 'isGuest', 'is_anonymous', 'isAnonymous', 'guest'].some(key => body[key] === true)) return { state: 'login_required' };
      return { state: 'verified', sourceToken: token, userId: body.id, email: body.email };
    } catch { return { state: 'network_error' }; }
    finally { clearTimeout(timer); }
  })()`
}

export class ZaiAccountBrowserManager {
  private accounts = new Map<string, AccountBrowser>()
  private chatLocks = new Set<string>()

  authenticate(options: ZaiAccountBrowserOptions): Promise<ZaiAccountBrowserResult> {
    if (!options || typeof options.accountId !== 'string' || !options.accountId.trim() || options.accountId.length > 256
      || !options.credentials || typeof options.credentials !== 'object'
      || (options.interactive !== undefined && typeof options.interactive !== 'boolean')
      || (options.isAccountCurrent !== undefined && typeof options.isAccountCurrent !== 'function')
      || (options.proxyMode !== undefined && !['system', 'none'].includes(options.proxyMode))) {
      return Promise.resolve({ success: false, errorCode: 'browser_error' })
    }
    if (options.signal?.aborted) return Promise.resolve({ success: false, errorCode: 'cancelled' })
    let proxyConfig: ProviderProxyConfig
    try { proxyConfig = normalizeNetworkProxyConfig(options.proxyConfig ?? options.proxyMode ?? getProviderProxyConfig('zai')) }
    catch { return Promise.resolve({ success: false, errorCode: 'browser_error' }) }
    if (this.chatLocks.has(options.accountId) && options.interactive !== false) return Promise.resolve({ success: false, errorCode: 'busy' })
    const expected = options.expectedIdentity ?? {}
    const userId = accountUserId(expected.userId)
    const email = accountEmail(expected.email)
    if ((expected.userId !== undefined && !userId) || (expected.email !== undefined && !email)) {
      return Promise.resolve({ success: false, errorCode: 'identity_unverified' })
    }
    let entry = this.accounts.get(options.accountId)
    if (entry?.operation) {
      if (options.interactive === false) return Promise.resolve({ success: false, errorCode: 'busy' })
      entry.canFocus = true; this.focus(entry); return entry.operation.promise
    }
    if (!entry) {
      try {
        const ownedSession = session.fromPartition(`zai-account-${randomUUID()}`)
        entry = {
          accountId: options.accountId, session: ownedSession, network: new OwnedSessionProxy(ownedSession),
          children: new Set(), ready: Promise.resolve(), disposed: false, initializing: true, authenticated: false, stage: 'opening', canFocus: options.interactive !== false,
        }
        this.accounts.set(options.accountId, entry)
      } catch { return Promise.resolve({ success: false, errorCode: 'browser_error' }) }
    }
    const current = entry
    let resolve!: Operation['resolve']
    const promise = new Promise<ZaiAccountBrowserResult>(done => { resolve = done })
    const operation: Operation = { promise, resolve, expectedIdentity: { userId, email }, checking: false, interactive: options.interactive !== false }
    current.canFocus = operation.interactive
    current.operation = operation
    if (options.signal) {
      const abort = () => this.finish(current, operation, { success: false, errorCode: 'cancelled' })
      options.signal.addEventListener('abort', abort, { once: true })
      operation.removeAbort = () => options.signal!.removeEventListener('abort', abort)
    }
    current.initializing = true
    current.authenticated = false
    current.nativeErrorCode = undefined
    current.verificationFailure = undefined
    operation.timer = setTimeout(() => this.finish(current, operation, { success: false, errorCode: 'timeout' }), operation.interactive ? LOGIN_TIMEOUT : 30000)
    this.focus(current)
    const savedToken = tokenValue(options.credentials.token)
    const work = current.ready.then(async () => {
      if (!this.current(current, operation)) return
      if (!current.window) await this.createWindow(current, proxyConfig, operation)
      else if (JSON.stringify(current.proxyConfig) !== JSON.stringify(proxyConfig)) {
        await current.network.apply(proxyConfig)
        current.proxyConfig = proxyConfig
      }
      if (!this.current(current, operation)) return
      // Reuse a live account browser, but import an explicitly changed encrypted account token.
      if (savedToken && fingerprint(savedToken) !== current.importedFingerprint) {
        if (await this.synchronize(current, operation, savedToken)) current.importedFingerprint = fingerprint(savedToken)
      }
      if (!this.current(current, operation)) return
      operation.poll = setInterval(() => { void this.check(current, operation) }, POLL_INTERVAL)
      await this.check(current, operation)
    }).catch(error => {
      current.nativeErrorCode = nativeErrorCode(error)
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'busy')) current.proxyConfig = undefined
      if (this.current(current, operation)) this.finish(current, operation, { success: false,
        errorCode: error && typeof error === 'object' && 'code' in error && error.code === 'busy' ? 'busy' : 'browser_error' })
    }).finally(() => { if (current.ready === work) current.initializing = false })
    current.ready = work
    return promise
  }

  /** One dedicated API page per account, sharing only that account's verified website session.
   * The callback owns its complete response lifetime; no queued or fallback submission is made.
   */
  async withChatWindow<T>(options: ZaiAccountBrowserOptions, task: (window: BrowserWindow) => Promise<T>): Promise<T> {
    const fail = (code: string): never => { throw Object.assign(new Error(`Z.ai website ${code}`), { code }) }
    if (!options || typeof options.accountId !== 'string' || typeof task !== 'function') return fail('invalid_request')
    const accountId = options.accountId
    if (this.chatLocks.has(accountId) || this.accounts.get(accountId)?.operation) return fail('account_busy')
    this.chatLocks = new Set([...this.chatLocks, accountId])
    try {
      if (options.signal?.aborted) return fail('cancelled')
      if (options.isAccountCurrent?.() === false) return fail('account_changed')
      const auth = await this.authenticate({ ...options, interactive: false })
      if (!auth.success) return fail(auth.errorCode === 'busy' ? 'account_busy' : auth.errorCode ?? 'browser_error')
      if (options.signal?.aborted) return fail('cancelled')
      if (options.isAccountCurrent?.() === false) return fail('account_changed')
      const entry = this.accounts.get(accountId)
      if (!entry || entry.disposed || !entry.authenticated) return fail('account_changed')
      if (!entry.chatWindow || entry.chatWindow.isDestroyed()) {
        const window = new BrowserWindow({
          width: 1060, height: 780, minWidth: 640, minHeight: 480, show: false, title: 'Z.ai · API', autoHideMenuBar: true,
          webPreferences: { session: entry.session, nodeIntegration: false, contextIsolation: true,
            sandbox: true, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false },
        })
        entry.chatWindow = window
        // API chat pages never open another origin/window. Login belongs to the separate login window.
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        const guard = (event: { preventDefault(): void }, url: string): void => { if (!sameOrigin(url)) event.preventDefault() }
        window.webContents.on('will-navigate', guard)
        window.webContents.on('will-redirect', guard)
        window.once('closed', () => { if (entry.chatWindow === window) entry.chatWindow = undefined })
      }
      const result = await task(entry.chatWindow)
      if (options.signal?.aborted) return fail('cancelled')
      if (options.isAccountCurrent?.() === false) return fail('account_changed')
      return result
    } finally {
      this.chatLocks = new Set([...this.chatLocks].filter(id => id !== accountId))
    }
  }

  hasOpenBrowsers(): boolean {
    // App shutdown must also await a session still in setProxy, before BrowserWindow exists.
    return this.chatLocks.size > 0 || [...this.accounts.values()].some(entry => !entry.disposed && (entry.initializing || !!entry.operation
      || (!!entry.window && !entry.window.isDestroyed()) || (!!entry.chatWindow && !entry.chatWindow.isDestroyed())))
  }

  getAccountState(accountId: string): { windowOpen: boolean; authenticated: boolean; exactOrigin: boolean; stage?: string; nativeErrorCode?: string; verificationFailure?: string } {
    const entry = this.accounts.get(accountId)
    const windowOpen = !!entry && !entry.disposed && !!entry.window && !entry.window.isDestroyed()
    const exactOrigin = windowOpen && !entry!.window!.webContents.isDestroyed() && sameOrigin(entry!.window!.webContents.getURL())
    return { windowOpen, authenticated: exactOrigin && !!entry?.authenticated, exactOrigin,
      ...(entry ? { stage: entry.stage } : {}), ...(entry?.nativeErrorCode ? { nativeErrorCode: entry.nativeErrorCode } : {}),
      ...(entry?.verificationFailure ? { verificationFailure: entry.verificationFailure } : {}) }
  }

  async clearAccount(accountId: string): Promise<void> {
    const entry = this.accounts.get(accountId)
    if (!entry) return
    this.accounts.delete(accountId)
    entry.disposed = true
    entry.network.dispose()
    entry.authenticated = false
    if (entry.operation) this.finish(entry, entry.operation, { success: false, errorCode: 'cancelled' })
    for (const child of entry.children) { if (!child.isDestroyed()) child.destroy() }
    if (entry.chatWindow && !entry.chatWindow.isDestroyed()) entry.chatWindow.destroy()
    if (entry.window && !entry.window.isDestroyed()) entry.window.destroy()
    // A cancelled initialization can still be in setProxy; no subsequent window/seed is allowed.
    try { await entry.ready } catch { /* Cleanup still proceeds after initialization failure. */ }
    await Promise.allSettled([entry.session.clearStorageData(), entry.session.closeAllConnections()])
  }

  async destroy(): Promise<void> {
    await Promise.all([...this.accounts.keys()].map(accountId => this.clearAccount(accountId)))
  }

  private current(entry: AccountBrowser, operation: Operation): boolean {
    return !entry.disposed && this.accounts.get(entry.accountId) === entry && entry.operation === operation
  }

  private focus(entry: AccountBrowser): void {
    if (!entry.canFocus) return
    const window = entry.window
    if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus() }
  }

  private async createWindow(entry: AccountBrowser, config: ProviderProxyConfig, operation: Operation): Promise<void> {
    if (JSON.stringify(entry.proxyConfig) !== JSON.stringify(config)) {
      await entry.network.apply(config)
      entry.proxyConfig = config
    }
    if (!this.current(entry, operation)) return
    const window = new BrowserWindow({
      width: 1060, height: 780, minWidth: 640, minHeight: 480, show: false, title: 'Z.ai', autoHideMenuBar: true,
      webPreferences: { session: entry.session, nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, allowRunningInsecureContent: false },
    })
    entry.window = window
    this.attachWindow(entry, window)
    window.once('ready-to-show', () => this.focus(entry))
    window.once('closed', () => {
      if (entry.disposed) return
      if (entry.chatWindow && !entry.chatWindow.isDestroyed() && !entry.operation) entry.window = undefined
      else void this.clearAccount(entry.accountId)
    })
    entry.stage = 'loading'
    await this.loadOfficial(entry)
    this.focus(entry)
  }

  private async loadOfficial(entry: AccountBrowser): Promise<void> {
    try { await entry.window!.loadURL(`${ORIGIN}/`) } catch (error) {
      entry.nativeErrorCode = nativeErrorCode(error)
      // Chromium aborts a load when normal SPA/OAuth navigation supersedes it. That is not identity proof.
      if (entry.nativeErrorCode !== 'ERR_ABORTED') throw error
    }
  }

  private attachWindow(entry: AccountBrowser, window: BrowserWindow): void {
    const contents = window.webContents
    contents.setWindowOpenHandler(({ url }) => {
      if (entry.disposed || !loginNavigation(url) || entry.children.size >= 8) return { action: 'deny' }
      return { action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: {
        autoHideMenuBar: true, width: 680, height: 780,
        webPreferences: { session: entry.session, nodeIntegration: false, contextIsolation: true,
          sandbox: true, webSecurity: true, allowRunningInsecureContent: false },
      } }
    })
    contents.on('did-create-window', child => {
      if (entry.disposed) { child.destroy(); return }
      entry.children = new Set([...entry.children, child])
      this.attachWindow(entry, child)
      child.once('closed', () => { entry.children = new Set([...entry.children].filter(item => item !== child)) })
    })
    const guard = (event: { preventDefault(): void }, url: string): void => { if (!loginNavigation(url)) event.preventDefault() }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
    contents.on('render-process-gone', () => {
      entry.authenticated = false
      if (entry.operation) this.finish(entry, entry.operation, { success: false, errorCode: 'browser_error' })
    })
  }

  private async synchronize(entry: AccountBrowser, operation: Operation, token: string, sourceToken?: string): Promise<boolean> {
    const contents = entry.window?.webContents
    if (!this.current(entry, operation) || !contents || contents.isDestroyed() || !sameOrigin(contents.getURL())) return false
    // Both checks are necessary: navigation can race executeJavaScript dispatch.
    entry.stage = 'seeding_storage'
    const seeded = await contents.executeJavaScript(`(() => {
      if (location.origin !== ${JSON.stringify(ORIGIN)}) return false;
      ${sourceToken ? `if (localStorage.getItem('token') !== ${JSON.stringify(sourceToken)}) return false;` : ''}
      localStorage.setItem('token', ${JSON.stringify(token)}); return true;
    })()`)
    if (!this.current(entry, operation) || seeded !== true || contents.isDestroyed() || !sameOrigin(contents.getURL())) return false
    // Omit domain: the cookie is host-only, never shared with an IdP or another account session.
    entry.stage = 'seeding_cookie'
    try {
      await entry.session.cookies.set({ url: `${ORIGIN}/`, name: 'token', value: token, path: '/', secure: true, httpOnly: false, sameSite: 'lax' })
    } catch {
      // The official app authenticates using localStorage + Bearer. Chromium may reject a long
      // token cookie; that optional convenience must not prevent the real identity verification.
      entry.nativeErrorCode = 'cookie_unavailable'
    }
    if (!this.current(entry, operation) || contents.isDestroyed() || !sameOrigin(contents.getURL())) return false
    entry.stage = 'reloading'
    await this.loadOfficial(entry)
    if (!this.current(entry, operation) || contents.isDestroyed() || !sameOrigin(contents.getURL())) return false
    return true
  }

  private async check(entry: AccountBrowser, operation: Operation): Promise<void> {
    const contents = entry.window?.webContents
    if (!this.current(entry, operation) || operation.checking || !contents || contents.isDestroyed() || !sameOrigin(contents.getURL())) return
    operation.checking = true
    try {
      entry.stage = 'checking'
      const result: unknown = await contents.executeJavaScript(verificationScript())
      if (!this.current(entry, operation) || contents.isDestroyed() || !sameOrigin(contents.getURL())) return
      if (!result || typeof result !== 'object') { entry.verificationFailure = 'metadata_invalid'; return }
      const data = result as Record<string, unknown>
      if (data.state !== 'verified') {
        entry.stage = 'waiting_login'
        entry.verificationFailure = ['source_changed', 'login_required', 'network_error', 'origin_changed'].includes(String(data.state))
          ? data.state as AccountBrowser['verificationFailure'] : 'metadata_invalid'
        if (!operation.interactive && data.state !== 'source_changed') {
          this.finish(entry, operation, { success: false, errorCode: data.state === 'login_required' ? 'login_required'
            : data.state === 'network_error' ? 'network_error' : 'identity_unverified' })
        }
        return // Guest/expired sessions remain open for normal manual login.
      }
      const userId = accountUserId(data.userId)
      const email = accountEmail(data.email)
      const sourceToken = tokenValue(data.sourceToken)
      if ((!userId && !email) || !sourceToken || (email && /@guest\.com$/i.test(email))) {
        entry.verificationFailure = 'metadata_invalid'
        this.finish(entry, operation, { success: false, errorCode: 'identity_unverified' }); return
      }
      const expected = operation.expectedIdentity
      if ((expected.userId && userId !== expected.userId) || (expected.email && email?.toLowerCase() !== expected.email.toLowerCase())) {
        entry.verificationFailure = 'identity_mismatch'
        this.finish(entry, operation, { success: false, errorCode: 'identity_mismatch' }); return
      }
      // The official page owns refresh/rotation. The request's Bearer token has just been
      // accepted by the server for the matching real identity; do not chase response JWTs.
      // Guard a user switching account while the last fetch was completing, without collecting other storage.
      const unchanged = await contents.executeJavaScript(`location.origin === ${JSON.stringify(ORIGIN)} && localStorage.getItem('token') === ${JSON.stringify(sourceToken)}`)
      if (!this.current(entry, operation)) return
      if (unchanged !== true) { entry.verificationFailure = 'source_changed'; return }
      this.finish(entry, operation, { success: true, credentials: { token: sourceToken }, accountInfo: { ...(userId ? { userId } : {}), ...(email ? { email } : {}) } })
    } catch (error) {
      entry.nativeErrorCode = nativeErrorCode(error)
      entry.verificationFailure = 'browser_error'
      if (!operation.interactive) this.finish(entry, operation, { success: false, errorCode: 'browser_error' })
      // Navigation, offline and expired sessions can recover in the same window. Never expose remote error text.
    } finally { operation.checking = false }
  }

  private finish(entry: AccountBrowser, operation: Operation, result: ZaiAccountBrowserResult): void {
    if (entry.operation !== operation) return
    if (operation.timer) clearTimeout(operation.timer)
    if (operation.poll) clearInterval(operation.poll)
    operation.removeAbort?.()
    entry.operation = undefined
    entry.authenticated = result.success
    if (result.success) { entry.stage = 'ready'; entry.nativeErrorCode = undefined; entry.verificationFailure = undefined }
    // Deliberately retain the owned official-site window and session after success or timeout.
    operation.resolve(result)
  }
}

export const zaiAccountBrowserManager = new ZaiAccountBrowserManager()
