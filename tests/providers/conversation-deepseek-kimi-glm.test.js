const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { Readable, PassThrough } = require('node:stream')
const { once } = require('node:events')

const root = join(__dirname, '..', '..')
const plain = value => JSON.parse(JSON.stringify(value))

// Execute production adapters with only network/Electron boundaries replaced.
// All credentials and upstream replies are fixtures; this never contacts a site.
function load(file, overrides = {}) {
  const fileName = join(root, file)
  const result = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  assert.equal(result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0)
  const module = { exports: {} }
  vm.runInNewContext(result.outputText, {
    module, exports: module.exports, Buffer, TextDecoder, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      if (name.startsWith('.')) return {}
      return require(name)
    },
  }, { filename: fileName })
  return module.exports
}

const options = load('src/main/proxy/adapters/providerModelOptions.ts')
const common = {
  './deepseek-restrictions': load('src/main/proxy/adapters/deepseek-restrictions.ts'),
  './deepseek-restrictions.ts': load('src/main/proxy/adapters/deepseek-restrictions.ts'),
  './deepseek-images': load('src/main/proxy/adapters/deepseek-images.ts'),
  crypto: { default: require('node:crypto') },
  './providerModelOptions': options,
  './glm-model-options.ts': load('src/main/proxy/adapters/glm-model-options.ts'),
  '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({
    formatAssistantToolCalls: calls => `CALLS:${JSON.stringify(calls)}`,
    formatToolResult: result => `TOOL_RESULT:${result.toolCallId}:${result.content}`,
  }) },
  '../utils/tools': {
    hasToolPromptInjected: () => false,
    toolsToSystemPrompt: () => 'FIXTURE_TOOL_DEFINITION', TOOL_WRAP_HINT: '',
  },
  '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
  '../utils/toolParser.ts': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
  '../utils/streamToolHandler': { createBaseChunk: (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' }) },
  '../../store/store': { storeManager: { updateAccount() {} } },
}
const account = Object.freeze({ id: 'fixture-account', credentials: Object.freeze({ token: 'fixture-token', refresh_token: 'fixture-token' }) })
const provider = Object.freeze({ id: 'fixture', apiEndpoint: 'fixture-only' })

function bytes(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value)
  // Force UTF-8 and Connect framing across transport boundaries.
  return Readable.from(Array.from({ length: Math.ceil(buffer.length / 7) }, (_, i) => buffer.subarray(i * 7, i * 7 + 7)))
}
function sse(events, done = false) {
  return bytes(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''))
}
async function consume(handler, response, streaming) {
  if (!streaming) return handler.handleNonStream(response)
  let text = ''
  for await (const chunk of await handler.handleStream(response)) text += String(chunk)
  const chunks = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)))
  assert.equal((text.match(/data: \[DONE\]/g) || []).length, 1)
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop')
  return { choices: [{ message: { content: chunks.map(chunk => chunk.choices[0].delta.content || '').join('') } }] }
}

