import { Transform, type TransformCallback } from 'node:stream'
import type { ChatCompletionMessageToolCall, ChatMessage, SSEEvent } from './types.ts'
import { ConversationError, type ConversationTurn } from './conversationContinuity.ts'
import { SseFrameDecoder } from './sseFraming.ts'

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const invalid = (message: string) => new ConversationError(message, 'invalid_stream', 502)

/** Validate original OpenAI SSE before committing, or observe a stateless n=1 response without a session. */
export class ConversationStream extends Transform {
  private decoder = new SseFrameDecoder()
  private content = ''
  private calls = new Map<number, ChatCompletionMessageToolCall>()
  private done = false
  private committed = false
  private terminalChunks: Buffer[] = []
  private terminalBytes = 0
  private toolBytes = 0
  private turn?: ConversationTurn
  private finishReason = ''
  private validateMessage?: (message: ChatMessage, finishReason: string) => void

  constructor(turn?: ConversationTurn, validateMessage?: (message: ChatMessage, finishReason: string) => void) {
    super()
    this.turn = turn
    this.validateMessage = validateMessage
    this.once('error', () => this.turn?.fail())
    this.once('close', () => { if (!this.committed) this.turn?.fail() })
  }

  private accept(events: SSEEvent[]): void {
    for (const event of events) {
      if (event.event === 'error') throw invalid('Upstream returned a stream error.')
      const data = event.data.trim()
      if (!data) continue
      if (data === '[DONE]' && this.done) continue
      if (this.done) throw invalid('Data received after stream completion.')
      if (data === '[DONE]') {
        if (!this.finishReason) throw invalid('Upstream stream did not finish reliably.')
        this.done = true
        continue
      }
      let value: unknown
      try { value = JSON.parse(data) } catch { throw invalid('Upstream SSE contains invalid JSON.') }
      if (!object(value)) throw invalid('Upstream SSE contains an invalid event.')
      if (value.error || value.type === 'error') throw invalid('Upstream returned a stream error.')
      if (event.event === 'ping' || value.type === 'ping') continue
      if (!Array.isArray(value.choices)) {
        if (object(value.usage)) continue
        throw invalid('Upstream SSE is not an OpenAI chat-completion event.')
      }
      if (value.choices.length > 1) throw invalid('Streaming supports exactly one response choice.')
      for (const choice of value.choices) {
        if (!object(choice) || (choice.index !== undefined && choice.index !== 0)) throw invalid('Upstream SSE contains an invalid choice index.')
        const delta = choice.delta ?? {}
        if (!object(delta)) throw invalid('Upstream SSE contains an invalid delta.')
        if (delta.role !== undefined && delta.role !== 'assistant') throw invalid('Upstream stream role must be assistant.')
        if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') throw invalid('Upstream stream content must be text.')
        if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) throw invalid('Upstream stream contains invalid tool calls.')
        if (delta.function_call !== undefined) throw invalid('Legacy upstream function_call is unsupported; use tool_calls.')
        const calls = delta.tool_calls ?? [], content = typeof delta.content === 'string' ? delta.content : ''
        if (this.finishReason && (content || calls.length)) throw invalid('Upstream sent content after its finish reason.')
        this.content += content
        if (this.content.length > 16 * 1024 * 1024) throw invalid('Upstream response exceeds the supported size.')
        for (const call of calls) this.tool(call)
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (!['stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason)) throw invalid('Upstream returned an unsupported finish reason.')
          if (this.finishReason && this.finishReason !== choice.finish_reason) throw invalid('Upstream returned conflicting finish reasons.')
          this.finishReason = choice.finish_reason
        }
      }
    }
  }

  private tool(call: unknown): void {
    if (!object(call) || !Number.isSafeInteger(call.index) || call.index < 0 || call.index > 1023) throw invalid('Upstream tool-call index is invalid.')
    if (call.type !== undefined && call.type !== 'function') throw invalid('Upstream tool type is unsupported.')
    if (call.function !== undefined && !object(call.function)) throw invalid('Upstream tool definition is invalid.')
    const fn = call.function ?? {}
    for (const part of [call.id, fn.name, fn.arguments]) if (part !== undefined && part !== null && typeof part !== 'string') throw invalid('Upstream tool-call fragment is invalid.')
    const previous = this.calls.get(call.index)
    const id = call.id ?? '', name = fn.name ?? '', args = fn.arguments ?? ''
    this.toolBytes += id.length + name.length + args.length
    if (this.toolBytes > 16 * 1024 * 1024) throw invalid('Upstream tool arguments exceed the supported size.')
    const append = (before = '', fragment = '') => !fragment || fragment === before ? before : before + fragment
    this.calls.set(call.index, { id: append(previous?.id, id), type: 'function', function: {
      name: append(previous?.function.name, name), arguments: (previous?.function.arguments ?? '') + args,
    } })
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.accept(this.decoder.push(chunk))
      // Withhold final bytes until clean EOF; clients must not see DONE before the lock is committed.
      if (this.done) {
        this.terminalBytes += chunk.length
        if (this.terminalBytes > 4 * 1024 * 1024) throw invalid('Excessive data after stream completion.')
        this.terminalChunks = [...this.terminalChunks, Buffer.from(chunk)]
        callback()
      } else callback(null, chunk)
    } catch (error) {
      this.turn?.fail()
      callback(error instanceof Error ? error : invalid('Upstream stream validation failed.'))
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.accept(this.decoder.end())
      if (!this.done) throw new ConversationError('Upstream stream was interrupted.', 'incomplete_stream', 502)
      const calls = [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
      const ids = new Set<string>()
      for (const call of calls) {
        if (!call.id.trim() || !call.function.name.trim() || ids.has(call.id)) throw invalid('Upstream tool call has a missing or duplicate identity.')
        ids.add(call.id)
        let args: unknown
        try { args = JSON.parse(call.function.arguments.trim() || '{}') } catch { throw invalid('Upstream tool arguments are not complete JSON.') }
        if (!object(args)) throw invalid('Upstream tool arguments must be a JSON object.')
      }
      if (this.finishReason === 'tool_calls' && !calls.length) throw invalid('Upstream finished with tool_calls but supplied no tools.')
      const message: ChatMessage = { role: 'assistant', content: this.content || null, ...(calls.length ? { tool_calls: calls } : {}) }
      this.validateMessage?.(message, this.finishReason)
      this.turn?.commit(message)
      this.committed = true
      for (const chunk of this.terminalChunks) this.push(chunk)
      this.terminalChunks = []
      callback()
    } catch (error) {
      this.turn?.fail()
      callback(error instanceof Error ? error : invalid('Upstream stream validation failed.'))
    }
  }
}
