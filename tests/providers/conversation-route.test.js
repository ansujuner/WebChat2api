const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')
const ts = require('typescript')
const Koa = require('koa')
const bodyParser = require('koa-bodyparser')
const { Readable, PassThrough } = require('node:stream')
const { once } = require('node:events')
const http = require('node:http')

const root = join(__dirname, '..', '..')
const plain = value => JSON.parse(JSON.stringify(value))
const user = content => ({ role: 'user', content })
const assistant = content => ({ role: 'assistant', content })
const complete = content => ({ id: 'fixture-response', object: 'chat.completion', model: 'fixture-model',
  choices: [{ index: 0, message: assistant(content), finish_reason: 'stop' }] })
const chunk = (content, finish_reason = null) => `data: ${JSON.stringify({
  id: 'fixture-response', object: 'chat.completion.chunk', model: 'fixture-model',
  choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason }],
})}\n\n`

function loadRoute(overrides, relative = 'src/main/proxy/routes/chat.ts') {
  const fileName = join(root, relative)
  const result = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  assert.equal(result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  const module = { exports: {} }
  vm.runInNewContext(result.outputText, {
    module, exports: module.exports, Buffer, AbortController,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      if (name.startsWith('.')) throw new Error(`Unmocked route dependency: ${name}`)
      return require(name)
    },
  }, { filename: fileName })
  return module.exports
}

async function setup(t, { custom = false, forward, legacy = false, noSelection = false, rateLimit } = {}) {
  const continuity = await import(pathToFileURL(join(root, 'src/main/proxy/conversationContinuity.ts')))
  const streamModule = await import(pathToFileURL(join(root, 'src/main/proxy/conversationStream.ts')))
  continuity.conversationContinuity.clear()
  const calls = [], selections = [], logs = [], marked = []
  const counters = { total: 0, success: 0, failure: 0, active: 0, accountUpdates: 0, persisted: [] }
  let created = 0
  const provider = { id: custom ? 'custom' : 'deepseek', type: custom ? 'custom' : 'builtin', name: 'Fixture' }
  const accounts = [{ id: 'account-A', name: 'A', status: 'active' }, { id: 'account-B', name: 'B', status: 'active' }]
  const chat = loadRoute({
    '@koa/router': { default: require('@koa/router') },
    '../../../shared/accountAvailability': require('../../src/shared/accountAvailability.ts'),
    '../conversationContinuity': continuity,
    '../conversationStream': streamModule,
    '../requestValidation': await import('../../src/main/proxy/requestValidation.ts'),
    '../requestAccounting': await import('../../src/main/proxy/requestAccounting.ts'),
    '../clientIdentity': await import('../../src/main/proxy/clientIdentity.ts'),
    '../loadbalancer': { loadBalancer: {
      selectAccount(model, strategy, preferredProvider, preferredAccount) {
        selections.push({ model, strategy, preferredProvider, preferredAccount })
        if (noSelection) return null
        const account = preferredAccount ? accounts.find(value => value.id === preferredAccount) : accounts[(selections.length - 1) % 2]
        return account ? { account, provider, actualModel: 'fixture-model' } : null
      },
      getModelRateLimit: () => rateLimit,
      markAccountFailed: id => marked.push(id), clearAccountFailure() {},
    } },
    '../modelMapper': { modelMapper: { getPreferredProvider() {}, getPreferredAccount() {} } },
    '../status': { proxyStatusManager: {
      recordRequestStart() { counters.total++; counters.active++ },
      recordRequestSuccess() { counters.success++; counters.active-- },
      recordRequestFailure() { counters.failure++; counters.active-- },
    } },
    '../../store/store': { storeManager: {
      getConfig: () => ({ sessionConfig: { sessionTimeout: 30 }, loadBalanceStrategy: 'round-robin' }),
      addLog() {}, getAccountById: id => accounts.find(account => account.id === id),
      updateAccount(id, updates) { counters.accountUpdates++; const index = accounts.findIndex(account => account.id === id); if (index >= 0) accounts[index] = { ...accounts[index], ...updates } },
      updateRequestLog(id, update) { Object.assign(logs[Number(id) - 1], update) },
      recordRequestInStats(success) { counters.persisted.push(success) },
      addRequestLog: value => { logs.push(value); return { id: String(logs.length) } },
    } },
    '../stream': { streamHandler: { createTransformStream: () => new PassThrough() } },
    '../utils/toolFormatConverter': {
      isAnthropicToolFormat: () => false,
      transformResponseToAnthropic: value => value, transformChunkToAnthropic: value => value,
    },
    '../forwarder': { requestForwarder: {
      supportsConversation: () => !custom,
      async forwardChatCompletion(request, account) {
        const options = continuity.getConversationOptions(request)
        calls.push({ request: plain(request), options, account: account.id })
        if (forward) return forward({ request, options, calls, account })
        if (!custom) options.onConversation?.({
          sessionId: options.conversation?.sessionId || `upstream-${++created}`,
          parentMessageId: `assistant-${calls.length}`,
        })
        const content = `回答${calls.length}`
        if (request.stream) {
          const bytes = Buffer.from(chunk(content) + chunk(null, 'stop') + 'data: [DONE]\n\n')
          return { success: true, status: 200, skipTransform: true, stream: Readable.from(
            Array.from({ length: Math.ceil(bytes.length / 5) }, (_, i) => bytes.subarray(i * 5, i * 5 + 5))) }
        }
        return { success: true, status: 200, skipTransform: true, body: complete(content) }
      },
    } },
  })
  const route = legacy ? loadRoute({
    '@koa/router': { default: require('@koa/router') }, './chat': chat,
    '../legacyCompletions': await import('../../src/main/proxy/legacyCompletions.ts'),
  }, 'src/main/proxy/routes/completions.ts').default : chat.default
  const app = new Koa()
  app.on('error', () => {})
  app.use(bodyParser())
  app.use(route.routes()).use(route.allowedMethods())
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    continuity.conversationContinuity.clear()
  })
  const url = `http://127.0.0.1:${server.address().port}/v1/${legacy ? '' : 'chat/'}completions`
  return { url, calls, selections, logs, marked, counters, accounts, created: () => created,
    post: (body, headers = {}) => fetch(url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-client-A', ...headers }, body: JSON.stringify(body) }),
  }
}

