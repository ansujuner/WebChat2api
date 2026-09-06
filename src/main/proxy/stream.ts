/**
 * Native OpenAI SSE support. Provider-specific formats belong in dedicated
 * adapters; this path never guesses tool calls from arbitrary assistant text.
 */
import { PassThrough, type Readable, type Transform } from 'node:stream'
import type { SSEEvent, ChatCompletionResponse, ChatCompletionChoice, ChatMessage } from './types.ts'
import { ConversationStream } from './conversationStream.ts'
import { SseFrameDecoder } from './sseFraming.ts'

export class SSEParser {
  private decoder = new SseFrameDecoder()
  parse(data: string): SSEEvent[] { return this.decoder.push(data) }
  end(): SSEEvent[] { return this.decoder.end() }
  reset(): void { this.decoder = new SseFrameDecoder() }
}

export class SSEFormatter {
  format(event: SSEEvent): string {
    const field = (value: string) => value.replace(/[\r\n]/g, '')
    return (event.id ? 'id: ' + field(event.id) + '\n' : '') +
      (event.event ? 'event: ' + field(event.event) + '\n' : '') +
      (event.retry !== undefined ? 'retry: ' + event.retry + '\n' : '') +
      event.data.split(/\r\n|\r|\n/).map(line => 'data: ' + line).join('\n') + '\n\n'
  }
  formatJSON(data: object, event?: string): string { return this.format({ event, data: JSON.stringify(data) }) }
  formatDone(): string { return 'data: [DONE]\n\n' }
}

export class StreamHandler {
  private readonly formatter = new SSEFormatter()

  /** A fresh validator per response preserves native chunks/usage/tools and requires real terminal EOF. */
  createTransformStream(_model: string, _responseId: string, onEnd?: () => void): Transform {
    const stream = new ConversationStream()
    if (onEnd) stream.once('finish', onEnd)
    return stream
  }

  /** Aggregate only a validated n=1 stream. An interrupted upstream can never become a successful response. */
  async streamToResponse(input: NodeJS.ReadableStream, model: string, responseId: string): Promise<ChatCompletionResponse> {
    const source = input as Readable
    let message: ChatMessage | undefined, finishReason: ChatCompletionChoice['finish_reason'] = null
    let reasoning = '', usage: ChatCompletionResponse['usage']
    const observer = new ConversationStream(undefined, (value, reason) => {
      message = value
      finishReason = reason as ChatCompletionChoice['finish_reason']
    })
    const fail = () => observer.destroy(new Error('Upstream stream could not be completed.'))
    source.once('error', fail)
    source.once('close', () => { if (!source.readableEnded) fail() })
    observer.once('close', () => { source.unpipe(observer); if (!source.readableEnded) source.destroy() })
    if (source.destroyed || source.readableEnded) observer.destroy(new Error('Upstream stream is unavailable.'))
    else source.pipe(observer)
    const parser = new SseFrameDecoder()
    const accept = (events: SSEEvent[]) => {
      for (const event of events) {
        if (!event.data.trim() || event.data.trim() === '[DONE]') continue
        const value = JSON.parse(event.data)
        const part = value.choices?.[0]?.delta?.reasoning_content
        if (typeof part === 'string') reasoning += part
        if (reasoning.length > 16 * 1024 * 1024) throw new Error('Upstream reasoning exceeds the supported size.')
        if (value.usage && typeof value.usage === 'object') {
          const count = (candidate: unknown, before = 0) => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? Math.max(candidate, before) : before
          const prompt = count(value.usage.prompt_tokens, usage?.prompt_tokens)
          const completion = count(value.usage.completion_tokens, usage?.completion_tokens)
          usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: count(value.usage.total_tokens, Math.max(usage?.total_tokens ?? 0, prompt + completion)) }
        }
      }
    }
    try {
      for await (const chunk of observer) accept(parser.push(chunk))
      accept(parser.end())
      if (!message || !finishReason) throw new Error('Upstream stream did not contain a completed message.')
      return { id: responseId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { ...message, role: 'assistant', content: typeof message.content === 'string' ? message.content : null, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      }
    } catch (error) {
      source.unpipe(observer); source.destroy(); observer.destroy()
      throw error
    } finally { source.removeListener('error', fail) }
  }

  createPassThrough(): PassThrough { return new PassThrough() }
  writeSSEEvent(stream: PassThrough, data: object): void { stream.write(this.formatter.formatJSON(data)) }
  writeSSEDone(stream: PassThrough): void { stream.end(this.formatter.formatDone()) }

  /** Errors are protocol errors, never successful assistant content followed by DONE. */
  createErrorStream(_model: string, _responseId: string, error: string): PassThrough {
    const stream = new PassThrough()
    stream.end(this.formatter.formatJSON({ error: { type: 'upstream_stream_error', message: error.slice(0, 4096) } }))
    return stream
  }
}
export const streamHandler = new StreamHandler()
export default streamHandler
