const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
function load(file, mocks = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { module, exports: module.exports, Date, Buffer,
    console: { log(...args) { assert.doesNotMatch(JSON.stringify(args), /fixture-(?:old|new|replacement|access|extra)/) }, error() {}, warn() {} },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) return {}
      if (['crypto', 'stream', 'path', 'node:timers'].includes(name)) return require(name)
      if (['electron', 'os', 'form-data', 'mime-types', 'eventsource-parser'].includes(name)) return {}
      throw Error(`No real external boundary allowed: ${name}`)
    },
  }, { filename: file })
  return module.exports
}
const credentials = Object.freeze({ refresh_token: 'fixture-old', token: 'fixture-extra', device: 'fixture-extra-device' })
const encrypt = input => Object.fromEntries(Object.entries(input).map(([key, value]) => [key, 'encrypted:' + value]))
function fixture(changes = {}) {
  let writes = 0
  let data = { accounts: [{ id: 'a', providerId: 'glm', name: 'GLM fixture', status: 'active', createdAt: 1, updatedAt: 1, credentials: encrypt(credentials), ...changes }], providers: [{ id: 'glm', name: 'GLM' }] }
  const store = load('src/main/store/store.ts', {
    '../../shared/accountIdentity': require('../../src/shared/accountIdentity.ts'),
    '../../shared/accountAvailability': require('../../src/shared/accountAvailability.ts'),
    'node:timers': { setTimeout() { return { unref() {} } }, clearTimeout() {} },
  }).storeManager
  store.store = { get: key => data[key], set(key, value) { writes++; data = { ...data, [key]: value } } }
  store.isInitialized = true
  store.encryptCredentials = encrypt
  store.decryptCredentials = input => Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value.replace(/^encrypted:/, '')]))
  return { store, data: () => data, writes: () => writes, account: () => store.getAccountById('a', true) }
}

test('normal credential replacements increment revision; metadata edits and caller revisions cannot reset or forge it', () => {
  const f = fixture(), old = f.data().accounts[0]
  assert.equal(f.account().credentialRevision ?? 0, 0)
  f.store.updateAccount('a', { enabled: false, credentialRevision: 999 })
  assert.equal(f.account().credentialRevision, 0)
  f.store.updateAccount('a', { credentials: { ...credentials }, credentialRevision: -4 })
  assert.equal(f.account().credentialRevision, 1, 'Even a deliberate same-value replacement changes the identity revision')
  f.store.updateAccount('a', { credentials: { refresh_token: 'fixture-replacement' }, credentialRevision: 0 })
  assert.equal(f.account().credentialRevision, 2)
  for (const credentialRevision of [undefined, null, NaN, 0, 9000]) f.store.updateAccount('a', { status: 'expired', credentialRevision })
  assert.equal(f.account().credentialRevision, 2)
  assert.equal(f.account().enabled, false)
  assert.equal(old.credentialRevision, undefined)
  assert.deepEqual(old.credentials, encrypt(credentials), 'Previous snapshots remain immutable')
})

test('new account input cannot choose a credential revision and invalid replacements cannot write', () => {
  const f = fixture()
  f.store.addAccount({ ...f.account(), id: 'new', credentialRevision: 123, credentials: { refresh_token: 'fixture-new' } })
  assert.equal(f.data().accounts.find(account => account.id === 'new').credentialRevision, 0)
  const before = f.writes()
  for (const value of [null, [], 'fixture-new', { token: null }, { token: {} }]) assert.throws(() => f.store.updateAccount('a', { credentials: value }))
  assert.equal(f.writes(), before)
  assert.equal(f.account().credentialRevision ?? 0, 0)
  const exhausted = fixture({ credentialRevision: Number.MAX_SAFE_INTEGER })
  assert.throws(() => exhausted.store.updateAccount('a', { credentials: { refresh_token: 'fixture-new' } }), /revision exhausted/)
  assert.equal(exhausted.writes(), 0)
})

