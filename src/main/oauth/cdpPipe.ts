import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

/** Private, inherited pipe transport. Never opens a TCP debugging endpoint. */
export class CdpPipe extends EventEmitter {
  private nextId = 0
  private buffer = Buffer.alloc(0)
  private closed = false
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()

  constructor(private readonly input: Writable, private readonly output: Readable) {
    super()
    output.on('data', this.receive)
    output.on('end', this.onClose)
    output.on('close', this.onClose)
    output.on('error', this.onClose)
    input.on('error', this.onClose)
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeout = 5000): Promise<any> {
    if (this.closed) return Promise.reject(new Error('The browser connection is closed.'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The browser did not respond in time.'))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`, error => {
          if (error) this.onClose()
        })
      } catch { this.onClose() }
    })
  }

  private receive = (chunk: Buffer | string): void => {
    if (this.closed) return
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
    // The login protocol expects only small metadata/token responses; bound malformed input.
    if (this.buffer.length > 2 * 1024 * 1024) { this.onClose(); return }
    let end: number
    while ((end = this.buffer.indexOf(0)) !== -1) {
      const frame = this.buffer.subarray(0, end)
      this.buffer = this.buffer.subarray(end + 1)
      if (!frame.length) continue
      let message: any
      try { message = JSON.parse(frame.toString('utf8')) } catch { this.onClose(); return }
      if (!message || typeof message !== 'object') { this.onClose(); return }
      const pending = this.pending.get(message.id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      // Remote error text may contain page URLs or credentials; never forward it to UI/logs.
      if (message.error) pending.reject(new Error('The browser command could not be completed.'))
      else pending.resolve(message.result ?? {})
    }
  }

  private onClose = (): void => {
    if (this.closed) return
    this.closed = true
    this.buffer = Buffer.alloc(0)
    for (const pending of Array.from(this.pending.values())) {
      clearTimeout(pending.timer)
      pending.reject(new Error('The browser connection is closed.'))
    }
    this.pending = new Map()
    this.emit('close')
  }

  close(): void {
    this.onClose()
    this.output.off('data', this.receive)
    // Retain error handlers until streams are destroyed, avoiding late unhandled EPIPE errors.
    this.input.destroy()
    this.output.destroy()
  }
}
