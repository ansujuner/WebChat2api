const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const Koa = require('koa')
const http = require('node:http')

const root = join(__dirname, '../..')
const typesPromise = import('../../src/main/store/types.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const expected = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

function load(file, mocks) {
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync(join(root, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(source, { module, exports: module.exports, Date,
    console: { log() {}, error() {}, warn() {} },
    require(name) {
      if (name.endsWith('/shared/accountAvailability')) return require('../../src/shared/accountAvailability.ts')
      if (name === 'node:timers') return require('node:timers')
      if (name === '../arena/rateLimit') return { getArenaModelAvailability: () => ({ available: true, reason: 'ready' }) }
      if (Object.hasOwn(mocks, name)) return mocks[name]
      throw new Error(`Isolated catalog fixture forbids unexpected storage or network dependency: ${name}`)
    },
  }, { filename: file })
  return module.exports
}

async function storeFixture(options = {}) {
  const types = await typesPromise
  const { storeManager } = load('src/main/store/store.ts', {
    electron: {}, os: { homedir() { throw new Error('Real user profile access forbidden') } },
    path: require('node:path'), './types': types,
    '../data/builtin-prompts': {}, '../requestLogs/manager': {}, '../appLogs/manager': {},
    '../requestLogs/types': { normalizeRequestLogConfig: value => value },
    '../../shared/toolCalling': { normalizeToolCallingConfig: value => value },
    '../../shared/accountIdentity': {},
    '../providers/arenaCatalog': await import('../../src/main/providers/arenaCatalog.ts'),
  })
  const deepseek = types.BUILTIN_PROVIDERS.find(provider => provider.id === 'deepseek')
  let data = freeze({
    config: { ...plain(types.DEFAULT_CONFIG), modelMappings: plain(types.LEGACY_DEEPSEEK_AUTO_MODEL_MAPPINGS), ...options.config },
    providers: [{ ...plain(deepseek), supportedModels: expected.slice(0, 2),
      modelMappings: Object.fromEntries(expected.slice(0, 2).map(id => [id, id])), createdAt: 1700000000000 },
      { id: 'fixture-custom-provider', type: 'custom', enabled: false, supportedModels: ['leave-me'], modelMappings: { 'leave-me': 'custom-target' } }],
    userModelOverrides: { deepseek: { addedModels: [], excludedModels: [] }, ...options.overrides },
    // Only fixture metadata; no credentials are supplied or decrypted.
    accounts: [{ id: 'fixture-account', providerId: 'deepseek', status: 'active' }],
  })
  const initial = data
  storeManager.store = { get: key => data[key], set: (key, value) => { data = { ...data, [key]: value } } }
  storeManager.isInitialized = true
  storeManager.decryptCredentials = () => { throw new Error('Catalog must not decrypt credentials') }
  storeManager.getStoragePath = () => { throw new Error('Real storage forbidden') }
  storeManager.initializeDefaultModelMappings()
  await storeManager.initializeDefaultProviders()
  return { storeManager, initial, getData: () => data }
}

test('exactly three official DeepSeek IDs share the provider registry and persisted defaults', async () => {
  const types = await typesPromise
  const { deepseekConfig } = await import('../../src/main/providers/builtin/deepseek.ts')
  assert.deepEqual(types.DEEPSEEK_PRIMARY_MODELS, expected)
  assert.equal(types.BUILTIN_PROVIDERS.find(provider => provider.id === 'deepseek'), deepseekConfig)
  assert.deepEqual(deepseekConfig.supportedModels, expected)
  assert.deepEqual(deepseekConfig.modelMappings, Object.fromEntries(expected.map(id => [id, id])))
  assert.deepEqual(types.DEFAULT_CONFIG.modelMappings, {})
})

test('old six generated feature aliases are removed once and never reseeded', async () => {
  const { LEGACY_DEEPSEEK_AUTO_MODEL_MAPPINGS, normalizeModelMappingsWithDefaults } = await typesPromise
  const input = freeze(plain(LEGACY_DEEPSEEK_AUTO_MODEL_MAPPINGS))
  const normalized = normalizeModelMappingsWithDefaults(input)
  assert.deepEqual(normalized, {})
  assert.deepEqual(normalizeModelMappingsWithDefaults(normalized), {})
  assert.equal(Object.keys(input).length, 6)
})

test('migration preserves custom retargeting, account binding, unknown names, and other providers', async () => {
  const { normalizeModelMappingsWithDefaults } = await typesPromise
  const input = freeze({
    'deepseek-v4-flash-search': { requestModel: 'deepseek-v4-flash-search', actualModel: 'custom-upstream', preferredProviderId: 'deepseek' },
    'deepseek-v4-pro-think': { requestModel: 'deepseek-v4-pro-think', actualModel: 'deepseek-v4-pro', preferredProviderId: 'deepseek', preferredAccountId: 'fixture-account' },
    'DeepSeek-R1': { requestModel: 'DeepSeek-R1', actualModel: 'deepseek-reasoner', preferredProviderId: 'fixture-other' },
    'my-fast-model': { requestModel: 'my-fast-model', actualModel: 'deepseek-v4-flash', preferredProviderId: 'deepseek' },
    'glm-custom': { requestModel: 'glm-custom', actualModel: 'GLM-5.3', preferredProviderId: 'glm' },
  })
  const normalized = normalizeModelMappingsWithDefaults(input)
  assert.deepEqual(normalized, input)
  for (const key of Object.keys(input)) assert.notEqual(normalized[key], input[key])
})

test('provider override cleanup removes known duplicates but keeps custom targets and exclusions', async () => {
  const { sanitizeDeepSeekModelOverrides } = await typesPromise
  const input = freeze({ addedModels: [
    ...expected.map(id => ({ displayName: id, actualModelId: id })),
    { displayName: 'deepseek-v4-flash-search', actualModelId: 'deepseek-v4-flash' },
    { displayName: 'DeepSeek-R1', actualModelId: 'deepseek-reasoner' },
    { displayName: 'deepseek-v4-pro-think', actualModelId: 'custom-target' },
    { displayName: 'my-model', actualModelId: 'deepseek-v4-flash' },
  ], excludedModels: ['DeepSeek-R1', 'deepseek-v4-flash', 'deepseek-v4-pro-think', 'my-model', 'other-exclusion'] })
  const normalized = sanitizeDeepSeekModelOverrides(input)
  assert.deepEqual(normalized, { addedModels: input.addedModels.slice(-2),
    excludedModels: ['deepseek-v4-flash', 'deepseek-v4-pro-think', 'my-model', 'other-exclusion'] })
  assert.notEqual(normalized.addedModels[0], input.addedModels.at(-2))
  assert.deepEqual(sanitizeDeepSeekModelOverrides(normalized), normalized)
})

test('actual startup migration persists exactly three models without touching another provider or real profiles', async () => {
  const { storeManager, initial, getData } = await storeFixture({ overrides: {
    'fixture-custom-provider': { addedModels: [{ displayName: 'other-alias', actualModelId: 'other-target' }], excludedModels: ['leave-me'] },
  } })
  assert.deepEqual(plain(storeManager.getEffectiveModels('deepseek')).map(model => model.displayName), expected)
  assert.deepEqual(plain(getData().config.modelMappings), {})
  assert.equal(getData().providers[1], initial.providers[1])
  assert.equal(getData().userModelOverrides['fixture-custom-provider'], initial.userModelOverrides['fixture-custom-provider'])
  assert.equal(initial.providers[0].supportedModels.length, 2)
  assert.equal(Object.keys(initial.config.modelMappings).length, 6)
  storeManager.initializeDefaultModelMappings()
  await storeManager.initializeDefaultProviders()
  assert.deepEqual(plain(storeManager.getEffectiveModels('deepseek')).map(model => model.displayName), expected)
  assert.deepEqual(plain(getData().config.modelMappings), {})
})

test('OpenAI and Anthropic discovery expose only three default DeepSeek entries after real startup migration', async t => {
  const { storeManager } = await storeFixture()
  const router = load('src/main/proxy/routes/models.ts', {
    '../../store/store': { storeManager }, '@koa/router': require('@koa/router'),
    '../modelMappingResolver': await import('../../src/main/proxy/modelMappingResolver.ts'),
  }).default
  const app = new Koa()
  app.use(router.routes())
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const get = (pathname, native = false) => new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: server.address().port, path: pathname,
      headers: native ? { 'anthropic-version': '2023-06-01' } : {},
    }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(body) }) } catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
  })
  for (const native of [false, true]) {
    const list = await get('/v1/models', native)
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.data.map(model => model.id), expected)
    for (const id of expected) assert.equal((await get(`/v1/models/${id}`, native)).status, 200)
    for (const alias of ['deepseek-v4-flash-search', 'deepseek-v4-pro-think', 'DeepSeek-R1']) {
      assert.equal((await get(`/v1/models/${alias}`, native)).status, 404)
    }
  }
})

