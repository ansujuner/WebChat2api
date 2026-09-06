/** Normal browser-origin checks; no fingerprint changes or anti-detection behavior. */
export function isProviderHost(host: unknown, domains: readonly string[]): boolean {
  if (typeof host !== 'string') return false
  const normalized = host.toLowerCase().replace(/^\./, '').replace(/\.$/, '')
  return domains.some(value => {
    const domain = value.toLowerCase().replace(/^\./, '').replace(/\.$/, '')
    return !!domain && (normalized === domain || normalized.endsWith(`.${domain}`))
  })
}
export function isProviderUrl(url: string, domains: readonly string[]): boolean {
  try {
    const parsed = new URL(url)
    return ['https:', 'http:'].includes(parsed.protocol) && isProviderHost(parsed.hostname, domains)
  } catch { return false }
}
export function isBrowserLoginUrl(url: string): boolean {
  if (url === 'about:blank') return true
  try {
    const parsed = new URL(url)
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password
  } catch { return false }
}
/** Syntactic candidate only; actual account validation belongs to the provider adapter. */
export function isCredentialCandidate(value: unknown, now = Date.now()): value is string {
  if (typeof value !== 'string' || value.length < 5 || value.length > 128 * 1024 || /\s/.test(value)) return false
  if (value.startsWith('eyJ')) {
    const parts = value.split('.')
    if (parts.length === 5) return value.length >= 100
    if (parts.length !== 3) return false
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
      if (typeof payload.exp === 'number' && payload.exp * 1000 <= now) return false
      if (payload.is_anonymous === true || payload.isAnonymous === true || payload.guest === true) return false
      if (typeof payload.email === 'string' && payload.email.toLowerCase().endsWith('@guest.com')) return false
      return ['app_id', 'sub', 'exp', 'id', 'user_id', 'uid', 'email'].some(key => payload[key] !== undefined)
    } catch { return false }
  }
  return true
}
export function storedCredential(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value)
      return typeof parsed?.value === 'string' ? parsed.value : undefined
    } catch { return undefined }
  }
  return value
}
export function loginLoadError(code?: string | number): string {
  const value = String(code ?? '')
  if (/PROXY|TUNNEL/.test(value) || ['-130', '-111'].includes(value)) return 'The login page could not connect through the selected proxy. Check network settings and retry.'
  if (/CERT/.test(value) || /^-20[0-9]$/.test(value)) return 'The login page certificate could not be verified. Check your system clock and network; certificate checks remain enabled.'
  return 'The login page could not be loaded. Check the network and retry. If this website does not support embedded browsers, use its normal browser login and the supported manual account import.'
}
