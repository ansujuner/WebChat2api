import { net } from 'electron'
import { getNetworkSession } from '../../network/proxy'
import { Readable } from 'stream'
import type { Account, Provider } from '../../store/types'
import type { ConversationRequestOptions, ProviderConversationState } from '../conversationTypes'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'

const PERPLEXITY_URL = 'https://www.perplexity.ai'
const QUERY_ENDPOINT = `${PERPLEXITY_URL}/rest/sse/perplexity_ask`

const FAKE_HEADERS: Record<string, string> = {
  'Accept': 'text/event-stream',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Origin': PERPLEXITY_URL,
  'Sec-Ch-Ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
}

interface PerplexityMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | readonly unknown[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest extends ConversationRequestOptions {
  model: string
  messages: PerplexityMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max'
  tools?: any[]
  tool_choice?: any
}

interface SessionData {
  context_uuid?: string
  backend_uuid: string
  read_write_token: string
  thread_url_slug: string
  frontend_context_uuid: string
  frontend_uuid: string
  createdAt: number
}

interface StoredCookies {
  [name: string]: string
}

const sessionCache = new Map<string, SessionData>()
const cookiesCache = new Map<string, StoredCookies>()

function extractTextContent(content: PerplexityMessage['content']): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part: unknown) => {
    if (typeof part !== 'object' || part === null || !('type' in part) || part.type !== 'text') return []
    if (!('text' in part) || typeof part.text !== 'string') {
      throw new Error('Perplexity text content parts must contain a string')
    }
    return [part.text]
  }).join('\n')
}

function parseStoredCookies(value: unknown): StoredCookies {
  if (value === undefined || value === null || value === '') return {}
  const entries: [string, unknown][] = typeof value === 'string'
    ? value.split(';').map(part => part.trim()).filter(Boolean).map(part => {
      const separator = part.indexOf('=')
      if (separator < 1) throw new Error('Perplexity cookies must use name=value format')
      return [part.slice(0, separator).trim(), part.slice(separator + 1)]
    })
    : typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value)
      : (() => { throw new Error('Perplexity cookies must be a cookie string or a string-valued object') })()

  return Object.fromEntries(entries.map(([name, cookieValue]) => {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)
      || typeof cookieValue !== 'string' || /[\r\n\0;]/.test(cookieValue)) {
      throw new Error('Perplexity cookies contain an invalid name or value')
    }
    return [name, cookieValue]
  }))
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function extractQuery(messages: PerplexityMessage[]): string {
  if (messages.length === 1 && messages[0].role === 'user') return extractTextContent(messages[0].content)
  const systemPrompt = messages.filter(message => message.role === 'system')
    .map(message => extractTextContent(message.content)).filter(Boolean).join('\n\n')

  // Build conversation history from all non-system messages
  const conversationParts: string[] = []
  for (const msg of messages) {
    if (msg.role === 'system') continue
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      conversationParts.push(getProviderToolProfile('perplexity').formatAssistantToolCalls(
        msg.tool_calls.map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })),
      ))
      continue
    }
    if (msg.role === 'tool' && msg.tool_call_id) {
      conversationParts.push(getProviderToolProfile('perplexity').formatToolResult({
        toolCallId: msg.tool_call_id, content: extractTextContent(msg.content),
      }))
      continue
    }
    
    const content = extractTextContent(msg.content)
    
    if (content) {
      const roleLabel = msg.role === 'user' ? 'User' : 'Assistant'
      conversationParts.push(`[${roleLabel}]: ${content}`)
    }
  }

  const conversationHistory = conversationParts.join('\n\n')

  // Combine system prompt and conversation history
  if (systemPrompt && conversationHistory) {
    return `${systemPrompt}\n\n---\n\n${conversationHistory}`
  }
  
  return conversationHistory || systemPrompt
}

const PERPLEXITY_REASONING_MODELS: Record<string, string> = {
  // Only Search variants from the live /rest/models/config/v2 catalog.
  gpt56_terra: 'gpt56_terra_thinking',
  gpt56_sol: 'gpt56_sol_thinking',
  gemini38flash: 'gemini38flashthinking',
  claude50sonnet: 'claude50sonnetthinking',
  claude50opus: 'claude50opusthinking',
  grok46low: 'grok46medium',
}

