const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = join(__dirname, '..', '..')
const plain = value => JSON.parse(JSON.stringify(value))
const identity = require('../../src/shared/accountIdentity.ts')
const availability = require('../../src/shared/accountAvailability.ts')
const loginContract = require('../../src/shared/accountReauthentication.ts')
function load(file, mocks = {}, logs = []) {
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync(join(root, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(source, { module, exports: module.exports, Buffer, URL, Date, Set, Object, Error,
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    require(name) { if (Object.hasOwn(mocks, name)) return mocks[name]; if (name.startsWith('.')) return {}; return require(name) },
  }, { filename: file })
  return module.exports
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(options = {}) {
  const logs = []
  const native = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`cipher:${value}`), decryptString: value => value.toString().slice(7) }
  const { storeManager } = load('src/main/store/store.ts', {
    electron: { safeStorage: native }, '../../shared/accountIdentity': identity, '../../shared/accountAvailability': availability,
    './types': { BUILTIN_PROVIDERS: loginContract.ACCOUNT_LOGIN_PROVIDERS.map(id => load(`src/main/providers/builtin/${id}.ts`).default) },
    '../../shared/providerNetwork': require('../../src/shared/providerNetwork.ts'),
  }, logs)
  const original = { id: 'original-account', providerId: 'zai', name: 'My Original Account', nameSource: 'custom',
    providerUserId: 'website-user', email: 'person@example.test', credentials: { token: 'old-fixture-token' }, credentialRevision: 3,
    status: 'active', enabled: false, cooldownUntil: Date.now() + 3600000, cooldownReason: 'temporary_ban',
    requestCount: 17, todayUsed: 4, dailyLimit: 9, createdAt: 100, updatedAt: 101, ...options.account }
  let data = { accounts: [ { ...original, credentials: storeManager.encryptCredentials(original.credentials) } ],
    providers: [{ id: 'zai', type: 'builtin', apiEndpoint: 'https://chat.z.ai/api', ...options.provider }], config: { oauthProxyMode: 'none' } }
  let writes = 0, reads = 0, notifications = 0, ignored = false
  storeManager.store = {
    get: key => { if (key === 'accounts') reads += 1; return data[key] === undefined ? undefined : plain(data[key]) },
    set: (key, value) => { writes += 1; if (options.failWrites) throw new Error('Disk error with secret token'); if (!ignored) data = { ...data, [key]: plain(value) } },
  }
  storeManager.isInitialized = true
  storeManager.notifyAccountsChanged = () => { notifications += 1 }
  storeManager.getConfig = () => ({ oauthProxyMode: 'none' })
  let authenticate = options.authenticate || (async () => ({ success: true, credentials: { token: 'new-fixture-token', captcha_verify_param: 'never-save-captcha' }, accountInfo: { userId: 'website-user', email: 'person@example.test' } }))
  const calls = [], cleared = [], oauthCalls = [], arenaCalls = [], scopeCalls = []
  const browser = { authenticate: async request => { calls.push(plain(request)); return authenticate(request) }, clearAccount: async id => { cleared.push(id) } }
  const service = load('src/main/oauth/accountReauthentication.ts', {
    '../store/store': { storeManager }, '../../shared/accountIdentity': identity, '../../shared/accountReauthentication': loginContract,
    './zaiAccountBrowser': { zaiAccountBrowserManager: browser },
    '../network/proxy': { getProviderProxyConfig: () => options.proxyConfig || { mode: 'none' }, withProviderNetwork: async (id, task) => { scopeCalls.push(id); return task() } },
    './manager': { oauthManager: {
      validateToken: async (...args) => { oauthCalls.push(['validate', ...plain(args)]); return options.validate ? options.validate() : { valid: true, accountInfo: { userId: 'website-user', email: 'person@example.test' } } },
      startInAppLogin: async (...args) => { oauthCalls.push(['login', ...plain(args)]); return options.login ? options.login() : { ...authenticated('new-fixture-token'), providerId: original.providerId } },
    } },
    '../arena/browserManager': { arenaBrowserManager: {
      reauthenticate: async input => { arenaCalls.push(input); return options.arena ? options.arena(input) : { success: true, profileId: input.profileId, accountInfo: { email: 'person@example.test' } } },
      clearProfile: async id => { cleared.push(id) },
    } },
  }, logs)
  return { ...service, storeManager, original, calls, cleared, logs, oauthCalls, arenaCalls, scopeCalls, setAuthenticate: value => { authenticate = value },
    snapshot: () => plain(data), counts: () => ({ writes, reads, notifications }), ignoreWrites: () => { ignored = true },
    replaceAccount: value => { data = { ...data, accounts: [value] } }, changeProvider: value => { data = { ...data, providers: [value] } } }
}
const authenticated = token => ({ success: true, credentials: { token }, accountInfo: { userId: 'website-user', email: 'person@example.test' } })

test('account-bound login saves to the original ID through actual encrypted store and verifies the stored result', async () => {
  const f = fixture({ account: { status: 'expired', errorMessage: 'old auth failure', credentials: { token: 'old-fixture-token', captcha_verify_param: 'stale-proof', cookies: 'stale-cookie' } } })
  const result = await f.reauthenticateAccount('original-account')
  assert.deepEqual(plain(result), { success: true, accountId: 'original-account', state: 'updated' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].accountId, 'original-account')
  assert.deepEqual(f.calls[0].proxyConfig, { mode: 'none' })
  assert.deepEqual(f.calls[0].expectedIdentity, { userId: 'website-user', email: 'person@example.test' })
  const saved = f.storeManager.getAccountById('original-account', true)
  assert.deepEqual(plain(saved.credentials), { token: 'new-fixture-token' })
  assert.equal(saved.credentialRevision, 4)
  assert.equal(saved.status, 'active'); assert.equal(saved.errorMessage, undefined)
  for (const key of ['id', 'providerId', 'name', 'nameSource', 'enabled', 'cooldownUntil', 'cooldownReason', 'requestCount', 'todayUsed', 'dailyLimit', 'createdAt']) assert.equal(saved[key], f.original[key])
  assert.equal(f.snapshot().accounts.length, 1)
  assert.notEqual(f.snapshot().accounts[0].credentials.token, 'new-fixture-token')
  assert.equal(f.counts().writes, 1)
  assert.equal(f.counts().notifications, 1)
  assert.ok(f.counts().reads >= 4, 'start, CAS, persisted readback and final verification read the real store')
  assert.equal(JSON.stringify(result).includes('token'), false)
  assert.equal(JSON.stringify(result).includes('person@example.test'), false)
  assert.equal(JSON.stringify(f.logs).includes('fixture-token'), false)
})

test('restoring an already valid identical account makes no write and never falsely claims an update', async () => {
  const f = fixture({ authenticate: async () => authenticated('old-fixture-token') })
  const before = f.snapshot()
  assert.equal((await f.reauthenticateAccount('original-account')).state, 'restored')
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.counts().writes, 0)
  assert.equal(f.counts().notifications, 0)
})

