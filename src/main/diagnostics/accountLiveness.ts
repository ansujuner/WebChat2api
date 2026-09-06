import { createHash, randomUUID } from 'node:crypto'
import { accountAvailability, type AccountAvailabilityInput } from '../../shared/accountAvailability.ts'
import type { AccountLivenessInput, AccountLivenessJob, AccountLivenessReason, AccountLivenessResult } from '../../shared/accountLiveness.ts'
import type { ForwardResult } from '../proxy/types.ts'

export class AccountLivenessError extends Error {
  readonly code: 'invalid_input' | 'busy'
  constructor(code: 'invalid_input' | 'busy') {
    super(code === 'busy' ? 'An account liveness check is already running.' : 'Invalid account liveness options.')
    this.name = 'AccountLivenessError'
    this.code = code
  }
}
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value)
const MAX_ACCOUNTS = 1000
export function validateAccountLivenessInput(value: unknown = {}): AccountLivenessInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AccountLivenessError('invalid_input')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['accountIds', 'providerId'].includes(key)) ||
    (input.accountIds !== undefined && input.providerId !== undefined)) throw new AccountLivenessError('invalid_input')
  if (input.providerId !== undefined && !validId(input.providerId)) throw new AccountLivenessError('invalid_input')
  if (input.accountIds !== undefined && (!Array.isArray(input.accountIds) || !input.accountIds.length ||
    input.accountIds.length > MAX_ACCOUNTS || !input.accountIds.every(validId))) throw new AccountLivenessError('invalid_input')
  return { ...(input.providerId !== undefined ? { providerId: input.providerId as string } : {}),
    ...(input.accountIds !== undefined ? { accountIds: [...new Set(input.accountIds as string[])] } : {}) }
}

export interface LivenessAccount extends AccountAvailabilityInput {
  id: string
  name: string
  providerId: string
  /** Opaque internal fingerprint of manual credential identity; never exported. */
  revision?: string
  errorMessage?: string
}
export interface LivenessProvider { id: string; enabled: boolean; revision?: string }
export interface LivenessModel { displayName: string; actualModelId: string }
export interface AccountLivenessDependencies {
  getAccounts(): LivenessAccount[]
  getAccount(id: string): LivenessAccount | undefined
  getProvider(id: string): LivenessProvider | undefined
  getModels(providerId: string): LivenessModel[]
  forward(accountId: string, model: LivenessModel, signal: AbortSignal): Promise<ForwardResult>
  recordSuccess?(accountId: string): void
  now?: () => number
  deadlineMs?: number
}

