const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { PassThrough, Readable } = require('node:stream')
const vm = require('node:vm')
const ts = require('typescript')

// No accounts, browser profiles, HTTP requests, or real generations are used.
// Run the actual adapters/parsers with deterministic HTTP and tool-parser seams.
function load(provider, client) {
  const fileName = join(__dirname, '../../src/main/proxy/adapters', `${provider}.ts`)
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  assert.deepEqual(diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), [])
  const baseChunk = (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' })
  const mocks = {
    axios: { default: { ...client, create: () => client } },
    '../../oauth/zaiWebsiteChat': {
      runZaiWebsiteChat: options => client.websiteChat(options),
      ZaiWebsiteChatError: class extends Error {},
    },
    crypto: { default: require('node:crypto') },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({
      formatToolResult: ({ toolCallId, content }) => `<tool_result id="${toolCallId}">${content}</tool_result>`,
      formatAssistantToolCalls: calls => JSON.stringify(calls),
    }) },
    '../promptToolUse': { hasToolUse: () => false, parseToolUse: () => [] },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/streamToolHandler': {
      createBaseChunk: baseChunk,
      createToolCallState: () => ({ hasEmittedToolCall: false }),
      processStreamContent: (content, state, chunk) => ({
        chunks: [{ ...chunk, choices: [{ index: 0, delta: { content }, finish_reason: null }] }],
      }),
      flushToolCallBuffer: () => [],
    },
    './zai-model-options.ts': {
      DEFAULT_ZAI_WEB_MODEL: 'fixture-model',
      resolveZaiWebModel: value => value,
      isZaiThinkingRequired: () => false,
    },
  }
  const exports = {}
  const context = {
    exports, module: { exports }, Buffer, URLSearchParams, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require: name => Object.hasOwn(mocks, name) ? mocks[name] : name.startsWith('.') ? {} : require(name),
  }
  vm.runInNewContext(outputText, context, { filename: fileName })
  return context.module.exports
}

const plain = value => JSON.parse(JSON.stringify(value))
const sse = events => events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')
const messages = content => Object.freeze([Object.freeze({ role: 'user', content })])

for (const state of ['already-ended', 'already-destroyed', 'stalled']) {
  test(`zai: non-200 ${state} error stream returns promptly without consuming it again`, { timeout: 1000 }, async () => {
    const source = state === 'already-ended' ? Readable.from(['fixture error page']) : new PassThrough()
    if (state === 'already-ended') { for await (const _chunk of source) { /* intentionally consume before adapter sees it */ } }
    if (state === 'already-destroyed') source.destroy()
    const response = Object.freeze({ status: 403, headers: {}, data: source })
    const { ZaiAdapter } = load('zai', {
      websiteChat: async () => ({ response, chatId: 'fixture-chat', requestId: 'fixture-request' }),
    })
    const adapter = new ZaiAdapter({ id: 'zai', modelMappings: {} }, { id: 'fixture-account', providerId: 'zai', credentials: { token: 'fixture-token' } })
    const result = await adapter.chatCompletion({ model: 'fixture-model', messages: messages('hello'), stream: false, retainConversation: true })
    assert.equal(result.response.status, 403)
    assert.equal(result.response.data, source)
    assert.equal(source.destroyed, true)
    assert.equal(response.data, source, 'the adapter must not mutate the original response')
    assert.equal(source.listenerCount('data'), 0, 'error bodies are not drained for logging')
  })
}

test('zai: client non-stream mode uses the website SSE response rather than a standalone JSON request', async () => {
  const source = new PassThrough()
  let submitted
  const { ZaiAdapter } = load('zai', { websiteChat: async options => {
    submitted = options
    return { response: { status: 200, headers: {}, data: source }, chatId: 'fixture-chat', requestId: 'fixture-request' }
  }, post: () => assert.fail('independent HTTP must never run') })
  const adapter = new ZaiAdapter({ id: 'zai', modelMappings: {} }, { id: 'fixture-account', providerId: 'zai', credentials: { token: 'fixture-token' } })
  const result = await adapter.chatCompletion({ model: 'fixture-model', messages: messages('hello'), stream: false, retainConversation: true })
  assert.equal(submitted.prompt, 'hello')
  assert.equal(result.response.data, source)
  source.destroy()
})

