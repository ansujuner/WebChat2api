const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { PassThrough, Readable } = require('node:stream')
const { getEventListeners } = require('node:events')
const { setImmediate: nextTurn } = require('node:timers/promises')
const restrictions = require('../../src/main/proxy/adapters/deepseek-restrictions.ts')
const continuity = require('../../src/main/proxy/conversationContinuity.ts')
const availability = require('../../src/shared/accountAvailability.ts')
const source = readFileSync(path.join(__dirname, '../../src/main/proxy/forwarder.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText
const providers = [['deepseek','DeepSeek'], ['glm','GLM'], ['kimi','Kimi'], ['mimo','Mimo'],
  ['qwen','Qwen'], ['qwen-ai','QwenAi'], ['zai','Zai'], ['minimax','MiniMax'],
  ['perplexity','Perplexity'], ['arena','Arena']]
const plain = value => JSON.parse(JSON.stringify(value))
const answer = () => ({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] })
// Execute the real typed error declaration without loading any provider transport.
const zaiSource = readFileSync(path.join(__dirname, '../../src/main/proxy/adapters/zai.ts'), 'utf8')
const zaiAst = ts.createSourceFile('zai.ts', zaiSource, ts.ScriptTarget.Latest, true)
const errorDeclaration = zaiAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'ZaiUpstreamError')
const errorModule = { exports: {} }
vm.runInNewContext(ts.transpileModule(errorDeclaration.getText(zaiAst), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText, { exports: errorModule.exports, Error })
const { ZaiUpstreamError } = errorModule.exports
const glmSource = readFileSync(path.join(__dirname, '../../src/main/proxy/adapters/glm.ts'), 'utf8')
const glmAst = ts.createSourceFile('glm.ts', glmSource, ts.ScriptTarget.Latest, true)
const glmErrorDeclaration = glmAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'GLMUpstreamError')
const glmErrorModule = { exports: {} }
vm.runInNewContext(ts.transpileModule(glmErrorDeclaration.getText(glmAst), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText, { exports: glmErrorModule.exports, Error })
const { GLMUpstreamError } = glmErrorModule.exports

function realZaiHandler() {
  const module = { exports: {} }
  const imports = {
    '../utils/streamToolHandler': {
      createToolCallState: () => ({ hasEmittedToolCall: false }),
      createBaseChunk: (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' }),
      processStreamContent: (content, state, base) => ({ chunks: [{ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] }] }),
      flushToolCallBuffer: () => [],
    },
  }
  vm.runInNewContext(ts.transpileModule(zaiSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText, { module, exports: module.exports, Buffer, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require: name => Object.hasOwn(imports, name) ? imports[name] : name.startsWith('.') ? {} : require(name),
  })
  return module.exports.ZaiStreamHandler
}

function fixture(providerId = 'deepseek', options = {}) {
  let account = { id: 'fixture-account', providerId, enabled: false, status: 'expired',
    credentials: { token: 'fixture-not-a-real-credential' }, ...options.account }
  let provider = { id: providerId, enabled: false, apiEndpoint: 'https://fixture.invalid', headers: {}, ...options.provider }
  const captured = [], changes = [], parsers = [], observed = []
  const storeManager = {
    // Mirror the real store: credential material is decrypted only with the explicit flag.
    getAccountById: (id, includeCredentials = false) => id !== 'fixture-account' ? undefined
      : includeCredentials ? account : { ...account, credentials: { token: 'encrypted-fixture-placeholder' } },
    getProviderById: id => id === providerId ? provider : undefined,
    getConfig: () => ({ retryCount: 4, contextManagement: { enabled: true }, toolCallingConfig: { mode: 'managed' } }),
  }
  class AxiosError extends Error {}
  const imports = {
    '../providers/customApi': require('../../src/main/providers/customApi.ts'),
    axios: { create: () => ({ request: async config => { captured.push({ config }); return options.custom ? options.custom(config) : { status: 200, headers: {}, data: answer() } } }), AxiosError },
    '../store/store': { storeManager },
    '../store/accounts': { AccountManager: {
      suspendUntil: (...args) => changes.push({ kind: 'suspend', args }),
      updateStatus: (...args) => changes.push({ kind: 'status', args }),
    } },
    '../../shared/accountAvailability': availability,
    './conversationContinuity': continuity,
    './adapters/deepseek-restrictions': restrictions,
    './status': { proxyStatusManager: { getConfig: () => ({ timeout: 1000 }) } },
    './sessionManager': { sessionManager: { shouldDeleteAfterChat: () => true } },
    './services/contextManagementService': { createContextManagementService() { throw Error('must never summarize a probe') } },
    './toolCalling/ToolCallingEngine': { ToolCallingEngine: class {
      constructor() { if (!options.allowToolEngine) throw Error('must never inject or parse tools for a probe') }
      transformRequest({ request }) { return { messages: request.messages, plan: { shouldParseResponse: false } } }
    } },
    '../arena/protocol': { ArenaError: class extends Error {} },
  }
  for (const [id, label] of providers) {
    class Adapter {
      constructor(selectedProvider, selectedAccount) {
        assert.equal(selectedProvider, provider)
        assert.equal(selectedAccount, account)
      }
      async chatCompletion(request) {
        captured.push({ id, request })
        if (options.beforeResponse) await options.beforeResponse()
        if (options.error) throw options.error
        const data = options.websiteStream ? options.websiteStream(request) : options.raw ?? Readable.from([])
        const response = { status: options.responseStatus ?? 200, headers: {}, data: id === 'minimax' ? answer() : data }
        if (id === 'perplexity') return { stream: data, sessionId: 'new-probe-only' }
        return { response, sessionId: 'new-probe-only', conversationId: 'new-probe-only', chatId: 'new-probe-only', query: 'probe' }
      }
      deleteSession() { assert.fail('probe must not delete user conversations') }
      deleteConversation() { assert.fail('probe must not delete user conversations') }
      deleteChat() { assert.fail('probe must not delete user conversations') }
      generateConversationTitle() { assert.fail('probe must not request a second generation for a title') }
    }
    Adapter[`is${label}Provider`] = value => value.id === id
    class Handler {
      constructor(...args) { parsers.push(args) }
      setChatId() {}
      setAccountRestrictionListener() {}
      getSessionId() { return 'new-probe-only' }
      getConversationId() { return 'new-probe-only' }
      setConversationListener() { assert.fail('probe must not register a conversation continuation') }
      async handleNonStream(raw) {
        if (options.beforeParse) await options.beforeParse()
        for await (const chunk of raw) observed.push(Buffer.from(chunk))
        if (options.parseError) throw options.parseError
        return id === 'mimo' ? JSON.stringify(answer()) : answer()
      }
    }
    imports[`./adapters/${id}`] = { [`${label}Adapter`]: Adapter, [`${label}StreamHandler`]: Handler }
    if (id === 'zai') {
      imports[`./adapters/${id}`].ZaiUpstreamError = ZaiUpstreamError
      if (options.actualZaiHandler) imports[`./adapters/${id}`].ZaiStreamHandler = realZaiHandler()
    }
    if (id === 'glm') imports[`./adapters/${id}`].GLMUpstreamError = GLMUpstreamError
    if (['deepseek', 'perplexity', 'arena'].includes(id)) imports[`./adapters/${id}-stream`] = { [`${label}StreamHandler`]: Handler }
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports, Buffer, Error, Date, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} }, require: name => {
      if (Object.hasOwn(imports, name)) return imports[name]
      if (name === 'stream') return require('node:stream')
      throw Error(`Unmocked boundary: ${name}`)
    },
  })
  const forwarder = new module.exports.RequestForwarder()
  return { forwarder, captured, changes, parsers, observed, AxiosError, account: () => account, provider: () => provider,
    replaceAccount: next => { account = next }, removeProvider: () => { provider = undefined },
    run: signal => forwarder.forwardAccountProbe('fixture-account', 'actual-model', signal, providerId === 'arena' ? 'arena/text/actual-model' : 'display-model'),
  }
}