test('same token with expired authentication is a real update to active without lifting manual disable or cooldown', async () => {
  const f = fixture({ account: { status: 'error', errorMessage: 'expired' }, authenticate: async () => authenticated('old-fixture-token') })
  assert.equal((await f.reauthenticateAccount('original-account')).state, 'updated')
  const saved = f.storeManager.getAccountById('original-account', true)
  assert.equal(saved.status, 'active'); assert.equal(saved.enabled, false)
  assert.equal(saved.cooldownUntil, f.original.cooldownUntil)
  assert.equal(saved.credentialRevision, 4)
})

test('first verified identity can enrich a legacy record without changing its chosen name', async () => {
  const f = fixture({ account: { email: undefined, providerUserId: undefined }, authenticate: async () => authenticated('old-fixture-token') })
  assert.equal((await f.reauthenticateAccount('original-account')).state, 'updated')
  const saved = f.storeManager.getAccountById('original-account', true)
  assert.equal(saved.name, 'My Original Account'); assert.equal(saved.providerUserId, 'website-user')
  assert.equal(saved.email, 'person@example.test')
})

test('invalid renderer input and unsupported provider never launch a browser or save', async () => {
  const f = fixture()
  for (const input of [null, {}, [], '../other', 'bad\naccount']) assert.equal((await f.reauthenticateAccount(input)).errorCode, 'invalid_account')
  assert.equal((await f.reauthenticateAccount('missing')).errorCode, 'invalid_account')
  const custom = fixture({ provider: { type: 'custom' } })
  assert.equal((await custom.reauthenticateAccount('original-account')).errorCode, 'unsupported_provider')
  assert.equal(f.calls.length, 0); assert.equal(custom.calls.length, 0)
  assert.equal(f.counts().writes, 0)
})

