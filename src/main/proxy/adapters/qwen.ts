/**
 * Qwen Adapter
 * Implements Qwen (Tongyi Qianwen) web API protocol
 * Based on new chat2.qianwen.com API
 */

import axios, { AxiosResponse } from 'axios'
import { PassThrough } from 'stream'
import { createGunzip, createInflate, createBrotliDecompress } from 'zlib'
import * as ZstdCodec from 'zstd-codec'
import { Account, Provider } from '../../store/types'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { createBaseChunk } from '../utils/streamToolHandler'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import type { ConversationRequestOptions, ProviderConversationState } from '../conversationTypes'

const QWEN_API_BASE = 'https://chat2.qianwen.com'
const QWEN_CHAT2_API_BASE = 'https://chat2-api.qianwen.com'
const QWEN_CHAT_SIDE_API_BASE = 'https://chat-side.qianwen.com'

const MODEL_MAP: Record<string, string> = {
  // Use modelCode, not legacyModelCode, from the current domestic web catalog.
  'Qwen3.7': 'Qwen',
  'Qwen3.7-千问': 'Qwen',
  'Qwen3.8-Max': 'Qwen3.8-Max',
  'Qwen3.7-Max': 'Qwen3.7-Max',
  'Qwen3.6-Flash': 'Qwen3.6-Flash',
}

const DEFAULT_HEADERS = {
  Accept: 'application/json, text/event-stream, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Cache-Control': 'no-cache',
  Origin: 'https://www.qianwen.com',
  Pragma: 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="145", "Not(A:Brand";v="24", "Google Chrome";v="145"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-site',
  Referer: 'https://www.qianwen.com/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
}

interface QwenMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[]
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest extends ConversationRequestOptions {
  model: string
  originalModel?: string
  messages: QwenMessage[]
  tools?: any[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max'
  enableThinking?: boolean
  enableWebSearch?: boolean
}

interface QwenSessionListPage {
  sessionIds: string[]
  hasMore: boolean
  nextCursor: string
}

function uuid(separator: boolean = true): string {
  const id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
  return separator ? id : id.replace(/-/g, '')
}

function generateNonce(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function extractTextContent(content: string | any[]): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .filter((item) => item.type === 'text')
      .map((item) => item.text || '')
      .join('\n')
  }
  return ''
}

