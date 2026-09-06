const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { setTimeout: sleep } = require('node:timers/promises')
const ORIGIN = 'https://chat.z.ai'
const plain = value => JSON.parse(JSON.stringify(value))
const frame = data => `data: ${JSON.stringify({ type: 'chat:completion', data })}\n\n`
const ANSWER = frame({ role: 'assistant', id: 'assistant-1', phase: 'answer', delta_content: '你好' })
const DONE = frame({ role: 'assistant', id: 'assistant-1', phase: 'done', done: true })
const config = overrides => ({ accountId: 'account-1', credentials: { token: 'synthetic-credential' }, expectedIdentity: { userId: 'user-1' }, model: 'x-preview-l', prompt: 'fixture question', ...overrides })
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

/** Real production bridge scripts and stream parser; a fake website owns its normal submit/refresh logic. */
function fixture(options = {}) {
  let source, context, selected = 'x-preview-l', currentURL = `${ORIGIN}/`, closed = false, busy = false, taskFinished = false, now = 0, pageToken = 'synthetic-page-token'
  const calls = [], authCalls = [], graphCalls = [], loads = [], officialBodies = [], nativeAborts = [], safeLogs = [], proofs = 'synthetic-proof-must-remain-only-in-official-request'
  const input = { value: '', disabled: false, focus() {}, closest() { return form } }
  const toggle = { disabled: false, active: false, getAttribute() { return String(toggle.active) }, click() { toggle.active = !toggle.active } }
  const form = { querySelectorAll() { return [toggle] } }
  const selector = { click() {} }
  const send = { get disabled() { return !input.value }, click() {
    if (options.neverSubmit) return
    const body = {
      model: selected, messages: [{ role: 'user', content: input.value }], stream: true,
      chat_id: new URL(currentURL).pathname.startsWith('/c/') ? new URL(currentURL).pathname.slice(3) : 'site-created-chat-1',
      id: 'site-created-request-1', current_user_message_parent_id: new URL(currentURL).pathname.startsWith('/c/') ? 'assistant-previous' : null,
      current_user_message_id: 'site-user-node-1',
      features: { auto_web_search: toggle.active, enable_thinking: true }, captcha_verify_param: proofs,
      ...options.body,
    }
    const submit = () => context.fetch(`${ORIGIN}/api/v2/chat/completions`, {
      method: 'POST', body: JSON.stringify(body), headers: { Authorization: 'Bearer synthetic-page-token', 'X-Signature': 'synthetic-signature' },
    }).then(response => response.text()).then(text => officialBodies.push(text)).catch(() => {})
    void submit()
    if (options.duplicate) void submit()
  } }
  function newPage() {
    input.value = ''
    const document = {
      getElementById(id) {
        if (id === 'chat-input') return input
        if (id === 'send-message-button') return send
        if (id === `model-selector-${selected}-button`) return selector
        return null
      },
      querySelector(selectorString) {
        if (selectorString.startsWith('button[id^=')) return selector
        const model = /data-value="([^"]+)"/.exec(selectorString)?.[1]
        if (model && ['x-preview-l', 'glm-5.3'].includes(model)) return { disabled: !!options.disabledModel, click() { selected = model } }
        return null
      },
      querySelectorAll() { return options.visibleChallenge ? [{ getBoundingClientRect() { return { width: 200, height: 200 } } }] : [] },
    }
    source = async (url, init) => {
      if (String(url) === `${ORIGIN}/api/v1/auths/`) {
        authCalls.push({ url: String(url), init })
        if (options.authWait) await options.authWait
        const response = new Response(JSON.stringify(options.authIdentity ?? { id: 'user-1', email: 'one@example.test' }), { status: options.authStatus ?? 200 })
        Object.defineProperty(response, 'url', { value: options.authURL ?? String(url) })
        return response
      }
      if (String(url).startsWith(`${ORIGIN}/api/v1/chats/`)) {
        graphCalls.push({ url: String(url), init })
        const body = options.graph ? options.graph(graphCalls.length) : { chat: { history: { messages: {
          'site-user-node-1': { id: 'site-user-node-1', role: 'user', parentId: null, childrenIds: ['site-created-request-1'] },
          'site-created-request-1': { id: 'site-created-request-1', role: 'assistant', parentId: 'site-user-node-1', model: selected, done: true, content: 'private transcript not exported' },
        } } } }
        const response = new Response(JSON.stringify(body), { status: options.graphStatus ?? 200 })
        Object.defineProperty(response, 'url', { value: String(url) })
        return response
      }
      calls.push({ url: String(url), body: JSON.parse(init.body), init })
      init.signal?.addEventListener('abort', () => { nativeAborts.push(true) }, { once: true })
      if (options.beforeResponse) await options.beforeResponse
      const chunks = options.chunks ?? [ANSWER, DONE]
      const stream = new ReadableStream({ async start(controller) {
        if (options.streamWait) await options.streamWait
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      } })
      const response = new Response(stream, { status: options.status ?? 200, headers: { 'content-type': options.contentType ?? 'text/event-stream' } })
      Object.defineProperty(response, 'url', { value: options.responseURL ?? String(url) })
      return response
    }
    context = vm.createContext({ URL, AbortController, AbortSignal, TextDecoder, TextEncoder, Response, Headers, document, location: new URL(currentURL), fetch: source,
      setTimeout, clearTimeout, localStorage: { getItem(key) { assert.equal(key, 'token'); return pageToken } },
      getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' } },
      console: { log() { throw new Error('No raw site logs') } } })
    context.window = context
  }
  newPage()
  const window = {
    shown: false, focused: false,
    isDestroyed() { return closed },
    async loadURL(url) { currentURL = url; loads.push(url); newPage(); if (options.loadError) throw options.loadError },
    show() { this.shown = true }, focus() { this.focused = true },
    webContents: {
      isDestroyed() { return closed }, getURL() { return currentURL },
      async executeJavaScript(script) { if (options.beforeExecute) options.beforeExecute(script); return vm.runInContext(script, context) },
      async insertText(text) { input.value = text },
    },
  }
  const manager = { async withChatWindow(opts, task) {
    assert.equal(opts.interactive, false)
    if (options.managerError) throw Object.assign(new Error('secret manager error'), { code: options.managerError })
    if (busy) throw { code: 'account_busy' }
    busy = true
    try { return await task(window) } finally { busy = false; taskFinished = true }
  } }
  const module = { exports: {} }
  const file = path.join(__dirname, '../../src/main/oauth/zaiWebsiteChat.ts')
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText
  class Clock extends Date { static now() { return now } }
  vm.runInNewContext(code, {
    module, exports: module.exports, URL, Buffer, Date: Clock, AbortController,
    require(name) {
      if (name === './zaiAccountBrowser') return { zaiAccountBrowserManager: manager }
      if (name === 'node:timers/promises') return { setTimeout: async ms => { now += options.fastTimeout ? 30000 : ms; await sleep(1) } }
      if (name.startsWith('.')) throw new Error(`Unmocked ${name}`)
      return require(name)
    },
    console: { log() { throw new Error('No raw proxy logs') }, warn(label, diagnostic) {
      assert.equal(label, '[ZaiWebsiteChat]')
      assert.ok(Object.keys(diagnostic).every(key => ['stage', 'code', 'reason'].includes(key)))
      assert.ok(!/synthetic|fixture|https:|Bearer/.test(JSON.stringify(diagnostic)))
      safeLogs.push(plain(diagnostic))
    }, error() { throw new Error('No raw error logs') } },
  }, { filename: file })
  return { ...module.exports, window, calls, authCalls, graphCalls, loads, proofs, officialBodies, nativeAborts, safeLogs,
    get context() { return context }, get busy() { return busy }, get taskFinished() { return taskFinished },
    close() { closed = true }, async settled() { for (let index = 0; index < 100 && !taskFinished; index++) await sleep(2); assert.equal(taskFinished, true) },
    setPageToken(token) { pageToken = token },
  }
}
async function collect(stream) { let text = ''; for await (const chunk of stream) text += chunk; return text }

