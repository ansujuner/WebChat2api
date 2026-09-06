const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const ts = require('typescript')

const root = join(__dirname, '..', '..')

// Exercise the real adapters while replacing only Electron/network imports.
// No browser profile, credentials, network requests, or paid generations are used.
function load(relativePath, overrides = {}) {
  const fileName = join(root, relativePath)
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  assert.deepEqual(diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error), [])
  const exports = {}
  const context = {
    exports,
    module: { exports },
    require: name => {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      if (name === '../../network/proxy') return { getNetworkSession: async () => ({ fixtureNetworkSession: true }) }
      if (name.startsWith('.')) return {}
      return require(name)
    },
    console: { log() {}, warn() {}, error() {} },
    Buffer,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(outputText, context, { filename: fileName })
  return context.module.exports
}

const qwenAiConfig = load('src/main/providers/builtin/qwen-ai.ts').qwenAiConfig
const qwenConfig = load('src/main/providers/builtin/qwen.ts').qwenConfig
const perplexityConfig = load('src/main/providers/builtin/perplexity.ts').perplexityConfig
const plain = value => JSON.parse(JSON.stringify(value))

test('Domestic Qwen defaults use current modelCode values instead of legacy IDs', () => {
  assert.deepEqual(plain(qwenConfig.supportedModels), [
    'Qwen3.7', 'Qwen3.8-Max', 'Qwen3.7-Max', 'Qwen3.6-Flash',
  ])
  assert.deepEqual(plain(qwenConfig.modelMappings), {
    'Qwen3.7': 'Qwen',
    'Qwen3.8-Max': 'Qwen3.8-Max',
    'Qwen3.7-Max': 'Qwen3.7-Max',
    'Qwen3.6-Flash': 'Qwen3.6-Flash',
  })
})

test('Domestic Qwen sends the selected current model without a thinking-preview substitution', async () => {
  const sent = []
  const { QwenAdapter } = load('src/main/proxy/adapters/qwen.ts', {
    axios: { default: { create: () => ({ post: async (url, payload) => {
      sent.push({ url, payload })
      return { status: 200, data: {}, headers: {} }
    } }) } },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
  })
  const adapter = new QwenAdapter(qwenConfig, { credentials: { ticket: 'fixture-not-a-real-ticket' } })
  for (const model of qwenConfig.supportedModels) {
    await adapter.chatCompletion({ model, enableThinking: true, messages: [{ role: 'user', content: 'fixture' }] })
    assert.equal(sent.at(-1).payload.model, qwenConfig.modelMappings[model])
    assert.equal(sent.at(-1).payload.deep_search, '1')
  }
  await adapter.chatCompletion({
    model: 'Qwen3.8-Max', originalModel: 'alias-think-search',
    enableThinking: false, enableWebSearch: false,
    messages: [{ role: 'user', content: 'fixture' }],
  })
  assert.equal(sent.at(-1).payload.model, 'Qwen3.8-Max')
  assert.equal(sent.at(-1).payload.deep_search, '0')
  assert.equal(sent.at(-1).payload.enable_search, false)
})

test('Qwen Studio defaults exactly match the anonymously verified active web catalog', () => {
  assert.deepEqual(plain(qwenAiConfig.supportedModels), ['Qwen3.7-Plus', 'Qwen3.8-Max'])
  assert.deepEqual(plain(qwenAiConfig.modelMappings), {
    'Qwen3.7-Plus': 'qwen3.7-plus',
    'Qwen3.8-Max': 'qwen3.8-max',
  })
  assert.equal(qwenAiConfig.modelsApiEndpoint, 'https://chat.qwen.ai/api/models')
})