export class QwenAdapter {
  private provider: Provider
  private account: Account
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
  }

  private getTicket(): string {
    const credentials = this.account.credentials
    return credentials.ticket || credentials.tongyi_sso_ticket || ''
  }

  private mapModel(model: string): string {
    const lowerModel = model.toLowerCase()
    const explicitMapping = Object.entries(this.provider.modelMappings || {}).find(
      ([name]) => name.toLowerCase() === lowerModel,
    )
    const builtinMapping = Object.entries(MODEL_MAP).find(
      ([name]) => name.toLowerCase() === lowerModel,
    )
    return explicitMapping?.[1] || builtinMapping?.[1] || model
  }

  private getApiHeaders(ticket: string): Record<string, string> {
    return {
      Cookie: `tongyi_sso_ticket=${ticket}`,
      ...DEFAULT_HEADERS,
      'Content-Type': 'application/json',
      'X-Platform': 'pc_tongyi',
      'X-DeviceId': '5b68c267-cd8e-fd0e-148a-18345bc9a104',
    }
  }

  private getApiParams(extra: Record<string, string | number> = {}): Record<string, string | number> {
    return {
      biz_id: 'ai_qwen',
      chat_client: 'h5',
      device: 'pc',
      fr: 'pc',
      pr: 'qwen',
      ut: '5b68c267-cd8e-fd0e-148a-18345bc9a104',
      la: 'zh_CN',
      tz: 'Asia/Shanghai',
      wv: '1',
      ve: '1',
      ...extra,
    }
  }

  private extractSessionIds(data: any): string[] {
    const candidateLists = [
      data?.data?.list,
      data?.data?.sessions,
      data?.data?.sessionList,
      data?.data?.records,
      data?.data?.items,
      data?.data?.dataList,
      data?.data?.result?.list,
      data?.data?.result?.records,
      data?.data?.pageData?.list,
      data?.data?.pageData?.records,
      data?.list,
      data?.sessions,
    ].filter(Array.isArray)

    const sessionIds = candidateLists.flatMap((items: any[]) => (
      items
        .map((item: any) => item?.session_id || item?.sessionId || item?.session?.id || item?.id)
        .filter((sessionId: any): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0)
    ))

    return [...new Set(sessionIds)]
  }

  private async listSessions(pageNum: number, cursor?: string): Promise<QwenSessionListPage> {
    const ticket = this.getTicket()
    if (!ticket) {
      throw new Error('Qwen ticket not configured, please add ticket in account settings')
    }

    const response = await axios.post(
      `${QWEN_CHAT2_API_BASE}/api/v2/session/page/list`,
      {
        pageSize: 100,
        pageNum,
        ...(cursor ? { cursor } : {}),
      },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams(),
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || response.data?.success === false) {
      throw new Error(`Qwen session list failed: HTTP ${response.status}`)
    }

    const data = response.data?.data || {}
    const nextCursor = data.nextCursor || data.next_cursor || data.cursor || ''

    return {
      sessionIds: this.extractSessionIds(response.data),
      hasMore: Boolean(data.hasMore ?? data.has_more ?? data.page?.hasMore ?? data.result?.hasMore),
      nextCursor: typeof nextCursor === 'string' ? nextCursor : '',
    }
  }

  private async deleteRelatedFileRecords(sessionIds: string[]): Promise<boolean> {
    const ticket = this.getTicket()
    if (!ticket || sessionIds.length === 0) {
      return true
    }

    const timestamp = Date.now()
    const response = await axios.post(
      `${QWEN_CHAT_SIDE_API_BASE}/api/v2/file/record/delete`,
      { sessionIds },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams({
          nonce: generateNonce(),
          timestamp,
        }),
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200 || response.data?.success === false) {
      console.warn('[Qwen] Failed to delete related file records:', response.status, response.data)
      return false
    }

    return true
  }

  private async deleteSessions(sessionIds: string[]): Promise<boolean> {
    const ticket = this.getTicket()
    if (!ticket || sessionIds.length === 0) {
      return sessionIds.length === 0
    }

    const response = await axios.post(
      `${QWEN_CHAT2_API_BASE}/api/v1/session/delete/batch`,
      { session_ids: sessionIds },
      {
        headers: this.getApiHeaders(ticket),
        params: this.getApiParams(),
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    if (response.status !== 200) {
      console.warn(`[Qwen] Failed to delete sessions: status ${response.status}`)
      return false
    }

    const { success, code, msg } = response.data || {}
    if (success === false || (typeof code === 'number' && code !== 0)) {
      console.warn(`[Qwen] Failed to delete sessions: ${msg || 'Unknown error'}`)
      return false
    }

    const fileRecordSuccess = await this.deleteRelatedFileRecords(sessionIds)
    if (!fileRecordSuccess) {
      console.warn('[Qwen] Sessions deleted but related file record cleanup failed')
    }

    return true
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{
    response: AxiosResponse
    sessionId: string
    reqId: string
  }> {
    const ticket = this.getTicket()
    if (!ticket) {
      throw new Error('Qwen ticket not configured, please add ticket in account settings')
    }

    const reqId = uuid(false)
    const sessionId = request.conversation?.sessionId || uuid(false)
    const parentReqId = request.conversation?.parentMessageId
    if (request.conversation && !parentReqId) {
      throw new Error('Qwen continuation is missing the previous upstream request ID; start a new conversation')
    }
    request.onConversation?.({ sessionId, ...(parentReqId ? { parentMessageId: parentReqId } : {}) })
    
    const actualModel = this.mapModel(request.model)
    
    // Determine if thinking and web search should be enabled
    // Priority: explicit parameters > model name detection
    // Use originalModel for feature detection (preserves user's intent before mapping)
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    
    const enableThinking = request.enableThinking
      ?? Boolean(request.reasoning_effort || modelLower.includes('think') || modelLower.includes('r1'))
    const enableWebSearch = request.enableWebSearch ?? request.web_search ?? modelLower.includes('search')
    // Thinking/search are options. Do not replace the selected model with the
    // retired Qwen3-Max-Thinking-Preview backend ID.
    
    console.log('[Qwen] Session info:', {
      sessionId,
      reqId,
    })
    console.log('[Qwen] Using model:', actualModel)

    const toolProfile = getProviderToolProfile('qwen')

    // Build prompt content from conversation messages
    let systemPrompt = ''
    const conversationParts: string[] = []
    
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        systemPrompt = extractTextContent(msg.content)
      } else if (msg.role === 'user') {
        conversationParts.push(extractTextContent(msg.content))
      } else if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        conversationParts.push(toolProfile.formatAssistantToolCalls(msg.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        }))))
      } else if (msg.role === 'assistant') {
        conversationParts.push(`Assistant: ${extractTextContent(msg.content)}`)
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        conversationParts.push(toolProfile.formatToolResult({
          toolCallId: msg.tool_call_id,
          content: extractTextContent(msg.content),
        }))
      }
    }

    let userContent = conversationParts.join('\n\n')

    // Inject tools prompt if tools are provided and not already injected by client
    if (request.tools && request.tools.length > 0 && !hasToolPromptInjected(request.messages)) {
      const toolsPrompt = toolsToSystemPrompt(request.tools)
      systemPrompt = systemPrompt 
        ? systemPrompt + '\n\n' + toolsPrompt 
        : toolsPrompt
      // Add tool wrap hint to user content
      userContent = userContent + TOOL_WRAP_HINT
    }

    // If system prompt exists, prepend it to user content
    const finalContent = systemPrompt 
      ? `${systemPrompt}\n\nUser: ${userContent}`
      : userContent

    const timestamp = Date.now()
    const nonce = generateNonce()

    const requestBody = {
      deep_search: (enableWebSearch || enableThinking) ? '1' : '0',
      req_id: reqId,
      model: actualModel,
      scene: 'chat',
      session_id: sessionId,
      sub_scene: 'chat',
      temporary: false,
      messages: [
        {
          content: finalContent,
          mime_type: 'text/plain',
          meta_data: {
            ori_query: finalContent
          }
        }
      ],
      from: 'default',
      parent_req_id: parentReqId || '0',
      enable_search: enableWebSearch,
      biz_data: '{"entryPoint":"tongyigw"}',
      ...(!request.conversation ? { scene_param: 'first_turn' } : {}),
      chat_client: 'h5',
      client_tm: timestamp.toString(),
      protocol_version: 'v2',
      biz_id: 'ai_qwen'
    }

    const queryString = `biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&ut=${uuid(false)}&nonce=${nonce}&timestamp=${timestamp}`
    const url = `${QWEN_API_BASE}/api/v2/chat?${queryString}`

    console.log('[Qwen] Sending request to /api/v2/chat...')

    const response = await this.axiosInstance.post(url, requestBody, {
      headers: {
        ...DEFAULT_HEADERS,
        'Content-Type': 'application/json',
        Cookie: `tongyi_sso_ticket=${ticket}`,
      },
      responseType: 'stream',
      timeout: 120000,
      decompress: false,
    })

    console.log('[Qwen] Response status:', response.status)
    console.log('[Qwen] Response headers:', JSON.stringify(response.headers, null, 2))

    return { response, sessionId, reqId }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      if (!sessionId) {
        return false
      }

      const success = await this.deleteSessions([sessionId])
      if (success) {
        console.log('[Qwen] Session deleted successfully:', sessionId)
      }
      return success
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.warn('[Qwen] Failed to delete session:', errorMessage)
      return false
    }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      let allSessionIds: string[] = []
      let nextCursor = ''

      for (let pageNum = 1; pageNum <= 100; pageNum++) {
        const result = await this.listSessions(pageNum, nextCursor || undefined)
        allSessionIds = [...allSessionIds, ...result.sessionIds]

        if (!result.hasMore || result.sessionIds.length === 0) {
          break
        }

        nextCursor = result.nextCursor
      }

      allSessionIds = [...new Set(allSessionIds)]

      if (allSessionIds.length === 0) {
        console.log('[Qwen] No sessions to delete')
        return true
      }

      console.log('[Qwen] Found', allSessionIds.length, 'sessions to delete')

      for (let i = 0; i < allSessionIds.length; i += 100) {
        const batch = allSessionIds.slice(i, i + 100)
        const success = await this.deleteSessions(batch)
        if (!success) {
          return false
        }
      }

      console.log('[Qwen] All sessions deleted successfully')
      return true
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      console.warn('[Qwen] Failed to delete all sessions:', errorMessage)
      return false
    }
  }

  static isQwenProvider(provider: Provider): boolean {
    return provider.id === 'qwen' || provider.apiEndpoint.includes('qianwen.com') || provider.apiEndpoint.includes('aliyun.com')
  }
}