test('missing, guest, mismatched, or incomplete identity cannot overwrite the original account', async () => {
  for (const accountInfo of [{}, { userId: 'other-user', email: 'person@example.test' }, { userId: 'website-user', email: 'other@example.test' },
    { userId: 'website-user' }, { userId: 'website-user', email: 'someone@guest.com' }]) {
    const f = fixture({ authenticate: async () => ({ success: true, credentials: { token: 'new-token' }, accountInfo }) })
    const result = await f.reauthenticateAccount('original-account')
    assert.equal(result.success, false)
    assert.ok(['identity_mismatch', 'identity_unverified'].includes(result.errorCode))
    assert.equal(f.counts().writes, 0)
  }
})

test('malformed browser credentials and upstream prose produce safe fixed failures only', async () => {
  for (const browserResult of [{ success: true, credentials: {}, accountInfo: { userId: 'website-user' } },
    { success: true, credentials: { token: 'secret\r\nHeader:value' }, accountInfo: { userId: 'website-user' } },
    { success: false, errorCode: 'Upstream leaked fixture-private-value', credentials: { token: 'fixture-private-value' } }]) {
    const f = fixture({ authenticate: async () => browserResult })
    const result = await f.reauthenticateAccount('original-account')
    assert.equal(result.success, false); assert.equal(f.counts().writes, 0)
    assert.equal(JSON.stringify(result).includes('fixture-private-value'), false)
  }
  const f = fixture({ authenticate: async () => { throw new Error('Native error with fixture-secret') } })
  assert.equal((await f.reauthenticateAccount('original-account')).errorCode, 'browser_error')
  assert.equal(JSON.stringify(f.logs).includes('fixture-secret'), false)
})

test('duplicate account login is busy while first request remains owned by main without editor liveness dependency', async () => {
  const pending = deferred()
  const f = fixture({ authenticate: () => pending.promise })
  const first = f.reauthenticateAccount('original-account')
  assert.equal((await f.reauthenticateAccount('original-account')).errorCode, 'busy')
  pending.resolve(authenticated('new-fixture-token'))
  assert.equal((await first).state, 'updated')
  assert.equal(f.calls.length, 1)
  assert.equal((await f.reauthenticateAccount('original-account')).state, 'restored')
})

test('concurrent user credential edits cannot be overwritten by a late verified browser response', async () => {
  const pending = deferred()
  const f = fixture({ authenticate: () => pending.promise })
  const response = f.reauthenticateAccount('original-account')
  f.storeManager.updateAccount('original-account', { credentials: { token: 'user-edited-token' } })
  pending.resolve(authenticated('new-fixture-token'))
  assert.equal((await response).errorCode, 'account_changed')
  assert.equal(f.storeManager.getAccountById('original-account', true).credentials.token, 'user-edited-token')
})

test('official token rotation with unchanged revision is still protected by full credential compare-and-swap', async () => {
  const pending = deferred()
  const f = fixture({ authenticate: () => pending.promise })
  const response = f.reauthenticateAccount('original-account')
  f.storeManager.rotateAccountCredentials('original-account', { token: 'old-fixture-token' }, { token: 'official-new-token' })
  pending.resolve(authenticated('new-fixture-token'))
  assert.equal((await response).errorCode, 'account_changed')
  const saved = f.storeManager.getAccountById('original-account', true)
  assert.equal(saved.credentialRevision, 3); assert.equal(saved.credentials.token, 'official-new-token')
})

test('deleted accounts, changed identities, and changed provider types reject in-flight login results', async () => {
  for (const change of [f => f.storeManager.deleteAccount('original-account'),
    f => f.storeManager.updateAccount('original-account', { providerUserId: 'changed-user' }),
    f => f.changeProvider({ id: 'zai', type: 'custom' })]) {
    const pending = deferred()
    const f = fixture({ authenticate: () => pending.promise })
    const response = f.reauthenticateAccount('original-account')
    change(f)
    const writes = f.counts().writes
    pending.resolve(authenticated('new-fixture-token'))
    assert.equal((await response).errorCode, 'account_changed')
    assert.equal(f.counts().writes, writes)
  }
})

test('noncredential preference edits made during login are preserved from the current row, not the old snapshot', async () => {
  const pending = deferred()
  const f = fixture({ authenticate: () => pending.promise })
  const response = f.reauthenticateAccount('original-account')
  f.storeManager.updateAccount('original-account', { name: 'Changed while logging in', nameSource: 'custom', dailyLimit: 20, enabled: true })
  pending.resolve(authenticated('new-fixture-token'))
  assert.equal((await response).state, 'updated')
  const saved = f.storeManager.getAccountById('original-account', true)
  assert.equal(saved.name, 'Changed while logging in'); assert.equal(saved.dailyLimit, 20); assert.equal(saved.enabled, true)
})

