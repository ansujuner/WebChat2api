import { TextDecoder } from 'node:util'
import type { SSEEvent } from './types.ts'

/** Request-local SSE framing. Never dispatch a partial event or repair invalid UTF-8. */
export class SseFrameDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private line = ''
  private skipLF = false
  private data: string[] = []
  private event: Partial<SSEEvent> = {}
  private size = 0

  push(chunk: Buffer | string): SSEEvent[] {
    let text: string
    try { text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true }) }
    catch { throw new Error('Upstream SSE contains invalid UTF-8.') }
    return this.parse(text)
  }

  end(): SSEEvent[] {
    let text: string
    try { text = this.decoder.decode() } catch { throw new Error('Upstream SSE contains incomplete UTF-8.') }
    const events = this.parse(text)
    if (this.data.length || this.event.event || (this.line.trim() && !this.line.startsWith(':'))) throw new Error('Upstream SSE ended with an incomplete frame.')
    return events
  }

  private parse(text: string): SSEEvent[] {
    const events: SSEEvent[] = []
    if (this.skipLF && text) { if (text.startsWith('\n')) text = text.slice(1); this.skipLF = false }
    const breaks = /\r\n|\r|\n/g
    let offset = 0, match: RegExpExecArray | null
    while ((match = breaks.exec(text))) {
      const line = this.line + text.slice(offset, match.index)
      this.line = ''; offset = match.index + match[0].length
      if (match[0] === '\r' && offset === text.length) this.skipLF = true
      if (line === '') {
        if (this.data.length || this.event.event) events.push({ ...this.event, data: this.data.join('\n') })
        this.data = []; this.event = {}; this.size = 0
        continue
      }
      this.size += line.length
      if (this.size > 4 * 1024 * 1024) throw new Error('Upstream SSE frame exceeds the supported size.')
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon)
      const raw = colon < 0 ? '' : line.slice(colon + 1), value = raw.startsWith(' ') ? raw.slice(1) : raw
      if (field === 'data') this.data = [...this.data, value]
      else if (field === 'event') this.event = { ...this.event, event: value }
      else if (field === 'id' && !value.includes('\0')) this.event = { ...this.event, id: value }
      else if (field === 'retry' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) this.event = { ...this.event, retry: Number(value) }
    }
    this.line += text.slice(offset)
    if (this.line.length + this.size > 4 * 1024 * 1024) throw new Error('Upstream SSE frame exceeds the supported size.')
    return events
  }
}
