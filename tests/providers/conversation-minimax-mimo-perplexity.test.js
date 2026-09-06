const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { Readable, PassThrough } = require('node:stream')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const ts = require('typescript')

function load(file, overrides = {}) {
  const fileName = join(__dirname, '../../src/main/proxy/adapters', file)
  const output = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const exports = {}
  const toolHelpers = {
    createToolCallState: () => ({}),
    createBaseChunk: (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' }),
    processStreamContent: (content, state, base, first) => ({ chunks: [{ ...base, choices: [{ index: 0, delta: { ...(first ? { role: 'assistant' } : {}), content }, finish_reason: null }] }] }),
    flushToolCallBuffer: () => [],
  }
  const defaults = {
    '../../network/proxy': { getNetworkSession: async () => ({ fixtureNetworkSession: true }) },
    './providerModelOptions': { resolveMiniMaxWebModel: () => 'MiniMax-Agent' },
    '../utils/streamToolHandler': toolHelpers,
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/tools': { hasToolPromptInjected: () => false, toolsToSystemPrompt: () => 'Tool definitions', TOOL_WRAP_HINT: '' },
    '../toolCalling/providerProfiles.ts': { getProviderToolProfile: () => ({}) },
  }
  vm.runInNewContext(output, {
    exports, module: { exports }, Buffer, AbortController,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : Object.hasOwn(defaults, name) ? defaults[name] : name.startsWith('.') ? {} : require(name),
    console: { log() {}, warn() {}, error() {} },
    setTimeout: callback => setImmediate(callback), clearTimeout: clearImmediate,
    global: { storeManager: { getConfig: () => ({ mode: 'single', deleteAfterTimeout: true }) } },
  }, { filename: fileName })
  return exports
}
const account = { id: 'fixture-account', credentials: { token: 'test-only', service_token: 'fixture-service', user_id: 'fixture-user', ph_token: 'fixture-ph' } }
const queries = ['你好', '今天天气怎么样', '那明天呢']
const collect = async stream => { let text = ''; for await (const chunk of stream) text += chunk; return text }
const plain = value => JSON.parse(JSON.stringify(value))

for (const streaming of [false, true]) {
  test(`MiniMax reuses one chat across three ${streaming ? 'streaming' : 'non-streaming'} turns and ignores old/partial answers`, async () => {
    const { MiniMaxAdapter } = load('minimax.ts')
    const adapter = new MiniMaxAdapter({ id: 'minimax' }, account)
    adapter.requestDeviceInfo = async () => ({})
    let messages = [], sent = [], polls = 0, turn = 0, deletes = 0, conversation
    adapter.deleteChat = async () => { deletes++; return true }
    adapter.request = async (method, path, body) => {
      if (path.endsWith('/send_msg')) {
        sent.push(plain(body)); turn++; polls = 0
        return { status: 200, data: { base_resp: { status_code: 0 }, chat_id: 'chat-1', msg_id: `user-${turn}` } }
      }
      assert.ok(path.endsWith('/get_chat_detail'))
      polls++
      const user = { msg_type: 1, msg_id: `user-${turn}`, msg_content: queries[turn - 1] }
      const answer = { msg_type: 2, msg_id: `answer-${turn}`, msg_content: `answer turn ${turn}` }
      const current = polls === 1 ? messages : [...messages, user, answer]
      if (polls === 3) messages = current
      return { status: 200, data: { base_resp: { status_code: 0 }, chat: { chat_status: polls === 2 ? 1 : 2 }, messages: current } }
    }
    for (const query of queries) {
      const result = await adapter.chatCompletion({ model: 'minimax-agent', messages: [{ role: 'user', content: query }], stream: streaming, conversation, retainConversation: true, onConversation: state => { conversation = state } })
      if (streaming) {
        const text = await collect(result.stream.stream)
        assert.match(text, new RegExp(`answer turn ${turn}`))
        for (let old = 1; old < turn; old++) assert.ok(!text.includes(`answer turn ${old}`))
        assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1)
      } else assert.equal(result.response.data.choices[0].message.content, `answer turn ${turn}`)
      assert.equal(polls, 3)
      assert.equal(conversation.sessionId, 'chat-1')
      assert.equal(conversation.parentMessageId, `answer-${turn}`)
    }
    assert.equal(sent.filter(body => !body.chat_id).length, 1)
    assert.deepEqual(sent.map(body => body.text), queries)
    assert.deepEqual(sent.slice(1).map(body => body.chat_id), ['chat-1', 'chat-1'])
    assert.equal(deletes, 0)
  })

  test(`MiMo saves once, preserves ID and sends only current input across three ${streaming ? 'streaming' : 'non-streaming'} turns`, async () => {
    const sent = [], saved = []
    let turn = 0, conversation
    const axios = async options => {
      sent.push(plain(options.data)); turn++
      return { status: 200, data: Readable.from([`event: dialogId\ndata: {"content":"dialog-${turn}"}\n\nevent: message\ndata: {"content":"answer ${turn}"}\n\nevent: finish\ndata: {}\n\n`]) }
    }
    axios.post = async (url, data) => { saved.push(plain(data)); return { status: 200, data: { code: 0 } } }
    const { MimoAdapter, MimoStreamHandler } = load('mimo.ts', { axios: { default: axios } })
    const adapter = new MimoAdapter({ id: 'mimo' }, account)
    for (const query of queries) {
      const result = await adapter.chatCompletion({ model: 'mimo-v2.5', messages: [{ role: 'user', content: query }], stream: streaming, conversation, retainConversation: true, onConversation: state => { conversation = state } })
      const handler = new MimoStreamHandler('mimo-v2.5', result.conversationId)
      handler.setConversationListener(state => { conversation = state })
      const text = streaming ? await collect(handler.handleStream(result.response.data)) : await handler.handleNonStream(result.response.data)
      assert.match(text, new RegExp(`answer ${turn}`))
      assert.equal(conversation.parentMessageId, `dialog-${turn}`)
    }
    assert.equal(saved.length, 1)
    assert.deepEqual(sent.map(body => body.query), queries)
    assert.equal(new Set(sent.map(body => body.conversationId)).size, 1)
    assert.equal(new Set(sent.map(body => body.msgId)).size, 3)
    assert.equal(saved[0].conversationId, sent[0].conversationId)
  })

  test(`Perplexity follows actual backend entry cursors across three ${streaming ? 'streaming' : 'non-streaming'} turns`, async () => {
    const sent = []
    let conversation, turn = 0
    const net = { request: () => {
      const request = new EventEmitter()
      request.setHeader = () => {}
      request.write = body => sent.push(JSON.parse(body))
      request.end = () => setImmediate(() => {
        turn++
        const response = new EventEmitter(); response.statusCode = 200
        request.emit('response', response)
        setImmediate(() => {
          const event = { context_uuid: 'server-thread', backend_uuid: `backend-${turn}`, read_write_token: 'fixture-write-token', thread_url_slug: 'fixture-thread', blocks: [{ diff_block: { field: 'markdown_block', patches: [{ path: '/answer', value: `answer ${turn}` }] } }] }
          response.emit('data', Buffer.from(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`))
          response.emit('end')
        })
      })
      return request
    } }
    const { PerplexityAdapter } = load('perplexity.ts', { electron: { net } })
    const { PerplexityStreamHandler } = load('perplexity-stream.ts')
    for (const query of queries) {
      const adapter = new PerplexityAdapter({ id: 'perplexity', modelMappings: {} }, account)
      const result = await adapter.chatCompletion({ model: 'turbo', messages: [{ role: 'user', content: query }], stream: streaming, conversation, retainConversation: true, onConversation: state => { conversation = state } })
      if (turn === 1) assert.equal(result.sessionId, '', 'must not invent a session ID from the request UUID')
      const handler = new PerplexityStreamHandler('turbo', result.sessionId, undefined, adapter)
      handler.setConversationListener(state => { conversation = state })
      const text = streaming ? await collect(await handler.handleStream(result.stream)) : JSON.stringify(await handler.handleNonStream(result.stream))
      assert.match(text, new RegExp(`answer ${turn}`))
      assert.equal(conversation.sessionId, 'server-thread')
      assert.equal(conversation.parentMessageId, `backend-${turn}`)
      assert.equal(conversation.extras.read_write_token, 'fixture-write-token')
      assert.equal(conversation.extras.frontend_context_uuid, sent[0].params.frontend_context_uuid)
    }
    assert.deepEqual(sent.map(body => body.query_str), queries)
    assert.equal(sent.filter(body => body.params.frontend_context_uuid).length, 1)
    assert.equal(sent[0].params.last_backend_uuid, undefined)
    assert.deepEqual(sent.slice(1).map(body => body.params.last_backend_uuid), ['backend-1', 'backend-2'])
    assert.ok(sent.slice(1).every(body => body.params.read_write_token === 'fixture-write-token'))
    assert.equal(new Set(sent.map(body => body.params.frontend_uuid)).size, 3)
  })
}

test('MiniMax does not select history if the submitted message has not appeared or another turn starts', () => {
  const { selectMiniMaxTurnResponse } = load('minimax.ts')
  const old = { msg_id: 'old-answer', msg_type: 2, msg_content: 'stale answer' }
  assert.equal(selectMiniMaxTurnResponse([old], 'current-user'), undefined)
  assert.equal(selectMiniMaxTurnResponse([{ msg_id: 'current-user', msg_type: 1 }, { msg_id: 'next-user', msg_type: 1 }, old], 'current-user'), undefined)
})

test('Perplexity refuses missing cursors before submitting instead of silently opening another thread', async () => {
  const { PerplexityAdapter } = load('perplexity.ts', { electron: { net: { request: () => assert.fail('must not send') } } })
  const adapter = new PerplexityAdapter({ id: 'perplexity' }, account)
  await assert.rejects(adapter.chatCompletion({ model: 'turbo', messages: [{ role: 'user', content: 'continue' }], conversation: { sessionId: 'real-thread' } }), /missing its server continuation cursor/)
})

test('single user input is not trimmed or decorated', () => {
  const { buildMimoQuery } = load('mimo.ts')
  assert.equal(buildMimoQuery([{ role: 'user', content: '  你好\n' }]), '  你好\n')
})

test('MiMo rejects truncated stream and non-stream turns instead of committing partial conversation', async () => {
  const { MimoStreamHandler } = load('mimo.ts')
  const partial = () => Readable.from(['event: message\ndata: {"content":"partial"}\n\n'])
  await assert.rejects(collect(new MimoStreamHandler('mimo-v2.5', 'fixture').handleStream(partial())), /without a finish event/)
  await assert.rejects(new MimoStreamHandler('mimo-v2.5', 'fixture').handleNonStream(partial()), /without a finish event/)
})

test('Perplexity requires a terminal event in both response modes', async () => {
  const { PerplexityStreamHandler } = load('perplexity-stream.ts')
  const partial = () => Readable.from(['data: {"backend_uuid":"entry","blocks":[]}\n\n'])
  await assert.rejects(collect(await new PerplexityStreamHandler('turbo', '').handleStream(partial())), /without a completed terminal event/)
  await assert.rejects(new PerplexityStreamHandler('turbo', '').handleNonStream(partial()), /without a completed terminal event/)
  const done = () => Readable.from(['data: {"context_uuid":"thread","backend_uuid":"entry","status":"COMPLETED"}\n\n'])
  assert.match(await collect(await new PerplexityStreamHandler('turbo', '').handleStream(done())), /\[DONE\]/)
  assert.equal((await new PerplexityStreamHandler('turbo', '').handleNonStream(done())).id, 'thread')
})

test('Perplexity keeps the first bound conversation ID stable when later frames include context_uuid', () => {
  const { PerplexityAdapter } = load('perplexity.ts', { electron: {} })
  const adapter = new PerplexityAdapter({ id: 'perplexity' }, account)
  const first = adapter.updateSessionData({ backend_uuid: 'first-entry', read_write_token: 'first-token' })
  const later = adapter.updateSessionData({ backend_uuid: 'second-entry', context_uuid: 'server-context' })
  assert.equal(first.sessionId, 'first-entry')
  assert.equal(later.sessionId, 'first-entry')
  assert.equal(later.parentMessageId, 'second-entry')
  assert.equal(later.extras.read_write_token, 'first-token')
})

test('Perplexity session cache isolates two conversations belonging to the same account', () => {
  const { PerplexityAdapter } = load('perplexity.ts', { electron: {} })
  const first = new PerplexityAdapter({ id: 'perplexity' }, account)
  const second = new PerplexityAdapter({ id: 'perplexity' }, account)
  first.updateSessionData({ context_uuid: 'thread-A', backend_uuid: 'entry-A', read_write_token: 'token-A' })
  second.updateSessionData({ context_uuid: 'thread-B', backend_uuid: 'entry-B', read_write_token: 'token-B' })
  assert.equal(PerplexityAdapter.getSessionData(account.id, 'thread-A').backend_uuid, 'entry-A')
  assert.equal(PerplexityAdapter.getSessionData(account.id, 'thread-B').read_write_token, 'token-B')
  PerplexityAdapter.clearSessionCache(account.id)
  assert.equal(PerplexityAdapter.getSessionData(account.id, 'thread-A'), undefined)
  assert.equal(PerplexityAdapter.getSessionData(account.id, 'thread-B'), undefined)
})

test('MiniMax exhausted polling fails the stream without a normal terminal marker', async () => {
  const { MiniMaxAdapter } = load('minimax.ts')
  const adapter = new MiniMaxAdapter({ id: 'minimax' }, account)
  adapter.request = async () => ({ status: 200, data: { base_resp: { status_code: 0 }, messages: [], chat: { chat_status: 2 } } })
  const stream = adapter.createPollingStream('chat', {}, 'MiniMax-Agent', 'pending-user')
  let emitted = ''
  stream.on('data', chunk => { emitted += chunk })
  await assert.rejects(collect(stream), /did not complete the current turn/)
  assert.equal(emitted.includes('[DONE]'), false)
})

test('MiniMax preserves multiple initial system instructions and tool results', () => {
  const { MiniMaxAdapter } = load('minimax.ts')
  const adapter = new MiniMaxAdapter({ id: 'minimax' }, account)
  const original = [
    { role: 'system', content: 'Always answer in Chinese' },
    { role: 'system', content: 'Available tools schema' },
    { role: 'user', content: '你好' },
  ]
  const frozen = Object.freeze(original.map(message => Object.freeze(message)))
  const payload = adapter.messagesPrepare(frozen)
  assert.match(payload.text, /Always answer in Chinese/)
  assert.match(payload.text, /Available tools schema/)
  assert.match(payload.text, /你好/)
  const tool = adapter.messagesPrepare([{ role: 'tool', tool_call_id: 'call-1', content: 'sunny' }])
  assert.match(tool.text, /call-1/)
  assert.match(tool.text, /sunny/)
  assert.deepEqual(plain(frozen), original)
})


test('MiniMax client disconnect clears a pending poll and aborts an in-flight detail request', async () => {
  const { once } = require('node:events')
  const { MiniMaxAdapter } = load('minimax.ts')
  const pending = new MiniMaxAdapter({ id: 'minimax' }, account)
  let requests = 0
  pending.request = async () => { requests++; assert.fail('scheduled poll should be cancelled') }
  const before = pending.createPollingStream('chat', {}, 'MiniMax-Agent', 'user')
  const beforeClose = once(before, 'close'); before.destroy(); await beforeClose
  await new Promise(setImmediate)
  assert.equal(requests, 0)

  const running = new MiniMaxAdapter({ id: 'minimax' }, account)
  let capturedSignal, requestStarted
  const started = new Promise(resolve => { requestStarted = resolve })
  running.request = (method, path, body, device, signal) => {
    requests++; capturedSignal = signal; requestStarted()
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
  }
  const output = running.createPollingStream('chat', {}, 'MiniMax-Agent', 'user')
  await started
  const closed = once(output, 'close'); output.destroy(); await closed
  await new Promise(setImmediate)
  assert.equal(capturedSignal.aborted, true)
  assert.equal(requests, 1)
})

test('MiMo disconnect destroys an idle upstream stream without waiting for the next event', async () => {
  const { once } = require('node:events')
  const { MimoStreamHandler } = load('mimo.ts')
  const upstream = new PassThrough()
  const output = new MimoStreamHandler('mimo-v2.5', 'thread').handleStream(upstream)
  output.resume()
  await new Promise(setImmediate)
  const closed = once(output, 'close')
  output.destroy()
  let timer
  try { await Promise.race([closed, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('disconnect deadlocked')), 1000) })]) }
  finally { clearTimeout(timer) }
  assert.equal(upstream.destroyed, true)
})

test('Perplexity disconnect reaches Electron request.abort, but normal EOF does not abort', async () => {
  const { once } = require('node:events')
  const responses = []; let aborts = 0
  const net = { request: () => {
    const request = new EventEmitter()
    request.setHeader = () => {}; request.write = () => {}
    request.abort = () => { aborts++ }
    request.end = () => setImmediate(() => {
      const response = new EventEmitter(); response.statusCode = 200; responses.push(response)
      request.emit('response', response)
    })
    return request
  } }
  const { PerplexityAdapter } = load('perplexity.ts', { electron: { net } })
  const { PerplexityStreamHandler } = load('perplexity-stream.ts')
  const first = await new PerplexityAdapter({ id: 'perplexity' }, account).chatCompletion({ model: 'turbo', messages: [{ role: 'user', content: 'hello' }] })
  const output = await new PerplexityStreamHandler('turbo', '').handleStream(first.stream)
  const closed = once(output, 'close'); output.destroy(); await closed
  await new Promise(setImmediate)
  assert.equal(first.stream.destroyed, true)
  assert.equal(aborts, 1)

  const second = await new PerplexityAdapter({ id: 'perplexity' }, account).chatCompletion({ model: 'turbo', messages: [{ role: 'user', content: 'hello' }] })
  const normal = await new PerplexityStreamHandler('turbo', '').handleStream(second.stream)
  const collected = collect(normal)
  responses[1].emit('data', Buffer.from('data: {"context_uuid":"thread","backend_uuid":"answer","status":"completed"}\n\n'))
  responses[1].emit('end')
  assert.match(await collected, /\[DONE\]/)
  await new Promise(setImmediate)
  assert.equal(aborts, 1)
})
