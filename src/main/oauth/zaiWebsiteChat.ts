/** Submit through the account's normal website UI; never manufacture or export CAPTCHA proofs. */
import { PassThrough, type Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { createParser } from 'eventsource-parser'
import type { BrowserWindow } from 'electron'
import type { ProviderConversationState } from '../proxy/conversationTypes'
import { zaiAccountBrowserManager, type ZaiAccountBrowserOptions } from './zaiAccountBrowser'

const ORIGIN = 'https://chat.z.ai'
const COMPLETIONS = '/api/v2/chat/completions'
const READY_TIMEOUT = 30000
const SUBMIT_TIMEOUT = 45000
const RESPONSE_TIMEOUT = 180000
const MAX_OUTPUT = 32 * 1024 * 1024
export type ZaiWebsiteChatErrorCode = 'login_required' | 'identity_mismatch' | 'browser_unavailable' | 'account_busy' | 'model_unavailable'
  | 'unsupported_options' | 'action_required' | 'account_changed' | 'invalid_request' | 'upstream_error'
  | 'incomplete_stream' | 'cancelled' | 'protocol_mismatch'
const ERROR_CODES = new Set<ZaiWebsiteChatErrorCode>(['login_required', 'identity_mismatch', 'browser_unavailable', 'account_busy', 'model_unavailable',
  'unsupported_options', 'action_required', 'account_changed', 'invalid_request', 'upstream_error', 'incomplete_stream', 'cancelled', 'protocol_mismatch'])
type WebsiteStage = 'browser' | 'navigation' | 'model' | 'options' | 'input' | 'submit' | 'identity' | 'stream' | 'cursor'
const SAFE_REASONS = new Set(['duplicate_submission', 'invalid_request_shape', 'model_mismatch', 'prompt_mismatch', 'invalid_ids',
  'session_mismatch', 'parent_mismatch', 'options_mismatch', 'source_changed', 'auth_rejected', 'identity_mismatch', 'response_origin_mismatch', 'incomplete_terminal', 'cursor_missing'])

export class ZaiWebsiteChatError extends Error {
  constructor(readonly code: ZaiWebsiteChatErrorCode) { super(`Z.ai website ${code}`); this.name = 'ZaiWebsiteChatError' }
}
export interface ZaiWebsiteChatOptions extends ZaiAccountBrowserOptions {
  model: string
  prompt: string
  conversation?: ProviderConversationState
  webSearch?: boolean
  thinking?: boolean
  signal?: AbortSignal
  /** Main-only account metadata/revision guard. Never serialized into page scripts. */
  isAccountCurrent?: () => boolean
  /** Main-only verified graph cursor callback, emitted before any terminal output. */
  onConversation?: (state: ProviderConversationState) => void
}
export interface ZaiWebsiteChatResult {
  response: { status: number; headers: Record<string, string>; data: Readable }
  chatId: string
  requestId: string
}
function safeError(error: unknown, fallback: ZaiWebsiteChatErrorCode = 'browser_unavailable'): ZaiWebsiteChatError {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
  return new ZaiWebsiteChatError(typeof code === 'string' && ERROR_CODES.has(code as ZaiWebsiteChatErrorCode) ? code as ZaiWebsiteChatErrorCode : fallback)
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) }
function currentOrigin(window: BrowserWindow): boolean {
  if (window.isDestroyed() || window.webContents.isDestroyed()) return false
  try { return new URL(window.webContents.getURL()).origin === ORIGIN } catch { return false }
}