test('Chinese and English mode labels remain presentation-only and do not alter copied model IDs', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    const data = JSON.parse(readFileSync(join(root, 'src/renderer/src/i18n/locales', `${locale}.json`), 'utf8'))
    assert.deepEqual(Object.keys(data.deepseek.models), expected)
  }
  for (const component of ['ModelEditor', 'ModelList']) {
    const source = readFileSync(join(root, 'src/renderer/src/components/models', `${component}.tsx`), 'utf8')
    assert.match(source, /deepseek\.models\.\$\{model\.displayName\}/)
  }
  const list = readFileSync(join(root, 'src/renderer/src/components/models/ModelList.tsx'), 'utf8')
  assert.match(list, /name: model\.displayName/)
  assert.match(list, /model\.label &&/)
  assert.match(list, /const text = selectedModelNames\.join/)
  assert.match(list, /const text = filteredModels\.map\(m => m\.name\)\.join/)
  assert.match(list, /navigator\.clipboard\.writeText\(text\)/)
})

test('renderer Restore Defaults cannot reintroduce feature aliases or make custom alias names read-only', () => {
  const source = readFileSync(join(root, 'src/renderer/src/components/proxy/ModelMappingConfig.tsx'), 'utf8')
  assert.match(source, /const DEFAULT_MODEL_MAPPINGS: Record<string, ModelMapping> = \{\}/)
  assert.doesNotMatch(source, /deepseek-v4-(?:flash|pro)-(?:think|search)/)
  assert.match(source, /DEFAULT_MODEL_MAPPING_KEYS = new Set\(Object\.keys\(DEFAULT_MODEL_MAPPINGS\)\)/)
})
