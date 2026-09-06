/**
 * Z.ai Adapter
 * Implements Z.ai (GLM International) API protocol
 */

import axios, { AxiosResponse } from 'axios'
import crypto from 'crypto'
import { PassThrough } from 'stream'
import { StringDecoder } from 'node:string_decoder'
import { createParser } from 'eventsource-parser'
import FormData from 'form-data'
import { Account, Provider } from '../../store/types'
import type { ConversationRequestOptions, ProviderConversationState } from '../conversationTypes'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { hasToolUse, parseToolUse, ToolCall } from '../promptToolUse'
import { parseToolCallsFromText } from '../utils/toolParser'
import { DEFAULT_ZAI_WEB_MODEL, isZaiThinkingRequired, resolveZaiWebModel } from './zai-model-options.ts'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'

const ZAI_API_BASE = 'https://chat.z.ai'

type ZaiFailureCategory = 'captcha_required' | 'verification_required' | 'authentication_required' | 'access_denied'
  | 'model_unavailable' | 'rate_limited' | 'quota_exceeded' | 'upstream_error' | 'invalid_json'
  | 'unexpected_json' | 'incomplete_stream' | 'transport_error'

export class ZaiUpstreamError extends Error {
  readonly category: ZaiFailureCategory
  readonly upstreamCode?: number
  constructor(category: ZaiFailureCategory, code?: number) {
    super(`Z.ai upstream ${category}${code !== undefined ? ` (code ${code})` : ''}`)
    this.name = 'ZaiUpstreamError'
    this.category = category
    this.upstreamCode = code
  }
}

/** Classify only known error fields in memory. Never expose arbitrary remote text. */
export function classifyZaiFailure(value: any, fallback: ZaiFailureCategory = 'upstream_error'): ZaiUpstreamError {
  if (value instanceof ZaiUpstreamError) return value
  let objects = [value].filter(item => item && typeof item === 'object' && !Array.isArray(item))
  for (let depth = 0; depth < 3 && objects.length < 16; depth++) {
    const children = objects.flatMap(item => [item.error, item.data, item.detail, item.details])
      .filter(item => item && typeof item === 'object' && !Array.isArray(item) && !objects.includes(item))
    objects = [...objects, ...children].slice(0, 16)
  }
  const code = objects.flatMap(item => [item.code, item.error_code, item.status_code, item.status])
    .find(item => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= 999999)
  const signals = [typeof value?.error === 'string' ? value.error.slice(0, 512) : '',
    ...objects.flatMap(item => ['message', 'msg', 'detail', 'reason', 'type', 'code'].map(key => typeof item[key] === 'string' ? item[key].slice(0, 512) : '')),
  ].join(' ').toLowerCase()
  let category = fallback
  if (/captcha|验证码|人机验证/.test(signals)) category = 'captcha_required'
  else if (/verif(?:y|ication)|security check|risk control|安全验证|环境异常/.test(signals)) category = 'verification_required'
  else if (/unauthori[sz]ed|unauthenticated|authentication|invalid.?token|token.?expired|login required|未登录|登录失效/.test(signals) || code === 401) category = 'authentication_required'
  else if (/rate.?limit|too many requests|频率|请求过多/.test(signals) || code === 429) category = 'rate_limited'
  else if (/quota|insufficient.?balance|credit.?exhaust|余额不足|配额/.test(signals)) category = 'quota_exceeded'
  else if (/model/.test(signals) && /not.?found|not.?available|not.?exist|unsupported|invalid|不可用|不存在/.test(signals)) category = 'model_unavailable'
  else if (/forbidden|access.?denied|permission|无权/.test(signals) || code === 403) category = 'access_denied'
  return new ZaiUpstreamError(category, code)
}

function hasZaiFailure(value: any, eventName?: string): boolean {
  return eventName === 'error' || !!value?.error || !!value?.data?.error || value?.type === 'error'
    || value?.success === false || value?.data?.success === false || value?.status === 'error' || value?.data?.status === 'error'
}

function logZaiFailure(error: ZaiUpstreamError): void {
  console.warn('[Z.ai] response_failure', { category: error.category, ...(error.upstreamCode !== undefined ? { code: error.upstreamCode } : {}) })
}