test('Qwen Studio maps current names, preserves explicit mappings, and never upgrades retired exact IDs', () => {
  const { QwenAiAdapter } = load('src/main/proxy/adapters/qwen-ai.ts', {
    axios: { default: { create: () => ({}) } },
  })
  const adapter = new QwenAiAdapter(qwenAiConfig, { credentials: {} })
  assert.equal(adapter.mapModel('Qwen3.7-Plus'), 'qwen3.7-plus')
  assert.equal(adapter.mapModel('Qwen3.8-Max-THINKING'), 'qwen3.8-max')
  assert.equal(adapter.mapModel('qwen'), 'qwen3.7-plus')
  assert.equal(adapter.mapModel('qwen3.8'), 'qwen3.8-max')
  assert.equal(adapter.mapModel('qwen3.7-max'), 'qwen3.7-max')
  assert.equal(adapter.mapModel('qwen3.6-plus'), 'qwen3.6-plus')
  const custom = new QwenAiAdapter({
    ...qwenAiConfig,
    modelMappings: Object.freeze({ qwen: 'account-specific-upstream-id' }),
  }, { credentials: {} })
  assert.equal(custom.mapModel('QWEN-thinking'), 'account-specific-upstream-id')
})

test('Qwen Studio sends the selected current model throughout create-chat and completion payloads', async () => {
  const sent = []
  const client = {
    post: async (url, payload) => {
      sent.push({ url, payload })
      return url.endsWith('/chats/new')
        ? { data: { data: { id: 'fixture-chat-id' } } }
        : { status: 200, data: {}, headers: {} }
    },
  }
  const { QwenAiAdapter } = load('src/main/proxy/adapters/qwen-ai.ts', {
    axios: { default: { create: () => client } },
  })
  const adapter = new QwenAiAdapter(qwenAiConfig, {
    credentials: Object.freeze({ token: 'fixture-token-not-a-real-credential', cookies: 'fixture=1' }),
  })
  for (const [model, expected, thinking] of [
    ['Qwen3.8-Max-THINKING', 'qwen3.8-max', true],
    ['Qwen3.7-Plus-fast', 'qwen3.7-plus', false],
  ]) {
    await adapter.chatCompletion({ model, messages: [{ role: 'user', content: 'fixture' }] })
    const [create, completion] = sent.slice(-2)
    assert.deepEqual(plain(create.payload.models), [expected])
    assert.equal(completion.payload.model, expected)
    assert.deepEqual(plain(completion.payload.messages[0].models), [expected])
    assert.equal(completion.payload.messages[0].feature_config.thinking_enabled, thinking)
  }
})

test('Perplexity catalog matches live Search models and excludes Comet-only and historical entries', () => {
  const { data } = JSON.parse(readFileSync(join(root, 'docs/providers/evidence/perplexity-models-2026-09-06.json'), 'utf8'))
  const rows = data.search_config.filter(row => data.models[row.non_reasoning_model || row.reasoning_model]?.mode === 'search')
  const expected = Object.fromEntries(rows.map(row => [row.label, row.non_reasoning_model || row.reasoning_model]))
  assert.deepEqual(plain(perplexityConfig.supportedModels), ['Best', 'Auto', ...Object.keys(expected)])
  assert.deepEqual(plain(perplexityConfig.modelMappings), { Best: data.default_models.search, Auto: data.default_models.search, ...expected })
  assert.equal(perplexityConfig.modelMappings['Claude Opus 4.8'], undefined)
  assert.equal(perplexityConfig.modelMappings['Claude Sonnet 5'], 'claude50sonnet')
})

test('Perplexity reasoning settings select only exact current Search variants', () => {
  const { resolvePerplexityModel } = load('src/main/proxy/adapters/perplexity.ts', { electron: { net: {} } })
  const { data } = JSON.parse(readFileSync(join(root, 'docs/providers/evidence/perplexity-models-2026-09-06.json'), 'utf8'))
  for (const row of data.search_config) {
    const model = row.non_reasoning_model || row.reasoning_model
    if (data.models[model]?.mode !== 'search') continue
    assert.equal(resolvePerplexityModel(row.label, perplexityConfig.modelMappings), model)
    assert.equal(resolvePerplexityModel(row.label, perplexityConfig.modelMappings, 'high'), row.reasoning_model || model)
  }
  assert.equal(resolvePerplexityModel('Best', perplexityConfig.modelMappings, 'high'), 'turbo')
  assert.equal(resolvePerplexityModel('GPT-5.6 Terra', perplexityConfig.modelMappings, 'max'), 'gpt56_terra_thinking')
})

