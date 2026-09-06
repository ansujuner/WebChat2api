/**
 * Kimi K3 / K2.6 Adapter
 * Implements Kimi web API protocol with thinking mode and web search support
 */

import axios, { AxiosResponse } from 'axios'
import { Account, Provider } from '../../store/types'
import { PassThrough } from 'stream'
import { toolsToSystemPrompt, TOOL_WRAP_HINT, hasToolPromptInjected } from '../utils/tools'
import { parseToolCallsFromText } from '../utils/toolParser'
import { createBaseChunk } from '../utils/streamToolHandler'
import { createKimiChatPayload, encodeKimiGrpcFrame, resolveKimiScenario } from './providerModelOptions'
import type { KimiReasoningEffort } from './providerModelOptions'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import { ToolStreamParser } from '../toolCalling/ToolStreamParser'
import type { ToolCallingPlan } from '../toolCalling/types'
import type { ConversationRequestOptions, ProviderConversationState } from '../conversationTypes'

const KIMI_API_BASE = 'https://www.kimi.com'

const FAKE_HEADERS: Record<string, string> = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Origin: KIMI_API_BASE,
  'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Priority: 'u=1, i',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  userId: string
  refreshTime: number
}

interface KimiMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | any[] | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest extends ConversationRequestOptions {
  model: string
  originalModel?: string
  messages: KimiMessage[]
  stream?: boolean
  temperature?: number
  enableThinking?: boolean
  reasoning_effort?: KimiReasoningEffort
  enableWebSearch?: boolean
  tools?: any[]
  tool_choice?: any
  conversationId?: string
  parentId?: string
}

const accessTokenMap = new Map<string, TokenInfo>()

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

export function detectTokenType(token: string): 'jwt' | 'refresh' {
  if (token.startsWith('eyJ') && token.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
      if (payload.app_id === 'kimi' && payload.typ === 'access') {
        return 'jwt'
      }
    } catch (e) {
      // Parse failed, treat as refresh token
    }
  }
  return 'refresh'
}

function extractUserIdFromJWT(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString())
    return payload.sub
  } catch (e) {
    return undefined
  }
}

function checkResult(result: AxiosResponse, refreshToken: string): any {
  if (result.status === 401) {
    accessTokenMap.delete(refreshToken)
    throw new Error('Token invalid or expired')
  }
  if (!result.data) {
    return null
  }
  const { error_type, message } = result.data
  if (typeof error_type !== 'string') {
    return result.data
  }
  if (error_type === 'auth.token.invalid') {
    accessTokenMap.delete(refreshToken)
  }
  throw new Error(`Kimi API error: ${message || error_type}`)
}

export class KimiAdapter {
  private token: string

  constructor(_provider: Provider, account: Account) {
    this.token = account.credentials.token || account.credentials.refreshToken || ''
  }

  private async acquireToken(): Promise<{ accessToken: string; userId: string }> {
    if (!this.token) {
      throw new Error('Kimi Token not configured')
    }

    let result = accessTokenMap.get(this.token)
    if (result && result.refreshTime > unixTimestamp()) {
      console.log('[Kimi] Using cached token')
      return { accessToken: result.accessToken, userId: result.userId }
    }

    const tokenType = detectTokenType(this.token)
    console.log('[Kimi] Token type:', tokenType)

    if (tokenType === 'jwt') {
      const userId = extractUserIdFromJWT(this.token) || ''
      accessTokenMap.set(this.token, {
        accessToken: this.token,
        refreshToken: this.token,
        userId,
        refreshTime: unixTimestamp() + 300,
      })
      console.log('[Kimi] Using JWT token, userId:', userId)
      return { accessToken: this.token, userId }
    }

    console.log('[Kimi] Non-JWT token detected, attempting direct use...')
    accessTokenMap.set(this.token, {
      accessToken: this.token,
      refreshToken: this.token,
      userId: '',
      refreshTime: unixTimestamp() + 300,
    })
    return { accessToken: this.token, userId: '' }
  }