for (const [id] of providers) test(`${id}: exact-account probe contains one plain turn, no tools/context/title/deletion or status writes`, async () => {
  const f = fixture(id)
  const before = plain(f.account())
  const result = await f.run()
  assert.equal(result.success, true, result.error)
  assert.equal(f.captured.length, 1)
  const sent = f.captured[0].request
  assert.equal(sent.model, 'actual-model')
  assert.deepEqual(plain(sent.messages), [{ role: 'user', content: '你好，请只回复 OK。' }])
  assert.equal(sent.stream, false)
  assert.equal(sent.tools, undefined)
  assert.equal(sent.conversation, undefined)
  assert.equal(sent.onConversation, undefined)
  assert.equal(sent.retainConversation, true)
  assert.deepEqual(plain(f.account()), before)
  assert.deepEqual(f.changes, [])
  assert.ok(f.parsers.every(args => args.every(arg => typeof arg !== 'function')))
})

test('custom probe sends max_tokens 32 once, takes fresh credentials, and never serializes internal capability/signal', async () => {
  const f = fixture('custom')
  const controller = new AbortController()
  const result = await f.run(controller.signal)
  assert.equal(result.success, true)
  assert.equal(f.captured.length, 1)
  const config = f.captured[0].config
  assert.equal(config.signal, controller.signal)
  assert.equal(config.maxContentLength, 1024 * 1024)
  assert.equal(config.maxBodyLength, 16 * 1024)
  assert.deepEqual(plain(config.data), { model: 'actual-model', messages: [{ role: 'user', content: '你好，请只回复 OK。' }], stream: false, max_tokens: 32 })
  assert.equal(config.headers.Authorization, `Bearer ${f.account().credentials.token}`)
  assert.deepEqual(f.changes, [])
})

