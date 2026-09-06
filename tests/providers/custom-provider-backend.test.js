const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = join(__dirname, '..', '..')
const plain = value => JSON.parse(JSON.stringify(value))
function load(file, mocks = {}) {
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync(join(root, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(source, { module, exports: module.exports, URL, Date, Set, Object, Error, console,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name === '../../shared/providerNetwork' || name === '../../shared/providerNetwork.ts') return require('../../src/shared/providerNetwork.ts')
      if (name === '../network/providerContext' || name === '../network/providerContext.ts') return require('../../src/main/network/providerContext.ts')
      return require(name)
    },
  }, { filename: file })
  return module.exports
}
const api = load('src/main/providers/customApi.ts')
const provider = (apiEndpoint, optional = false) => ({ id: 'custom-test', type: 'custom', authType: 'token', name: 'Fixture', apiEndpoint, headers: {},
  credentialFields: [{ name: 'apiKey', label: 'API Key', type: 'password', required: !optional }] })
async function fixture(t, handler) {
  const calls = []
  const server = http.createServer((req, res) => { calls.push({ url: req.url, headers: req.headers, method: req.method }); handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return { base: `http://127.0.0.1:${server.address().port}`, calls }
}
function managers(initial = []) {
  let providers = initial
  let accounts = []
  let serial = 0
  const logs = []
  const builtin = { ...provider('https://builtin.invalid/api'), id: 'deepseek', type: 'builtin', name: 'DeepSeek' }
  const storeManager = {
    getProviders: () => providers,
    getProviderById: id => providers.find(p => p.id === id),
    generateId: () => `custom-${++serial}`,
    addProvider: value => { providers = [...providers, value] },
    updateProvider: (id, value) => { providers = providers.map(p => p.id === id ? { ...p, ...value } : p); return providers.find(p => p.id === id) },
    deleteProvider: id => { providers = providers.filter(p => p.id !== id); return true },
    getAccountsByProviderId: id => accounts.filter(a => a.providerId === id),
    deleteAccount: id => { accounts = accounts.filter(a => a.id !== id); return true },
    addLog: (...args) => logs.push(args),
  }
  const { CustomProviderManager: manager } = load('src/main/providers/custom.ts', {
    '../store/store': { storeManager }, '../store/types': { BUILTIN_PROVIDERS: [builtin] }, './customApi': api,
    '../../shared/accountAvailability': require('../../src/shared/accountAvailability.ts'),
  })
  const { ProviderManager } = load('src/main/store/providers.ts', {
    './store': { storeManager }, './types': { BUILTIN_PROVIDERS: [builtin] }, '../providers/custom': { CustomProviderManager: manager },
  })
  return { manager, ProviderManager, getProviders: () => providers, logs, setAccounts: rows => { accounts = rows }, getAccounts: () => accounts }
}

test('custom Base URLs normalize root, versioned prefixes, pasted routes, whitespace and trailing slash consistently', () => {
  for (const [input, expected] of [
    [' https://api.example.test/ ', 'https://api.example.test/v1'],
    ['https://api.example.test/v1/', 'https://api.example.test/v1'],
    ['http://127.0.0.1:1234/openai/v1/chat/completions', 'http://127.0.0.1:1234/openai/v1'],
    ['http://localhost:11434/v1/models', 'http://localhost:11434/v1'],
  ]) assert.equal(api.normalizeCustomApiEndpoint(input), expected)
  assert.equal(api.customApiUrl(provider('https://api.example.test/v1/'), '/models'), 'https://api.example.test/v1/models')
})

test('custom Base URL rejects credentials, query, fragment, non-HTTP protocols and malformed values', () => {
  for (const input of ['', null, {}, 'file:///tmp/models', 'ftp://example.test', 'https://key@example.test/v1', 'https://example.test/v1?api_key=secret', 'https://example.test/#secret']) assert.throws(() => api.normalizeCustomApiEndpoint(input))
})

test('custom provider headers reject secret/auth fields and request smuggling inputs without echoing values', () => {
  for (const name of ['Authorization', 'x-api-key', 'Cookie', 'Proxy-Authorization', 'access_token', 'X-Secret', 'Host', 'Content-Length', 'Connection']) {
    assert.throws(() => api.validateCustomHeaders({ [name]: 'sensitive-fixture-value' }), error => !error.message.includes('sensitive-fixture-value'))
  }
  for (const data of [{ 'bad\rheader': 'x' }, { accept: 'text/plain\r\nx-stuff: value' }, { x: 123 }, [], null]) assert.throws(() => api.validateCustomHeaders(data))
  assert.deepEqual(plain(api.validateCustomHeaders({ 'OpenAI-Organization': 'org-fixture', 'X-Project': 'project-fixture' })), { 'OpenAI-Organization': 'org-fixture', 'X-Project': 'project-fixture' })
})

test('custom request credentials stay out of provider config and no-key is explicit', () => {
  const original = provider('http://localhost:1234/v1')
  assert.throws(() => api.customRequestHeaders(original, {}), /API key/)
  assert.deepEqual(plain(api.customRequestHeaders({ ...original, credentialFields: provider('', true).credentialFields }, {})), { Accept: 'application/json' })
  assert.equal(api.customRequestHeaders(original, { apiKey: ' fixture-secret ' }).Authorization, 'Bearer fixture-secret')
  assert.throws(() => api.customRequestHeaders(original, { apiKey: 'x\r\nHost: bad' }), /format/)
  assert.equal(JSON.stringify(original).includes('fixture-secret'), false)
})

test('model parser uses canonical IDs, deduplicates and handles dangerous object keys as own data', () => {
  const result = api.parseCustomModels({ data: [{ id: 'a', name: 'Display Name' }, { id: 'a' }, { id: '__proto__' }, 'b'] })
  assert.deepEqual(plain(result.supportedModels), ['a', '__proto__', 'b'])
  assert.equal(Object.hasOwn(result.modelMappings, '__proto__'), true)
  assert.equal(result.modelMappings.__proto__, '__proto__')
  for (const input of ['<html>login</html>', {}, { data: {} }, { data: [{ name: 'Not an OpenAI ID' }] }, new Array(10001).fill('a')]) assert.throws(() => api.parseCustomModels(input))
})

test('real local HTTP model fetch sends one GET to versioned route with only supplied fixture credentials', async t => {
  const f = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-native-tools' }, { id: 'fixture-chat' }] })) })
  const catalog = await api.fetchCustomModels(provider(`${f.base}/v1/`), { apiKey: 'fixture-local-key' })
  assert.deepEqual(plain(catalog.supportedModels), ['fixture-native-tools', 'fixture-chat'])
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, '/v1/models')
  assert.equal(f.calls[0].method, 'GET')
  assert.equal(f.calls[0].headers.authorization, 'Bearer fixture-local-key')
})

test('real local no-key model endpoint receives no Authorization header', async t => {
  const f = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"local-chat"}]}') })
  await api.fetchCustomModels(provider(f.base, true), {})
  assert.equal(f.calls[0].headers.authorization, undefined)
  assert.equal(f.calls[0].url, '/v1/models')
})