async function answer(response, streaming) {
  assert.equal(response.status, 200)
  const sessionId = response.headers.get('X-Chat2API-Session-ID')
  assert.match(sessionId, /^c2a-[a-f0-9-]{36}$/)
  if (!streaming) {
    const body = await response.json()
    assert.equal(body.session_id, sessionId)
    return { sessionId, message: body.choices[0].message }
  }
  const text = await response.text()
  assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1)
  const content = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)).choices[0].delta.content || '').join('')
  return { sessionId, message: assistant(content) }
}

for (const change of [{ enabled: false }, { cooldownReason: 'temporary_ban', cooldownUntil: Date.now() + 3600000 }, { status: 'expired' }, { status: 'error' }]) {
  test(`existing HTTP conversation never switches accounts or submits after bound account becomes unavailable: ${JSON.stringify(change)}`, async t => {
    const f = await setup(t)
    const first = await answer(await f.post({ model: 'fixture-model', messages: [user('first')] }), false)
    f.accounts[0] = { ...f.accounts[0], ...change }
    const second = await f.post({ model: 'fixture-model', session_id: first.sessionId, messages: [user('next')] })
    assert.equal(second.status, 409)
    const body = await second.json()
    assert.equal(body.error.code, change.cooldownUntil ? 'account_cooling_down' : 'account_unavailable')
    if (change.cooldownUntil) assert.ok(Number(second.headers.get('Retry-After')) > 0)
    assert.equal(f.calls.length, 1, 'No second provider submission')
    assert.equal(f.selections.length, 1, 'No fallback account selection')
    assert.equal(f.accounts[1].status, 'active', 'Another healthy account must not become a bypass')
    f.accounts[0] = { id: 'account-A', name: 'A', status: 'active', enabled: true }
    const resumed = await answer(await f.post({ model: 'fixture-model', session_id: first.sessionId, messages: [user('next')] }), false)
    assert.equal(resumed.sessionId, first.sessionId, 'Rejected preflight leaves the original conversation resumable')
    assert.equal(f.calls[1].account, 'account-A')
  })
}

