const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
function load(file, mocks = {}, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { module, exports: module.exports, Date,
    console: { log() {}, error() {} },
    require(name) { assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency ${name}`); return mocks[name] },
    ...globals,
  }, { filename: file })
  return module.exports
}
function fixture(initial = [], clock = 2000000000000) {
  let now = clock, serial = 0, decryptions = 0, writes = 0
  const timers = new Map(), notifications = []
  const Clock = class extends Date { static now() { return now } }
  const availability = load('src/shared/accountAvailability.ts', {}, { Date: Clock })
  const identity = load('src/shared/accountIdentity.ts')
  const store = load('src/main/store/store.ts', {
    electron: {}, os: { homedir() { throw Error('No actual profile access') } }, path: {}, './types': {},
    '../data/builtin-prompts': {}, '../requestLogs/manager': {}, '../requestLogs/types': {}, '../../shared/toolCalling': {}, '../appLogs/manager': {},
    '../../shared/accountIdentity': identity, '../providers/arenaCatalog': {}, '../../shared/accountAvailability': availability,
    'node:timers': { setTimeout(callback, delay) { const handle = { unref() {} }; timers.set(handle, { callback, at: now + delay }); return handle }, clearTimeout(handle) { timers.delete(handle) } },
  }, { Date: Clock }).storeManager
  let data = { accounts: plain(initial), providers: [{ id: 'deepseek', name: 'DeepSeek', enabled: true }] }
  store.store = { get: key => data[key], set: (key, value) => { writes++; data = { ...data, [key]: value } } }
  store.isInitialized = true
  store.encryptCredentials = input => ({ token: `encrypted:${input.token}` })
  store.decryptCredentials = input => { decryptions++; return { token: input.token?.replace(/^encrypted:/, '') } }
  store.generateId = () => `account-${++serial}`
  store.addLog = () => {}
  store.setMainWindow({ isDestroyed: () => false, webContents: { send: (...args) => notifications.push(args) } })
  let validation = { valid: true }
  const { AccountManager } = load('src/main/store/accounts.ts', {
    './store': { storeManager: store }, './validator': { validateCredentials: async () => validation },
    '../../shared/accountIdentity': identity, '../providers/arenaCatalog': {}, '../../shared/accountAvailability': availability,
  }, { Date: Clock })
  store.refreshAccountAvailability()
  return { store, AccountManager, availability, timers, notifications,
    data: () => data, decryptions: () => decryptions, writes: () => writes,
    validation: value => { validation = value },
    advance(value, tick = true) { now = value; if (tick) for (const [handle, timer] of [...timers]) if (timer.at <= now) { timers.delete(handle); timer.callback() } },
    now: () => now,
  }
}
const account = overrides => ({ id: 'a', providerId: 'deepseek', name: 'Fixture', credentials: { token: 'encrypted:fixture-only' }, status: 'active', createdAt: 1, updatedAt: 1, ...overrides })

test('one pure availability rule keeps manual switch, auth validity, cooldown and daily usage independent', () => {
  const { accountAvailability } = fixture().availability
  const baseline = Object.freeze(account())
  assert.deepEqual(plain(accountAvailability(baseline)), { available: true, reason: 'ready' })
  for (const [overrides, reason] of [
    [{ enabled: false }, 'disabled'], [{ enabled: null }, 'disabled'], [{ status: 'expired' }, 'expired'], [{ status: 'error' }, 'error'],
    [{ status: 'inactive' }, 'inactive'], [{ cooldownReason: 'temporary_ban' }, 'cooldown'],
    [{ cooldownUntil: 2000000000001 }, 'cooldown'], [{ cooldownUntil: NaN }, 'cooldown'], [{ dailyLimit: 5, todayUsed: 5 }, 'daily_limit'],
  ]) assert.equal(accountAvailability({ ...baseline, ...overrides }).reason, reason)
  assert.equal(accountAvailability({ ...baseline, cooldownUntil: 2000000000000 }).available, true)
  assert.equal(accountAvailability({ ...baseline, enabled: false, status: 'error', cooldownUntil: 2000000000001 }).reason, 'disabled')
  assert.equal(baseline.enabled, undefined)
})

test('manual disable survives credentials validation/refresh and automatic suspension expiry', async () => {
  const f = fixture([account()]), now = f.now()
  f.AccountManager.setEnabled('a', false)
  f.AccountManager.suspendUntil('a', now + 1000)
  await f.AccountManager.validate('a')
  f.AccountManager.update('a', { credentials: { token: 'updated-fixture' }, status: 'active' })
  assert.equal(f.AccountManager.isAvailable('a'), false)
  assert.equal(f.data().accounts[0].enabled, false)
  assert.equal(f.data().accounts[0].cooldownUntil, now + 1000)
  f.advance(now + 1000)
  assert.equal(f.data().accounts[0].cooldownReason, undefined)
  assert.equal(f.data().accounts[0].enabled, false)
  assert.equal(f.AccountManager.isAvailable('a'), false)
  f.AccountManager.setEnabled('a', true)
  assert.equal(f.AccountManager.isAvailable('a'), true)
})

test('cooldown expiry and restart recover scheduling but never expired/error credential states', () => {
  const now = 2000000000000
  const initial = ['active', 'expired', 'error'].map((status, index) => account({ id: String(index), status, cooldownReason: 'temporary_ban', cooldownUntil: now + 100 }))
  const f = fixture(initial, now)
  assert.equal(f.timers.size, 1)
  const original = f.data().accounts
  const before = f.decryptions()
  f.advance(now + 100)
  assert.equal(f.decryptions(), before, 'Timer must not decrypt credentials')
  assert.equal(f.AccountManager.isAvailable('0'), true)
  assert.equal(f.AccountManager.isAvailable('1'), false)
  assert.equal(f.AccountManager.isAvailable('2'), false)
  assert.equal(original[0].cooldownUntil, now + 100, 'No snapshot mutation')
  assert.deepEqual(f.notifications, [['accounts:changed']])
  const restarted = fixture(initial, now + 100)
  assert.equal(restarted.AccountManager.getAvailable().length, 1)
  assert.equal(restarted.data().accounts[1].status, 'expired')
  assert.equal(restarted.data().accounts[2].status, 'error')
  assert.equal(restarted.timers.size, 0)
})

test('lazy access expires holds if timers have not fired and broadcasts only state changes', () => {
  const f = fixture([account({ cooldownReason: 'temporary_ban', cooldownUntil: 2000000000010 })])
  f.advance(f.now() + 10, false)
  assert.equal(f.AccountManager.getByProviderId('deepseek')[0].cooldownUntil, undefined)
  assert.equal(f.AccountManager.isAvailable('a'), true)
  const writes = f.writes()
  f.AccountManager.getAll(); f.AccountManager.getActive(); f.AccountManager.getById('a')
  assert.equal(f.writes(), writes)
  assert.deepEqual(f.notifications, [['accounts:changed']])
})

test('indefinite suspension needs explicit release; shorter reports and manual enabling cannot clear it', () => {
  const f = fixture([account({ enabled: false, status: 'error' })]), now = f.now()
  f.AccountManager.suspendUntil('a', now + 1000)
  f.AccountManager.suspendUntil('a', now + 100)
  assert.equal(f.data().accounts[0].cooldownUntil, now + 1000)
  f.AccountManager.suspendUntil('a', undefined)
  f.AccountManager.suspendUntil('a', now + 2000)
  assert.equal(f.data().accounts[0].cooldownUntil, undefined)
  assert.equal(f.data().accounts[0].cooldownReason, 'temporary_ban')
  assert.equal(f.timers.size, 0)
  f.AccountManager.setEnabled('a', true)
  assert.equal(f.data().accounts[0].cooldownReason, 'temporary_ban')
  f.AccountManager.setEnabled('a', false)
  f.AccountManager.clearSuspension('a')
  assert.equal(f.data().accounts[0].enabled, false)
  assert.equal(f.data().accounts[0].status, 'error')
})

test('invalid switches and suspension times fail before persistent writes; new accounts default enabled', () => {
  const f = fixture([account()]), before = f.writes()
  for (const value of [null, undefined, 0, 'false', {}]) assert.throws(() => f.AccountManager.setEnabled('a', value))
  for (const value of [null, NaN, Infinity, f.now(), f.now() - 1, f.now() + 0.5, 8640000000000001]) assert.throws(() => f.AccountManager.suspendUntil('a', value))
  assert.throws(() => f.AccountManager.suspendUntil('a', f.now() + 100, 'other'))
  assert.throws(() => f.store.updateAccount('a', { enabled: undefined }))
  assert.equal(f.writes(), before)
  assert.equal(f.AccountManager.create({ providerId: 'deepseek', credentials: { token: 'new-fixture' } }).enabled, true)
})

test('actual load balancing excludes disabled/cooling/invalid/daily-limited accounts for every strategy and preference', () => {
  const f = fixture([account({ id: 'disabled', enabled: false }), account({ id: 'cooling', cooldownUntil: 2000000000001 }), account({ id: 'expired', status: 'expired' }), account({ id: 'limited', dailyLimit: 2, todayUsed: 2 }), account({ id: 'ready' })])
  const store = { getProviders: () => [{ id: 'deepseek', name: 'DeepSeek', enabled: true }], getAccountsByProviderId: () => f.store.getAccounts(),
    getEffectiveModels: () => [{ displayName: 'model', actualModelId: 'native' }], getConfig: () => ({}) }
  const { LoadBalancer } = load('src/main/proxy/loadbalancer.ts', {
    '../store/store': { storeManager: store }, './modelMappingResolver': {}, '../../shared/accountAvailability': f.availability,
    '../arena/rateLimit': { getArenaModelAvailability() { throw Error('Non-Arena must not inspect Arena quota') } },
  })
  const balancer = new LoadBalancer()
  for (const strategy of ['round-robin', 'fill-first', 'failover']) for (const preferred of ['disabled', 'cooling', 'expired', 'limited']) {
    assert.equal(balancer.selectAccount('model', strategy, 'deepseek', preferred).account.id, 'ready')
  }
  assert.equal(balancer.getAvailableAccountCount('model'), 1)
  f.AccountManager.setEnabled('ready', false)
  assert.equal(balancer.selectAccount('model'), null)
  assert.deepEqual(plain(balancer.getAvailableModels()), [])
})

test('Arena quota selection is scoped to native model and modality and never disables a whole account', () => {
  const f = fixture(), calls = []
  const store = { getProviders: () => [{ id: 'arena', name: 'Arena', enabled: true }], getAccountsByProviderId: () => [account({ id: 'arena-one', providerId: 'arena' })],
    getEffectiveModels: () => [{ displayName: 'arena/image/Seedream', actualModelId: 'image-native' }, { displayName: 'arena/text/Max', actualModelId: 'text-native' }], getConfig: () => ({}) }
  const { LoadBalancer } = load('src/main/proxy/loadbalancer.ts', {
    '../store/store': { storeManager: store }, './modelMappingResolver': {}, '../../shared/accountAvailability': f.availability,
    '../arena/rateLimit': { getArenaModelAvailability(...args) { calls.push(args); return { available: args[2] === 'text' } } },
  })
  const balancer = new LoadBalancer()
  assert.equal(balancer.selectAccount('arena/image/Seedream'), null)
  assert.equal(balancer.selectAccount('arena/text/Max').account.id, 'arena-one')
  assert.deepEqual(calls, [['arena-one', 'image-native', 'image'], ['arena-one', 'text-native', 'text']])
  assert.equal(f.writes(), 0)
})

test('management account switching validates booleans and explicit suspension release, returning masked credentials', async () => {
  const f = fixture([account({ cooldownReason: 'temporary_ban' })]), routes = new Map()
  const auth = () => {}
  class Router { constructor() { for (const method of ['get', 'put', 'post', 'delete']) this[method] = (path, middleware, handler) => { assert.equal(middleware, auth); routes.set(method + path, handler) } } }
  load('src/main/proxy/routes/management/accounts.ts', { '@koa/router': Router, '../../middleware/managementAuth': { managementAuthMiddleware: auth }, '../../../store/accounts': { default: f.AccountManager, __esModule: true } })
  const ctx = body => ({ params: { id: 'a' }, request: { body }, set() {} })
  for (const enabled of [undefined, null, 'false', 0]) {
    const context = ctx({ enabled }); await routes.get('put/accounts/:id/enabled')(context); assert.equal(context.status, 400)
  }
  const disabled = ctx({ enabled: false }); await routes.get('put/accounts/:id/enabled')(disabled)
  assert.equal(disabled.body.data.enabled, false)
  assert.equal(disabled.body.data.credentials.token, '***')
  assert.equal(disabled.body.data.cooldownReason, 'temporary_ban')
  const unconfirmed = ctx({}); await routes.get('post/accounts/:id/clear-suspension')(unconfirmed); assert.equal(unconfirmed.status, 400)
  const confirmed = ctx({ confirmed: true }); await routes.get('post/accounts/:id/clear-suspension')(confirmed)
  assert.equal(confirmed.body.data.enabled, false)
  assert.equal(confirmed.body.data.cooldownReason, undefined)
})

test('model retry metadata requires only known model limits across all eligible accounts and respects bound identities', () => {
  const f = fixture(), now = f.now()
  let records = [account({ id: 'one' }), account({ id: 'two' })]
  let states = { one: { available: false, reason: 'model_quota', availableAt: now + 1000 }, two: { available: false, reason: 'upstream_cooldown', availableAt: now + 500 } }
  const store = { getProviders: () => [{ id: 'arena', enabled: true }], getAccountsByProviderId: () => records,
    getEffectiveModels: () => [{ displayName: 'arena/image/Test', actualModelId: 'native' }], getConfig: () => ({}) }
  const { LoadBalancer } = load('src/main/proxy/loadbalancer.ts', {
    '../store/store': { storeManager: store }, './modelMappingResolver': {}, '../../shared/accountAvailability': f.availability,
    '../arena/rateLimit': { getArenaModelAvailability: id => states[id] },
  }, { Date: class extends Date { static now() { return now } } })
  const balancer = new LoadBalancer()
  assert.deepEqual(plain(balancer.getModelRateLimit('arena/image/Test')), { availableAt: now + 500 })
  assert.equal(balancer.getModelRateLimit('arena/image/Test', 'arena', 'one').availableAt, now + 1000)
  assert.equal(balancer.getModelRateLimit('arena/image/Test', 'other'), undefined)
  assert.equal(balancer.getModelRateLimit('other'), undefined)
  for (const state of [{ available: true, reason: 'ready' }, { available: false, reason: 'storage_error' }, { available: false, reason: 'uninitialized' }, { available: false, reason: 'model_quota' }, { available: false, reason: 'model_quota', availableAt: now - 1 }]) {
    states = { ...states, two: state }
    assert.equal(balancer.getModelRateLimit('arena/image/Test'), undefined)
  }
  records = [account({ id: 'one', enabled: false })]
  assert.equal(balancer.getModelRateLimit('arena/image/Test'), undefined)
})

test('IPC/UI surfaces expose a dedicated manual switch, no-credential notifications and explicit release confirmation', () => {
  const read = file => fs.readFileSync(path.join(root, file), 'utf8')
  const handlers = read('src/main/ipc/handlers.ts'), preload = read('src/preload/index.ts')
  assert.match(handlers, /ACCOUNTS_SET_ENABLED[\s\S]*?AccountManager\.setEnabled\(id, enabled\)[\s\S]*?getById\(id, false\)/)
  assert.match(preload, /onChanged:[\s\S]*?removeListener\(IpcChannels.ACCOUNTS_CHANGED, listener\)/)
  const control = read('src/renderer/src/components/providers/AccountAvailabilityControl.tsx')
  assert.match(control, /<Switch checked=\{account.enabled !== false\}/)
  assert.match(control, /window.confirm\(t\('accountAvailability.releaseConfirm'\)\)/)
  assert.match(control, /new Date\(account.cooldownUntil\).toLocaleString\(\)/)
  for (const name of ['AccountList', 'AccountDetail']) assert.match(read(`src/renderer/src/components/providers/${name}.tsx`), /<AccountAvailabilityControl account=\{account\}/)
  assert.match(read('src/renderer/src/pages/Providers.tsx'), /unsubscribe\?\.\(\)/)
  for (const language of ['en-US', 'zh-CN']) assert.ok(JSON.parse(read(`src/renderer/src/i18n/locales/${language}.json`)).accountAvailability.staysDisabled)
})
