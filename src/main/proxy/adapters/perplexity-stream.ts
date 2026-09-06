import { PassThrough } from 'stream'
import { StringDecoder } from 'node:string_decoder'
import { parseToolCallsFromText } from '../utils/toolParser'
import { 
  createToolCallState, 
  processStreamContent, 
  flushToolCallBuffer,
  createBaseChunk,
  ToolCallState 
} from '../utils/streamToolHandler'
import type { PerplexityAdapter } from './perplexity'
import type { ConversationRequestOptions } from '../conversationTypes'
import type { ToolCallingPlan } from '../toolCalling/types'

function filterCitations(content: string): string {
  // Filter out citation markers like [1], [perplexity+1], [perplexity-1], etc.
  // These appear in the middle of text and should be removed
  // Note: We preserve newlines and markdown formatting
  return content
    .replace(/\[(?:perplexity[+-])?\d+\]/g, '')
}

interface PerplexitySSEEvent {
  status?: string
  context_uuid?: string
  frontend_context_uuid?: string
  frontend_uuid?: string
  backend_uuid?: string
  read_write_token?: string
  thread_url_slug?: string
  thread_title?: string
  blocks?: PerplexityBlock[]
  related_query_items?: Array<{ text: string }>
}

interface PerplexityBlock {
  intended_usage?: string
  diff_block?: {
    field?: string
    patches?: PerplexityPatch[]
  }
  sources_mode_block?: {
    web_results?: any[]
  }
  media_block?: {
    media_items?: any[]
  }
}

interface PerplexityPatch {
  path?: string
  value?: string | { chunks?: string[] } | { answer?: string } | any
}

interface SessionTokens {
  context_uuid?: string
  frontend_context_uuid?: string
  backend_uuid?: string
  read_write_token?: string
  thread_url_slug?: string
}

export class PerplexityStreamHandler {
  private onConversation?: ConversationRequestOptions['onConversation']
  private model: string
  private sessionId: string
  private isFirstChunk: boolean = true
  private created: number
  private onEnd?: () => void
  private toolCallState: ToolCallState
  private adapter?: PerplexityAdapter
  private sessionTokens: SessionTokens = {}
  private accumulatedContent: string = ''
  private accumulatedReasoning: string = ''
  private sources: any[] = []
  private toolCallingPlan?: ToolCallingPlan

  constructor(
    model: string,
    sessionId: string,
    onEnd?: () => void,
    adapter?: PerplexityAdapter,
    toolCallingPlan?: ToolCallingPlan
  ) {
    this.model = model
    this.sessionId = sessionId
    this.created = Math.floor(Date.now() / 1000)
    this.onEnd = onEnd
    this.toolCallingPlan = toolCallingPlan
    this.toolCallState = createToolCallState(toolCallingPlan)
    this.adapter = adapter
  }

  getSessionTokens(): SessionTokens {
    return this.sessionTokens
  }

  setConversationListener(listener: ConversationRequestOptions['onConversation']): void {
    this.onConversation = listener
  }

