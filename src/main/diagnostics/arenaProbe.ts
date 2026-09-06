import { randomUUID } from 'node:crypto'
import { oauthManager } from '../oauth/manager'
import { arenaBrowserManager } from '../arena/browserManager'
import { ArenaError, arenaImageUrl } from '../arena/protocol'
import { AccountManager } from '../store/accounts'
import { storeManager } from '../store/store'
import { arenaProfileCredentials } from '../providers/arenaCatalog'
import { syncArenaProviderModels } from '../providers/arenaIntegration'
import { proxyServer } from '../proxy/server'
import { proxyStatusManager } from '../proxy/status'
import { requestLoopback, type ProbeHttpResponse } from './localProbe'
import { accountAvailability } from '../../shared/accountAvailability'

export interface ArenaLoginReport {
  version: 1
  live: false
  stream: false
  protocol: 'openai'
  status: 'awaiting_login' | 'passed' | 'login_busy' | 'login_not_completed' | 'action_required' | 'route_changed'
  accountVerified: boolean
  models: string[]
}
export interface ArenaProbeCheck {
  stage: 'text_first' | 'text_continuation' | 'image'
  model: string
  httpStatus?: number
  completed: boolean
  replyMatches?: boolean
  continued?: boolean
  imageReturned?: boolean
  error?: string
}
export interface ArenaProbeReport {
  version: 1
  live: true
  stream: false
  protocol: 'openai'
  running: boolean
  port?: number
  status: string
  accountVerified: boolean
  models: string[]
  checks: ArenaProbeCheck[]
}
let inFlight = false
const loginBase = (): ArenaLoginReport => ({ version: 1, live: false, stream: false, protocol: 'openai', status: 'awaiting_login', accountVerified: false, models: [] })
const activeArenaAccount = () => AccountManager.getByProviderId('arena', true).find(account => account.status === 'active')
const object = (text: string): Record<string, any> | undefined => {
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined }
  catch { return undefined }
}

/** Login is explicitly interactive. Only the returned owned-profile reference is saved, never browser tokens. */
export async function runArenaLoginProbe(progress: (report: ArenaLoginReport) => Promise<void>): Promise<ArenaLoginReport> {
  const base = loginBase()
  if (inFlight || oauthManager.isInAppLoginOpen()) return { ...base, status: 'login_busy' }
  inFlight = true
  let pending: ReturnType<typeof oauthManager.startInAppLogin> | undefined, settled = false
  try {
    const existing = activeArenaAccount()
    if (existing) {
      const credentials = arenaProfileCredentials(existing.credentials)
      const status = await arenaBrowserManager.status(credentials.browserProfileId)
      if (!status.authenticated) return { ...base, status: status.errorCode === 'route_changed' ? 'route_changed' : 'action_required' }
      const catalog = await syncArenaProviderModels(credentials.browserProfileId)
      return { ...base, status: 'passed', accountVerified: true, models: catalog.supportedModels }
    }
    pending = oauthManager.startInAppLogin('arena', 'arena', 10 * 60 * 1000).then(result => { settled = true; return result }, () => {
      settled = true; return { success: false, providerId: 'arena', providerType: 'arena', error: 'Arena login was not completed.' }
    })
    await progress(base)
    const result = await pending
    if (!result.success || !result.credentials) return { ...base, status: 'login_not_completed' }
    const credentials = arenaProfileCredentials(result.credentials)
    // Independently recheck the returned owned browser before writing an account.
    const status = await arenaBrowserManager.status(credentials.browserProfileId)
    if (!status.authenticated) return { ...base, status: status.errorCode === 'route_changed' ? 'route_changed' : 'action_required' }
    const catalog = await syncArenaProviderModels(credentials.browserProfileId)
    const duplicate = AccountManager.getByProviderId('arena', true).some(account => account.credentials?.browserProfileId === credentials.browserProfileId)
    if (!duplicate) AccountManager.create({ providerId: 'arena', nameSource: 'auto', email: status.accountInfo?.email, credentials })
    return { ...base, status: 'passed', accountVerified: true, models: catalog.supportedModels }
  } catch (error) {
    // Exceptions may contain profile paths or provider responses; reports contain categories only.
    return { ...base, status: error instanceof ArenaError && error.code === 'route_changed' ? 'route_changed' : 'login_not_completed' }
  } finally {
    if (pending && !settled) {
      try { oauthManager.cancelInAppLogin(); await arenaBrowserManager.cancelAndWait(); await pending }
      catch { /* No credentials or raw cancellation exceptions leave this diagnostic. */ }
    }
    inFlight = false
  }
}