export class QwenStreamHandler {
  private onConversation?: (state: ProviderConversationState) => void
  private sessionId: string = ''
  private model: string
  private created: number
  private onEnd?: (sessionId: string) => void
  private content: string = ''
  private responseId: string = ''
  private stopSent: boolean = false
  private hasError: boolean = false
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private sentRole: boolean = false
  private thinkingContent: string = ''
  private sentThinkingRole: boolean = false

  constructor(model: string, onEnd?: (sessionId: string) => void, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
  }

  hasSessionError(): boolean {
    return this.hasError
  }

  setConversationListener(listener?: (state: ProviderConversationState) => void): void {
    this.onConversation = listener
  }

  private captureConversation(result: any): void {
    const communication = result.communication
    if (typeof communication?.sessionid === 'string' && communication.sessionid) {
      this.sessionId = communication.sessionid
    }
    if (typeof communication?.reqid === 'string' && communication.reqid) {
      this.responseId = communication.reqid
    }
    if (this.sessionId && this.responseId) {
      this.onConversation?.({ sessionId: this.sessionId, parentMessageId: this.responseId })
    }
  }

  handleStream(stream: any, response?: AxiosResponse): PassThrough {
    const transStream = new PassThrough()
    transStream.once('close', () => {
      if (!transStream.writableEnded && typeof stream.destroy === 'function') stream.destroy()
    })

    console.log('[Qwen] Starting stream handler...')
    
    const contentEncoding = response?.headers?.['content-encoding']
    console.log('[Qwen] Content-Encoding:', contentEncoding)

    let buffer = ''
    let streamEnded = false

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
      this.hasError = true
      transStream.destroy(error instanceof Error ? error : new Error(String(error)))
    }