test('Z.ai guard binds account identity/revision and provider existence, not natural token refresh or user preferences', async () => {
  const f = fixture('zai', { account: { credentialRevision: 4, email: 'fixture@example.invalid', providerUserId: 'fixture-user' } })
  assert.equal((await f.run()).success, true)
  const guard = f.captured[0].request.isAccountCurrent
  assert.equal(typeof guard, 'function')
  assert.equal(guard(), true)
  const initial = f.account()
  for (const updates of [{ credentials: { token: 'fresh-website-token' } }, { name: 'New label' }, { enabled: true },
    { todayUsed: 5, cooldownUntil: Date.now() + 5000 }]) {
    f.replaceAccount({ ...initial, ...updates })
    assert.equal(guard(), true, 'same account metadata remains bound')
  }
  for (const updates of [{ credentialRevision: 5 }, { email: 'different@example.invalid' }, { providerUserId: 'different-user' },
    { providerId: 'glm' }, { id: 'different-account' }]) {
    f.replaceAccount({ ...initial, ...updates })
    assert.equal(guard(), false, 'explicit account/identity changes invalidate the submission')
  }
  f.replaceAccount(initial)
  f.removeProvider()
  assert.equal(guard(), false)
  assert.doesNotMatch(JSON.stringify(f.captured[0].request), /isAccountCurrent/)
})

