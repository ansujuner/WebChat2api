import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

export type ArenaModality = 'text' | 'image'
export interface ArenaModel { id: string; name: string; modality: ArenaModality; publicName?: string; rateLimitedUntil?: number }
export interface ArenaConversation { id: string; modelId: string; modality: ArenaModality }
export type ArenaErrorCode = 'action_required' | 'model_not_available' | 'invalid_request' | 'browser_unavailable' | 'account_busy' | 'incomplete_stream' | 'upstream_error' | 'aborted' | 'rate_limited' | 'quota_unavailable'
export interface ArenaDiagnostic {
  stage: 'browser' | 'snapshot' | 'score' | 'submission' | 'stream' | 'decode'
  upstreamStatus?: number
  protocolCode?: string
  errorHints?: string[]
  issuePaths?: string[]
  issueCodes?: string[]
}
const ERROR_HINTS = ['uuid', 'v7', 'model', 'mode', 'validation', 'required', 'body', 'session', 'quota', 'credit', 'timestamp', 'time', 'version', 'recaptcha', 'authentication', 'rate_limit']
const ISSUE_FIELDS = ['id', 'mode', 'modelAId', 'modelBId', 'modality', 'userMessageId', 'modelAMessageId', 'modelBMessageId', 'userMessage', 'content', 'type', 'text', 'experimental_attachments', 'metadata', 'recaptchaV3Token', 'recaptchaV2Token', 'cloudflareMetadata']
const ISSUE_CODES = ['invalid_type', 'invalid_literal', 'custom', 'invalid_union', 'invalid_union_discriminator', 'invalid_enum_value', 'unrecognized_keys', 'invalid_arguments', 'invalid_return_type', 'invalid_date', 'invalid_string', 'too_small', 'too_big', 'invalid_intersection_types', 'not_multiple_of', 'not_finite', 'invalid_format', 'invalid_value']
const ERRORS: Record<ArenaErrorCode, string> = {
  action_required: 'Complete Arena sign-in or verification in the account browser, then explicitly try again. No automatic retry was performed.',
  model_not_available: 'This model is not available in the current Arena catalog. Refresh the account model list.',
  invalid_request: 'The Arena request or conversation identifier is invalid.',
  browser_unavailable: 'The Arena account browser is unavailable. Open the account login window and try again.',
  account_busy: 'This Arena account already has a request in progress.',
  incomplete_stream: 'Arena did not return a complete terminal response. The request was not retried.',
  upstream_error: 'Arena could not complete this request. The request was not retried.',
  aborted: 'The Arena request was cancelled. The request was not retried.',
  rate_limited: 'This Arena account has reached the limit for this model. Wait until its quota resets. No request was retried.',
  quota_unavailable: 'Arena quota storage is unavailable. Restore the app data directory and restart the app before submitting again.',
}
export class ArenaError extends Error {
  readonly status: number
  readonly actionRequired: boolean
  readonly diagnostic?: ArenaDiagnostic
  readonly retryAt?: number
  constructor(readonly code: ArenaErrorCode, diagnostic?: ArenaDiagnostic, retryAt?: number) {
    super(ERRORS[code]); this.name = 'ArenaError'
    this.status = code === 'rate_limited' ? 429 : code === 'quota_unavailable' ? 503 : code === 'invalid_request' ? 400 : code === 'model_not_available' ? 404 : code === 'account_busy' ? 409 : code === 'action_required' ? 409 : 502
    this.actionRequired = code === 'action_required'
    if (Number.isSafeInteger(retryAt) && retryAt! > 0) this.retryAt = retryAt
    if (diagnostic && ['browser', 'snapshot', 'score', 'submission', 'stream', 'decode'].includes(diagnostic.stage)) {
      this.diagnostic = Object.freeze({ stage: diagnostic.stage,
        ...(Number.isInteger(diagnostic.upstreamStatus) && diagnostic.upstreamStatus! >= 100 && diagnostic.upstreamStatus! <= 599 ? { upstreamStatus: diagnostic.upstreamStatus } : {}),
        ...(typeof diagnostic.protocolCode === 'string' && /^[0-9a-z]$/.test(diagnostic.protocolCode) ? { protocolCode: diagnostic.protocolCode } : {}),
        ...(Array.isArray(diagnostic.errorHints) ? { errorHints: [...new Set(diagnostic.errorHints.filter(value => ERROR_HINTS.includes(value)))].slice(0, 16) } : {}),
        ...(Array.isArray(diagnostic.issuePaths) ? { issuePaths: [...new Set(diagnostic.issuePaths.filter(value => typeof value === 'string' && value.split('.').length <= 8 && value.split('.').every(part => ISSUE_FIELDS.includes(part))))].slice(0, 16) } : {}),
        ...(Array.isArray(diagnostic.issueCodes) ? { issueCodes: [...new Set(diagnostic.issueCodes.filter(value => ISSUE_CODES.includes(value)))].slice(0, 16) } : {}),
      })
    }
  }
}
export const isArenaUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

