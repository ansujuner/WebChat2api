const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const Koa = require('koa')
const Router = require('@koa/router')
const bodyParser = require('koa-bodyparser')
const { Readable, PassThrough } = require('node:stream')
const { once } = require('node:events')
const root = join(__dirname, '..', '..')
const plain = value => JSON.parse(JSON.stringify(value))
function load(relative, deps) {
  const fileName = join(root, relative)
  const result = ts.transpileModule(readFileSync(fileName, 'utf8'), { fileName, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
  assert.equal(result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  const module = { exports: {} }
  vm.runInNewContext(result.outputText, { module, exports: module.exports, Buffer, AbortController,
    console: { log() {}, warn() {}, error() {} }, require: name => {
      if (Object.hasOwn(deps, name)) return deps[name]
      if (!name.startsWith('.')) return require(name)
      throw new Error(`Unmocked dependency: ${name}`)
    } }, { filename: fileName })
  return module.exports
}
const tool = { name: 'Read', description: 'Read a local fixture', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }
const base = { model: 'fixture-model', max_tokens: 256, tools: [tool], metadata: { user_id: '{"session_id":"fixture-cli"}' } }
const user = content => ({ role: 'user', content })
const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] })
const call = { id: 'toolu_fixture', type: 'function', function: { name: 'Read', arguments: '{ "file_path" : "fixture.txt" }' } }