for (const stream of [false, true]) test(`Z.ai ${stream ? 'stream' : 'nonstream'} graph-verified cursor cannot be overwritten by conflicting terminal SSE IDs`, async () => {
  const f = fixture('zai', { actualZaiHandler: true, allowToolEngine: true,
    websiteStream: request => Readable.from((async function* () {
      yield Buffer.from('data: {"type":"chat:completion","data":{"phase":"answer","delta_content":"OK"}}\n\n')
      // The website bridge reports its authoritative GET /chats graph before releasing the terminal tail.
      request.onConversation({ sessionId: 'new-probe-only', parentMessageId: 'verified-graph-assistant' })
      yield Buffer.from('data: {"type":"chat:completion","data":{"role":"assistant","id":"unverified-sse-id","phase":"done","done":true}}\n\n')
    })()),
  })
  const tracker = new continuity.ConversationContinuity()
  const turn = tracker.begin({ model: 'model', stream, messages: [{ role: 'user', content: 'First' }] }, 'fixture')
  turn.bind({ providerId: 'zai', accountId: 'fixture-account', actualModel: 'model', kind: 'zai' })
  const result = await f.forwarder.forwardZai(turn.request, f.account(), f.provider(), 'model', Date.now())
  assert.equal(result.success, true, result.error)
  if (stream) {
    let text = ''
    for await (const chunk of result.stream) text += chunk.toString()
    assert.match(text, /\[DONE\]/)
  } else assert.equal(result.body.choices[0].message.content, 'OK')
  turn.commit({ role: 'assistant', content: 'OK' })
  const next = tracker.begin({ model: 'model', session_id: turn.id, messages: [{ role: 'user', content: 'Next' }] }, 'fixture')
  assert.equal(continuity.getConversationOptions(next.request).conversation.parentMessageId, 'verified-graph-assistant')
  next.cancel()
})

for (const [name, account, code, status] of [
  ['finite cooldown', { cooldownUntil: Date.now() + 3600000 }, 'account_temporarily_suspended', 429],
  ['indefinite cooldown', { cooldownReason: 'temporary_ban' }, 'account_temporarily_suspended', 429],
  ['malformed cooldown', { cooldownUntil: NaN }, 'account_temporarily_suspended', 429],
  ['daily quota', { dailyLimit: 2, todayUsed: 2 }, 'account_daily_limit', 429],
  ['persisted permanent ban', { errorMessage: 'DeepSeek account suspended; manual review required.' }, 'account_banned', 403],
  ['permanent ban code', { errorMessage: 'account_banned' }, 'account_banned', 403],
]) test(`probe cannot bypass ${name}, even while manually disabled and auth status stale`, async () => {
  const f = fixture('deepseek', { account })
  const result = await f.run()
  assert.equal(result.success, false)
  assert.equal(result.errorCode, code)
  assert.equal(result.status, status)
  assert.equal(f.captured.length, 0)
  assert.deepEqual(f.changes, [])
})

test('expired cooldown and stale error auth status may be explicitly tested without enabling the account', async () => {
  const f = fixture('deepseek', { account: { cooldownReason: 'temporary_ban', cooldownUntil: Date.now() - 1000, status: 'error', errorMessage: 'Authentication expired' } })
  assert.equal((await f.run()).success, true)
  assert.equal(f.account().status, 'error')
  assert.equal(f.account().enabled, false)
  assert.deepEqual(f.changes, [])
})

test('missing/stale selection and arbitrary invalid models never create a transport', async () => {
  const f = fixture()
  assert.equal((await f.forwarder.forwardAccountProbe('missing', 'model')).status, 404)
  for (const model of ['', ' ', '*', 'bad\nmodel', 'x'.repeat(257)]) {
    assert.equal((await f.forwarder.forwardAccountProbe('fixture-account', model)).status, 400)
  }
  f.removeProvider()
  assert.equal((await f.run()).status, 404)
  assert.equal(f.captured.length, 0)
})

test('JSON-looking probe flags cannot bypass ordinary request account scheduling', async () => {
  const f = fixture()
  const result = await f.forwarder.forwardChatCompletion({ model: 'model', messages: [], account_probe: true, forwardAccountProbe: true, skipAvailability: true },
    f.account(), f.provider(), 'model', {})
  assert.equal(result.success, false)
  assert.equal(f.captured.length, 0)
})

test('uncertain provider failure is attempted once despite configured retryCount', async () => {
  const f = fixture('deepseek', { error: Error('fixture uncertain response') })
  assert.equal((await f.run()).success, false)
  assert.equal(f.captured.length, 1)
})

test('an unconsumed failed response is closed on settlement without aborting unrelated streams', async () => {
  const raw = new PassThrough(), unrelated = new PassThrough()
  const f = fixture('deepseek', { raw, responseStatus: 403 })
  const controller = new AbortController()
  assert.equal((await f.run(controller.signal)).status, 403)
  assert.equal(raw.destroyed, true)
  assert.equal(unrelated.destroyed, false)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  unrelated.destroy()
})