test('HTTP model-only quota returns 429 with Retry-After before any submission, not a generic 503', async t => {
  const f = await setup(t, { noSelection: true, rateLimit: { availableAt: Date.now() + 60000 } })
  const response = await f.post({ model: 'arena/text/Test', messages: [user('not submitted')] })
  assert.equal(response.status, 429)
  assert.equal((await response.json()).error.code, 'model_rate_limited')
  assert.ok(Number(response.headers.get('Retry-After')) > 0)
  assert.equal(f.calls.length, 0)
})

test('HTTP unavailable account/storage without a trustworthy model limit remains 503', async t => {
  const f = await setup(t, { noSelection: true })
  const response = await f.post({ model: 'arena/text/Test', messages: [user('not submitted')] })
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Retry-After'), null)
  assert.equal(f.calls.length, 0)
})

for (const streaming of [true, false]) {
  for (const mode of ['full-history', 'explicit-id']) {
    test(`HTTP ${streaming ? 'stream' : 'non-stream'} ${mode} keeps one account/chat and forwards only three new inputs`, async t => {
      const fixture = await setup(t)
      const history = []
      let sessionId
      const inputs = ['你好', '今天天气怎么样', '接着说']
      for (let turn = 0; turn < inputs.length; turn++) {
        history.push(user(inputs[turn]))
        const response = await fixture.post({ model: 'fixture-model', stream: streaming,
          messages: mode === 'explicit-id' ? [user(inputs[turn])] : history,
        }, mode === 'explicit-id' && sessionId ? { 'X-Chat2API-Session-ID': sessionId } : {})
        const result = await answer(response, streaming)
        if (sessionId) assert.equal(result.sessionId, sessionId)
        sessionId = result.sessionId
        assert.equal(result.message.content, `回答${turn + 1}`)
        history.push(result.message)
        assert.deepEqual(fixture.calls[turn].request.messages, [user(inputs[turn])])
        assert.equal(fixture.calls[turn].account, 'account-A')
        assert.equal(fixture.calls[turn].options.retainConversation, true)
        if (turn > 0) {
          assert.equal(fixture.calls[turn].options.conversation.sessionId, 'upstream-1')
          assert.equal(fixture.calls[turn].options.conversation.parentMessageId, `assistant-${turn}`)
          assert.equal(fixture.selections[turn].preferredAccount, 'account-A')
        }
      }
      assert.equal(fixture.created(), 1)
      assert.doesNotMatch(JSON.stringify(fixture.logs.map(log => log.requestBody)), /upstream-1|assistant-1|onConversation|retainConversation/)
    })
  }
}

test('HTTP custom stateless API retains full transcript and has no managed conversation header', async t => {
  const fixture = await setup(t, { custom: true })
  const messages = [user('你好'), assistant('你好呀'), user('今天天气怎么样')]
  const response = await fixture.post({ model: 'fixture-model', messages })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('X-Chat2API-Session-ID'), null)
  assert.deepEqual(fixture.calls[0].request.messages, messages)
  assert.equal(fixture.calls[0].options.conversation, undefined)
  assert.equal(fixture.calls[0].options.signal.aborted, false)
  await response.json()
})

test('HTTP rejects malformed IDs, roles and n>1 before forwarding', async t => {
  const fixture = await setup(t)
  for (const body of [
    { session_id: 'website-chat-id', messages: [user('你好')] },
    { messages: [{ role: 'invalid', content: '你好' }] },
    { messages: [user('你好')], n: 2 },
  ]) {
    const response = await fixture.post({ model: 'fixture-model', ...body })
    assert.equal(response.status, 400)
    await response.json()
  }
  assert.equal(fixture.calls.length, 0)
})

test('HTTP unknown and different-client session IDs return 404 without exposing or forwarding a conversation', async t => {
  const fixture = await setup(t)
  const unknown = await fixture.post({ model: 'fixture-model', messages: [user('你好')], session_id: 'c2a-00000000-0000-0000-0000-000000000000' })
  assert.equal(unknown.status, 404)
  await unknown.json()
  const first = await answer(await fixture.post({ model: 'fixture-model', messages: [user('你好')] }), false)
  const foreign = await fixture.post({ model: 'fixture-model', messages: [user('下一句')], session_id: first.sessionId }, { Authorization: 'Bearer fixture-client-B' })
  assert.equal(foreign.status, 404)
  await foreign.json()
  assert.equal(fixture.calls.length, 1)
})

