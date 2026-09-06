import type { ProviderProxyConfig } from '../../network/providerContext.ts'
/**
 * Z.ai Adapter
 * Implements Z.ai (GLM International) API protocol
 */

import { runZaiWebsiteChat, ZaiWebsiteChatError } from '../../oauth/zaiWebsiteChat'
import { PassThrough } from 'stream'
import { StringDecoder } from 'node:string_decoder'
import { createParser } from 'eventsource-parser'
import { Account, Provider } from '../../store/types'
import type { ConversationRequestOptions, ProviderConversationState } from '../conversationTypes'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import type { ToolCallingPlan } from '../toolCalling/types'
import { isZaiThinkingRequired, resolveZaiWebModel } from './zai-model-options.ts'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'

type ZaiFailureCategory = 'captcha_required' | 'verification_required' | 'authentication_required' | 'access_denied'
  | 'model_unavailable' | 'rate_limited' | 'quota_exceeded' | 'upstream_error' | 'invalid_json'
  | 'unexpected_json' | 'incomplete_stream' | 'transport_error' | 'browser_unavailable' | 'account_busy'
  | 'account_changed' | 'invalid_request' | 'unsupported_options' | 'cancelled' | 'protocol_mismatch'

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

/** Preserve the browser's trusted codes both before headers and during its response stream. */
function classifyZaiWebsiteFailure(error: unknown): ZaiUpstreamError {
  if (typeof ZaiWebsiteChatError === 'function' && error instanceof ZaiWebsiteChatError) {
    switch (error.code) {
      case 'login_required': return new ZaiUpstreamError('authentication_required')
      case 'action_required': return new ZaiUpstreamError('verification_required')
      case 'browser_unavailable': case 'account_busy': case 'model_unavailable':
      case 'unsupported_options': case 'account_changed': case 'invalid_request':
      case 'upstream_error': case 'incomplete_stream': case 'cancelled': case 'protocol_mismatch':
        return new ZaiUpstreamError(error.code)
    }
  }
  return new ZaiUpstreamError('transport_error')
}

/** Classify only known error fields in memory. Never expose arbitrary remote text. */
export function classifyZaiFailure(value: any, fallback: ZaiFailureCategory = 'upstream_error'): ZaiUpstreamError {
  if (value instanceof ZaiUpstreamError) return value
  if (typeof ZaiWebsiteChatError === 'function' && value instanceof ZaiWebsiteChatError) return classifyZaiWebsiteFailure(value)
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
const SEARCH_CITATION_LOOSE_PATTERN = '【[^】]*turn\\d+search\\d+[^】]*】'
const SEARCH_CITATION_BRACKET_START = '【'
const SEARCH_CITATION_BRACKET_END = '】'

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
  proxyMode?: 'system' | 'none'
  proxyConfig?: ProviderProxyConfig
  /** Main-only account binding guard; never part of website JSON or renderer IPC. */
  isAccountCurrent?: () => boolean
}

export class ZaiAdapter {
  constructor(private provider: Provider, private account: Account) {}

  /** Website-owned conversations are never deleted by an independent credential transport. */
  async deleteChat(_chatId: string): Promise<boolean> {
    console.warn('[Z.ai] Automatic deletion is unavailable for account-browser conversations; use the official website.')
    return false
  }

  async deleteAllChats(): Promise<boolean> {
    console.warn('[Z.ai] Bulk deletion is unavailable for account-browser conversations; use the official website.')
    return false
  }

  async chatCompletion(request: ChatCompletionRequest): ReturnType<typeof runZaiWebsiteChat> {
    if (!this.account.id || this.account.providerId !== 'zai' || this.provider.id !== 'zai') throw new ZaiUpstreamError('authentication_required')
    if (request.isAccountCurrent && !request.isAccountCurrent()) throw new ZaiUpstreamError('account_changed')
    if (request.signal?.aborted) throw new ZaiUpstreamError('cancelled')
    // The current bridge can submit text only. Never silently drop attachments or tools.
    if (!Array.isArray(request.messages) || !request.messages.length) throw new ZaiUpstreamError('invalid_request')
    if (request.messages.some(message => Array.isArray(message.content)
      && message.content.some(part => !part || part.type !== 'text' || typeof part.text !== 'string'))) {
      throw new ZaiUpstreamError('unsupported_options')
    }
    if (request.messages.some(message => message.role === 'tool' && !message.tool_call_id)) {
      throw new ZaiUpstreamError('invalid_request')
    }
    
    console.log('[Z.ai] chatCompletion called with request.model:', request.model)
    
    // Web IDs are not always the public Model API IDs (Flash is x-preview-l).
    const mappedModel = resolveZaiWebModel(request.model)
    
    console.log('[Z.ai] Original model:', request.model, '-> Mapped model:', mappedModel)
    
    // Extract system message and merge with user message
    const systemContent = request.messages
      .filter(msg => msg.role === 'system')
      .map(msg => typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(part => part.text).join('\n') : '')
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
        const calls = profile().formatAssistantToolCalls(msg.tool_calls.map(call => ({
          id: call.id, name: call.function.name, arguments: call.function.arguments,
        })))
        return { role: 'assistant' as const, content: [textContent(msg.content), calls].filter(Boolean).join('\n\n') }
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
    
    if (firstUserIdx < 0) throw new ZaiUpstreamError('invalid_request')
    // Continuity has already reduced a retained conversation to its current turn.
    // A single ordinary message stays byte-for-byte plain. Initial supplied history
    // and structured tool results retain their role boundaries in one website input.
    const prompt = processedMessages.length === 1 && processedMessages[0].role === 'user'
      ? textContent(processedMessages[0].content)
      : processedMessages.map(message => `${message.role === 'assistant' ? 'Assistant' : 'User'}: ${textContent(message.content)}`).join('\n\n')
    if (!prompt.trim()) throw new ZaiUpstreamError('invalid_request')
    if (request.conversation && !request.conversation.parentMessageId) {
      throw new ZaiUpstreamError('invalid_request')
    }

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

    let result: Awaited<ReturnType<typeof runZaiWebsiteChat>>
    try {
      result = await runZaiWebsiteChat({
        accountId: this.account.id,
        credentials: { ...this.account.credentials },
        expectedIdentity: { userId: this.account.providerUserId, email: this.account.email },
        ...(request.proxyConfig ? { proxyConfig: request.proxyConfig } : request.proxyMode ? { proxyMode: request.proxyMode } : {}),
        model: mappedModel, prompt,
        ...(request.conversation ? { conversation: { ...request.conversation } } : {}),
        webSearch: enableWebSearch, thinking: enableThinking, signal: request.signal,
        onConversation: request.onConversation,
        isAccountCurrent: request.isAccountCurrent,
      })
    } catch (error) {
      // The browser is the only chat transport: no old HTTP fallback or hidden retry.
      throw classifyZaiWebsiteFailure(error)
    }
    const { response, chatId, requestId } = result
    if (response.status !== 200) {
      response.data?.destroy?.()
      return { response, chatId, requestId }
    }
    // IDs come from the actual website submission, never locally pre-created chats.
    request.onConversation?.({ sessionId: chatId,
      ...(request.conversation?.parentMessageId ? { parentMessageId: request.conversation.parentMessageId } : {}) })
    return result
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
  private lastMessageId: string = ''
  private toolCallState: ToolCallState
  private sentRole: boolean = false
  private sentThinkingRole: boolean = false
  private citationBuffer: { value: string } = { value: '' }
  private thinkingCitationBuffer: { value: string } = { value: '' }

  constructor(model: string, onEnd?: (chatId: string) => void, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallState = createToolCallState(toolCallingPlan)
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