test('Perplexity validates string and legacy object cookies without mutating credentials', () => {
  const { PerplexityAdapter } = load('src/main/proxy/adapters/perplexity.ts', { electron: { net: {} } })
  for (const cookies of ['example=fixture==; another=value', Object.freeze({ example: 'fixture==', another: 'value' })]) {
    const account = { credentials: Object.freeze({ cookies, sessionToken: 'fixture-session' }) }
    const adapter = new PerplexityAdapter(perplexityConfig, account)
    assert.equal(adapter.buildCookieHeader(), 'example=fixture==; another=value; __Secure-next-auth.session-token=fixture-session')
    if (typeof cookies === 'object') assert.equal(cookies['__Secure-next-auth.session-token'], undefined)
  }
  for (const cookies of ['missing-separator', { invalid: 123 }, { invalid: 'value\r\nnext' }, ['invalid']]) {
    assert.throws(() => new PerplexityAdapter(perplexityConfig, { credentials: { cookies } }), /Perplexity cookies/)
  }
})

test('Perplexity rejects malformed text parts before making a request', async () => {
  const { PerplexityAdapter } = load('src/main/proxy/adapters/perplexity.ts', {
    electron: { net: { request: () => assert.fail('must validate content before sending') } },
  })
  const adapter = new PerplexityAdapter(perplexityConfig, { credentials: {} })
  await assert.rejects(adapter.chatCompletion({
    model: 'Best', messages: [{ role: 'user', content: [{ type: 'text', text: 123 }] }],
  }), /text content parts must contain a string/)
})

test('Perplexity preserves explicit modern web IDs instead of falling back to old model families', () => {
  const { resolvePerplexityModel } = load('src/main/proxy/adapters/perplexity.ts', { electron: { net: {} } })
  for (const model of ['Best', 'Auto', 'auto', 'TURBO']) assert.equal(resolvePerplexityModel(model), 'turbo')
  for (const model of ['account-gpt-5-new-id', 'account-gemini-new-id', 'account-claude-opus-new-id', 'unknown-exact-id']) {
    assert.equal(resolvePerplexityModel(model), model)
  }
  assert.equal(resolvePerplexityModel('My Model', { 'my model': 'account-verified-id' }), 'account-verified-id')
  assert.equal(resolvePerplexityModel('Auto', { Auto: 'auto' }), 'turbo')
})

test('Perplexity transmits exact custom, Best, and current thinking model preferences without downgrade', async () => {
  let sent
  const net = {
    request: () => {
      const request = new EventEmitter()
      request.setHeader = () => {}
      request.write = data => { sent = JSON.parse(data) }
      request.end = () => {
        const response = new EventEmitter()
        response.statusCode = 200
        request.emit('response', response)
        queueMicrotask(() => response.emit('end'))
      }
      return request
    },
  }
  const { PerplexityAdapter } = load('src/main/proxy/adapters/perplexity.ts', { electron: { net } })
  const adapter = new PerplexityAdapter({ modelMappings: { 'My Model': 'account-claude-new-id' } }, {
    id: 'fixture-account', credentials: { sessionToken: 'fixture-not-a-real-session' },
  })
  const result = await adapter.chatCompletion({ model: 'My Model', messages: [{ role: 'user', content: 'fixture' }] })
  assert.equal(sent.params.model_preference, 'account-claude-new-id')
  result.stream.destroy()
  const current = new PerplexityAdapter(perplexityConfig, {
    id: 'fixture-current-account', credentials: { sessionToken: 'fixture-not-a-real-session' },
  })
  for (const [model, effort, expected] of [
    ['Best', undefined, 'turbo'],
    ['Auto', undefined, 'turbo'],
    ['GPT-5.6 Terra', 'high', 'gpt56_terra_thinking'],
    ['Gemini 3.8 Flash', undefined, 'gemini38flash'],
  ]) {
    const response = await current.chatCompletion({
      model, reasoning_effort: effort, messages: [
        { role: 'system', content: [{ type: 'text', text: 'system fixture' }] },
        { role: 'user', content: [null, { type: 'image_url', image_url: {} }, { type: 'text', text: 'fixture' }] },
      ],
    })
    assert.equal(sent.params.model_preference, expected)
    assert.equal(sent.params.mode, 'copilot')
    assert.equal(sent.query_str, 'system fixture\n\n---\n\n[User]: fixture')
    response.stream.destroy()
  }
})