test('real DeepSeek restriction catch still records provider-directed restrictions during a probe', async () => {
  let error
  try { restrictions.throwIfDeepSeekRestricted({ code: 50006, data: { end_at: Math.ceil(Date.now() / 1000) + 3600 } }) } catch (caught) { error = caught }
  const f = fixture('deepseek', { error })
  assert.equal((await f.run()).errorCode, 'account_temporarily_suspended')
  assert.equal(f.captured.length, 1)
  assert.equal(f.changes.length, 1)
  assert.equal(f.changes[0].kind, 'suspend')
})

test('abort before submission performs no work', async () => {
  const f = fixture()
  const controller = new AbortController()
  controller.abort()
  assert.equal((await f.run(controller.signal)).errorCode, 'account_probe_cancelled')
  assert.equal(f.captured.length, 0)
})

test('abort destroys only this probe response stream, waits for its parser to settle, and removes listeners', async () => {
  const raw = new PassThrough(), unrelated = new PassThrough()
  const f = fixture('deepseek', { raw })
  const controller = new AbortController()
  const pending = f.run(controller.signal)
  await nextTurn()
  controller.abort()
  assert.equal((await pending).errorCode, 'account_probe_cancelled')
  assert.equal(raw.destroyed, true)
  assert.equal(unrelated.destroyed, false)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  unrelated.destroy()
})

test('unsupported setup cancellation does not race/unlock the still-running request', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const raw = new PassThrough()
  const f = fixture('deepseek', { raw, beforeResponse: () => gate })
  const controller = new AbortController()
  let settled = false
  const pending = f.run(controller.signal).then(result => { settled = true; return result })
  await nextTurn()
  controller.abort()
  await nextTurn()
  assert.equal(settled, false)
  release()
  assert.equal((await pending).errorCode, 'account_probe_cancelled')
  assert.equal(raw.destroyed, true)
  assert.equal(f.captured.length, 1)
  assert.equal(f.parsers.length, 0)
})

test('the native response cap is lazy, preserves the first UTF-8 chunks, and permits exactly 1 MiB', async () => {
  let reads = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const bytes = Buffer.concat([Buffer.from('首尾'), Buffer.alloc(1024 * 1024 - Buffer.byteLength('首尾'), 32)])
  const raw = new Readable({ read() { reads++; this.push(bytes.subarray(0, 1)); this.push(bytes.subarray(1)); this.push(null) } })
  const f = fixture('deepseek', { raw, beforeParse: () => gate })
  const pending = f.run()
  await nextTurn()
  assert.equal(reads, 0, 'no consumption before the parser subscribes')
  release()
  assert.equal((await pending).success, true)
  assert.deepEqual(Buffer.concat(f.observed), bytes)
})

for (const id of ['deepseek', 'arena', 'perplexity']) test(`${id}: raw native response over 1 MiB fails and closes only its own stream`, async () => {
  const raw = Readable.from([Buffer.alloc(512 * 1024), Buffer.alloc(512 * 1024), Buffer.from('x')])
  const f = fixture(id, { raw })
  const controller = new AbortController()
  const result = await f.run(controller.signal)
  assert.equal(result.success, false)
  assert.equal(result.errorCode, 'account_probe_response_too_large')
  assert.equal(result.status, 502)
  assert.equal(raw.destroyed, true)
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  assert.equal(f.captured.length, 1)
})

test('Z.ai may reject before reading the bounded stream without leaving the original source open', async () => {
  const raw = new PassThrough()
  const f = fixture('zai', { raw, responseStatus: 403 })
  assert.equal((await f.run()).status, 403)
  await nextTurn()
  assert.equal(raw.destroyed, true)
})

test('custom Axios size-limit rejection becomes a safe typed failure with no retry', async () => {
  const f = fixture('custom', { custom: async () => { throw new f.AxiosError('maxContentLength size of 1048576 exceeded') } })
  const result = await f.run()
  assert.equal(result.success, false)
  assert.equal(result.errorCode, 'account_probe_response_too_large')
  assert.equal(result.status, 502)
  assert.equal(f.captured.length, 1)
})

