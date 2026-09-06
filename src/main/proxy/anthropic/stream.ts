import { randomUUID } from 'node:crypto'
import { Transform, type TransformCallback } from 'node:stream'
import { TextDecoder } from 'node:util'

export interface AnthropicStreamOptions {
  model?: string
  inputTokens?: number
  requestId?: string
}

interface ToolFragments {
  id: string
  name: string
  fragments: string[]
}

type JsonObject = Record<string, unknown>
type StopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'refusal'

const MAX_FRAME_SIZE = 4 * 1024 * 1024
const MAX_TOOL_SIZE = 16 * 1024 * 1024
const ERROR_TYPES = new Set([
  'api_error', 'invalid_request_error', 'authentication_error', 'permission_error',
  'not_found_error', 'rate_limit_error', 'overloaded_error',
])

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Translate OpenAI chat SSE to the Anthropic Messages event protocol.
 * Spec: https://platform.claude.com/docs/en/build-with-claude/streaming
 *
 * Text is streamed immediately. Interleaved tool arguments are retained until a
 * clean terminal stream, validated as objects, then emitted in tool-index order.
 * This prevents a completed tool block from authorizing execution of truncated
 * arguments. Original argument fragments remain input_json_delta events.
 * OpenAI reasoning_content is deliberately omitted: these providers cannot
 * produce Anthropic-signed thinking blocks, and signatures must not be invented.
 */
export class AnthropicStream extends Transform {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly options: AnthropicStreamOptions
  private lineBuffer = ''
  private skipLF = false
  private dataLines: string[] = []
  private eventName = ''
  private frameSize = 0
  private started = false
  private failed = false
  private done = false
  private completed = false
  private finishReason: string | undefined
  private responseModel = ''
  private inputTokens: number
  private hasInputUsage = false
  private outputTokens = 0
  private textIndex: number | undefined
  private nextIndex = 0
  private tools = new Map<number, ToolFragments>()
  private toolSize = 0

  constructor(options: AnthropicStreamOptions = {}) {
    super()
    this.options = { ...options }
    this.inputTokens = tokenCount(options.inputTokens) ?? 0
  }

  /** Convert a source/network failure to native SSE without discarding its error frame. */
  fail(error: unknown): void {
    if (this.completed || this.destroyed) return
    if (!this.failed) this.reportFailure(error)
    if (!this.writableEnded) this.end()
  }

  private event(type: string, data: JsonObject = {}): void {
    this.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  }

  private reportFailure(error: unknown): void {
    if (this.failed || this.completed) return
    this.failed = true
    const nested = object(error) && object(error.error) ? error.error : error
    const type = object(nested) && typeof nested.type === 'string' && ERROR_TYPES.has(nested.type)
      ? nested.type : 'api_error'
    const message = nested instanceof Error ? nested.message
      : object(nested) && typeof nested.message === 'string' ? nested.message
      : 'The upstream stream could not be completed.'
    this.event('error', {
      error: { type, message: message.slice(0, 4096) },
      ...(this.options.requestId ? { request_id: this.options.requestId } : {}),
    })
    this.tools.clear()
    this.dataLines = []
    this.lineBuffer = ''
    // Unlike Node's special "error" event, this notification cannot destroy the
    // readable before the native error frame reaches the client.
    this.emit('conversionError', new Error(message))
  }