/** Private page state contains only this response and selected correlation IDs, never request headers/proofs. */
export function zaiChatCaptureScript(key: string, options: Pick<ZaiWebsiteChatOptions, 'model' | 'prompt' | 'conversation' | 'webSearch' | 'thinking' | 'expectedIdentity'>): string {
  const expected = { model: options.model, prompt: options.prompt, chatId: options.conversation?.sessionId,
    parentId: options.conversation?.parentMessageId, webSearch: options.webSearch, thinking: options.thinking,
    identity: options.expectedIdentity }
  return `(() => {
    if (location.origin !== ${JSON.stringify(ORIGIN)}) return false;
    const key = ${JSON.stringify(key)}, expected = ${JSON.stringify(expected)};
    const original = window.fetch;
    const state = { submitted: false, closed: false, done: false, error: null, reason: null, stage: 'submit', metadata: null, chunks: [], size: 0, abort: new AbortController() };
    Object.defineProperty(window, key, { configurable: true, value: state });
    const fail = (code, reason = null) => { state.error = code; state.reason = reason; state.closed = true; state.abort.abort(); };
    window.fetch = async function(input, init) {
      let url;
      try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href); }
      catch { return original.call(this, input, init); }
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      if (url.origin !== ${JSON.stringify(ORIGIN)} || url.pathname !== ${JSON.stringify(COMPLETIONS)} || method !== 'POST') return original.call(this, input, init);
      // Keep this gate installed after completion/failure: late CAPTCHA callbacks or automatic retries
      // must not launch a second generation. The next task navigates to a fresh official page.
      if (state.closed || state.submitted || location.origin !== ${JSON.stringify(ORIGIN)}) { fail('protocol_mismatch', 'duplicate_submission'); throw new Error('Chat submission unavailable'); }
      state.submitted = true;
      let body;
      try { if (typeof init?.body !== 'string' || init.body.length > 2000000) throw 0; body = JSON.parse(init.body); } catch { fail('protocol_mismatch', 'invalid_request_shape'); throw new Error('Chat submission unavailable'); }
      const ids = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
      const lastUser = Array.isArray(body.messages) ? [...body.messages].reverse().find(message => message?.role === 'user') : null;
      const prompt = typeof lastUser?.content === 'string' ? lastUser.content : Array.isArray(lastUser?.content) ? lastUser.content.filter(part => part?.type === 'text').map(part => part.text || '').join('\\n') : null;
      const mismatch = body.model !== expected.model ? 'model_mismatch' : prompt !== expected.prompt ? 'prompt_mismatch'
        : !ids(body.chat_id) || !ids(body.id) || !ids(body.current_user_message_id) ? 'invalid_ids' : expected.chatId && body.chat_id !== expected.chatId ? 'session_mismatch'
        : (expected.chatId && body.current_user_message_parent_id !== expected.parentId) || (!expected.chatId && body.current_user_message_parent_id != null) ? 'parent_mismatch' : null;
      if (mismatch) { fail('protocol_mismatch', mismatch); throw new Error('Chat submission unavailable'); }
      if ((expected.webSearch !== undefined && Boolean(body.features?.auto_web_search) !== expected.webSearch)
        || (expected.thinking !== undefined && Boolean(body.features?.enable_thinking) !== expected.thinking)) { fail('unsupported_options', 'options_mismatch'); throw new Error('Chat options unavailable'); }
      const chatId = body.chat_id, requestId = body.id, userMessageId = body.current_user_message_id;
      body = null; // Do not keep body.captcha_verify_param, private metadata or full history in bridge state.
      // Bind this actual generation's Bearer, not an earlier login-window token, to the account.
      // Only the official origin sees it; no token, auth response or CAPTCHA proof enters bridge state.
      let bearer;
      state.stage = 'identity';
      try { bearer = /^Bearer\\s+(\\S+)$/i.exec(new Headers(init?.headers || input?.headers).get('Authorization') || '')?.[1]; } catch {}
      const storageSnapshot = localStorage.getItem('token');
      if (!bearer || bearer.length < 8 || bearer.length > 16384 || !storageSnapshot) { fail('account_changed', 'source_changed'); throw new Error('Chat identity unavailable'); }
      const authController = new AbortController();
      const authTimer = setTimeout(() => authController.abort(), 8000);
      try {
        const auth = await original.call(this, ${JSON.stringify(`${ORIGIN}/api/v1/auths/`)}, {
          method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer ' + bearer },
          credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([authController.signal, state.abort.signal])
        });
        const authURL = new URL(auth.url);
        if (auth.status !== 200 || authURL.origin !== ${JSON.stringify(ORIGIN)} || authURL.pathname !== '/api/v1/auths/') throw 0;
        const text = await auth.text(); if (text.length > 65536) throw 0;
        const identity = JSON.parse(text); if (!identity || typeof identity !== 'object' || Array.isArray(identity)) throw 0;
        const userId = typeof identity.id === 'number' && Number.isSafeInteger(identity.id) && identity.id >= 0 ? String(identity.id)
          : typeof identity.id === 'string' && identity.id.trim().length <= 128 && !/[\\x00-\\x1f\\x7f]/.test(identity.id) ? identity.id.trim() : '';
        const email = typeof identity.email === 'string' && identity.email.trim().length <= 254 && /^[^\\s@<>\\x00-\\x1f\\x7f]+@[^\\s@<>\\x00-\\x1f\\x7f]+\\.[^\\s@<>\\x00-\\x1f\\x7f]+$/.test(identity.email.trim()) ? identity.email.trim() : '';
        if ((!userId && !email) || /@guest\\.com$/i.test(email) || String(identity.role || '').trim().toLowerCase() === 'guest'
          || ['is_guest', 'isGuest', 'is_anonymous', 'isAnonymous', 'guest'].some(key => identity[key] === true)) throw 0;
        if ((expected.identity?.userId && userId !== expected.identity.userId)
          || (expected.identity?.email && email.toLowerCase() !== expected.identity.email.toLowerCase())) { fail('account_changed', 'identity_mismatch'); throw 0; }
      } catch { if (!state.error) fail('login_required', 'auth_rejected'); throw new Error('Chat identity unavailable'); }
      finally { clearTimeout(authTimer); }
      if (state.closed || location.origin !== ${JSON.stringify(ORIGIN)} || localStorage.getItem('token') !== storageSnapshot
        || new Headers(init?.headers || input?.headers).get('Authorization')?.replace(/^Bearer\\s+/i, '') !== bearer) { fail('account_changed', 'source_changed'); throw new Error('Chat identity unavailable'); }
      // The current site's body.id refers to an assistant graph node, but it is only a candidate:
      // require the persisted graph to prove role + exact parent edges before exposing a cursor.
      state.readCursor = async () => {
        if (!state.done || state.closed || location.origin !== ${JSON.stringify(ORIGIN)}) return { error: 'account_changed' };
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 3000);
        try {
          const path = '/api/v1/chats/' + encodeURIComponent(chatId);
          const response = await original.call(window, ${JSON.stringify(ORIGIN)} + path, { method: 'GET',
            headers: { Accept: 'application/json', Authorization: 'Bearer ' + bearer }, credentials: 'omit',
            redirect: 'error', cache: 'no-store', signal: AbortSignal.any([controller.signal, state.abort.signal]) });
          const url = new URL(response.url);
          if (url.origin !== ${JSON.stringify(ORIGIN)} || url.pathname !== path) return { error: 'protocol_mismatch' };
          if (response.status === 401) return { error: 'login_required' };
          if (response.status === 403) return { error: 'action_required' };
          if (response.status !== 200) return { pending: true };
          const text = await response.text(); if (text.length > 4194304) return { error: 'protocol_mismatch' };
          const graph = JSON.parse(text);
          const messages = graph?.chat?.history?.messages;
          if (!messages || typeof messages !== 'object' || Array.isArray(messages)) return { pending: true };
          const user = messages[userMessageId], assistant = messages[requestId];
          if (!user || !assistant) return { pending: true };
          if (user.id !== userMessageId || user.role !== 'user' || (user.parentId ?? null) !== (expected.parentId ?? null)
            || assistant.id !== requestId || assistant.role !== 'assistant' || assistant.parentId !== userMessageId
            || (assistant.model !== undefined && assistant.model !== expected.model)
            || (Array.isArray(user.childrenIds) && !user.childrenIds.includes(requestId))) return { error: 'protocol_mismatch' };
          if (assistant.error) return { error: 'upstream_error' };
          if (assistant.done === false) return { pending: true };
          if (state.closed || location.origin !== ${JSON.stringify(ORIGIN)}) return { error: 'account_changed' };
          return { assistantId: assistant.id }; // Never return any graph content, account data or token.
        } catch { return { pending: true }; }
        finally { clearTimeout(timer); }
      };
      state.stage = 'submit';
      const signals = [state.abort.signal, init?.signal].filter(Boolean);
      let response;
      try { response = await original.call(this, input, { ...init, signal: AbortSignal.any(signals) }); }
      catch { if (!state.error) fail('upstream_error'); throw new Error('Chat request unavailable'); }
      try { const finalURL = new URL(response.url); if (finalURL.origin !== ${JSON.stringify(ORIGIN)} || finalURL.pathname !== ${JSON.stringify(COMPLETIONS)}) throw 0; }
      catch { fail('protocol_mismatch', 'response_origin_mismatch'); throw new Error('Chat response unavailable'); }
      state.stage = 'stream';
      state.metadata = { status: response.status, contentType: response.headers.get('content-type') || '', chatId, requestId };
      if (!response.body) { fail('incomplete_stream'); return response; }
      // Tee only the submitted chat response. The website receives its untouched branch.
      const reader = response.clone().body.getReader();
      void (async () => {
        const decoder = new TextDecoder();
        try {
          while (!state.closed) {
            const chunk = await reader.read();
            if (chunk.done) { const tail = decoder.decode(); if (tail) state.chunks.push(tail); state.done = true; return; }
            const text = decoder.decode(chunk.value, { stream: true });
            state.size += text.length;
            if (state.size > 2097152) { fail('incomplete_stream'); return; }
            if (text) state.chunks.push(text);
          }
        } catch { if (!state.error) fail('incomplete_stream'); }
        finally { reader.cancel().catch(() => {}); }
      })();
      return response;
    };
    return true;
  })()`
}