  private messagesPrepare(messages: KimiMessage[], toolsPrompt?: string): string {
    const toolProfile = getProviderToolProfile('kimi')
    // The proxy supplies only new messages; do not fetch or reconstruct history.
    const parts = messages.map(message => {
      if (message.role === 'assistant' && message.tool_calls?.length) {
        return toolProfile.formatAssistantToolCalls(message.tool_calls.map(call => ({
          id: call.id, name: call.function.name, arguments: call.function.arguments,
        })))
      }
      if (message.role === 'tool' && message.tool_call_id) {
        return toolProfile.formatToolResult({ toolCallId: message.tool_call_id, content: String(message.content || '') })
      }
      const text = Array.isArray(message.content)
        ? message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
        : String(message.content || '')
      return message.role === 'system' ? `System: ${text}` : text
    })
    return [...parts, ...(toolsPrompt ? [toolsPrompt] : [])].join('\n\n')
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; conversationId: string }> {
    // Reject unverified model IDs before performing authenticated requests.
    resolveKimiScenario(request.model)
    if (request.conversation && !request.conversation.parentMessageId) {
      throw new Error('Kimi conversation cannot continue without the previous assistant message ID; start a new client conversation')
    }
    const messages = [...request.messages]

    // Check if tool prompt has already been injected by client
    const toolPromptExists = hasToolPromptInjected(messages)

    let toolsPrompt = ''
    if (!request.conversation && request.tools && request.tools.length > 0 && !toolPromptExists) {
      toolsPrompt = toolsToSystemPrompt(request.tools, true)

      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
          const currentContent = messages[i].content
          if (typeof currentContent === 'string') {
            messages[i] = { ...messages[i], content: currentContent + TOOL_WRAP_HINT }
          } else if (Array.isArray(currentContent)) {
            messages[i] = {
              ...messages[i],
              content: [...currentContent, { type: 'text', text: TOOL_WRAP_HINT }],
            }
          }
          break
        }
      }
    }

    const content = this.messagesPrepare(messages, toolsPrompt)

    // Determine if thinking and web search should be enabled
    // Priority: explicit parameters > model name detection
    // Use originalModel for feature detection (preserves user's intent before mapping)
    const modelForDetection = request.originalModel || request.model
    const modelLower = modelForDetection.toLowerCase()
    
    let enableThinking = request.enableThinking
    let enableWebSearch = request.enableWebSearch ?? false
    
    // Auto-enable based on model name (if not explicitly set)
    if (enableThinking === undefined && (modelLower.includes('think') || modelLower.includes('r1'))) {
      enableThinking = true
      console.log('[Kimi] Thinking mode enabled (from model name)')
    }
    if (!enableWebSearch && modelLower.includes('search')) {
      enableWebSearch = true
      console.log('[Kimi] Web search enabled (from model name)')
    }

    const payload = createKimiChatPayload({
      model: request.model,
      content,
      enableWebSearch,
      enableThinking,
      reasoning_effort: request.reasoning_effort,
      conversationId: request.conversation?.sessionId,
      parentMessageId: request.conversation?.parentMessageId,
    })
    const frameBuffer = encodeKimiGrpcFrame(payload)
    const { accessToken } = await this.acquireToken()

    console.log('[Kimi] Request body length:', frameBuffer.length, 'JSON length:', frameBuffer.length - 5)

    const response = await axios.post(
      `${KIMI_API_BASE}/apiv2/kimi.gateway.chat.v1.ChatService/Chat`,
      frameBuffer,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/connect+json',
          ...FAKE_HEADERS,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
      }
    )

    console.log('[Kimi] Completion response status:', response.status)

    if (response.status === 401) {
      accessTokenMap.delete(this.token)
      throw new Error('Token invalid or expired')
    }

    if (response.status !== 200) {
      throw new Error(`Completion request failed: HTTP ${response.status}`)
    }

    return { response, conversationId: request.conversation?.sessionId || '' }
  }

  async deleteConversation(conversationId: string): Promise<boolean> {
    try {
      const { accessToken } = await this.acquireToken()
      
      const response = await axios.post(
        `${KIMI_API_BASE}/apiv2/kimi.chat.v1.ChatService/DeleteChat`,
        { chat_id: conversationId },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )

      console.log('[Kimi] Chat deleted:', conversationId, 'Status:', response.status)
      return response.status === 200
    } catch (error) {
      console.error('[Kimi] Failed to delete conversation:', error)
      return false
    }
  }

  private async listChats(pageToken?: string): Promise<{ chatIds: string[]; nextPageToken: string }> {
    const { accessToken } = await this.acquireToken()
    const response = await axios.post(
      `${KIMI_API_BASE}/apiv2/kimi.chat.v1.ChatService/ListChats`,
      {
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
        query: '',
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    const data = checkResult(response, this.token)
    const chats = Array.isArray(data?.chats) ? data.chats : []
    const chatIds = chats
      .map((chat: any) => typeof chat?.id === 'string' ? chat.id : '')
      .filter(Boolean)

    return {
      chatIds,
      nextPageToken: typeof data?.nextPageToken === 'string' ? data.nextPageToken : '',
    }
  }

  private async batchDeleteChats(chatIds: string[]): Promise<boolean> {
    if (chatIds.length === 0) {
      return true
    }

    const { accessToken } = await this.acquireToken()
    const response = await axios.post(
      `${KIMI_API_BASE}/apiv2/kimi.chat.v1.ChatService/BatchDeleteChats`,
      { chat_ids: chatIds },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...FAKE_HEADERS,
        },
        timeout: 30000,
        validateStatus: () => true,
      }
    )

    checkResult(response, this.token)
    return response.status === 200
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      let allChatIds: string[] = []
      let pageToken = ''

      for (let page = 0; page < 100; page++) {
        const result = await this.listChats(pageToken || undefined)
        allChatIds = [...allChatIds, ...result.chatIds]

        if (!result.nextPageToken || result.chatIds.length === 0) {
          break
        }

        pageToken = result.nextPageToken
      }

      if (allChatIds.length === 0) {
        console.log('[Kimi] No chats to delete')
        return true
      }

      console.log('[Kimi] Found', allChatIds.length, 'chats to delete')

      for (let i = 0; i < allChatIds.length; i += 100) {
        const batch = allChatIds.slice(i, i + 100)
        const success = await this.batchDeleteChats(batch)
        if (!success) {
          return false
        }
      }

      console.log('[Kimi] All chats deleted successfully')
      return true
    } catch (error) {
      console.error('[Kimi] Failed to delete all chats:', error)
      return false
    }
  }

  static isKimiProvider(provider: Provider): boolean {
    return provider.id === 'kimi' || provider.apiEndpoint.includes('kimi.com')
  }
}