test('HTTP failures do not leak echoed key/response bodies and redirects are never followed', async t => {
  for (const status of [301, 401, 403, 404, 429, 500]) {
    const f = await fixture(t, (_req, res) => { res.statusCode = status; res.setHeader('Location', '/stolen-key'); res.end('Echo fixture-local-secret') })
    await assert.rejects(api.fetchCustomModels(provider(f.base), { apiKey: 'fixture-local-secret' }), error => !error.message.includes('fixture-local-secret'))
    assert.equal(f.calls.length, 1)
  }
})

test('HTML login page with HTTP 200 is not accepted as a valid credential check', async t => {
  const f = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html>Sign in</html>') })
  await assert.rejects(api.fetchCustomModels(provider(f.base, true)), /model list/)
})

test('custom creation and management API creation share full validation and immutable normalized defaults', () => {
  const { manager, ProviderManager, getProviders } = managers()
  const input = { name: ' My API ', authType: 'token', apiEndpoint: 'http://localhost:1234/', supportedModels: [' model-a ', 'model-a'] }
  const item = manager.create(input)
  assert.equal(item.name, 'My API'); assert.equal(item.apiEndpoint, 'http://localhost:1234/v1')
  assert.equal(item.chatPath, '/chat/completions'); assert.equal(item.credentialFields[0].name, 'apiKey')
  assert.deepEqual(plain(item.supportedModels), ['model-a']); assert.equal(input.name, ' My API ')
  assert.throws(() => ProviderManager.create({ ...input, name: 'my api' }), /already exists/)
  assert.throws(() => ProviderManager.create({ ...input, name: 'Other', headers: { Authorization: 'secret' } }), /Authentication headers/)
  assert.equal(getProviders().length, 1)
})