/** Capture at most 64 KiB, only until a real SSE event proves the response format. */
class ZaiResponseDiagnostics {
  private prefix = Buffer.alloc(0)
  private truncated = false
  private sawSse = false
  append(chunk: Buffer): void {
    if (this.sawSse) return
    const remaining = 64 * 1024 - this.prefix.length
    if (chunk.length > remaining) this.truncated = true
    if (remaining > 0) this.prefix = Buffer.concat([this.prefix, chunk.subarray(0, remaining)])
  }
  event(): void { this.sawSse = true; this.prefix = Buffer.alloc(0) }
  incomplete(): ZaiUpstreamError {
    if (!this.sawSse && !this.truncated && this.prefix.length) {
      try { return classifyZaiFailure(JSON.parse(this.prefix.toString('utf8')), 'unexpected_json') }
      catch { return new ZaiUpstreamError('incomplete_stream') }
    }
    return new ZaiUpstreamError('incomplete_stream')
  }
}

const X_FE_VERSION = 'prod-fe-1.1.93'
const ZAI_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN',
  'Cache-Control': 'no-cache',
  Origin: ZAI_API_BASE,
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': ZAI_USER_AGENT,
  'X-Region': 'domestic',
}

const SEARCH_CITATION_PATTERN = '【turn\\d+search\\d+】'
const SEARCH_CITATION_PARTIAL_START_PATTERN = '【turn\\d+search\\d+$'
const SEARCH_CITATION_PARTIAL_END_PATTERN = '^】'
const SEARCH_CITATION_LOOSE_PATTERN = '【[^】]*turn\\d+search\\d+[^】]*】'
const SEARCH_CITATION_BRACKET_START = '【'
const SEARCH_CITATION_BRACKET_END = '】'

function cleanSearchCitations(text: string): string {
  return text.replace(new RegExp(SEARCH_CITATION_PATTERN, 'g'), '')
}

function cleanSearchCitationsWithBuffer(text: string, buffer: { value: string }): string {
  const combined = buffer.value + text
  
  // First try to match complete citations
  let cleaned = combined.replace(new RegExp(SEARCH_CITATION_LOOSE_PATTERN, 'g'), '')
  
  // Check if there's an opening bracket at the end that might start a citation
  const lastOpenBracket = cleaned.lastIndexOf(SEARCH_CITATION_BRACKET_START)
  if (lastOpenBracket !== -1) {
    const afterBracket = cleaned.slice(lastOpenBracket)
    // Check if it looks like a citation pattern
    if (afterBracket.includes('turn') || afterBracket.includes('search')) {
      // Keep the partial citation in buffer
      buffer.value = afterBracket
      cleaned = cleaned.slice(0, lastOpenBracket)
    } else if (!afterBracket.includes(SEARCH_CITATION_BRACKET_END)) {
      // Opening bracket without closing, might be a citation
      buffer.value = afterBracket
      cleaned = cleaned.slice(0, lastOpenBracket)
    } else {
      buffer.value = ''
    }
  } else {
    buffer.value = ''
  }
  
  return cleaned
}

interface ZaiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest extends ConversationRequestOptions {
  model: string
  /** Original model name before mapping (used for feature detection like web search, thinking mode) */
  originalModel?: string
  messages: ZaiMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max' | boolean
  chatId?: string
  parentMessageId?: string
}

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

export class ZaiAdapter {
  private provider: Provider
  private account: Account
  private token: string | null = null

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getToken(): string {
    const credentials = this.account.credentials
    return credentials.token || credentials.accessToken || credentials.jwt || ''
  }

  private getCaptchaVerifyParam(): string | undefined {
    const credentials = this.account.credentials
    return credentials.captcha_verify_param || credentials.captchaVerifyParam || undefined
  }

  private async ensureToken(): Promise<string> {
    const token = this.getToken()
    if (token) {
      return token
    }
    throw new Error('Z.ai token not configured, please add token in account settings')
  }