export function resolvePerplexityModel(
  model: string,
  modelMappings: Record<string, string> = {},
  reasoningEffort?: ChatCompletionRequest['reasoning_effort'],
): string {
  const mappedModel = Object.entries(modelMappings).find(
    ([name]) => name.toLowerCase() === model.toLowerCase(),
  )?.[1] || model

  // Best's actual default_models.search value is turbo; Auto is the old alias.
  // New/user-mapped IDs must never become GPT-5,
  // Claude 4, Gemini 2.5, or turbo just because their names look similar.
  if (['best', 'auto', 'turbo'].includes(mappedModel.toLowerCase())) return 'turbo'
  if (reasoningEffort) return PERPLEXITY_REASONING_MODELS[mappedModel] || mappedModel
  return mappedModel
}

export class PerplexityAdapter {
  private conversation?: ProviderConversationState
  private onConversation?: ConversationRequestOptions['onConversation']
  private frontendContextUuid = ''
  private provider: Provider
  private account: Account
  private cookie: string
  private allCookies: StoredCookies

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.cookie = account.credentials.sessionToken || account.credentials.cookie || account.credentials.token || ''
    // Store all cookies from credentials for Cloudflare-protected requests
    const storedCookies = parseStoredCookies(account.credentials.cookies)
    // Copy legacy object-form cookies; never mutate the account's credentials.
    this.allCookies = {
      ...storedCookies,
      ...(this.cookie && !storedCookies['__Secure-next-auth.session-token']
        ? { '__Secure-next-auth.session-token': this.cookie }
        : {}),
    }
  }

  private buildCookieHeader(): string {
    const cookieParts: string[] = []
    for (const [name, value] of Object.entries(this.allCookies)) {
      cookieParts.push(`${name}=${value}`)
    }
    if (this.cookie && !this.allCookies['__Secure-next-auth.session-token']) {
      cookieParts.push(`__Secure-next-auth.session-token=${this.cookie}`)
    }
    return cookieParts.join('; ')
  }

  private formatNetworkError(error: Error): string {
    const errorMsg = error.message || String(error)
    
    if (errorMsg.includes('ERR_CONNECTION_RESET') || errorMsg.includes('net::ERR_CONNECTION_RESET')) {
      return 'Network connection reset. Please check your network connection and try again.'
    }
    if (errorMsg.includes('ERR_CONNECTION_REFUSED') || errorMsg.includes('net::ERR_CONNECTION_REFUSED')) {
      return 'Connection refused. The server may be temporarily unavailable.'
    }
    if (errorMsg.includes('ERR_CONNECTION_TIMED_OUT') || errorMsg.includes('net::ERR_CONNECTION_TIMED_OUT')) {
      return 'Connection timed out. Please check your network and try again.'
    }
    if (errorMsg.includes('ERR_SSL') || errorMsg.includes('SSL')) {
      return 'SSL/TLS handshake failed. Please check your network security settings.'
    }
    if (errorMsg.includes('ERR_NAME_NOT_RESOLVED') || errorMsg.includes('net::ERR_NAME_NOT_RESOLVED')) {
      return 'DNS resolution failed. Please check your network connection.'
    }
    if (errorMsg.includes('ERR_NETWORK_CHANGED') || errorMsg.includes('net::ERR_NETWORK_CHANGED')) {
      return 'Network changed during request. Please try again.'
    }
    if (errorMsg.includes('ERR_INTERNET_DISCONNECTED') || errorMsg.includes('net::ERR_INTERNET_DISCONNECTED')) {
      return 'No internet connection. Please check your network settings.'
    }
    
    return `Network error: ${errorMsg}. Please check your connection and try again.`
  }

  private buildRequestData(
    query: string,
    model: string,
    conversation?: ProviderConversationState,
  ): any {
    const frontendUuid = uuid()
    const frontendContextUuid = conversation?.extras?.frontend_context_uuid || uuid()
    this.frontendContextUuid = frontendContextUuid
    if (conversation && (!conversation.parentMessageId || !conversation.extras?.read_write_token)) {
      throw new Error('Perplexity conversation is missing its server continuation cursor; start a new conversation explicitly')
    }

    const baseParams: any = {
      attachments: [],
      language: 'en-US',
      timezone: 'America/Los_Angeles',
      search_focus: 'internet',
      sources: ['web'],
      search_recency_filter: null,
      frontend_uuid: frontendUuid,
      mode: 'copilot',
      model_preference: model,
      is_related_query: false,
      is_sponsored: false,
      // Captured official SPA Vw/Jw: a new frontend context is supplied only
      // when creating a thread. Follow-ups use the latest backend entry cursor.
      ...(conversation ? {
        last_backend_uuid: conversation.parentMessageId,
        read_write_token: conversation.extras?.read_write_token,
      } : { frontend_context_uuid: frontendContextUuid }),
      prompt_source: 'user',
      query_source: conversation ? 'followup' : 'home',
      is_incognito: false,
      time_from_first_type: 18361,
      local_search_enabled: false,
      use_schematized_api: true,
      send_back_text_in_streaming_api: false,
      supported_block_use_cases: [
        'answer_modes',
        'media_items',
        'knowledge_cards',
        'inline_entity_cards',
        'place_widgets',
        'finance_widgets',
        'prediction_market_widgets',
        'sports_widgets',
        'flight_status_widgets',
        'news_widgets',
        'shopping_widgets',
        'jobs_widgets',
        'search_result_widgets',
        'inline_images',
        'inline_assets',
        'placeholder_cards',
        'diff_blocks',
        'inline_knowledge_cards',
        'entity_group_v2',
        'refinement_filters',
        'canvas_mode',
        'maps_preview',
        'answer_tabs',
        'price_comparison_widgets',
        'preserve_latex',
        'generic_onboarding_widgets',
        'in_context_suggestions',
        'inline_claims'
      ],
      client_coordinates: null,
      mentions: [],
      dsl_query: query,
      skip_search_enabled: true,
      is_nav_suggestions_disabled: false,
      source: 'default',
      always_search_override: false,
      override_no_search: false,
      should_ask_for_mcp_tool_confirmation: true,
      browser_agent_allow_once_from_toggle: false,
      force_enable_browser_agent: false,
      supported_features: ['browser_agent_permission_banner_v1.1'],
      version: '2.18'
    }

    return {
      params: baseParams,
      query_str: query
    }
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ stream: Readable; sessionId: string }> {
    this.conversation = request.conversation
    this.onConversation = request.onConversation
    const query = extractQuery(request.messages)
    if (!query) {
      throw new Error('No user message found in request')
    }

    const model = resolvePerplexityModel(request.model, this.provider.modelMappings, request.reasoning_effort)
    const requestId = uuid()

    const referer = `${PERPLEXITY_URL}/`

    const headers: Record<string, string> = {
      ...FAKE_HEADERS,
      'Content-Type': 'application/json',
      'Cookie': `__Secure-next-auth.session-token=${this.cookie}`,
      'x-perplexity-request-reason': 'perplexity-query-state-provider',
      'x-request-id': requestId,
      'Referer': referer,
    }

    const data = this.buildRequestData(query, model, request.conversation)

    // Share the configured OS/PAC or direct route, but never another account's cookies.
    const networkSession = await getNetworkSession()
    const request_ = net.request({
      method: 'POST',
      url: QUERY_ENDPOINT,
      session: networkSession,
      useSessionCookies: false,
    })

    for (const [key, value] of Object.entries(headers)) {
      request_.setHeader(key, value)
    }

    let responseEnded = false
    const stream = new Readable({
      read() {},
      destroy(error, callback) {
        if (!responseEnded) request_.abort()
        callback(error)
      },
    })

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let errorBodyRead = false
      
      request_.on('response', (response) => {
        const statusCode = response.statusCode
        
        if (statusCode === 403) {
          // Cloudflare challenge - need to handle this
          stream.emit('error', new Error('Cloudflare challenge detected. Please try again later.'))
          reject(new Error('Cloudflare challenge detected'))
          return
        }
        
        if (statusCode === 429) {
          // Rate limit exceeded
          stream.emit('error', new Error('Rate limit exceeded. Please wait a moment and try again.'))
          reject(new Error('Rate limit exceeded'))
          return
        }
        
        if (statusCode && statusCode >= 400) {
          // Error response - read full body before rejecting
          errorBodyRead = true
          let errorBody = ''
          response.on('data', (chunk: Buffer) => {
            errorBody += chunk.toString()
          })
          response.on('end', () => {
            const errorMsg = `HTTP ${statusCode}: ${errorBody.substring(0, 200)}`
            console.error('[Perplexity] Server error:', errorMsg)
            stream.emit('error', new Error(errorMsg))
            reject(new Error(errorMsg))
          })
          response.on('error', (error) => {
            console.error('[Perplexity] Error response stream error:', error)
            const errorMsg = `HTTP ${statusCode}: Failed to read error response`
            stream.emit('error', new Error(errorMsg))
            reject(new Error(errorMsg))
          })
          return
        }
        
        // Success response - stream the data
        response.on('data', (chunk) => {
          stream.push(chunk)
          chunks.push(Buffer.from(chunk))
        })
        
        response.on('end', () => {
          responseEnded = true
          stream.push(null)
        })
        
        response.on('error', (error) => {
          if (stream.destroyed) return
          console.error('[Perplexity] Response error:', error)
          const errorMessage = this.formatNetworkError(error)
          stream.emit('error', new Error(errorMessage))
        })
        
        // Request UUIDs are not upstream conversation IDs. SSE supplies those.
        resolve({ stream, sessionId: request.conversation?.sessionId || '' })
      })
      
      request_.on('error', (error) => {
        if (stream.destroyed) return
        console.error('[Perplexity] Request error:', error)
        const errorMessage = this.formatNetworkError(error)
        const wrappedError = new Error(errorMessage)
        stream.emit('error', wrappedError)
        reject(wrappedError)
      })
      
      request_.write(JSON.stringify(data))
      request_.end()
    })
  }

  updateSessionData(data: Partial<SessionData>): ProviderConversationState | undefined {
    const sessionId = this.conversation?.sessionId || data.context_uuid || data.backend_uuid
    if (!sessionId) return undefined
    const cacheKey = `${this.account.id}:${sessionId}`
    const existing = sessionCache.get(cacheKey)
    
    const newData: SessionData = {
      backend_uuid: data.backend_uuid || existing?.backend_uuid || '',
      read_write_token: data.read_write_token || existing?.read_write_token || '',
      thread_url_slug: data.thread_url_slug || existing?.thread_url_slug || '',
      context_uuid: data.context_uuid || existing?.context_uuid,
      frontend_context_uuid: data.frontend_context_uuid || existing?.frontend_context_uuid || this.frontendContextUuid,
      frontend_uuid: data.frontend_uuid || existing?.frontend_uuid || '',
      createdAt: existing?.createdAt || Date.now(),
    }
    
    sessionCache.set(cacheKey, newData)
    this.conversation = {
      sessionId,
      parentMessageId: data.backend_uuid || this.conversation?.parentMessageId,
      extras: {
        ...this.conversation?.extras,
        ...(newData.read_write_token ? { read_write_token: newData.read_write_token } : {}),
        ...(newData.frontend_context_uuid ? { frontend_context_uuid: newData.frontend_context_uuid } : {}),
        ...(newData.thread_url_slug ? { thread_url_slug: newData.thread_url_slug } : {}),
      },
    }
    this.onConversation?.(this.conversation)
    return this.conversation
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const cacheKey = `${this.account.id}:${sessionId || this.conversation?.sessionId || ''}`
    const sessionData = sessionCache.get(cacheKey)
    
    if (!sessionData?.backend_uuid) {
      sessionCache.delete(cacheKey)
      return true
    }

    try {
      const deleteUrl = `${PERPLEXITY_URL}/rest/thread/delete_thread_by_entry_uuid?version=2.18&source=default`
      
      const headers: Record<string, string> = {
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Content-Type': 'application/json',
        'Cookie': this.buildCookieHeader(),
        'Origin': PERPLEXITY_URL,
        'Referer': `${PERPLEXITY_URL}/`,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'x-app-apiclient': 'default',
        'x-app-apiversion': '2.18',
        'x-perplexity-request-endpoint': deleteUrl,
        'x-perplexity-request-reason': 'home-sidebar',
        'x-perplexity-request-try-number': '1',
      }

      const requestBody = {
        entry_uuid: sessionData.backend_uuid,
        read_write_token: sessionData.read_write_token || '',
      }

      const networkSession = await getNetworkSession()
      return new Promise((resolve) => {
        const request_ = net.request({
          method: 'DELETE',
          url: deleteUrl,
          session: networkSession,
          useSessionCookies: false,
        })

        for (const [key, value] of Object.entries(headers)) {
          request_.setHeader(key, value)
        }

        request_.on('response', (response) => {
          const statusCode = response.statusCode
          
          // Read response body
          let responseBody = ''
          response.on('data', (chunk: Buffer) => {
            responseBody += chunk.toString()
          })
          
          if (statusCode && statusCode >= 200 && statusCode < 300) {
            sessionCache.delete(cacheKey)
            resolve(true)
          } else {
            sessionCache.delete(cacheKey)
            resolve(false)
          }
        })

        request_.on('error', (error) => {
          console.error('[Perplexity] Delete request error:', error)
          sessionCache.delete(cacheKey)
          resolve(false)
        })

        request_.write(JSON.stringify(requestBody))
        request_.end()
      })
    } catch (error) {
      console.error('[Perplexity] Delete session error:', error)
      sessionCache.delete(cacheKey)
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    const deleteUrl = `${PERPLEXITY_URL}/rest/thread/delete_all_threads?version=2.18&source=default`
    
    const headers: Record<string, string> = {
      'Accept': '*/*',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/json',
      'Cookie': this.buildCookieHeader(),
      'Origin': PERPLEXITY_URL,
      'Referer': `${PERPLEXITY_URL}/library`,
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Google Chrome";v="134"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'x-app-apiclient': 'default',
      'x-app-apiversion': '2.18',
      'x-perplexity-request-endpoint': deleteUrl,
      'x-perplexity-request-reason': 'threads-list',
      'x-perplexity-request-try-number': '1',
    }

    const networkSession = await getNetworkSession()
    return new Promise((resolve) => {
      const request_ = net.request({
        method: 'DELETE',
        url: deleteUrl,
        session: networkSession,
        useSessionCookies: false,
      })

      for (const [key, value] of Object.entries(headers)) {
        request_.setHeader(key, value)
      }

      request_.on('response', (response) => {
        const statusCode = response.statusCode
        
        let responseBody = ''
        response.on('data', (chunk: Buffer) => {
          responseBody += chunk.toString()
        })
        
        response.on('end', () => {
          if (statusCode && statusCode >= 200 && statusCode < 300) {
            try {
              const data = JSON.parse(responseBody)
              if (data.status === 'success') {
                PerplexityAdapter.clearSessionCache(this.account.id)
                resolve(true)
              } else {
                resolve(false)
              }
            } catch {
              resolve(false)
            }
          } else {
            resolve(false)
          }
        })
      })

      request_.on('error', (error) => {
        console.error('[Perplexity] Delete all chats error:', error)
        resolve(false)
      })

      request_.write(JSON.stringify({ delete_all: true }))
      request_.end()
    })
  }

  static isPerplexityProvider(provider: Provider): boolean {
    return provider.id === 'perplexity' || provider.apiEndpoint.includes('perplexity.ai')
  }

  static clearSessionCache(accountId: string): void {
    for (const key of Array.from(sessionCache.keys())) {
      if (key.startsWith(`${accountId}:`)) sessionCache.delete(key)
    }
  }

  static getSessionData(accountId: string, sessionId: string): SessionData | undefined {
    return sessionCache.get(`${accountId}:${sessionId}`)
  }
}

export const perplexityAdapter = {
  PerplexityAdapter,
}
