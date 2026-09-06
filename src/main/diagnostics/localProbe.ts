/**
 * Opt-in, app-owned diagnostic against the already-running local proxy.
 * No profile files are opened, configuration is changed, credentials are exported,
 * or failed generations retried. Only DeepSeek and GLM-family providers are in the live-test allowlist.
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { createVisionFixture } from './visionFixture.ts'
import { accountAvailability, summarizeAccountAvailability } from '../../shared/accountAvailability.ts'

export interface LocalProbeOptions {
  live?: boolean
  deepseekModel?: string
  providers?: Array<'deepseek' | 'glm' | 'zai'>
  protocol?: 'openai' | 'anthropic'
  stream?: boolean
  turns?: 1 | 2
}
export interface ProbeProviderResult {
  provider: 'deepseek' | 'glm' | 'zai'
  model?: string
  inputImage?: boolean
  activeAccounts: number
  scheduling?: ReturnType<typeof summarizeAccountAvailability>
  status: string
  checks: Array<{ turn: number; httpStatus?: number; completed: boolean; replyMatches: boolean; reply?: string; error?: string }>
}
export interface LocalProbeReport {
  version: 1
  live: boolean
  protocol: 'openai' | 'anthropic'
  stream: boolean
  running: boolean
  port?: number
  configuredPort?: number
  portMismatch: boolean
  status: string
  healthStatus?: number
  modelsStatus?: number
  providers: ProbeProviderResult[]
}
interface ProbeConfig {
  proxyPort?: number
  enableApiKey?: boolean
  apiKeys?: Array<{ enabled: boolean; key: string }>
  modelMappings?: Record<string, { preferredProviderId?: string }>
}
interface ProbeProvider { id: string; name: string; enabled: boolean }
export interface ProbeHttpResponse { status: number; headers: Record<string, string | string[] | undefined>; text: string }
export interface ProbeHttpRequest { hostname: string; port: number; path: string; headers: Record<string, string>; body?: unknown; maxResponseBytes?: number }
export interface LocalProbeDependencies {
  getConfig(): ProbeConfig
  getStatus(): { isRunning: boolean; port: number; host?: string }
  getProviders(): ProbeProvider[]
  getEffectiveModels(providerId: string): Array<{ displayName: string }>
  getActiveAccountCount(providerId: string): number
  getAccountScheduling?(providerId: string): ReturnType<typeof summarizeAccountAvailability>
  request?: (options: ProbeHttpRequest) => Promise<ProbeHttpResponse>
}
const MARKER = 'CHAT2API_SMOKE_OK'
const MAX_RESPONSE_BYTES = 1024 * 1024
let appProbeInFlight = false

/** Direct loopback HTTP deliberately avoids OS/env proxy routing for gateway credentials. */
export async function requestLoopback(options: ProbeHttpRequest): Promise<ProbeHttpResponse> {
  if (!['127.0.0.1', '::1'].includes(options.hostname)) throw new Error('non_loopback_target')
  const maxResponseBytes = options.maxResponseBytes === undefined ? MAX_RESPONSE_BYTES : options.maxResponseBytes
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 48 * 1024 * 1024) throw new Error('invalid_response_limit')
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const request = http.request({ hostname: options.hostname, port: options.port, path: options.path,
      method: payload ? 'POST' : 'GET', agent: false,
      headers: { ...options.headers, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}) },
    }, response => {
      let size = 0
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxResponseBytes) { response.destroy(); request.destroy(new Error('response_too_large')); return }
        chunks.push(chunk)
      })
      response.once('error', () => reject(new Error('connection_failed')))
      response.once('aborted', () => reject(new Error('stream_interrupted')))
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }))
    })
    const timer = setTimeout(() => request.destroy(new Error('request_timeout')), 180000)
    request.once('close', () => clearTimeout(timer))
    request.once('error', () => reject(new Error('connection_failed')))
    request.end(payload)
  })
}

function parseObject(text: string): Record<string, any> | undefined {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch { return undefined }
}