test('HTTP upstream 401 marks the turn uncertain and continuation returns 409 without an automatic retry', async t => {
  const fixture = await setup(t, { forward: async () => ({ success: false, status: 401, error: 'Fixture expired account' }) })
  const first = await fixture.post({ model: 'fixture-model', messages: [user('你好')] })
  assert.equal(first.status, 401)
  const sessionId = first.headers.get('X-Chat2API-Session-ID')
  await first.json()
  const second = await fixture.post({ model: 'fixture-model', messages: [user('下一句')], session_id: sessionId })
  assert.equal(second.status, 409)
  assert.equal((await second.json()).error.code, 'conversation_uncertain')
  assert.deepEqual(fixture.marked, ['account-A'])
  assert.equal(fixture.calls.length, 1)
})

test('HTTP refuses overlapping full-history continuation with 409 while the first turn is running', async t => {
  let started, release
  const entered = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const fixture = await setup(t, { forward: async ({ options }) => {
    options.onConversation({ sessionId: 'upstream-busy', parentMessageId: 'assistant-busy' })
    started()
    await gate
    return { success: true, status: 200, body: complete('回答1') }
  } })
  const firstPromise = fixture.post({ model: 'fixture-model', messages: [user('你好')] })
  await entered
  const second = await fixture.post({ model: 'fixture-model', messages: [user('你好'), assistant('回答1'), user('下一句')] })
  assert.equal(second.status, 409)
  assert.equal((await second.json()).error.code, 'conversation_busy')
  release()
  await answer(await firstPromise, false)
  assert.equal(fixture.calls.length, 1)
})

test('HTTP partial stream cannot commit; retrying that session returns 409', async t => {
  const fixture = await setup(t, { forward: async ({ options }) => {
    options.onConversation({ sessionId: 'upstream-truncated', parentMessageId: 'assistant-partial' })
    return { success: true, status: 200, skipTransform: true, stream: Readable.from([chunk('部分回答')]) }
  } })
  const first = await fixture.post({ model: 'fixture-model', stream: true, messages: [user('你好')] })
  assert.equal(first.status, 200)
  const sessionId = first.headers.get('X-Chat2API-Session-ID')
  const text = await first.text()
  assert.match(text, /upstream_stream_error/)
  assert.doesNotMatch(text, /data: \[DONE\]/)
  const second = await fixture.post({ model: 'fixture-model', messages: [user('下一句')], session_id: sessionId })
  assert.equal(second.status, 409)
  await second.json()
  assert.equal(fixture.calls.length, 1)
  assert.deepEqual(fixture.counters, { total: 1, success: 0, failure: 1, active: 0, accountUpdates: 0, persisted: [false] })
  assert.equal(fixture.logs[0].status, 'error')
})

test('HTTP client disconnect destroys the upstream source and cannot be resumed as a finished turn', async t => {
  const upstream = new PassThrough()
  const closed = once(upstream, 'close')
  const fixture = await setup(t, { forward: async ({ options }) => {
    options.onConversation({ sessionId: 'upstream-disconnected', parentMessageId: 'assistant-partial' })
    upstream.write(chunk('部分回答'))
    return { success: true, status: 200, skipTransform: true, stream: upstream }
  } })
  const sessionId = await new Promise((resolve, reject) => {
    const request = http.request(fixture.url, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: 'Bearer fixture-client-A',
    } }, response => {
      response.once('data', () => {
        const id = response.headers['x-chat2api-session-id']
        response.destroy()
        request.destroy()
        resolve(id)
      })
      response.on('error', () => {})
    })
    request.on('error', reject)
    request.end(JSON.stringify({ model: 'fixture-model', stream: true, messages: [user('你好')] }))
  })
  await closed
  const response = await fixture.post({ model: 'fixture-model', messages: [user('下一句')], session_id: sessionId })
  assert.equal(response.status, 409)
  await response.json()
  assert.equal(fixture.calls.length, 1)
  assert.deepEqual(fixture.counters, { total: 1, success: 0, failure: 1, active: 0, accountUpdates: 0, persisted: [false] })
  assert.equal(fixture.logs[0].status, 'error')
})