    const processBuffer = () => {
      while (!streamEnded) {
        const doubleNewlineIndex = buffer.indexOf('\n\n')
        if (doubleNewlineIndex === -1) break

        const eventBlock = buffer.substring(0, doubleNewlineIndex)
        buffer = buffer.substring(doubleNewlineIndex + 2)

        const lines = eventBlock.split('\n')
        let eventType = 'message'
        let eventData = ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.substring(6).trim()
          } else if (line.startsWith('data:')) {
            eventData = line.substring(5).trim()
          }
        }

        if (eventData && eventData !== '[DONE]') {
          try {
            const result = JSON.parse(eventData)
            if (result.error || (result.error_code && result.error_code !== 0)) {
              fail(new Error(`Qwen upstream error: ${result.error_msg || result.error_code || 'request failed'}`))
              return
            }
            console.log('[Qwen] Parsed event:', eventType, 'data keys:', Object.keys(result))
            if (result.data?.messages) {
              console.log('[Qwen] Messages count:', result.data.messages.length)
              for (const msg of result.data.messages) {
                console.log('[Qwen] Message:', msg.mime_type, 'status:', msg.status, 'content length:', msg.content?.length || 0)
              }
            }

            this.captureConversation(result)

            if (result.data?.messages) {
              // First pass: collect thinking content and answer content
              // Strategy: only use deep_think type to avoid duplicate content from multimodal_chat_think
              let eventThinkingContent = ''
              let eventThinkingType = ''
              const eventMessages: Array<{ msg: any, hasMultiLoad: boolean }> = []

              for (const msg of result.data.messages) {
                console.log('[Qwen] Message detail:', JSON.stringify(msg).substring(0, 500))

                // Collect thinking content from meta_data.multi_load
                const metaData = msg.meta_data || {}
                const multiLoad = metaData.multi_load || []
                let msgHasMultiLoad = false
                for (const load of multiLoad) {
                  if (load.type === 'deep_think' && load.content) {
                    // Only use deep_think type for thinking content
                    // multimodal_chat_think may contain slightly different content causing duplicates
                    const newThinkingContent = load.content.think_content || load.content.content || ''
                    if (newThinkingContent.length > eventThinkingContent.length) {
                      eventThinkingContent = newThinkingContent
                      eventThinkingType = load.type
                    }
                    msgHasMultiLoad = true
                  } else if (load.type === 'multimodal_chat_think') {
                    // Only fall back to multimodal_chat_think if no deep_think exists in this event
                    if (!msgHasMultiLoad && load.content) {
                      const newThinkingContent = load.content.think_content || load.content.content || ''
                      if (newThinkingContent.length > eventThinkingContent.length) {
                        eventThinkingContent = newThinkingContent
                        eventThinkingType = load.type
                      }
                      msgHasMultiLoad = true
                    }
                  }
                }
                eventMessages.push({ msg, hasMultiLoad: msgHasMultiLoad })
              }

              // Process thinking content (once per event, only before answer phase starts)
              // Once answer content has been sent (sentRole), stop emitting reasoning_content
              if (!this.sentRole && eventThinkingContent.length > this.thinkingContent.length) {
                const chunk = eventThinkingContent.substring(this.thinkingContent.length)
                this.thinkingContent = eventThinkingContent
                console.log('[Qwen] Thinking chunk, length:', chunk.length, 'content:', chunk.substring(0, 50), 'type:', eventThinkingType, 'prev:', this.thinkingContent.length - chunk.length, '->', this.thinkingContent.length)

                if (chunk.trim()) {
                  // Send reasoning_content delta
                  if (!this.sentThinkingRole) {
                    transStream.write(`data: ${JSON.stringify({
                      id: this.responseId || this.sessionId,
                      model: this.model,
                      object: 'chat.completion.chunk',
                      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
                      created: this.created,
                    })}\n\n`)
                    this.sentThinkingRole = true
                  }

                  transStream.write(`data: ${JSON.stringify({
                    id: this.responseId || this.sessionId,
                    model: this.model,
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { reasoning_content: chunk }, finish_reason: null }],
                    created: this.created,
                  })}\n\n`)
                }
              }

              // Second pass: process answer content and completion status
              for (const { msg } of eventMessages) {
                
                // Filter out [(deep_think)] and [(multimodal_chat_think_*)] markers from content
                if ((msg.mime_type === 'text/plain' || msg.mime_type === 'multi_load/iframe') && msg.content) {
                  // Skip content that is just the deep_think marker
                  let newContent = msg.content
                  if (newContent === '[(deep_think)]' || newContent.trim() === '[(deep_think)]') {
                    console.log('[Qwen] Skipping deep_think marker')
                    continue
                  }
                  // Remove any deep_think and multimodal_chat_think markers from content
                  newContent = newContent.replace(/\[\(deep_think\)\]/g, '')
                  newContent = newContent.replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')
                  
                  if (!newContent.trim()) {
                    console.log('[Qwen] Skipping empty content after filtering')
                    continue
                  }
                  
                  console.log('[Qwen] newContent.length:', newContent.length, 'this.content.length:', this.content.length)
                  if (newContent.length > this.content.length) {
                    const chunk = newContent.substring(this.content.length)
                    this.content = newContent
                    console.log('[Qwen] Writing chunk, length:', chunk.length)

                    // Process tool call interception
                    const baseChunk = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
                    const outputChunks = this.toolStreamParser?.push(chunk, baseChunk, !this.sentRole) ?? [{
                      ...baseChunk,
                      choices: [{ index: 0, delta: { ...(!this.sentRole ? { role: 'assistant' } : {}), content: chunk }, finish_reason: null }],
                    }]

                    for (const outChunk of outputChunks) {
                      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
                    }

                    if (outputChunks.length > 0) this.sentRole = true
                    console.log('[Qwen] Chunk written to stream')
                  } else {
                    console.log('[Qwen] Skipping - no new content')
                  }
                }

                if (msg.status === 'complete' || msg.status === 'finished') {
                  // 只有当 multi_load/iframe 消息完成时才发送 stop
                  if (msg.mime_type === 'multi_load/iframe' && !this.stopSent) {
                    this.stopSent = true
                    console.log('[Qwen] Sending stop for multi_load/iframe, content so far:', this.content.length)
                    
                    // Flush any remaining tool calls
                    const baseChunk = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
                    const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
                    
                    for (const outChunk of flushChunks) {
                      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
                    }
                    
                    // Check if we emitted tool calls
                    const finishReason = this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop'
                    
                    transStream.write(
                      `data: ${JSON.stringify({
                        id: this.responseId || this.sessionId,
                        model: this.model,
                        object: 'chat.completion.chunk',
                        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                        created: this.created,
                      })}\n\n`
                    )
                    safeEnd('data: [DONE]\n\n')
                    this.onEnd?.(this.sessionId)
                  }
                }
              }
            }

          } catch (err) {
            console.error('[Qwen] Parse error:', err, 'Data:', eventData.substring(0, 200))
            fail(err)
          }
        }