test('normal DOM submission preserves website proofs privately and returns exact SSE with website IDs', async () => {
  const f = fixture()
  const result = await f.runZaiWebsiteChat(config())
  assert.equal(result.chatId, 'site-created-chat-1'); assert.equal(result.requestId, 'site-created-request-1')
  assert.equal(result.response.status, 200)
  assert.equal(await collect(result.response.data), ANSWER + DONE)
  await f.settled()
  assert.equal(f.calls.length, 1)
  assert.equal(f.authCalls.length, 1)
  assert.equal(f.authCalls[0].init.credentials, 'omit')
  assert.equal(f.authCalls[0].init.headers.Authorization, 'Bearer synthetic-page-token')
  assert.equal(f.calls[0].body.captcha_verify_param, f.proofs, 'only the official submitter supplies its own proof')
  const key = Object.getOwnPropertyNames(f.context).find(key => key.startsWith('__chat2api_zai_'))
  const state = JSON.stringify(f.context[key])
  assert.ok(!state.includes(f.proofs)); assert.ok(!state.includes('synthetic-page-token')); assert.ok(!state.includes('synthetic-signature'))
  assert.equal(f.busy, false)
  assert.equal(f.nativeAborts.length, 0, 'successful tee completion must not abort the website response branch')
})

test('model DOM selection is exact and disabled models never submit', async () => {
  const f = fixture()
  const result = await f.runZaiWebsiteChat(config({ model: 'glm-5.3', webSearch: true }))
  await collect(result.response.data); await f.settled()
  assert.equal(f.calls[0].body.model, 'glm-5.3'); assert.equal(f.calls[0].body.features.auto_web_search, true)
  const disabled = fixture({ disabledModel: true })
  await assert.rejects(disabled.runZaiWebsiteChat(config({ model: 'glm-5.3' })), error => error.code === 'model_unavailable')
  assert.equal(disabled.calls.length, 0)
})