test('HTTP malformed optional fields are rejected before session selection or any provider call', async t => {
  const fixture = await setup(t)
  for (const extra of [
    { stream: 'false' }, { user: {} }, { temperature: '0.5' }, { top_p: 3 }, { n: 0 }, { max_tokens: 1.5 },
    { stop: [1] }, { tools: 'not-an-array' }, { tools: [{ type: 'function', function: { name: 'Read', parameters: [] } }] },
    { tool_choice: {} }, { web_search: 'true' }, { deep_research: 1 },
    { messages: [{ role: 'tool', content: 'result' }] },
    { messages: [{ role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'Read', arguments: {} } }] }] },
  ]) {
    const response = await fixture.post({ model: 'fixture-model', messages: [user('hello')], ...extra })
    assert.equal(response.status, 400, JSON.stringify(extra))
    const body = await response.json()
    assert.equal(body.error.type, 'invalid_request_error')
    assert.equal(typeof body.error.param, 'string')
  }
  assert.equal(fixture.calls.length, 0)
  assert.equal(fixture.selections.length, 0)
})

test('HTTP stream remains active until response completion and records exactly one final success', async t => {
  const upstream = new PassThrough()
  const fixture = await setup(t, { forward: async ({ options }) => {
    options.onConversation({ sessionId: 'upstream-active', parentMessageId: 'assistant-active' })
    upstream.write(chunk('first'))
    return { success: true, status: 200, skipTransform: true, stream: upstream }
  } })
  const response = await fixture.post({ model: 'fixture-model', stream: true, messages: [user('hello')] })
  assert.equal(response.status, 200)
  assert.deepEqual(fixture.counters, { total: 1, success: 0, failure: 0, active: 1, accountUpdates: 0, persisted: [] })
  upstream.end(chunk(null, 'stop') + 'data: [DONE]\n\n')
  await response.text()
  assert.deepEqual(fixture.counters, { total: 1, success: 1, failure: 0, active: 0, accountUpdates: 1, persisted: [true] })
})

test('HTTP incomplete JSON is counted only as failure rather than success plus failure', async t => {
  const fixture = await setup(t, { forward: async () => ({ success: true, status: 200, body: { choices: [] } }) })
  const response = await fixture.post({ model: 'fixture-model', messages: [user('hello')] })
  assert.equal(response.status, 502)
  await response.json()
  assert.deepEqual(fixture.counters, { total: 1, success: 0, failure: 1, active: 0, accountUpdates: 0, persisted: [false] })
  assert.equal(fixture.logs.length, 1)
  assert.equal(fixture.logs[0].status, 'error')
})

test('actual missing upstream cursor keeps its typed public code and 502 in both HTTP and the existing request log', async t => {
  const fixture = await setup(t, { forward: async () => ({ success: true, status: 200, body: complete('A complete answer without a provider cursor') }) })
  const response = await fixture.post({ model: 'fixture-model', messages: [user('fixture input')] })
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error.code, 'conversation_cursor_missing')
  assert.equal(fixture.calls.length, 1)
  assert.equal(fixture.logs.length, 1, 'The original log is corrected, not duplicated')
  assert.equal(fixture.logs[0].status, 'error')
  assert.equal(fixture.logs[0].statusCode, 502)
  assert.equal(fixture.logs[0].responseStatus, 502)
  assert.equal(JSON.parse(fixture.logs[0].responseBody).error.code, 'conversation_cursor_missing')
  assert.equal(fixture.counters.success, 0); assert.equal(fixture.counters.failure, 1)
})

test('typed early conversation exceptions retain safe codes while untyped status/code properties remain private', async t => {
  const { ConversationError } = await import(pathToFileURL(join(root, 'src/main/proxy/conversationContinuity.ts')))
  for (const typed of [true, false]) {
    const fixture = await setup(t, { forward: async () => {
      throw typed ? new ConversationError('Fixture could not continue.', 'conversation_cursor_missing', 502)
        : Object.assign(new Error('Fixture exception.'), { code: 'PRIVATE-UNTRUSTED-CODE', status: 418 })
    } })
    const response = await fixture.post({ model: 'fixture-model', messages: [user('fixture input')] })
    const body = await response.json()
    assert.equal(response.status, typed ? 502 : 500)
    assert.equal(body.error.code, typed ? 'conversation_cursor_missing' : null)
    assert.equal(fixture.logs.length, 1)
    assert.equal(fixture.logs[0].statusCode, response.status)
    assert.equal(fixture.logs[0].responseStatus, response.status)
    assert.equal(JSON.parse(fixture.logs[0].responseBody).error.code, body.error.code)
    assert.doesNotMatch(JSON.stringify(body) + fixture.logs[0].responseBody, /PRIVATE-UNTRUSTED-CODE/)
  }
})

