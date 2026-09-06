import { randomUUID } from 'node:crypto'
import { accountAvailability } from '../../shared/accountAvailability.ts'
import type { ToolCallingConfig, ToolClientAdapterId, ToolSmokeCategory } from '../../shared/toolCalling.ts'
import { normalizeToolCallingConfig } from '../../shared/toolCalling.ts'
import { requestLoopback, type ProbeHttpRequest, type ProbeHttpResponse } from './localProbe.ts'
import { getLatestToolCallingSmokeResult, setLatestToolCallingSmokeResult, type ToolCallingSmokeResult } from '../proxy/toolCalling/diagnostics.ts'

export interface ToolCallingSmokeInput { model?: string; providerId?: string; clientAdapterId?: ToolClientAdapterId }
export interface ToolCallingSmokeCheck { stage: 'tool_call' | 'tool_result'; success: boolean; httpStatus?: number }
export interface ToolCallingSmokeReport extends ToolCallingSmokeResult {
  model?: string
  failureCode?: string
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
  getProviders(): Array<{ id: string; name: string; enabled: boolean }>
  getEffectiveModels(providerId: string): Array<{ displayName: string }>
  getActiveAccountCount(providerId: string): number
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
  if (!selected) return fail('provider_or_account_error', 'no_available_model', '所选模型没有可用账号或存在供应商映射冲突，请先登录并启用账号。')
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
    const first = await request({ ...local, path: '/v1/chat/completions', headers: { ...headers, 'X-Chat2API-Client-ID': clientId, 'X-Chat2API-New-Conversation': 'true' },
      body: { ...common, messages: [{ role: 'user', content: `工具调用兼容性测试：先调用 ${TOOL_NAME}，唯一参数 nonce 为 ${nonce}。不要自行解释或猜测工具结果。收到工具结果后，只回复工具返回的字符串，不要再调用工具。` }] } })
    report = { ...report, checks: [{ stage: 'tool_call', success: false, httpStatus: first.status }] }
    if (first.status !== 200) return fail('provider_or_account_error', `first_http_${first.status}`, '第一轮模型请求失败；请检查账号、网络及供应商验证状态。没有自动重试。')
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
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) return fail('client_did_not_return_tool_result', 'missing_conversation_id', '第一轮缺少可继续的会话标识，无法验证工具结果回传。')
    const current = deps.getConfig()
    if (JSON.stringify({ toolCallingConfig: current.toolCallingConfig, modelMappings: current.modelMappings }) !== configIdentity) return fail('not_run', 'settings_changed', '测试期间工具设置或模型映射已改变，已停止后续请求；请重新测试。')
    // This constant is created after a validated tool call and is never in the
    // first prompt. It proves that the second reply consumed the tool result.
    const mockResult = `CHAT2API_TOOL_OK_${randomUUID().replace(/-/g, '')}`
    const second = await request({ ...local, path: '/v1/chat/completions', headers: { ...headers, 'X-Chat2API-Client-ID': clientId, 'X-Chat2API-Session-ID': sessionId },
      body: { ...common, messages: [{ role: 'tool', tool_call_id: call.id, content: mockResult }] } })
    report = { ...report, checks: [...report.checks, { stage: 'tool_result', success: false, httpStatus: second.status }] }
    if (second.status !== 200) return fail('provider_or_account_error', `second_http_${second.status}`, '工具调用已成功，但同一会话的工具结果回传请求失败。没有自动重试。')
    const secondChoice = parseObject(second.text)?.choices?.[0]
    if (secondChoice?.message?.role !== 'assistant' || secondChoice.finish_reason !== 'stop' || secondChoice.message.tool_calls?.length) return fail('client_did_not_return_tool_result', 'invalid_final_envelope', '工具调用已成功，但模型没有完成工具结果后的最终回复。')
    if (typeof secondChoice.message.content !== 'string' || secondChoice.message.content.trim() !== mockResult) return fail('client_did_not_return_tool_result', 'tool_result_not_consumed', '工具调用已成功，但最终回复没有准确使用本地测试结果。')
    return { ...report, success: true, category: 'pass', message: '两轮真实请求均通过：模型调用工具，本地返回无害测试结果，模型在同一会话正确回复。', checks: report.checks.map(check => ({ ...check, success: true })) }
  } catch {
    return fail('provider_or_account_error', 'connection_failed_not_retried', '测试连接中断或超时；请求可能已提交，未自动重试。请检查账号和网络状态。')
  }
}

async function appDependencies(): Promise<ToolCallingSmokeDependencies> {
  const [{ storeManager }, { proxyServer }, { proxyStatusManager }] = await Promise.all([import('../store/store'), import('../proxy/server'), import('../proxy/status')])
  return { getConfig: () => storeManager.getConfig(), getStatus: () => ({ isRunning: proxyServer.isRunning(), port: proxyStatusManager.getPort(), host: proxyStatusManager.getHost() }),
    getProviders: () => storeManager.getProviders(), getEffectiveModels: id => storeManager.getEffectiveModels(id),
    getActiveAccountCount: id => storeManager.getAccountsByProviderId(id).filter(account => accountAvailability(account).available).length }
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
