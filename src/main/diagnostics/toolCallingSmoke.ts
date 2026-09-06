import { randomUUID } from 'node:crypto'
import { accountAvailability, summarizeAccountAvailability } from '../../shared/accountAvailability.ts'
import type { ToolCallingConfig, ToolClientAdapterId, ToolSmokeCategory } from '../../shared/toolCalling.ts'
import { normalizeToolCallingConfig } from '../../shared/toolCalling.ts'
import { requestLoopback, type ProbeHttpRequest, type ProbeHttpResponse } from './localProbe.ts'
import { getLatestToolCallingSmokeResult, setLatestToolCallingSmokeResult, type ToolCallingSmokeResult } from '../proxy/toolCalling/diagnostics.ts'

export interface ToolCallingSmokeInput { model?: string; providerId?: string; clientAdapterId?: ToolClientAdapterId }
export interface ToolCallingSmokeCheck { stage: 'tool_call' | 'tool_result'; success: boolean; httpStatus?: number }
export interface ToolCallingSmokeReport extends ToolCallingSmokeResult {
  model?: string
  failureCode?: string
  upstreamCategory?: string
  retryAt?: number
  checks: ToolCallingSmokeCheck[]
}
interface SmokeConfig {
  toolCallingConfig?: ToolCallingConfig
  enableApiKey?: boolean
  apiKeys?: Array<{ enabled: boolean; key: string }>
  modelMappings?: Record<string, { preferredProviderId?: string }>
}
export interface ToolCallingSmokeDependencies {
  getConfig(): SmokeConfig
  getStatus(): { isRunning: boolean; port: number; host?: string }
  getProviders(): Array<{ id: string; name: string; enabled: boolean; type?: string }>
  getEffectiveModels(providerId: string): Array<{ displayName: string }>
  getActiveAccountCount(providerId: string): number
  getAccountScheduling?(providerId: string): ReturnType<typeof summarizeAccountAvailability>
  request?: (options: ProbeHttpRequest) => Promise<ProbeHttpResponse>
}
export interface ToolCallingSmokeModel { model: string; providerId: string; providerName: string }
let inFlight = false
const TOOL_NAME = 'chat2api_smoke_echo'
const CLIENTS = ['standard-openai-tools', 'cherry-studio-mcp']

export function validateToolCallingSmokeInput(value: unknown): ToolCallingSmokeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tool test options')
  if (Object.keys(value).some(key => !['model', 'providerId', 'clientAdapterId'].includes(key))) throw new Error('Invalid tool test options')
  const options = value as Record<string, unknown>
  for (const key of ['model', 'providerId', 'clientAdapterId'] as const) {
    const item = options[key]
    if (item !== undefined && (typeof item !== 'string' || !item.trim() || item.length > 256)) throw new Error('Invalid tool test options')
  }
  if (options.clientAdapterId !== undefined && !CLIENTS.includes(options.clientAdapterId as string)) throw new Error('Invalid tool test client adapter')
  return value as ToolCallingSmokeInput
}

function availableModels(deps: ToolCallingSmokeDependencies): ToolCallingSmokeModel[] {
  const config = deps.getConfig()
  const candidates = deps.getProviders().filter(provider => provider.enabled && deps.getActiveAccountCount(provider.id) > 0)
    .flatMap(provider => deps.getEffectiveModels(provider.id).filter(item => item.displayName && !item.displayName.includes('*') && !item.displayName.startsWith('arena/image/')).map(item => ({ model: item.displayName, providerId: provider.id, providerName: provider.name })))
  return candidates.filter(item => {
    const preferred = config.modelMappings?.[item.model]?.preferredProviderId
    return preferred ? preferred === item.providerId : candidates.filter(other => other.model === item.model).every(other => other.providerId === item.providerId)
  }).sort((left, right) => Number(right.providerId === 'deepseek' && right.model === 'deepseek-v4-flash') - Number(left.providerId === 'deepseek' && left.model === 'deepseek-v4-flash'))
}