test('HTTP disconnect before upstream headers releases accounting and destroys a late source once returned', async t => {
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const upstream = new PassThrough(), closed = once(upstream, 'close')
  const fixture = await setup(t, { forward: async () => {
    enter(); await gate
    return { success: true, status: 200, skipTransform: true, stream: upstream }
  } })
  const request = http.request(fixture.url, { method: 'POST', headers: { 'content-type': 'application/json' } })
  request.on('error', () => {})
  request.end(JSON.stringify({ model: 'fixture-model', stream: true, messages: [user('hello')] }))
  await entered
  request.destroy()
  for (let index = 0; index < 100 && fixture.counters.failure === 0; index++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(fixture.counters.failure, 1)
  assert.equal(fixture.counters.active, 0)
  assert.equal(fixture.calls[0].options.signal.aborted, true)
  assert.equal('signal' in fixture.calls[0].request, false)
  release(); await closed
  assert.deepEqual(fixture.counters, { total: 1, success: 0, failure: 1, active: 0, accountUpdates: 0, persisted: [false] })
})

test('HTTP data after DONE cannot commit the conversation as a successful response', async t => {
  const fixture = await setup(t, { forward: async ({ options }) => {
    options.onConversation({ sessionId: 'upstream-trailing-data', parentMessageId: 'assistant-invalid' })
    return { success: true, status: 200, skipTransform: true,
      stream: Readable.from([chunk('回答'), chunk(null, 'stop') + 'data: [DONE]\n\n', chunk('非法尾部')]) }
  } })
  const first = await fixture.post({ model: 'fixture-model', stream: true, messages: [user('你好')] })
  assert.equal(first.status, 200)
  const sessionId = first.headers.get('X-Chat2API-Session-ID')
  const text = await first.text()
  assert.match(text, /upstream_stream_error/)
  assert.doesNotMatch(text, /data: \[DONE\]/)
  const second = await fixture.post({ model: 'fixture-model', messages: [user('下一句')], session_id: sessionId })
  assert.equal(second.status, 409)
  await second.json()
  assert.equal(fixture.calls.length, 1)
})

test('legacy completions returns text_completion choices.text, echo and one prompt through chat continuity', async t => {
  const fixture = await setup(t, { legacy: true })
  const first = await fixture.post({ model: 'fixture-model', prompt: '你好', echo: true })
  assert.equal(first.status, 200)
  const sessionId = first.headers.get('x-chat2api-session-id')
  const body = await first.json()
  assert.equal(body.object, 'text_completion')
  assert.deepEqual(body.choices, [{ text: '你好回答1', index: 0, logprobs: null, finish_reason: 'stop' }])
  assert.equal(body.choices[0].message, undefined)
  assert.deepEqual(fixture.calls[0].request.messages, [user('你好')])
  assert.equal(fixture.calls[0].request.prompt, undefined)
  const second = await fixture.post({ model: 'fixture-model', prompt: '继续', session_id: sessionId })
  assert.equal(second.status, 200)
  assert.equal((await second.json()).choices[0].text, '回答2')
  assert.equal(fixture.calls[1].options.conversation.sessionId, 'upstream-1')
  assert.equal(fixture.counters.success, 2)
})

test('legacy completions rejects null bodies, batch prompts and unsupported options without forwarding', async t => {
  const fixture = await setup(t, { legacy: true })
  for (const body of [null, [], { model: 'fixture-model', prompt: ['first', 'second'] },
    { model: 'fixture-model', prompt: 123 }, { model: 'fixture-model', prompt: 'hello', echo: 'false' },
    { model: 'fixture-model', prompt: 'hello', stream: 'true' }, { model: 'fixture-model', prompt: 'hello', best_of: 2 },
    { model: 'fixture-model', prompt: 'hello', suffix: 'insertion' }, { model: 'fixture-model', prompt: 'hello', logprobs: 1 }]) {
    const response = await fixture.post(body)
    assert.equal(response.status, 400)
    if (response.headers.get('content-type')?.includes('json')) assert.equal((await response.json()).error.type, 'invalid_request_error')
    else await response.text()
  }
  assert.equal(fixture.calls.length, 0)
})

test('legacy completion streaming uses text deltas, one echo and one clean DONE', async t => {
  const fixture = await setup(t, { legacy: true })
  const response = await fixture.post({ model: 'fixture-model', prompt: '你好', stream: true, echo: true })
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1)
  const events = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)))
  assert.ok(events.every(value => value.object === 'text_completion' && !value.choices[0].delta && !value.choices[0].message))
  assert.equal(events.map(value => value.choices[0].text).join(''), '你好回答1')
  assert.equal(events.at(-1).choices[0].finish_reason, 'stop')
  assert.deepEqual(fixture.counters, { total: 1, success: 1, failure: 0, active: 0, accountUpdates: 1, persisted: [true] })
})