test('store write failures and missing readback never produce success and never expose native error details', async () => {
  for (const ignored of [false, true]) {
    const f = fixture({ failWrites: !ignored })
    if (ignored) f.ignoreWrites()
    const result = await f.reauthenticateAccount('original-account')
    assert.equal(result.errorCode, 'save_failed'); assert.equal(result.success, false)
    assert.equal(JSON.stringify(result).includes('secret'), false)
    assert.equal(f.counts().notifications, 0)
  }
})

test('account cleanup disposes only the explicitly deleted account browser without touching any credentials', async () => {
  const f = fixture()
  await f.clearAccountReauthentication('original-account')
  assert.deepEqual(f.cleared, ['original-account'])
  assert.equal(f.counts().writes, 0); assert.equal(f.calls.length, 0)
})

test('IPC and preload expose only account ID; account and provider deletions clean owned browser state', () => {
  const channels = readFileSync(join(root, 'src/main/ipc/channels.ts'), 'utf8')
  const handlers = readFileSync(join(root, 'src/main/ipc/handlers.ts'), 'utf8')
  const preload = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
  assert.match(channels, /ACCOUNTS_REAUTHENTICATE: 'accounts:reauthenticate'/)
  assert.match(preload, /reauthenticate: \(accountId: string\): Promise<AccountReauthenticationResult>/)
  const handler = handlers.slice(handlers.indexOf('ipcMain.handle(IpcChannels.ACCOUNTS_REAUTHENTICATE'), handlers.indexOf('ipcMain.handle(IpcChannels.ACCOUNTS_SET_ENABLED'))
  assert.match(handler, /isLivenessAppWindow\(owner\)/)
  assert.match(handler, /event.senderFrame !== event.sender.mainFrame/)
  assert.match(handler, /return reauthenticateAccount\(accountId\)/)
  assert.doesNotMatch(handler, /credentials|providerType|result\.credentials/)
  assert.match(handlers, /if \(deleted\) await clearAccountReauthentication\(id\)/)
  assert.match(handlers, /accountIds.map\(accountId => clearAccountReauthentication\(accountId\)\)/)
})

test('every token-based builtin signs in under its provider route and atomically saves canonical credentials to the original record', async () => {
  const credentials = {
    deepseek: [{ userToken: '{"value":"fresh-deepseek"}' }, { token: 'fresh-deepseek' }],
    glm: [{ chatglm_refresh_token: 'fresh-glm' }, { refresh_token: 'fresh-glm' }],
    kimi: [{ token: 'fresh-kimi' }, { token: 'fresh-kimi' }],
    minimax: [{ token: 'fresh-minimax', realUserID: 'website-user' }, { token: 'fresh-minimax', realUserID: 'website-user' }],
    mimo: [{ serviceToken: 'fresh-mimo', userId: 'website-user', xiaomichatbot_ph: 'fresh-ph' }, { service_token: 'fresh-mimo', user_id: 'website-user', ph_token: 'fresh-ph' }],
    qwen: [{ tongyi_sso_ticket: 'fresh-qwen' }, { ticket: 'fresh-qwen' }],
    'qwen-ai': [{ token: 'fresh-qwen-ai', cookies: '[]' }, { token: 'fresh-qwen-ai', cookies: '[]' }],
    perplexity: [{ '__Secure-next-auth.session-token': 'fresh-perplexity' }, { sessionToken: 'fresh-perplexity' }],
  }
  for (const [providerId, [raw, canonical]] of Object.entries(credentials)) {
    const f = fixture({ provider: { id: providerId }, account: { providerId, status: 'expired' },
      proxyConfig: { mode: 'custom', url: 'http://127.0.0.1:7888' },
      login: async () => ({ success: true, credentials: { ...raw, captcha_verify_param: 'discard-proof', unrelated_secret: 'discard-secret' }, accountInfo: { userId: 'website-user', email: 'person@example.test' } }) })
    assert.deepEqual(plain(await f.reauthenticateAccount('original-account')), { success: true, accountId: 'original-account', state: 'updated' }, providerId)
    assert.deepEqual(f.oauthCalls, [['login', providerId, providerId, null, { mode: 'custom', url: 'http://127.0.0.1:7888' }]])
    assert.deepEqual(f.scopeCalls, [providerId])
    assert.equal(f.calls.length, 0)
    const saved = f.storeManager.getAccountById('original-account', true)
    assert.deepEqual(plain(saved.credentials), canonical)
    assert.equal(saved.status, 'active'); assert.equal(saved.credentialRevision, 4)
    for (const key of ['name', 'nameSource', 'enabled', 'cooldownUntil', 'cooldownReason', 'dailyLimit', 'createdAt']) assert.equal(saved[key], f.original[key])
    assert.equal(f.snapshot().accounts.length, 1)
  }
})

