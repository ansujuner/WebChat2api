import { Transform, type TransformCallback } from 'node:stream'
import { TextDecoder } from 'node:util'

interface CompletionOptions { model: string; prompt: string; echo?: boolean }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const finishReasons = ['stop', 'length', 'content_filter']

function metadata(body: Record<string, any>, model: string) {
  return { id: typeof body.id === 'string' ? body.id.replace(/^chatcmpl-/, 'cmpl-') : 'cmpl-proxy',
    object: 'text_completion', created: Number.isFinite(body.created) ? body.created : Math.floor(Date.now() / 1000),
    model: typeof body.model === 'string' ? body.model : model,
    ...(object(body.usage) ? { usage: body.usage } : {}) }
}

/** The legacy API is text-only. Never silently turn tool calls into an empty successful answer. */
export function convertChatToCompletion(body: unknown, options: CompletionOptions): Record<string, unknown> {
  if (!object(body) || body.error || !Array.isArray(body.choices) || !body.choices.length) throw new Error('Upstream returned an incomplete text completion.')
  const choices = body.choices.map((choice: any) => {
    if (!object(choice) || !Number.isInteger(choice.index) || choice.index < 0 || !object(choice.message) ||
      choice.message.role !== 'assistant' || (choice.message.content !== null && typeof choice.message.content !== 'string') ||
      choice.message.tool_calls?.length || !finishReasons.includes(choice.finish_reason)) throw new Error('Upstream response cannot be represented as a text completion.')
    return { text: (options.echo ? options.prompt : '') + (choice.message.content ?? ''), index: choice.index,
      logprobs: null, finish_reason: choice.finish_reason }
  })
  return { ...metadata(body, options.model), choices }
}

/** Translate the already-normalized chat SSE; no provider transport, retries or history of its own. */
export class LegacyCompletionStream extends Transform {
  private readonly options: CompletionOptions
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private pending = ''
  private done = false
  private failed = false
  private completed = false
  private seen = new Set<number>()
  private finished = new Set<number>()

  constructor(options: CompletionOptions) { super(); this.options = { ...options } }

  fail(error: unknown): void {
    if (this.completed || this.destroyed) return
    if (!this.failed) {
      this.failed = true
      const nested = object(error) && object(error.error) ? error.error : error
      const message = nested instanceof Error ? nested.message : object(nested) && typeof nested.message === 'string' ? nested.message : 'Upstream text completion stream failed.'
      this.push(`data: ${JSON.stringify({ error: { message: message.slice(0, 4096), type: 'upstream_stream_error' } })}\n\n`)
      this.emit('conversionError', new Error(message))
    }
    if (!this.writableEnded) this.end()
  }

  private parse(text: string): void {
    this.pending += text
    if (this.pending.length > 4 * 1024 * 1024) throw new Error('Upstream completion SSE frame is too large.')
    let separator: RegExpExecArray | null
    while (!this.failed && (separator = /\r?\n\r?\n/.exec(this.pending))) {
      const frame = this.pending.slice(0, separator.index)
      this.pending = this.pending.slice(separator.index + separator[0].length)
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data) continue
      if (this.done) throw new Error('Upstream sent data after completion.')
      if (data === '[DONE]') {
        if (!this.seen.size || this.finished.size !== this.seen.size) throw new Error('Upstream completion ended without a finish reason.')
        this.done = true
        continue
      }
      const value: unknown = JSON.parse(data)
      if (!object(value)) throw new Error('Invalid upstream completion event.')
      if (value.error) { this.fail(value); return }
      if (!Array.isArray(value.choices)) throw new Error('Invalid upstream completion choices.')
      const choices = value.choices.map((choice: any) => {
        if (!object(choice) || !Number.isInteger(choice.index) || choice.index < 0 || !object(choice.delta)) throw new Error('Invalid upstream completion delta.')
        if (choice.delta.tool_calls?.length || (choice.delta.content != null && typeof choice.delta.content !== 'string') ||
          (choice.finish_reason != null && !finishReasons.includes(choice.finish_reason))) throw new Error('Upstream event cannot be represented as text completion.')
        if (this.finished.has(choice.index)) throw new Error('Upstream sent a delta after a choice finished.')
        const prefix = this.options.echo && !this.seen.has(choice.index) ? this.options.prompt : ''
        this.seen = new Set([...this.seen, choice.index])
        if (choice.finish_reason != null) this.finished = new Set([...this.finished, choice.index])
        return { text: prefix + (choice.delta.content ?? ''), index: choice.index, logprobs: null, finish_reason: choice.finish_reason ?? null }
      })
      this.push(`data: ${JSON.stringify({ ...metadata(value, this.options.model), choices })}\n\n`)
    }
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try { if (!this.failed) this.parse(this.decoder.decode(chunk, { stream: true })) }
    catch (error) { this.fail(error) }
    callback()
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (!this.failed) {
        this.parse(this.decoder.decode())
        if (!this.done || this.pending.trim()) throw new Error('Upstream completion stream was interrupted.')
        this.completed = true
        this.push('data: [DONE]\n\n')
      }
    } catch (error) { this.fail(error) }
    callback()
  }
}