const zaiCategories = [
  ['captcha_required', 403, 'action_required'], ['verification_required', 403, 'action_required'],
  ['authentication_required', 401, 'authentication_required'], ['access_denied', 403, 'action_required'],
  ['model_unavailable', 404, 'model_unavailable'], ['rate_limited', 429, 'rate_limited'],
  ['quota_exceeded', 429, 'rate_limited'], ['upstream_error', 502, 'upstream_error'],
  ['invalid_json', 502, 'incomplete_response'], ['unexpected_json', 502, 'incomplete_response'],
  ['incomplete_stream', 502, 'incomplete_response'], ['transport_error', 502, 'transport_error'],
  ['browser_unavailable', 503, 'browser_unavailable'], ['account_busy', 409, 'account_busy'],
  ['account_changed', 409, 'account_probe_selection_changed'], ['invalid_request', 400, 'invalid_request'],
  ['unsupported_options', 400, 'unsupported_options'], ['cancelled', 408, 'account_probe_cancelled'],
  ['protocol_mismatch', 502, 'incomplete_response'],
]
for (const [status, code] of [[401, 'authentication_required'], [403, 'action_required'], [429, 'rate_limited'], [502, 'upstream_error']]) {
  test(`GLM ${status} retains safe failure classification for account liveness`, async () => {
    const error = new GLMUpstreamError(status, status === 429 ? '120' : undefined)
    error.message = 'PRIVATE auth token and remote prose'
    const f = fixture('glm', { error })
    const result = await f.run()
    assert.equal(result.success, false)
    assert.equal(result.status, status)
    assert.equal(result.errorCode, code)
    assert.equal(result.headers?.['retry-after'], status === 429 ? '120' : undefined)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|token|prose/)
    assert.equal(f.captured.length, 1, 'an auth failure is not silently retried')
  })
}
test('probe mapping covers exactly the typed Z.ai failure category enum', () => {
  const declaration = zaiAst.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === 'ZaiFailureCategory')
  assert.deepEqual([...declaration.getText(zaiAst).matchAll(/'([a-z_]+)'/g)].map(match => match[1]).sort(),
    zaiCategories.map(([category]) => category).sort())
})
for (const [category, status, code] of zaiCategories) test(`HTTP-200 Z.ai parser failure ${category} produces a safe truthful probe result`, async () => {
  const parseError = new ZaiUpstreamError(category, 401)
  parseError.message = 'fixture-private-provider-message'
  const f = fixture('zai', { parseError })
  const result = await f.run()
  assert.equal(result.success, false)
  assert.equal(result.status, status)
  assert.equal(result.errorCode, code)
  assert.equal(f.captured.length, 1)
  assert.equal(f.parsers.length, 1, 'classification happens after the HTTP-200 response is consumed')
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|upstreamCode/)
})
test('Z.ai error prose/duck-typed categories do not forge probe classifications or leak private messages', async () => {
  for (const parseError of [Object.assign(Error('fixture-private: captcha_required'), { category: 'captcha_required' }),
    Object.assign(new ZaiUpstreamError('upstream_error'), { category: 'fixture-private-category' })]) {
    const f = fixture('zai', { parseError })
    const result = await f.run()
    assert.equal(result.errorCode, 'upstream_error')
    assert.equal(result.status, 502)
    assert.doesNotMatch(JSON.stringify(result), /fixture-private/)
    assert.equal(f.captured.length, 1)
  }
})
for (const [category, status, accountCode] of zaiCategories) test(`ordinary Z.ai ${category} retains safe HTTP/code rather than becoming a generic 500`, async () => {
  const parseError = new ZaiUpstreamError(category, 401)
  parseError.message = 'fixture-private-provider-message'
  const f = fixture('zai', { parseError, allowToolEngine: true, account: { enabled: true, status: 'active' } })
  const result = await f.forwarder.forwardZai({ model: 'model', stream: false, messages: [{ role: 'user', content: 'fixture' }] },
    f.account(), f.provider(), 'model', Date.now())
  assert.equal(result.success, false)
  const code = ['captcha_required', 'verification_required', 'access_denied', 'quota_exceeded'].includes(category) ? category : accountCode
  assert.equal(result.status, status)
  assert.equal(result.errorCode, code)
  assert.equal(result.error, `Z.ai upstream ${code}`)
  assert.doesNotMatch(JSON.stringify(result), /fixture-private|upstreamCode/)
})

