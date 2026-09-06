/** Per-provider routing. Missing values preserve the existing global default. */
export type ProviderNetworkProxyMode = 'inherit' | 'system' | 'none' | 'custom'
export type ProviderProxyConfig = { mode: 'system' | 'none' } | { mode: 'custom'; url: string }
export interface ProviderNetworkStatus {
  mode: 'system' | 'none' | 'custom'
  /** Route resolution, not connectivity or login verification. */
  route: 'direct' | 'proxy' | 'unknown'
}

export function validateProviderNetworkMode(value: unknown): asserts value is ProviderNetworkProxyMode | undefined {
  if (value !== undefined && value !== 'inherit' && value !== 'system' && value !== 'none' && value !== 'custom') {
    throw new Error('Provider network proxy mode must be inherit, system, none or custom')
  }
}

/** Fixed proxy endpoint only. Never accept passwords, PAC scripts or target URL components. */
export function normalizeProviderProxyUrl(value: unknown): string {
  const invalid = () => new Error('Proxy address must be http, https or socks5://host:port without credentials, path, query or fragment')
  if (typeof value !== 'string' || value.length > 2048 || !value.trim() || /\s/.test(value.trim())) throw invalid()
  const input = value.trim()
  // Chromium accepts a proxy RULE list, not just a URL. Reject rule separators
  // and percent-encoded hosts before URL parsing can decode them into syntax.
  const endpoint = /^(https?|socks5):\/\/(\[[0-9a-f:.]+\]|[^\[\]:/]+):(\d{1,5})\/?$/i.exec(input)
  if (!endpoint || /[\\?#@%;,=]/.test(input)) throw invalid()
  let url: URL
  try { url = new URL(input) } catch { throw invalid() }
  const port = endpoint[3]
  const host = url.hostname.toLowerCase()
  const dnsHost = host.endsWith('.') ? host.slice(0, -1) : host
  const validHost = host.startsWith('[')
    ? /^\[[0-9a-f:.]+\]$/.test(host) // URL has already validated IPv6 syntax.
    : dnsHost.length <= 253 && dnsHost.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/') || !port
    || Number(port) < 1 || Number(port) > 65535 || !validHost) throw invalid()
  return `${url.protocol}//${host}:${Number(port)}`
}

export function validateProviderNetworkSettings(value: { networkProxyMode?: unknown; networkProxyUrl?: unknown }): void {
  validateProviderNetworkMode(value.networkProxyMode)
  if (value.networkProxyUrl !== undefined) normalizeProviderProxyUrl(value.networkProxyUrl)
  if (value.networkProxyMode === 'custom' && value.networkProxyUrl === undefined) throw new Error('A custom proxy address is required')
}