test('continuation opens its actual chat and verifies the previous assistant parent before sending', async () => {
  const f = fixture()
  const result = await f.runZaiWebsiteChat(config({ conversation: { sessionId: 'existing-chat', parentMessageId: 'assistant-previous' }, prompt: 'only current turn' }))
  await collect(result.response.data); await f.settled()
  assert.deepEqual(f.loads, [`${ORIGIN}/c/existing-chat`])
  assert.equal(f.calls[0].body.messages[0].content, 'only current turn')
  const wrong = fixture({ body: { current_user_message_parent_id: 'different-assistant' } })
  await assert.rejects(wrong.runZaiWebsiteChat(config({ conversation: { sessionId: 'existing-chat', parentMessageId: 'assistant-previous' } })), error => error.code === 'protocol_mismatch')
  assert.equal(wrong.calls.length, 0)
})

test('model, prompt, conversation and unsupported feature mismatch reject before network submission', async () => {
  for (const body of [{ model: 'unrequested-model' }, { messages: [{ role: 'user', content: 'other input' }] }, { current_user_message_parent_id: 'unexpected-parent' }]) {
    const f = fixture({ body })
    await assert.rejects(f.runZaiWebsiteChat(config()), error => error.code === 'protocol_mismatch')
    assert.equal(f.calls.length, 0)
  }
  const f = fixture()
  await assert.rejects(f.runZaiWebsiteChat(config({ thinking: false })), error => error.code === 'unsupported_options')
  assert.equal(f.calls.length, 0)
})