/** Keep arbitrary upstream output private; expose only the expected harmless marker. */
function safeErrorCategory(value: any): string | undefined {
  const message = value?.error?.message
  if (typeof message !== 'string') return undefined
  const match = /^Z\.ai upstream (captcha_required|verification_required|authentication_required|access_denied|model_unavailable|rate_limited|quota_exceeded|upstream_error|invalid_json|unexpected_json|incomplete_stream|transport_error)(?: \(code \d{1,6}\))?$/.exec(message)
  return match?.[1]
}

function inspectReply(response: ProbeHttpResponse, protocol: 'openai' | 'anthropic', stream: boolean, expectedReply = MARKER): { completed: boolean; replyMatches: boolean; text: string; errorCategory?: string } {
  if (response.status !== 200) return { completed: false, replyMatches: false, text: '', errorCategory: safeErrorCategory(parseObject(response.text)) }
  let text = '', completed = false
  let errorCategory: string | undefined
  if (!stream) {
    const value = parseObject(response.text)
    if (protocol === 'openai') {
      const choice = value?.choices?.[0]
      completed = choice?.message?.role === 'assistant' && ['stop', 'length'].includes(choice.finish_reason)
      if (typeof choice?.message?.content === 'string') text = choice.message.content
    } else {
      completed = value?.type === 'message' && value?.role === 'assistant' && ['end_turn', 'max_tokens'].includes(value.stop_reason)
      if (Array.isArray(value?.content)) text = value.content.filter((block: any) => block?.type === 'text' && typeof block.text === 'string').map((block: any) => block.text).join('')
    }
  } else {
    let finished = false, done = false, failed = false
    const normalized = response.text.replace(/\r\n/g, '\n')
    const frames = normalized.split('\n\n')
    if (frames.at(-1)?.trim()) failed = true
    for (const frame of frames) {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data) continue
      if (data === '[DONE]' && protocol === 'openai') { if (!finished) failed = true; done = true; continue }
      const value = parseObject(data)
      if (!value || value.error || value.type === 'error' || done) { failed = true; errorCategory ??= safeErrorCategory(value); continue }
      if (protocol === 'openai') {
        const choice = value.choices?.[0]
        if (typeof choice?.delta?.content === 'string') text += choice.delta.content
        if (choice?.finish_reason) {
          if (!['stop', 'length'].includes(choice.finish_reason)) failed = true
          finished = true
        }
      } else {
        if (value.type === 'content_block_delta' && value.delta?.type === 'text_delta' && typeof value.delta.text === 'string') text += value.delta.text
        if (value.type === 'message_delta' && value.delta?.stop_reason) {
          if (!['end_turn', 'max_tokens'].includes(value.delta.stop_reason)) failed = true
          finished = true
        }
        if (value.type === 'message_stop') { if (!finished) failed = true; done = true }
      }
    }
    completed = finished && done && !failed
  }
  return { completed, replyMatches: completed && text.trim() === expectedReply, text, errorCategory }
}

function validatedOptions(value: LocalProbeOptions): Required<LocalProbeOptions> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_probe_options')
  if (value.live !== undefined && typeof value.live !== 'boolean') throw new Error('invalid_probe_options')
  if (value.stream !== undefined && typeof value.stream !== 'boolean') throw new Error('invalid_probe_options')
  if (value.protocol !== undefined && !['openai', 'anthropic'].includes(value.protocol)) throw new Error('invalid_probe_options')
  if (value.turns !== undefined && ![1, 2].includes(value.turns)) throw new Error('invalid_probe_options')
  const providers = value.providers ?? ['deepseek', 'glm']
  if (value.deepseekModel !== undefined && (!['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'].includes(value.deepseekModel) || providers.length !== 1 || providers[0] !== 'deepseek' || value.protocol === 'anthropic')) throw new Error('invalid_probe_options')
  if (!Array.isArray(providers) || !providers.length || providers.length > 2 || providers.some(provider => !['deepseek', 'glm', 'zai'].includes(provider)) || new Set(providers).size !== providers.length) throw new Error('invalid_probe_options')
  return { live: value.live ?? false, deepseekModel: value.deepseekModel ?? '', providers, protocol: value.protocol ?? 'openai', stream: value.stream ?? false, turns: value.turns ?? 1 }
}