test('custom edit validates even blank values, cannot mutate identity or inject authentication fields', () => {
  const { manager, ProviderManager } = managers()
  const original = manager.create({ name: 'Custom', authType: 'token', apiEndpoint: 'http://localhost:1234' })
  for (const changes of [{ name: '' }, { apiEndpoint: '' }, { headers: { 'x-api-key': 'secret' } }, { id: 'deepseek' }, { type: 'builtin' }, { createdAt: 1 }, { enabled: 'true' }, { chatPath: '//evil.test' }]) assert.throws(() => ProviderManager.update(original.id, changes))
  const changed = ProviderManager.update(original.id, { name: ' Custom Renamed ', enabled: false, supportedModels: ['new'] })
  assert.equal(changed.name, 'Custom Renamed'); assert.equal(changed.enabled, false)
  assert.equal(original.name, 'Custom'); assert.equal(original.enabled, true)
})

test('custom and builtin channels save separate routes; export/import/duplicate retain only validated proxy settings', () => {
  const { manager, ProviderManager, getProviders } = managers()
  const direct = manager.create({ name: 'Direct channel', authType: 'token', apiEndpoint: 'http://localhost:1234', networkProxyMode: 'none' })
  const proxied = manager.create({ name: 'Proxy channel', authType: 'token', apiEndpoint: 'http://localhost:1234',
    networkProxyMode: 'custom', networkProxyUrl: 'http://LOCALHOST:07890/' })
  assert.equal(proxied.networkProxyUrl, 'http://localhost:7890')
  ProviderManager.update(direct.id, { networkProxyMode: 'system' })
  assert.equal(getProviders().find(p => p.id === proxied.id).networkProxyMode, 'custom')
  const exported = JSON.parse(manager.exportProvider(proxied.id))
  assert.equal(exported.networkProxyMode, 'custom'); assert.equal(exported.networkProxyUrl, 'http://localhost:7890')
  const imported = manager.importProvider(JSON.stringify({ ...exported, name: 'Imported channel' }))
  assert.equal(imported.networkProxyUrl, proxied.networkProxyUrl)
  assert.equal(manager.duplicate(proxied.id).networkProxyMode, 'custom')
  const builtin = manager.create({ id: 'deepseek', type: 'builtin', name: 'Ignored', authType: 'token', apiEndpoint: 'https://ignored.invalid', networkProxyMode: 'none' })
  assert.equal(ProviderManager.update(builtin.id, { networkProxyMode: 'system' }).networkProxyMode, 'system')
  for (const changes of [{ networkProxyMode: 'bad' }, { networkProxyMode: 'custom' }, { networkProxyUrl: 'http://user:SECRET@localhost:7890' }]) {
    assert.throws(() => ProviderManager.update(direct.id, changes), error => !error.message.includes('SECRET'))
  }
  assert.equal(getProviders().find(p => p.id === direct.id).networkProxyMode, 'system')
})

test('reserved built-in IDs and duplicate IDs cannot hijack custom records; built-in additions use trusted config', () => {
  const { manager } = managers()
  const data = { name: 'Fixture', authType: 'token', apiEndpoint: 'http://localhost:1234' }
  assert.throws(() => manager.create({ ...data, id: 'deepseek' }), /reserved/)
  const builtin = manager.create({ ...data, id: 'deepseek', type: 'builtin' })
  assert.equal(builtin.name, 'DeepSeek'); assert.equal(builtin.apiEndpoint, 'https://builtin.invalid/api')
  assert.throws(() => manager.create({ ...data, id: 'not-builtin', type: 'builtin' }), /Unknown/)
})

