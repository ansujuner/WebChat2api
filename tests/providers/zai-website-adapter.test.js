const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { PassThrough } = require('node:stream')
const models = require('../../src/main/proxy/adapters/zai-model-options.ts')

// Execute the production adapter with only the website boundary replaced.
// No stores, credentials, browser profiles, or live network are loaded.
const filename = join(__dirname, '../../src/main/proxy/adapters/zai.ts')
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText
const plain = value => JSON.parse(JSON.stringify(value))
function fixture(options = {}) {
  const calls = [], logs = []
  class ZaiWebsiteChatError extends Error { constructor(code) { super('PRIVATE upstream data'); this.code = code } }
  const account = Object.freeze({ id: 'fixture-account', providerId: 'zai', credentialRevision: 6,
    providerUserId: 'fixture-user', email: 'fixture@example.invalid', enabled: false,
    credentials: Object.freeze({ token: 'PRIVATE fixture token', captcha_verify_param: 'PRIVATE obsolete proof' }), ...options.account })
  const response = { status: 200, headers: { 'content-type': 'text/event-stream' }, data: new PassThrough() }
  const imports = {
    '../../oauth/zaiWebsiteChat': { ZaiWebsiteChatError, runZaiWebsiteChat: async input => {
      calls.push(input)
      if (options.code) throw new ZaiWebsiteChatError(options.code)
      if (options.error) throw options.error
      return { response, chatId: input.conversation?.sessionId ?? 'website-created-chat', requestId: 'website-request' }
    } },
    './zai-model-options.ts': models,
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({
      formatToolResult: ({ toolCallId, content }) => `<tool_result id="${toolCallId}">${content}</tool_result>`,
      formatAssistantToolCalls: value => JSON.stringify(value),
    }) },
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports, Buffer, URLSearchParams,
    console: { log: (...v) => logs.push(v), warn: (...v) => logs.push(v), error: (...v) => logs.push(v) },
    require: name => {
      if (Object.hasOwn(imports, name)) return imports[name]
      if (name.startsWith('.')) return {}
      if (['stream', 'node:string_decoder', 'eventsource-parser'].includes(name)) return require(name)
      assert.fail(`Forbidden transport or dependency: ${name}`)
    },
  })
  const adapter = new module.exports.ZaiAdapter({ id: 'zai' }, account)
  return { adapter, account, calls, logs, response, ZaiWebsiteChatError,
    classify: module.exports.classifyZaiFailure,
    run: (request = {}) => adapter.chatCompletion({ model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: '你好' }], ...request }) }
}

test('one plain turn goes through only its own website identity/session, preserving the account and signal', async () => {
  const f = fixture(), before = plain(f.account), controller = new AbortController()
  const isAccountCurrent = () => true
  const result = await f.run({ proxyMode: 'none', signal: controller.signal, reasoning_effort: false, isAccountCurrent })
  assert.equal(result.response, f.response)
  assert.equal(f.calls.length, 1)
  const input = f.calls[0]
  assert.equal(input.prompt, '你好')
  assert.equal(input.accountId, f.account.id)
  assert.deepEqual(plain(input.expectedIdentity), { userId: 'fixture-user', email: 'fixture@example.invalid' })
  assert.deepEqual(plain(input.credentials), plain(f.account.credentials))
  assert.notEqual(input.credentials, f.account.credentials)
  assert.equal(input.proxyMode, 'none')
  assert.equal(input.signal, controller.signal)
  assert.equal(input.isAccountCurrent, isAccountCurrent)
  assert.doesNotMatch(JSON.stringify(input), /isAccountCurrent/)
  assert.equal(input.model, 'x-preview-l')
  assert.equal(input.thinking, true, 'current Flash requires thinking')
  assert.equal(input.webSearch, false)
  assert.equal(input.conversation, undefined)
  assert.deepEqual(plain(f.account), before, 'no token persistence or credential revision update during chat')
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|fixture-user|example.invalid/)
  f.response.data.destroy()
})

test('verified website conversation cursor reaches the original callback without serializing it as prompt data', async () => {
  const f = fixture(), states = []
  const onConversation = state => states.push(plain(state))
  await f.run({ onConversation })
  assert.equal(f.calls[0].onConversation, onConversation)
  assert.doesNotMatch(JSON.stringify(f.calls[0]), /onConversation/)
  f.calls[0].onConversation({ sessionId: 'website-created-chat', parentMessageId: 'verified-assistant-node' })
  assert.deepEqual(states.at(-1), { sessionId: 'website-created-chat', parentMessageId: 'verified-assistant-node' })
  f.response.data.destroy()
})

