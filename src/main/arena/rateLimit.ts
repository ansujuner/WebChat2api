import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ArenaError, isArenaUuid, type ArenaModality, type ArenaModel } from './protocol'

const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const MAX_FILE_BYTES = 20 * 1024 * 1024
const DEFAULT_RETRY_MS = 60_000
export interface ArenaModelAvailability {
  available: boolean
  reason: 'ready' | 'model_quota' | 'upstream_cooldown' | 'uninitialized' | 'storage_error'
  availableAt?: number
  remaining?: number
  limit?: number
  windowMs?: number
}
export interface ArenaModelPolicy {
  limit: number
  windowMs: number
  source: 'user-default' | 'official-runtime'
}
interface Attempt { id: string; at: number }
interface Bucket { policy?: ArenaModelPolicy; attempts: Attempt[]; cooldownUntil?: number }
interface Ledger { version: 1; updatedAt: number; buckets: Record<string, Bucket> }
export interface ArenaRateLimitStorage { read(): unknown; write(ledger: unknown): void }
export interface ArenaReservation { key: string; id: string }
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const validAccount = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value)
export const isArenaQuotaAccountId = validAccount
function keyFor(accountId: string, modelId: string, modality: ArenaModality): string {
  if (!validAccount(accountId) || !isArenaUuid(modelId) || !['text', 'image'].includes(modality)) throw new ArenaError('invalid_request')
  return `${accountId}:${modelId.toLowerCase()}:${modality}`
}
function validPolicy(value: unknown): value is ArenaModelPolicy {
  return object(value) && Number.isInteger(value.limit) && value.limit > 0 && value.limit <= 10000
    && Number.isInteger(value.windowMs) && value.windowMs > 0 && value.windowMs <= MAX_WINDOW_MS
    && ['user-default', 'official-runtime'].includes(value.source)
}
function validateLedger(value: unknown): Ledger {
  if (!object(value) || value.version !== 1 || !timestamp(value.updatedAt) || !object(value.buckets)
    || Object.keys(value.buckets).length > 20000) throw new Error('Invalid Arena quota ledger')
  const buckets: Record<string, Bucket> = {}
  for (const [key, entry] of Object.entries(value.buckets)) {
    const parts = key.split(':')
    if (parts.length !== 3 || keyFor(parts[0], parts[1], parts[2] as ArenaModality) !== key
      || !object(entry) || !Array.isArray(entry.attempts) || entry.attempts.length > 10000
      || (entry.policy !== undefined && !validPolicy(entry.policy))
      || (entry.cooldownUntil !== undefined && !timestamp(entry.cooldownUntil))) throw new Error('Invalid Arena quota ledger')
    const ids = new Set<string>()
    const attempts = entry.attempts.map((attempt: unknown) => {
      if (!object(attempt) || !isArenaUuid(attempt.id) || !timestamp(attempt.at) || ids.has(attempt.id)) throw new Error('Invalid Arena quota ledger')
      ids.add(attempt.id)
      return { id: attempt.id, at: attempt.at }
    })
    buckets[key] = { attempts, ...(entry.policy ? { policy: { ...entry.policy } } : {}),
      ...(entry.cooldownUntil !== undefined ? { cooldownUntil: entry.cooldownUntil } : {}) }
  }
  return { version: 1, updatedAt: value.updatedAt, buckets }
}

/** Synchronous commits serialize concurrent requests in the single-instance Electron main process.
 * Reservations are durable charges until a PROVEN pre-submission failure explicitly releases them.
 * A crash, cancellation or transport timeout after an uncertain send never restores quota. */