const STAGE_NAME_THINKING = 'STAGE_NAME_THINKING'

export class KimiStreamHandler {
  private model: string
  private conversationId: string
  private toolStreamParser?: ToolStreamParser
  private toolCallingPlan?: ToolCallingPlan
  private realChatId: string | null = null
  private lastMessageId: string | null = null
  private hasError: boolean = false
  private isDone: boolean = false
  private currentPhase: 'thinking' | 'answer' | undefined = undefined
  private reasoningBuffer: string = ''
  private conversationListener?: (state: ProviderConversationState) => void
  private messageRoles: Readonly<Record<string, string>> = {}

  setConversationListener(listener?: (state: ProviderConversationState) => void): void {
    this.conversationListener = listener
  }

  private observeConversation(data: any): void {
    if (typeof data.chat?.id === 'string' && data.chat.id) {
      this.realChatId = data.chat.id
    }
    if (typeof data.message?.id === 'string' && typeof data.message.role === 'string') {
      this.messageRoles = { ...this.messageRoles, [data.message.id]: data.message.role }
      if (data.message.role === 'assistant') this.lastMessageId = data.message.id
    }
    const blockId = data.block?.message_id ?? data.block?.messageId
    // Chat response block.text/block.think patches are generated assistant
    // output, not the echoed input message. Never accept a known user ID.
    const isOutputPatch = (data.op === 'set' || data.op === 'append')
      && (this.isAnswerMask(data.mask) || this.isThinkingMask(data.mask))
    if (typeof blockId === 'string' && blockId && this.messageRoles[blockId] !== 'user'
      && (this.messageRoles[blockId] === 'assistant' || isOutputPatch)) {
      this.lastMessageId = blockId
    }
    const sessionId = this.getConversationId()
    if (sessionId) {
      this.conversationListener?.({ sessionId, ...(this.lastMessageId ? { parentMessageId: this.lastMessageId } : {}) })
    }
  }