function errorCategory(response: ProbeHttpResponse): string {
  const value = object(response.text)?.error
  if (response.status === 429 || value?.code === 'model_rate_limited') return 'rate_limited'
  const allowed = ['action_required', 'route_changed', 'model_not_available', 'invalid_request', 'browser_unavailable', 'account_busy', 'incomplete_stream', 'upstream_error', 'aborted', 'rate_limited', 'quota_unavailable'] as const
  for (const code of allowed) {
    if (value?.code === code || value?.message === new ArenaError(code).message) return code
  }
  if (response.status === 401 || response.status === 403) return 'action_required'
  return response.status === 200 ? 'incomplete_response' : 'request_failed_not_retried'
}
function failureStatus(response: ProbeHttpResponse, fallback: 'text_check_failed' | 'image_check_failed'): string {
  const category = errorCategory(response)
  return ['action_required', 'route_changed', 'rate_limited', 'quota_unavailable'].includes(category) ? category : fallback
}
function textReply(response: ProbeHttpResponse, marker: string): { completed: boolean; replyMatches: boolean } {
  const choice = object(response.text)?.choices?.[0]
  const completed = response.status === 200 && choice?.message?.role === 'assistant' && choice?.finish_reason === 'stop' && typeof choice.message.content === 'string'
  return { completed, replyMatches: completed && choice.message.content.trim() === marker }
}

