/** Web protocol observed in DeepSeek's official main.2029023598.js, 2026-09-06.
 * Inspect structured error/user metadata only; generated prose is never an account signal.
 */
export interface DeepSeekRestriction {
  kind: 'temporary' | 'permanent'
  until?: number
}

const object = (value: unknown): Record<string, any> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined

function expiry(value: unknown, now: number): number | undefined {
  // Official mute_until/end_at fields use epoch seconds, not duration or local-time strings.
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d{9,11}(?:\.\d{1,3})?$/.test(value) ? Number(value) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 99999999999) return undefined
  const milliseconds = seconds * 1000
  return Number.isSafeInteger(milliseconds) && milliseconds > now && milliseconds <= 8640000000000000 ? milliseconds : undefined
}

export function parseDeepSeekRestriction(payload: unknown, mode: 'api' | 'completion' = 'api', now = Date.now()): DeepSeekRestriction | undefined {
  const root = object(payload)
  if (!root) return undefined
  const nodes = [root, object(root.data), object(root.error), object(root.data?.error)]
  for (const node of nodes) {
    if (!node) continue
    const code = node.code ?? node.biz_code
    if (code === 40012 || code === '40012') return { kind: 'permanent' }
    if (code === 50006 || code === '50006' || (mode === 'completion' && (code === 5 || code === '5'))) {
      const detail = object(node.data) ?? object(node.biz_data) ?? node
      const until = expiry(detail.end_at ?? detail.mute_until, now)
      return { kind: 'temporary', ...(until ? { until } : {}) }
    }
  }
  // Token/user responses can be successful while the account is temporarily muted.
  const data = object(root.data?.biz_data) ?? object(root.biz_data)
  const user = object(data?.user) ?? data
  const chat = object(user?.chat)
  if (chat?.is_muted === true) {
    const until = expiry(chat.mute_until, now)
    return { kind: 'temporary', ...(until ? { until } : {}) }
  }
  return undefined
}

export class DeepSeekAccountRestrictionError extends Error {
  readonly status = 429
  readonly code: 'account_temporarily_suspended' | 'account_banned'
  readonly restriction: DeepSeekRestriction
  constructor(restriction: DeepSeekRestriction) {
    super(restriction.kind === 'permanent'
      ? 'DeepSeek has suspended this account. It is excluded from selection and requires manual review.'
      : restriction.until
        ? `DeepSeek temporarily suspended this account until ${new Date(restriction.until).toISOString()}. No request was retried.`
        : 'DeepSeek temporarily suspended this account without a usable recovery time. It is paused pending manual review.')
    this.name = 'DeepSeekAccountRestrictionError'
    this.restriction = { ...restriction }
    this.code = restriction.kind === 'permanent' ? 'account_banned' : 'account_temporarily_suspended'
  }
}

export function throwIfDeepSeekRestricted(payload: unknown, mode: 'api' | 'completion' = 'api'): void {
  const restriction = parseDeepSeekRestriction(payload, mode)
  if (restriction) throw new DeepSeekAccountRestrictionError(restriction)
}

/** Error responses can still arrive as a stream. Bound both size and wait time. */
export async function readDeepSeekErrorBody(input: any): Promise<unknown> {
  if (!input || typeof input.on !== 'function') {
    if (typeof input !== 'string' && !Buffer.isBuffer(input)) return input
    if (Buffer.byteLength(input) > 65536) return undefined
    try { return JSON.parse(String(input)) } catch { return undefined }
  }
  return new Promise(resolve => {
    let chunks: Buffer[] = [], length = 0, settled = false
    const finish = (value?: unknown) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      input.removeListener('data', onData); input.removeListener('end', onEnd)
      input.removeListener('close', onClose)
      // Retain the error listener until close; destroying a transport can emit asynchronously.
      chunks = []
      resolve(value)
    }
    const onData = (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += value.length
      if (length > 65536) { finish(); input.destroy?.(); return }
      chunks.push(value)
    }
    const onEnd = () => {
      const text = Buffer.concat(chunks).toString('utf8')
      try { finish(JSON.parse(text)) } catch { finish() }
    }
    const onClose = () => finish()
    const timer = setTimeout(() => { finish(); input.destroy?.() }, 10000)
    input.on('data', onData); input.once('end', onEnd); input.once('error', onClose); input.once('close', onClose)
    if (input.readableEnded || input.destroyed) finish()
  })
}
