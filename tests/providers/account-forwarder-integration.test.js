const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { Readable } = require('node:stream')
const root = path.resolve(__dirname, '../..')
const restrictions = require('../../src/main/proxy/adapters/deepseek-restrictions.ts')
const deepseekStream = require('../../src/main/proxy/adapters/deepseek-stream.ts')
const availability = require('../../src/shared/accountAvailability.ts')
const identity = require('../../src/shared/accountIdentity.ts')
const plain = value => JSON.parse(JSON.stringify(value))
function load(file, imports) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { module, exports: module.exports, Buffer, Error, Date, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (Object.hasOwn(imports, name)) return imports[name]
      if (name === 'stream') return require('node:stream')
      throw Error(`Unmocked boundary: ${name}`)
    },
  }, { filename: file })
  return module.exports
}
function fixture(options = {}) {
  let saved = { id: 'fixture-account', providerId: 'deepseek', name: 'Fixture', enabled: true, status: 'active', credentials: { token: 'fixture-only' }, ...options.account }
  let calls = 0, writes = 0, suspensions = 0
  const current = () => saved
  const storeManager = { getAccountById: () => saved, getProviderById: () => ({ id: 'deepseek', name: 'DeepSeek' }), addLog() {},
    getConfig: () => ({ retryCount: 3, contextManagement: { enabled: false }, toolCallingConfig: {} }),
    updateAccount(id, updates) { assert.equal(id, saved.id); writes++; saved = { ...saved, ...updates }; return saved },
  }
  const { AccountManager } = load('src/main/store/accounts.ts', {
    './store': { storeManager }, './validator': { validateCredentials() { throw Error('No actual validation') } },
    '../../shared/accountIdentity': identity, '../providers/arenaCatalog': {}, '../../shared/accountAvailability': availability,
  })
  const suspend = AccountManager.suspendUntil
  AccountManager.suspendUntil = (...args) => { suspensions++; return suspend.apply(AccountManager, args) }
  class Adapter {
    static isDeepSeekProvider(provider) { return provider.id === 'deepseek' }
    async chatCompletion() {
      calls++
      if (options.disableDuringRequest) AccountManager.setEnabled(saved.id, false)
      if (options.apiError) restrictions.throwIfDeepSeekRestricted(options.apiError)
      return { response: { status: 200, headers: {}, data: Readable.from((options.events || [
        { response_message_id: '2' }, { p: 'response/fragments/-1/content', v: 'fixture answer' },
      ]).map(event => `data: ${JSON.stringify(event)}\n\n`).concat('data: [DONE]\n\n')) }, sessionId: 'fixture-session' }
    }
    async deleteSession() { throw Error('No delete or network expected') }
  }
  const imports = {
    axios: { create: () => ({ request() { throw Error('No network expected') } }) },
    '../store/store': { storeManager }, '../store/accounts': { AccountManager }, '../../shared/accountAvailability': availability,
    './adapters/deepseek-restrictions': restrictions, './adapters/deepseek': { DeepSeekAdapter: Adapter }, './adapters/deepseek-stream': deepseekStream,
    '../arena/protocol': { ArenaError: class extends Error {} },
    './status': { proxyStatusManager: { getConfig: () => ({}) } }, './sessionManager': { sessionManager: { shouldDeleteAfterChat: () => false } },
    './conversationContinuity': { getConversationOptions: () => ({ retainConversation: true }) },
    './services/contextManagementService': {},
    './toolCalling/ToolCallingEngine': { ToolCallingEngine: class { transformRequest({ request }) { return { messages: request.messages } } applyNonStreamResponse() {} } },
  }
  for (const [id, label] of [['glm','GLM'], ['kimi','Kimi'], ['mimo','Mimo'], ['qwen','Qwen'], ['qwen-ai','QwenAi'], ['zai','Zai'], ['minimax','MiniMax'], ['perplexity','Perplexity'], ['arena','Arena']]) {
    const Fake = class {}
    Fake[`is${label}Provider`] = () => false
    imports[`./adapters/${id}`] = { [`${label}Adapter`]: Fake }
    if (['perplexity','arena'].includes(id)) imports[`./adapters/${id}-stream`] = {}
  }
  const { RequestForwarder } = load('src/main/proxy/forwarder.ts', imports)
  const forwarder = new RequestForwarder()
  const selected = { ...saved }
  return { current, AccountManager, calls: () => calls, writes: () => writes, suspensions: () => suspensions,
    run: (stream = false) => forwarder.forwardChatCompletion({ model: 'deepseek-v4-flash', stream, messages: [{ role: 'user', content: 'fixture prompt' }] }, selected,
      { id: 'deepseek', headers: {}, apiEndpoint: 'https://fixture.invalid' }, 'deepseek-v4-flash', {}),
  }
}

