import type { Session } from 'electron'
import { applyProxyToSession } from './proxy'
import { normalizeNetworkProxyConfig, type ProviderProxyConfig } from './providerContext.ts'

/** Install once, before navigation, on an exclusively-owned browser Session.
 * Electron permits one listener per webRequest event. Do not use on a shared
 * session or combine with another onBeforeRequest/onCompleted/onErrorOccurred owner.
 * Only request IDs are retained; no URL, headers, body or credential is collected.
 */
export class OwnedSessionProxy {
  private active = new Set<number>()
  private queued = new Map<number, (result: { cancel?: boolean }) => void>()
  private changing = false
  private disposed = false
  private failed = false

  constructor(private readonly target: Session) {
    target.webRequest.onBeforeRequest((details, callback) => {
      if (this.disposed || this.failed) { callback({ cancel: true }); return }
      if (this.changing) { this.queued.set(details.id, callback); return }
      this.active.add(details.id)
      callback({})
    })
    const completed = (details: { id: number }): void => {
      this.active.delete(details.id)
      const queued = this.queued.get(details.id)
      this.queued.delete(details.id)
      queued?.({ cancel: true })
    }
    target.webRequest.onCompleted(completed)
    target.webRequest.onErrorOccurred(completed)
  }

  async apply(value: ProviderProxyConfig): Promise<void> {
    const config = normalizeNetworkProxyConfig(value)
    if (this.disposed) throw Object.assign(new Error('Browser proxy session was closed'), { code: 'cancelled' })
    // A webpage's manual generation counts too. Do not interrupt it or silently
    // submit a new API operation using the previous route.
    if (this.changing || this.active.size) throw Object.assign(new Error('Browser network is busy; retry when the current operation completes'), { code: 'busy' })
    this.changing = true
    let applied = false
    try {
      await applyProxyToSession(this.target, config, false)
      if (this.disposed) throw Object.assign(new Error('Browser proxy session was closed'), { code: 'cancelled' })
      // All old requests finished; new ones are queued above. Retiring pooled
      // sockets now cannot abort an answer or carry the next request via old routing.
      await this.target.closeAllConnections()
      if (this.disposed) throw Object.assign(new Error('Browser proxy session was closed'), { code: 'cancelled' })
      applied = true
      this.failed = false
    } finally {
      this.changing = false
      this.failed = !applied
      const pending = [...this.queued]
      this.queued.clear()
      for (const [id, callback] of pending) {
        if (applied && !this.disposed) { this.active.add(id); callback({}) }
        else callback({ cancel: true })
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const callback of this.queued.values()) callback({ cancel: true })
    this.queued.clear()
    this.active.clear()
    this.target.webRequest.onBeforeRequest(null)
    this.target.webRequest.onCompleted(null)
    this.target.webRequest.onErrorOccurred(null)
  }
}