for (const [code, category] of [
  ['FRONTEND_CAPTCHA_REQUIRED', 'captcha_required'],
  ['VERIFICATION_REQUIRED', 'verification_required'],
  ['MODEL_NOT_FOUND', 'model_unavailable'],
  ['INVALID_TOKEN', 'authentication_required'],
]) {
  for (const streaming of [false, true]) {
    test(`zai: HTTP 200 JSON ${code} yields safe ${category} in ${streaming ? 'stream' : 'non-stream'} mode`, async () => {
      const { ZaiStreamHandler } = load('zai', {})
      const source = new PassThrough()
      const handler = new ZaiStreamHandler('fixture-model')
      let result
      if (streaming) {
        const output = await handler.handleStream(source)
        result = (async () => { for await (const _chunk of output) { /* never complete an error response */ } })()
      } else result = handler.handleNonStream(source)
      const rejected = assert.rejects(result, error => {
        assert.equal(error.category, category)
        assert.equal(error.upstreamCode, 403)
        assert.doesNotMatch(error.message, /SECRET|private-profile|Bearer/)
        return true
      })
      source.end(JSON.stringify({ error: { code: 403, detail: { code, message: 'SECRET private-profile Bearer fixture' } } }))
      await rejected
    })
  }
}

test('zai: SSE error event uses a safe category instead of exposing remote text', async () => {
  const { ZaiStreamHandler } = load('zai', {})
  const source = new PassThrough()
  const promise = new ZaiStreamHandler('fixture-model').handleNonStream(source)
  const rejected = assert.rejects(promise, error => error.category === 'captcha_required' && !error.message.includes('SECRET'))
  source.end('event: error\ndata: {"code":"FRONTEND_CAPTCHA_REQUIRED","message":"SECRET"}\n\n')
  await rejected
})

test('zai: unexpected legitimate JSON is diagnosed but never forged into a completed SSE conversation', async () => {
  const { ZaiStreamHandler } = load('zai', {})
  const source = new PassThrough()
  const promise = new ZaiStreamHandler('fixture-model').handleNonStream(source)
  const rejected = assert.rejects(promise, error => error.category === 'unexpected_json')
  source.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }] }))
  await rejected
})

test('zai: JSON diagnostics do not retain or parse beyond the 64 KiB prefix limit', async () => {
  const { ZaiStreamHandler } = load('zai', {})
  const source = new PassThrough()
  const promise = new ZaiStreamHandler('fixture-model').handleNonStream(source)
  const rejected = assert.rejects(promise, error => error.category === 'incomplete_stream')
  source.end(JSON.stringify({ padding: 'x'.repeat(70 * 1024), error: { code: 'FRONTEND_CAPTCHA_REQUIRED' } }))
  await rejected
})

const cases = [
  {
    provider: 'qwen', adapter: 'QwenAdapter', handler: 'QwenStreamHandler',
    id: payload => payload.session_id,
    parent: payload => payload.parent_req_id,
    content: payload => payload.messages[0].content,
    cursor: (payload, round) => payload.req_id,
    events: (payload, cursor) => [{
      communication: { sessionid: payload.session_id, reqid: cursor },
      data: { messages: [{ mime_type: 'multi_load/iframe', content: '你好！', status: 'complete' }] },
    }],
  },
  {
    provider: 'qwen-ai', adapter: 'QwenAiAdapter', handler: 'QwenAiStreamHandler',
    id: payload => payload.chat_id,
    parent: payload => payload.parent_id,
    content: payload => payload.messages[0].content,
    cursor: (payload, round) => `server-assistant-response-${round}`,
    events: (payload, cursor) => [
      { 'response.created': { response_id: cursor } },
      { choices: [{ delta: { phase: 'answer', status: 'finished', content: '你好！' } }] },
    ],
  },
  {
    provider: 'zai', adapter: 'ZaiAdapter', handler: 'ZaiStreamHandler',
    id: payload => payload.conversation?.sessionId ?? 'server-chat-id',
    parent: payload => payload.conversation?.parentMessageId ?? null,
    content: payload => payload.prompt,
    cursor: (payload, round) => `server-assistant-message-${round}`,
    events: (payload, cursor) => [
      // A user echo must never become the assistant cursor.
      { type: 'chat:completion', data: { role: 'user', id: 'website-user-echo' } },
      { type: 'chat:completion', data: { role: 'assistant', id: cursor, phase: 'answer', delta_content: '你好！' } },
      { type: 'chat:completion', data: { phase: 'done', done: true } },
    ],
  },
]