export function zaiChatDrainScript(key: string): string {
  return `(() => {
    if (location.origin !== ${JSON.stringify(ORIGIN)}) return { error: 'account_changed' };
    const state = window[${JSON.stringify(key)}]; if (!state) return { error: 'browser_unavailable' };
    const chunks = state.chunks.splice(0); state.size = 0;
    const challengeVisible = [...document.querySelectorAll('#chat-captcha-element,[id^="aliyunCaptcha-"],[class*="aliyunCaptcha-"]')].some(element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
    return { chunks, metadata: state.metadata, submitted: state.submitted, done: state.done, error: state.error, reason: state.reason, stage: state.stage, challengeVisible };
  })()`
}
export function zaiChatCloseScript(key: string, abort = true): string {
  return `(() => { const state = window[${JSON.stringify(key)}]; if (state) { state.closed = true; ${abort ? 'state.abort.abort();' : ''} delete state.readCursor; state.chunks = []; state.size = 0; } })()`
}

export function zaiChatCursorScript(key: string): string {
  return `(() => { if (location.origin !== ${JSON.stringify(ORIGIN)}) return { error: 'account_changed' }; const state = window[${JSON.stringify(key)}]; return typeof state?.readCursor === 'function' ? state.readCursor() : { error: 'protocol_mismatch' }; })()`
}