function setup(kind, complete = true) {
  const sent = []
  let createCount = 0
  let generation = 0
  const client = {
    get: async () => ({ status: 200, data: { data: { biz_data: { token: 'fixture-access' } } } }),
    post: async (url, body) => {
      if (url.endsWith('/chat_session/create')) {
        createCount++
        return { status: 200, data: { data: { biz_data: { chat_session: { id: `deepseek-${createCount}` } } } } }
      }
      if (url.endsWith('/create_pow_challenge')) {
        return { status: 200, data: { data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1' } } } } }
      }
      if (url.endsWith('/user/refresh')) {
        return { status: 200, data: { code: 0, result: { access_token: 'fixture-access', refresh_token: 'fixture-token' } } }
      }
      const payload = kind === 'kimi' ? JSON.parse(body.subarray(5).toString()) : plain(body)
      sent.push({ url, payload })
      generation++
      const answer = `答复${generation}`
      let data
      if (kind === 'deepseek') {
        data = sse([
          { response_message_id: generation * 2 },
          { v: { response: { thinking_enabled: false, fragments: [{ type: 'ANSWER', content: answer }] } } },
        ], complete)
      } else if (kind === 'kimi') {
        const events = [
          { chat: { id: 'kimi-chat' }, message: { id: `user-${generation}`, role: 'user' } },
          { message: { id: `thinking-${generation}`, role: 'assistant' } },
          // A later generated answer block is the actual next-turn parent.
          { op: 'append', mask: 'block.text', block: { message_id: `answer-${generation}`, text: { content: answer } } },
          ...(complete ? [{ done: true }] : []),
        ]
        data = bytes(Buffer.concat(events.map(options.encodeKimiGrpcFrame)))
      } else {
        data = sse([
          { conversation_id: 'glm-chat', status: 'processing', parts: [{ logic_id: 1, content: [{ type: 'text', text: answer }] }] },
          ...(complete ? [{ conversation_id: 'glm-chat', status: 'finish' }] : []),
        ])
      }
      return { status: 200, data }
    },
  }
  const overrides = {
    ...common, axios: { default: client },
    '../../lib/challenge': { getDeepSeekHash: async () => ({ calculateHash: () => 1 }) },
  }
  const module = load(`src/main/proxy/adapters/${kind}.ts`, overrides)
  const [Adapter, Handler, model] = kind === 'deepseek'
    ? [module.DeepSeekAdapter, load('src/main/proxy/adapters/deepseek-stream.ts', common).DeepSeekStreamHandler, 'deepseek-v4-flash']
    : kind === 'kimi' ? [module.KimiAdapter, module.KimiStreamHandler, 'k2d6-chat']
      : [module.GLMAdapter, module.GLMStreamHandler, 'glm-5.3-flash']
  return {
    adapter: new Adapter(provider, account), sent, model,
    createCount: () => createCount,
    handler: sessionId => kind === 'glm' ? new Handler(model, undefined, sessionId) : new Handler(model, sessionId),
  }
}

for (const kind of ['deepseek', 'kimi', 'glm']) {
  for (const streaming of [true, false]) {
    test(`${kind} ${streaming ? 'stream' : 'non-stream'} reuses one upstream chat for three verbatim turns`, async () => {
      const fixture = setup(kind)
      let conversation
      const inputs = ['你好', '今天天气怎么样', '接着说']
      for (let turn = 0; turn < inputs.length; turn++) {
        const previous = conversation && Object.freeze({ ...conversation })
        const observe = state => { conversation = { ...conversation, ...plain(state) } }
        const request = Object.freeze({
          model: fixture.model,
          messages: Object.freeze([Object.freeze({ role: 'user', content: inputs[turn] })]),
          conversation: previous, retainConversation: true, onConversation: observe,
        })
        const result = await fixture.adapter.chatCompletion(request)
        const handler = fixture.handler(result.sessionId || result.conversationId || '')
        handler.setConversationListener(observe)
        const response = await consume(handler, result.response.data, streaming)
        assert.equal(response.choices[0].message.content, `答复${turn + 1}`)
        const payload = fixture.sent[turn].payload
        const prompt = kind === 'deepseek' ? payload.prompt : kind === 'kimi' ? payload.message.blocks[0].text.content : payload.messages[0].content[0].text
        assert.equal(prompt, inputs[turn])
        if (kind === 'deepseek') {
          assert.equal(payload.chat_session_id, 'deepseek-1')
          assert.equal(payload.parent_message_id, turn === 0 ? null : turn * 2)
          assert.equal(conversation.parentMessageId, String((turn + 1) * 2))
        } else if (kind === 'kimi') {
          assert.equal(payload.chat_id, turn === 0 ? '' : 'kimi-chat')
          assert.equal(payload.message.parent_id, turn === 0 ? '' : `answer-${turn}`)
          assert.equal(conversation.parentMessageId, `answer-${turn + 1}`)
        } else assert.equal(payload.conversation_id, turn === 0 ? '' : 'glm-chat')
        if (turn > 0) assert.equal(conversation.sessionId, previous.sessionId)
        assert.equal(request.messages[0].content, inputs[turn])
      }
      if (kind === 'deepseek') assert.equal(fixture.createCount(), 1)
      assert.equal(fixture.sent.length, 3)
    })

    test(`${kind} ${streaming ? 'stream' : 'non-stream'} rejects truncated output instead of a success finish`, async () => {
      const fixture = setup(kind, false)
      const result = await fixture.adapter.chatCompletion({ model: fixture.model, messages: [{ role: 'user', content: '你好' }] })
      const handler = fixture.handler(result.sessionId || result.conversationId || '')
      await assert.rejects(consume(handler, result.response.data, streaming), /before.*completion/)
    })
  }
}

for (const kind of ['deepseek', 'kimi', 'glm']) {
  test(`${kind} client cancellation destroys its actual upstream readable`, async () => {
    const fixture = setup(kind)
    const source = new PassThrough()
    const upstreamClosed = once(source, 'close')
    const output = await fixture.handler('existing-chat').handleStream(source)
    output.on('error', () => {})
    output.destroy()
    await upstreamClosed
    assert.equal(source.destroyed, true)
  })

  test(`${kind} normal successful completion does not abort its upstream before EOF`, async () => {
    const fixture = setup(kind)
    const source = new PassThrough()
    const destroy = source.destroy.bind(source)
    let prematurelyDestroyed = false
    source.destroy = (...args) => {
      if (!source.readableEnded) prematurelyDestroyed = true
      return destroy(...args)
    }
    const consumed = consume(fixture.handler('existing-chat'), source, true)
    const data = kind === 'deepseek'
      ? `data: ${JSON.stringify({ response_message_id: 2 })}\n\ndata: [DONE]\n\n`
      : kind === 'kimi' ? options.encodeKimiGrpcFrame({ done: true })
        : `data: ${JSON.stringify({ conversation_id: 'existing-chat', status: 'finish' })}\n\n`
    source.end(data)
    await consumed
    assert.equal(prematurelyDestroyed, false)
  })
}

test('DeepSeek new client conversations on the same account never share an account-wide cache', async () => {
  const fixture = setup('deepseek')
  for (let chat = 1; chat <= 2; chat++) {
    const result = await fixture.adapter.chatCompletion({ model: fixture.model, messages: [{ role: 'user', content: '你好' }] })
    await consume(fixture.handler(result.sessionId), result.response.data, false)
    assert.equal(fixture.sent.at(-1).payload.chat_session_id, `deepseek-${chat}`)
    assert.equal(fixture.sent.at(-1).payload.parent_message_id, null)
  }
  assert.equal(fixture.createCount(), 2)
})

for (const kind of ['deepseek', 'kimi']) {
  test(`${kind} refuses a continuation missing the real assistant cursor`, async () => {
    const fixture = setup(kind)
    await assert.rejects(fixture.adapter.chatCompletion({
      model: fixture.model, messages: [{ role: 'user', content: '下一句' }], conversation: { sessionId: 'existing' },
    }), /previous assistant message ID/)
    assert.equal(fixture.sent.length, 0)
  })
}

test('Kimi never treats an echoed user block as the assistant cursor', async () => {
  const fixture = setup('kimi')
  const handler = fixture.handler('kimi-chat')
  let state
  handler.setConversationListener(value => { state = value })
  const data = bytes(Buffer.concat([
    { message: { id: 'user-echo', role: 'user' } },
    { op: 'set', mask: 'block.text', block: { message_id: 'user-echo', text: { content: 'echo' } } },
    { done: true },
  ].map(options.encodeKimiGrpcFrame)))
  await consume(handler, data, false)
  assert.equal(state?.parentMessageId, undefined)
})

for (const kind of ['deepseek', 'kimi', 'glm']) {
  test(`${kind} retains initial system instructions and sends subsequent tool results without old user input`, async () => {
    const fixture = setup(kind)
    const observe = state => { conversation = { ...conversation, ...plain(state) } }
    let conversation
    const first = await fixture.adapter.chatCompletion({ model: fixture.model, onConversation: observe,
      messages: [{ role: 'system', content: '系统指令' }, { role: 'user', content: '你好' }],
    })
    const firstHandler = fixture.handler(first.sessionId || first.conversationId || '')
    firstHandler.setConversationListener(observe)
    await consume(firstHandler, first.response.data, false)
    assert.match(JSON.stringify(fixture.sent[0].payload), /系统指令/)
    const second = await fixture.adapter.chatCompletion({ model: fixture.model, conversation,
      messages: [{ role: 'tool', tool_call_id: 'call-1', content: '天气晴' }],
    })
    await consume(fixture.handler(second.sessionId || second.conversationId || ''), second.response.data, false)
    assert.match(JSON.stringify(fixture.sent[1].payload), /天气晴/)
    assert.doesNotMatch(JSON.stringify(fixture.sent[1].payload), /你好|系统指令/)
  })
}