const nativeTools = [{ type: 'function', function: { name: 'fixture_echo', parameters: { type: 'object', properties: { value: { type: 'string' } } } } }]
for (const stream of [false, true]) test(`custom native tools reach the wire unchanged (${stream ? 'streaming' : 'nonstreaming'})`, async () => {
  const f = fixture('custom', { account: { enabled: true, status: 'active' }, provider: { type: 'custom' } })
  const request = { model: 'display-model', messages: [{ role: 'user', content: 'Call fixture_echo' }], tools: nativeTools,
    tool_choice: { type: 'function', function: { name: 'fixture_echo' } }, parallel_tool_calls: false, stream }
  const original = JSON.stringify(request)
  const result = await f.forwarder.forwardChatCompletion(request, f.account(), f.provider(), 'actual-model', {})
  assert.equal(result.success, true)
  assert.equal(f.captured.length, 1)
  assert.deepEqual(plain(f.captured[0].config.data), { ...request, model: 'actual-model' })
  assert.equal(JSON.stringify(request), original)
  assert.doesNotMatch(JSON.stringify(f.captured[0].config.data), /CHAT2API|Available Tools/)
})

test('a custom API is never treated as a website even if a built-in matcher accepts its ID/domain', async () => {
  const f = fixture('deepseek', { account: { enabled: true, status: 'active' }, provider: { type: 'custom' } })
  assert.equal(f.forwarder.supportsConversation(f.provider()), false)
  assert.equal(f.forwarder.conversationKind(f.provider()), undefined)
  const result = await f.forwarder.forwardChatCompletion({ model: 'fixture', tools: nativeTools, messages: [{ role: 'user', content: 'fixture' }] },
    f.account(), f.provider(), 'fixture', {})
  assert.equal(result.success, true)
  assert.ok(f.captured[0].config, 'generic Axios path rather than website adapter')
  assert.equal(f.captured[0].id, undefined)
})

test('native tool failures never retry uncertain submissions and preserve status', async () => {
  const f = fixture('custom', { account: { enabled: true, status: 'active' }, provider: { type: 'custom' },
    custom: async () => ({ status: 429, headers: {}, data: { error: { message: 'fixture rate limit' } } }) })
  const result = await f.forwarder.forwardChatCompletion({ model: 'fixture', messages: [{ role: 'user', content: 'fixture' }], tools: nativeTools },
    f.account(), f.provider(), 'fixture', {})
  assert.equal(result.status, 429)
  assert.equal(f.captured.length, 1)
})

test('native tool-result history and call IDs remain intact with context management enabled', async () => {
  const f = fixture('custom', { account: { enabled: true, status: 'active' }, provider: { type: 'custom' } })
  const messages = [{ role: 'user', content: 'fixture' }, { role: 'assistant', content: null,
    tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: 'fixture_echo', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'fixture-call', content: 'OK' }]
  const result = await f.forwarder.forwardChatCompletion({ model: 'fixture', messages }, f.account(), f.provider(), 'fixture', {})
  assert.equal(result.success, true)
  assert.equal(f.captured.length, 1)
  assert.deepEqual(plain(f.captured[0].config.data.messages), messages)
})