async function waitFor(window: BrowserWindow, predicate: string, signal?: AbortSignal, timeout = READY_TIMEOUT): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new ZaiWebsiteChatError('cancelled')
    if (!currentOrigin(window)) throw new ZaiWebsiteChatError('browser_unavailable')
    if (await window.webContents.executeJavaScript(`location.origin === ${JSON.stringify(ORIGIN)} && (${predicate})`)) return
    await delay(100)
  }
  throw new ZaiWebsiteChatError('browser_unavailable')
}

async function preparePage(window: BrowserWindow, options: ZaiWebsiteChatOptions, onStage: (stage: WebsiteStage) => void): Promise<void> {
  // Only the dedicated API page is navigated. The user's sign-in/manual-chat window is untouched.
  onStage('navigation')
  try { await window.loadURL(`${ORIGIN}${options.conversation ? `/c/${options.conversation.sessionId}` : '/'}`) } catch (error) {
    const code = error && typeof error === 'object' ? error as { code?: unknown; errno?: unknown } : undefined
    if (code?.code !== 'ERR_ABORTED' && code?.errno !== -3) throw error
    // Normal navigation may supersede loadURL. Exact origin and actual DOM still must verify below.
  }
  await waitFor(window, `!!document.getElementById('chat-input') && !!document.querySelector('button[id^="model-selector-"][id$="-button"]')`, options.signal)
  onStage('model')
  const selectedId = `model-selector-${options.model}-button`
  const alreadySelected = await window.webContents.executeJavaScript(`!!document.getElementById(${JSON.stringify(selectedId)})`)
  if (!alreadySelected) {
    await window.webContents.executeJavaScript(`document.querySelector('button[id^="model-selector-"][id$="-button"]').click()`)
    const selector = `button[aria-label="model-item"][data-value=${JSON.stringify(options.model)}]`
    await waitFor(window, `!!document.querySelector(${JSON.stringify(selector)})`, options.signal, 5000)
    const changed = await window.webContents.executeJavaScript(`(() => { const item = document.querySelector(${JSON.stringify(selector)}); if (!item || item.disabled) return false; item.click(); return true; })()`)
    if (!changed) throw new ZaiWebsiteChatError('model_unavailable')
    await waitFor(window, `!!document.getElementById(${JSON.stringify(selectedId)})`, options.signal, 5000)
  }
  if (options.webSearch !== undefined) {
    onStage('options')
    // The current official input toolbar has one data-active toggle (web search). If it changes,
    // do not guess: captured outgoing features below must still exactly match the requested setting.
    await window.webContents.executeJavaScript(`(() => { const form = document.getElementById('chat-input')?.closest('form'); const buttons = form?.querySelectorAll('button[data-active]'); if (buttons?.length === 1 && !buttons[0].disabled && (buttons[0].getAttribute('data-active') === 'true') !== ${JSON.stringify(options.webSearch)}) buttons[0].click(); })()`)
  }
}