test('no request is sent twice, including a late official retry after capture cleanup', async () => {
  const duplicate = fixture({ duplicate: true })
  await assert.rejects(duplicate.runZaiWebsiteChat(config()), error => error.code === 'protocol_mismatch')
  assert.ok(duplicate.calls.length <= 1)
  const f = fixture()
  const result = await f.runZaiWebsiteChat(config()); await collect(result.response.data); await f.settled()
  await assert.rejects(f.context.fetch(`${ORIGIN}/api/v2/chat/completions`, { method: 'POST', body: JSON.stringify(f.calls[0].body) }))
  assert.equal(f.calls.length, 1)
})

test('stream lock is held until response finishes; header readiness does not unlock the account', async () => {
  const waiting = deferred(), f = fixture({ streamWait: waiting.promise })
  const result = await f.runZaiWebsiteChat(config())
  assert.equal(f.busy, true); assert.equal(f.taskFinished, false)
  await assert.rejects(f.runZaiWebsiteChat(config()), error => error.code === 'account_busy')
  waiting.resolve(); await collect(result.response.data); await f.settled()
  assert.equal(f.calls.length, 1)
})

test('terminal SSE is exposed only after unlock, allowing an immediate next tool-result turn', async () => {
  const f = fixture()
  const first = await f.runZaiWebsiteChat(config())
  let second
  first.response.data.on('data', chunk => {
    if (chunk.toString().includes('"phase":"done"')) {
      assert.equal(f.busy, false, 'terminal event must not precede release of the account lease')
      second = f.runZaiWebsiteChat(config({ prompt: 'tool result current input', conversation: { sessionId: 'site-created-chat-1', parentMessageId: 'assistant-previous' } }))
    }
  })
  await collect(first.response.data)
  assert.ok(second)
  const result = await second; await collect(result.response.data)
  assert.equal(f.calls.length, 2)
})

test('truncated SSE and malformed frames never produce a fabricated terminal success', async () => {
  for (const chunks of [[ANSWER], ['data: not-json\n\n', DONE], ['data: [DONE]\n\n']]) {
    const f = fixture({ chunks })
    const result = await f.runZaiWebsiteChat(config())
    await assert.rejects(collect(result.response.data), error => error.code === 'incomplete_stream')
    await f.settled()
    assert.equal(f.calls.length, 1)
  }
})

test('HTTP/JSON failures remain real failure bodies for the existing safe provider parser', async () => {
  for (const status of [200, 403, 429]) {
    const body = JSON.stringify({ error: { code: 'FRONTEND_CAPTCHA_REQUIRED', message: 'synthetic private error' } })
    const f = fixture({ chunks: [body], contentType: 'application/json', status })
    const result = await f.runZaiWebsiteChat(config())
    assert.equal(result.response.status, status)
    assert.equal(await collect(result.response.data), body)
    await f.settled()
  }
})

test('manual verification timeout shows only API page and late verification may not submit', async () => {
  const f = fixture({ neverSubmit: true, fastTimeout: true, visibleChallenge: true })
  await assert.rejects(f.runZaiWebsiteChat(config()), error => error.code === 'action_required')
  assert.equal(f.window.shown, true); assert.equal(f.window.focused, true)
  await assert.rejects(f.context.fetch(`${ORIGIN}/api/v2/chat/completions`, { method: 'POST', body: '{}' }))
  assert.equal(f.calls.length, 0)
})

test('no response alone is not misreported as CAPTCHA, and redirected responses fail closed', async () => {
  const stalled = fixture({ neverSubmit: true, fastTimeout: true })
  await assert.rejects(stalled.runZaiWebsiteChat(config()), error => error.code === 'browser_unavailable')
  assert.equal(stalled.window.shown, true)
  for (const responseURL of ['https://idp.example.test/', `${ORIGIN}/auth`]) {
    const f = fixture({ responseURL })
    await assert.rejects(f.runZaiWebsiteChat(config()), error => error.code === 'protocol_mismatch')
    assert.equal(f.calls.length, 1)
  }
})