test('initial system/history/tool content remains intact; continued tool turn sends only its result', async () => {
  const f = fixture()
  const messages = [{ role: 'system', content: 'First-turn instructions' }, { role: 'user', content: 'Question' },
    { role: 'assistant', content: 'Working on it', tool_calls: [{ id: 'call-a', function: { name: 'weather', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-a', content: 'Sunny' }]
  const before = plain(messages)
  await f.run({ messages })
  for (const text of ['First-turn instructions', 'Question', 'Assistant: Working on it', 'weather', 'call-a', 'Sunny']) {
    assert.ok(f.calls[0].prompt.includes(text), text)
  }
  assert.deepEqual(messages, before)
  const conversation = Object.freeze({ sessionId: 'website-created-chat', parentMessageId: 'actual-assistant' })
  const states = []
  await f.run({ messages: [{ role: 'tool', tool_call_id: 'call-b', content: '25°C' }], conversation,
    onConversation: state => states.push(plain(state)) })
  assert.equal(f.calls[1].prompt, '<tool_result id="call-b">25°C</tool_result>')
  assert.deepEqual(plain(f.calls[1].conversation), conversation)
  assert.deepEqual(states, [conversation])
  assert.doesNotMatch(f.calls[1].prompt, /First-turn|Question|Sunny/)
  f.response.data.destroy()
})

test('search and optional thinking use caller options without rewriting explicit model IDs', async () => {
  const f = fixture()
  await f.run({ model: 'GLM-5.2', web_search: true, reasoning_effort: false })
  assert.equal(f.calls[0].model, 'glm-5.2')
  assert.equal(f.calls[0].webSearch, true)
  assert.equal(f.calls[0].thinking, false)
  await f.run({ model: 'Exact-Case-Model', originalModel: 'Exact-Case-Model-search', reasoning_effort: false })
  assert.equal(f.calls[1].model, 'Exact-Case-Model')
  assert.equal(f.calls[1].webSearch, true)
  f.response.data.destroy()
})

for (const [name, request, category] of [
  ['attachment', { messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,PRIVATE' } }] }] }, 'unsupported_options'],
  ['missing parent', { conversation: { sessionId: 'old-chat' } }, 'invalid_request'],
  ['orphan tool', { messages: [{ role: 'tool', content: 'result' }] }, 'invalid_request'],
  ['empty prompt', { messages: [{ role: 'user', content: '  ' }] }, 'invalid_request'],
  ['changed account', { isAccountCurrent: () => false }, 'account_changed'],
]) test(`${name} is rejected before website submission, not silently dropped`, async () => {
  const f = fixture()
  await assert.rejects(f.run(request), error => error.category === category)
  assert.equal(f.calls.length, 0)
  f.response.data.destroy()
})

for (const [code, category] of [
  ['login_required', 'authentication_required'], ['action_required', 'verification_required'],
  ...['browser_unavailable', 'account_busy', 'model_unavailable', 'unsupported_options', 'account_changed',
    'invalid_request', 'upstream_error', 'incomplete_stream', 'cancelled', 'protocol_mismatch'].map(code => [code, code]),
]) test(`website ${code} is a safe failure without independent HTTP fallback or retry`, async () => {
  const f = fixture({ code })
  await assert.rejects(f.run(), error => error.category === category && !error.message.includes('PRIVATE'))
  const streamError = f.classify(new f.ZaiWebsiteChatError(code), 'transport_error')
  assert.equal(streamError.category, category, 'the same failure after headers retains its safe category')
  assert.doesNotMatch(streamError.message, /PRIVATE/)
  assert.equal(f.calls.length, 1)
  f.response.data.destroy()
})

test('unknown browser errors are sanitized; aborts and disabled deletion never submit a request', async () => {
  const f = fixture({ error: Object.assign(Error('PRIVATE transport failure'), { code: 'login_required' }) })
  await assert.rejects(f.run(), error => error.category === 'transport_error' && !error.message.includes('PRIVATE'))
  assert.equal(f.calls.length, 1)
  const aborted = fixture(), controller = new AbortController()
  controller.abort()
  await assert.rejects(aborted.run({ signal: controller.signal }), error => error.category === 'cancelled')
  assert.equal(await aborted.adapter.deleteChat('user-owned-chat'), false)
  assert.equal(await aborted.adapter.deleteAllChats(), false)
  assert.equal(aborted.calls.length, 0)
  f.response.data.destroy(); aborted.response.data.destroy()
})