export function runZaiWebsiteChat(options: ZaiWebsiteChatOptions): Promise<ZaiWebsiteChatResult> {
  if (!options || !identifier(options.accountId) || typeof options.model !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.model) || typeof options.prompt !== 'string'
    || !options.prompt.trim() || options.prompt.length > 200000
    || (options.conversation && (!identifier(options.conversation.sessionId) || !identifier(options.conversation.parentMessageId)))) {
    return Promise.reject(new ZaiWebsiteChatError('invalid_request'))
  }
  if (options.signal?.aborted) return Promise.reject(new ZaiWebsiteChatError('cancelled'))
  const assertAccountCurrent = () => {
    if (!options.isAccountCurrent) return
    let current = false
    try { current = options.isAccountCurrent() === true } catch { /* Never expose store errors or credentials. */ }
    if (!current) throw new ZaiWebsiteChatError('account_changed')
  }
  let resolve!: (result: ZaiWebsiteChatResult) => void
  let reject!: (error: Error) => void
  let returned = false
  let stage: WebsiteStage = 'browser'
  let reason: string | undefined
  const response = new Promise<ZaiWebsiteChatResult>((yes, no) => { resolve = yes; reject = no })
  const output = new PassThrough()
  let completionTail = ''
  output.on('error', () => {}) // The caller attaches its parser after the headers promise resolves.
  const rejectSafe = (error: unknown) => {
    const normalized = safeError(error)
    console.warn('[ZaiWebsiteChat]', { stage, code: normalized.code, ...(reason && SAFE_REASONS.has(reason) ? { reason } : {}) })
    if (!returned) { returned = true; reject(normalized) }
    output.destroy(normalized)
  }
  void zaiAccountBrowserManager.withChatWindow({ ...options, interactive: false }, async window => {
    const key = `__chat2api_zai_${randomUUID().replaceAll('-', '')}`
    let installed = false, completed = false
    const cancel = () => { if (!completed) output.destroy(new ZaiWebsiteChatError('cancelled')) }
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      assertAccountCurrent()
      await preparePage(window, options, value => { stage = value })
      assertAccountCurrent()
      if (options.signal?.aborted || output.destroyed) throw new ZaiWebsiteChatError('cancelled')
      installed = await window.webContents.executeJavaScript(zaiChatCaptureScript(key, options)) === true
      if (!installed) throw new ZaiWebsiteChatError('browser_unavailable')
      stage = 'input'
      const focused = await window.webContents.executeJavaScript(`(() => { const input = document.getElementById('chat-input'); if (location.origin !== ${JSON.stringify(ORIGIN)} || !input || input.disabled || input.value) return false; input.focus(); return true; })()`)
      if (!focused) throw new ZaiWebsiteChatError('browser_unavailable')
      await window.webContents.insertText(options.prompt)
      await waitFor(window, `!!document.getElementById('send-message-button') && !document.getElementById('send-message-button').disabled`, options.signal, 5000)
      assertAccountCurrent()
      stage = 'submit'
      const submitted = await window.webContents.executeJavaScript(`(() => { if (location.origin !== ${JSON.stringify(ORIGIN)}) return false; const input = document.getElementById('chat-input'), button = document.getElementById('send-message-button'); if (!input || input.value !== ${JSON.stringify(options.prompt)} || !button || button.disabled) return false; button.click(); return true; })()`)
      if (!submitted) throw new ZaiWebsiteChatError('browser_unavailable')
      let metadata: { status: number; contentType: string; chatId: string; requestId: string } | undefined
      let challengeShown = false
      let lastProgress = Date.now(), deadline = lastProgress + SUBMIT_TIMEOUT, bytes = 0, terminal = false, malformed = false
      const heldTail: string[] = []
      const parser = createParser({ onEvent(event) {
        if (event.data === '[DONE]') return
        try {
          if (terminal) { malformed = true; return }
          const data = JSON.parse(event.data)
          if (data?.type === 'chat:completion' && data.data?.phase === 'done' && data.data?.done === true) terminal = true
        }
        catch { malformed = true }
      } })
      while (true) {
        assertAccountCurrent()
        if (options.signal?.aborted || output.destroyed) throw new ZaiWebsiteChatError('cancelled')
        if (!currentOrigin(window)) throw new ZaiWebsiteChatError('account_changed')
        const state = await window.webContents.executeJavaScript(zaiChatDrainScript(key))
        if (['submit', 'identity', 'stream'].includes(state?.stage)) stage = state.stage
        if (typeof state?.reason === 'string' && SAFE_REASONS.has(state.reason)) reason = state.reason
        if (state?.error) throw safeError({ code: state.error }, 'upstream_error')
        if (!state || !Array.isArray(state.chunks)) throw new ZaiWebsiteChatError('protocol_mismatch')
        if (state.challengeVisible === true && !challengeShown) { challengeShown = true; window.show(); window.focus() }
        if (!metadata && state.metadata) {
          const value = state.metadata
          if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599 || !identifier(value.chatId) || !identifier(value.requestId)
            || typeof value.contentType !== 'string' || value.contentType.length > 256) throw new ZaiWebsiteChatError('protocol_mismatch')
          metadata = value
          deadline = Date.now() + RESPONSE_TIMEOUT
          returned = true
          resolve({ response: { status: value.status, headers: { 'content-type': value.contentType }, data: output }, chatId: value.chatId, requestId: value.requestId })
        }
        for (const chunk of state.chunks) {
          if (typeof chunk !== 'string') throw new ZaiWebsiteChatError('protocol_mismatch')
          bytes += Buffer.byteLength(chunk)
          if (bytes > MAX_OUTPUT) throw new ZaiWebsiteChatError('incomplete_stream')
          lastProgress = Date.now()
          if (metadata?.contentType.includes('text/event-stream')) parser.feed(chunk)
          // Existing parsers finish as soon as they see phase:done, not on network EOF.
          // Hold that tail until the account lease has actually been released; otherwise an
          // immediate tool-result continuation can wrongly encounter account_busy.
          if (terminal || heldTail.length) { heldTail.push(chunk); continue }
          if (!output.write(chunk)) {
            while (output.writableNeedDrain && !output.destroyed) {
              if (options.signal?.aborted) throw new ZaiWebsiteChatError('cancelled')
              if (Date.now() > deadline) throw new ZaiWebsiteChatError('incomplete_stream')
              await delay(25)
            }
          }
        }
        if (state.done) {
          assertAccountCurrent()
          if (!metadata || (metadata.contentType.includes('text/event-stream') && (!terminal || malformed))) { reason = 'incomplete_terminal'; throw new ZaiWebsiteChatError('incomplete_stream') }
          if (options.onConversation && terminal) {
            stage = 'cursor'
            const cursorDeadline = Date.now() + 10000
            let assistantId: string | undefined
            while (Date.now() < cursorDeadline) {
              assertAccountCurrent()
              if (options.signal?.aborted || output.destroyed) throw new ZaiWebsiteChatError('cancelled')
              const cursor = await window.webContents.executeJavaScript(zaiChatCursorScript(key))
              assertAccountCurrent()
              if (cursor?.error) throw safeError({ code: cursor.error }, 'protocol_mismatch')
              if (identifier(cursor?.assistantId)) { assistantId = cursor.assistantId; break }
              await delay(250)
            }
            if (!assistantId) { reason = 'cursor_missing'; throw new ZaiWebsiteChatError('protocol_mismatch') }
            assertAccountCurrent()
            options.onConversation({ sessionId: metadata.chatId, parentMessageId: assistantId })
          }
          completed = true
          completionTail = heldTail.join('')
          return
        }
        if (Date.now() > deadline || (metadata && Date.now() - lastProgress > 60000)) {
          if (!metadata) { window.show(); window.focus(); throw new ZaiWebsiteChatError(state.challengeVisible === true ? 'action_required' : 'browser_unavailable') }
          throw new ZaiWebsiteChatError('incomplete_stream')
        }
        await delay(50)
      }
    } finally {
      options.signal?.removeEventListener('abort', cancel)
      if (installed && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        await window.webContents.executeJavaScript(zaiChatCloseScript(key, !completed)).catch(() => {})
      }
    }
  }).then(() => { if (!output.destroyed) output.end(completionTail) }).catch(rejectSafe)
  return response
}