for (const spec of cases) {
  test(`${spec.provider}: cancelling the output also closes the upstream response`, async () => {
    const classes = load(spec.provider, {})
    const handler = new classes[spec.handler]('fixture-model')
    const source = new PassThrough()
    const output = await handler.handleStream(source)
    const closed = new Promise(resolve => source.once('close', resolve))
    output.destroy()
    await closed
    assert.equal(source.destroyed, true)
  })

  for (const streamMode of [true, false]) {
    test(`${spec.provider}: ${streamMode ? 'stream' : 'non-stream'} reuses one chat and sends only each new input`, async () => {
      const sent = []
      const created = []
      const deleted = []
      const client = {
        websiteChat: async options => {
          sent.push(plain(options))
          return { response: { status: 200, data: new PassThrough(), headers: {} }, chatId: options.conversation?.sessionId ?? 'server-chat-id', requestId: `website-request-${sent.length}` }
        },
        post: async (url, payload) => {
          if (url.endsWith('/chats/new')) {
            created.push(plain(payload))
            return spec.provider === 'qwen-ai'
              ? { data: { data: { id: 'server-chat-id' } } }
              : { status: 200, data: { id: 'server-chat-id' } }
          }
          sent.push(plain(payload))
          return { status: 200, data: new PassThrough(), headers: {} }
        },
        delete: async url => { deleted.push(url); return { status: 200 } },
      }
      const classes = load(spec.provider, client)
      const adapter = new classes[spec.adapter]({ id: spec.provider, modelMappings: {} }, {
        id: 'fixture-account', providerId: spec.provider,
        credentials: Object.freeze({ token: 'fixture-token', cookies: 'fixture=1', ticket: 'fixture-ticket' }),
      })
      let state
      let firstId
      let previousCursor
      for (const [index, input] of ['你好', '今天天气怎么样'].entries()) {
        const priorState = state ? Object.freeze({ ...state }) : undefined
        const request = Object.freeze({
          model: 'fixture-model', messages: messages(input), stream: streamMode,
          conversation: priorState, retainConversation: true,
          onConversation: value => { state = plain(value) },
        })
        const result = await adapter.chatCompletion(request)
        const payload = sent.at(-1)
        const cursor = spec.cursor(payload, index)
        const handler = new classes[spec.handler]('fixture-model')
        if (handler.setChatId) handler.setChatId(result.chatId)
        handler.setConversationListener(value => { state = plain(value) })
        if (streamMode) {
          const stream = await handler.handleStream(result.response.data, result.response)
          const chunks = []
          const complete = new Promise((resolve, reject) => {
            stream.on('data', chunk => chunks.push(chunk.toString()))
            stream.once('end', resolve)
            stream.once('error', reject)
          })
          result.response.data.end(sse(spec.events(payload, cursor)))
          await complete
          assert.match(chunks.join(''), /你好！/)
          assert.match(chunks.join(''), /\[DONE\]/)
        } else {
          const response = handler.handleNonStream(result.response.data, result.response)
          result.response.data.end(sse(spec.events(payload, cursor)))
          const completed = await response
          assert.equal(completed.choices[0].message.content, '你好！')
        }
        assert.equal(spec.content(payload), input)
        if (spec.provider !== 'zai') assert.equal(payload.messages.length, 1)
        assert.equal(state.sessionId, spec.id(payload))
        assert.equal(state.parentMessageId, cursor)
        if (index === 0) {
          firstId = spec.id(payload)
          assert.equal(spec.parent(payload), spec.provider === 'qwen' ? '0' : null)
        } else {
          assert.equal(spec.id(payload), firstId)
          assert.equal(spec.parent(payload), previousCursor)
          assert.equal(priorState.parentMessageId, previousCursor)
          if (spec.provider === 'qwen') {
            assert.notEqual(payload.req_id, sent[0].req_id)
            assert.equal(payload.scene_param, undefined)
          } else if (spec.provider === 'qwen-ai') {
            assert.equal(payload.messages[0].parentId, previousCursor)
            assert.equal(payload.messages[0].parent_id, previousCursor)
            assert.notEqual(payload.messages[0].fid, sent[0].messages[0].fid)
            assert.notEqual(previousCursor, sent[0].messages[0].fid)
            assert.notEqual(previousCursor, sent[0].messages[0].childrenIds[0])
          }
        }
        previousCursor = cursor
      }
      assert.equal(sent.length, 2)
      assert.equal(created.length, spec.provider === 'qwen-ai' ? 1 : 0)
      assert.deepEqual(deleted, [])
    })
  }

  test(`${spec.provider}: missing upstream cursor fails before creating/sending a replacement chat`, async () => {
    let requests = 0
    const classes = load(spec.provider, { websiteChat: async () => { requests++; throw new Error('website must not run') }, post: async () => { requests++; throw new Error('network must not run') } })
    const adapter = new classes[spec.adapter]({ id: spec.provider, modelMappings: {} }, {
      id: 'fixture-account', providerId: spec.provider,
      credentials: { token: 'fixture-token', ticket: 'fixture-ticket', cookies: 'fixture=1' },
    })
    await assert.rejects(adapter.chatCompletion({
      model: 'fixture-model', messages: messages('第二轮'),
      conversation: { sessionId: 'server-chat-id' }, retainConversation: true,
    }), spec.provider === 'zai' ? error => error.category === 'invalid_request' : /missing the previous/)
    assert.equal(requests, 0)
  })
}

