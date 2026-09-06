import { createHash, randomUUID } from 'node:crypto'
import type { ChatCompletionRequest, ChatMessage } from './types.ts'
import type { ConversationRequestOptions, ProviderConversationState } from './conversationTypes.ts'

export class ConversationError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, code = 'conversation_conflict', status = 409) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface ConversationBinding {
  providerId: string
  accountId: string
  actualModel: string
  /** Protocol selected by the forwarder (custom provider IDs can use a website endpoint too). */
  kind?: string
}

const optionKeys = ['tools', 'tool_choice', 'tool_format', 'web_search', 'reasoning_effort', 'deep_research'] as const
type Options = Pick<ChatCompletionRequest, typeof optionKeys[number]>
interface RecordState {
  id: string
  scope: string
  model: string
  system: string[]
  options: Options
  hashes: string[]
  pending: string[]
  binding?: ConversationBinding
  upstream?: ProviderConversationState
  status: 'busy' | 'ready' | 'uncertain'
  expires: number
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
const hash = (value: unknown): string => createHash('sha256').update(stable(value)).digest('hex')
export const conversationScope = (...parts: unknown[]): string => hash(parts)

function messageHash(message: ChatMessage): string {
  const content = Array.isArray(message.content) && message.content.every(p => p.type === 'text')
    ? message.content.map(p => p.text ?? '').join('') : message.content ?? ''
  return hash({ role: message.role, content, name: message.name,
    tool_call_id: message.tool_call_id,
    tool_calls: message.tool_calls?.length ? message.tool_calls.map(call => {
      let args: unknown = call.function.arguments
      try { args = JSON.parse(call.function.arguments.trim() || '{}') } catch { /* Invalid calls are rejected before commit. */ }
      return { id: call.id, type: call.type, function: { name: call.function.name, arguments: args } }
    }) : undefined })
}
const prefix = (whole: string[], part: string[]): boolean => part.length > 0 &&
  whole.length >= part.length && part.every((h, i) => whole[i] === h)

// WeakMap keeps provider cursors/callbacks out of JSON, upstream custom APIs and request logs.
const requestOptions = new WeakMap<ChatCompletionRequest, ConversationRequestOptions>()
export function getConversationOptions(request: ChatCompletionRequest): ConversationRequestOptions {
  return requestOptions.get(request) ?? {}
}
export function setConversationAbortSignal(request: ChatCompletionRequest, signal: AbortSignal): void {
  requestOptions.set(request, { ...getConversationOptions(request), signal })
}

export interface ConversationTurn {
  id: string
  request: ChatCompletionRequest
  binding?: ConversationBinding
  isContinuation: boolean
  bind(binding: ConversationBinding): void
  commit(message: ChatMessage): void
  fail(): void
  cancel(): void
}

/** Account-independent local routing index. Only exact transcripts, never the account's latest chat. */
export class ConversationContinuity {
  private records = new Map<string, RecordState>()
  private readonly now: () => number
  private readonly capacity: number
  constructor(now = Date.now, capacity = 2000) {
    this.now = now
    this.capacity = capacity
  }

  clear(): void { this.records.clear() }