let lastUuidTimestamp = -1
let lastUuidCounter = 0
/** UUID v7 wire IDs: millisecond timestamp, monotonic rand_a, and a fresh cryptographic rand_b. */
export function arenaUuidV7(): string {
  const now = Date.now()
  const maxTimestamp = 0xffffffffffff
  if (!Number.isInteger(now) || now < 0 || now > maxTimestamp) throw new ArenaError('invalid_request')
  const bytes = randomBytes(16)
  let timestamp = now > lastUuidTimestamp ? now : lastUuidTimestamp
  let counter = now > lastUuidTimestamp ? bytes.readUInt16BE(6) & 0x0fff : lastUuidCounter + 1
  // Retain ordering on clock rollback; advance logical time only if the 12-bit counter overflows.
  if (counter > 0x0fff) { timestamp++; counter = 0 }
  if (timestamp > maxTimestamp) throw new ArenaError('invalid_request')
  bytes.writeUIntBE(timestamp, 0, 6)
  bytes.writeUInt16BE(0x7000 | counter, 6)
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  lastUuidTimestamp = timestamp
  lastUuidCounter = counter
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function isArenaPage(url: unknown): boolean {
  if (typeof url !== 'string') return false
  try { const value = new URL(url); return value.origin === 'https://arena.ai' && !value.username && !value.password } catch { return false }
}

/** Public fallback checked 2026-09-06; not proof of account availability. Never seed stale Seedream IDs. */
export const ARENA_PUBLIC_MODELS: ArenaModel[] = [
  { id: '019b24bb-5caf-71c3-b854-37d0c7086f21', name: 'max', modality: 'text' },
  { id: '019b24bb-5caf-71c3-b854-37d0c7086f21', name: 'max', modality: 'image' },
]

export function normalizeArenaModels(input: unknown): ArenaModel[] {
  if (!Array.isArray(input)) return []
  const output: ArenaModel[] = [], seen = new Set<string>()
  for (const entry of input.slice(0, 2000)) {
    if (!entry || typeof entry !== 'object' || !isArenaUuid(entry.id) || entry.userSelectable === false
      || typeof entry.organization !== 'string' || !entry.organization.trim()
      || typeof entry.provider !== 'string' || !entry.provider.trim()) continue
    const label = typeof entry.publicName === 'string' && entry.publicName.toLowerCase() === 'max' ? 'max' : (entry.displayName || entry.publicName)
    if (typeof label !== 'string' || !label.trim() || label.length > 160 || /[\x00-\x1f]/.test(label)) continue
    if (entry.capabilities?.inputCapabilities?.text !== true) continue
    for (const modality of ['text', 'image'] as const) {
      const capability = entry.capabilities?.outputCapabilities?.[modality]
      if (capability !== true && !(modality === 'image' && capability && typeof capability === 'object' && !Array.isArray(capability))) continue
      const key = `${modality}:${label.toLowerCase()}`
      if (!seen.has(key)) {
        seen.add(key)
        const until = typeof entry.rateLimitedUntil === 'string' && entry.rateLimitedUntil.length <= 40 ? Date.parse(entry.rateLimitedUntil) : NaN
        const publicName = typeof entry.publicName === 'string' && entry.publicName.trim().length <= 160 && !/[\x00-\x1f]/.test(entry.publicName) ? entry.publicName.trim() : undefined
        output.push({ id: entry.id, name: label, modality,
          ...(publicName && publicName.toLowerCase() !== label.toLowerCase() ? { publicName } : {}),
          ...(Number.isSafeInteger(until) && until > 0 ? { rateLimitedUntil: until } : {}) })
      }
    }
  }
  return output
}

export function arenaRequest(model: ArenaModel, prompt: string, conversation?: ArenaConversation) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 200000 || !model || !isArenaUuid(model.id)
    || !['text', 'image'].includes(model.modality)) throw new ArenaError('invalid_request')
  if (conversation && (!isArenaUuid(conversation.id) || conversation.modelId !== model.id || conversation.modality !== model.modality)) throw new ArenaError('invalid_request')
  const next = conversation ? { ...conversation } : { id: arenaUuidV7(), modelId: model.id, modality: model.modality }
  return { conversation: next,
    path: conversation ? `/nextjs-api/stream/post-to-evaluation/${next.id}` : '/nextjs-api/stream/create-evaluation',
    body: { id: next.id, ...(!conversation ? { mode: 'direct-battle' } : {}), modelAId: model.id,
      userMessageId: arenaUuidV7(), modelAMessageId: arenaUuidV7(),
      userMessage: { content: prompt, experimental_attachments: [], metadata: {} },
      modality: model.modality === 'text' ? 'chat' : 'image' },
  }
}