for (const spec of cases.filter(item => item.provider !== 'qwen')) {
  test(`${spec.provider}: tool-only continuation sends the new result on the same assistant parent`, async () => {
    const sent = []
    const classes = load(spec.provider, { websiteChat: async options => {
      sent.push(plain(options))
      return { response: { status: 200, headers: {}, data: new PassThrough() }, chatId: options.conversation.sessionId, requestId: 'website-request' }
    }, post: async (url, payload) => {
      assert.doesNotMatch(url, /chats\/new/)
      sent.push(plain(payload))
      return { status: 200, data: {}, headers: {} }
    } })
    const adapter = new classes[spec.adapter]({ id: spec.provider, modelMappings: {} }, {
      id: 'fixture-account', providerId: spec.provider,
      credentials: { token: 'fixture-token', cookies: 'fixture=1' },
    })
    const turnMessages = Object.freeze([Object.freeze({
      role: 'tool', tool_call_id: 'weather-call', content: '上海：晴，25°C',
    })])
    await adapter.chatCompletion({
      model: 'fixture-model', messages: turnMessages,
      conversation: { sessionId: 'existing-chat', parentMessageId: 'server-assistant-tool-call' },
      retainConversation: true,
    })
    const payload = sent[0]
    assert.equal(spec.id(payload), 'existing-chat')
    assert.equal(spec.parent(payload), 'server-assistant-tool-call')
    if (spec.provider !== 'zai') {
      assert.equal(payload.messages.length, 1)
      assert.equal(payload.messages[0].role, 'user')
    }
    assert.equal(spec.content(payload), '<tool_result id="weather-call">上海：晴，25°C</tool_result>')
    assert.deepEqual(plain(turnMessages), [{ role: 'tool', tool_call_id: 'weather-call', content: '上海：晴，25°C' }])
  })
}

test('Z.ai non-stream SSE-string and JSON paths both capture only actual assistant IDs', async () => {
  const { ZaiStreamHandler } = load('zai', {})
  for (const data of [
    sse([
      { type: 'chat:completion', data: { role: 'assistant', id: 'assistant-node', phase: 'answer', delta_content: 'hello' } },
      { type: 'chat:completion', data: { phase: 'done', done: true } },
    ]),
    { id: 'envelope-not-parent', choices: [{ message: { role: 'assistant', id: 'assistant-node', content: 'hello' }, finish_reason: 'stop' }] },
  ]) {
    const handler = new ZaiStreamHandler('fixture-model')
    handler.setChatId('server-chat-id')
    let state
    handler.setConversationListener(value => { state = plain(value) })
    const result = await handler.handleNonStream(data)
    assert.equal(result.choices[0].message.content, 'hello')
    assert.deepEqual(state, { sessionId: 'server-chat-id', parentMessageId: 'assistant-node' })
  }
})

test('Qwen AI never guesses a parent from a user echo or a generic SSE envelope ID', async () => {
  const { QwenAiStreamHandler } = load('qwen-ai', {})
  const handler = new QwenAiStreamHandler('fixture-model')
  handler.setChatId('server-chat-id')
  const states = []
  handler.setConversationListener(value => states.push(plain(value)))
  const stream = new PassThrough()
  const result = handler.handleNonStream(stream)
  stream.end(sse([
    { id: 'user-or-envelope-id', role: 'user' },
    { choices: [{ delta: { phase: 'answer', status: 'finished', content: 'hello' } }] },
  ]))
  await result
  assert.deepEqual(states, [])
})

for (const spec of cases) {
  for (const streamMode of [true, false]) {
    for (const failure of ['truncation', 'upstream-error', 'malformed-json']) {
      test(`${spec.provider}: ${streamMode ? 'stream' : 'non-stream'} ${failure} cannot commit a successful conversation`, async () => {
        const classes = load(spec.provider, {})
        const handler = new classes[spec.handler]('fixture-model')
        if (handler.setChatId) handler.setChatId('server-chat-id')
        const stream = new PassThrough()
        const body = failure === 'upstream-error'
          ? sse([{ error: { message: 'fixture-upstream-failed' } }])
          : failure === 'malformed-json'
            ? 'data: {invalid-json}\n\n'
            : sse([{ heartbeat: true }])
        if (streamMode) {
          const output = await handler.handleStream(stream)
          const chunks = []
          const failed = new Promise((resolve, reject) => {
            output.on('data', chunk => chunks.push(chunk.toString()))
            output.once('error', resolve)
            output.once('end', () => reject(new Error('must not end successfully')))
          })
          stream.end(body)
          const error = await failed
          assert.ok(error.message)
          assert.doesNotMatch(chunks.join(''), /\[DONE\]|"finish_reason":"stop"/)
        } else {
          const response = handler.handleNonStream(stream)
          const failed = assert.rejects(response)
          stream.end(body)
          await failed
        }
      })
    }
  }
}
