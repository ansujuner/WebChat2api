const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { EventEmitter } = require('node:events')
const root = join(__dirname, '../..')
const profileId = '11111111-1111-4111-8111-111111111111'
const textId = '22222222-2222-4222-8222-222222222222'
const imageId = '33333333-3333-4333-8333-333333333333'
const live = () => ({ source: 'runtime', models: [{ id: textId, name: 'Max', modality: 'text' }, { id: imageId, name: 'Max', modality: 'image' }] })
const expected = () => ({ supportedModels: ['arena/text/Max', 'arena/image/Max'], modelMappings: { 'arena/text/Max': textId, 'arena/image/Max': imageId } })
const plain = value => JSON.parse(JSON.stringify(value))
const catalogPromise = import('../../src/main/providers/arenaCatalog.ts')
function load(file, mocks) {
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync(join(root, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  vm.runInNewContext(source, { module, exports: module.exports, Date, AbortController, setTimeout, clearTimeout,
    console: { log() {}, error() {}, warn() {} }, require(name) {
      if (name.endsWith('/shared/accountAvailability')) return require('../../src/shared/accountAvailability.ts')
      if (name === 'node:timers') return require('node:timers')
      if (name === '../arena/rateLimit') return { getArenaModelAvailability: () => ({ available: true, reason: 'ready' }) }
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (['events', 'node:events', 'node:path', 'path'].includes(name)) return require(name)
      throw new Error(`Isolated Arena fixture forbids unmocked dependency: ${name}`)
    },
  }, { filename: file })
  return module.exports
}
async function integrationFixture(overrides = {}) {
  const calls = [], writes = []
  const browser = {
    status: async id => { calls.push(['status', id]); return { authenticated: true } },
    getModels: async id => { calls.push(['models', id]); return live() },
    ...overrides,
  }
  const module = load('src/main/providers/arenaIntegration.ts', {
    '../arena/browserManager': { arenaBrowserManager: browser }, './arenaCatalog': await catalogPromise,
    '../store/store': { storeManager: {
      getAccountsByProviderId(id, secrets) { calls.push(['accounts', id, secrets]); return [{ status: 'active', credentials: { browserProfileId: profileId } }] },
      ensureProviderExists: id => calls.push(['ensure', id]), updateProvider: (id, value) => writes.push([id, value]),
    } },
  })
  return { ...module, calls, writes }
}

test('Arena public defaults never advertise account capacity; runtime catalog separates same text and image name', async () => {
  const { arenaConfig } = await import('../../src/main/providers/builtin/arena.ts')
  assert.deepEqual(arenaConfig.supportedModels, [])
  assert.deepEqual(arenaConfig.modelMappings, {})
  const { runtimeArenaCatalog } = await catalogPromise
  assert.deepEqual(runtimeArenaCatalog(live()), expected())
  assert.throws(() => runtimeArenaCatalog({ ...live(), source: 'public-snapshot' }), /Public snapshots/)
})

test('Arena catalog drops malformed IDs, wildcards, controls and duplicate names without mutating input', async () => {
  const { runtimeArenaCatalog, savedArenaCatalog } = await catalogPromise
  const input = live()
  input.models.push({ id: textId, name: 'max', modality: 'text' }, { id: 'fake', name: 'Fake', modality: 'text' },
    { id: textId, name: '*', modality: 'text' }, { id: textId, name: 'Bad\nName', modality: 'text' })
  Object.freeze(input.models)
  assert.deepEqual(runtimeArenaCatalog(input), expected())
  assert.equal(input.models.length, 6)
  assert.deepEqual(savedArenaCatalog(['arena/text/Max', '*', 'arena/text/*', 'arena/image/Wrong'],
    { 'arena/text/Max': textId, '*': textId, 'arena/text/*': textId, 'arena/image/Wrong': 'fake' }),
    { supportedModels: ['arena/text/Max'], modelMappings: { 'arena/text/Max': textId } })
  assert.throws(() => runtimeArenaCatalog({ source: 'runtime', models: [] }), /valid runtime models/)
})

test('Arena credentials accept only app profile UUID, never token, cookie or filesystem path', async () => {
  const { arenaProfileCredentials } = await catalogPromise
  assert.deepEqual(arenaProfileCredentials(Object.freeze({ browserProfileId: profileId })), { browserProfileId: profileId })
  for (const value of [null, [], {}, { browserProfileId: '../profile' }, { browserProfileId: 'C:\\Users\\fixture' },
    { browserProfileId: profileId, token: 'fixture' }, { browserProfileId: profileId, cookies: 'fixture' }])
    assert.throws(() => arenaProfileCredentials(value), /only browserProfileId/)
})

test('Arena catalog sync checks signed-in account and live browser before any store write', async () => {
  const f = await integrationFixture()
  assert.deepEqual(plain(await f.syncArenaProviderModels()), expected())
  assert.deepEqual(f.calls, [['accounts', 'arena', true], ['status', profileId], ['models', profileId], ['ensure', 'arena']])
  assert.deepEqual(plain(f.writes), [['arena', expected()]])
})

test('Arena failed login, invalid profile, snapshot catalog and cancellation do not overwrite saved models', async () => {
  for (const overrides of [{ status: async () => ({ authenticated: false }) },
    { getModels: async () => ({ ...live(), source: 'public-snapshot' }) }]) {
    const f = await integrationFixture(overrides)
    await assert.rejects(f.syncArenaProviderModels(profileId)); assert.deepEqual(f.writes, [])
  }
  const invalid = await integrationFixture()
  await assert.rejects(invalid.syncArenaProviderModels('not-a-profile'))
  assert.deepEqual(invalid.calls, [])
  const controller = new AbortController()
  const cancelled = await integrationFixture({ getModels: async () => { controller.abort(); return live() } })
  await assert.rejects(cancelled.syncArenaProviderModels(profileId, controller.signal))
  assert.deepEqual(cancelled.writes, [])
})

async function adapterFixture(overrides = {}) {
  const browser = Object.assign(new EventEmitter(), {
    startLogin: async () => ({ success: true, profileId, accountInfo: { email: 'arena@example.test' } }),
    status: async () => ({ authenticated: true, accountInfo: { email: 'arena@example.test' } }),
    cancel() {}, cancelAndWait: async () => {}, ...overrides,
  })
  const calls = []
  class BaseOAuthAdapter { constructor(config) { this.config = config } emitProgress(...args) { calls.push(['progress', ...args]) } }
  const { ArenaAdapter } = load('src/main/oauth/adapters/arena.ts', {
    './base': { BaseOAuthAdapter }, '../../arena/browserManager': { arenaBrowserManager: browser },
    '../../providers/arenaCatalog': await catalogPromise,
    '../../providers/arenaIntegration': { syncArenaProviderModels: async (id, signal) => { signal.throwIfAborted(); calls.push(['sync', id]) } },
  })
  return { adapter: new ArenaAdapter({ providerId: 'arena' }), browser, calls }
}
test('Arena OAuth returns only profile ID and verified identity after live catalog synchronization', async () => {
  const f = await adapterFixture()
  const result = await f.adapter.startLogin({ providerId: 'arena' })
  assert.equal(result.success, true)
  assert.deepEqual(plain(result.credentials), { browserProfileId: profileId })
  assert.equal(result.accountInfo.email, 'arena@example.test')
  assert.deepEqual(f.calls[0], ['sync', profileId])
  assert.equal(f.browser.listenerCount('status'), 0)
  assert.equal((await f.adapter.validateToken({ browserProfileId: profileId })).valid, true)
  assert.equal((await f.adapter.validateToken({ token: 'fixture' })).valid, false)
})

test('Arena cancelled adapter ignores late browser success and never starts model sync', async () => {
  let finish
  const f = await adapterFixture({ startLogin: () => new Promise(resolve => { finish = resolve }) })
  const pending = f.adapter.startLogin({ providerId: 'arena' })
  await f.adapter.cancelLogin()
  finish({ success: true, profileId })
  assert.equal((await pending).success, false)
  assert.deepEqual(f.calls, [])
  assert.equal(f.browser.listenerCount('status'), 0)
})

async function storeFixture() {
  const types = await import('../../src/main/store/types.ts')
  const arena = types.BUILTIN_PROVIDERS.find(p => p.id === 'arena')
  const catalog = await catalogPromise
  const { storeManager } = load('src/main/store/store.ts', {
    electron: {}, os: { homedir() { throw new Error('No real profiles') } }, './types': types,
    '../data/builtin-prompts': {}, '../requestLogs/manager': {}, '../appLogs/manager': {},
    '../requestLogs/types': { normalizeRequestLogConfig: x => x }, '../../shared/toolCalling': { normalizeToolCallingConfig: x => x },
    '../../shared/accountIdentity': {}, '../providers/arenaCatalog': catalog,
  })
  let data = { providers: [Object.freeze({ ...arena, ...expected() })], userModelOverrides: { arena: { addedModels: [{ displayName: 'arena/text/Fake', actualModelId: textId }], excludedModels: [] } } }
  storeManager.store = { get: key => data[key], set: (key, value) => { data = { ...data, [key]: value } } }
  storeManager.isInitialized = true
  return { storeManager, getData: () => data }
}
test('real startup migration retains validated Arena catalog and excludes unverified custom additions', async () => {
  const f = await storeFixture()
  const old = f.getData().providers[0]
  await f.storeManager.initializeDefaultProviders()
  assert.deepEqual(plain(f.getData().providers[0].supportedModels), expected().supportedModels)
  assert.deepEqual(plain(f.getData().providers[0].modelMappings), expected().modelMappings)
  assert.notEqual(old, f.getData().providers[0])
  assert.throws(() => f.storeManager.addCustomModel('arena', { displayName: 'arena/text/Fake', actualModelId: textId }), /discovered/)
  assert.deepEqual(plain(f.storeManager.resetModels('arena')).map(m => m.displayName), expected().supportedModels)
  assert.deepEqual(plain(f.storeManager.getEffectiveModels('arena')).map(m => m.displayName), expected().supportedModels)
})

test('Arena account storage rejects credential imports on create and update', async () => {
  const writes = []
  const { AccountManager } = load('src/main/store/accounts.ts', {
    './store': { storeManager: { ensureProviderExists() {}, getProviderById: () => ({ id: 'arena', name: 'Arena' }),
      generateId: () => 'fixture-account', addAccount: value => writes.push(value), addLog() {},
      getAccountById: () => ({ id: 'fixture-account', providerId: 'arena' }),
      updateAccount: (id, value) => { writes.push(value); return value },
    } }, './validator': {}, '../../shared/accountIdentity': await import('../../src/shared/accountIdentity.ts'),
    '../providers/arenaCatalog': await catalogPromise,
  })
  const account = AccountManager.create({ providerId: 'arena', credentials: { browserProfileId: profileId }, email: 'arena@example.test' })
  assert.equal(account.name, 'arena@example.test')
  assert.deepEqual(plain(writes[0].credentials), { browserProfileId: profileId })
  assert.throws(() => AccountManager.create({ providerId: 'arena', credentials: { token: 'fake' } }))
  assert.throws(() => AccountManager.update('fixture-account', { credentials: { browserProfileId: profileId, token: 'fake' } }))
  assert.throws(() => AccountManager.update('fixture-account', { providerId: 'deepseek' }))
  assert.equal(writes.length, 1)
})

test('Arena login UI defaults to browser-only, describes profile storage, and exposes refresh-model action', () => {
  for (const name of ['AddProviderDialog', 'AddAccountDialog']) {
    const source = readFileSync(join(root, `src/renderer/src/components/providers/${name}.tsx`), 'utf8')
    assert.match(source, /'arena'\]\s*\.includes/)
    assert.match(source, /setActiveTab\([^\n]*'arena' \? 'oauth' : 'manual'\)/)
    assert.match(source, /!== 'arena' && <TabsTrigger value="manual"/)
    assert.match(source, /arena\.profileOnlyHelp/)
    assert.match(source, /arena\.browserLoginHelp/)
  }
  const card = readFileSync(join(root, 'src/renderer/src/components/providers/ProviderCard.tsx'), 'utf8')
  assert.match(card, /modelsApiEndpoint \|\| provider.id === 'arena'/)
  const page = readFileSync(join(root, 'src/renderer/src/pages/Providers.tsx'), 'utf8')
  assert.match(page, /const currentProviders = await window.electronAPI.providers.getAll\(\)/)
})

test('Arena reserved namespace never falls through to wildcard/custom providers or global aliases', async () => {
  let effective = []
  const provider = { id: 'arena', name: 'Arena', type: 'builtin', enabled: true }
  const storeManager = {
    getProviders: () => [provider, { id: 'custom', enabled: true }],
    getConfig: () => ({ modelMappings: { pretend: { actualModel: 'arena/text/Max', preferredProviderId: 'arena' } } }),
    getEffectiveModels: id => id === 'arena' ? effective : [],
    getAccountsByProviderId: id => [{ id: `fixture-${id}`, providerId: id, status: 'active' }],
  }
  const { LoadBalancer } = load('src/main/proxy/loadbalancer.ts', { '../store/store': { storeManager }, './modelMappingResolver': await import('../../src/main/proxy/modelMappingResolver.ts') })
  const balancer = new LoadBalancer()
  assert.equal(balancer.selectAccount('arena/text/Max'), null)
  assert.equal(balancer.selectAccount('pretend', undefined, 'arena'), null)
  effective = expected().supportedModels.map(displayName => ({ displayName, actualModelId: expected().modelMappings[displayName] }))
  assert.equal(balancer.selectAccount('arena/text/Max').actualModel, textId)
  assert.equal(balancer.selectAccount('arena/image/Max').actualModel, imageId)
  assert.equal(balancer.selectAccount('arena/text/Unknown'), null)
  assert.equal(balancer.selectAccount('arena/text/max'), null)
  assert.equal(balancer.selectAccount('arena/text/Max', undefined, 'custom'), null)
  assert.equal(balancer.selectAccount('pretend', undefined, 'arena'), null)
})

test('Arena OAuth manager selects native browser adapter, cancels catalog phase, and ignores stale results', async () => {
  const requests = [], cancellations = []
  const adapter = { getProviderType: () => 'arena', setProgressCallback() {}, setMainWindow() {},
    startLogin: () => new Promise(resolve => requests.push(resolve)), cancelLogin: async () => { cancellations.push(true) },
  }
  const forbidden = () => { throw new Error('Embedded/external token login forbidden for Arena') }
  const { OAuthManager } = load('src/main/oauth/manager.ts', {
    electron: { shell: {} }, './adapters': { createAdapter: () => adapter },
    './inAppLogin': { inAppLoginManager: { isWindowOpen: () => false, startLogin: forbidden } },
    './externalBrowserLogin': { externalBrowserLoginManager: { isWindowOpen: () => false, startLogin: forbidden } },
    '../arena/browserManager': { arenaBrowserManager: { isWindowOpen: () => false } },
  })
  const manager = new OAuthManager()
  const first = manager.startInAppLogin('arena', 'arena', 2000)
  manager.cancelInAppLogin()
  assert.equal((await first).success, false)
  assert.equal(cancellations.length, 1)
  const second = manager.startInAppLogin('arena', 'arena', 2000)
  requests[0]({ success: true, providerId: 'arena', credentials: { browserProfileId: profileId } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.getStatus(), 'pending')
  requests[1]({ success: true, providerId: 'arena', credentials: { browserProfileId: profileId } })
  assert.equal((await second).success, true)
  assert.equal(manager.getStatus(), 'idle')
})

test('Arena OAuth does not expose raw browser/transport failure details', async () => {
  const f = await adapterFixture({ startLogin: async () => { throw new Error('private-token-fixture path fixture') } })
  const result = await f.adapter.startLogin({ providerId: 'arena' })
  assert.equal(result.success, false)
  assert.doesNotMatch(result.error, /private-token-fixture|path fixture/)
  assert.match(result.error, /verification prompts/)
})
