import type { ProxyStatus } from '@/types/electron'

interface ProxyStatusApi {
  proxy: {
    getStatus(): Promise<ProxyStatus>
    onStatusChanged(callback: (status: ProxyStatus) => void): () => void
  }
  config?: { onConfigChanged?(callback: () => void): () => void }
}

/** Configuration events trigger a fresh runtime snapshot, never overwrite a
 * live listener address. Revisions also discard stale initial IPC responses. */
export function observeProxyStatus(api: ProxyStatusApi, receive: (status: ProxyStatus) => void, onError: (error: unknown) => void) {
  let revision = 0
  let disposed = false
  const refresh = async () => {
    const requestedRevision = ++revision
    try {
      const status = await api.proxy.getStatus()
      if (!disposed && requestedRevision === revision) receive(status)
    } catch (error) {
      if (!disposed && requestedRevision === revision) onError(error)
    }
  }
  const unsubscribeStatus = api.proxy.onStatusChanged(status => {
    revision++
    if (!disposed) receive(status)
  })
  const unsubscribeConfig = api.config?.onConfigChanged?.(() => { void refresh() })
  void refresh()
  return {
    refresh,
    dispose() { disposed = true; revision++; unsubscribeStatus(); unsubscribeConfig?.() },
  }
}

export function localProxyOrigin(status: Pick<ProxyStatus, 'host' | 'port'>): string {
  const host = ['0.0.0.0', '::', '[::]'].includes(status.host) ? '127.0.0.1' : status.host
  return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${status.port}`
}