  constructor(model: string, conversationId: string, _enableThinking: boolean = false, toolCallingPlan?: ToolCallingPlan) {
    this.model = model
    this.conversationId = conversationId
    this.toolCallingPlan = toolCallingPlan
    this.toolStreamParser = toolCallingPlan?.shouldParseResponse ? new ToolStreamParser(toolCallingPlan) : undefined
  }

  getConversationId(): string | null {
    // Return realChatId if available, otherwise return null (not empty string)
    // to prevent saving invalid session IDs
    if (this.realChatId) {
      return this.realChatId
    }
    // Only return conversationId if it's a valid ID (not empty and not a temporary ID)
    if (this.conversationId && this.conversationId.length > 0 && !this.conversationId.startsWith('kimi-')) {
      return this.conversationId
    }
    return null
  }

  getLastMessageId(): string | null {
    return this.lastMessageId
  }

  hasSessionError(): boolean {
    return this.hasError
  }

  private detectMultiStage(data: any): 'thinking' | 'answer' | undefined {
    if (!data.block?.multiStage?.stages || !Array.isArray(data.block.multiStage.stages)) {
      return undefined
    }
    
    const stages = data.block.multiStage.stages
    if (stages.length === 0) {
      return undefined
    }
    
    const firstStage = stages[0]
    if (firstStage?.name === STAGE_NAME_THINKING) {
      return firstStage.status === 'completed' ? 'answer' : 'thinking'
    }
    
    return undefined
  }

  private isThinkingMask(mask: string | undefined): boolean {
    if (!mask) return false
    return mask.includes('block.think')
  }

  private isAnswerMask(mask: string | undefined): boolean {
    if (!mask) return false
    return mask.includes('block.text')
  }

  private extractThinkContent(data: any): string | null {
    return data.block?.think?.content || null
  }

  private extractTextContent(data: any): string | null {
    return data.block?.text?.content || null
  }

  async handleStream(stream: any): Promise<PassThrough> {
    const transStream = new PassThrough()
    transStream.once('close', () => {
      if (!this.isDone) stream.destroy?.()
    })
    const created = unixTimestamp()
    let buffer: Buffer = Buffer.alloc(0)
    let sentRole = false

    stream.on('data', (chunk: Buffer) => {
      if (this.isDone || this.hasError) return
      buffer = Buffer.concat([buffer, chunk])
      this.processBuffer(buffer, transStream, created, (remaining) => { buffer = remaining }, () => sentRole, (v) => { sentRole = v })
    })

    stream.once('error', (error: Error) => {
      this.hasError = true
      transStream.destroy(error)
    })
    const failIncomplete = () => {
      if (!this.isDone) {
        this.hasError = true
        transStream.destroy(new Error('Kimi response ended before its completion marker'))
      }
    }
    stream.once('end', failIncomplete)
    stream.once('close', failIncomplete)

    return transStream
  }

