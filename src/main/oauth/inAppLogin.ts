/** Isolated normal browser login: no spoofing, fingerprint injection, or security bypasses. */
import { BrowserWindow, session, type Session, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { ProviderType } from './types'
import { getTokenExtractionConfig, type TokenExtractionConfig } from './tokenExtractionConfig'
import { isBrowserLoginUrl, isCredentialCandidate, isProviderHost, isProviderUrl, loginLoadError, storedCredential } from './loginPolicy'
import { applyProxyToSession } from '../network/proxy'

export interface InAppLoginResult { success: boolean; credentials?: Record<string, string>; error?: string }
export interface TokenFoundEvent { key: string; value: string; allCookies?: Record<string, string> }
export interface InAppLoginOptions {
  providerId: string
  providerType: ProviderType
  timeout?: number
  proxyMode?: 'system' | 'none'
}
const DEFAULT_TIMEOUT = 300000
const MIN_LOGIN_TIME = 5000

export class InAppLoginManager extends EventEmitter {
  private loginWindow: BrowserWindow | null = null
  private loginSession: Session | null = null
  private popupWindows = new Set<BrowserWindow>()
  private config: TokenExtractionConfig | null = null
  private active = false
  private timeoutId: NodeJS.Timeout | null = null
  private pollId: NodeJS.Timeout | null = null
  private resolvePromise: ((result: InAppLoginResult) => void) | null = null
  private loginStartTime = 0
  private checking = false
  private generation = 0
  private networkTokens: Record<string, string> = {}
  private cookieListener: ((...args: any[]) => void) | null = null

  async startLogin(options: InAppLoginOptions): Promise<InAppLoginResult> {
    if (this.active) return { success: false, error: 'A login process is already in progress' }
    const config = getTokenExtractionConfig(options.providerType)
    if (!config || !isBrowserLoginUrl(config.loginUrl)) return { success: false, error: 'This provider has no supported login page.' }
    if (options.proxyMode !== undefined && !['system', 'none'].includes(options.proxyMode)) return { success: false, error: 'Invalid login proxy mode.' }
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 1000 || options.timeout > 30 * 60 * 1000)) {
      return { success: false, error: 'Login timeout must be between 1 second and 30 minutes.' }
    }
    this.active = true
    this.generation += 1
    const generation = this.generation
    this.config = config
    this.loginStartTime = Date.now()
    const result = new Promise<InAppLoginResult>(resolve => { this.resolvePromise = resolve })
    this.timeoutId = setTimeout(() => this.complete({ success: false, error: 'Login timeout. Please retry when ready to sign in.' }), options.timeout ?? DEFAULT_TIMEOUT)
    this.emit('status', { status: 'pending', message: 'Opening isolated login window...' })
    void this.createLoginWindow(options, generation).catch(error => {
      if (error?.code === 'ERR_ABORTED' || error?.errno === -3) return
      if (this.active && this.generation === generation) this.complete({ success: false, error: loginLoadError(error?.code) })
    })
    return result
  }

  private async createLoginWindow(options: InAppLoginOptions, generation: number): Promise<void> {
    // No persist: prefix: attempts never reuse another account's cookies or leave disk profiles.
    const loginSession = session.fromPartition(`oauth-${randomUUID()}`)
    this.loginSession = loginSession
    // Both system and direct modes are fully configured before any navigation.
    await applyProxyToSession(loginSession, options.proxyMode ?? 'system')
    if (!this.active || generation !== this.generation) return
    const config = this.config!
    // Keep the actual runtime UA and client hints; do not claim another OS or Chromium version.
    const window = new BrowserWindow({
      width: 1060, height: 780, minWidth: 640, minHeight: 480, show: false,
      title: config.windowTitle || 'Login', autoHideMenuBar: true,
      webPreferences: { session: loginSession, nodeIntegration: false, contextIsolation: true,
        sandbox: true, webSecurity: true, allowRunningInsecureContent: false },
    })
    this.loginWindow = window
    this.attachWindow(window)
    this.setupTokenInterception(loginSession, generation)
    window.once('ready-to-show', () => {
      if (!window.isDestroyed()) window.show()
      if (this.active) this.emit('status', { status: 'pending', message: 'Please sign in normally in the login window.' })
    })
    window.once('closed', () => {
      if (this.active && generation === this.generation) this.complete({ success: false, error: 'Login window was closed.' })
    })
    this.pollId = setInterval(() => { void this.checkForTokens() }, 1500)
    await window.loadURL(config.loginUrl)
  }

  private attachWindow(window: BrowserWindow): void {
    const contents = window.webContents
    contents.setWindowOpenHandler(({ url }) => {
      if (!this.active || !isBrowserLoginUrl(url) || this.popupWindows.size >= 8) return { action: 'deny' }
      return { action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: {
        autoHideMenuBar: true, width: 680, height: 780,
        webPreferences: { session: this.loginSession!, nodeIntegration: false, contextIsolation: true,
          sandbox: true, webSecurity: true, allowRunningInsecureContent: false },
      } }
    })
    contents.on('did-create-window', child => {
      this.popupWindows = new Set([...this.popupWindows, child])
      this.attachWindow(child)
      child.once('closed', () => {
        this.popupWindows = new Set([...this.popupWindows].filter(candidate => candidate !== child))
        void this.checkForTokens()
      })
    })
    const guardNavigation = (event: { preventDefault(): void }, url: string): void => {
      if (!isBrowserLoginUrl(url)) {
        event.preventDefault()
        this.emit('status', { status: 'pending', message: 'This login step requires an external application. Use the provider’s normal browser login if the embedded flow is not supported.' })
      }
    }
    contents.on('will-navigate', guardNavigation)
    contents.on('will-redirect', guardNavigation)
    contents.on('did-finish-load', () => { void this.checkForTokens() })
    contents.on('did-navigate-in-page', () => { void this.checkForTokens() })
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      // ERR_ABORTED is a normal navigation handoff, not a failed login.
      if (this.active && isMainFrame && code !== -3) this.emit('status', { status: 'pending', message: loginLoadError(code) })
    })
    contents.on('render-process-gone', () => {
      if (this.active) this.complete({ success: false, error: 'The login browser stopped unexpectedly. Restart the app and retry.' })
    })
  }

  private setupTokenInterception(loginSession: Session, generation: number): void {
    // Observe only provider requests and never modify headers. Exclude IdP credentials.
    loginSession.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: details.requestHeaders })
      if (!this.active || generation !== this.generation || !this.config) return
      if (!isProviderUrl(details.url, this.config.targetDomains)) return
      const header = details.requestHeaders.Authorization ?? details.requestHeaders.authorization
      if (typeof header !== 'string') return
      for (const source of this.config.tokenSources) {
        if (source.type !== 'networkHeader') continue
        const match = source.extractPattern ? header.match(new RegExp(source.extractPattern)) : /^Bearer\s+(.+)$/i.exec(header)
        const value = match?.[1]
        if (isCredentialCandidate(value)) {
          this.networkTokens = { ...this.networkTokens, [source.key]: value }
          if (this.hasMinTimePassed()) this.emit('tokenFound', { key: source.key, value })
        }
      }
    })
    this.cookieListener = (_event, cookie, _cause, removed) => {
      if (this.active && !removed && this.config && isProviderHost(cookie.domain, this.config.targetDomains)) void this.checkForTokens()
    }
    loginSession.cookies.on('changed', this.cookieListener)
  }

  private hasMinTimePassed(): boolean { return Date.now() - this.loginStartTime >= MIN_LOGIN_TIME }

  private async checkStorage(contents: WebContents, config: TokenExtractionConfig, generation: number): Promise<void> {
    if (contents.isDestroyed() || !isProviderUrl(contents.getURL(), config.targetDomains)) return
    for (const source of config.tokenSources.filter(source => source.type === 'localStorage')) {
      if (!this.active || generation !== this.generation || contents.isDestroyed()) return
      // Read a configured storage key only; never patch navigator or other browser properties.
      const value: unknown = await contents.executeJavaScript(`localStorage.getItem(${JSON.stringify(source.key)})`)
      if (!this.active || generation !== this.generation) return
      if (source.key === 'user_detail_agent') {
        if (typeof value !== 'string') continue
        let parsed: unknown
        try { parsed = JSON.parse(value) } catch { continue }
        if (!parsed || typeof parsed !== 'object') continue
        const data = parsed as Record<string, unknown>
        const id = data.realUserID ?? data.id
        if (typeof id === 'string' || typeof id === 'number') this.emit('tokenFound', { key: 'realUserID', value: String(id) })
        continue
      }
      const token = storedCredential(value)
      if (isCredentialCandidate(token)) this.emit('tokenFound', { key: source.key === '_token' ? 'token' : source.key, value: token })
    }
  }

  private async checkForTokens(): Promise<void> {
    if (!this.active || this.checking || !this.config || !this.loginSession || !this.hasMinTimePassed()) return
    this.checking = true
    const config = this.config
    const loginSession = this.loginSession
    const generation = this.generation
    try {
      // Do not lose a token observed before the minimum page-settle time, and
      // permit account validation retries without waiting for another API call.
      for (const [key, value] of Object.entries(this.networkTokens)) {
        if (!this.active || generation !== this.generation) return
        this.emit('tokenFound', { key, value })
      }
      const windows = [this.loginWindow, ...this.popupWindows].filter((value): value is BrowserWindow => !!value && !value.isDestroyed())
      for (const window of windows) await this.checkStorage(window.webContents, config, generation)
      if (!this.active || generation !== this.generation) return
      // Electron cookies.get includes HttpOnly cookies. No raw Set-Cookie interception.
      const cookies = (await loginSession.cookies.get({})).filter(cookie => isProviderHost(cookie.domain, config.targetDomains))
      const cookieMap = Object.fromEntries(cookies.filter(cookie => cookie.value).map(cookie => [cookie.name, cookie.value]))
      for (const source of config.tokenSources.filter(source => source.type === 'cookie')) {
        if (!this.active || generation !== this.generation) return
        const value = cookieMap[source.key]
        const identifier = source.key === 'userId' && typeof value === 'string' && !!value && value.length < 256
        if (identifier || isCredentialCandidate(value)) this.emit('tokenFound', { key: source.key, value, allCookies: { ...cookieMap } })
      }
    } catch {
      // Contexts disappear during navigation. Never log errors containing URLs or credentials.
      if (this.active && generation === this.generation) this.emit('status', { status: 'pending', message: 'Waiting for the provider login page to finish loading...' })
    } finally {
      if (generation === this.generation) this.checking = false
    }
  }

  completeWithSuccess(credentials: Record<string, string>): void { this.complete({ success: true, credentials: { ...credentials } }) }
  private complete(result: InAppLoginResult): void {
    if (!this.active) return
    this.active = false
    const resolve = this.resolvePromise
    this.resolvePromise = null
    this.cleanup()
    resolve?.(result)
    this.emit('complete', result)
  }
  private cleanup(): void {
    if (this.timeoutId) clearTimeout(this.timeoutId)
    if (this.pollId) clearInterval(this.pollId)
    this.timeoutId = null
    this.pollId = null
    const loginSession = this.loginSession
    if (loginSession) {
      loginSession.webRequest.onBeforeSendHeaders(null)
      if (this.cookieListener) loginSession.cookies.off('changed', this.cookieListener)
      void loginSession.clearStorageData().catch(() => { this.emit('cleanupWarning', 'The closed login session could not be cleared yet.') })
      void loginSession.closeAllConnections().catch(() => { this.emit('cleanupWarning', 'The closed login connections could not be released yet.') })
    }
    this.cookieListener = null
    for (const window of [...this.popupWindows, this.loginWindow]) if (window && !window.isDestroyed()) window.destroy()
    this.popupWindows = new Set()
    this.loginWindow = null
    this.loginSession = null
    this.config = null
    this.networkTokens = {}
    this.checking = false
  }
  cancel(): void { this.complete({ success: false, error: 'Login cancelled by user.' }) }
  isWindowOpen(): boolean { return this.active }
  destroy(): void { this.cancel(); this.removeAllListeners() }
}
export const inAppLoginManager = new InAppLoginManager()
export default InAppLoginManager