async function setup(t, options = {}) {
  const continuity = await import('../../src/main/proxy/conversationContinuity.ts')
  const coreStream = await import('../../src/main/proxy/conversationStream.ts')
  const codec = await import('../../src/main/proxy/anthropic/messages.ts')
  const nativeStream = await import('../../src/main/proxy/anthropic/stream.ts')
  const errors = await import('../../src/main/proxy/anthropic/errors.ts')
  continuity.conversationContinuity.clear()
  const calls = []
  const chat = load('src/main/proxy/routes/chat.ts', {
    '../../../shared/accountAvailability': require('../../src/shared/accountAvailability.ts'),
    '@koa/router': { default: Router }, '../conversationContinuity': continuity, '../conversationStream': coreStream,
    '../requestValidation': await import('../../src/main/proxy/requestValidation.ts'),
    '../requestAccounting': await import('../../src/main/proxy/requestAccounting.ts'),
    '../clientIdentity': await import('../../src/main/proxy/clientIdentity.ts'),
    '../loadbalancer': { loadBalancer: { selectAccount: () => ({ account: { id: 'fixture-account', name: 'Fixture' }, provider: { id: 'deepseek', name: 'DeepSeek' }, actualModel: 'fixture-upstream' }), markAccountFailed() {}, clearAccountFailure() {} } },
    '../modelMapper': { modelMapper: { getPreferredProvider() {}, getPreferredAccount() {} } },
    '../status': { proxyStatusManager: { recordRequestStart() {}, recordRequestSuccess() {}, recordRequestFailure() {} } },
    '../../store/store': { storeManager: { getConfig: () => ({ sessionConfig: { sessionTimeout: 30 } }),
      addLog() {}, getAccountById: () => ({ id: 'fixture-account', status: 'active' }), updateAccount() {}, addRequestLog: () => ({ id: 'log' }), updateRequestLog() {}, recordRequestInStats() {} } },
    '../stream': { streamHandler: { createTransformStream: () => new PassThrough() } },
    '../utils/toolFormatConverter': { isAnthropicToolFormat: () => false, transformResponseToAnthropic: value => value },
    '../forwarder': { requestForwarder: {
      supportsConversation: () => true, conversationKind: () => 'deepseek',
      async forwardChatCompletion(request, account) {
        const upstream = continuity.getConversationOptions(request)
        calls.push({ request: plain(request), upstream, account: account.id })
        if (options.forward) return options.forward({ request, upstream, calls })
        upstream.onConversation({ sessionId: upstream.conversation?.sessionId ?? `website-${calls.length}`, parentMessageId: `reply-${calls.length}` })
        const isTool = calls.length === 1 && options.toolResponse
        if (request.stream) {
          const text = isTool ? frame(chunk({ role: 'assistant', content: '读取文件' })) +
            frame(chunk({ tool_calls: [{ index: 0, ...call, function: { name: 'Read', arguments: '{ "file_' } }] })) +
            frame(chunk({ tool_calls: [{ index: 0, function: { arguments: 'path" : "fixture.txt" }' } }] })) +
            frame(chunk({}, 'tool_calls')) : frame(chunk({ role: 'assistant', content: `回复${calls.length}` })) + frame(chunk({}, 'stop'))
          const bytes = Buffer.from(text + frame('[DONE]'))
          return { success: true, skipTransform: true, stream: Readable.from([...bytes].map(b => Buffer.from([b]))) }
        }
        return { success: true, status: 200, body: { id: 'completion-fixture', model: 'fixture-upstream',
          choices: [{ index: 0, message: isTool ? { role: 'assistant', content: '读取文件', tool_calls: [call] } :
            { role: 'assistant', content: `回复${calls.length}` }, finish_reason: isTool ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 8 } } }
      },
    } },
  })
  const messages = load('src/main/proxy/routes/messages.ts', {
    '@koa/router': { default: Router }, './chat': chat, '../anthropic/messages': codec,
    '../anthropic/stream': nativeStream, '../anthropic/errors': errors,
  }).default
  const app = new Koa()
  app.on('error', () => {})
  app.use(errors.anthropicErrorMiddleware)
  app.use(bodyParser())
  app.use(async (ctx, next) => {
    const key = ctx.get('x-api-key') || ctx.get('Authorization').replace(/^Bearer /, '')
    if (key !== 'fixture-key') { ctx.status = 401; ctx.body = { error: { message: 'Invalid API key' } }; return }
    ctx.state.apiKeyId = 'fixture-key-id'
    await next()
  })
  app.use(messages.routes()).use(messages.allowedMethods())
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); continuity.conversationContinuity.clear() })
  const url = `http://127.0.0.1:${server.address().port}`
  return { calls, url, post: (body, path = '/v1/messages', headers = {}) => fetch(url + path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-key', 'anthropic-version': '2023-06-01', ...headers }, body: JSON.stringify(body) }) }
}

function parseEvents(text) {
  return text.split(/\r?\n\r?\n/).filter(frame => frame.includes('data:')).map(frame => JSON.parse(frame.split(/\r?\n/).find(line => line.startsWith('data:')).slice(5)))
}
function reconstruct(events) {
  const blocks = []
  for (const event of events) {
    if (event.type === 'content_block_start') blocks[event.index] = { ...event.content_block }
    if (event.type === 'content_block_delta') {
      const block = blocks[event.index]
      if (event.delta.type === 'text_delta') block.text += event.delta.text
      if (event.delta.type === 'input_json_delta') block.raw = (block.raw ?? '') + event.delta.partial_json
    }
  }
  return blocks.map(({ raw, ...block }) => block.type === 'tool_use' ? { ...block, input: JSON.parse(raw || '{}') } : block)
}

for (const streaming of [false, true]) {
  test(`Anthropic HTTP ${streaming ? 'SSE' : 'JSON'} tool-use/result loop retains native webpage context and strips history`, async t => {
    const fixture = await setup(t, { toolResponse: true })
    const history = [user('请读取文件')]
    const first = await fixture.post({ ...base, messages: history, stream: streaming }, '/v1/messages?beta=true')
    assert.equal(first.status, 200)
    const id = first.headers.get('x-chat2api-session-id')
    assert.match(id, /^c2a-/)
    assert.match(first.headers.get('request-id'), /^req_/)
    let content
    if (streaming) {
      const text = await first.text()
      assert.doesNotMatch(text, /data: \[DONE\]/)
      const events = parseEvents(text)
      assert.equal(events[0].type, 'message_start')
      assert.equal(events.at(-1).type, 'message_stop')
      assert.equal(events.find(e => e.type === 'message_delta').delta.stop_reason, 'tool_use')
      content = reconstruct(events)
    } else {
      const answer = await first.json()
      assert.equal(answer.type, 'message'); assert.equal(answer.stop_reason, 'tool_use')
      assert.equal(answer.choices, undefined)
      content = answer.content
    }
    assert.deepEqual(content.find(block => block.type === 'tool_use').input, { file_path: 'fixture.txt' })
    history.push({ role: 'assistant', content }, user([{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: 'fixture contents' }]))
    const second = await fixture.post({ ...base, messages: history, stream: false })
    assert.equal(second.status, 200)
    assert.equal(second.headers.get('x-chat2api-session-id'), id)
    const answer2 = await second.json()
    assert.equal(answer2.stop_reason, 'end_turn')
    assert.deepEqual(fixture.calls[1].request.messages, [{ role: 'tool', tool_call_id: 'toolu_fixture', content: 'fixture contents' }])
    history.push({ role: 'assistant', content: answer2.content }, user('继续'))
    const third = await fixture.post({ ...base, messages: history })
    assert.equal(third.status, 200)
    assert.equal(third.headers.get('x-chat2api-session-id'), id)
    assert.deepEqual(fixture.calls[2].request.messages, [{ role: 'user', content: '继续' }])
    assert.equal(fixture.calls[2].upstream.conversation.sessionId, 'website-1')
  })
}

test('count_tokens is clearly an estimate, needs no upstream account/generation and accepts no max_tokens', async t => {
  const fixture = await setup(t)
  const response = await fixture.post({ model: base.model, system: '帮助编程', tools: [tool], messages: [user('你好')] }, '/v1/messages/count_tokens')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-chat2api-token-count'), 'estimated')
  const body = await response.json()
  assert.ok(Number.isInteger(body.input_tokens) && body.input_tokens > 0)
  assert.equal(fixture.calls.length, 0)
})

test('Messages endpoints provide Anthropic auth, validation and parser error envelopes', async t => {
  const fixture = await setup(t)
  for (const [body, headers, status] of [[base, {}, 400], [{ ...base, messages: [user('hi')] }, { 'x-api-key': 'wrong' }, 401],
    [{ ...base, messages: [user('hi')] }, { 'anthropic-version': 'unknown' }, 400]]) {
    const response = await fixture.post(body, '/v1/messages', headers)
    assert.equal(response.status, status)
    const value = await response.json()
    assert.equal(value.type, 'error'); assert.equal(typeof value.error.message, 'string')
    if (status === 401) assert.equal(value.error.type, 'authentication_error')
  }
  const invalidJson = await fetch(fixture.url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-key' }, body: '{' })
  assert.equal(invalidJson.status, 400); assert.equal((await invalidJson.json()).type, 'error')
  const bearer = await fixture.post({ ...base, messages: [user('hi')] }, '/v1/messages', { 'x-api-key': '', Authorization: 'Bearer fixture-key' })
  assert.equal(bearer.status, 200)
})

test('upstream SSE errors remain Anthropic errors without a fake message_stop', async t => {
  const fixture = await setup(t, { forward: ({ upstream }) => {
    upstream.onConversation({ sessionId: 'upstream', parentMessageId: 'reply-1' })
    return { success: true, skipTransform: true, stream: Readable.from([Buffer.from(frame({ error: { message: 'fixture failed' } }))]) }
  } })
  const response = await fixture.post({ ...base, messages: [user('hi')], stream: true })
  const events = parseEvents(await response.text())
  assert.ok(events.some(e => e.type === 'error'))
  assert.ok(!events.some(e => e.type === 'message_stop'))
  const next = await fixture.post({ ...base, messages: [user('continue')], session_id: response.headers.get('x-chat2api-session-id') })
  assert.equal(next.status, 409)
  assert.equal((await next.json()).type, 'error')
})

test('bad streamed tool JSON, duplicate IDs and tool_calls without tools cannot commit before native conversion', async t => {
  for (const toolCalls of [
    [{ index: 0, ...call, function: { name: 'Read', arguments: '{broken' } }],
    [{ index: 0, ...call }, { index: 1, ...call }],
    [],
  ]) {
    await t.test(JSON.stringify(toolCalls), async st => {
      const fixture = await setup(st, { forward: ({ upstream }) => {
        upstream.onConversation({ sessionId: 'upstream', parentMessageId: 'reply-1' })
        return { success: true, skipTransform: true, stream: Readable.from([Buffer.from(
          frame(chunk({ role: 'assistant', tool_calls: toolCalls })) + frame(chunk({}, 'tool_calls')) + frame('[DONE]'))]) }
      } })
      const response = await fixture.post({ ...base, messages: [user('hi')], stream: true })
      const events = parseEvents(await response.text())
      assert.ok(events.some(e => e.type === 'error'))
      assert.ok(!events.some(e => e.type === 'message_stop'))
      const next = await fixture.post({ ...base, messages: [user('continue')], session_id: response.headers.get('x-chat2api-session-id') })
      assert.equal(next.status, 409)
    })
  }
})