test('malformed imports and credential metadata are rejected while exports never contain legacy secret headers', () => {
  const legacy = { ...provider('http://localhost:1234'), headers: { Authorization: 'secret-fixture', 'X-Api-Key': 'secret-key', Accept: 'application/json' } }
  const { manager } = managers([legacy])
  const exported = manager.exportProvider(legacy.id)
  assert.equal(exported.includes('secret-'), false)
  for (const json of ['null', '[]', '{}', '{"type":"builtin"}', '{invalid']) assert.throws(() => manager.importProvider(json))
  assert.throws(() => manager.create({ name: 'Bad', authType: 'token', apiEndpoint: 'http://localhost:1234', credentialFields: [{ name: 'apiKey', label: 'API Key', type: 'password', required: 'yes' }] }), /Invalid/)
})

test('model sync chooses only available account, skips disabled accounts, preserves manual models on failure', async t => {
  let status = 200
  const f = await fixture(t, (_req, res) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(status === 200 ? '{"data":[{"id":"remote-model"}]}' : '{"error":"fixture secret"}') })
  const { manager, getProviders, setAccounts } = managers()
  const p = manager.create({ name: 'Sync', authType: 'token', apiEndpoint: f.base, supportedModels: ['manual-model'] })
  setAccounts([
    { id: 'disabled', providerId: p.id, credentials: { apiKey: 'disabled-key' }, enabled: false, status: 'active' },
    { id: 'active', providerId: p.id, credentials: { apiKey: 'active-key' }, enabled: true, status: 'active' },
  ])
  const catalog = await manager.fetchModels(p.id)
  assert.equal(f.calls[0].headers.authorization, 'Bearer active-key')
  assert.deepEqual(plain(catalog.supportedModels), ['manual-model', 'remote-model'])
  status = 500
  await assert.rejects(manager.fetchModels(p.id), /500/)
  assert.deepEqual(plain(getProviders()[0].supportedModels), ['manual-model'])
})

test('deleting a custom provider removes its accounts only, while duplicate copies no credentials', () => {
  const { manager, setAccounts, getAccounts, getProviders } = managers()
  const p = manager.create({ name: 'Delete me', authType: 'token', apiEndpoint: 'http://localhost:1234', supportedModels: ['a'] })
  setAccounts([{ id: 'mine', providerId: p.id, credentials: { apiKey: 'must-not-copy' } }, { id: 'other', providerId: 'elsewhere', credentials: {} }])
  const copy = manager.duplicate(p.id)
  assert.equal(JSON.stringify(copy).includes('must-not-copy'), false)
  assert.equal(manager.delete(p.id), true)
  assert.deepEqual(getAccounts().map(a => a.id), ['other'])
  assert.equal(getProviders().length, 1)
})

test('no-key custom provider can validate credentials via both account and provider check paths', async t => {
  const f = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"no-key-model"}]}') })
  const p = provider(f.base, true)
  const { validateCredentials } = load('src/main/store/validator.ts', {
    '../providers/checker': {}, '../providers/customApi': api,
  })
  const { ProviderChecker } = load('src/main/providers/checker.ts', {
    './builtin': { getBuiltinProvider: () => undefined }, '../arena/browserManager': {}, './arenaCatalog': {}, './arenaIntegration': {}, './customApi': api,
  })
  assert.equal((await validateCredentials(p, {})).valid, true)
  assert.equal((await ProviderChecker.checkAccountToken(p, { credentials: {} })).valid, true)
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls.every(call => call.headers.authorization === undefined), true)
})

test('concurrent endpoint edits discard in-flight model results and never retry keys against the new endpoint', async t => {
  let release
  let arrived
  const seen = new Promise(resolve => { arrived = resolve })
  const f = await fixture(t, (_req, res) => { release = () => { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"old-target-model"}]}') }; arrived() })
  const { manager, setAccounts, getProviders } = managers()
  const p = manager.create({ name: 'Race', authType: 'token', apiEndpoint: f.base, supportedModels: ['manual'] })
  setAccounts([{ id: 'account', providerId: p.id, credentials: { apiKey: 'original-key' }, enabled: true, status: 'active' }])
  const lookup = manager.fetchModels(p.id)
  await seen
  manager.update(p.id, { apiEndpoint: 'http://127.0.0.1:1/v1' })
  release()
  await assert.rejects(lookup, /configuration changed/)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(plain(getProviders()[0].supportedModels), ['manual'])
})

