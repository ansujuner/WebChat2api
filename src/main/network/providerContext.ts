import { AsyncLocalStorage } from 'node:async_hooks'
import { normalizeProviderProxyUrl, type ProviderProxyConfig } from '../../shared/providerNetwork.ts'
export type { ProviderProxyConfig } from '../../shared/providerNetwork.ts'

export type NetworkProxyMode = 'system' | 'none' | 'custom'
export type GlobalNetworkProxyMode = 'system' | 'none'
export interface ProviderNetworkScope { readonly providerId: string; readonly config: ProviderProxyConfig }
const scopes = new AsyncLocalStorage<Readonly<ProviderNetworkScope>>()
let readProviderMode: (id: string) => unknown = () => undefined
let readGlobalMode: (() => unknown) | undefined
let configuredGlobalMode: GlobalNetworkProxyMode = 'system'

/** Installed by main after store initialization; avoids bootstrap/store import cycles. */
export function setProviderProxyResolver(provider: (id: string) => unknown, global: () => unknown): void {
  if (typeof provider !== 'function' || typeof global !== 'function') throw new Error('Invalid provider proxy resolver')
  readProviderMode = provider
  readGlobalMode = global
}

export function setConfiguredGlobalProxyMode(mode: GlobalNetworkProxyMode): void { configuredGlobalMode = mode }

/** Accept legacy two-mode arguments only at trusted browser boundaries. */
export function normalizeNetworkProxyConfig(value: ProviderProxyConfig | GlobalNetworkProxyMode): ProviderProxyConfig {
  const input = typeof value === 'string' ? { mode: value } : value
  if (input?.mode === 'system' || input?.mode === 'none') return Object.freeze({ mode: input.mode })
  if (input?.mode === 'custom') return Object.freeze({ mode: 'custom', url: normalizeProviderProxyUrl(input.url) })
  throw new Error('Invalid network proxy configuration')
}

export function getProviderProxyConfig(providerId: string): ProviderProxyConfig {
  if (typeof providerId !== 'string' || !providerId.trim() || providerId.length > 256) throw new Error('Invalid network provider ID')
  const scope = scopes.getStore()
  if (scope?.providerId === providerId) return scope.config
  const value = readProviderMode(providerId)
  const settings = value && typeof value === 'object' ? value as { mode?: unknown; url?: unknown } : { mode: value }
  if (settings.mode === 'custom') return normalizeNetworkProxyConfig({ mode: 'custom', url: normalizeProviderProxyUrl(settings.url) })
  if (settings.mode === 'system' || settings.mode === 'none') return Object.freeze({ mode: settings.mode })
  if (settings.mode !== undefined && settings.mode !== 'inherit') throw new Error('Invalid provider proxy mode')
  const global = readGlobalMode ? readGlobalMode() : configuredGlobalMode
  if (global === undefined) return Object.freeze({ mode: 'system' })
  if (global !== 'system' && global !== 'none') throw new Error('Invalid global proxy mode')
  return Object.freeze({ mode: global })
}

export function getProviderProxyMode(providerId: string): NetworkProxyMode { return getProviderProxyConfig(providerId).mode }

export function getProviderNetworkScope(): Readonly<ProviderNetworkScope> | undefined { return scopes.getStore() }

/** An operation keeps its routing decision across awaits, callbacks and nested calls. */
export function withProviderNetwork<T>(providerId: string, task: () => T): T {
  if (typeof task !== 'function') throw new Error('Invalid provider network operation')
  const current = scopes.getStore()
  if (current?.providerId === providerId) return task()
  return scopes.run(Object.freeze({ providerId, config: getProviderProxyConfig(providerId) }), task)
}

/** EventEmitter/native callbacks do not inherit the listener's registration context. */
export function bindProviderNetwork<A extends unknown[], T>(providerId: string, task: (...args: A) => T): (...args: A) => T {
  const current = scopes.getStore()
  const scope = current?.providerId === providerId ? current : Object.freeze({ providerId, config: getProviderProxyConfig(providerId) })
  return (...args) => scopes.run(scope, () => task(...args))
}