function parseObject(text: string): Record<string, any> | undefined {
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined }
  catch { return undefined }
}

const UPSTREAM_MESSAGES: Record<string, string> = {
  captcha_required: '供应商要求完成验证码；请在该账号的登录窗口完成验证后再测试。',
  verification_required: '供应商要求完成浏览器验证；请打开该账号的登录窗口处理后再测试。',
  action_required: '供应商要求登录或验证；请在该账号的登录窗口处理后再测试。',
  authentication_required: '账号登录已失效或 API 密钥无效；请重新登录或更新密钥。',
  access_denied: '供应商拒绝了当前账号的访问；请先在官网检查账号状态。',
  account_cooling_down: '账号处于临时封禁或冷却期；到期前不会继续提交测试。',
  account_unavailable: '当前没有可用账号；请检查账号启用状态、登录状态及使用额度。',
  account_banned: '供应商已停用该账号；请先在官网处理账号限制。',
  rate_limited: '账号或模型触发调用频率限制；请等待额度恢复后再测试。',
  quota_exceeded: '账号额度已用尽；请等待额度恢复或检查供应商用量。',
  model_unavailable: '供应商当前不提供此模型；请刷新模型列表并选择可用模型。',
  browser_unavailable: '账号浏览器未就绪；请打开该账号的登录窗口后再测试。',
  incomplete_response: '供应商没有返回完整回复；本次未重试，工具能力尚未验证。',
  transport_error: '供应商连接中断；本次未重试，工具能力尚未验证。',
  upstream_error: '供应商请求失败；请先确认普通对话能够正常回复。',
}

/** Only allowlisted machine codes/status are public; never copy remote exception prose. */
function upstreamFailure(response: ProbeHttpResponse, report: ToolCallingSmokeReport, stage: 'first' | 'second'): ToolCallingSmokeReport {
  const code = parseObject(response.text)?.error?.code
  const aliases: Record<string, string> = { account_temporarily_suspended: 'account_cooling_down', account_daily_limit: 'quota_exceeded',
    model_rate_limited: 'rate_limited', no_available_account: 'account_unavailable', model_not_available: 'model_unavailable',
    invalid_json: 'incomplete_response', unexpected_json: 'incomplete_response', incomplete_stream: 'incomplete_response' }
  const typed = typeof code === 'string' && (Object.hasOwn(aliases, code) ? aliases[code] : Object.hasOwn(UPSTREAM_MESSAGES, code) ? code : undefined)
  const category = typed || ({ 401: 'authentication_required', 403: 'access_denied', 429: 'rate_limited' } as Record<number, string>)[response.status] || 'upstream_error'
  const retry = response.headers['retry-after']
  const seconds = typeof retry === 'string' && /^\d{1,10}$/.test(retry) ? Number(retry) : undefined
  return { ...report, success: false, category: 'provider_or_account_error', failureCode: `${stage}_http_${response.status}`,
    upstreamCategory: category, ...(seconds !== undefined && seconds > 0 ? { retryAt: Date.now() + seconds * 1000 } : {}),
    message: `${stage === 'second' ? '工具调用已成功，但结果回传受阻。' : '工具能力尚未验证。'}${UPSTREAM_MESSAGES[category]}没有自动重试。` }
}

