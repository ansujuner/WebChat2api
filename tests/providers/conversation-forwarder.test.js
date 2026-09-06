const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { PassThrough, Readable } = require('node:stream')
const vm = require('node:vm')
const ts = require('typescript')

// Exercise the real RequestForwarder + private WeakMap conversation options.
// Only provider transports/parsers, Electron store and tool-engine boundaries are mocked.
const base = join(__dirname, '../../src/main/proxy')
function evaluate(file, imports = {}) {
  const filename = join(base, file)
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  assert.equal(diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0)
  const exports = {}
  vm.runInNewContext(outputText, {
    exports, module: { exports }, Error, Buffer, structuredClone,
    require: name => {
      if (Object.hasOwn(imports, name)) return imports[name]
      if (!name.startsWith('.')) return require(name)
      throw new Error(`Unmocked import: ${name}`)
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: callback => setImmediate(callback), clearTimeout: clearImmediate,
  }, { filename })
  return exports
}
const providers = [
  ['deepseek', 'DeepSeek'], ['glm', 'GLM'], ['kimi', 'Kimi'],
  ['qwen', 'Qwen'], ['qwen-ai', 'QwenAi'], ['zai', 'Zai'],
  ['minimax', 'MiniMax'], ['mimo', 'Mimo'], ['perplexity', 'Perplexity'],
  ['arena', 'Arena'],
]
const plain = value => JSON.parse(JSON.stringify(value))
const consume = async stream => { let result = ''; for await (const chunk of stream) result += chunk; return result }

function fixture(zaiResponse) {
  const continuityModule = evaluate('conversationContinuity.ts')
  const manager = new continuityModule.ConversationContinuity()
  const captured = [], listeners = [], constructions = [], deletes = [], transforms = []
  let contextCalls = 0, failNext = false
  const makeAnswer = () => ({ id: 'upstream-thread', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture answer' }, finish_reason: 'stop' }] })
  const asChunks = () => `data: ${JSON.stringify({ id: 'upstream-thread', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'fixture answer' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'upstream-thread', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
  const imports = {
    axios: { default: { create: () => ({ request: () => assert.fail('no network allowed') }) } },
    './conversationContinuity': continuityModule,
    '../../shared/accountAvailability': require('../../src/shared/accountAvailability.ts'),
    '../store/accounts': { AccountManager: { suspendUntil() { assert.fail('No restriction in this fixture') }, updateStatus() { assert.fail('No restriction in this fixture') } } },
    './adapters/deepseek-restrictions': require('../../src/main/proxy/adapters/deepseek-restrictions.ts'),
    '../arena/protocol': { ArenaError: class extends Error { constructor(code) { super(code); this.status = 400 } } },
    './status': { proxyStatusManager: { getConfig: () => ({ timeout: 1000 }) } },
    '../store/store': { storeManager: { getAccountById: id => ({ id, status: 'active' }), getConfig: () => ({ retryCount: 3, contextManagement: { enabled: true }, toolCallingConfig: {} }) } },
    './sessionManager': { sessionManager: { shouldDeleteAfterChat: () => true } },
    './services/contextManagementService': { createContextManagementService: () => { contextCalls++; throw new Error('retained conversations must not summarize') } },
    './toolCalling/ToolCallingEngine': { ToolCallingEngine: class {
      transformRequest({ request }) {
        transforms.push(plain(request.messages))
        return { messages: [{ role: 'system', content: 'INJECTED_TOOL_SCHEMA' }, ...request.messages], tools: [{ ignored: true }], plan: { fixtureParserPlan: true } }
      }
      applyNonStreamResponse() {}
    } },
  }
  for (const [id, label] of providers) {
    class Adapter {
      constructor(provider, account) { assert.equal(provider.id, id); assert.equal(account.id, 'fixture-account') }
      async chatCompletion(options) {
        captured.push({ id, options })
        if (failNext) throw new Error('uncertain upstream submission')
        options.onConversation?.({ sessionId: 'upstream-thread', parentMessageId: `message-${captured.length}` })
        const response = id === 'zai' && zaiResponse ? zaiResponse : { status: 200, headers: {}, data: id === 'minimax' && !options.stream ? makeAnswer() : Readable.from([]) }
        if (id === 'perplexity') return { stream: response.data, sessionId: 'upstream-thread' }
        if (id === 'minimax' && options.stream) return { response: null, stream: { stream: Readable.from([asChunks()]) }, chatId: 'upstream-thread' }
        return { response, sessionId: 'upstream-thread', chatId: 'upstream-thread', conversationId: 'upstream-thread', reqId: 'request-id', query: 'fixture query' }
      }
      async deleteSession(value) { deletes.push({ id, value }); return true }
      async deleteConversation(value) { deletes.push({ id, value }); return true }
      async deleteChat(value) { deletes.push({ id, value }); return true }
      async generateConversationTitle() { return true }
    }
    Adapter[`is${label}Provider`] = provider => provider.id === id
    class Handler {
      constructor(...args) { constructions.push({ id, args }); this.listener = undefined }
      setConversationListener(listener) { assert.equal(typeof listener, 'function'); this.listener = listener; listeners.push({ id, listener }) }
      setAccountRestrictionListener() {}
      setChatId() {}
      getConversationId() { return 'upstream-thread' }
      getSessionId() { return 'upstream-thread' }
      getAssistantContentForTitle() { return 'fixture answer' }
      async handleStream() {
        assert.equal(typeof this.listener, 'function', 'listener must be connected before stream parsing')
        this.listener({ sessionId: 'upstream-thread', parentMessageId: `message-${captured.length}` })
        const output = new PassThrough()
        setImmediate(() => output.end(asChunks()))
        return output
      }
      async handleNonStream() {
        assert.equal(typeof this.listener, 'function', 'listener must be connected before non-stream parsing')
        this.listener({ sessionId: 'upstream-thread', parentMessageId: `message-${captured.length}` })
        return id === 'mimo' ? JSON.stringify(makeAnswer()) : makeAnswer()
      }
    }
    if (id === 'mimo') Handler.prototype.handleStream = function () {
      assert.equal(typeof this.listener, 'function')
      this.listener({ sessionId: 'upstream-thread', parentMessageId: `message-${captured.length}` })
      return Readable.from([asChunks()])
    }
    imports[`./adapters/${id}`] = { [`${label}Adapter`]: Adapter, [`${label}StreamHandler`]: Handler }
    if (id === 'deepseek' || id === 'perplexity' || id === 'arena') imports[`./adapters/${id}-stream`] = { [`${label}StreamHandler`]: Handler }
  }
  const { RequestForwarder } = evaluate('forwarder.ts', imports)
  return { manager, forwarder: new RequestForwarder(), captured, listeners, constructions, deletes, transforms, contextCalls: () => contextCalls, fail: () => { failNext = true } }
}

for (const status of [204, 302, 403, 429, 500]) {
  test(`zai forwarder rejects HTTP ${status} before parsing an error body`, { timeout: 1000 }, async () => {
    const data = new PassThrough()
    const f = fixture({ status, headers: {}, data })
    const result = await f.forwarder.forwardZai({ model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }] },
      { id: 'fixture-account', credentials: {} }, { id: 'zai', modelMappings: {} }, 'fixture-model', Date.now())
    assert.equal(result.success, false)
    assert.equal(result.status, status)
    assert.equal(result.error, `HTTP ${status}`)
    assert.equal(data.destroyed, true)
    assert.equal(f.constructions.length, 0)
  })
}

for (const [id] of providers) {
  for (const streaming of [false, true]) {
    test(`${id}: forwarder wires private conversation options and listener through three ${streaming ? 'streaming' : 'non-streaming'} turns`, async () => {
      const f = fixture()
      const provider = { id, apiEndpoint: 'https://fixture.invalid', headers: {}, modelMappings: {} }
      const account = { id: 'fixture-account', credentials: {} }
      const input = ['你好', '今天天气怎么样', '那明天呢']
      let sessionId
      for (let round = 0; round < input.length; round++) {
        const turn = f.manager.begin({ model: 'model', stream: streaming, ...(sessionId ? { sessionId } : {}), messages: [{ role: 'user', content: input[round] }] }, 'scope')
        sessionId = turn.id
        turn.bind({ providerId: id, accountId: account.id, actualModel: 'mapped-model' })
        const result = await f.forwarder.forwardChatCompletion(turn.request, account, provider, 'mapped-model', {})
        assert.equal(result.success, true, result.error)
        const output = streaming ? await consume(result.stream) : JSON.stringify(result.body)
        assert.match(output, /fixture answer/)
        const sent = f.captured.at(-1).options
        assert.equal(sent.model, 'mapped-model')
        assert.equal(sent.retainConversation, true)
        assert.equal(typeof sent.onConversation, 'function')
        if (round === 0) {
          assert.equal(sent.conversation, undefined)
          assert.equal(sent.messages[0].content, 'INJECTED_TOOL_SCHEMA')
        } else {
          assert.equal(sent.conversation.sessionId, 'upstream-thread')
          assert.equal(sent.conversation.parentMessageId, `message-${round}`)
          assert.deepEqual(plain(sent.messages), [{ role: 'user', content: input[round] }])
          assert.equal(sent.tools, undefined)
        }
        turn.commit({ role: 'assistant', content: 'fixture answer' })
      }
      assert.equal(f.captured.length, 3)
      assert.equal(f.listeners.length, id === 'minimax' ? 0 : 3, 'MiniMax reports polling state directly from its adapter')
      assert.ok(f.constructions.every(item => item.args.every(arg => typeof arg !== 'function')), 'retained handlers must not receive deletion callbacks')
      assert.equal(f.deletes.length, 0)
      assert.equal(f.contextCalls(), 0)
      assert.equal(f.transforms.length, 3, 'parser planning still runs without repeating the injected prompt')
    })
  }

  test(`${id}: retained forwarding does not retry uncertain submissions or call context summarization`, async () => {
    const f = fixture()
    f.fail()
    const turn = f.manager.begin({ model: 'model', messages: [{ role: 'user', content: 'hello' }] }, 'scope')
    turn.bind({ providerId: id, accountId: 'fixture-account', actualModel: 'mapped-model' })
    const result = await f.forwarder.forwardChatCompletion(turn.request, { id: 'fixture-account', credentials: {} }, { id, apiEndpoint: 'https://fixture.invalid' }, 'mapped-model', {})
    assert.equal(result.success, false)
    assert.equal(f.captured.length, 1)
    assert.equal(f.contextCalls(), 0)
    assert.equal(f.deletes.length, 0)
    turn.fail()
  })
}