export class ArenaRateLimiter {
  private ledger: Ledger
  private failed = false
  constructor(private readonly storage: ArenaRateLimitStorage, private readonly clock: () => number = Date.now) {
    this.ledger = validateLedger(storage.read())
  }
  private now(): number {
    const now = this.clock()
    if (!timestamp(now)) throw new ArenaError('quota_unavailable')
    // A wall clock rollback must not make previous reservations disappear.
    return Math.max(now, this.ledger.updatedAt)
  }
  private persist(buckets: Record<string, Bucket>): void {
    if (this.failed) throw new ArenaError('quota_unavailable')
    const next: Ledger = { version: 1, updatedAt: this.now(), buckets }
    try { this.storage.write(next); this.ledger = next }
    catch { this.failed = true; throw new ArenaError('quota_unavailable') }
  }
  availability(accountId: string, modelId: string, modality: ArenaModality): ArenaModelAvailability {
    const key = keyFor(accountId, modelId, modality)
    if (this.failed) return { available: false, reason: 'storage_error' }
    const now = this.now(), entry = this.ledger.buckets[key]
    const attempts = entry?.policy ? entry.attempts.filter(attempt => attempt.at > now - entry.policy!.windowMs) : []
    const policy = entry?.policy
    const quotaAt = policy && attempts.length >= policy.limit ? [...attempts].sort((a, b) => a.at - b.at)[attempts.length - policy.limit].at + policy.windowMs : 0
    const cooldownAt = (entry?.cooldownUntil ?? 0) > now ? entry!.cooldownUntil! : 0
    const availableAt = Math.max(quotaAt, cooldownAt)
    return { available: !availableAt, reason: availableAt ? (cooldownAt >= quotaAt ? 'upstream_cooldown' : 'model_quota') : 'ready',
      ...(availableAt ? { availableAt } : {}), ...(policy ? { remaining: Math.max(0, policy.limit - attempts.length), limit: policy.limit, windowMs: policy.windowMs } : {}) }
  }
  /** Only normalized, authenticated runtime catalogs may identify the Seedream model UUID. */
  observeModel(accountId: string, model: ArenaModel): void {
    const key = keyFor(accountId, model.id, model.modality), current = this.ledger.buckets[key] ?? { attempts: [] }
    const seedream = model.modality === 'image' && [model.name, model.publicName].some(name => name?.trim().toLowerCase() === 'seedream-5.0-pro')
    const policy = current.policy?.source === 'official-runtime' ? current.policy : seedream ? { limit: 5, windowMs: 3600000, source: 'user-default' as const } : current.policy
    const until = timestamp(model.rateLimitedUntil) && model.rateLimitedUntil > this.now() ? model.rateLimitedUntil : undefined
    if (JSON.stringify(policy) === JSON.stringify(current.policy) && (!until || until <= (current.cooldownUntil ?? 0))) return
    this.persist({ ...this.ledger.buckets, [key]: { ...current, ...(policy ? { policy } : {}),
      ...(until ? { cooldownUntil: Math.max(until, current.cooldownUntil ?? 0) } : {}) } })
  }
  /** A future verified official quota extractor can override the user default, never guessed fields. */
  setOfficialPolicy(accountId: string, modelId: string, modality: ArenaModality, policy: Omit<ArenaModelPolicy, 'source'>): void {
    const checked = { ...policy, source: 'official-runtime' as const }
    if (!validPolicy(checked)) throw new ArenaError('invalid_request')
    const key = keyFor(accountId, modelId, modality), current = this.ledger.buckets[key] ?? { attempts: [] }
    this.persist({ ...this.ledger.buckets, [key]: { ...current, policy: checked } })
  }
  reserve(accountId: string, modelId: string, modality: ArenaModality): ArenaReservation {
    const key = keyFor(accountId, modelId, modality), available = this.availability(accountId, modelId, modality)
    if (!available.available) throw new ArenaError(available.reason === 'storage_error' ? 'quota_unavailable' : 'rate_limited', undefined, available.availableAt)
    const now = this.now(), current = this.ledger.buckets[key] ?? { attempts: [] }
    // Do not invent a 10,000-request / 30-day cap for unknown models. Their
    // upstream cooldown is persisted, but there is no local attempt counter.
    // Once an official policy is observed its local history begins then.
    const attempts = current.policy ? current.attempts.filter(attempt => attempt.at > now - current.policy!.windowMs) : []
    if (!this.ledger.buckets[key] && Object.keys(this.ledger.buckets).length >= 20000) throw new ArenaError('quota_unavailable')
    const id = randomUUID()
    this.persist({ ...this.ledger.buckets, [key]: { ...current, attempts: current.policy ? [...attempts, { id, at: now }] : [] } })
    return Object.freeze({ key, id })
  }
  releaseBeforeSubmission(reservation: ArenaReservation): void {
    const current = this.ledger.buckets[reservation.key]
    if (!current?.attempts.some(attempt => attempt.id === reservation.id)) return
    this.persist({ ...this.ledger.buckets, [reservation.key]: { ...current, attempts: current.attempts.filter(attempt => attempt.id !== reservation.id) } })
  }
  cooldown(accountId: string, modelId: string, modality: ArenaModality, retryAt?: number): number {
    const key = keyFor(accountId, modelId, modality), current = this.ledger.buckets[key] ?? { attempts: [] }, now = this.now()
    const until = Math.max(current.cooldownUntil ?? 0, timestamp(retryAt) && retryAt > now ? retryAt : now + DEFAULT_RETRY_MS)
    this.persist({ ...this.ledger.buckets, [key]: { ...current, cooldownUntil: until } })
    return until
  }
}

/** App-owned directory only; no account secrets, profile files, or credential storage is read. */
export function createArenaRateLimitStorage(userDataDirectory: string): ArenaRateLimitStorage {
  if (!path.isAbsolute(userDataDirectory)) throw new ArenaError('quota_unavailable')
  const root = fs.realpathSync(userDataDirectory), directory = path.join(root, 'arena-rate-limits')
  fs.mkdirSync(directory, { recursive: true })
  const guard = () => {
    const stat = fs.lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(directory) !== directory) throw new ArenaError('quota_unavailable')
  }
  guard()
  const file = path.join(directory, 'ledger-v1.json')
  const checkFile = () => {
    if (!fs.existsSync(file)) return false
    const stat = fs.lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES || stat.nlink !== 1) throw new ArenaError('quota_unavailable')
    return true
  }
  return {
    read() { guard(); return checkFile() ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 1, updatedAt: 0, buckets: {} } },
    write(ledger) {
      guard(); checkFile()
      const content = JSON.stringify(ledger)
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new ArenaError('quota_unavailable')
      const temporary = path.join(directory, `ledger-${randomUUID()}.tmp`)
      let fd: number | undefined
      try {
        fd = fs.openSync(temporary, 'wx', 0o600)
        fs.writeFileSync(fd, content, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
        fs.renameSync(temporary, file)
      } finally {
        if (fd !== undefined) fs.closeSync(fd)
        // Only the unique file created above is eligible for cleanup.
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
      }
    },
  }
}
let limiter: ArenaRateLimiter | undefined
let initializationFailed = false
export function initializeArenaRateLimits(userDataDirectory: string): void {
  if (limiter || initializationFailed) return
  try { limiter = new ArenaRateLimiter(createArenaRateLimitStorage(userDataDirectory)) }
  catch { initializationFailed = true; throw new ArenaError('quota_unavailable') }
}
export function getArenaRateLimiter(): ArenaRateLimiter {
  if (!limiter) throw new ArenaError('quota_unavailable')
  return limiter
}
export function getArenaModelAvailability(accountId: string, modelId: string, modality: ArenaModality): ArenaModelAvailability {
  return limiter?.availability(accountId, modelId, modality) ?? { available: false, reason: initializationFailed ? 'storage_error' : 'uninitialized' }
}