  begin(request: ChatCompletionRequest, scope: string, ttlMs = 30 * 60 * 1000): ConversationTurn {
    const now = this.now()
    for (const [id, record] of this.records) {
      if (record.expires <= now && record.status !== 'busy') this.records.delete(id)
    }
    const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 30 * 60 * 1000
    const system = request.messages.filter(m => m.role === 'system').map(messageHash)
    const input = request.messages.filter(m => m.role !== 'system')
    const hashes = input.map(messageHash)
    const explicitId = request.session_id ?? request.sessionId
    if (request.new_conversation && explicitId) {
      throw new ConversationError('new_conversation cannot be combined with session_id', 'invalid_session_id', 400)
    }
    let previous: RecordState | undefined
    if (explicitId) {
      previous = this.records.get(explicitId)
      if (!previous || previous.scope !== scope) {
        throw new ConversationError('Conversation is unknown or expired. Start a new conversation explicitly.', 'conversation_not_found', 404)
      }
      if (previous.model !== request.model) throw new ConversationError('Cannot change the model within a conversation. Start a new conversation.')
    } else if (!request.new_conversation && input.length > 1) {
      const matches = [...this.records.values()].filter(r => r.scope === scope && r.model === request.model &&
        (prefix(hashes, r.hashes) || (r.status !== 'ready' && prefix(hashes, r.pending))))
      // Identical visible text can belong to conversations with different bootstrap
      // instructions. Use the supplied policy to disambiguate, but keep the original
      // candidates when none match so changed instructions still fail, never replay.
      const policyMatches = matches.filter(r => stable(system) === stable(r.system) && hash(
        Object.fromEntries(optionKeys.map(key => [key, request[key] ?? r.options[key]]))) === hash(r.options))
      const candidates = policyMatches.length ? policyMatches : matches
      if (candidates.length > 1) throw new ConversationError('Conversation history is ambiguous. Send X-Chat2API-Session-ID.', 'ambiguous_conversation')
      previous = candidates[0]
    }
    if (previous?.status === 'busy') throw new ConversationError('The previous turn is still running.', 'conversation_busy')
    if (previous?.status === 'uncertain') throw new ConversationError('The previous turn did not finish reliably. Start a new conversation explicitly.', 'conversation_uncertain')
    if (previous && system.length && stable(system) !== stable(previous.system)) {
      throw new ConversationError('System instructions changed. Start a new conversation explicitly.')
    }
    if (previous && !explicitId && stable(system) !== stable(previous.system)) {
      throw new ConversationError('System instructions changed. Start a new conversation explicitly.')
    }
    const options = Object.fromEntries(optionKeys.map(k => [k, request[k] ?? previous?.options[k]])) as Options
    if (previous && hash(options) !== hash(previous.options)) {
      throw new ConversationError('Tools or conversation modes changed. Start a new conversation explicitly.')
    }
    let delta = input
    if (previous) {
      if (prefix(hashes, previous.hashes)) delta = input.slice(previous.hashes.length)
      else if (!explicitId || input.some(m => m.role === 'assistant')) {
        throw new ConversationError('The supplied history does not match this conversation.', 'conversation_history_mismatch')
      }
      if (!previous.upstream?.sessionId) throw new ConversationError('Upstream did not provide a resumable conversation ID.', 'conversation_cursor_missing')
    }
    if (previous && (!delta.length || delta.some(m => m.role === 'assistant'))) {
      throw new ConversationError('Only new user/tool messages may be appended. No new input was found.', 'invalid_messages', 400)
    }
    const record: RecordState = {
      id: previous?.id ?? `c2a-${randomUUID()}`, scope, model: request.model,
      system: previous?.system ?? system, options: structuredClone(options),
      hashes: previous?.hashes ?? [], pending: previous ? [...previous.hashes, ...delta.map(messageHash)] : hashes,
      binding: previous?.binding, upstream: previous?.upstream,
      status: 'busy', expires: now + ttl,
    }
    this.records.set(record.id, record)
    const forwarded: ChatCompletionRequest = { ...request, ...options,
      messages: previous ? delta : request.messages }
    let settled = false
    const change = (update: Partial<RecordState>): void => {
      const current = this.records.get(record.id)
      if (current) this.records.set(record.id, { ...current, ...update })
    }
    requestOptions.set(forwarded, {
      retainConversation: true,
      conversation: previous?.upstream ? structuredClone(previous.upstream) : undefined,
      onConversation: (state) => {
        if (settled || !state.sessionId) return
        const current = this.records.get(record.id)?.upstream
        if (current && current.sessionId !== state.sessionId) {
          change({ status: 'uncertain' })
          throw new ConversationError('Upstream unexpectedly changed conversation ID.', 'upstream_conversation_changed')
        }
        change({ upstream: { ...current, ...state, extras: { ...current?.extras, ...state.extras } } })
      },
    })
    return {
      id: record.id, request: forwarded, binding: previous?.binding ? { ...previous.binding } : undefined,
      isContinuation: !!previous,
      bind: (binding) => {
        // Only website adapters reserve capacity; stateless custom APIs cancel this provisional turn.
        if (!previous && this.records.size > this.capacity) {
          throw new ConversationError('Conversation capacity reached. Retry after idle sessions expire.', 'conversation_capacity', 503)
        }
        if (!input.length || input[input.length - 1].role === 'assistant') {
          throw new ConversationError('messages must end with new user or tool input', 'invalid_messages', 400)
        }
        if (previous?.binding && hash(previous.binding) !== hash(binding)) {
          throw new ConversationError('The original account/model is unavailable; switching accounts would lose context.', 'conversation_account_unavailable', 503)
        }
        change({ binding: { ...binding } })
      },
      commit: (message) => {
        if (settled) return
        try {
          const callIds = new Set<string>()
          for (const call of message.tool_calls ?? []) {
            const args = JSON.parse(call.function.arguments.trim() || '{}')
            if (typeof call.id !== 'string' || !call.id.trim() || callIds.has(call.id) || typeof call.function.name !== 'string' || !call.function.name.trim() || call.type !== 'function' || !args || typeof args !== 'object' || Array.isArray(args)) {
              throw new Error('Invalid tool call')
            }
            callIds.add(call.id)
          }
        } catch {
          settled = true
          change({ status: 'uncertain' })
          throw new ConversationError('Upstream returned invalid tool-call arguments.', 'invalid_tool_call', 502)
        }
        const current = this.records.get(record.id)
        const needsParent = ['deepseek', 'kimi', 'qwen', 'qwen-ai', 'zai', 'perplexity'].includes(current?.binding?.kind ?? current?.binding?.providerId ?? '')
        const missingParent = needsParent && (!current?.upstream?.parentMessageId ||
          (previous && previous.upstream?.parentMessageId === current.upstream.parentMessageId))
        if (!current?.upstream?.sessionId || current.status === 'uncertain' || missingParent) {
          settled = true
          change({ status: 'uncertain' })
          throw new ConversationError('Upstream response has no reliable continuation ID.', 'conversation_cursor_missing', 502)
        }
        settled = true
        change({ status: 'ready', hashes: [...record.pending, messageHash(message)], pending: [], expires: this.now() + ttl })
      },
      fail: () => {
        if (!settled) { settled = true; change({ status: 'uncertain', expires: this.now() + ttl }) }
      },
      cancel: () => {
        if (!settled) {
          settled = true
          if (previous && this.records.has(record.id)) this.records.set(record.id, previous)
          else this.records.delete(record.id)
        }
      },
    }
  }
}

export const conversationContinuity = new ConversationContinuity()