export type ArenaEvent = { type: 'text' | 'reasoning'; text: string } | { type: 'image'; url: string } | { type: 'finish'; reason: string }
export function arenaImageUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 32 * 1024 * 1024) throw new ArenaError('upstream_error')
  if (/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(input)) return input
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port
      || !url.hostname.includes('.') || /^(?:[0-9.]+|\[.*\])$/.test(url.hostname)
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(url.hostname)) throw new Error()
    return url.href
  } catch { throw new ArenaError('upstream_error') }
}

/** Arena multiplexes participant prefixes before Vercel data lines; it is not SSE. */
export class ArenaProtocolDecoder {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private finished = false
  private bytes = 0
  private protocolCode?: string
  private failure(code: ArenaErrorCode = 'upstream_error'): ArenaError { return new ArenaError(code, { stage: 'decode', protocolCode: this.protocolCode }) }
  push(chunk: Buffer | string): ArenaEvent[] {
    this.bytes += Buffer.byteLength(chunk)
    if (this.bytes > 48 * 1024 * 1024) throw this.failure()
    this.pending += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const lines = this.pending.split('\n'); this.pending = lines.pop() || ''
    return lines.flatMap(line => this.line(line.replace(/\r$/, '')))
  }
  end(): ArenaEvent[] {
    this.pending += this.decoder.end()
    const events = this.pending ? this.line(this.pending.replace(/\r$/, '')) : []
    this.pending = ''
    if (!this.finished) throw this.failure('incomplete_stream')
    return events
  }
  private line(line: string): ArenaEvent[] {
    if (!line.trim()) return []
    this.protocolCode = /^[ab][0-9a-z]:/.test(line) ? line[1] : undefined
    if (!this.protocolCode) throw this.failure()
    if (line[0] !== 'a') return []
    if (this.finished) throw this.failure()
    let value: any
    try { value = JSON.parse(line.slice(3)) } catch { throw this.failure() }
    const code = line[1]
    if (code === '3' || (code === 'd' && value?.finishReason === 'error')) throw this.failure()
    if (code === '0' || code === 'g') {
      if (typeof value !== 'string') throw this.failure()
      return [{ type: code === '0' ? 'text' : 'reasoning', text: value }]
    }
    if (code === 'd') {
      if (!value || typeof value.finishReason !== 'string') throw this.failure()
      this.finished = true
      return [{ type: 'finish', reason: value.finishReason }]
    }
    if (code === '2') {
      if (!Array.isArray(value)) throw this.failure()
      return value.filter(item => item?.type === 'image').map(item => ({ type: 'image', url: arenaImageUrl(item.image || (item.data ? `data:${item.mimeType || 'image/png'};base64,${item.data}` : undefined)) }))
    }
    if (code === 'k' && typeof value?.mimeType === 'string' && value.mimeType.startsWith('image/')) {
      return [{ type: 'image', url: arenaImageUrl(`data:${value.mimeType};base64,${value.data}`) }]
    }
    // Other known Vercel data parts (metadata, citations, tools) do not imply completion.
    if (!['8', '9', 'a', 'b', 'c', 'e', 'f', 'h', 'i', 'j', 'k'].includes(code)) throw this.failure()
    return []
  }
}