/** Dependency-injected entrypoint lets regression tests prove boundaries without a profile. */
export async function probeLocalApp(deps: LocalProbeDependencies, input: LocalProbeOptions = {}): Promise<LocalProbeReport> {
  const options = validatedOptions(input)
  const state = deps.getStatus()
  const config = deps.getConfig()
  const report: LocalProbeReport = { version: 1, live: options.live, protocol: options.protocol, stream: options.stream,
    running: state.isRunning, port: state.port, configuredPort: config.proxyPort,
    portMismatch: !!state.isRunning && state.port !== config.proxyPort, status: 'not_run', providers: [] }
  if (!state.isRunning) return { ...report, status: 'proxy_not_running' }
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) return { ...report, status: 'invalid_running_port' }
  const host = state.host ?? '127.0.0.1'
  const hostname = ['0.0.0.0', '::', '[::]', 'localhost', '127.0.0.1'].includes(host) ? '127.0.0.1'
    : ['::1', '[::1]'].includes(host) ? '::1' : undefined
  if (!hostname) return { ...report, status: 'non_loopback_bind_not_probed' }
  const headers: Record<string, string> = {}
  if (config.enableApiKey) {
    const key = config.apiKeys?.find(key => key.enabled && typeof key.key === 'string' && key.key)
    if (!key) return { ...report, status: 'no_enabled_gateway_api_key' }
    headers.Authorization = `Bearer ${key.key}`
  }
  const request = deps.request ?? requestLoopback
  try {
    const health = await request({ hostname, port: state.port, path: '/health', headers: {} })
    report.healthStatus = health.status
    if (health.status !== 200 || parseObject(health.text)?.status !== 'running') return { ...report, status: 'health_check_failed' }
    const modelsResponse = await request({ hostname, port: state.port, path: '/v1/models', headers })
    report.modelsStatus = modelsResponse.status
    const advertised = parseObject(modelsResponse.text)?.data
    if (modelsResponse.status !== 200 || !Array.isArray(advertised)) return { ...report, status: 'model_catalogue_failed' }
    const providers = deps.getProviders().filter(provider => provider.enabled)
    const available = providers.map(provider => ({ ...provider, activeAccounts: deps.getActiveAccountCount(provider.id), models: deps.getEffectiveModels(provider.id).map(model => model.displayName) }))
    const clientId = `local-probe-${randomUUID()}`
    for (const requestedProviderId of options.providers) {
      // "GLM" can mean Qingyan or Z.ai in the UI. Prefer a logged-in family
      // member rather than incorrectly reporting no account for the other site.
      const providerId = requestedProviderId === 'glm' && !available.some(provider => provider.id === 'glm' && provider.activeAccounts)
        && available.some(provider => provider.id === 'zai' && provider.activeAccounts) ? 'zai' : requestedProviderId
      const provider = available.find(provider => provider.id === providerId)
      const item: ProbeProviderResult = { provider: providerId, activeAccounts: provider?.activeAccounts ?? 0, status: 'not_run', checks: [] }
      if (deps.getAccountScheduling) item.scheduling = deps.getAccountScheduling(providerId)
      report.providers = [...report.providers, item]
      if (!provider || !provider.activeAccounts) { item.status = 'no_active_account'; continue }
      const model = provider.models.find(model => (!options.deepseekModel || model === options.deepseekModel) && !model.includes('*') && advertised.some(entry => entry?.id === model && entry.owned_by === provider.name) &&
        (!config.modelMappings?.[model]?.preferredProviderId || config.modelMappings[model].preferredProviderId === providerId) &&
        available.filter(candidate => candidate.activeAccounts && candidate.models.includes(model)).every(candidate => candidate.id === providerId))
      if (!model) { item.status = 'no_unambiguous_advertised_model'; continue }
      item.model = model
      if (!options.live) { item.status = 'ready'; continue }
      const vision = model === 'deepseek-v4-flash-vision-exp' ? createVisionFixture() : undefined
      const expectedReply = vision?.expected ?? MARKER
      if (vision) item.inputImage = true
      let sessionId: string | undefined
      let previousReply = ''
      for (let turn = 1; turn <= options.turns; turn++) {
        const prompt = turn === 1 ? (vision ? '读出图片中间的四位数字。只回复这四位数字，不要解释。' : `请只回复：${MARKER}`) : '请只回复你在上一轮回复的验证字符串。'
        // Explicit returned gateway ID keeps followup input-only. Never import a website ID.
        const messages = [{ role: 'user', content: vision && turn === 1 ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: vision.dataUrl } }] : prompt }]
        const body = { model, messages, stream: options.stream, max_tokens: 96 }
        if (turn > 1 && (!sessionId || previousReply.trim() !== expectedReply)) break
        try {
          const response = await request({ hostname, port: state.port,
            path: options.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions',
            headers: { ...headers, 'X-Chat2API-Client-ID': clientId,
              ...(turn === 1 ? { 'X-Chat2API-New-Conversation': 'true' } : { 'X-Chat2API-Session-ID': sessionId! }),
              ...(options.protocol === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}),
            }, body })
          const result = inspectReply(response, options.protocol, options.stream, expectedReply)
          item.checks = [...item.checks, { turn, httpStatus: response.status, completed: result.completed, replyMatches: result.replyMatches,
            ...(result.replyMatches ? { reply: expectedReply } : { error: result.errorCategory ?? (response.status !== 200 ? `http_${response.status}` : result.completed ? 'unexpected_reply' : 'incomplete_response') }) }]
          if (!result.completed || !result.replyMatches) { item.status = 'failed'; break }
          const sessionHeader = response.headers['x-chat2api-session-id']
          sessionId = typeof sessionHeader === 'string' && /^[a-zA-Z0-9_-]{1,256}$/.test(sessionHeader) ? sessionHeader : undefined
          previousReply = result.text
          if (turn < options.turns && !sessionId) { item.status = 'missing_continuation_id'; break }
          item.status = turn === options.turns ? 'passed' : 'running'
        } catch {
          // A failed submission may have executed remotely. Never retry or expose raw errors.
          item.checks = [...item.checks, { turn, completed: false, replyMatches: false, error: 'connection_failed_not_retried' }]
          item.status = 'failed'
          break
        }
      }
    }
    report.status = report.providers.every(item => item.status === (options.live ? 'passed' : 'ready')) ? (options.live ? 'passed' : 'ready') : 'needs_attention'
    return report
  } catch { return { ...report, status: 'local_probe_connection_failed' } }
}