  private processBuffer(
    buffer: Buffer,
    transStream: PassThrough,
    created: number,
    setBuffer: (remaining: Buffer) => void,
    getSentRole: () => boolean,
    setSentRole: (v: boolean) => void
  ) {
    let offset = 0

    // gRPC-Web frame format: 1 byte flag + 4 bytes length (big-endian) + payload
    while (offset + 5 <= buffer.length) {
      if (this.isDone || this.hasError) break
      const length = buffer.readUInt32BE(offset + 1)

      if (offset + 5 + length > buffer.length) {
        break
      }

      const payload = buffer.slice(offset + 5, offset + 5 + length)

      try {
        const text = payload.toString('utf8')
        if (text.trim()) {
          const data = JSON.parse(text)
          
          // Check for error response
          if (data.error) {
            console.error('[Kimi] API Error:', data.error)
            this.hasError = true
            transStream.destroy(new Error(`Kimi API Error: ${data.error.message || 'Unknown upstream error'}`))
            return
          }
          
          this.handleMessage(data, transStream, created, getSentRole, setSentRole)
        }
      } catch (error) {
        this.hasError = true
        transStream.destroy(error instanceof Error ? error : new Error('Invalid Kimi response frame'))
        return
      }

      offset += 5 + length
    }

    setBuffer(buffer.slice(offset))
  }

