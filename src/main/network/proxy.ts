import { app, session, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { getProviderNetworkScope, getProviderProxyMode, getProviderProxyConfig, withProviderNetwork, normalizeNetworkProxyConfig, setConfiguredGlobalProxyMode, type NetworkProxyMode, type GlobalNetworkProxyMode, type ProviderProxyConfig } from './providerContext.ts'
export { getProviderProxyMode, getProviderProxyConfig, normalizeNetworkProxyConfig, setProviderProxyResolver, withProviderNetwork } from './providerContext.ts'
export type { NetworkProxyMode, ProviderProxyConfig } from './providerContext.ts'

export interface NetworkProxyStatus {
  mode: NetworkProxyMode
  /** Resolution only: this is not a connectivity or authentication test. */
  route: 'direct' | 'proxy' | 'unknown'
}

type ProxySession = Pick<Session, 'setProxy' | 'closeAllConnections'>
let active: Readonly<{ mode: GlobalNetworkProxyMode; session: Session }> | undefined
let pending: Promise<void> = Promise.resolve()
const providerSessions = new Map<string, Promise<Session>>()

export function validateNetworkProxyMode(mode: unknown): asserts mode is GlobalNetworkProxyMode {
  if (mode !== 'system' && mode !== 'none') throw new Error('Network proxy mode must be system or none')
}

/** Use for a newly-created login session, before its first navigation. */
export async function applyProxyToSession(target: ProxySession, value: ProviderProxyConfig | GlobalNetworkProxyMode, closeConnections = true): Promise<void> {
  const config = normalizeNetworkProxyConfig(value)
  await target.setProxy(config.mode === 'custom'
    ? { mode: 'fixed_servers', proxyRules: config.url, proxyBypassRules: '<-loopback>' }
    : { mode: config.mode === 'system' ? 'system' : 'direct' })
  if (closeConnections) await target.closeAllConnections()
}

/** Atomic replacement: changing settings must not terminate an in-flight answer. */
export function configureNetworkProxy(mode: GlobalNetworkProxyMode): Promise<void> {
  validateNetworkProxyMode(mode)
  const update = pending.then(async () => {
    await app.whenReady()
    const next = session.fromPartition(`chat2api-network-${randomUUID()}`, { cache: false })
    await applyProxyToSession(next, mode)
    active = Object.freeze({ mode, session: next })
    setConfiguredGlobalProxyMode(mode)
  })
  // A rejected setting is reported to its caller and never replaces the old one.
  pending = update.catch(() => {})
  return update
}

export async function getNetworkSession(providerId?: string): Promise<Session> {
  await pending
  if (!active) throw new Error('Network transport is not initialized; no request was sent')
  const scope = getProviderNetworkScope()
  const id = providerId ?? scope?.providerId
  if (id) {
    const config = scope?.providerId === id ? scope.config : getProviderProxyConfig(id)
    const key = JSON.stringify([id, config])
    let selected = providerSessions.get(key)
    if (!selected) {
      selected = (async () => {
        const target = session.fromPartition(`chat2api-provider-${randomUUID()}`, { cache: false })
        await applyProxyToSession(target, config)
        return target
      })()
      providerSessions.set(key, selected)
      selected.catch(() => { if (providerSessions.get(key) === selected) providerSessions.delete(key) })
    }
    return selected
  }
  return active.session
}

export async function getNetworkProxyStatus(providerId?: string, targetUrl = 'https://chat.deepseek.com/'): Promise<NetworkProxyStatus> {
  // Snapshot before the first await: the displayed mode must describe the same
  // configuration Chromium resolves, even if the user saves an edit meanwhile.
  return providerId ? withProviderNetwork(providerId, () => resolveNetworkProxyStatus(providerId, targetUrl))
    : resolveNetworkProxyStatus(undefined, targetUrl)
}

async function resolveNetworkProxyStatus(providerId: string | undefined, targetUrl: string): Promise<NetworkProxyStatus> {
  await pending
  const globalSnapshot = active
  const mode = providerId ? getProviderProxyMode(providerId) : globalSnapshot?.mode ?? 'system'
  if (!globalSnapshot) return { mode, route: 'unknown' }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const target = new URL(targetUrl)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return { mode, route: 'unknown' }
    const selected = providerId ? await getNetworkSession(providerId) : globalSnapshot.session
    // Chromium evaluates the operating system/PAC rules. Do not expose proxy
    // addresses, credentials, or send an account request for this diagnostic.
    const result = await Promise.race([
      selected.resolveProxy(target.href),
      new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error('Proxy resolution timeout')), 5000) }),
    ])
    const first = result.split(';', 1)[0].trim()
    const route = first === 'DIRECT' ? 'direct' : /^(PROXY|HTTPS|SOCKS4?|SOCKS5)\s/i.test(first) ? 'proxy' : 'unknown'
    return { mode, route }
  } catch {
    return { mode, route: 'unknown' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