  private extractLastUserMessage(messages: ZaiMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        const content = messages[i].content
        if (typeof content === 'string') {
          return content
        }
        if (Array.isArray(content)) {
          const textParts: string[] = []
          for (const part of content) {
            if (typeof part === 'object' && part !== null && part.type === 'text' && part.text) {
              textParts.push(part.text)
            }
          }
          if (textParts.length > 0) {
            return textParts.join('\n')
          }
        }
        return ''
      }
    }
    return ''
  }

  private extractUserIDFromToken(token: string): string {
    try {
      const parts = token.split('.')
      if (parts.length < 2) {
        return 'guest'
      }
      let payload = parts[1]
      const padding = payload.length % 4
      if (padding > 0) {
        payload += '='.repeat(4 - padding)
      }
      payload = payload.replace(/-/g, '+').replace(/_/g, '/')
      const decoded = Buffer.from(payload, 'base64').toString('utf8')
      const data = JSON.parse(decoded)
      return data.id || data.user_id || data.uid || data.sub || 'guest'
    } catch {
      return 'guest'
    }
  }

  private generateSignature(messageText: string, requestId: string, timestampMs: number, userId: string): string {
    const secret = 'key-@@@@)))()((9))-xxxx&&&%%%%%'
    const r = timestampMs
    const i = String(timestampMs)
    const e = `requestId,${requestId},timestamp,${timestampMs},user_id,${userId}`
    
    // a = message text UTF-8 bytes
    const a = Buffer.from(messageText, 'utf-8')
    // w = base64 encode of message text
    const w = a.toString('base64')
    // c = canonical string: metadata | base64_message | timestamp_string
    const canonicalString = `${e}|${w}|${i}`

    // E = window index (5 minute window)
    const windowIndex = Math.floor(r / (5 * 60 * 1000))
    
    // Layer1: A = HMAC(secret, window_index) -> hex string
    const derivedKeyHex = crypto.createHmac('sha256', secret).update(String(windowIndex)).digest('hex')
    
    // Layer2: k = HMAC(A_hex, canonical_string) -> hex string
    const signature = crypto.createHmac('sha256', derivedKeyHex).update(canonicalString).digest('hex')

    return signature
  }

  async createChat(model: string = DEFAULT_ZAI_WEB_MODEL, firstMessageContent: string = ''): Promise<{ chatId: string; messageId: string }> {
    const token = await this.ensureToken()
    const timestamp = Math.floor(Date.now() / 1000)
    const messageId = uuid()
    
    console.log('[Z.ai] Creating chat with model:', model)
    
    const requestBody = {
      chat: {
        id: '',
        title: '新聊天',
        models: [model],
        params: {},
        history: {
          messages: firstMessageContent ? {
            [messageId]: {
              id: messageId,
              parentId: null,
              childrenIds: [],
              role: 'user',
              content: firstMessageContent,
              timestamp,
              models: [model],
            },
          } : {},
          currentId: firstMessageContent ? messageId : '',
        },
        tags: [],
        flags: [],
        features: [
          {
            type: 'tool_selector',
            server: 'tool_selector_h',
            status: 'hidden',
          },
        ],
        mcp_servers: [],
        enable_thinking: true,
        auto_web_search: false,
        message_version: 1,
        extra: {},
        timestamp: Date.now(),
        type: 'default',
      },
    }
    
    const response = await axios.post(
      `${ZAI_API_BASE}/api/v1/chats/new`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...FAKE_HEADERS,
          'Cookie': `token=${token}`,
          Referer: `${ZAI_API_BASE}/`,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 && response.status !== 201) {
      console.error('[Z.ai] Create chat response status:', response.status)
      throw new Error(`Failed to create chat: HTTP ${response.status}`)
    }

    if (typeof response.data?.id !== 'string' || !response.data.id) {
      throw new Error('Failed to create Z.ai chat: no chat ID returned')
    }
    console.log('[Z.ai] Chat created')
    return { chatId: response.data.id, messageId }
  }

  async deleteChat(chatId: string): Promise<boolean> {
    try {
      const token = await this.ensureToken()
      
      const response = await axios.delete(
        `${ZAI_API_BASE}/api/v1/chats/${chatId}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
            Referer: `${ZAI_API_BASE}/`,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )

      console.log('[Z.ai] Chat deleted; status:', response.status)
      return response.status === 200 || response.status === 204
    } catch (error) {
      console.error('[Z.ai] Failed to delete chat; remote error details omitted')
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.ensureToken()
      
      console.log('[Z.ai] Deleting all chats...')
      
      const response = await axios.delete(
        `${ZAI_API_BASE}/api/v1/chats/`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
            Referer: `${ZAI_API_BASE}/`,
          },
          timeout: 30000,
          validateStatus: () => true,
        }
      )

      console.log('[Z.ai] Delete all chats response status:', response.status)
      
      if (response.status === 200 && response.data === true) {
        console.log('[Z.ai] All chats deleted successfully')
        return true
      }
      
      console.warn('[Z.ai] Delete all chats failed; status:', response.status)
      return false
    } catch (error) {
      console.error('[Z.ai] Failed to delete all chats; remote error details omitted')
      return false
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; chatId: string; requestId: string }> {
    const token = await this.ensureToken()
    if (request.messages.some(message => message.role === 'tool' && !message.tool_call_id)) {
      throw new Error('Z.ai tool results require tool_call_id')
    }
    const userId = this.extractUserIDFromToken(token)
    
    console.log('[Z.ai] chatCompletion called with request.model:', request.model)
    
    // Web IDs are not always the public Model API IDs (Flash is x-preview-l).
    const mappedModel = resolveZaiWebModel(request.model)
    
    console.log('[Z.ai] Original model:', request.model, '-> Mapped model:', mappedModel)
    
    // Extract system message and merge with user message
    const systemContent = request.messages
      .filter(msg => msg.role === 'system')
      .map(msg => typeof msg.content === 'string' ? msg.content : '')
      .filter(Boolean)
      .join('\n\n')
    const profile = () => getProviderToolProfile('zai')
    const textContent = (content: ZaiMessage['content']): string => typeof content === 'string'
      ? content : Array.isArray(content) ? content.filter(part => part?.type === 'text').map(part => part.text || '').join('\n') : ''
    const turnMessages = request.messages.filter(msg => msg.role !== 'system').map(msg => {
      if (msg.role === 'tool') {
        return { role: 'user' as const, content: profile().formatToolResult({
          toolCallId: msg.tool_call_id!, content: textContent(msg.content),
        }) }
      }
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        return { role: 'assistant' as const, content: profile().formatAssistantToolCalls(msg.tool_calls.map(call => ({
          id: call.id, name: call.function.name, arguments: call.function.arguments,
        }))) }
      }
      return { ...msg }
    })
    const firstUserIdx = turnMessages.findIndex(msg => msg.role === 'user')
    
    // If system prompt exists, prepend it to the first user message
    const processedMessages = turnMessages.map((msg, index) => {
      if (!systemContent || index !== firstUserIdx) return { ...msg }
      const originalContent = textContent(msg.content)
      return { ...msg, content: `${systemContent}\n\nUser: ${originalContent}` }
    })
    
    const signaturePrompt = this.extractLastUserMessage(processedMessages)
    
    const parentMessageId = request.conversation?.parentMessageId || null
    if (request.conversation && !parentMessageId) {
      throw new Error('Z.ai continuation is missing the previous assistant message ID; start a new conversation')
    }
    const chatResult = request.conversation
      ? { chatId: request.conversation.sessionId, messageId: uuid() }
      : await this.createChat(mappedModel, signaturePrompt)
    const { chatId, messageId } = chatResult
    request.onConversation?.({ sessionId: chatId, ...(parentMessageId ? { parentMessageId } : {}) })
    
    const requestId = uuid()
    const timestamp = Date.now()
    const signature = this.generateSignature(signaturePrompt, requestId, timestamp, userId)

    // Determine if thinking and web search should be enabled
    // Priority: explicit parameters > model name detection
    // Use originalModel for feature detection (preserves user's intent before mapping)
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    
    // GLM-5.3 and Flash do not support disabling thinking on the current website.
    let enableThinking = isZaiThinkingRequired(mappedModel) || request.reasoning_effort !== false
    let enableWebSearch = !!request.web_search
    
    // Auto-enable based on model name (if not explicitly set)
    if (!enableThinking && (modelLower.includes('think') || modelLower.includes('r1'))) {
      enableThinking = true
      console.log('[Z.ai] Thinking mode enabled (from model name)')
    }
    if (!enableWebSearch && modelLower.includes('search')) {
      enableWebSearch = true
      console.log('[Z.ai] Web search enabled (from model name)')
    }

    // Z.ai API uses auto_web_search for web search feature
    // web_search should always be false, use auto_web_search instead
    const features = {
      image_generation: false,
      web_search: false,
      auto_web_search: enableWebSearch,
      preview_mode: true,
      flags: [],
      vlm_tools_enable: false,
      vlm_web_search_enable: false,
      vlm_website_mode: false,
      enable_thinking: enableThinking,
    }

    const requestBody: Record<string, any> = {
      // The website protocol is SSE. Client non-streaming is aggregated below,
      // rather than asking for JSON and then accidentally parsing it as SSE.
      stream: true,
      model: mappedModel,
      messages: processedMessages,
      signature_prompt: signaturePrompt,
      params: {},
      extra: {},
      features,
      variables: {
        '{{USER_NAME}}': 'User',
        '{{USER_LOCATION}}': 'Unknown',
        '{{CURRENT_DATETIME}}': new Date().toISOString().replace('T', ' ').substring(0, 19),
        '{{CURRENT_DATE}}': new Date().toISOString().substring(0, 10),
        '{{CURRENT_TIME}}': new Date().toISOString().substring(11, 19),
        '{{CURRENT_WEEKDAY}}': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()],
        '{{CURRENT_TIMEZONE}}': 'Asia/Shanghai',
        '{{USER_LANGUAGE}}': 'zh-CN',
      },
      chat_id: chatId,
      id: requestId,
      current_user_message_id: messageId,
      current_user_message_parent_id: parentMessageId,
      background_tasks: {
        title_generation: true,
        tags_generation: true,
      },
    }

    const captchaVerifyParam = this.getCaptchaVerifyParam()
    if (captchaVerifyParam) {
      requestBody.captcha_verify_param = captchaVerifyParam
    }

    console.log('[Z.ai] Sending chat request...')
    console.log('[Z.ai] Model:', request.model)

    const queryParams = new URLSearchParams({
      timestamp: String(timestamp),
      requestId,
      user_id: userId,
      version: '0.0.1',
      platform: 'web',
      token,
      user_agent: ZAI_USER_AGENT,
      language: 'zh-CN',
      languages: 'zh-CN,zh',
      timezone: 'Asia/Shanghai',
      cookie_enabled: 'true',
      screen_width: '1512',
      screen_height: '982',
      screen_resolution: '1512x982',
      viewport_height: '945',
      viewport_width: '923',
      viewport_size: '923x945',
      color_depth: '30',
      pixel_ratio: '2',
      current_url: `${ZAI_API_BASE}/c/${chatId}`,
      pathname: `/c/${chatId}`,
      search: '',
      hash: '',
      host: 'chat.z.ai',
      hostname: 'chat.z.ai',
      protocol: 'https:',
      referrer: '',
      title: 'Z.ai - Advanced AI Chatbot & Agent powered by GLM-5.3-Flash',
      timezone_offset: '-480',
      local_time: new Date().toISOString(),
      utc_time: new Date().toUTCString(),
      is_mobile: 'false',
      is_touch: 'false',
      max_touch_points: '0',
      browser_name: 'Chrome',
      os_name: 'Mac OS',
      signature_timestamp: String(timestamp),
    })

    const response = await axios.post(
      `${ZAI_API_BASE}/api/v2/chat/completions?${queryParams.toString()}`,
      requestBody,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...FAKE_HEADERS,
          'X-Signature': signature,
          'X-FE-Version': X_FE_VERSION,
          'Cookie': `token=${token}`,
          Referer: `${ZAI_API_BASE}/c/${chatId}`,
          Priority: 'u=1, i',
        },
        responseType: 'stream',
        timeout: 120000,
        validateStatus: () => true,
      }
    )

    console.log('[Z.ai] Response status:', response.status)
    const contentType = String(response.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
    console.log('[Z.ai] Response content type:', ['application/json', 'text/event-stream'].includes(contentType) ? contentType : 'other')
    if (response.status !== 200) {
      console.log('[Z.ai] Remote request failed; request and authentication details omitted')
      // The HTTP status is sufficient to reject this request. Do not await an
      // error page's end event: it may already have ended, or may never finish.
      // It is neither a chat stream nor safe diagnostic text to log/forward.
      response.data?.destroy?.()
      return { response: { ...response, data: undefined }, chatId, requestId }
    }

    return { response, chatId, requestId }
  }

  static isZaiProvider(provider: Provider): boolean {
    return provider.id === 'zai' || provider.apiEndpoint.includes('z.ai') || provider.apiEndpoint.includes('chat.z.ai')
  }
}

export class ZaiStreamHandler {
  private onConversation?: (state: ProviderConversationState) => void
  private chatId: string = ''
  private model: string
  private created: number
  private onEnd?: (chatId: string) => void
  private content: string = ''
  private toolCallsSent: boolean = false
  private lastMessageId: string = ''
  private toolCallState: ToolCallState
  private sentRole: boolean = false
  private sentThinkingRole: boolean = false
  private streamEnded: boolean = false
  private citationBuffer: { value: string } = { value: '' }
  private thinkingCitationBuffer: { value: string } = { value: '' }

  constructor(model: string, onEnd?: (chatId: string) => void) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallState = createToolCallState()
  }

  setChatId(chatId: string) {
    this.chatId = chatId
  }

  setConversationListener(listener?: (state: ProviderConversationState) => void): void {
    this.onConversation = listener
  }

  private captureConversation(result: any): void {
    // Only the upstream assistant node is a valid next-turn parent. A user ID,
    // generated request ID, or top-level completion envelope ID is not.
    if (result?.role === 'assistant' && typeof result.id === 'string' && result.id) {
      this.lastMessageId = result.id
      if (this.chatId) {
        this.onConversation?.({ sessionId: this.chatId, parentMessageId: this.lastMessageId })
      }
    }
  }

  getLastMessageId(): string {
    return this.lastMessageId
  }

  private sendToolCalls(transStream: PassThrough): void {
    if (this.toolCallsSent) return
    
    const toolCalls = parseToolUse(this.content)
    if (toolCalls && toolCalls.length > 0) {
      this.toolCallsSent = true
      
      // Send tool_calls delta
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        transStream.write(
          `data: ${JSON.stringify({
            id: this.chatId,
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: i,
                  id: tc.id,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments,
                  },
                }],
              },
              finish_reason: null,
            }],
            created: this.created,
          })}\n\n`
        )
      }
      
      // Send finish with tool_calls
      transStream.write(
        `data: ${JSON.stringify({
          id: this.chatId,
          model: this.model,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })}\n\n`
      )
      transStream.end('data: [DONE]\n\n')
      if (this.onEnd) {
        try {
          this.onEnd(this.chatId)
        } catch (e) {
          console.error('[Z.ai] onEnd callback failed; error details omitted')
        }
      }
    }
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    transStream.once('close', () => {
      if (!transStream.writableEnded && typeof stream.destroy === 'function') stream.destroy()
    })

    console.log('[Z.ai] Starting stream handler...')
    
    let streamEnded = false
    const diagnostics = new ZaiResponseDiagnostics()
    const decoder = new StringDecoder('utf8')

    const safeEnd = (data?: string) => {
      if (streamEnded) return
      streamEnded = true
      if (data) {
        transStream.end(data)
      } else {
        transStream.end()
      }
    }
    const fail = (error: unknown) => {
      if (streamEnded) return
      streamEnded = true
      const safeError = classifyZaiFailure(error, 'transport_error')
      logZaiFailure(safeError)
      transStream.destroy(safeError)
    }

    const parser = createParser({
      onEvent: (event: any) => {
        if (streamEnded) return
        diagnostics.event()
        try {
          if (event.data === '[DONE]') return

          const data = JSON.parse(event.data)
          if (hasZaiFailure(data, event.event)) {
            fail(classifyZaiFailure(data))
            return
          }
          
          if (data.type !== 'chat:completion') return
          
          const result = data.data
          if (!result) return

          this.captureConversation(result)

          if (result.phase === 'thinking' && result.delta_content) {
            const cleanedContent = cleanSearchCitationsWithBuffer(result.delta_content, this.thinkingCitationBuffer)
            if (!cleanedContent) return
            // Output thinking content as reasoning_content
            if (!this.sentThinkingRole) {
              transStream.write(
                `data: ${JSON.stringify({
                  id: this.chatId,
                  model: this.model,
                  object: 'chat.completion.chunk',
                  choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '' }, finish_reason: null }],
                  created: this.created,
                })}\n\n`
              )
              this.sentThinkingRole = true
            }
            transStream.write(
              `data: ${JSON.stringify({
                id: this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { reasoning_content: cleanedContent }, finish_reason: null }],
                created: this.created,
              })}\n\n`
            )
          } else if (result.phase === 'answer' && result.delta_content) {
            const cleanedContent = cleanSearchCitationsWithBuffer(result.delta_content, this.citationBuffer)
            if (!cleanedContent) return
            this.content += cleanedContent
            
            // Process tool call interception
            const baseChunk = createBaseChunk(this.chatId, this.model, this.created)
            const { chunks: outputChunks } = processStreamContent(
              cleanedContent, 
              this.toolCallState, 
              baseChunk, 
              !this.sentRole && !this.sentThinkingRole,
              'zai'
            )

            for (const outChunk of outputChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }

            if (outputChunks.length > 0) this.sentRole = true
          } else if (result.phase === 'done' && result.done) {
            console.log('[Z.ai] Stream finished, content length:', this.content.length)
            
            // Flush any remaining tool calls
            const baseChunk = createBaseChunk(this.chatId, this.model, this.created)
            const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'zai')
            
            for (const outChunk of flushChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }
            
            // Check if we emitted tool calls
            const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'
            
            const usage = result.usage || { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            
            transStream.write(
              `data: ${JSON.stringify({
                id: this.chatId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                usage,
                created: this.created,
              })}\n\n`
            )
            safeEnd('data: [DONE]\n\n')
            if (this.onEnd) {
              try {
                this.onEnd(this.chatId)
              } catch (e) {
                console.error('[Z.ai] onEnd callback failed; error details omitted')
              }
            }
          }
        } catch (err) {
          console.error('[Z.ai] Stream parse failed; remote content omitted')
          fail(new ZaiUpstreamError('invalid_json'))
        }
      },
    })

    stream.on('data', (buffer: Buffer) => {
      if (streamEnded) return
      diagnostics.append(buffer)
      parser.feed(decoder.write(buffer))
    })
    stream.once('error', (err: Error) => {
      console.error('[Z.ai] Stream failed; remote error details omitted')
      fail(classifyZaiFailure(err, 'transport_error'))
    })
    stream.once('close', () => {
      console.log('[Z.ai] Stream closed')
      fail(diagnostics.incomplete())
    })
    stream.once('end', () => { parser.feed(decoder.end()); fail(diagnostics.incomplete()) })

    return transStream
  }

  async handleNonStream(response: any): Promise<any> {
    console.log('[Z.ai] Starting non-stream handler...')
    
    return new Promise((resolve, reject) => {
      const data = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '', reasoning_content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      let resolved = false
      let reasoningContent = ''
      const resolveOnce = (result: any) => {
        if (resolved) return
        resolved = true
        clearTimeout(timeout)
        if (reasoningContent) {
          result.choices[0].message.reasoning_content = reasoningContent
        }
        resolve(result)
      }

      const rejectOnce = (err: Error) => {
        if (resolved) return
        resolved = true
        clearTimeout(timeout)
        const safeError = classifyZaiFailure(err, 'transport_error')
        logZaiFailure(safeError)
        reject(safeError)
        if (typeof response?.destroy === 'function') response.destroy()
      }

      const timeout = setTimeout(() => {
        if (!resolved) {
          rejectOnce(new ZaiUpstreamError('incomplete_stream'))
        }
      }, 60000)

      // Parameter is already response.data from forwarder.ts
      const streamData = response

      // Check if streamData is a stream or JSON
      console.log('[Z.ai] Non-stream: streamData type:', typeof streamData)
      console.log('[Z.ai] Non-stream: streamData.on type:', typeof streamData?.on)
      console.log('[Z.ai] Non-stream: streamData is function?', typeof streamData?.on === 'function')
      if (streamData && typeof streamData.on === 'function') {
        console.log('[Z.ai] Non-stream: taking stream path')
        // Stream response - use buffers for citation cleaning
        const thinkingBuffer = { value: '' }
        const answerBuffer = { value: '' }
        const diagnostics = new ZaiResponseDiagnostics()
        const decoder = new StringDecoder('utf8')
        const parser = createParser({
          onEvent: (event: any) => {
            if (resolved) return
            diagnostics.event()
            try {
              if (event.data === '[DONE]') return

              const eventData = JSON.parse(event.data)
              if (hasZaiFailure(eventData, event.event)) {
                rejectOnce(classifyZaiFailure(eventData))
                return
              }
              
              if (eventData.type !== 'chat:completion') return
              
              const result = eventData.data
              if (!result) return
              this.captureConversation(result)
              data.id = this.lastMessageId || this.chatId

              if (result.phase === 'thinking' && result.delta_content) {
                reasoningContent += cleanSearchCitationsWithBuffer(result.delta_content, thinkingBuffer)
              } else if (result.phase === 'answer' && result.delta_content) {
                data.choices[0].message.content += cleanSearchCitationsWithBuffer(result.delta_content, answerBuffer)
              } else if (result.phase === 'done' && result.done) {
                console.log('[Z.ai] Non-stream finished, content length:', data.choices[0].message.content.length)
                if (result.usage) {
                  data.usage = result.usage
                }
                resolveOnce(data)
              }
            } catch (err) {
              console.error('[Z.ai] Non-stream parse failed; remote content omitted')
              rejectOnce(new ZaiUpstreamError('invalid_json'))
            }
          },
        })

        streamData.on('data', (buffer: Buffer) => { if (!resolved) { diagnostics.append(buffer); parser.feed(decoder.write(buffer)) } })
        streamData.once('error', rejectOnce)
        streamData.once('close', () => {
          rejectOnce(diagnostics.incomplete())
        })
        streamData.once('end', () => { parser.feed(decoder.end()); rejectOnce(diagnostics.incomplete()) })
      } else if (streamData) {
        // JSON response - parse directly
        try {
          // Handle SSE format in JSON response
          if (typeof streamData === 'string') {
            if (streamData.trimStart().startsWith('{') && Buffer.byteLength(streamData, 'utf8') <= 64 * 1024) {
              throw classifyZaiFailure(JSON.parse(streamData), 'unexpected_json')
            }
            let content = ''
            let reasoning = ''
            let completed = false
            const thinkingBuffer = { value: '' }
            const answerBuffer = { value: '' }
            const lines = streamData.split('\n')
            for (const line of lines) {
              if (line.startsWith('data:')) {
                const jsonStr = line.substring(5).trim()
                if (jsonStr === '[DONE]') continue
                const event = JSON.parse(jsonStr)
                if (hasZaiFailure(event)) throw classifyZaiFailure(event)
                if (event.type === 'chat:completion' && event.data) {
                  this.captureConversation(event.data)
                  data.id = this.lastMessageId || this.chatId
                  if (event.data.phase === 'thinking' && event.data.delta_content) {
                    reasoning += cleanSearchCitationsWithBuffer(event.data.delta_content, thinkingBuffer)
                  } else if (event.data.phase === 'answer' && event.data.delta_content) {
                    content += cleanSearchCitationsWithBuffer(event.data.delta_content, answerBuffer)
                  } else if (event.data.phase === 'done' && event.data.done) {
                    completed = true
                    if (event.data.usage) {
                      data.usage = event.data.usage
                    }
                  }
                }
              }
            }
            if (!completed) throw new ZaiUpstreamError('incomplete_stream')
            data.choices[0].message.content = content
            if (reasoning) {
              data.choices[0].message.reasoning_content = reasoning
            }
          } else {
            // Direct JSON object
            if (hasZaiFailure(streamData)) throw classifyZaiFailure(streamData)
            if (!streamData.choices?.[0]?.finish_reason) throw classifyZaiFailure(streamData, 'unexpected_json')
            this.captureConversation(streamData.choices?.[0]?.message)
            if (streamData.type === 'chat:completion') this.captureConversation(streamData.data)
            data.id = this.lastMessageId || this.chatId
            data.choices[0].message.content = streamData.choices?.[0]?.message?.content || ''
          }
          
          console.log('[Z.ai] Non-stream JSON finished, content length:', data.choices[0].message.content.length)
          resolveOnce(data)
        } catch (err) {
          console.error('[Z.ai] Non-stream JSON parse failed; remote content omitted')
          rejectOnce(err instanceof ZaiUpstreamError ? err : new ZaiUpstreamError('invalid_json'))
        }
      } else {
        console.log('[Z.ai] Non-stream: streamData is falsy, taking empty path')
        rejectOnce(new ZaiUpstreamError('incomplete_stream'))
      }
    })
  }

  getChatId(): string {
    return this.chatId
  }
}

export const zaiAdapter = {
  ZaiAdapter,
  ZaiStreamHandler,
}