  private handleMessage(
    data: any,
    transStream: PassThrough,
    created: number,
    getSentRole: () => boolean,
    setSentRole: (v: boolean) => void
  ) {
    if (data.heartbeat) return

    this.observeConversation(data)

    const multiStagePhase = this.detectMultiStage(data)
    if (multiStagePhase) {
      this.currentPhase = multiStagePhase
      console.log('[Kimi] Detected multiStage phase:', this.currentPhase)
    }

    if (data.block?.text?.flags === 'thinking') {
      this.currentPhase = 'thinking'
    } else if (data.block?.text?.flags === 'answer') {
      this.currentPhase = 'answer'
    }

    if ((data.op === 'set' || data.op === 'append')) {
      const mask = data.mask
      
      if (this.isThinkingMask(mask)) {
        const thinkContent = this.extractThinkContent(data)
        if (thinkContent) {
          if (!getSentRole()) {
            transStream.write(`data: ${JSON.stringify({
              id: this.getConversationId(),
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              created,
            })}\n\n`)
            setSentRole(true)
          }
          
          this.reasoningBuffer += thinkContent
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { reasoning_content: thinkContent }, finish_reason: null }],
            created,
          })}\n\n`)
        }
      } else if (this.isAnswerMask(mask)) {
        const textContent = this.extractTextContent(data)
        if (textContent) {
          if (!getSentRole()) {
            transStream.write(`data: ${JSON.stringify({
              id: this.getConversationId(),
              model: this.model,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
              created,
            })}\n\n`)
            setSentRole(true)
          }
          
          this.sendChunk(transStream, textContent, created)
        }
      } else if (data.block?.text?.content) {
        const content = data.block.text.content
        
        if (!getSentRole()) {
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            created,
          })}\n\n`)
          setSentRole(true)
        }
        
        if (this.currentPhase === 'thinking') {
          this.reasoningBuffer += content
          transStream.write(`data: ${JSON.stringify({
            id: this.getConversationId(),
            model: this.model,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }],
            created,
          })}\n\n`)
        } else {
          this.sendChunk(transStream, content, created)
        }
      }
    }

    if (data.done !== undefined && !this.isDone) {
      this.isDone = true
      const chatId = this.getConversationId() || this.conversationId
      const baseChunk = createBaseChunk(chatId, this.model, created)
      const flushChunks = this.toolStreamParser?.flush(baseChunk) ?? []
      for (const outChunk of flushChunks) {
        transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
      }

      transStream.write(`data: ${JSON.stringify({
        id: this.getConversationId(),
        model: this.model,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: this.toolStreamParser?.hasEmittedToolCall() ? 'tool_calls' : 'stop' }],
        created,
      })}\n\n`)
      transStream.end('data: [DONE]\n\n')
    }
  }

  private sendChunk(transStream: PassThrough, content: string, created: number) {
    // Process tool call interception
    // Use getConversationId() to get the real chat_id if available
    const chatId = this.getConversationId() || this.conversationId
    const baseChunk = createBaseChunk(chatId, this.model, created)
    const outputChunks = this.toolStreamParser?.push(content, baseChunk, false) ?? []

    // Check if we emitted tool calls first
    const hasToolCalls = outputChunks.some(c => c.choices?.[0]?.delta?.tool_calls)

    for (const outChunk of outputChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    if (!this.toolStreamParser || (!this.toolStreamParser.isBuffering() && !this.toolStreamParser.hasEmittedToolCall() && !hasToolCalls && outputChunks.length === 0)) {
      transStream.write(`data: ${JSON.stringify({
        ...baseChunk,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`)
    }
  }

  async handleNonStream(stream: any): Promise<any> {
    const created = unixTimestamp()
    let content = ''
    let reasoningContent = ''
    let buffer = Buffer.alloc(0)
    let currentPhase: 'thinking' | 'answer' | undefined = undefined

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        if (this.isDone || this.hasError) return
        buffer = Buffer.concat([buffer, chunk])

        let offset = 0
        while (offset + 5 <= buffer.length) {
          if (this.isDone || this.hasError) break
          const length = buffer.readUInt32BE(offset + 1)

          if (offset + 5 + length > buffer.length) {
            break
          }

          const payload = buffer.slice(offset + 5, offset + 5 + length)

          try {
            const text = payload.toString('utf8')
            if (text.trim()) {
              const data = JSON.parse(text)

              if (data.error) {
                this.hasError = true
                reject(new Error(`Kimi API Error: ${data.error.message || JSON.stringify(data.error)}`))
                return
              }

              this.observeConversation(data)

              const multiStagePhase = this.detectMultiStage(data)
              if (multiStagePhase) {
                currentPhase = multiStagePhase
                console.log('[Kimi] Non-stream: Detected multiStage phase:', currentPhase)
              }

              if (data.block?.text?.flags === 'thinking') {
                currentPhase = 'thinking'
              } else if (data.block?.text?.flags === 'answer') {
                currentPhase = 'answer'
              }

              if ((data.op === 'set' || data.op === 'append')) {
                const mask = data.mask
                
                if (this.isThinkingMask(mask)) {
                  const thinkContent = this.extractThinkContent(data)
                  if (thinkContent) {
                    reasoningContent += thinkContent
                  }
                } else if (this.isAnswerMask(mask)) {
                  const textContent = this.extractTextContent(data)
                  if (textContent) {
                    content += textContent
                  }
                } else if (data.block?.text?.content) {
                  const textContent = data.block.text.content
                  if (currentPhase === 'thinking') {
                    reasoningContent += textContent
                  } else {
                    content += textContent
                  }
                }
              }

              if (data.done !== undefined) {
                this.isDone = true
                const { content: cleanContent, toolCalls } = this.toolCallingPlan?.shouldParseResponse
                  ? { content, toolCalls: [] }
                  : parseToolCallsFromText(content, 'kimi')

                const message: any = {
                  role: 'assistant',
                  content: toolCalls.length > 0 ? null : cleanContent.trim(),
                }

                if (reasoningContent.trim()) {
                  message.reasoning_content = reasoningContent.trim()
                }

                if (toolCalls.length > 0) {
                  message.tool_calls = toolCalls
                }

                resolve({
                  id: this.realChatId || this.conversationId,
                  model: this.model,
                  object: 'chat.completion',
                  created,
                  choices: [{
                    index: 0,
                    message,
                    finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
                  }],
                  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                })
              }
            }
          } catch (error) {
            this.hasError = true
            reject(error)
            return
          }

          offset += 5 + length
        }

        buffer = buffer.slice(offset)
      })

      stream.once('error', (error: Error) => {
        this.hasError = true
        reject(error)
      })
      const failIncomplete = () => {
        if (!this.isDone) {
          this.hasError = true
          reject(new Error('Kimi response ended before its completion marker'))
        }
      }
      stream.once('end', failIncomplete)
      stream.once('close', failIncomplete)
    })
  }
}

export const kimiAdapter = {
  KimiAdapter,
  KimiStreamHandler,
}