test('legacy completion truncation exposes an SSE error, no DONE, and one failed request', async t => {
  const fixture = await setup(t, { legacy: true, forward: async ({ options }) => {
    options.onConversation({ sessionId: 'legacy-truncated', parentMessageId: 'partial' })
    return { success: true, skipTransform: true, stream: Readable.from([chunk('部分')]) }
  } })
  const response = await fixture.post({ model: 'fixture-model', prompt: 'hello', stream: true })
  const text = await response.text()
  assert.match(text, /upstream_stream_error/)
  assert.doesNotMatch(text, /\[DONE\]/)
  assert.deepEqual(fixture.counters, { total: 1, success: 0, failure: 1, active: 0, accountUpdates: 0, persisted: [false] })
})

test('custom JSON upstream missing/error/incomplete replies fail with 502 instead of a fabricated answer', async t => {
  for (const body of [undefined, {}, { error: { message: 'fixture failure' } }, { choices: [] },
    { choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: null }] }]) {
    const f = await setup(t, { custom: true, forward: async () => ({ success: true, status: 200, body }) })
    const response = await f.post({ model: 'fixture-model', messages: [user('hello')] })
    assert.equal(response.status, 502)
    assert.equal((await response.json()).error.type, 'internal_error')
    assert.equal(f.counters.success, 0)
    assert.equal(f.counters.failure, 1)
  }
})

test('overlapping successful requests increment current account counts rather than stale selection snapshots', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = await setup(t, { custom: true, forward: async () => { await gate; return { success: true, status: 200, body: complete('ok') } } })
  const requests = Array.from({ length: 4 }, () => f.post({ model: 'fixture-model', messages: [user('hello')] }))
  for (let i = 0; i < 100 && f.calls.length < 4; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(f.calls.length, 4)
  release()
  for (const response of await Promise.all(requests)) { assert.equal(response.status, 200); await response.json() }
  assert.equal(f.accounts[0].requestCount, 2)
  assert.equal(f.accounts[1].requestCount, 2)
  assert.equal(f.accounts[0].todayUsed, 2)
  assert.equal(f.accounts[1].todayUsed, 2)
})

test('upstream request errors do not mark a valid account as failed for future requests', async t => {
  const f = await setup(t, { custom: true, forward: async () => ({ success: false, status: 400, error: 'Unsupported parameter fixture' }) })
  const response = await f.post({ model: 'fixture-model', messages: [user('hello')] })
  assert.equal(response.status, 400); await response.text()
  assert.deepEqual(f.marked, [])
})

test('streaming n>1 is rejected before any account selection or provider submission', async t => {
  for (const custom of [true, false]) {
    const f = await setup(t, { custom })
    const response = await f.post({ model: 'fixture-model', messages: [user('hello')], stream: true, n: 2 })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.param, 'n')
    assert.equal(f.selections.length, 0)
    assert.equal(f.calls.length, 0)
  }
})

test('impossible required or forced tool choices return 400 before account selection and submission', async t => {
  for (const custom of [true, false]) {
    const f = await setup(t, { custom })
    for (const stream of [true, false]) {
      for (const options of [
        { tool_choice: 'required' },
        { tool_choice: 'required', tools: [] },
        { tool_choice: 'required', tools: null },
        { tool_choice: { type: 'function', function: { name: 'missing' } },
          tools: [{ type: 'function', function: { name: 'declared' } }] },
      ]) {
        const response = await f.post({ model: 'fixture-model', messages: [user('hello')], stream, ...options })
        assert.equal(response.status, 400)
        assert.equal((await response.json()).error.param, 'tool_choice')
      }
    }
    assert.equal(f.selections.length, 0)
    assert.equal(f.calls.length, 0)
  }
})
