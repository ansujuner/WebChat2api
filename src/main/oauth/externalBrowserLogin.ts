import { getProviderProxyConfig, normalizeNetworkProxyConfig, type ProviderProxyConfig } from '../network/providerContext.ts'
/** DeepSeek login in a real installed browser; no Electron identity masking or fingerprint changes. */
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { InAppLoginOptions, InAppLoginResult } from './inAppLogin'
import { browserChildEnvironment, findInstalledLoginBrowser, loginBrowserArguments, type InstalledLoginBrowser } from './browserDiscovery'
import { CdpPipe } from './cdpPipe'
import { isCredentialCandidate, storedCredential } from './loginPolicy'

const PROVIDER_ORIGIN = 'https://chat.deepseek.com'
const TOKEN_EXPRESSION = `location.origin === ${JSON.stringify(PROVIDER_ORIGIN)} ? localStorage.getItem('userToken') : null`
const ENVIRONMENT_EXPRESSION = `location.origin === ${JSON.stringify(PROVIDER_ORIGIN)} ? ({electron: navigator.userAgent.toLowerCase().includes('electron') || ('process' in window && window.process?.type === 'renderer'), tauri: navigator.userAgent.toLowerCase().includes('tauri') || !!window.__TAURI__, unsafeWarningVisible: /使用环境异常|数据和隐私泄露风险|当前设备运行环境异常/.test(document.body?.innerText || '')}) : null`
const DEFAULT_TIMEOUT = 300000

export function isDeepSeekLoginPage(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try { const parsed = new URL(url); return parsed.origin === PROVIDER_ORIGIN && !parsed.username && !parsed.password } catch { return false }
}