test('trusted synchronous rotation preserves revision, other credential fields and all scheduling/auth state', () => {
  const until = Date.now() + 3600000
  const f = fixture({ credentialRevision: 7, enabled: false, status: 'expired', cooldownUntil: until, cooldownReason: 'temporary_ban' })
  const before = plain(f.data())
  const updated = f.store.rotateAccountCredentials('a', credentials, Object.freeze({ refresh_token: 'fixture-new' }))
  assert.equal(updated.credentialRevision, 7)
  assert.deepEqual(plain(updated.credentials), { ...credentials, refresh_token: 'fixture-new' })
  assert.equal(updated.enabled, false)
  assert.equal(updated.status, 'expired')
  assert.equal(updated.cooldownUntil, until)
  assert.deepEqual(f.data().accounts[0].credentials, encrypt({ ...credentials, refresh_token: 'fixture-new' }))
  assert.equal(f.writes(), 1)
  assert.deepEqual(before.accounts[0].credentials, encrypt(credentials))
  assert.equal(credentials.refresh_token, 'fixture-old')
})

test('user replacement beats stale provider rotation, and concurrent rotations with the same expected snapshot write only once', () => {
  const f = fixture()
  const expected = f.account().credentials
  f.store.updateAccount('a', { credentials: { refresh_token: 'fixture-replacement' } })
  assert.equal(f.store.rotateAccountCredentials('a', expected, { refresh_token: 'fixture-new' }), null)
  assert.equal(f.account().credentials.refresh_token, 'fixture-replacement')
  assert.equal(f.account().credentialRevision, 1)
  assert.equal(f.writes(), 1)
  const parallel = fixture()
  assert.ok(parallel.store.rotateAccountCredentials('a', credentials, { refresh_token: 'fixture-new' }))
  assert.equal(parallel.store.rotateAccountCredentials('a', credentials, { refresh_token: 'fixture-replacement' }), null)
  assert.equal(parallel.account().credentials.refresh_token, 'fixture-new')
  assert.equal(parallel.account().credentialRevision, 0)
  assert.equal(parallel.writes(), 1)
})

test('rotation CAS compares complete own credential keys regardless of order and rejects partial/deleted accounts', () => {
  const f = fixture()
  assert.equal(f.store.rotateAccountCredentials('a', { refresh_token: 'fixture-old' }, { refresh_token: 'fixture-new' }), null)
  assert.equal(f.store.rotateAccountCredentials('a', { ...credentials, unexpected: '' }, { refresh_token: 'fixture-new' }), null)
  assert.equal(f.store.rotateAccountCredentials('missing', credentials, { refresh_token: 'fixture-new' }), null)
  const reversed = Object.fromEntries(Object.entries(credentials).reverse())
  assert.ok(f.store.rotateAccountCredentials('a', reversed, { refresh_token: 'fixture-old' }))
  assert.equal(f.writes(), 0, 'Identical trusted refresh does not rewrite encrypted bytes')
  assert.ok(f.store.rotateAccountCredentials('a', reversed, { refresh_token: 'fixture-new' }))
  assert.equal(f.writes(), 1)
})

function glmFixture(options = {}) {
  const f = fixture(options.account), requests = []
  const { GLMAdapter } = load('src/main/proxy/adapters/glm.ts', {
    axios: { async post(url, body, config) {
      assert.match(url, /\/user-api\/user\/refresh$/)
      requests.push({ url, body, authorization: config.headers.Authorization })
      if (options.beforeResponse) await options.beforeResponse(f)
      return { status: 200, data: { code: 0, result: options.response === undefined ? { access_token: 'fixture-access', refresh_token: 'fixture-new' } : options.response } }
    } },
    '../../store/store': { storeManager: f.store },
  })
  const provider = { id: 'glm' }
  return { ...f, requests, adapter: () => new GLMAdapter(provider, f.account()), GLMAdapter, provider }
}