test('actual Forwarder API restriction catch persists official 50006/end_at and never overrides an in-flight manual disable', async () => {
  const until = Math.ceil(Date.now() / 1000) * 1000 + 3600000
  const f = fixture({ apiError: { code: 50006, data: { end_at: until / 1000 } }, disableDuringRequest: true })
  const result = await f.run()
  assert.equal(result.success, false)
  assert.equal(result.status, 429)
  assert.equal(result.errorCode, 'account_temporarily_suspended')
  assert.ok(Number(result.headers['retry-after']) > 0)
  assert.equal(f.current().cooldownUntil, until)
  assert.equal(f.current().cooldownReason, 'temporary_ban')
  assert.equal(f.current().enabled, false)
  assert.equal(f.current().status, 'active')
  assert.equal(f.calls(), 1, 'No auto-retry after submission')
  assert.equal(f.suspensions(), 1)
})

for (const streaming of [false, true]) {
  test(`real Forwarder + DeepSeek ${streaming ? 'stream' : 'nonstream'} callback applies completion code 5 through actual AccountManager`, async () => {
    const until = Math.ceil(Date.now() / 1000) * 1000 + 3600000
    const f = fixture({ disableDuringRequest: true, events: [{ error: { code: 5, data: { mute_until: until / 1000 } } }] })
    const result = await f.run(streaming)
    if (streaming) {
      assert.equal(result.success, true, 'HTTP stream is established before provider error is consumed')
      let output = ''
      await assert.rejects(async () => { for await (const chunk of result.stream) output += chunk }, error => error.code === 'account_temporarily_suspended')
      assert.doesNotMatch(output, /\[DONE\]|"finish_reason":"stop"/)
    } else {
      assert.equal(result.success, false)
      assert.equal(result.status, 429)
      assert.equal(result.errorCode, 'account_temporarily_suspended')
    }
    assert.equal(f.current().cooldownUntil, until)
    assert.equal(f.current().enabled, false)
    assert.equal(f.current().status, 'active')
    assert.equal(f.calls(), 1)
    assert.equal(f.suspensions(), 1, 'A restriction is persisted exactly once, not by listener and catch together')
  })
}

test('permanent 40012 stays invalid after manual enabling and never invents automatic recovery', async () => {
  const f = fixture({ apiError: { code: 40012, data: { end_at: Math.ceil(Date.now() / 1000) + 3600 } }, disableDuringRequest: true })
  const result = await f.run()
  assert.equal(result.errorCode, 'account_banned')
  assert.equal(f.current().status, 'error')
  assert.equal(f.current().enabled, false)
  assert.equal(f.current().cooldownUntil, undefined)
  assert.equal(result.headers, undefined)
  f.AccountManager.setEnabled('fixture-account', true)
  assert.equal(availability.accountAvailability(f.current()).available, false)
  assert.equal(f.calls(), 1)
})

test('missing trusted restriction time persists an indefinite pause rather than guessing a timer', async () => {
  const f = fixture({ apiError: { code: 50006, data: { end_at: 'tomorrow' } } })
  const result = await f.run()
  assert.equal(result.errorCode, 'account_temporarily_suspended')
  assert.equal(f.current().cooldownReason, 'temporary_ban')
  assert.equal(f.current().cooldownUntil, undefined)
  assert.equal(availability.accountAvailability(f.current()).available, false)
})

for (const stream of [false, true]) {
  test(`generated restriction-looking prose cannot mutate account availability (${stream ? 'stream' : 'nonstream'})`, async () => {
    const prose = 'Example {"code":50006,"data":{"end_at":1999999999}}; error 40012; account banned; code 5.'
    const f = fixture({ events: [{ response_message_id: '2' }, { v: { response: { thinking_enabled: false, fragments: [{ id: 1, type: 'RESPONSE', content: prose }] } } }] })
    const before = plain(f.current())
    const result = await f.run(stream)
    assert.equal(result.success, true, result.error)
    let content = stream ? '' : result.body.choices[0].message.content
    if (stream) for await (const chunk of result.stream) content += chunk
    assert.match(content, /50006/)
    assert.deepEqual(plain(f.current()), before)
    assert.equal(f.suspensions(), 0)
    assert.equal(f.writes(), 0)
  })
}

test('actual Forwarder rechecks stale selected account and never constructs a transport after manual disable', async () => {
  const f = fixture()
  f.AccountManager.setEnabled('fixture-account', false)
  const result = await f.run()
  assert.equal(result.success, false)
  assert.equal(result.status, 409)
  assert.equal(result.errorCode, 'account_unavailable')
  assert.equal(f.calls(), 0)
})