test('generic login needs a matching identity and rejects unknown or concurrently replaced credentials without overwriting', async () => {
  for (const kind of ['mismatch', 'missing', 'edit', 'delete']) {
    const pending = deferred()
    const f = fixture({ provider: { id: 'kimi' }, account: { providerId: 'kimi' }, login: () => pending.promise })
    const task = f.reauthenticateAccount('original-account')
    if (kind === 'edit') f.storeManager.updateAccount('original-account', { credentials: { token: 'USER-REPLACEMENT' } })
    if (kind === 'delete') f.storeManager.deleteAccount('original-account')
    const writes = f.counts().writes
    pending.resolve({ success: true, credentials: { token: 'NEW' }, accountInfo: kind === 'missing' ? {} : { userId: kind === 'mismatch' ? 'other-user' : 'website-user', email: 'person@example.test' } })
    const result = await task
    assert.equal(result.errorCode, kind === 'missing' ? 'identity_unverified' : kind === 'mismatch' ? 'identity_mismatch' : 'account_changed')
    assert.equal(f.counts().writes, writes)
  }
})

test('legacy generic identity can be verified from old credentials but absent identity never gets invented from a display name', async () => {
  const f = fixture({ provider: { id: 'kimi' }, account: { providerId: 'kimi', email: undefined, providerUserId: undefined } })
  assert.equal((await f.reauthenticateAccount('original-account')).state, 'updated')
  assert.equal(f.oauthCalls[0][0], 'validate'); assert.equal(f.oauthCalls[1][0], 'login')
  for (const valid of [true, false]) {
    const unverified = fixture({ provider: { id: 'perplexity' }, account: { providerId: 'perplexity', email: undefined, providerUserId: undefined },
      validate: async () => ({ valid, accountInfo: { name: 'person@example.test' } }) })
    assert.equal((await unverified.reauthenticateAccount('original-account')).errorCode, 'identity_unverified')
    assert.equal(unverified.oauthCalls.filter(call => call[0] === 'login').length, 0)
    assert.equal(unverified.counts().writes, 0)
  }
})

test('Arena reauthentication preserves exact profile and settings, with scoped cancellation and stale account guard', async () => {
  const profileId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const options = { provider: { id: 'arena' }, account: { providerId: 'arena', providerUserId: undefined, status: 'expired', credentials: { browserProfileId: profileId } } }
  const f = fixture(options)
  assert.equal((await f.reauthenticateAccount('original-account')).state, 'updated')
  assert.equal(f.arenaCalls.length, 1)
  assert.equal(f.arenaCalls[0].profileId, profileId)
  assert.equal(f.arenaCalls[0].expectedEmail, 'person@example.test')
  assert.deepEqual(plain(f.storeManager.getAccountById('original-account', true).credentials), { browserProfileId: profileId })
  assert.equal(f.storeManager.getAccountById('original-account').enabled, false)
  const changedRoute = fixture({ ...options, arena: async () => ({ success: false, errorCode: 'route_changed' }) })
  assert.equal((await changedRoute.reauthenticateAccount('original-account')).errorCode, 'route_changed')
  assert.equal(changedRoute.counts().writes, 0)
  await f.clearAccountReauthentication('original-account')
  assert.deepEqual(f.cleared, ['original-account', profileId])
  for (const change of ['profile', 'identity', 'deleted']) {
    const pending = deferred(), g = fixture({ ...options, arena: () => pending.promise })
    const task = g.reauthenticateAccount('original-account')
    assert.equal(g.arenaCalls[0].isAccountCurrent(), true)
    if (change === 'deleted') g.storeManager.deleteAccount('original-account')
    else g.storeManager.updateAccount('original-account', change === 'identity' ? { email: 'someone-else@example.test' } : { credentials: { browserProfileId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' } })
    assert.equal(g.arenaCalls[0].isAccountCurrent(), false)
    const writes = g.counts().writes
    pending.resolve({ success: true, profileId, accountInfo: { email: 'person@example.test' } })
    assert.equal((await task).errorCode, 'account_changed')
    assert.equal(g.counts().writes, writes)
  }
})
