import { app, session, type Session } from 'electron'
import { randomUUID } from 'node:crypto'

export type NetworkProxyMode = 'system' | 'none'
export interface NetworkProxyStatus {
  mode: NetworkProxyMode
  /** Resolution only: this is not a connectivity or authentication test. */
  route: 'direct' | 'proxy' | 'unknown'
}

type ProxySession = Pick<Session, 'setProxy' | 'closeAllConnections'>
let active: Readonly<{ mode: NetworkProxyMode; session: Session }> | undefined
let pending: Promise<void> = Promise.resolve()

export function validateNetworkProxyMode(mode: unknown): asserts mode is NetworkProxyMode {
  if (mode !== 'system' && mode !== 'none') throw new Error('Network proxy mode must be system or none')
}

/** Use for a newly-created login session, before its first navigation. */
export async function applyProxyToSession(target: ProxySession, mode: NetworkProxyMode): Promise<void> {
  validateNetworkProxyMode(mode)
  await target.setProxy({ mode: mode === 'system' ? 'system' : 'direct' })
  await target.closeAllConnections()
}

/** Atomic replacement: changing settings must not terminate an in-flight answer. */
export function configureNetworkProxy(mode: NetworkProxyMode): Promise<void> {
  validateNetworkProxyMode(mode)
  const update = pending.then(async () => {
    await app.whenReady()
    const next = session.fromPartition(`chat2api-network-${randomUUID()}`, { cache: false })
    await applyProxyToSession(next, mode)
    active = Object.freeze({ mode, session: next })
  })
  // A rejected setting is reported to its caller and never replaces the old one.
  pending = update.catch(() => {})
  return update
}

export async function getNetworkSession(): Promise<Session> {
  await pending
  if (!active) throw new Error('Network transport is not initialized; no request was sent')
  return active.session
}

export async function getNetworkProxyStatus(): Promise<NetworkProxyStatus> {
  await pending
  const current = active
  if (!current) return { mode: 'system', route: 'unknown' }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Chromium evaluates the operating system/PAC rules. Do not expose proxy
    // addresses, credentials, or send an account request for this diagnostic.
    const result = await Promise.race([
      current.session.resolveProxy('https://chat.deepseek.com/'),
      new Promise<string>((_, reject) => { timer = setTimeout(() => reject(new Error('Proxy resolution timeout')), 5000) }),
    ])
    const first = result.split(';', 1)[0].trim()
    const route = first === 'DIRECT' ? 'direct' : /^(PROXY|HTTPS|SOCKS4?|SOCKS5)\s/i.test(first) ? 'proxy' : 'unknown'
    return { mode: current.mode, route }
  } catch {
    return { mode: current.mode, route: 'unknown' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