for (const [status, code] of [[401, 'authentication_required'], [403, 'access_denied'], [404, 'model_unavailable'],
  [429, 'rate_limited'], [500, 'upstream_error'], [302, 'upstream_error']]) test(`custom HTTP ${status} exposes only safe status/retry metadata and closes unread streams`, async () => {
  for (const stream of [false, true]) {
    const raw = stream ? new PassThrough() : { error: { message: 'fixture-private-api-key-echo' } }
    const f = fixture('custom', { account: { enabled: true, status: 'active' }, provider: { type: 'custom' },
      custom: async () => ({ status, headers: { 'retry-after': '60', 'set-cookie': 'fixture-private-cookie' }, data: raw }) })
    const result = await f.forwarder.forwardChatCompletion({ model: 'fixture', messages: [{ role: 'user', content: 'fixture' }], tools: nativeTools, stream },
      f.account(), f.provider(), 'fixture', {})
    assert.equal(result.success, false)
    assert.equal(result.status, status === 302 ? 502 : status)
    assert.equal(result.errorCode, code)
    assert.deepEqual(plain(result.headers), { 'retry-after': '60' })
    assert.equal(f.captured[0].config.maxRedirects, 0)
    assert.doesNotMatch(JSON.stringify(result), /fixture-private/)
    assert.equal(f.captured.length, 1)
    if (stream) assert.equal(raw.destroyed, true)
  }
})

test('custom transport exceptions and forged retry headers never export API keys', async () => {
  for (const throwError of [true, false]) {
    const f = fixture('custom', { account: { enabled: true, status: 'active' }, provider: { type: 'custom' }, custom: async () => {
      if (throwError) throw new Error('fixture-private-api-key')
      return { status: 500, headers: { 'retry-after': 'fixture-private-api-key' }, data: 'fixture-private-api-key' }
    } })
    const result = await f.forwarder.forwardChatCompletion({ model: 'fixture', messages: [{ role: 'user', content: 'fixture' }], tools: nativeTools },
      f.account(), f.provider(), 'fixture', {})
    assert.equal(result.errorCode, 'upstream_error')
    assert.equal(result.headers, undefined)
    assert.doesNotMatch(JSON.stringify(result), /fixture-private/)
    assert.equal(f.captured.length, 1)
  }
})

test('custom chat uses the same normalized URL and newest API key as model lookup', async () => {
  const f = fixture('custom', { provider: { type: 'custom', apiEndpoint: ' https://fixture.invalid/v1/chat/completions ' },
    account: { enabled: true, status: 'active', credentials: { apiKey: ' fixture-new-key ', token: 'fixture-old-key' } } })
  const result = await f.forwarder.forwardChatCompletion({ model: 'fixture', messages: [{ role: 'user', content: 'fixture' }], tools: nativeTools },
    f.account(), f.provider(), 'fixture', {})
  assert.equal(result.success, true)
  assert.equal(f.captured[0].config.url, 'https://fixture.invalid/v1/chat/completions')
  assert.equal(f.captured[0].config.headers.Authorization, 'Bearer fixture-new-key')
  assert.equal(f.captured[0].config.headers['Content-Type'], 'application/json')
  assert.equal(f.captured[0].config.headers.Accept, 'application/json')
})

test('custom no-key APIs omit Authorization while invalid headers/credentials never submit', async () => {
  for (const [label, provider, credentials, expected] of [
    ['no key service', { credentialFields: [{ name: 'apiKey', required: false }] }, {}, true],
    ['required missing key', {}, {}, false],
    ['newline credential', {}, { apiKey: 'fixture\r\nforged' }, false],
    ['duplicate lowercase authorization', { headers: { authorization: 'fixture-untrusted' } }, { apiKey: 'fixture-key' }, false],
  ]) {
    const f = fixture('custom', { provider: { type: 'custom', ...provider }, account: { enabled: true, status: 'active', credentials } })
    const result = await f.forwarder.forwardChatCompletion({ model: 'fixture', messages: [{ role: 'user', content: 'fixture' }], tools: nativeTools },
      f.account(), f.provider(), 'fixture', {})
    assert.equal(result.success, expected, label)
    assert.equal(f.captured.length, expected ? 1 : 0, label)
    if (expected) assert.equal(f.captured[0].config.headers.Authorization, undefined)
    assert.doesNotMatch(JSON.stringify(result), /fixture-key|fixture-untrusted|forged/)
  }
})