  private recordConversation(event: PerplexitySSEEvent): void {
    const tokens = Object.fromEntries(
      ['context_uuid', 'backend_uuid', 'read_write_token', 'thread_url_slug', 'frontend_context_uuid']
        .filter(key => typeof event[key as keyof PerplexitySSEEvent] === 'string' && event[key as keyof PerplexitySSEEvent])
        .map(key => [key, event[key as keyof PerplexitySSEEvent]]),
    ) as SessionTokens
    this.sessionTokens = { ...this.sessionTokens, ...tokens }
    if (!Object.keys(tokens).length) return
    const state = this.adapter?.updateSessionData(this.sessionTokens)
    if (state) {
      this.sessionId = state.sessionId
      this.onConversation?.(state)
    } else if (!this.adapter && this.sessionTokens.backend_uuid) {
      this.sessionId = this.sessionTokens.context_uuid || this.sessionId || this.sessionTokens.backend_uuid
      this.onConversation?.({
        sessionId: this.sessionId,
        parentMessageId: this.sessionTokens.backend_uuid,
        extras: Object.fromEntries(Object.entries(this.sessionTokens).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
      })
    }
  }

  private formatStreamError(errorMsg: string): string {
    if (errorMsg.includes('ERR_CONNECTION_RESET') || errorMsg.includes('net::ERR_CONNECTION_RESET')) {
      return 'Network connection reset during streaming. Please check your network connection and try again.'
    }
    if (errorMsg.includes('ERR_CONNECTION_REFUSED') || errorMsg.includes('net::ERR_CONNECTION_REFUSED')) {
      return 'Connection refused during streaming. The server may be temporarily unavailable.'
    }
    if (errorMsg.includes('ERR_CONNECTION_TIMED_OUT') || errorMsg.includes('net::ERR_CONNECTION_TIMED_OUT')) {
      return 'Connection timed out during streaming. Please check your network and try again.'
    }
    if (errorMsg.includes('ERR_SSL') || errorMsg.includes('SSL')) {
      return 'SSL/TLS handshake failed during streaming. Please check your network security settings.'
    }
    if (errorMsg.includes('ERR_NETWORK_CHANGED') || errorMsg.includes('net::ERR_NETWORK_CHANGED')) {
      return 'Network changed during streaming. Please try again.'
    }
    
    return `Stream error: ${errorMsg}`
  }

  private parseSSE(data: string): PerplexitySSEEvent | null {
    try {
      return JSON.parse(data)
    } catch {
      return null
    }
  }

  private createChunk(delta: { role?: string; content?: string; reasoning_content?: string; tool_calls?: any[] }, finishReason?: string): string {
    return `data: ${JSON.stringify({
      id: this.sessionId,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason || null,
      }],
      created: this.created,
    })}\n\n`
  }

  async handleStream(stream: NodeJS.ReadableStream): Promise<NodeJS.ReadableStream> {
    const transStream = new PassThrough()
    let buffer = ''
    const decoder = new StringDecoder('utf8')
    let doneCalled = false
    transStream.once('close', () => {
      const upstream = stream as PassThrough
      if (!transStream.readableEnded && !upstream.readableEnded && !upstream.destroyed) upstream.destroy?.()
    })

    stream.on('data', (chunk: Buffer) => {
      if (doneCalled) return
      const chunkStr = decoder.write(chunk)
      buffer += chunkStr
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.trim()) continue

        if (line.startsWith('event:')) continue

        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data === '[DONE]') {
            if (!doneCalled) {
              doneCalled = true
              this.handleDone(transStream)
            }
            return
          }

          const parsed = this.parseSSE(data)
          if (!parsed) continue
          if (['failed', 'error', 'cancelled'].includes(parsed.status?.toLowerCase() || '')) {
            doneCalled = true
            transStream.destroy(new Error('Perplexity did not complete the current turn'))
            return
          }
          this.processEvent(parsed, transStream)
          if (parsed.status?.toLowerCase() === 'completed' && !doneCalled) {
            doneCalled = true
            this.handleDone(transStream)
            return
          }
        }
      }
    })

    stream.on('end', () => {
      if (buffer.trim()) {
        // Process remaining buffer if needed
      }
      if (!doneCalled) {
        doneCalled = true
        transStream.destroy(new Error('Perplexity stream ended without a completed terminal event'))
      }
    })

    stream.on('error', (err) => {
      console.error('[Perplexity Stream] Stream error:', err)
      const errorMessage = err.message || String(err)
      const userFriendlyError = this.formatStreamError(errorMessage)
      transStream.destroy(new Error(userFriendlyError))
    })

    return transStream
  }

  private processEvent(event: PerplexitySSEEvent, transStream: PassThrough): void {
    this.recordConversation(event)

    if (event.blocks) {
      for (const block of event.blocks) {
        this.processBlock(block, transStream)
      }
    }
  }

  private processBlock(block: PerplexityBlock, transStream: PassThrough): void {
    if (block.intended_usage === 'sources_answer_mode') {
      this.sources = block.sources_mode_block?.web_results || []
      return
    }

    if (block.intended_usage === 'media_items') {
      return
    }

    if (!block.diff_block?.patches) return

    const field = block.diff_block.field
    const isMarkdownBlock = field === 'markdown_block'

    for (const patch of block.diff_block.patches) {
      const path = patch.path || ''
      
      if (path === '/progress') continue

      let value = patch.value
      if (!value) continue

      if (typeof value === 'object' && 'chunks' in value) {
        value = (value as { chunks?: string[] }).chunks?.join('') || ''
      }

      if (path.startsWith('/goals')) {
        this.handleReasoning(value, transStream)
        continue
      }

      if (!isMarkdownBlock) continue

      if (typeof value === 'object' && 'answer' in value) {
        value = (value as { answer?: string }).answer || ''
      }

      if (typeof value === 'string' && value) {
        this.handleContent(value, transStream)
      }
    }
  }

  private handleReasoning(value: any, transStream: PassThrough): void {
    let content = ''
    if (typeof value === 'string') {
      content = value
    } else if (typeof value === 'object' && value !== null) {
      return
    }

    if (!content) return

    if (content.startsWith(this.accumulatedReasoning)) {
      content = content.slice(this.accumulatedReasoning.length)
    }

    if (!content) return

    this.accumulatedReasoning += content

    const delta: { role?: string; reasoning_content?: string } = {}
    
    if (this.isFirstChunk) {
      delta.role = 'assistant'
      this.isFirstChunk = false
    }

    delta.reasoning_content = content
    transStream.write(this.createChunk(delta))
  }

  private handleContent(content: string, transStream: PassThrough): void {
    if (content.startsWith(this.accumulatedContent)) {
      content = content.slice(this.accumulatedContent.length)
    } else if (this.accumulatedContent.endsWith(content)) {
      return
    }

    if (!content) return

    this.accumulatedContent += content

    // Filter out citation markers from the content
    // Citation-looking JSON such as [1] inside a tool argument is literal data.
    const filteredContent = this.toolCallingPlan?.tools.length ? content : filterCitations(content)
    if (!filteredContent) return

    const baseChunk = createBaseChunk(this.sessionId, this.model, this.created)
    const { chunks, shouldFlush } = processStreamContent(
      filteredContent,
      this.toolCallState,
      baseChunk,
      this.isFirstChunk,
      'perplexity'
    )

    for (const chunk of chunks) {
      transStream.write(`data: ${JSON.stringify(chunk)}\n\n`)
      this.isFirstChunk = false
    }

    if (this.toolCallState.isBufferingToolCall || this.toolCallState.hasEmittedToolCall) {
      return
    }

    if (chunks.length > 0) {
      return
    }

    const delta: { role?: string; content?: string } = {}
    
    if (this.isFirstChunk) {
      delta.role = 'assistant'
      this.isFirstChunk = false
    }

    delta.content = content
    transStream.write(this.createChunk(delta))
  }

  private handleDone(transStream: PassThrough): void {
    const baseChunk = createBaseChunk(this.sessionId, this.model, this.created)
    const flushChunks = flushToolCallBuffer(this.toolCallState, baseChunk, 'perplexity')
    for (const outChunk of flushChunks) {
      transStream.write(`data: ${JSON.stringify(outChunk)}\n\n`)
    }

    if (this.sources.length > 0) {
      const citations = this.sources
        .filter(r => r.cite_index)
        .sort((a, b) => a.cite_index - b.cite_index)
        .map(r => `[${r.cite_index}]: [${r.title}](${r.url})`)
        .join('\n')
      
      if (citations) {
        transStream.write(this.createChunk({ content: `\n\n${citations}` }))
      }
    }

    const finishReason = this.toolCallState.hasEmittedToolCall ? 'tool_calls' : 'stop'

    transStream.write(this.createChunk({}, finishReason))
    transStream.write('data: [DONE]\n\n')
    transStream.end()
    
    this.onEnd?.()
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<any> {
    return new Promise((resolve, reject) => {
      let buffer = ''
      const decoder = new StringDecoder('utf8')
      let completed = false

      stream.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk)
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.trim()) continue

          if (line.startsWith('event:')) continue

          if (line.startsWith('data:')) {
            const data = line.slice(5).trim()
            if (data === '[DONE]') {
              completed = true
              return
            }

            try {
              const parsed = JSON.parse(data)
              if (['failed', 'error', 'cancelled'].includes(parsed.status?.toLowerCase() || '')) {
                reject(new Error('Perplexity did not complete the current turn'))
                return
              }
              this.processEventForNonStream(parsed)
              if (parsed.status?.toLowerCase() === 'completed') completed = true
            } catch {
              // Ignore parse errors
            }
          }
        }
      })

      stream.on('end', () => {
        if (!completed) {
          reject(new Error('Perplexity stream ended without a completed terminal event'))
          return
        }
        // Filter citations from accumulated content
        const filteredAccumulatedContent = this.toolCallingPlan?.tools.length ? this.accumulatedContent : filterCitations(this.accumulatedContent)
        // The forwarder applies the declared schema once, after collection.
        const { content: cleanContent, toolCalls } = this.toolCallingPlan
          ? { content: filteredAccumulatedContent, toolCalls: [] } : parseToolCallsFromText(filteredAccumulatedContent)

        const message: any = {
          role: 'assistant',
        }
        
        if (this.accumulatedReasoning) {
          message.reasoning_content = filterCitations(this.accumulatedReasoning.trim())
        }
        
        message.content = toolCalls.length > 0 ? null : cleanContent.trim()

        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls
        }

        resolve({
          id: this.sessionId,
          model: this.model,
          object: 'chat.completion',
          choices: [{
            index: 0,
            message,
            finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          created: this.created,
        })
      })

      stream.on('error', (err) => {
        const errorMessage = err.message || String(err)
        const userFriendlyError = this.formatStreamError(errorMessage)
        reject(new Error(userFriendlyError))
      })
    })
  }

  private processEventForNonStream(event: PerplexitySSEEvent): void {
    this.recordConversation(event)

    if (event.blocks) {
      for (const block of event.blocks) {
        this.processBlockForNonStream(block)
      }
    }
  }

  private processBlockForNonStream(block: PerplexityBlock): void {
    if (block.intended_usage === 'sources_answer_mode') {
      this.sources = block.sources_mode_block?.web_results || []
      return
    }

    if (!block.diff_block?.patches) return

    const field = block.diff_block.field
    const isMarkdownBlock = field === 'markdown_block'

    for (const patch of block.diff_block.patches) {
      const path = patch.path || ''
      
      if (path === '/progress') continue

      let value = patch.value
      if (!value) continue

      if (typeof value === 'object' && 'chunks' in value) {
        value = (value as { chunks?: string[] }).chunks?.join('') || ''
      }

      if (path.startsWith('/goals')) {
        if (typeof value === 'string') {
          // Check for duplicate reasoning content
          if (value.startsWith(this.accumulatedReasoning)) {
            value = value.slice(this.accumulatedReasoning.length)
          }
          if (value) {
            this.accumulatedReasoning += value
          }
        }
        continue
      }

      if (!isMarkdownBlock) continue

      if (typeof value === 'object' && 'answer' in value) {
        value = (value as { answer?: string }).answer || ''
      }

      if (typeof value === 'string' && value) {
        // Check for duplicate content - same logic as handleContent
        if (value.startsWith(this.accumulatedContent)) {
          value = value.slice(this.accumulatedContent.length)
        } else if (this.accumulatedContent.endsWith(value)) {
          continue
        }
        
        if (value) {
          this.accumulatedContent += value
        }
      }
    }
  }
}
