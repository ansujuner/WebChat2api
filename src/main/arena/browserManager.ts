import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile, lstat } from 'node:fs/promises'
import path from 'node:path'
import { Readable, type Writable } from 'node:stream'
import { findInstalledLoginBrowser, loginBrowserArguments, browserChildEnvironment } from '../oauth/browserDiscovery'
import { CdpPipe } from '../oauth/cdpPipe'
import { storeManager } from '../store/store'
import { getProviderProxyConfig } from '../network/proxy'
import type { ProviderProxyConfig } from '../../shared/providerNetwork'
import { accountEmail } from '../../shared/accountIdentity'
import type { AccountReauthenticationErrorCode } from '../../shared/accountReauthentication'
import { ARENA_PUBLIC_MODELS, ArenaError, ArenaProtocolDecoder, arenaRequest, isArenaPage, isArenaUuid, normalizeArenaModels, type ArenaConversation, type ArenaModel, type ArenaModality } from './protocol'
import { ARENA_RUNTIME_SNAPSHOT, arenaStartExpression, arenaDrainExpression, arenaAbortExpression } from './pageScripts'
import { getArenaRateLimiter, isArenaQuotaAccountId } from './rateLimit'

export interface ArenaAccountInfo { email?: string; name?: string }
export interface ArenaLoginResult { success: boolean; profileId?: string; accountInfo?: ArenaAccountInfo; error?: string }
export interface ArenaReauthenticationOptions { profileId: string; expectedEmail?: string; isAccountCurrent: () => boolean }
export interface ArenaReauthenticationResult extends ArenaLoginResult { errorCode?: AccountReauthenticationErrorCode }
export interface ArenaStatus { authenticated: boolean; accountInfo?: ArenaAccountInfo; actionRequired?: boolean; errorCode?: 'route_changed' }
export interface ArenaChatOptions { accountId: string; profileId: string; model: string; prompt: string; conversation?: ArenaConversation; signal?: AbortSignal }
export interface ArenaCatalog { models: ArenaModel[]; source: 'runtime' | 'public-snapshot' }
interface BrowserContext { profileId: string; pipe: CdpPipe; child: ChildProcess; exited: () => boolean; exit: Promise<void>; proxyConfig: ProviderProxyConfig }

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new ArenaError('aborted'))
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(new ArenaError('aborted')) }
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/** Only application-created UUID profiles are accepted; never attach to an existing personal browser. */
export async function arenaProfileDirectory(profileId: string, create = false): Promise<string> {
  if (!isArenaUuid(profileId)) throw new ArenaError('invalid_request')
  const appDirectory = await realpath(app.getPath('userData'))
  const root = path.join(appDirectory, 'arena-browser-profiles')
  await mkdir(root, { recursive: true })
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new ArenaError('browser_unavailable')
  const directory = path.join(root, profileId)
  if (create) {
    await mkdir(directory)
    await writeFile(path.join(directory, 'chat2api-profile.json'), JSON.stringify({ provider: 'arena', version: 1, profileId }), { flag: 'wx', mode: 0o600 })
  }
  if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory || path.dirname(directory) !== root) throw new ArenaError('browser_unavailable')
  const markerPath = path.join(directory, 'chat2api-profile.json')
  const markerStat = await lstat(markerPath)
  if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size > 512) throw new ArenaError('browser_unavailable')
  const markerText = await readFile(markerPath, 'utf8')
  if (markerText.length > 512) throw new ArenaError('browser_unavailable')
  let marker: any
  try { marker = JSON.parse(markerText) } catch { throw new ArenaError('browser_unavailable') }
  if (!marker || typeof marker !== 'object' || marker.provider !== 'arena' || marker.version !== 1 || marker.profileId !== profileId) throw new ArenaError('browser_unavailable')
  return directory
}

export class ArenaBrowserManager extends EventEmitter {
  private browsers = new Map<string, Promise<BrowserContext>>()
  private closingProfiles = new Map<string, Promise<void>>()
  private busyProfiles = new Set<string>()
  private login: { controller: AbortController; completion: Promise<ArenaLoginResult>; profileId?: string } | null = null
  private destroyed = false