/** Choose one ordinary text model; never fan out to other models on failure. */
export function selectLivenessModel(providerId: string, models: LivenessModel[]): LivenessModel | undefined {
  const valid = models.filter(model => typeof model.displayName === 'string' && typeof model.actualModelId === 'string' &&
    model.displayName.trim() && model.actualModelId.trim() && model.displayName.length <= 256 && model.actualModelId.length <= 256 &&
    !/[\x00-\x1f\x7f*]/.test(model.displayName + model.actualModelId) &&
    !/(?:^arena\/image\/|embedding|rerank|whisper|tts|dall-e|seedream|flux|stable-diffusion|gpt-image|imagen|image-generation|video-generation)/i.test(model.displayName + ' ' + model.actualModelId))
  if (providerId === 'arena') return valid.find(model => model.displayName === 'arena/text/max') ?? valid.find(model => model.displayName.startsWith('arena/text/'))
  const preferred: Record<string, string[]> = { deepseek: ['deepseek-v4-flash'], zai: ['GLM-5.3-Flash'], glm: ['GLM-5.3-Flash'] }
  return valid.find(model => preferred[providerId]?.includes(model.displayName)) ??
    valid.find(model => !/(think|reason|research|search|vision|pro|expert)/i.test(model.displayName)) ?? valid[0]
}
const safeLabel = (value: string): string => value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256)
const snapshot = (job: AccountLivenessJob): AccountLivenessJob => ({ ...job, results: job.results.map(result => ({ ...result })) })
const knownBan = (account: LivenessAccount): boolean => account.errorMessage === 'DeepSeek account suspended; manual review required.' || account.errorMessage === 'account_banned'
const completeReply = (result: ForwardResult): boolean => {
  const choice = result.body?.choices?.[0]
  const calls = choice?.message?.tool_calls
  return result.success === true && result.status === 200 && !result.stream && !result.body?.error &&
    Array.isArray(result.body?.choices) && result.body.choices.length === 1 && choice?.finish_reason === 'stop' &&
    choice.message?.role === 'assistant' && (calls == null || (Array.isArray(calls) && calls.length === 0)) &&
    choice.message.function_call == null && typeof choice.message.content === 'string' &&
    choice.message.content.trim().length > 0 && Buffer.byteLength(choice.message.content, 'utf8') <= 65536
}
function failureReason(result: ForwardResult): AccountLivenessReason {
  if (result.errorCode === 'route_changed') return 'route_changed'
  if (result.errorCode === 'account_busy') return 'account_busy'
  if (result.errorCode === 'account_banned') return 'account_banned'
  if (result.errorCode === 'account_temporarily_suspended' || result.errorCode === 'account_cooldown') return 'cooldown'
  if (result.errorCode === 'quota_unavailable') return 'quota_unavailable'
  if (result.errorCode === 'browser_unavailable') return 'browser_unavailable'
  if (result.errorCode === 'model_not_available' || result.errorCode === 'model_unavailable') return 'model_unavailable'
  if (result.errorCode === 'account_missing') return 'account_missing'
  if (result.errorCode === 'provider_missing') return 'provider_missing'
  if (result.errorCode === 'daily_limit' || result.errorCode === 'account_daily_limit') return 'daily_limit'
  if (result.errorCode === 'account_probe_selection_changed') return 'account_changed'
  if (['account_probe_response_too_large', 'incomplete_stream', 'invalid_response', 'incomplete_response'].includes(result.errorCode ?? '')) return 'incomplete_response'
  if (result.errorCode === 'account_probe_cancelled') return 'timeout'
  if (result.errorCode === 'action_required' || result.status === 403) return 'action_required'
  if (result.status === 401) return 'auth_required'
  if (result.status === 429 || ['rate_limited', 'model_rate_limited'].includes(result.errorCode ?? '')) return 'rate_limited'
  if (result.status === 408 || result.status === 504 || result.errorCode === 'aborted') return 'timeout'
  return result.success || result.status === 200 ? 'incomplete_response' : 'request_failed'
}
function retryTime(result: ForwardResult, now: number): number | undefined {
  const seconds = result.headers?.['retry-after'] ?? result.headers?.['Retry-After']
  if (typeof seconds !== 'string' || !/^\d{1,9}$/.test(seconds)) return undefined
  const value = Number(seconds)
  return value > 0 ? now + value * 1000 : undefined
}