  private start(): void {
    if (this.started) return
    this.started = true
    const requestId = this.options.requestId || randomUUID().replace(/-/g, '')
    this.event('message_start', { message: {
      id: requestId.startsWith('msg_') ? requestId : `msg_${requestId}`,
      type: 'message', role: 'assistant', content: [],
      model: this.options.model || this.responseModel || 'unknown',
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: this.inputTokens, output_tokens: 0 },
    } })
  }

  private parse(text: string): void {
    if (this.failed) return
    if (this.skipLF) {
      if (text.startsWith('\n')) text = text.slice(1)
      this.skipLF = false
    }
    if (!text) return
    const lines = /\r\n|\r|\n/g
    let offset = 0
    let match: RegExpExecArray | null
    while ((match = lines.exec(text))) {
      const line = this.lineBuffer + text.slice(offset, match.index)
      this.lineBuffer = ''
      offset = match.index + match[0].length
      this.line(line)
      if (this.failed) return
      if (match[0] === '\r' && offset === text.length) this.skipLF = true
    }
    this.lineBuffer += text.slice(offset)
    if (this.lineBuffer.length + this.frameSize > MAX_FRAME_SIZE) {
      throw new Error('The upstream SSE frame exceeds the supported size.')
    }
  }

  private line(line: string): void {
    if (line === '') {
      const data = this.dataLines.join('\n')
      const eventName = this.eventName
      this.dataLines = []
      this.eventName = ''
      this.frameSize = 0
      this.frame(data, eventName)
      return
    }
    this.frameSize += line.length
    if (this.frameSize > MAX_FRAME_SIZE) throw new Error('The upstream SSE frame exceeds the supported size.')
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    const raw = colon < 0 ? '' : line.slice(colon + 1)
    const value = raw.startsWith(' ') ? raw.slice(1) : raw
    if (field === 'data') this.dataLines = [...this.dataLines, value]
    else if (field === 'event') this.eventName = value
  }

  private frame(data: string, eventName: string): void {
    if (eventName === 'error' && !data.trim()) {
      this.reportFailure({ message: 'The upstream stream returned an error.' })
      return
    }
    if (!data.trim()) {
      if (eventName === 'ping' && !this.done) { this.start(); this.event('ping') }
      return
    }
    if (data.trim() === '[DONE]') {
      if (!this.finishReason) throw new Error('The upstream stream ended without a finish reason.')
      this.done = true
      return
    }
    if (this.done) throw new Error('Unexpected upstream data after stream completion.')
    let value: unknown
    try { value = JSON.parse(data) } catch { throw new Error('The upstream stream contains invalid JSON.') }
    if (!object(value)) throw new Error('The upstream stream contains an invalid event.')
    if (eventName === 'error' || value.error || value.type === 'error') {
      this.reportFailure(value)
      return
    }
    if (eventName === 'ping' || value.type === 'ping') {
      this.start()
      this.event('ping')
      return
    }
    if (typeof value.model === 'string') this.responseModel = value.model
    this.usage(value.usage)
    if (!Array.isArray(value.choices)) {
      if (object(value.usage)) { this.start(); return }
      throw new Error('The upstream event is not an OpenAI chat-completion chunk.')
    }
    if (value.choices.length > 1) throw new Error('Multiple response choices cannot be converted to one Anthropic message.')
    this.start()
    for (const choice of value.choices) {
      if (!object(choice) || (choice.index !== undefined && choice.index !== 0)) {
        throw new Error('The upstream stream contains an invalid response choice.')
      }
      const delta = choice.delta ?? {}
      if (!object(delta)) throw new Error('The upstream stream contains an invalid response delta.')
      if (delta.role !== undefined && delta.role !== 'assistant') throw new Error('The upstream stream role must be assistant.')
      if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') {
        throw new Error('The upstream stream contains unsupported non-text content.')
      }
      if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) {
        throw new Error('The upstream stream contains invalid tool calls.')
      }
      const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
      const content = typeof delta.content === 'string' ? delta.content : ''
      if (this.finishReason && (content || calls.length || delta.function_call)) {
        throw new Error('The upstream stream sent content after its finish reason.')
      }
      if (delta.function_call !== undefined) throw new Error('Legacy function_call deltas are not supported; use tool_calls.')
      if (content) this.text(content)
      for (const call of calls) this.tool(call)
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== 'string' || !['stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason)) {
          throw new Error('The upstream stream returned an unsupported finish reason.')
        }
        if (this.finishReason && this.finishReason !== choice.finish_reason) {
          throw new Error('The upstream stream returned conflicting finish reasons.')
        }
        this.finishReason = choice.finish_reason
      }
    }
  }

  private usage(value: unknown): void {
    if (!object(value)) return
    const input = tokenCount(value.prompt_tokens)
    const output = tokenCount(value.completion_tokens)
    if (input !== undefined) {
      this.inputTokens = this.hasInputUsage ? Math.max(this.inputTokens, input) : input
      this.hasInputUsage = true
    }
    if (output !== undefined) this.outputTokens = Math.max(this.outputTokens, output)
  }

  private text(content: string): void {
    if (this.textIndex === undefined) {
      this.textIndex = this.nextIndex++
      this.event('content_block_start', { index: this.textIndex, content_block: { type: 'text', text: '' } })
    }
    this.event('content_block_delta', { index: this.textIndex, delta: { type: 'text_delta', text: content } })
  }

  private tool(value: unknown): void {
    if (!object(value) || !Number.isSafeInteger(value.index) || (value.index as number) < 0 || (value.index as number) > 1023) {
      throw new Error('The upstream stream contains an invalid tool-call index.')
    }
    if (value.type !== undefined && value.type !== 'function') throw new Error('The upstream tool type is unsupported.')
    if (value.function !== undefined && !object(value.function)) throw new Error('The upstream tool definition is invalid.')
    const fn = object(value.function) ? value.function : {}
    for (const part of [value.id, fn.name, fn.arguments]) {
      if (part !== undefined && part !== null && typeof part !== 'string') throw new Error('The upstream tool-call fragment is invalid.')
    }
    const index = value.index as number
    const previous = this.tools.get(index) ?? { id: '', name: '', fragments: [] }
    const id = typeof value.id === 'string' ? value.id : ''
    const name = typeof fn.name === 'string' ? fn.name : ''
    const args = typeof fn.arguments === 'string' ? fn.arguments : ''
    this.toolSize += id.length + name.length + args.length
    if (this.toolSize > MAX_TOOL_SIZE) throw new Error('The upstream tool arguments exceed the supported size.')
    this.tools.set(index, {
      id: !id || id === previous.id ? previous.id : previous.id + id,
      name: !name || name === previous.name ? previous.name : previous.name + name,
      fragments: args ? [...previous.fragments, args] : previous.fragments,
    })
  }

  private finish(): void {
    if (!this.done || !this.finishReason) throw new Error('The upstream stream was interrupted before completion.')
    if (this.dataLines.length || this.eventName || (this.lineBuffer.trim() && !this.lineBuffer.startsWith(':'))) {
      throw new Error('The upstream stream ended with an incomplete SSE frame.')
    }
    const tools = [...this.tools.entries()].sort(([left], [right]) => left - right).map(([, value]) => value)
    const ids = new Set<string>()
    // Validate every tool before emitting any completed tool block.
    for (const tool of tools) {
      if (!tool.id.trim() || !tool.name.trim() || ids.has(tool.id)) throw new Error('The upstream tool call has a missing or duplicate identity.')
      ids.add(tool.id)
      let input: unknown
      try { input = JSON.parse(tool.fragments.join('').trim() || '{}') } catch { throw new Error('The upstream tool arguments are not complete JSON.') }
      if (!object(input)) throw new Error('The upstream tool arguments must be a JSON object.')
    }
    if (this.finishReason === 'tool_calls' && !tools.length) throw new Error('The upstream stream finished with tool_calls but supplied no tools.')
    this.start()
    // An empty text block can be sent back in a valid non-empty Messages content
    // array on the next turn, unlike content: []. Match the nonstream converter.
    if (this.textIndex === undefined && !tools.length) this.text('')
    if (this.textIndex !== undefined) this.event('content_block_stop', { index: this.textIndex })
    for (const tool of tools) {
      const index = this.nextIndex++
      this.event('content_block_start', { index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } })
      for (const fragment of tool.fragments.join('').trim() ? tool.fragments : ['{}']) {
        this.event('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: fragment } })
      }
      this.event('content_block_stop', { index })
    }
    const stopReason: StopReason = this.finishReason === 'length' ? 'max_tokens'
      : this.finishReason === 'content_filter' ? 'refusal'
      : tools.length ? 'tool_use' : 'end_turn'
    this.event('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: this.inputTokens, output_tokens: this.outputTokens },
    })
    this.event('message_stop')
    this.completed = true
    this.tools.clear()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      if (!this.failed) this.parse(this.decoder.decode(chunk, { stream: true }))
    } catch (error) { this.reportFailure(error) }
    callback()
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (!this.failed) { this.parse(this.decoder.decode()); this.finish() }
    } catch (error) { this.reportFailure(error) }
    callback()
  }
}