  isWindowOpen(): boolean { return this.login !== null }
  hasOpenBrowsers(): boolean { return this.login !== null || this.browsers.size > 0 }
  async startLogin(): Promise<ArenaLoginResult> {
    if (this.destroyed) return { success: false, error: 'The Arena browser manager is shutting down.' }
    if (this.login) return { success: false, error: 'An Arena login is already in progress.' }
    const controller = new AbortController()
    const completion = this.loginFlow(controller)
    this.login = { controller, completion }
    try { return await completion } finally { if (this.login?.controller === controller) this.login = null }
  }
  /** Existing accounts keep their exact app-owned profile. No new profile or copied cookies. */
  async reauthenticate(options: ArenaReauthenticationOptions): Promise<ArenaReauthenticationResult> {
    if (this.destroyed) return { success: false, errorCode: 'browser_error' }
    if (!isArenaUuid(options.profileId)) return { success: false, errorCode: 'invalid_account' }
    if (this.login || this.busyProfiles.has(options.profileId)) return { success: false, errorCode: 'busy' }
    const controller = new AbortController()
    this.busyProfiles = new Set([...this.busyProfiles, options.profileId])
    const completion = this.reauthenticateFlow(options, controller)
    this.login = { controller, completion, profileId: options.profileId }
    try { return await completion }
    finally {
      if (this.login?.controller === controller) this.login = null
      this.busyProfiles = new Set([...this.busyProfiles].filter(id => id !== options.profileId))
    }
  }
  private async reauthenticateFlow(options: ArenaReauthenticationOptions, controller: AbortController): Promise<ArenaReauthenticationResult> {
    let timedOut = false, shown = false
    const isCurrent = () => { try { return options.isAccountCurrent() } catch { return false } }
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, 5 * 60 * 1000)
    try {
      if (!isCurrent()) return { success: false, errorCode: 'account_changed' }
      await arenaProfileDirectory(options.profileId) // Verify ownership marker; never create a replacement.
      const browser = await this.context(options.profileId, controller.signal, true)
      let expectedEmail = accountEmail(options.expectedEmail)
      while (!controller.signal.aborted) {
        if (!isCurrent()) return { success: false, errorCode: 'account_changed' }
        if (browser.exited()) return { success: false, errorCode: 'cancelled' }
        const page = await this.readyPage(browser, controller.signal)
        let snapshot: any
        try {
          snapshot = page.snapshot
          if (!shown) { await browser.pipe.send('Page.bringToFront', {}, page.sessionId); shown = true }
        } finally { await browser.pipe.send('Target.detachFromTarget', { sessionId: page.sessionId }).catch(() => undefined) }
        if (!isCurrent()) return { success: false, errorCode: 'account_changed' }
        if (controller.signal.aborted) return { success: false, errorCode: timedOut ? 'timeout' : 'cancelled' }
        const email = accountEmail(snapshot?.accountInfo?.email)
        if (snapshot?.authenticated === true && email) {
          if (expectedEmail && email.toLowerCase() !== expectedEmail.toLowerCase()) return { success: false, errorCode: 'identity_mismatch' }
          // The original owned, already-authenticated profile can establish a legacy email.
          if (!expectedEmail) expectedEmail = email
          return { success: true, profileId: options.profileId, accountInfo: { email } }
        }
        // A logged-out legacy profile has no reliable identity to compare after a new sign-in.
        if (!expectedEmail) return { success: false, errorCode: 'identity_unverified' }
        await delay(1000, controller.signal)
      }
      return { success: false, errorCode: timedOut ? 'timeout' : 'cancelled' }
    } catch (error) {
      return { success: false, errorCode: !isCurrent() ? 'account_changed' : controller.signal.aborted ? timedOut ? 'timeout' : 'cancelled'
        : error instanceof ArenaError && error.code === 'route_changed' ? 'route_changed' : 'browser_error' }
    } finally { clearTimeout(timeout) }
  }
  /** Account deletion cancels only that profile's login and closes only its owned browser. */
  async clearProfile(profileId: string): Promise<void> {
    if (!isArenaUuid(profileId)) return
    const login = this.login
    if (login?.profileId === profileId) { login.controller.abort(); await login.completion }
    await this.closeProfile(profileId)
  }
  private async loginFlow(controller: AbortController): Promise<ArenaLoginResult> {
    const profileId = randomUUID()
    let successful = false
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000)
    try {
      await arenaProfileDirectory(profileId, true)
      if (controller.signal.aborted) throw new ArenaError('aborted')
      const browser = await this.context(profileId, controller.signal)
      this.emit('status', { status: 'pending', message: 'Sign in to Arena in its isolated Chrome/Edge window. Complete verification yourself if shown. No browser credentials are exported.' })
      while (!controller.signal.aborted) {
        if (browser.exited()) return { success: false, error: 'The Arena login browser was closed.' }
        const status = await this.status(profileId, controller.signal)
        if (controller.signal.aborted) throw new ArenaError('aborted')
        if (status.authenticated) { successful = true; return { success: true, profileId, accountInfo: status.accountInfo } }
        await delay(1000, controller.signal)
      }
      return { success: false, error: 'Arena login was cancelled.' }
    } catch {
      return { success: false, error: controller.signal.aborted ? 'Arena login was cancelled or timed out.' : 'Arena login could not be completed. Check the isolated browser and try again.' }
    } finally {
      clearTimeout(timeout)
      if (!successful) await this.closeProfile(profileId)
    }
  }
  cancel(): void { this.login?.controller.abort() }
  async cancelAndWait(): Promise<void> { const login = this.login; login?.controller.abort(); await login?.completion }
  async destroy(): Promise<void> {
    this.destroyed = true
    await this.cancelAndWait()
    await Promise.all([...this.browsers.keys()].map(id => this.closeProfile(id)))
  }

  private async context(profileId: string, signal?: AbortSignal, requestOwner = false): Promise<BrowserContext> {
    if (this.destroyed) throw new ArenaError('browser_unavailable')
    if (!isArenaUuid(profileId)) throw new ArenaError('invalid_request')
    if (signal?.aborted) throw new ArenaError('aborted')
    await this.closingProfiles.get(profileId)
    if (this.destroyed) throw new ArenaError('browser_unavailable')
    if (signal?.aborted) throw new ArenaError('aborted')
    const proxyConfig = getProviderProxyConfig('arena')
    const existing = this.browsers.get(profileId)
    if (existing) {
      const context = await existing
      if (!context.exited()) {
        if (JSON.stringify(context.proxyConfig) === JSON.stringify(proxyConfig)) return context
        // An idle API lease cannot prove a visible website's manual generation has finished.
        // Never close it or submit on the old route; the user must close this window first.
        throw new ArenaError('route_changed', { stage: 'browser' })
      }
      if (this.busyProfiles.has(profileId) && !requestOwner) throw new ArenaError('account_busy')
      await this.closeProfile(profileId)
      return this.context(profileId, signal, requestOwner)
    }
    const launch = this.launch(profileId, proxyConfig, signal)
    this.browsers = new Map([...this.browsers, [profileId, launch]])
    try { return await launch } catch {
      this.browsers = new Map([...this.browsers].filter(([id, value]) => id !== profileId || value !== launch))
      throw new ArenaError(signal?.aborted ? 'aborted' : 'browser_unavailable')
    }
  }
  private async launch(profileId: string, proxyConfig: ProviderProxyConfig, signal?: AbortSignal): Promise<BrowserContext> {
    const directory = await arenaProfileDirectory(profileId)
    const browser = await findInstalledLoginBrowser(signal)
    if (signal?.aborted) throw new ArenaError('aborted')
    const args = [...loginBrowserArguments(directory, proxyConfig).slice(0, -1), 'https://arena.ai/text/direct']
    const child = spawn(browser.executable, args, { shell: false, windowsHide: false, detached: false,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], env: browserChildEnvironment() })
    let exited = false
    const exit = new Promise<void>(resolve => {
      const finish = () => { exited = true; resolve() }
      child.once('exit', finish); child.once('error', finish)
    })
    const input = child.stdio[3] as Writable | null, output = child.stdio[4] as Readable | null
    if (!input || !output) throw new ArenaError('browser_unavailable')
    const pipe = new CdpPipe(input, output)
    try { await pipe.send('Browser.getVersion', {}, undefined, 15000) }
    catch {
      await pipe.send('Browser.close', {}, undefined, 2000).catch(() => undefined)
      pipe.close()
      throw new ArenaError('browser_unavailable')
    }
    return { profileId, pipe, child, exit, exited: () => exited, proxyConfig }
  }
  private async closeProfile(profileId: string): Promise<void> {
    const closing = this.closingProfiles.get(profileId)
    if (closing) return closing
    const pending = this.browsers.get(profileId)
    if (!pending) return
    const completion = (async () => { try {
      const context = await pending
      if (!context.exited()) await context.pipe.send('Browser.close', {}, undefined, 2000).catch(() => undefined)
      context.pipe.close()
      let timer: NodeJS.Timeout | undefined
      try { await Promise.race([context.exit, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000) })]) }
      finally { if (timer) clearTimeout(timer) }
      // Persistent application-owned profiles intentionally survive; never delete a live browser profile.
    } catch { /* A failed launch has no reusable pipe; never export its raw exception. */ }
    finally {
      this.browsers = new Map([...this.browsers].filter(([id, value]) => id !== profileId || value !== pending))
      this.closingProfiles = new Map([...this.closingProfiles].filter(([id]) => id !== profileId))
    } })()
    this.closingProfiles = new Map([...this.closingProfiles, [profileId, completion]])
    return completion
  }

  private async page(context: BrowserContext): Promise<{ targetId: string; sessionId: string }> {
    const { targetInfos } = await context.pipe.send('Target.getTargets')
    const target = Array.isArray(targetInfos) ? targetInfos.find(target => target.type === 'page' && isArenaPage(target.url) && typeof target.targetId === 'string') : undefined
    if (!target) throw new ArenaError('action_required')
    const attached = await context.pipe.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    if (typeof attached.sessionId !== 'string') throw new ArenaError('browser_unavailable')
    try {
      const { targetInfo } = await context.pipe.send('Target.getTargetInfo', { targetId: target.targetId })
      if (!isArenaPage(targetInfo?.url)) throw new ArenaError('action_required')
      return { targetId: target.targetId, sessionId: attached.sessionId }
    } catch (error) {
      await context.pipe.send('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => undefined)
      throw error instanceof ArenaError ? error : new ArenaError('browser_unavailable')
    }
  }
  private async evaluate(context: BrowserContext, sessionId: string, expression: string, timeout = 5000): Promise<any> {
    const response = await context.pipe.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout }, sessionId, timeout + 1000)
    if (response.exceptionDetails) throw new ArenaError('browser_unavailable')
    return response.result?.value
  }
  /** Poll only browser readiness, never submission: a restored profile can take seconds to hydrate. */
  private async readyPage(context: BrowserContext, signal?: AbortSignal): Promise<{ targetId: string; sessionId: string; snapshot: any }> {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ArenaError('aborted', { stage: 'snapshot' })
      if (this.destroyed || context.exited()) throw new ArenaError('browser_unavailable', { stage: 'browser' })
      let page: { targetId: string; sessionId: string } | undefined, retained = false
      try {
        page = await this.page(context)
        const snapshot = await this.evaluate(context, page.sessionId, ARENA_RUNTIME_SNAPSHOT)
        if (signal?.aborted) throw new ArenaError('aborted', { stage: 'snapshot' })
        if (snapshot?.ready === true) { retained = true; return { ...page, snapshot } }
      } catch (error) {
        if (signal?.aborted || error instanceof ArenaError && error.code === 'aborted') throw new ArenaError('aborted', { stage: 'snapshot' })
        // The initial target can still be about:blank or redirecting; no provider request is made here.
      } finally {
        if (page && !retained) await context.pipe.send('Target.detachFromTarget', { sessionId: page.sessionId }).catch(() => undefined)
      }
      const remaining = deadline - Date.now()
      if (remaining > 0) await delay(Math.min(250, remaining), signal)
    }
    throw new ArenaError('action_required', { stage: 'snapshot' })
  }
  private async snapshot(profileId: string, signal?: AbortSignal): Promise<any> {
    const context = await this.context(profileId, signal)
    const page = await this.readyPage(context, signal)
    try { return page.snapshot }
    finally { await context.pipe.send('Target.detachFromTarget', { sessionId: page.sessionId }).catch(() => undefined) }
  }
  async status(profileId: string, signal?: AbortSignal): Promise<ArenaStatus> {
    try {
      const snapshot = await this.snapshot(profileId, signal)
      const email = snapshot?.accountInfo?.email
      if (snapshot?.authenticated === true && typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320) {
        return { authenticated: true, accountInfo: { email, ...(typeof snapshot.accountInfo.name === 'string' && snapshot.accountInfo.name.length <= 160 ? { name: snapshot.accountInfo.name } : {}) } }
      }
      return { authenticated: false, actionRequired: true }
    } catch (error) { return { authenticated: false, actionRequired: true,
      ...(error instanceof ArenaError && error.code === 'route_changed' ? { errorCode: 'route_changed' as const } : {}) } }
  }
  async getModels(profileId?: string, signal?: AbortSignal): Promise<ArenaCatalog> {
    if (profileId) {
      const snapshot = await this.snapshot(profileId, signal)
      if (snapshot?.authenticated !== true) throw new ArenaError('action_required')
      const models = normalizeArenaModels(snapshot?.models)
      if (models.length) return { models, source: 'runtime' }
      throw new ArenaError('action_required')
    }
    return { models: ARENA_PUBLIC_MODELS.map(model => ({ ...model })), source: 'public-snapshot' }
  }
  async chat(options: ArenaChatOptions): Promise<{ stream: Readable; conversation: ArenaConversation }> {
    return this.request(options, 'text')
  }
  async generateImage(options: Omit<ArenaChatOptions, 'conversation'>): Promise<{ url: string }> {
    const result = await this.request(options, 'image')
    const decoder = new ArenaProtocolDecoder(), images: string[] = []
    let successfulFinish = false
    const accept = (events: ReturnType<ArenaProtocolDecoder['push']>) => {
      for (const event of events) {
        if (event.type === 'image') images.push(event.url)
        if (event.type === 'finish') {
          if (event.reason !== 'stop') throw new ArenaError('upstream_error', { stage: 'decode', protocolCode: 'd' })
          successfulFinish = true
        }
      }
    }
    for await (const chunk of result.stream) {
      accept(decoder.push(chunk))
    }
    accept(decoder.end())
    if (!successfulFinish || !images.length) throw new ArenaError('upstream_error', { stage: 'decode' })
    return { url: images[0] }
  }
  private async request(options: ArenaChatOptions, modality: ArenaModality): Promise<{ stream: Readable; conversation: ArenaConversation }> {
    if (!options || !isArenaQuotaAccountId(options.accountId) || !isArenaUuid(options.profileId) || typeof options.model !== 'string' || !options.model.trim()
      || options.model.length > 160 || typeof options.prompt !== 'string' || !options.prompt.trim()
      || options.prompt.length > 200000) throw new ArenaError('invalid_request')
    if (this.busyProfiles.has(options.profileId)) throw new ArenaError('account_busy')
    if (options.signal?.aborted) throw new ArenaError('aborted')
    this.busyProfiles = new Set([...this.busyProfiles, options.profileId])
    let context: BrowserContext | undefined, sessionId: string | undefined
    let stage: 'browser' | 'snapshot' | 'score' | 'stream' = 'browser'
    const key = `__chat2api_arena_${randomUUID().replaceAll('-', '')}`
    let released = false
    const abortPending = () => {
      if (context && sessionId) void this.evaluate(context, sessionId, arenaAbortExpression(key), 2000).catch(() => undefined)
    }
    const release = async () => {
      if (released) return
      released = true
      options.signal?.removeEventListener('abort', abortPending)
      if (context && sessionId) {
        await this.evaluate(context, sessionId, arenaAbortExpression(key), 2000).catch(() => undefined)
        await context.pipe.send('Target.detachFromTarget', { sessionId }).catch(() => undefined)
      }
      this.busyProfiles = new Set([...this.busyProfiles].filter(id => id !== options.profileId))
    }
    try {
      context = await this.context(options.profileId, options.signal, true)
      stage = 'snapshot'
      const page = await this.readyPage(context, options.signal); sessionId = page.sessionId
      options.signal?.addEventListener('abort', abortPending, { once: true })
      const snapshot = page.snapshot
      if (options.signal?.aborted) throw new ArenaError('aborted')
      if (snapshot?.authenticated !== true) throw new ArenaError('action_required')
      const account = storeManager.getAccountById(options.accountId, true)
      const expectedEmail = accountEmail(account?.email)
      const runtimeEmail = accountEmail(snapshot?.accountInfo?.email)
      if (!account || account.providerId !== 'arena' || account.credentials.browserProfileId !== options.profileId
        || !runtimeEmail || (expectedEmail && expectedEmail.toLowerCase() !== runtimeEmail.toLowerCase())) throw new ArenaError('action_required')
      const model = normalizeArenaModels(snapshot.models).find(model => model.modality === modality && (model.id === options.model || model.name.toLowerCase() === options.model.toLowerCase()))
      if (!model) throw new ArenaError('model_not_available')
      const request = arenaRequest(model, options.prompt, options.conversation)
      const quota = getArenaRateLimiter()
      quota.observeModel(options.accountId, model)
      const reservation = quota.reserve(options.accountId, model.id, modality)
      stage = 'score'
      const started = await this.evaluate(context, sessionId, arenaStartExpression(key, request.path, request.body), 65000)
      if (!started?.started && started?.diagnostic?.stage === 'score') quota.releaseBeforeSubmission(reservation)
      if (started?.error === 'rate_limited' || started?.diagnostic?.upstreamStatus === 429) {
        const retryAt = quota.cooldown(options.accountId, model.id, modality, started?.retryAt)
        throw new ArenaError('rate_limited', started?.diagnostic, retryAt)
      }
      if (options.signal?.aborted) throw new ArenaError('aborted')
      if (!started?.started) throw new ArenaError(started?.error === 'action_required' ? 'action_required' : started?.error === 'aborted' ? 'aborted' : 'upstream_error', started?.diagnostic)
      stage = 'stream'
      const owner = this, activeContext = context, activeSession = sessionId
      const stream = Readable.from((async function* () {
        try {
          while (true) {
            if (options.signal?.aborted) throw new ArenaError('aborted')
            const value = await owner.evaluate(activeContext, activeSession, arenaDrainExpression(key))
            if (!value || !Array.isArray(value.chunks)) throw new ArenaError('incomplete_stream')
            for (const chunk of value.chunks) { if (typeof chunk !== 'string') throw new ArenaError('upstream_error'); yield chunk }
            if (value.error) throw new ArenaError(value.error === 'action_required' ? 'action_required' : value.error === 'aborted' ? 'aborted' : 'incomplete_stream', value.diagnostic)
            if (value.done) break
            await delay(80, options.signal)
          }
        } catch (error) { throw error instanceof ArenaError && error.diagnostic ? error : new ArenaError(error instanceof ArenaError ? error.code : 'incomplete_stream', { stage: 'stream' }) }
        finally { await release() }
      })())
      const cancel = () => { stream.destroy(new ArenaError('aborted')); void release() }
      const deadline = setTimeout(cancel, 190000)
      options.signal?.addEventListener('abort', cancel, { once: true })
      options.signal?.removeEventListener('abort', abortPending)
      stream.once('close', () => { clearTimeout(deadline); options.signal?.removeEventListener('abort', cancel); void release() })
      return { stream, conversation: request.conversation }
    } catch (error) {
      await release()
      throw error instanceof ArenaError && error.diagnostic ? error : new ArenaError(error instanceof ArenaError ? error.code : 'browser_unavailable', { stage }, error instanceof ArenaError ? error.retryAt : undefined)
    }
  }
}

export const arenaBrowserManager = new ArenaBrowserManager()