/** One app-wide serial job. Cancellation stops the queue, never retries or replaces an in-flight request. */
export class AccountLivenessService {
  private readonly deps: AccountLivenessDependencies
  private readonly now: () => number
  private readonly deadlineMs: number
  private job: AccountLivenessJob | null = null
  private completion: Promise<void> = Promise.resolve()
  private listeners = new Set<(job: AccountLivenessJob) => void>()
  constructor(deps: AccountLivenessDependencies) {
    this.deps = deps
    const clock = deps.now ?? Date.now
    this.now = () => Math.max(clock(), this.job?.updatedAt ?? 0)
    this.deadlineMs = deps.deadlineMs ?? 90_000
    if (!Number.isInteger(this.deadlineMs) || this.deadlineMs < 1 || this.deadlineMs > 300_000) throw new AccountLivenessError('invalid_input')
  }
  get(): AccountLivenessJob | null { return this.job ? snapshot(this.job) : null }
  subscribe(listener: (job: AccountLivenessJob) => void): () => void {
    this.listeners = new Set([...this.listeners, listener])
    return () => { this.listeners = new Set([...this.listeners].filter(candidate => candidate !== listener)) }
  }
  private emit(): void {
    if (!this.job) return
    for (const listener of this.listeners) {
      try { listener(snapshot(this.job)) }
      catch { console.warn('[AccountLiveness] A UI listener could not receive progress.') }
    }
  }
  private patch(id: string, updates: Partial<AccountLivenessResult>): void {
    if (!this.job) return
    this.job = { ...this.job, updatedAt: this.now(), results: this.job.results.map(result => result.accountId === id ? { ...result, ...updates } : result) }
    this.emit()
  }
  start(value: unknown = {}): AccountLivenessJob {
    const input = validateAccountLivenessInput(value)
    if (this.job && ['running', 'cancelling'].includes(this.job.state)) throw new AccountLivenessError('busy')
    const accounts = this.deps.getAccounts()
    const selected = input.accountIds ?? accounts.filter(account => !input.providerId || account.providerId === input.providerId).map(account => account.id)
    if (selected.length > MAX_ACCOUNTS) throw new AccountLivenessError('invalid_input')
    const now = Math.max(this.now(), (this.job?.startedAt ?? 0) + 1)
    this.job = { id: randomUUID(), mode: input.accountIds?.length === 1 ? 'single' : 'batch', state: 'running', startedAt: now, updatedAt: now,
      results: [...new Set(selected)].map(id => {
        const account = accounts.find(item => item.id === id)
        return { accountId: id, accountName: safeLabel(account?.name ?? id), providerId: account?.providerId ?? '', status: 'queued' }
      }) }
    const initial = snapshot(this.job)
    this.emit()
    // Start after returning the queued snapshot so callers can subscribe/render immediately.
    this.completion = Promise.resolve().then(() => this.run()).catch(() => {
      if (!this.job) return
      this.job = { ...this.job, state: 'completed', updatedAt: this.now(), finishedAt: this.now(), results: this.job.results.map(result =>
        ['queued', 'running'].includes(result.status) ? { ...result, status: 'failed', reason: 'internal_error', finishedAt: this.now() } : result) }
      this.emit()
    })
    return initial
  }
  cancel(jobId: unknown): AccountLivenessJob | null {
    if (!validId(jobId)) throw new AccountLivenessError('invalid_input')
    if (!this.job || this.job.id !== jobId) return this.get()
    if (this.job.state !== 'running') return this.get()
    const now = this.now()
    this.job = { ...this.job, state: 'cancelling', updatedAt: now, results: this.job.results.map(result =>
      result.status === 'queued' ? { ...result, status: 'cancelled', reason: 'cancelled', finishedAt: now } : result) }
    this.emit()
    return this.get()
  }
  async wait(jobId: string): Promise<AccountLivenessJob | null> {
    if (this.job?.id !== jobId) return null
    await this.completion
    return this.job?.id === jobId ? this.get() : null
  }
  private skip(id: string, reason: AccountLivenessReason, retryAt?: number): void {
    this.patch(id, { status: 'skipped', reason, finishedAt: this.now(), ...(retryAt ? { retryAt } : {}) })
  }
  private async run(): Promise<void> {
    const targets = this.job!.results.map(result => result.accountId)
    for (const id of targets) {
      if (this.job!.state === 'cancelling') break
      try { await this.runOne(id) }
      catch { this.patch(id, { status: 'failed', reason: 'internal_error', finishedAt: this.now() }) }
    }
    const now = this.now()
    this.job = { ...this.job!, state: this.job!.state === 'cancelling' ? 'cancelled' : 'completed', updatedAt: now, finishedAt: now }
    this.emit()
  }
  private async runOne(id: string): Promise<void> {
    const account = this.deps.getAccount(id)
    if (!account) return this.skip(id, 'account_missing')
    const provider = this.deps.getProvider(account.providerId)
    if (!provider) return this.skip(id, 'provider_missing')
    if (this.job!.mode === 'batch' && !provider.enabled) return this.skip(id, 'provider_disabled')
    if (this.job!.mode === 'batch' && account.enabled === false) return this.skip(id, 'disabled')
    if (knownBan(account)) return this.skip(id, 'account_banned')
    // Explicit tests can check stale credential status, without changing it or the manual switch.
    const availability = accountAvailability({ ...account, enabled: true, status: 'active' }, this.now())
    if (!availability.available) return this.skip(id, availability.reason === 'daily_limit' ? 'daily_limit' : 'cooldown', availability.availableAt)
    const model = selectLivenessModel(provider.id, this.deps.getModels(provider.id))
    if (!model) return this.skip(id, 'no_text_model')
    const startedAt = this.now()
    this.patch(id, { status: 'running', startedAt, model: model.displayName, accountName: safeLabel(account.name), providerId: account.providerId })
    const controller = new AbortController()
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; controller.abort() }, this.deadlineMs)
    // Never race/release the lock: not every provider can cancel preparation or recall a submitted request.
    try {
      const result = await this.deps.forward(id, model, controller.signal)
      const finishedAt = this.now()
      const timing = { finishedAt, latencyMs: Math.max(0, finishedAt - startedAt),
        ...(Number.isInteger(result.status) && result.status! >= 100 && result.status! <= 599 ? { httpStatus: result.status } : {}) }
      const current = this.deps.getAccount(id), currentProvider = this.deps.getProvider(provider.id)
      if (!current || current.providerId !== account.providerId || current.revision !== account.revision || currentProvider?.revision !== provider.revision) {
        this.patch(id, { status: 'failed', reason: 'account_changed', ...timing }); return
      }
      if (timedOut) { this.patch(id, { status: 'failed', reason: 'timeout', ...timing }); return }
      if (completeReply(result)) {
        this.deps.recordSuccess?.(id)
        this.patch(id, { status: 'passed', ...timing })
      } else {
        const retryAt = current.cooldownUntil ?? retryTime(result, finishedAt)
        this.patch(id, { status: 'failed', reason: failureReason(result), ...timing, ...(retryAt && retryAt > finishedAt ? { retryAt } : {}) })
      }
    } catch {
      this.patch(id, { status: 'failed', reason: timedOut ? 'timeout' : 'request_failed', finishedAt: this.now(), latencyMs: Math.max(0, this.now() - startedAt) })
    } finally { clearTimeout(timeout) }
  }
}