/** Runs only two bounded proxy generations; the one allowed tool is a local constant-result fixture. */
export async function probeToolCalling(deps: ToolCallingSmokeDependencies, input: ToolCallingSmokeInput = {}): Promise<ToolCallingSmokeReport> {
  validateToolCallingSmokeInput(input)
  const initial = deps.getConfig()
  const config = normalizeToolCallingConfig(initial.toolCallingConfig)
  const configIdentity = JSON.stringify({ toolCallingConfig: initial.toolCallingConfig, modelMappings: initial.modelMappings })
  const initialReport: ToolCallingSmokeReport = { success: false, category: 'not_run', message: '尚未运行工具调用测试。',
    clientAdapterId: config.clientAdapterId, timestamp: Date.now(), checks: [] }
  let report = initialReport
  const fail = (category: ToolSmokeCategory, failureCode: string, message: string): ToolCallingSmokeReport => ({ ...report, success: false, category, failureCode, message })
  if (!config.enabled || config.mode === 'off') return fail('no_tools_received', 'tool_calling_disabled', '请先启用并保存工具调用设置，然后重新测试。')
  if (input.clientAdapterId && input.clientAdapterId !== config.clientAdapterId) return fail('not_run', 'unsaved_client_adapter', '客户端适配器尚未保存；请先保存设置，测试不会临时更改配置。')
  const selected = availableModels(deps).find(item => (!input.model || item.model === input.model) && (!input.providerId || item.providerId === input.providerId))
  if (!selected) {
    const scheduling = deps.getProviders().filter(provider => provider.enabled && (!input.providerId || provider.id === input.providerId))
      .map(provider => deps.getAccountScheduling?.(provider.id)).filter(item => item !== undefined)
    const cooling = scheduling.some(item => item.coolingDown > 0)
    const deadlines = scheduling.flatMap(item => item.nextRecoveryAt ? [item.nextRecoveryAt] : [])
    return { ...fail('provider_or_account_error', 'no_available_model', cooling
      ? '可用账号处于临时封禁或冷却期，没有发送生成请求；请等待恢复后再测试。'
      : '所选模型没有可用账号或存在供应商映射冲突，请先登录并启用账号。'),
      upstreamCategory: cooling ? 'account_cooling_down' : 'account_unavailable',
      ...(cooling && deadlines.length ? { retryAt: Math.min(...deadlines) } : {}) }
  }
  const stateless = deps.getProviders().find(provider => provider.id === selected.providerId)?.type === 'custom'
  report = { ...report, model: selected.model, providerId: selected.providerId }
  const state = deps.getStatus()
  if (!state.isRunning || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535) return fail('provider_or_account_error', 'proxy_not_running', '本地服务尚未启动，请先启动服务再测试。')
  const hostname = ['0.0.0.0', '::', '[::]', 'localhost', '127.0.0.1'].includes(state.host ?? '127.0.0.1') ? '127.0.0.1'
    : ['::1', '[::1]'].includes(state.host!) ? '::1' : undefined
  if (!hostname) return fail('provider_or_account_error', 'non_loopback_bind', '测试仅通过本机回环地址连接，不向外部地址发送服务凭据。')
  const key = initial.apiKeys?.find(item => item.enabled && typeof item.key === 'string' && item.key)?.key
  if (initial.enableApiKey && !key) return fail('provider_or_account_error', 'no_gateway_key', '服务开启了密钥验证，但没有启用的 API 密钥。')
  const headers: Record<string, string> = initial.enableApiKey ? { Authorization: `Bearer ${key}` } : {}
  const request = deps.request ?? requestLoopback
  const local = { hostname, port: state.port }
  try {
    const health = await request({ ...local, path: '/health', headers: {} })
    if (health.status !== 200 || parseObject(health.text)?.status !== 'running') return fail('provider_or_account_error', 'health_failed', '本地服务健康检查失败，请检查当前监听端口。')
    const catalogue = await request({ ...local, path: '/v1/models', headers })
    if (catalogue.status !== 200) return fail('provider_or_account_error', 'catalogue_failed', '无法读取本地服务模型列表，请检查 API 密钥和服务状态。')
    const advertised = parseObject(catalogue.text)?.data
    if (!Array.isArray(advertised) || !advertised.some(item => item?.id === selected.model && item?.owned_by === selected.providerName)) return fail('provider_or_account_error', 'model_not_advertised', '所选模型未在当前服务中公布；没有发送生成请求。')
    const nonce = randomUUID()
    const tools = [{ type: 'function', function: { name: TOOL_NAME, description: 'A harmless diagnostic echo. It has no file, network, shell or system capabilities.',
      parameters: { type: 'object', properties: { nonce: { type: 'string', enum: [nonce] } }, required: ['nonce'], additionalProperties: false } } }]
    const clientId = `tool-smoke-${randomUUID()}`
    const common = { model: selected.model, stream: false, max_tokens: 512, tools, tool_choice: 'auto' }
    const firstMessages = [{ role: 'user', content: `工具调用兼容性测试：先调用 ${TOOL_NAME}，唯一参数 nonce 为 ${nonce}。不要自行解释或猜测工具结果。收到工具结果后，只回复工具返回的字符串，不要再调用工具。` }]
    const first = await request({ ...local, path: '/v1/chat/completions', headers: { ...headers, 'X-Chat2API-Client-ID': clientId, 'X-Chat2API-New-Conversation': 'true' },
      body: { ...common, messages: firstMessages } })
    report = { ...report, checks: [{ stage: 'tool_call', success: false, httpStatus: first.status }] }
    if (first.status !== 200) return upstreamFailure(first, report, 'first')
    const firstChoice = parseObject(first.text)?.choices?.[0]
    const assistant = firstChoice?.message
    const calls = assistant?.tool_calls
    if (!Array.isArray(calls) || !calls.length) {
      const wrapper = typeof assistant?.content === 'string' && /CHAT2API|<tool_calls>|\[function_calls\]/.test(assistant.content)
      return fail(wrapper ? 'parser_failed' : 'model_did_not_call_tool', wrapper ? 'unparsed_tool_wrapper' : 'no_tool_call', wrapper ? '模型输出了工具标记，但没有解析成工具调用。' : '模型未返回工具调用，因此测试未通过。')
    }
    if (assistant.role !== 'assistant' || firstChoice.finish_reason !== 'tool_calls' || calls.length !== 1) return fail('parser_failed', 'invalid_tool_envelope', '第一轮工具调用结构或结束标记不正确，未执行任何工具。')
    const call = calls[0]
    if (call?.type !== 'function' || call?.function?.name !== TOOL_NAME) return fail('invalid_tool_name', 'unexpected_tool_name', '模型选择了测试允许范围外的工具，未执行该工具。')
    if (typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(call.id) || typeof call.function.arguments !== 'string') return fail('parser_failed', 'invalid_tool_identity', '工具调用缺少有效标识或 JSON 参数。')
    const args = parseObject(call.function.arguments)
    if (!args || Object.keys(args).length !== 1 || args.nonce !== nonce) return fail('parser_failed', 'invalid_tool_arguments', '工具参数没有完整保留本次测试值，未执行工具。')
    report = { ...report, checks: [{ stage: 'tool_call', success: true, httpStatus: first.status }] }
    const sessionId = first.headers['x-chat2api-session-id']
    if (!stateless && (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId))) return fail('client_did_not_return_tool_result', 'missing_conversation_id', '第一轮缺少可继续的会话标识，无法验证工具结果回传。')
    const current = deps.getConfig()
    if (JSON.stringify({ toolCallingConfig: current.toolCallingConfig, modelMappings: current.modelMappings }) !== configIdentity) return fail('not_run', 'settings_changed', '测试期间工具设置或模型映射已改变，已停止后续请求；请重新测试。')
    // This constant is created after a validated tool call and is never in the
    // first prompt. It proves that the second reply consumed the tool result.
    const mockResult = `CHAT2API_TOOL_OK_${randomUUID().replace(/-/g, '')}`
    const toolResult = { role: 'tool', tool_call_id: call.id, content: mockResult }
    // Website sessions retain prior messages; native APIs are stateless and must
    // receive the standard user -> assistant(tool_calls) -> tool history instead.
    const secondMessages = stateless ? [...firstMessages, { role: 'assistant', content: typeof assistant.content === 'string' ? assistant.content : null,
      tool_calls: [{ id: call.id, type: 'function', function: { name: TOOL_NAME, arguments: call.function.arguments } }] }, toolResult] : [toolResult]
    const second = await request({ ...local, path: '/v1/chat/completions', headers: { ...headers, 'X-Chat2API-Client-ID': clientId,
      ...(!stateless ? { 'X-Chat2API-Session-ID': sessionId as string } : {}) }, body: { ...common, messages: secondMessages } })
    report = { ...report, checks: [...report.checks, { stage: 'tool_result', success: false, httpStatus: second.status }] }
    if (second.status !== 200) return upstreamFailure(second, report, 'second')
    const secondChoice = parseObject(second.text)?.choices?.[0]
    if (secondChoice?.message?.role !== 'assistant' || secondChoice.finish_reason !== 'stop' || secondChoice.message.tool_calls?.length) return fail('client_did_not_return_tool_result', 'invalid_final_envelope', '工具调用已成功，但模型没有完成工具结果后的最终回复。')
    if (typeof secondChoice.message.content !== 'string' || secondChoice.message.content.trim() !== mockResult) return fail('client_did_not_return_tool_result', 'tool_result_not_consumed', '工具调用已成功，但最终回复没有准确使用本地测试结果。')
    return { ...report, success: true, category: 'pass', message: stateless
      ? '两轮真实请求均通过：模型原生调用工具，本地返回无害结果，并通过标准 API 历史正确完成回复。'
      : '两轮真实请求均通过：模型调用工具，本地返回无害测试结果，模型在同一会话正确回复。', checks: report.checks.map(check => ({ ...check, success: true })) }
  } catch {
    return fail('provider_or_account_error', 'connection_failed_not_retried', '测试连接中断或超时；请求可能已提交，未自动重试。请检查账号和网络状态。')
  }
}