test('normal ERR_ABORTED load handoff still requires the real official page and matching request', async () => {
  const f = fixture({ loadError: { code: 'ERR_ABORTED', errno: -3 } })
  const result = await f.runZaiWebsiteChat(config()); await collect(result.response.data); await f.settled()
  assert.equal(f.calls.length, 1)
  const broken = fixture({ loadError: { code: 'ERR_FAILED' } })
  await assert.rejects(broken.runZaiWebsiteChat(config()), error => error.code === 'browser_unavailable')
  assert.equal(broken.calls.length, 0)
})

test('caller cancellation aborts only its native chat and releases the account lock', async () => {
  const waiting = deferred(), controller = new AbortController(), f = fixture({ streamWait: waiting.promise })
  const result = await f.runZaiWebsiteChat(config({ signal: controller.signal }))
  controller.abort()
  await assert.rejects(collect(result.response.data), error => error.code === 'cancelled')
  await f.settled(); waiting.resolve()
  assert.equal(f.nativeAborts.length, 1); assert.equal(f.busy, false)
})

test('boundary validation and safe manager failures do not expose native exception prose', async () => {
  const f = fixture()
  for (const options of [config({ model: '../../escape' }), config({ prompt: '' }), config({ conversation: { sessionId: 'known' } })]) {
    await assert.rejects(f.runZaiWebsiteChat(options), error => error.code === 'invalid_request')
  }
  assert.equal(f.loads.length, 0)
  const blocked = fixture({ managerError: 'login_required' })
  await assert.rejects(blocked.runZaiWebsiteChat(config()), error => error.code === 'login_required' && !error.message.includes('secret'))
})

test('the actual submission Bearer must verify the bound non-guest account before generation', async () => {
  for (const authIdentity of [{ id: 'different-user', email: 'other@example.test' }, { id: 'user-1', email: 'anonymous@guest.com' }, { id: 'user-1', isGuest: true }, {}]) {
    const f = fixture({ authIdentity })
    await assert.rejects(f.runZaiWebsiteChat(config()), error => ['login_required', 'account_changed'].includes(error.code))
    assert.equal(f.calls.length, 0)
  }
  for (const overrides of [{ authStatus: 401 }, { authURL: 'https://idp.example.test/auth' }]) {
    const f = fixture(overrides)
    await assert.rejects(f.runZaiWebsiteChat(config()), error => error.code === 'login_required')
    assert.equal(f.calls.length, 0)
  }
})

test('a page token switch while identity verification is pending blocks the actual generation', async () => {
  const waiting = deferred(), f = fixture({ authWait: waiting.promise })
  const pending = f.runZaiWebsiteChat(config())
  while (!f.authCalls.length) await sleep(1)
  f.setPageToken('switched-account-token'); waiting.resolve()
  await assert.rejects(pending, error => error.code === 'account_changed')
  assert.equal(f.calls.length, 0)
})

test('an earlier request Bearer remains valid when page storage already rotated for the same identity', async () => {
  const f = fixture()
  f.setPageToken('rotated-same-account-storage-token')
  const result = await f.runZaiWebsiteChat(config()); await collect(result.response.data); await f.settled()
  assert.equal(f.authCalls[0].init.headers.Authorization, 'Bearer synthetic-page-token')
  assert.equal(f.calls.length, 1)
})

test('main account-revision guard fails before preparation and again during the response lifecycle', async () => {
  const stale = fixture()
  await assert.rejects(stale.runZaiWebsiteChat(config({ isAccountCurrent: () => false })), error => error.code === 'account_changed')
  assert.equal(stale.loads.length, 0); assert.equal(stale.calls.length, 0)
  let current = true
  const waiting = deferred(), f = fixture({ streamWait: waiting.promise })
  const result = await f.runZaiWebsiteChat(config({ isAccountCurrent: () => current }))
  current = false
  await assert.rejects(collect(result.response.data), error => error.code === 'account_changed')
  await f.settled(); waiting.resolve()
  assert.equal(f.calls.length, 1)
})