/** Call only inside the existing initialized Electron app; never boot another profile. */
export async function runLocalProbe(options: LocalProbeOptions = {}): Promise<LocalProbeReport> {
  validatedOptions(options)
  if (appProbeInFlight) throw new Error('A local diagnostic is already running; no additional request was sent.')
  appProbeInFlight = true
  try {
    const [{ storeManager }, { proxyServer }, { proxyStatusManager }] = await Promise.all([import('../store/store'), import('../proxy/server'), import('../proxy/status')])
    return await probeLocalApp({ getConfig: () => storeManager.getConfig(),
      getStatus: () => ({ isRunning: proxyServer.isRunning(), port: proxyStatusManager.getPort(), host: proxyStatusManager.getHost() }),
      getProviders: () => storeManager.getProviders(), getEffectiveModels: id => storeManager.getEffectiveModels(id),
      getActiveAccountCount: id => storeManager.getAccountsByProviderId(id).filter(account => accountAvailability(account).available).length,
      getAccountScheduling: id => summarizeAccountAvailability(storeManager.getAccountsByProviderId(id)),
    }, options)
  } finally { appProbeInFlight = false }
}

/** Explicit opt-in only: one independent check for each requested website mode. */
export async function runDeepSeekModesProbe(): Promise<LocalProbeReport> {
  const reports: LocalProbeReport[] = []
  for (const deepseekModel of ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']) {
    reports.push(await runLocalProbe({ live: true, providers: ['deepseek'], deepseekModel }))
  }
  return { ...reports[0], providers: reports.flatMap(report => report.providers),
    status: reports.every(report => report.status === 'passed') ? 'passed' : 'needs_attention' }
}