let servicePromise: Promise<AccountLivenessService> | undefined
async function getService(): Promise<AccountLivenessService> {
  if (!servicePromise) servicePromise = (async () => {
    const [{ storeManager }, { requestForwarder }, { recordAccountSuccess }] = await Promise.all([
      import('../store/store'), import('../proxy/forwarder'), import('../proxy/requestAccounting')])
    const identity = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const project = (account: ReturnType<typeof storeManager.getAccountById>): LivenessAccount | undefined => account && ({
      id: account.id, name: account.name, providerId: account.providerId, enabled: account.enabled, status: account.status,
      cooldownReason: account.cooldownReason, cooldownUntil: account.cooldownUntil, dailyLimit: account.dailyLimit,
      todayUsed: account.todayUsed, errorMessage: account.errorMessage, revision: identity([account.providerId, account.credentialRevision ?? 0]) })
    return new AccountLivenessService({
      getAccounts: () => storeManager.getAccounts().map(account => project(account)!),
      getAccount: id => project(storeManager.getAccountById(id)),
      getProvider: id => { const provider = storeManager.getProviderById(id); return provider && {
        id: provider.id, enabled: provider.enabled, revision: identity([provider.apiEndpoint, provider.chatPath, provider.headers, provider.authType]) } },
      getModels: id => storeManager.getEffectiveModels(id),
      forward: (id, model, signal) => requestForwarder.forwardAccountProbe(id, model.actualModelId, signal, model.displayName),
      recordSuccess: id => recordAccountSuccess(storeManager, id),
    })
  })().catch(error => { servicePromise = undefined; throw error })
  return servicePromise
}
export async function startAccountLiveness(input: unknown = {}): Promise<AccountLivenessJob> { return (await getService()).start(input) }
export async function getAccountLiveness(): Promise<AccountLivenessJob | null> { return (await getService()).get() }
export async function cancelAccountLiveness(jobId: unknown): Promise<AccountLivenessJob | null> { return (await getService()).cancel(jobId) }
export async function subscribeAccountLiveness(listener: (job: AccountLivenessJob) => void): Promise<() => void> { return (await getService()).subscribe(listener) }
export async function waitForAccountLiveness(jobId: string): Promise<AccountLivenessJob | null> { return (await getService()).wait(jobId) }

/** Redacted CLI report: safe to inspect locally without exporting identity labels. */
export function summarizeAccountLivenessJob(job: AccountLivenessJob) {
  const counts = { total: job.results.length,
    passed: job.results.filter(result => result.status === 'passed').length,
    failed: job.results.filter(result => result.status === 'failed').length,
    skipped: job.results.filter(result => result.status === 'skipped').length,
    cancelled: job.results.filter(result => result.status === 'cancelled').length }
  return { status: counts.total > 0 && counts.passed === counts.total ? 'passed' : 'needs_attention', state: job.state, counts,
    checks: job.results.map(result => ({ provider: result.providerId, status: result.status,
      ...(result.model ? { model: result.model } : {}), ...(result.reason ? { reason: result.reason } : {}),
      ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}), ...(result.latencyMs !== undefined ? { latencyMs: result.latencyMs } : {}),
      ...(result.retryAt ? { retryAt: result.retryAt } : {}) })) }
}
export async function runAccountLivenessProbe(input: unknown = {}) {
  const job = await startAccountLiveness(input)
  const result = await waitForAccountLiveness(job.id)
  if (!result) throw new Error('Account liveness report is no longer available.')
  return summarizeAccountLivenessJob(result)
}