test('missing SSE role/id is repaired only by an authoritative matching persisted assistant graph node', async () => {
  const chunks = [frame({ phase: 'answer', delta_content: 'answer without IDs' }), frame({ phase: 'done', done: true })]
  const f = fixture({ chunks })
  const cursors = []
  const result = await f.runZaiWebsiteChat(config({ onConversation: cursor => cursors.push(plain(cursor)) }))
  result.response.data.on('data', chunk => {
    if (chunk.toString().includes('"phase":"done"')) {
      assert.equal(cursors.length, 1, 'verified cursor must be installed before client sees terminal')
      assert.equal(f.busy, false)
    }
  })
  assert.equal(await collect(result.response.data), chunks.join(''), 'cursor recovery must not forge a text or metadata SSE')
  assert.deepEqual(cursors, [{ sessionId: 'site-created-chat-1', parentMessageId: 'site-created-request-1' }])
  assert.equal(f.graphCalls.length, 1)
  assert.equal(f.graphCalls[0].url, `${ORIGIN}/api/v1/chats/site-created-chat-1`)
  assert.equal(f.graphCalls[0].init.credentials, 'omit')
  assert.equal(f.calls.length, 1, 'cursor reads must never generate again')
})

test('read-only cursor recovery waits for website persistence without returning requestId blindly', async () => {
  const graph = { chat: { history: { messages: {
    'site-user-node-1': { id: 'site-user-node-1', role: 'user', parentId: 'assistant-previous', childrenIds: ['site-created-request-1'] },
    'site-created-request-1': { id: 'site-created-request-1', role: 'assistant', parentId: 'site-user-node-1', model: 'x-preview-l', done: true },
  } } } }
  const f = fixture({ graph: attempt => attempt < 3 ? { chat: { history: { messages: {} } } } : graph })
  const cursors = []
  const result = await f.runZaiWebsiteChat(config({ conversation: { sessionId: 'existing-chat', parentMessageId: 'assistant-previous' }, onConversation: cursor => cursors.push(plain(cursor)) }))
  await collect(result.response.data)
  assert.equal(f.graphCalls.length, 3)
  assert.deepEqual(cursors, [{ sessionId: 'existing-chat', parentMessageId: 'site-created-request-1' }])
  assert.equal(f.calls.length, 1)
  const absent = fixture({ graph: () => ({ chat: { history: { messages: {} } } }) })
  const missing = await absent.runZaiWebsiteChat(config({ onConversation() { throw new Error('must not invent cursor') } }))
  await assert.rejects(collect(missing.response.data), error => error.code === 'protocol_mismatch')
  assert.equal(absent.calls.length, 1)
  assert.equal(absent.safeLogs.at(-1).reason, 'cursor_missing')
})

test('graph role, assistant parent, previous parent and model must match the exact submitted turn', async () => {
  for (const change of [
    { assistant: { role: 'user' } }, { assistant: { parentId: 'another-user' } }, { assistant: { model: 'unrequested-model' } },
    { user: { parentId: 'another-assistant' } }, { user: { childrenIds: ['other-child'] } },
  ]) {
    const f = fixture({ graph: () => ({ chat: { history: { messages: {
      'site-user-node-1': { id: 'site-user-node-1', role: 'user', parentId: null, childrenIds: ['site-created-request-1'], ...change.user },
      'site-created-request-1': { id: 'site-created-request-1', role: 'assistant', parentId: 'site-user-node-1', model: 'x-preview-l', done: true, ...change.assistant },
    } } } }) })
    const result = await f.runZaiWebsiteChat(config({ onConversation() { throw new Error('must not use mismatched graph') } }))
    await assert.rejects(collect(result.response.data), error => error.code === 'protocol_mismatch')
    assert.equal(f.calls.length, 1)
  }
})