test('actual GLM refresh uses trusted CAS and caches both old and newly rotated refresh tokens without changing identity', async () => {
  const f = glmFixture({ account: { credentialRevision: 3 } })
  const original = f.account()
  const adapter = f.adapter()
  assert.equal(await adapter.acquireToken(), 'fixture-access')
  assert.equal(f.account().credentialRevision, 3)
  assert.deepEqual(f.account().credentials, { ...credentials, refresh_token: 'fixture-new' })
  assert.equal(await adapter.acquireToken(), 'fixture-access')
  assert.equal(await f.adapter().acquireToken(), 'fixture-access', 'New account snapshots hit the new-token cache key')
  assert.equal(await new f.GLMAdapter(f.provider, original).acquireToken(), 'fixture-access')
  assert.equal(f.requests.length, 1)
  assert.equal(f.writes(), 1)
})

test('actual GLM rejects stale in-flight refresh after user replacement and never caches the rejected access token', async () => {
  const f = glmFixture({ beforeResponse(state) { state.store.updateAccount('a', { credentials: { refresh_token: 'fixture-replacement' } }) } })
  const stale = f.adapter()
  await assert.rejects(stale.acquireToken(), /credentials changed during token refresh/)
  await assert.rejects(stale.acquireToken(), /credentials changed during token refresh/)
  assert.equal(f.requests.length, 2, 'Rejected rotation must not seed a cache alias')
  assert.equal(f.account().credentials.refresh_token, 'fixture-replacement')
  assert.equal(f.account().credentialRevision, 2)
  assert.equal(f.writes(), 2, 'Only the simulated user writes persisted')
})

test('two actual concurrent GLM refreshes sharing an expected snapshot permit only one trusted write', async () => {
  let entered = 0, release
  const barrier = new Promise(resolve => { release = resolve })
  const f = glmFixture({ beforeResponse: async () => { if (++entered === 2) release(); await barrier } })
  const responses = await Promise.allSettled([f.adapter().acquireToken(), f.adapter().acquireToken()])
  assert.equal(responses.filter(response => response.status === 'fulfilled').length, 1)
  assert.equal(responses.filter(response => response.status === 'rejected').length, 1)
  assert.equal(f.requests.length, 2)
  assert.equal(f.writes(), 1)
  assert.equal(f.account().credentials.refresh_token, 'fixture-new')
  assert.equal(f.account().credentialRevision, 0)
})

test('actual GLM validates both token strings before writing storage or cache', async () => {
  for (const response of [null, {}, { access_token: 'fixture-access' }, { access_token: '', refresh_token: 'fixture-new' },
    { access_token: 'fixture-access', refresh_token: ' ' }, { access_token: { secret: 'fixture-access' }, refresh_token: 'fixture-new' },
    { access_token: 'fixture-access', refresh_token: 123 }]) {
    const f = glmFixture({ response })
    const adapter = f.adapter()
    for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(adapter.acquireToken(), /invalid token refresh response/)
    assert.equal(f.writes(), 0)
    assert.equal(f.requests.length, 2)
    assert.equal(f.account().credentialRevision ?? 0, 0)
  }
})

test('rotation API is internal only; UI and generic account updates have no trusted rotation bypass', () => {
  for (const file of ['src/preload/index.ts', 'src/renderer/src/types/electron.d.ts', 'src/main/ipc/handlers.ts', 'src/main/proxy/routes/management/accounts.ts']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), /rotateAccountCredentials/)
  }
  const source = fs.readFileSync(path.join(root, 'src/main/proxy/adapters/glm.ts'), 'utf8')
  const acquire = source.slice(source.indexOf('private async acquireToken'), source.indexOf('private isBase64Data'))
  assert.doesNotMatch(acquire, /storeManager\.updateAccount/)
  assert.match(acquire, /tokenCache\.set\(refresh_token, tokenInfo\)/)
})