        if (eventType === 'complete') {
          console.log('[Qwen] Received complete event')
          if (!streamEnded && !this.stopSent) {
            this.stopSent = true
            
            // Flush any remaining tool calls
            const baseChunk = createBaseChunk(this.responseId || this.sessionId, this.model, this.created)
            const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
            
            for (const outChunk of flushChunks) {
              transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
            }
            
            // Check if we emitted tool calls
            const finishReason = this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop'
            
            transStream.write(
              `data: ${JSON.stringify({
                id: this.responseId || this.sessionId,
                model: this.model,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                created: this.created,
              })}\n\n`
            )
            safeEnd('data: [DONE]\n\n')
          }
        }
      }
    }

    let decompressStream: any = stream
    
    if (contentEncoding === 'gzip') {
      console.log('[Qwen] Decompressing gzip stream...')
      decompressStream = stream.pipe(createGunzip())
    } else if (contentEncoding === 'deflate') {
      console.log('[Qwen] Decompressing deflate stream...')
      decompressStream = stream.pipe(createInflate())
    } else if (contentEncoding === 'br') {
      console.log('[Qwen] Decompressing brotli stream...')
      decompressStream = stream.pipe(createBrotliDecompress())
    } else if (contentEncoding === 'zstd') {
      console.log('[Qwen] Decompressing zstd stream...')
      const chunks: Buffer[] = []
      let sourceEnded = false
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.once('end', () => {
        sourceEnded = true
        if (streamEnded) return
        try {
          const compressedData = Buffer.concat(chunks)
          ZstdCodec.run((zstd) => {
            if (streamEnded) return
            try {
              const simple = new zstd.Simple()
              const decompressed = simple.decompress(compressedData)
              buffer = Buffer.from(decompressed).toString('utf8')
              processBuffer()
              if (!streamEnded) fail(new Error('Qwen upstream stream ended before a completion event'))
            } catch (error) {
              fail(error)
            }
          })
        } catch (err) {
          console.error('[Qwen] Zstd decompression error:', err)
          fail(err)
        }
      })
      stream.once('error', (err: Error) => {
        console.error('[Qwen] Stream error:', err)
        fail(err)
      })
      stream.once('close', () => {
        if (!sourceEnded) fail(new Error('Qwen upstream compressed stream closed before completion'))
      })
      return transStream
    }

    if (decompressStream !== stream) stream.once('error', fail)
    decompressStream.on('data', (bufferChunk: Buffer) => {
      if (streamEnded) return
      buffer += bufferChunk.toString()
      processBuffer()
    })
    decompressStream.once('error', (err: Error) => {
      console.error('[Qwen] Stream error:', err)
      fail(err)
    })
    decompressStream.once('close', () => {
      console.log('[Qwen] Stream closed')
      if (streamEnded) return
      processBuffer()
      if (!streamEnded) fail(new Error('Qwen upstream stream closed before a completion event'))
    })
    decompressStream.once('end', () => {
      if (!streamEnded) {
        processBuffer()
        if (!streamEnded) fail(new Error('Qwen upstream stream ended before a completion event'))
      }
    })

    return transStream
  }

  async handleNonStream(stream: any, response?: AxiosResponse): Promise<any> {
    console.log('[Qwen] Starting non-stream handler...')

    return new Promise((resolve, reject) => {
      const data: {
        id: string
        model: string
        object: string
        choices: Array<{
          index: number
          message: { role: string; content: string | null; reasoning_content?: string; tool_calls?: any[] }
          finish_reason: string
        }>
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
        created: number
      } = {
        id: '',
        model: this.model,
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        created: this.created,
      }

      let contentAccumulator = ''
      let thinkingAccumulator = ''
      let buffer = ''
      let resolved = false

      const rejectOnce = (error: unknown) => {
        if (resolved) return
        resolved = true
        this.hasError = true
        reject(error instanceof Error ? error : new Error(String(error)))
        if (typeof stream.destroy === 'function') stream.destroy()
      }

      const finalizeWithData = (content: string) => {
        const { content: cleanContent, toolCalls } = this.toolCallingPlan?.shouldParseResponse
          ? { content, toolCalls: [] }
          : parseToolCallsFromText(content, 'qwen')
        if (toolCalls.length > 0) {
          data.choices[0].message.content = null
          data.choices[0].message.tool_calls = toolCalls
          data.choices[0].finish_reason = 'tool_calls'
        } else {
          data.choices[0].message.content = cleanContent.trim()
        }
      }

      const processBuffer = () => {
        while (!resolved) {
          const doubleNewlineIndex = buffer.indexOf('\n\n')
          if (doubleNewlineIndex === -1) break

          const eventBlock = buffer.substring(0, doubleNewlineIndex)
          buffer = buffer.substring(doubleNewlineIndex + 2)

          const lines = eventBlock.split('\n')
          let eventType = 'message'
          let eventData = ''

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.substring(6).trim()
            } else if (line.startsWith('data:')) {
              eventData = line.substring(5).trim()
            }
          }

          if (eventData && eventData !== '[DONE]') {
            try {
              const result = JSON.parse(eventData)
              if (result.error || (result.error_code && result.error_code !== 0)) {
                rejectOnce(new Error(`Qwen upstream error: ${result.error_msg || result.error_code || 'request failed'}`))
                return
              }
              console.log('[Qwen] Non-stream parsed event:', eventType, 'data keys:', Object.keys(result))

              this.captureConversation(result)
              data.id = this.responseId || this.sessionId || data.id

              if (result.data?.messages) {
                for (const msg of result.data.messages) {
                  // Handle thinking content from meta_data.multi_load
                  // Strategy: prefer deep_think, fall back to multimodal_chat_think only if no deep_think
                  const metaData = msg.meta_data || {}
                  const multiLoad = metaData.multi_load || []
                  let hasDeepThink = false
                  for (const load of multiLoad) {
                    if (load.type === 'deep_think' && load.content) {
                      const thinkContent = load.content.think_content || load.content.content || ''
                      if (thinkContent && thinkContent.length > thinkingAccumulator.length) {
                        thinkingAccumulator = thinkContent
                        console.log('[Qwen] Non-stream: Thinking content length:', thinkingAccumulator.length, 'type: deep_think')
                      }
                      hasDeepThink = true
                    }
                  }
                  // Fall back to multimodal_chat_think only if no deep_think found
                  if (!hasDeepThink) {
                    for (const load of multiLoad) {
                      if (load.type === 'multimodal_chat_think' && load.content) {
                        const thinkContent = load.content.think_content || load.content.content || ''
                        if (thinkContent && thinkContent.length > thinkingAccumulator.length) {
                          thinkingAccumulator = thinkContent
                          console.log('[Qwen] Non-stream: Thinking content length:', thinkingAccumulator.length, 'type: multimodal_chat_think (fallback)')
                        }
                      }
                    }
                  }
                  
                  // Handle multi_load/iframe content (actual response content)
                  if (msg.mime_type === 'multi_load/iframe' && msg.content) {
                    // Filter out deep_think and multimodal_chat_think markers
                    let filteredContent = msg.content
                    if (filteredContent === '[(deep_think)]' || filteredContent.trim() === '[(deep_think)]') {
                      console.log('[Qwen] Non-stream: Skipping deep_think marker')
                      continue
                    }
                    // Filter out all think markers: [(deep_think)], [(multimodal_chat_think_*)]
                    filteredContent = filteredContent.replace(/\[\(deep_think\)\]/g, '')
                    filteredContent = filteredContent.replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')
                    if (filteredContent.length > contentAccumulator.length) {
                      contentAccumulator = filteredContent
                      console.log('[Qwen] Non-stream multi_load/iframe content length:', contentAccumulator.length)
                    }
                  }
                  
                  // Also handle text/plain content
                  if (msg.mime_type === 'text/plain' && msg.content) {
                    // Filter out deep_think and multimodal_chat_think markers
                    let filteredContent = msg.content.replace(/\[\(deep_think\)\]/g, '')
                    filteredContent = filteredContent.replace(/\[\(multimodal_chat_think_\d+\)\]/g, '')
                    if (filteredContent.length > contentAccumulator.length) {
                      contentAccumulator = filteredContent
                    }
                  }

                  if (msg.status === 'complete' || msg.status === 'finished') {
                    if (msg.mime_type === 'multi_load/iframe') {
                      console.log('[Qwen] Non-stream finished, content length:', contentAccumulator.length)
                      this.content = contentAccumulator
                      
                      // Parse tool calls from content
                      const { content: cleanContent, toolCalls } = this.toolCallingPlan?.shouldParseResponse
                        ? { content: contentAccumulator, toolCalls: [] }
                        : parseToolCallsFromText(contentAccumulator, 'qwen')
                      
                      if (toolCalls.length > 0) {
                        data.choices[0].message.content = null
                        ;(data.choices[0].message as any).tool_calls = toolCalls
                        data.choices[0].finish_reason = 'tool_calls'
                      } else {
                        data.choices[0].message.content = cleanContent.trim()
                      }
                      
                      // Add reasoning_content if available
                      if (thinkingAccumulator) {
                        data.choices[0].message.reasoning_content = thinkingAccumulator
                      }
                      
                      this.onEnd?.(this.sessionId)
                      resolved = true
                      resolve(data)
                      return
                    }
                  }
                }
              }
            } catch (err) {
              console.error('[Qwen] Non-stream parse error:', err)
              rejectOnce(err)
            }
          }

          if (eventType === 'complete' && !resolved) {
            console.log('[Qwen] Non-stream complete event, content length:', contentAccumulator.length)
            this.content = contentAccumulator
            finalizeWithData(contentAccumulator)
            // Add reasoning_content if available
            if (thinkingAccumulator) {
              data.choices[0].message.reasoning_content = thinkingAccumulator
            }
            resolved = true
            resolve(data)
            return
          }
        }
      }

      let decompressStream: any = stream
      
      const contentEncoding = response?.headers?.['content-encoding']?.toLowerCase()
      if (contentEncoding === 'gzip') {
        console.log('[Qwen] Decompressing gzip stream...')
        decompressStream = stream.pipe(createGunzip())
      } else if (contentEncoding === 'deflate') {
        console.log('[Qwen] Decompressing deflate stream...')
        decompressStream = stream.pipe(createInflate())
      } else if (contentEncoding === 'br') {
        console.log('[Qwen] Decompressing brotli stream...')
        decompressStream = stream.pipe(createBrotliDecompress())
      } else if (contentEncoding === 'zstd') {
        console.log('[Qwen] Decompressing zstd stream...')
        const chunks: Buffer[] = []
        let sourceEnded = false
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.once('end', () => {
          sourceEnded = true
          if (resolved) return
          try {
            const compressedData = Buffer.concat(chunks)
            ZstdCodec.run((zstd) => {
              if (resolved) return
              try {
                const simple = new zstd.Simple()
                const decompressed = simple.decompress(compressedData)
                buffer = Buffer.from(decompressed).toString('utf8')
                processBuffer()
                if (!resolved) rejectOnce(new Error('Qwen upstream stream ended before a completion event'))
              } catch (error) {
                rejectOnce(error)
              }
            })
          } catch (err) {
            console.error('[Qwen] Zstd decompression error:', err)
            rejectOnce(err)
          }
        })
        stream.once('error', (err: Error) => {
          console.error('[Qwen] Non-stream error:', err)
          rejectOnce(err)
        })
        stream.once('close', () => {
          if (!sourceEnded) rejectOnce(new Error('Qwen upstream compressed stream closed before completion'))
        })
        return
      }

      if (decompressStream !== stream) stream.once('error', rejectOnce)
      decompressStream.on('data', (chunk: Buffer) => {
        if (resolved) return
        buffer += chunk.toString()
        processBuffer()
      })
      decompressStream.once('error', (err: Error) => {
        if (resolved) return
        console.error('[Qwen] Non-stream error:', err)
        rejectOnce(err)
      })
      decompressStream.once('close', () => {
        console.log('[Qwen] Non-stream closed, content length:', contentAccumulator.length)
        if (!resolved) {
          processBuffer()
          if (!resolved) rejectOnce(new Error('Qwen upstream stream closed before a completion event'))
        }
      })
      decompressStream.once('end', () => {
        console.log('[Qwen] Non-stream ended, content length:', contentAccumulator.length)
        if (!resolved) {
          processBuffer()
          if (!resolved) rejectOnce(new Error('Qwen upstream stream ended before a completion event'))
        }
      })
    })
  }

  getSessionId(): string {
    return this.sessionId
  }
}

export const qwenAdapter = {
  QwenAdapter,
  QwenStreamHandler,
}