/** Validate canonical containment again immediately before recursive profile removal. */
export async function removeOwnedLoginProfile(profileRoot: string, profile: string): Promise<void> {
  const [rootReal, profileReal] = await Promise.all([realpath(profileRoot), realpath(profile)])
  const relative = path.relative(rootReal, profileReal)
  if (!relative || path.isAbsolute(relative) || relative.includes(path.sep) || !/^login-[A-Za-z0-9_-]+$/.test(relative)) {
    throw new Error('The isolated login profile path failed its ownership check.')
  }
  if (path.resolve(profile) !== profileReal) throw new Error('The isolated login profile path changed.')
  await rm(profileReal, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

interface LoginAttempt {
  controller: AbortController
  closing: boolean
  started: number
  profileRoot: string | null
  profile: string | null
  browser: InstalledLoginBrowser | null
  child: ChildProcess | null
  exited: boolean
  exitPromise: Promise<void> | null
  pipe: CdpPipe | null
  poll: NodeJS.Timeout | null
  timer: NodeJS.Timeout | null
  checking: boolean
  launch: Promise<void>
  completion: Promise<InAppLoginResult>
  resolve: (result: InAppLoginResult) => void
}

export interface LoginBrowserEnvironment {
  browser: 'Chrome' | 'Edge'
  userAgent: string
  providerPages: { electron: boolean; tauri: boolean; unsafeWarningVisible: boolean }[]
}

export class ExternalBrowserLoginManager extends EventEmitter {
  private attempt: LoginAttempt | null = null

  async startLogin(options: InAppLoginOptions): Promise<InAppLoginResult> {
    if (this.attempt) return { success: false, error: 'A login process is already in progress' }
    if (options.providerType !== 'deepseek') return { success: false, error: 'System-browser automatic login currently supports DeepSeek only.' }
    if (options.proxyMode !== undefined && !['system', 'none'].includes(options.proxyMode)) return { success: false, error: 'Invalid login proxy mode.' }
    if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout < 1000 || options.timeout > 1800000)) return { success: false, error: 'Login timeout must be between 1 second and 30 minutes.' }
    let proxyConfig: ProviderProxyConfig
    try { proxyConfig = normalizeNetworkProxyConfig(options.proxyConfig ?? options.proxyMode ?? getProviderProxyConfig(options.providerId)) }
    catch { return { success: false, error: 'Invalid login proxy configuration.' } }
    let resolve!: LoginAttempt['resolve']
    const result = new Promise<InAppLoginResult>(done => { resolve = done })
    const attempt: LoginAttempt = { controller: new AbortController(), closing: false, started: Date.now(), profileRoot: null, profile: null, browser: null, child: null,
      exited: false, exitPromise: null, pipe: null, poll: null, timer: null, checking: false, launch: Promise.resolve(), completion: result, resolve }
    this.attempt = attempt
    attempt.timer = setTimeout(() => this.finish(attempt, { success: false, error: 'Login timeout. Please retry when ready to sign in.' }), options.timeout ?? DEFAULT_TIMEOUT)
    attempt.launch = this.launch(attempt, { ...options, proxyConfig }).catch(() => {
      this.finish(attempt, { success: false, error: 'The isolated browser could not be started. Check Chrome/Edge installation and local security settings, or use manual token import.' })
    })
    this.emit('status', { status: 'pending', message: 'Opening an isolated Chrome/Edge login window. Your usual browser profile will not be read.' })
    return result
  }

  private current(attempt: LoginAttempt): boolean { return this.attempt === attempt && !attempt.closing }

  private async launch(attempt: LoginAttempt, options: InAppLoginOptions): Promise<void> {
    try { attempt.browser = await findInstalledLoginBrowser(attempt.controller.signal) } catch {
      this.finish(attempt, { success: false, error: 'No verified Chrome or Edge is available for automatic login. Install or repair the official browser, or use manual token import.' })
      return
    }
    if (!this.current(attempt)) return
    const userData = await realpath(app.getPath('userData'))
    if (!this.current(attempt)) return
    const root = path.join(userData, 'oauth-browser-profiles')
    await mkdir(root, { recursive: true })
    attempt.profileRoot = await realpath(root)
    if (path.relative(userData, attempt.profileRoot) !== 'oauth-browser-profiles') throw new Error('The login profile root must be inside app data.')
    if (!this.current(attempt)) return
    attempt.profile = await mkdtemp(path.join(attempt.profileRoot, 'login-'))
    if (!this.current(attempt)) return
    const profileReal = await realpath(attempt.profile)
    if (profileReal !== path.resolve(attempt.profile) || path.dirname(profileReal) !== attempt.profileRoot) throw new Error('The isolated profile path changed before launch.')
    if (!this.current(attempt)) return
    const child = spawn(attempt.browser.executable, loginBrowserArguments(attempt.profile, options.proxyConfig ?? options.proxyMode ?? getProviderProxyConfig(options.providerId)), {
      shell: false, windowsHide: false, detached: false,
      // Chromium reads FD 3 and writes FD 4. No stderr/stdout logs containing page data are captured.
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: browserChildEnvironment(),
    })
    attempt.child = child
    attempt.exitPromise = new Promise(done => {
      const exited = (): void => { attempt.exited = true; done() }
      child.once('exit', exited)
      child.once('error', exited)
    })
    child.once('error', () => this.finish(attempt, { success: false, error: 'The login browser could not be started. Check your installed browser or use manual import.' }))
    child.once('exit', () => this.finish(attempt, { success: false, error: 'Login browser was closed.' }))
    const input = child.stdio[3] as Writable | null
    const output = child.stdio[4] as Readable | null
    if (!input || !output) throw new Error('Private browser pipes are unavailable.')
    const pipe = new CdpPipe(input, output)
    attempt.pipe = pipe
    pipe.once('close', () => {
      if (this.current(attempt)) this.finish(attempt, { success: false, error: 'The private login browser connection was closed. Please retry or use manual import.' })
    })
    // Wait for browser readiness without evaluating or altering any page.
    await pipe.send('Browser.getVersion', {}, undefined, 15000)
    if (!this.current(attempt)) return
    this.emit('status', { status: 'pending', message: `Please sign in normally in the new ${attempt.browser.name} window. Only the DeepSeek login token will be imported after validation.` })
    attempt.poll = setInterval(() => { void this.checkTokens(attempt) }, 1500)
    void this.checkTokens(attempt)
  }

  private async readProviderPages(attempt: LoginAttempt, expression: string): Promise<unknown[]> {
    const pipe = attempt.pipe
    if (!pipe || !this.current(attempt)) return []
    const { targetInfos } = await pipe.send('Target.getTargets')
    if (!Array.isArray(targetInfos)) return []
    const results: unknown[] = []
    for (const target of targetInfos.slice(0, 64)) {
      if (!this.current(attempt)) break
      // Never attach to IdP pages, subdomains, browser settings, workers, or existing user profiles.
      if (target.type !== 'page' || typeof target.targetId !== 'string' || !isDeepSeekLoginPage(target.url)) continue
      let sessionId: string | undefined
      try {
        const attached = await pipe.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
        sessionId = typeof attached.sessionId === 'string' ? attached.sessionId : undefined
        if (!sessionId || !this.current(attempt)) continue
        const { targetInfo } = await pipe.send('Target.getTargetInfo', { targetId: target.targetId })
        if (!this.current(attempt) || !isDeepSeekLoginPage(targetInfo?.url)) continue
        // The expression rechecks origin atomically to cover navigation between CDP messages.
        const value = await pipe.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false, timeout: 2000 }, sessionId)
        if (this.current(attempt) && !value.exceptionDetails) results.push(value.result?.value)
      } catch { /* A provider tab can navigate or close during polling; a later tick retries. */ }
      finally {
        if (sessionId) await pipe.send('Target.detachFromTarget', { sessionId }).catch(() => undefined)
      }
    }
    return results
  }

  private async checkTokens(attempt: LoginAttempt): Promise<void> {
    if (!this.current(attempt) || attempt.checking || Date.now() - attempt.started < 5000) return
    attempt.checking = true
    try {
      const values = await this.readProviderPages(attempt, TOKEN_EXPRESSION)
      for (const value of values) {
        if (!this.current(attempt)) return
        const token = storedCredential(value)
        if (isCredentialCandidate(token)) this.emit('tokenFound', { key: 'userToken', value: token })
      }
    } catch {
      if (this.current(attempt)) this.emit('status', { status: 'pending', message: 'Waiting for the DeepSeek login page. Complete sign-in in the new browser window.' })
    } finally { attempt.checking = false }
  }

  /** Read-only, bounded diagnostic fields; never returns URLs, tokens, cookies or an arbitrary CDP handle. */
  async getBrowserEnvironment(): Promise<LoginBrowserEnvironment | null> {
    const attempt = this.attempt
    if (!attempt || !attempt.browser || !attempt.pipe || !this.current(attempt)) return null
    try {
      const version = await attempt.pipe.send('Browser.getVersion')
      const pages = await this.readProviderPages(attempt, ENVIRONMENT_EXPRESSION)
      if (!this.current(attempt)) return null
      return { browser: attempt.browser.name, userAgent: typeof version.userAgent === 'string' ? version.userAgent.slice(0, 512) : '',
        providerPages: pages.filter((value): value is Record<string, boolean> => !!value && typeof value === 'object')
          .map(value => ({ electron: value.electron === true, tauri: value.tauri === true, unsafeWarningVisible: value.unsafeWarningVisible === true })) }
    } catch (error) {
      // Completion/cancellation legitimately closes an in-flight diagnostic's pipe.
      if (!this.current(attempt)) return null
      throw error
    }
  }

  completeWithSuccess(credentials: Record<string, string>): void {
    if (this.attempt) this.finish(this.attempt, { success: true, credentials: { ...credentials } })
  }

  private finish(attempt: LoginAttempt, result: InAppLoginResult): void {
    if (!this.current(attempt)) return
    attempt.closing = true
    attempt.controller.abort()
    if (attempt.timer) clearTimeout(attempt.timer)
    if (attempt.poll) clearInterval(attempt.poll)
    void this.cleanup(attempt).catch(() => {
      this.emit('cleanupWarning', 'The isolated login browser could not be completely closed. Close its window manually.')
    }).finally(() => {
      if (this.attempt === attempt) this.attempt = null
      attempt.resolve(result)
      this.emit('complete', result)
    })
  }

  private async cleanup(attempt: LoginAttempt): Promise<void> {
    // Close the pipe even during initial readiness, so cancellation cannot wait out that command.
    const pipe = attempt.pipe
    if (pipe && !attempt.exited) await pipe.send('Browser.close', {}, undefined, 2000).catch(() => undefined)
    pipe?.close()
    // Cancelled discovery/mkdtemp must settle before capturing profile ownership for removal.
    await attempt.launch
    if (attempt.exitPromise && !attempt.exited) {
      let timer: NodeJS.Timeout | undefined
      await Promise.race([attempt.exitPromise, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000) })])
      if (timer) clearTimeout(timer)
    }
    const remove = async (): Promise<void> => {
      if (!attempt.profile || !attempt.profileRoot) return
      try { await removeOwnedLoginProfile(attempt.profileRoot, attempt.profile) }
      catch { this.emit('cleanupWarning', 'The isolated login profile could not be removed yet. Close its browser window before retrying cleanup.') }
    }
    if (attempt.child && !attempt.exited) {
      this.emit('cleanupWarning', 'The isolated login browser is still closing. Close that window; its temporary profile will be removed after it exits.')
      // Never terminate other browser processes or delete profile files while a browser still owns them.
      void attempt.exitPromise?.then(remove)
    } else await remove()
  }

  cancel(): void { if (this.attempt) this.finish(this.attempt, { success: false, error: 'Login cancelled by user.' }) }

  /** App shutdown may await cleanup for at most 10 seconds; slow resources remain ownership-guarded. */
  async cancelAndWait(): Promise<void> {
    const attempt = this.attempt
    if (!attempt) return
    this.cancel()
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        attempt.completion,
        new Promise<void>(resolve => {
          timer = setTimeout(() => {
            this.emit('cleanupWarning', 'Login cleanup is taking longer than expected. Its isolated browser profile may remain until the browser finishes closing.')
            resolve()
          }, 10000)
        }),
      ])
    } finally { if (timer) clearTimeout(timer) }
  }

  isWindowOpen(): boolean { return !!this.attempt }
  destroy(): void { this.cancel(); this.removeAllListeners() }
}

export const externalBrowserLoginManager = new ExternalBrowserLoginManager()
export default ExternalBrowserLoginManager