/** Opt-in only: two text turns and one image via the existing authenticated loopback gateway. No retries. */
export async function runArenaProbe(): Promise<ArenaProbeReport> {
  let report: ArenaProbeReport = { version: 1, live: true, stream: false, protocol: 'openai', running: false,
    status: 'not_run', accountVerified: false, models: [], checks: [] }
  if (inFlight || oauthManager.isInAppLoginOpen()) return { ...report, status: 'login_busy' }
  inFlight = true
  try {
    const config = storeManager.getConfig()
    const state = { isRunning: proxyServer.isRunning(), port: proxyStatusManager.getPort(), host: proxyStatusManager.getHost() }
    report = { ...report, running: state.isRunning, port: state.port }
    if (!state.isRunning) return { ...report, status: 'proxy_not_running' }
    if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) return { ...report, status: 'invalid_running_port' }
    const hostname = ['0.0.0.0', '::', '[::]', 'localhost', '127.0.0.1'].includes(state.host) ? '127.0.0.1'
      : ['::1', '[::1]'].includes(state.host) ? '::1' : undefined
    if (!hostname) return { ...report, status: 'non_loopback_bind_not_probed' }
    const key = config.apiKeys?.find(item => item.enabled && typeof item.key === 'string' && item.key)?.key
    if (config.enableApiKey && !key) return { ...report, status: 'no_enabled_gateway_api_key' }
    const headers: Record<string, string> = config.enableApiKey ? { Authorization: `Bearer ${key}` } : {}
    const local = { hostname, port: state.port }
    const provider = storeManager.getProviderById('arena')
    if (!provider?.enabled) return { ...report, status: 'provider_not_enabled' }
    // An explicit login probe can inspect a paused account without enabling it,
    // but a live generation probe must use the same scheduling policy as routing.
    const accounts = AccountManager.getByProviderId('arena', true)
    const account = accounts.find(candidate => accountAvailability(candidate).available)
    if (!account) return { ...report, status: accounts.length ? 'no_available_account' : 'login_required' }
    const credentials = arenaProfileCredentials(account.credentials)
    const status = await arenaBrowserManager.status(credentials.browserProfileId)
    if (!status.authenticated) return { ...report, status: status.errorCode === 'route_changed' ? 'route_changed' : 'action_required' }
    const catalog = await syncArenaProviderModels(credentials.browserProfileId)
    report = { ...report, accountVerified: true, models: catalog.supportedModels }
    const health = await requestLoopback({ ...local, path: '/health', headers: {} })
    if (health.status !== 200 || object(health.text)?.status !== 'running') return { ...report, status: 'health_check_failed' }
    const models = await requestLoopback({ ...local, path: '/v1/models', headers })
    const advertised = object(models.text)?.data
    if (models.status !== 200 || !Array.isArray(advertised)) return { ...report, status: 'model_catalogue_failed' }
    const select = (modality: 'text' | 'image') => catalog.supportedModels.find(model => model.startsWith(`arena/${modality}/`)
      && advertised.some(item => item?.id === model && item.owned_by === provider.name)
      && (!config.modelMappings?.[model]?.preferredProviderId || config.modelMappings[model].preferredProviderId === 'arena'))
    const textModel = select('text'), imageModel = select('image')
    if (!textModel || !imageModel) return { ...report, status: 'no_advertised_text_and_image_models' }
    const marker = `ARENA_SMOKE_${randomUUID().replace(/-/g, '')}`, clientId = `arena-probe-${randomUUID()}`
    let sessionId: string | undefined
    for (const turn of [1, 2]) {
      const prompt = turn === 1 ? `请记住这个验证字符串，并且只回复该字符串：${marker}` : '只回复上一轮让我记住的验证字符串，不要解释。'
      const response = await requestLoopback({ ...local, path: '/v1/chat/completions',
        headers: { ...headers, 'X-Chat2API-Client-ID': clientId,
          ...(turn === 1 ? { 'X-Chat2API-New-Conversation': 'true' } : { 'X-Chat2API-Session-ID': sessionId! }) },
        body: { model: textModel, stream: false, max_tokens: 96, messages: [{ role: 'user', content: prompt }] } })
      const reply = textReply(response, marker), returnedId = response.headers['x-chat2api-session-id']
      const validId = typeof returnedId === 'string' && /^c2a-[a-f0-9-]{36}$/.test(returnedId)
      const continued = turn === 2 && validId && returnedId === sessionId && response.headers['x-chat2api-conversation'] === 'continued'
      const continuity = turn === 1 ? validId && response.headers['x-chat2api-conversation'] === 'new' : continued
      report = { ...report, checks: [...report.checks, { stage: turn === 1 ? 'text_first' : 'text_continuation', model: textModel,
        httpStatus: response.status, ...reply, ...(turn === 2 ? { continued } : {}),
        ...(!reply.completed ? { error: errorCategory(response) } : !reply.replyMatches ? { error: 'unexpected_reply' } : !continuity ? { error: 'missing_continuation' } : {}) }] }
      if (!reply.completed || !reply.replyMatches || !continuity) return { ...report, status: failureStatus(response, 'text_check_failed') }
      sessionId = returnedId as string
    }
    const image = await requestLoopback({ ...local, path: '/v1/images/generations', headers, maxResponseBytes: 48 * 1024 * 1024,
      body: { model: imageModel, prompt: 'A simple blue circle centered on a plain white background. No text.', n: 1, response_format: 'url' } })
    let imageReturned = false
    if (image.status === 200) { try { arenaImageUrl(object(image.text)?.data?.[0]?.url); imageReturned = true } catch { /* Untrusted or incomplete image output is not a passing test. */ } }
    report = { ...report, checks: [...report.checks, { stage: 'image', model: imageModel, httpStatus: image.status, completed: imageReturned, imageReturned,
      ...(!imageReturned ? { error: errorCategory(image) } : {}) }] }
    return { ...report, status: imageReturned ? 'passed' : failureStatus(image, 'image_check_failed') }
  } catch (error) {
    return { ...report, status: error instanceof ArenaError && ['route_changed', 'rate_limited', 'quota_unavailable'].includes(error.code) ? error.code : 'request_failed_not_retried' }
  } finally { inFlight = false }
}