test('concurrent account removal discards successful model lookup without restoring removed credentials', async t => {
  let release
  let arrived
  const seen = new Promise(resolve => { arrived = resolve })
  const f = await fixture(t, (_req, res) => { release = () => { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"new"}]}') }; arrived() })
  const { manager, setAccounts, getAccounts } = managers()
  const p = manager.create({ name: 'RaceAccount', authType: 'token', apiEndpoint: f.base })
  setAccounts([{ id: 'account', providerId: p.id, credentials: { apiKey: 'original-key' }, enabled: true, status: 'active' }])
  const lookup = manager.fetchModels(p.id)
  await seen
  setAccounts([])
  release()
  await assert.rejects(lookup, /Account changed/)
  assert.equal(getAccounts().length, 0)
})


test('successful model sync is additive and preserves manually configured aliases even for upstream ID collisions', async t => {
  const f = await fixture(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"alias"},{"id":"remote-new"}]}') })
  const { manager, getProviders } = managers()
  const p = manager.create({ name: 'Keep manual models', authType: 'token', apiEndpoint: f.base,
    supportedModels: ['manual-only', 'alias'], modelMappings: { 'manual-only': 'private-model', alias: 'actual-upstream-model' },
    credentialFields: provider('', true).credentialFields })
  const catalog = await manager.fetchModels(p.id)
  manager.update(p.id, catalog)
  assert.deepEqual(plain(getProviders()[0].supportedModels), ['manual-only', 'alias', 'remote-new'])
  assert.deepEqual(plain(getProviders()[0].modelMappings), { 'manual-only': 'private-model', alias: 'actual-upstream-model', 'remote-new': 'remote-new' })
})

test('editing the supported model list preserves remaining aliases, adds identity mappings, and removes stale mappings', () => {
  const { manager } = managers()
  const p = manager.create({ name: 'Edit model list', authType: 'token', apiEndpoint: 'http://localhost:1234/v1',
    supportedModels: ['keep-alias', 'remove-me'], modelMappings: { 'keep-alias': 'actual-model', 'remove-me': 'old-target' } })
  const updated = manager.update(p.id, { supportedModels: ['keep-alias', 'new-model'] })
  assert.deepEqual(plain(updated.modelMappings), { 'keep-alias': 'actual-model', 'new-model': 'new-model' })
  const storeSource = readFileSync(join(root, 'src/main/store/store.ts'), 'utf8')
  const code = storeSource.slice(storeSource.indexOf('  getEffectiveModels(providerId:'), storeSource.indexOf('  addCustomModel(providerId:'))
  const moduleSource = ts.transpileModule(`export class EffectiveStore { ${code} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(moduleSource, { module, exports: module.exports, require })
  const store = new module.exports.EffectiveStore()
  store.ensureInitialized = () => {}
  store.getProviderById = () => updated
  store.getProviderModelOverrides = () => ({ excludedModels: [], addedModels: [] })
  assert.deepEqual(plain(store.getEffectiveModels(p.id)), [
    { displayName: 'keep-alias', actualModelId: 'actual-model', isCustom: false },
    { displayName: 'new-model', actualModelId: 'new-model', isCustom: false },
  ])
})

test('model edits made while refresh is in flight are merged from the latest saved values, not revived from stale snapshot', async t => {
  let release
  let arrived
  const seen = new Promise(resolve => { arrived = resolve })
  const f = await fixture(t, (_req, res) => { release = () => { res.setHeader('Content-Type', 'application/json'); res.end('{"data":[{"id":"remote-new"}]}') }; arrived() })
  const { manager } = managers()
  const p = manager.create({ name: 'Concurrent models', authType: 'token', apiEndpoint: f.base,
    supportedModels: ['removed-during-fetch'], credentialFields: provider('', true).credentialFields })
  const lookup = manager.fetchModels(p.id)
  await seen
  manager.update(p.id, { supportedModels: ['added-during-fetch'], modelMappings: { 'added-during-fetch': 'latest-alias' } })
  release()
  const catalog = await lookup
  const updated = manager.update(p.id, catalog)
  assert.deepEqual(plain(updated.supportedModels), ['added-during-fetch', 'remote-new'])
  assert.deepEqual(plain(updated.modelMappings), { 'added-during-fetch': 'latest-alias', 'remote-new': 'remote-new' })
})