async function appDependencies(): Promise<ToolCallingSmokeDependencies> {
  const [{ storeManager }, { proxyServer }, { proxyStatusManager }] = await Promise.all([import('../store/store'), import('../proxy/server'), import('../proxy/status')])
  return { getConfig: () => storeManager.getConfig(), getStatus: () => ({ isRunning: proxyServer.isRunning(), port: proxyStatusManager.getPort(), host: proxyStatusManager.getHost() }),
    getProviders: () => storeManager.getProviders(), getEffectiveModels: id => storeManager.getEffectiveModels(id),
    getActiveAccountCount: id => storeManager.getAccountsByProviderId(id).filter(account => accountAvailability(account).available).length,
    getAccountScheduling: id => summarizeAccountAvailability(storeManager.getAccountsByProviderId(id)) }
}

export async function getToolCallingSmokeStatus(): Promise<{ config: ToolCallingConfig; latestSmokeResult: ToolCallingSmokeResult; models: ToolCallingSmokeModel[] }> {
  const deps = await appDependencies()
  const config = normalizeToolCallingConfig(deps.getConfig().toolCallingConfig)
  return { config: { ...config, advanced: { promptPreviewEnabled: config.advanced.promptPreviewEnabled } }, latestSmokeResult: structuredClone(getLatestToolCallingSmokeResult()), models: availableModels(deps) }
}

export async function runToolCallingSmoke(input: ToolCallingSmokeInput = {}): Promise<ToolCallingSmokeReport> {
  validateToolCallingSmokeInput(input)
  if (inFlight) return { success: false, category: 'not_run', failureCode: 'already_running', message: '已有工具测试正在运行，没有发送额外请求。', clientAdapterId: input.clientAdapterId ?? 'standard-openai-tools', timestamp: Date.now(), checks: [] }
  inFlight = true
  try {
    const result = await probeToolCalling(await appDependencies(), input)
    setLatestToolCallingSmokeResult(result)
    return result
  } finally { inFlight = false }
}
