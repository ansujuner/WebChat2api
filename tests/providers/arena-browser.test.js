const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { Readable } = require('node:stream')
const root = path.join(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
function load(name, overrides = {}, globals = {}) {
  const fileName = path.join(root, 'src/main/arena', name + '.ts')
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(fileName, 'utf8'), {
    fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, {
    module, exports: module.exports, Buffer, URL, AbortController, setTimeout, clearTimeout, process: { platform: process.platform },
    console: new Proxy({}, { get: () => () => { throw Error('No Arena diagnostics may log credentials or raw responses') } }),
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      assert.ok(name.startsWith('node:'), `Unexpected dependency: ${name}`)
      return require(name)
    }, ...globals,
  }, { filename: fileName })
  return module.exports
}
const protocol = load('protocol')
const scripts = load('pageScripts')
const rateLimits = load('rateLimit', { './protocol': protocol })
const id = '019b24bb-5caf-71c3-b854-37d0c7086f21'
const profileId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const secret = 'fixture-cookie-secret-do-not-export'
const model = { id, publicName: 'Max', displayName: 'Max', organization: 'fixture', provider: 'fixture', userSelectable: true,
  capabilities: { inputCapabilities: { text: true }, outputCapabilities: { text: true, image: { aspectRatios: ['1:1'] } } } }
const snapshot = { ready: true, authenticated: true, accountInfo: { email: 'fixture@example.test' }, models: [model] }
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code && !error.message.includes(secret))
const tick = async () => { for (let n = 0; n < 20; n++) await Promise.resolve() }

function fakeFiles() {
  const appDirectory = path.join(root, '.audit-cache', 'arena-unit-profile-fixture')
  const entries = new Map([[appDirectory, { directory: true }]])
  const api = {
    async mkdir(name) { if (!entries.has(name)) entries.set(name, { directory: true }) },
    async realpath(name) { if (!entries.has(name)) throw Error(secret); return entries.get(name).realpath || name },
    async lstat(name) { const entry = entries.get(name); if (!entry) throw Error(secret); return { isSymbolicLink: () => !!entry.link, isFile: () => !entry.directory, size: entry.content?.length || 0 } },
    async writeFile(name, content, options) { assert.equal(options.flag, 'wx'); if (entries.has(name)) throw Error(secret); entries.set(name, { content }) },
    async readFile(name) { const entry = entries.get(name); if (!entry) throw Error(secret); return entry.content },
  }
  return { entries, api, appDirectory }
}
function managerFixture(globals = {}, overrides = {}) {
  const files = fakeFiles(), calls = [], config = { oauthProxyMode: 'none' }
  let ledger = { version: 1, updatedAt: 0, buckets: {} }
  const quota = new rateLimits.ArenaRateLimiter({ read: () => ledger, write: value => { ledger = plain(value) } })
  const api = load('browserManager', {
    './rateLimit': { getArenaRateLimiter: () => quota, isArenaQuotaAccountId: rateLimits.isArenaQuotaAccountId },
    './protocol': protocol, './pageScripts': scripts,
    electron: { app: { getPath(name) { assert.equal(name, 'userData'); return files.appDirectory } } },
    '../store/store': { storeManager: { getConfig: () => ({ ...config }), getAccountById: () => ({ id: 'fixture-account', providerId: 'arena', email: snapshot.accountInfo.email, credentials: { browserProfileId: profileId } }) } },
    '../network/proxy': { getProviderProxyConfig: () => config.proxyConfig || { mode: config.oauthProxyMode } },
    '../../shared/accountIdentity': require('../../src/shared/accountIdentity.ts'),
    '../oauth/browserDiscovery': {
      findInstalledLoginBrowser: async () => { throw Error('Tests must not discover installed browsers') },
      loginBrowserArguments: () => { throw Error('Tests must not launch a browser') },
      browserChildEnvironment: () => { throw Error('Tests must not read process credentials') },
    },
    '../oauth/cdpPipe': { CdpPipe: class { constructor() { throw Error('Tests must not create a CDP pipe') } } },
    'node:child_process': { spawn() { throw Error('Tests must not launch a process') } },
    'node:fs/promises': files.api,
    ...overrides,
  }, globals)
  const manager = new api.ArenaBrowserManager()
  const context = { pipe: { async send(method, params) { calls.push({ method, params }); return {} } }, exited: () => false, proxyConfig: { mode: 'none' } }
  const wire = () => {
    manager.context = async (id, signal, requestOwner) => { calls.push({ operation: 'context', id, requestOwner }); return context }
    manager.page = async () => ({ targetId: 'owned-arena-page', sessionId: 'owned-session' })
    manager.evaluate = async (_, __, expression) => {
      calls.push({ operation: 'evaluate', expression })
      if (expression === scripts.ARENA_RUNTIME_SNAPSHOT) return snapshot
      if (expression.includes('const chunks=[]')) return { chunks: ['a0:"hello"\nad:{"finishReason":"stop"}\n'], done: true }
      if (expression.includes('const controller =')) return { started: true }
      return undefined
    }
  }
  return { api, manager, calls, context, files, config, wire, quota }
}

test('Arena catalog validates records and modalities, deduplicates names and never invents stale model IDs', () => {
  const input = [null, 7, { ...model, id: '../../private' }, { ...model, organization: null }, { ...model, publicName: 2, displayName: null },
    { ...model, userSelectable: false }, { ...model, capabilities: { inputCapabilities: { text: 'true' } } }, model, { ...model, id: profileId }]
  assert.deepEqual(plain(protocol.normalizeArenaModels(input)), [{ id, name: 'max', modality: 'text' }, { id, name: 'max', modality: 'image' }])
  assert.doesNotMatch(JSON.stringify(protocol.ARENA_PUBLIC_MODELS), /seedream/i)
  assert.deepEqual(plain(protocol.normalizeArenaModels({ models: [model] })), [])
})

test('Arena request uses one latest prompt and preserves evaluation ID only for matching model/modality', () => {
  const chosen = { id, name: 'max', modality: 'text' }
  const first = protocol.arenaRequest(chosen, '你好')
  assert.equal(first.path, '/nextjs-api/stream/create-evaluation')
  assert.equal(first.body.mode, 'direct-battle')
  assert.equal(first.body.modality, 'chat')
  const second = protocol.arenaRequest(chosen, '今天天气怎么样', first.conversation)
  assert.equal(second.path, '/nextjs-api/stream/post-to-evaluation/' + first.conversation.id)
  assert.equal(second.body.mode, undefined)
  assert.equal(second.body.userMessage.content, '今天天气怎么样')
  assert.doesNotMatch(JSON.stringify(second.body), /你好|history|messages|recaptcha|cookie/)
  assert.notEqual(first.body.userMessageId, second.body.userMessageId)
  for (const conversation of [{ ...first.conversation, id: '/bad' }, { ...first.conversation, modelId: profileId }, { ...first.conversation, modality: 'image' }]) {
    assert.throws(() => protocol.arenaRequest(chosen, 'next', conversation), { code: 'invalid_request' })
  }
  for (const prompt of ['', '  ', null, 'x'.repeat(200001)]) assert.throws(() => protocol.arenaRequest(chosen, prompt), { code: 'invalid_request' })
})

const uuidTimestamp = value => Number.parseInt(value.replaceAll('-', '').slice(0, 12), 16)
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('Arena UUID v7 has a real millisecond timestamp, correct version/variant and cryptographic entropy', () => {
  const baseline = Date.UTC(2026, 8, 6, 4, 0, 0, 123)
  let now = baseline
  const p = load('protocol', {}, { Date: class extends Date { static now() { return now } } })
  const values = Array.from({ length: 32 }, (_, index) => { now = baseline + index; return p.arenaUuidV7() })
  for (const [index, value] of values.entries()) {
    assert.match(value, uuidV7Pattern)
    assert.equal(uuidTimestamp(value), baseline + index)
    assert.equal(p.isArenaUuid(value), true)
  }
  assert.equal(new Set(values.map(value => value.slice(19))).size, values.length)
  assert.match(fs.readFileSync(path.join(root, 'src/main/arena/protocol.ts'), 'utf8'), /import \{ randomBytes \} from 'node:crypto'/)
})

test('Arena UUID v7 remains unique and ordered through same-millisecond counter overflow', () => {
  const now = Date.UTC(2026, 8, 6)
  let randomCalls = 0
  const p = load('protocol', { 'node:crypto': { randomBytes(size) {
    assert.equal(size, 16); randomCalls++; return Buffer.alloc(size, 0xff)
  } } }, { Date: class extends Date { static now() { return now } } })
  // Deliberately identical random bytes prove the counter also prevents collisions.
  const values = Array.from({ length: 8194 }, () => p.arenaUuidV7())
  assert.equal(randomCalls, values.length)
  assert.equal(new Set(values).size, values.length)
  assert.equal(uuidTimestamp(values[0]), now)
  assert.equal(uuidTimestamp(values[1]), now + 1)
  assert.equal(uuidTimestamp(values.at(-1)), now + 3)
  for (let index = 1; index < values.length; index++) {
    assert.match(values[index], uuidV7Pattern)
    assert.ok(values[index] > values[index - 1])
  }
})

test('Arena UUID v7 tolerates clock regression and resumes actual time when the clock catches up', () => {
  const baseline = Date.UTC(2026, 8, 6)
  let now = baseline
  const p = load('protocol', { 'node:crypto': { randomBytes: size => Buffer.alloc(size) } }, {
    Date: class extends Date { static now() { return now } },
  })
  const first = p.arenaUuidV7()
  now -= 60000
  const rolledBack = p.arenaUuidV7()
  assert.ok(rolledBack > first)
  assert.equal(uuidTimestamp(rolledBack), baseline)
  now = baseline + 1000
  const recovered = p.arenaUuidV7()
  assert.ok(recovered > rolledBack)
  assert.equal(uuidTimestamp(recovered), now)
})

test('Arena text/image submissions use UUID v7 for every new wire ID without rewriting existing conversations or models', () => {
  for (const modality of ['text', 'image']) {
    const chosen = { id, name: 'max', modality }
    const first = protocol.arenaRequest(chosen, 'first')
    const ids = [first.body.id, first.body.userMessageId, first.body.modelAMessageId]
    ids.forEach(value => assert.match(value, uuidV7Pattern))
    assert.ok(ids[0] < ids[1] && ids[1] < ids[2])
    assert.equal(first.body.modelAId, id)
    for (const savedId of [first.conversation.id, profileId]) {
      const conversation = Object.freeze({ id: savedId, modelId: id, modality })
      const continued = protocol.arenaRequest(chosen, 'next only', conversation)
      assert.deepEqual(plain(continued.conversation), conversation)
      assert.notEqual(continued.conversation, conversation)
      assert.equal(continued.path, '/nextjs-api/stream/post-to-evaluation/' + savedId)
      assert.equal(continued.body.id, savedId)
      assert.equal(continued.body.modelAId, id)
      assert.equal(continued.body.userMessage.content, 'next only')
      assert.match(continued.body.userMessageId, uuidV7Pattern)
      assert.match(continued.body.modelAMessageId, uuidV7Pattern)
      assert.ok(continued.body.userMessageId > ids[2])
      assert.ok(continued.body.modelAMessageId > continued.body.userMessageId)
    }
  }
})

test('Arena UUID v7 rejects invalid clocks and exhausted timestamp range without raw diagnostic data', () => {
  let now = 0
  const p = load('protocol', { 'node:crypto': { randomBytes: size => Buffer.alloc(size, 0xff) } }, {
    Date: class extends Date { static now() { return now } },
  })
  for (now of [-1, 1.25, NaN, Infinity, 0x1000000000000]) {
    assert.throws(() => p.arenaUuidV7(), { code: 'invalid_request' })
  }
  now = 0xffffffffffff
  assert.equal(uuidTimestamp(p.arenaUuidV7()), now)
  assert.throws(() => p.arenaUuidV7(), { code: 'invalid_request' })
})

test('Arena stream decoder handles UTF-8 boundaries, reasoning and participant isolation with mandatory terminal', () => {
  const wire = Buffer.from('b0:"not the chosen model"\nag:"思考"\na0:"你好"\nad:{"finishReason":"stop"}\n')
  const decoder = new protocol.ArenaProtocolDecoder(), events = []
  for (let n = 0; n < wire.length; n++) events.push(...decoder.push(wire.subarray(n, n + 1)))
  events.push(...decoder.end())
  assert.deepEqual(plain(events), [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '你好' }, { type: 'finish', reason: 'stop' }])
  const incomplete = new protocol.ArenaProtocolDecoder()
  incomplete.push('a0:"partial"\n')
  assert.throws(() => incomplete.end(), { code: 'incomplete_stream' })
  for (const input of ['data: {}\n', 'a3:"' + secret + '"\n', 'ad:{"finishReason":"error"}\n', 'ad:{}\n', 'a0:{}\n', 'az:{}\n']) {
    assert.throws(() => new protocol.ArenaProtocolDecoder().push(input), error => error.code === 'upstream_error' && !error.message.includes(secret))
  }
})

test('Arena image decoder accepts only validated image representations and requires finish', () => {
  for (const line of ['a2:[{"type":"image","data":"aGVsbG8=","mimeType":"image/png"}]', 'ak:{"mimeType":"image/png","data":"aGVsbG8="}']) {
    const decoder = new protocol.ArenaProtocolDecoder()
    assert.deepEqual(plain(decoder.push(line + '\nad:{"finishReason":"stop"}')), [{ type: 'image', url: 'data:image/png;base64,aGVsbG8=' }])
    assert.deepEqual(plain(decoder.end()), [{ type: 'finish', reason: 'stop' }])
  }
  for (const url of ['https://127.0.0.1/a', 'https://172.16.1.1/a', 'https://[::1]/a', 'https://user:secret@arena.ai/a', 'javascript:alert(1)', 'data:text/html;base64,aGVsbG8=', 'https://private.local/a', 'https://arena.ai:99/a']) {
    assert.throws(() => protocol.arenaImageUrl(url), { code: 'upstream_error' })
  }
  assert.equal(protocol.arenaImageUrl('https://cdn.arena.ai/image.png'), 'https://cdn.arena.ai/image.png')
})

test('Arena page scope accepts exact HTTPS provider origin only', () => {
  assert.equal(protocol.isArenaPage('https://arena.ai/text/direct'), true)
  for (const url of ['http://arena.ai', 'https://arena.ai.evil.example', 'https://user@arena.ai', 'https://arena.ai:444', 'file:///arena.ai', null]) assert.equal(protocol.isArenaPage(url), false)
})

function runtimeSnapshot(values, origin = 'https://arena.ai') {
  const root = { memoizedProps: values[0] }
  let last = root
  for (const value of values.slice(1)) { last.child = { memoizedProps: { value } }; last = last.child }
  const node = { '__reactFiber$fixture': root }
  return plain(vm.runInNewContext(scripts.ARENA_RUNTIME_SNAPSHOT, { location: { origin }, document: { querySelectorAll: () => [node] } }))
}

test('Runtime user/model stores override larger stale initial props, including logout and empty live catalog', () => {
  const initial = { initialUser: { email: 'stale@example.test', secret }, initialModels: [model, model, null] }
  const live = { getState: () => ({ user: null, models: [] }) }
  for (const order of [[initial, live], [live, initial]]) {
    assert.deepEqual(runtimeSnapshot(order), { ready: true, authenticated: false, accountInfo: {}, models: [] })
  }
  const result = runtimeSnapshot([initial, { getState: () => ({ user: { email: 'fresh@example.test', token: secret }, models: [model] }) }])
  assert.equal(result.accountInfo.email, 'fresh@example.test')
  assert.equal(result.models.length, 1)
  assert.doesNotMatch(JSON.stringify(result), /secret|token|stale/)
  assert.equal(runtimeSnapshot([initial], 'https://attacker.example'), null)
})

test('Arena profiles require UUID, exact ownership marker and canonical non-symlink containment', async () => {
  const f = managerFixture()
  await rejectsCode(f.api.arenaProfileDirectory('../personal', true), 'invalid_request')
  const directory = await f.api.arenaProfileDirectory(profileId, true)
  assert.equal(directory, path.join(f.files.appDirectory, 'arena-browser-profiles', profileId))
  assert.equal(await f.api.arenaProfileDirectory(profileId), directory)
  const marker = path.join(directory, 'chat2api-profile.json')
  f.files.entries.set(marker, { content: JSON.stringify({ provider: 'other', version: 1, profileId }) })
  await rejectsCode(f.api.arenaProfileDirectory(profileId), 'browser_unavailable')
  f.files.entries.set(marker, { content: JSON.stringify({ provider: 'arena', version: 1, profileId }), link: true })
  await rejectsCode(f.api.arenaProfileDirectory(profileId), 'browser_unavailable')
  f.files.entries.set(directory, { directory: true, realpath: path.join(root, 'unrelated') })
  await rejectsCode(f.api.arenaProfileDirectory(profileId), 'browser_unavailable')
})

test('Account catalog never uses public fallback when the scoped runtime is anonymous or missing models', async () => {
  const f = managerFixture()
  const publicCatalog = await f.manager.getModels()
  assert.equal(publicCatalog.source, 'public-snapshot')
  f.manager.snapshot = async () => ({ ...snapshot, authenticated: false })
  await rejectsCode(f.manager.getModels(profileId), 'action_required')
  f.manager.snapshot = async () => ({ ...snapshot, models: [] })
  await rejectsCode(f.manager.getModels(profileId), 'action_required')
  f.manager.snapshot = async () => snapshot
  assert.equal((await f.manager.getModels(profileId)).source, 'runtime')
})

test('Arena successful login retains its owned browser; cancellation closes only failed login', async () => {
  const f = managerFixture(), closed = []
  f.manager.context = async () => f.context
  f.manager.status = async () => ({ authenticated: true, accountInfo: snapshot.accountInfo })
  f.manager.closeProfile = async id => { closed.push(id) }
  const result = await f.manager.startLogin()
  assert.equal(result.success, true)
  assert.equal(protocol.isArenaUuid(result.profileId), true)
  assert.equal(result.accountInfo.email, snapshot.accountInfo.email)
  assert.equal(closed.length, 0)
  assert.equal(f.manager.isWindowOpen(), false)
  f.manager.status = async () => { f.manager.cancel(); return { authenticated: false } }
  const cancelled = await f.manager.startLogin()
  assert.equal(cancelled.success, false)
  assert.equal(closed.length, 1)
  assert.doesNotMatch(JSON.stringify(cancelled), /fixture-cookie/)
})

test('Arena context refuses a changed route without closing even an API-idle visible browser', async () => {
  const f = managerFixture(), launches = [], closed = []
  f.manager.launch = async (id, proxyConfig) => { launches.push(plain(proxyConfig)); return { ...f.context, proxyConfig } }
  f.manager.closeProfile = async id => { closed.push(id); f.manager.browsers.delete(id) }
  await f.manager.context(profileId)
  assert.deepEqual(launches, [{ mode: 'none' }])
  assert.equal(f.manager.hasOpenBrowsers(), true)
  f.config.oauthProxyMode = 'system'
  f.manager.busyProfiles.add(profileId)
  await rejectsCode(f.manager.context(profileId), 'route_changed')
  assert.equal(closed.length, 0)
  await rejectsCode(f.manager.context(profileId, undefined, true), 'route_changed')
  f.manager.busyProfiles.delete(profileId)
  await rejectsCode(f.manager.context(profileId), 'route_changed')
  assert.deepEqual(launches, [{ mode: 'none' }])
  assert.equal(closed.length, 0)
})

test('Arena existing-account login reuses exactly the owned profile and returns only verified matching email', async () => {
  const f = managerFixture(); f.wire()
  await f.api.arenaProfileDirectory(profileId, true)
  const files = [...f.files.entries.keys()]
  const result = await f.manager.reauthenticate({ profileId, expectedEmail: snapshot.accountInfo.email.toUpperCase(), isAccountCurrent: () => true })
  assert.deepEqual(plain(result), { success: true, profileId, accountInfo: { email: snapshot.accountInfo.email } })
  assert.deepEqual([...f.files.entries.keys()], files, 'Re-login must not create another profile')
  assert.equal(f.calls.find(call => call.operation === 'context').id, profileId)
  assert.ok(f.calls.some(call => call.method === 'Page.bringToFront'))
  assert.ok(f.calls.some(call => call.method === 'Target.detachFromTarget'))
  assert.equal(f.calls.some(call => call.method === 'Browser.close'), false)
  assert.equal(f.manager.busyProfiles.size, 0)
  assert.equal(f.manager.isWindowOpen(), false)
})

test('Arena wrong identity, missing original profile and a deleted account never return a replacement login', async () => {
  for (const kind of ['identity', 'missing-profile', 'deleted']) {
    const f = managerFixture(); f.wire()
    if (kind !== 'missing-profile') await f.api.arenaProfileDirectory(profileId, true)
    const result = await f.manager.reauthenticate({ profileId, expectedEmail: kind === 'identity' ? 'other@example.test' : snapshot.accountInfo.email,
      isAccountCurrent: () => kind !== 'deleted' })
    assert.equal(result.success, false)
    assert.equal(result.errorCode, kind === 'identity' ? 'identity_mismatch' : kind === 'deleted' ? 'account_changed' : 'profile_unavailable')
    assert.equal(result.profileId, undefined)
    assert.equal(f.manager.busyProfiles.size, 0)
  }
})

test('Arena re-login locks only its profile and rejects stale results after cancellation or account replacement', async () => {
  for (const change of ['cancel', 'account']) {
    const f = managerFixture(); f.wire(); await f.api.arenaProfileDirectory(profileId, true)
    let resolve, current = true
    f.manager.readyPage = () => new Promise(done => { resolve = done })
    const task = f.manager.reauthenticate({ profileId, expectedEmail: snapshot.accountInfo.email, isAccountCurrent: () => current })
    await tick()
    assert.equal((await f.manager.reauthenticate({ profileId, expectedEmail: snapshot.accountInfo.email, isAccountCurrent: () => true })).errorCode, 'busy')
    await rejectsCode(f.manager.chat({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'not sent' }), 'account_busy')
    if (change === 'cancel') f.manager.cancel(); else current = false
    resolve({ snapshot, targetId: 'owned-page', sessionId: 'owned-session' })
    const result = await task
    assert.equal(result.success, false)
    assert.equal(result.errorCode, change === 'cancel' ? 'cancelled' : 'account_changed')
    assert.equal(f.manager.busyProfiles.size, 0)
  }
})

test('Arena custom proxy URL changes require the user to close the old browser before the same profile can reopen', async () => {
  const f = managerFixture(), launches = [], closed = []
  f.config.proxyConfig = { mode: 'custom', url: 'http://127.0.0.1:7888' }
  f.manager.launch = async (id, proxyConfig) => { launches.push({ id, config: plain(proxyConfig) }); return { ...f.context, proxyConfig } }
  f.manager.closeProfile = async id => { closed.push(id); f.manager.browsers.delete(id) }
  await f.manager.context(profileId)
  f.config.proxyConfig = { mode: 'custom', url: 'socks5://127.0.0.1:7999' }
  f.manager.busyProfiles.add(profileId)
  await rejectsCode(f.manager.context(profileId), 'route_changed')
  assert.equal(closed.length, 0)
  f.manager.busyProfiles.delete(profileId)
  await rejectsCode(f.manager.context(profileId), 'route_changed')
  assert.equal(closed.length, 0); assert.equal(launches.length, 1)
  const old = await f.manager.browsers.get(profileId)
  old.exited = () => true // Only an actual user-closed browser can now be replaced.
  await f.manager.context(profileId)
  assert.deepEqual(launches, [{ id: profileId, config: { mode: 'custom', url: 'http://127.0.0.1:7888' } }, { id: profileId, config: { mode: 'custom', url: 'socks5://127.0.0.1:7999' } }])
  assert.deepEqual(closed, [profileId])
})

test('Arena route_changed is a fixed action-required error before auth, quota reservation or website submission', async () => {
  const f = managerFixture()
  await f.api.arenaProfileDirectory(profileId, true)
  f.manager.browsers.set(profileId, Promise.resolve(f.context))
  f.config.proxyConfig = { mode: 'custom', url: 'http://127.0.0.1:7888' }
  const error = await f.manager.chat({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'not sent' }).catch(error => error)
  assert.equal(error.code, 'route_changed'); assert.equal(error.status, 409); assert.equal(error.actionRequired, true)
  assert.match(error.message, /manual website chat/)
  assert.equal(f.calls.some(call => call.method === 'Browser.close' || call.operation === 'evaluate'), false)
  assert.equal(f.manager.busyProfiles.size, 0)
  const login = await f.manager.reauthenticate({ profileId, expectedEmail: snapshot.accountInfo.email, isAccountCurrent: () => true })
  assert.deepEqual(plain(login), { success: false, errorCode: 'route_changed' })
  assert.deepEqual(plain(await f.manager.status(profileId)), { authenticated: false, ready: false, actionRequired: true, errorCode: 'route_changed' })
  assert.equal(f.calls.some(call => call.method === 'Browser.close'), false)
})

test('Arena website identity switch blocks generation before model reservation or submission', async () => {
  const f = managerFixture(); f.wire()
  f.manager.readyPage = async () => ({ sessionId: 'owned-session', snapshot: { ...snapshot, accountInfo: { email: 'other@example.test' } } })
  await rejectsCode(f.manager.chat({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'not sent' }), 'action_required')
  assert.equal(f.calls.filter(call => call.expression?.includes('const controller =')).length, 0)
  assert.equal(f.manager.busyProfiles.size, 0)
})

test('Arena chat returns raw terminal stream and locks one account until resource release', async () => {
  const f = managerFixture(); f.wire()
  const first = await f.manager.chat({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'only latest input' })
  await rejectsCode(f.manager.chat({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'other' }), 'account_busy')
  let output = ''
  for await (const chunk of first.stream) output += chunk
  assert.match(output, /a0:"hello"/)
  assert.equal(f.manager.busyProfiles.size, 0)
  assert.ok(f.calls.some(call => call.method === 'Target.detachFromTarget'))
  const starts = f.calls.filter(call => call.expression?.includes('const controller ='))
  assert.equal(starts.length, 1)
  assert.match(starts[0].expression, /only latest input/)
  assert.equal(first.conversation.modelId, id)
})

test('Arena preflight rejects unknown model and malformed prompt without submitting', async () => {
  const f = managerFixture(); f.wire()
  await rejectsCode(f.manager.chat({ accountId: 'fixture-account', profileId, model: 'not-in-catalog', prompt: 'hello' }), 'model_not_available')
  await rejectsCode(f.manager.chat({ accountId: 'fixture-account', profileId, model: {}, prompt: 'hello' }), 'invalid_request')
  await rejectsCode(f.manager.chat({ accountId: 'fixture-account', profileId, model: 'max', prompt: '' }), 'invalid_request')
  assert.equal(f.manager.busyProfiles.size, 0)
  assert.equal(f.calls.filter(call => call.expression?.includes('const controller =')).length, 0)
})

test('Arena cancellation during initial submission aborts the page operation before exposing a stream', async () => {
  const f = managerFixture(); f.wire()
  const base = f.manager.evaluate, abort = new AbortController()
  let finishStart, started = false, aborts = 0
  f.manager.evaluate = async (context, session, expression) => {
    if (expression.includes('const controller =')) { started = true; return new Promise(resolve => { finishStart = resolve }) }
    if (expression.includes('delete globalThis[key]')) { aborts++; finishStart?.({ error: 'aborted' }); return }
    return base(context, session, expression)
  }
  const result = f.manager.chat({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'hello', signal: abort.signal })
  await tick(); assert.equal(started, true)
  abort.abort()
  await rejectsCode(result, 'aborted')
  assert.ok(aborts >= 1)
  assert.equal(f.manager.busyProfiles.size, 0)
})

test('Arena image return requires decoded image plus terminal; partial output never succeeds', async () => {
  const f = managerFixture()
  f.manager.request = async () => ({ stream: Readable.from(['a2:[{"type":"image","image":"https://cdn.arena.ai/fixture.png"}]\n']), conversation: {} })
  await rejectsCode(f.manager.generateImage({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'hello' }), 'incomplete_stream')
  f.manager.request = async () => ({ stream: Readable.from(['a2:[{"type":"image","image":"https://cdn.arena.ai/fixture.png"}]\nad:{"finishReason":"stop"}\n']), conversation: {} })
  assert.deepEqual(plain(await f.manager.generateImage({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'hello' })), { url: 'https://cdn.arena.ai/fixture.png' })
})

function pageFixture({ status = 200, problem = {}, missingScore = false, origin = 'https://arena.ai', headers = {}, now = Date.UTC(2026, 8, 6) } = {}) {
  const requests = [], timers = new Map()
  let number = 0
  const scope = {
    location: { origin }, URL, AbortController, TextDecoder,
    Date: class extends Date { static now() { return now } },
    setTimeout(fn) { const id = ++number; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) },
    document: { scripts: [{ src: 'https://www.google.com/recaptcha/enterprise.js?render=fixture-public-site-key' }] },
    async fetch(url, options) {
      requests.push({ url, options })
      let sent = false
      return { ok: status === 200, status, headers: { get: key => Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? null }, json: async () => problem, body: { getReader: () => ({
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.from(status === 200 ? 'a0:"fixture"\nad:{"finishReason":"stop"}\n' : JSON.stringify(problem)) }),
        releaseLock() {},
      }) } }
    },
  }
  scope.window = { grecaptcha: missingScore ? undefined : { enterprise: { ready(fn) { fn() }, execute: async (key, options) => {
    assert.equal(key, 'fixture-public-site-key'); assert.equal(options.action, 'chat_submit'); return secret
  } } } }
  const context = vm.createContext(scope)
  return { requests, timers, scope, context, run: expression => vm.runInContext(expression, context) }
}

test('Arena page transport sends one normal same-origin request and exports no score/cookie/credential', async () => {
  const f = pageFixture()
  const started = await f.run(scripts.arenaStartExpression('fixture-job', '/nextjs-api/stream/create-evaluation', { userMessage: { content: 'hello' } }))
  assert.deepEqual(plain(started), { started: true })
  await tick()
  const drained = f.run(scripts.arenaDrainExpression('fixture-job'))
  assert.equal(drained.done, true)
  assert.match(drained.chunks.join(''), /fixture/)
  assert.doesNotMatch(JSON.stringify([started, drained]), /fixture-cookie|recaptchaV3Token|credentials/)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].options.credentials, 'same-origin')
  assert.equal(JSON.parse(f.requests[0].options.body).recaptchaV3Token, secret)
  assert.equal(f.requests[0].options.headers, undefined)
  assert.equal(f.timers.size, 0)
  f.run(scripts.arenaAbortExpression('fixture-job'))
  assert.equal(f.scope['fixture-job'], undefined)
})

test('Arena protections stop with action_required and never invoke a second request or challenge solver', async () => {
  for (const config of [{ status: 401 }, { status: 403 }, { status: 400, problem: { error: 'recaptcha validation failed ' + secret } }, { missingScore: true }]) {
    const f = pageFixture(config)
    const result = await f.run(scripts.arenaStartExpression('fixture-job', '/nextjs-api/stream/create-evaluation', {}))
    assert.deepEqual(plain(result), { error: 'action_required', diagnostic: config.missingScore ? { stage: 'score' } : { stage: 'submission', upstreamStatus: config.status, errorHints: config.problem ? ['validation', 'recaptcha'] : [] } })
    assert.equal(f.requests.length, config.missingScore ? 0 : 1)
    assert.equal(f.timers.size, 0)
    assert.doesNotMatch(JSON.stringify(result), /fixture-cookie/)
  }
  const f = pageFixture({ origin: 'https://elsewhere.example' })
  assert.deepEqual(plain(await f.run(scripts.arenaStartExpression('fixture-job', '/nextjs-api/stream/create-evaluation', {}))), { error: 'action_required' })
  assert.equal(f.requests.length, 0)
})

test('Arena target attachment rejects origin changes and detaches even when revalidation fails', async () => {
  for (const failure of ['changed-origin', 'connection-error']) {
    const f = managerFixture(), calls = []
    const context = { pipe: { async send(method) {
      calls.push(method)
      if (method === 'Target.getTargets') return { targetInfos: [{ type: 'page', url: 'https://arena.ai/text/direct', targetId: 'owned' }] }
      if (method === 'Target.attachToTarget') return { sessionId: 'owned-session' }
      if (method === 'Target.getTargetInfo') {
        if (failure === 'connection-error') throw Error(secret)
        return { targetInfo: { url: 'https://accounts.google.com/' } }
      }
      return {}
    } } }
    await rejectsCode(f.manager.page(context), failure === 'changed-origin' ? 'action_required' : 'browser_unavailable')
    assert.deepEqual(calls, ['Target.getTargets', 'Target.attachToTarget', 'Target.getTargetInfo', 'Target.detachFromTarget'])
  }
})

test('Arena429 returns only safe reset timing, honors official headers and never resubmits', async () => {
  const now = Date.UTC(2026, 8, 6)
  const cases = [
    [{ 'RateLimit-Reset': String((now + 120000) / 1000), 'Retry-After': '9' }, now + 120000],
    [{ 'Retry-After': '90' }, now + 90000],
    [{ 'Retry-After': new Date(now + 300000).toUTCString() }, now + 300000],
    [{ 'RateLimit-Reset': '0', 'Retry-After': '45' }, now + 45000],
    [{ 'Retry-After': '-5', 'ratelimit-remaining': '9999' }, now + 60000],
    [{ 'RateLimit-Reset': 'Infinity', 'Retry-After': '' }, now + 60000],
  ]
  for (const [headers, retryAt] of cases) {
    const f = pageFixture({ status: 429, problem: { error: secret }, headers, now })
    const result = await f.run(scripts.arenaStartExpression('quota-fixture', '/nextjs-api/stream/create-evaluation', {}))
    assert.deepEqual(plain(result), { error: 'rate_limited', retryAt, diagnostic: { stage: 'submission', upstreamStatus: 429 } })
    assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0)
    assert.doesNotMatch(JSON.stringify(result), /fixture-cookie|errorHints|token/)
  }
})

test('Arena manager refunds only proven score-stage failures, retaining uncertain submissions', async () => {
  for (const phase of ['score', 'submission', 'transport']) {
    const f = managerFixture(); f.wire()
    f.quota.setOfficialPolicy('fixture-account', id, 'text', { limit: 5, windowMs: 3600000 })
    const original = f.manager.evaluate
    f.manager.evaluate = async (...args) => {
      if (!args[2].includes('const controller =')) return original(...args)
      if (phase === 'transport') throw Error(secret)
      return { error: 'action_required', diagnostic: { stage: phase } }
    }
    await assert.rejects(f.manager.chat({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'fixture' }))
    assert.equal(f.quota.availability('fixture-account', id, 'text').remaining, phase === 'score' ? 5 : 4)
  }
})

test('Arena manager persists model-only429 cooldown and rejects the next submission before score', async () => {
  const f = managerFixture(); f.wire()
  const original = f.manager.evaluate, retryAt = Date.now() + 120000
  let starts = 0
  f.manager.evaluate = async (...args) => {
    if (!args[2].includes('const controller =')) return original(...args)
    starts++
    return { error: 'rate_limited', retryAt, diagnostic: { stage: 'submission', upstreamStatus: 429 } }
  }
  for (let n = 0; n < 2; n++) {
    await assert.rejects(f.manager.chat({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'fixture' }), error => error.code === 'rate_limited' && error.status === 429 && error.retryAt === retryAt && !error.actionRequired)
  }
  assert.equal(starts, 1)
  assert.equal(f.quota.availability('fixture-account', id, 'image').available, true)
  assert.equal(f.quota.availability('another-account', id, 'text').available, true)
  await rejectsCode(f.manager.chat({ profileId, model: 'max', prompt: 'fixture' }), 'invalid_request')
})

test('Arena destroy closes only owned private pipes and concurrent shutdown does not duplicate Browser.close', async () => {
  const f = managerFixture(), calls = []
  let exited = false
  const context = { ...f.context, exited: () => exited, exit: Promise.resolve(), pipe: {
    async send(method) { calls.push(method); exited = true }, close() { calls.push('pipe.close') },
  } }
  f.manager.browsers.set(profileId, Promise.resolve(context))
  assert.equal(f.manager.hasOpenBrowsers(), true)
  await Promise.all([f.manager.destroy(), f.manager.destroy()])
  assert.deepEqual(calls, ['Browser.close', 'pipe.close'])
  assert.equal(f.manager.hasOpenBrowsers(), false)
})

test('Cancelling an Arena page operation while its score is pending prevents the first fetch entirely', async () => {
  const f = pageFixture()
  let score
  f.scope.window.grecaptcha.enterprise.execute = () => new Promise(resolve => { score = resolve })
  const pending = f.run(scripts.arenaStartExpression('fixture-job', '/nextjs-api/stream/create-evaluation', {}))
  await tick()
  f.run(scripts.arenaAbortExpression('fixture-job'))
  score(secret)
  assert.deepEqual(plain(await pending), { error: 'aborted', diagnostic: { stage: 'score' } })
  assert.equal(f.requests.length, 0)
  assert.equal(f.scope['fixture-job'], undefined)
  assert.equal(f.timers.size, 0)
})

test('Arena actual image method rejects unsuccessful terminal reasons even after receiving a valid image', async () => {
  for (const reason of ['cancelled', 'content-filter', 'content_filter', 'length', 'tool-calls', 'unknown', 'error', '']) {
    for (const newline of ['', '\n']) {
      const f = managerFixture()
      f.manager.request = async () => ({ stream: Readable.from(['a2:[{"type":"image","image":"https://cdn.arena.ai/fixture.png"}]\n',
        `ad:${JSON.stringify({ finishReason: reason })}${newline}`]), conversation: {} })
      await rejectsCode(f.manager.generateImage({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'hello' }), 'upstream_error')
    }
  }
})

test('Arena actual image method requires clean EOF after stop and rejects post-terminal data or transport failure', async () => {
  const wire = 'a2:[{"type":"image","image":"https://cdn.arena.ai/fixture.png"}]\nad:{"finishReason":"stop"}\n'
  const f = managerFixture()
  f.manager.request = async () => ({ stream: Readable.from([wire, 'a0:"late data"\n']), conversation: {} })
  await rejectsCode(f.manager.generateImage({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'hello' }), 'upstream_error')
  f.manager.request = async () => ({ stream: Readable.from((async function* () { yield wire; throw new protocol.ArenaError('incomplete_stream') })()), conversation: {} })
  await rejectsCode(f.manager.generateImage({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'hello' }), 'incomplete_stream')
})

test('Arena cancellation cannot become a successful login when an in-flight status check resolves late', async () => {
  const f = managerFixture(), closed = []
  let finishStatus, enteredStatus
  const statusStarted = new Promise(resolve => { enteredStatus = resolve })
  f.manager.context = async () => f.context
  f.manager.status = async () => new Promise(resolve => { finishStatus = resolve; enteredStatus() })
  f.manager.closeProfile = async id => { closed.push(id) }
  const pending = f.manager.startLogin()
  await statusStarted
  f.manager.cancel()
  finishStatus({ authenticated: true, accountInfo: snapshot.accountInfo })
  const result = await pending
  assert.equal(result.success, false)
  assert.equal(result.profileId, undefined)
  assert.equal(closed.length, 1)
})

test('Arena shutdown blocks queued and future browser acquisitions and fresh login', async () => {
  const f = managerFixture()
  let launches = 0, finishClosing
  f.manager.launch = async () => { launches++; return f.context }
  f.manager.closingProfiles.set(profileId, new Promise(resolve => { finishClosing = resolve }))
  const pending = f.manager.context(profileId)
  const closed = f.manager.destroy()
  finishClosing()
  await closed
  await rejectsCode(pending, 'browser_unavailable')
  await rejectsCode(f.manager.context(profileId), 'browser_unavailable')
  assert.equal((await f.manager.startLogin()).success, false)
  assert.equal(launches, 0)
})

test('Arena page applies abort-aware backpressure instead of truncating a valid image larger than 2 MiB', async () => {
  const f = pageFixture()
  f.scope.setTimeout = setTimeout; f.scope.clearTimeout = clearTimeout
  const wire = 'a2:[{"type":"image","mimeType":"image/png","data":"' + Buffer.alloc(2300000, 1).toString('base64') + '"}]\nad:{"finishReason":"stop"}\n'
  let sent = false
  f.scope.fetch = async () => ({ ok: true, status: 200, body: { getReader: () => ({
    read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.from(wire) }), releaseLock() {},
  }) } })
  assert.deepEqual(plain(await f.run(scripts.arenaStartExpression('large-image', '/nextjs-api/stream/create-evaluation', {}))), { started: true })
  let output = '', done = false
  try {
    for (let n = 0; n < 200 && !done; n++) {
      const drained = f.run(scripts.arenaDrainExpression('large-image'))
      assert.equal(drained.error, null)
      assert.ok(f.scope['large-image'].queued <= 2 * 1024 * 1024)
      output += drained.chunks.join(''); done = drained.done
      if (!done) await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.equal(done, true)
    assert.equal(output, wire)
    const decoder = new protocol.ArenaProtocolDecoder()
    const events = decoder.push(output); events.push(...decoder.end())
    assert.equal(events[0].type, 'image')
    assert.equal(events.at(-1).reason, 'stop')
  } finally { f.run(scripts.arenaAbortExpression('large-image')) }
})

test('Arena page cancellation interrupts backpressure without exporting or submitting again', async () => {
  const f = pageFixture()
  f.scope.setTimeout = setTimeout; f.scope.clearTimeout = clearTimeout
  let sent = false
  f.scope.fetch = async () => ({ ok: true, status: 200, body: { getReader: () => ({
    read: async () => sent ? { done: true } : (sent = true, { done: false, value: Buffer.alloc(2300000, 65) }), releaseLock() {},
  }) } })
  await f.run(scripts.arenaStartExpression('blocked-image', '/nextjs-api/stream/create-evaluation', {}))
  const state = f.scope['blocked-image']
  assert.equal(state.done, false)
  f.run(scripts.arenaAbortExpression('blocked-image'))
  await tick()
  assert.equal(state.done, true)
  assert.equal(state.error, 'aborted')
  assert.equal(f.scope['blocked-image'], undefined)
})

test('Arena safe diagnostics distinguish HTTP submission and decoder stages without preserving raw provider data', async () => {
  const f = managerFixture(); f.wire()
  const original = f.manager.evaluate
  f.manager.evaluate = async (context, session, expression) => expression.includes('const controller =')
    ? { error: 'upstream_error', diagnostic: { stage: 'submission', upstreamStatus: 400, request: secret, response: secret } }
    : original(context, session, expression)
  await assert.rejects(f.manager.chat({ accountId: 'fixture-account', profileId, model: 'max', prompt: 'hello' }), error => {
    assert.deepEqual(plain(error.diagnostic), { stage: 'submission', upstreamStatus: 400 })
    assert.doesNotMatch(JSON.stringify(error), /fixture-cookie|request|response/)
    return error.code === 'upstream_error'
  })
  assert.throws(() => new protocol.ArenaProtocolDecoder().push('az:"' + secret + '"\n'), error => {
    assert.deepEqual(plain(error.diagnostic), { stage: 'decode', protocolCode: 'z' })
    assert.doesNotMatch(JSON.stringify(error), /fixture-cookie/)
    return error.code === 'upstream_error'
  })
  const invalid = new protocol.ArenaError('upstream_error', { stage: 'decode', upstreamStatus: 999, protocolCode: secret, raw: secret })
  assert.deepEqual(plain(invalid.diagnostic), { stage: 'decode' })
  assert.equal(new protocol.ArenaError('upstream_error', { stage: secret }).diagnostic, undefined)
})

function readinessFixture() {
  let now = 0, sleeps = 0
  class Clock extends Date { static now() { return now } }
  const f = managerFixture({ Date: Clock, setTimeout(callback, milliseconds) { now += milliseconds; sleeps++; Promise.resolve().then(callback); return sleeps }, clearTimeout() {} })
  f.wire()
  return { ...f, get sleeps() { return sleeps }, get elapsed() { return now } }
}

test('Arena cold-profile status waits for initial target and current React hydration without submitting', async () => {
  const f = readinessFixture()
  let targets = 0, snapshots = 0
  f.manager.page = async () => { targets++; if (targets === 1) throw new protocol.ArenaError('action_required'); return { targetId: 'owned', sessionId: 'ready-session' } }
  f.manager.evaluate = async (_, __, expression) => { assert.equal(expression, scripts.ARENA_RUNTIME_SNAPSHOT); snapshots++; return snapshots === 1 ? { ...snapshot, ready: false } : snapshot }
  const result = await f.manager.status(profileId)
  assert.equal(result.authenticated, true)
  assert.equal(targets, 3)
  assert.equal(snapshots, 2)
  assert.equal(f.elapsed, 500)
  assert.equal(f.calls.filter(call => call.method === 'Target.detachFromTarget').length, 2)
})

test('Arena readiness does not wait on an already hydrated logged-out account', async () => {
  const f = readinessFixture()
  f.manager.evaluate = async () => ({ ready: true, authenticated: false, accountInfo: {}, models: [] })
  assert.equal((await f.manager.status(profileId)).authenticated, false)
  assert.equal(f.sleeps, 0)
  await rejectsCode(f.manager.getModels(profileId), 'action_required')
  assert.equal(f.sleeps, 0)
})

test('Arena hydration wait is bounded at 30 seconds and respects cancellation', async () => {
  const f = readinessFixture()
  f.manager.evaluate = async () => ({ ...snapshot, ready: false })
  await assert.rejects(f.manager.getModels(profileId), error => error.errorCode === 'page_not_ready')
  assert.equal(f.elapsed, 30000)
  const abort = new AbortController(), g = readinessFixture()
  g.manager.evaluate = async () => { abort.abort(); return { ...snapshot, ready: false } }
  await rejectsCode(g.manager.getModels(profileId, abort.signal), 'aborted')
  assert.equal(g.sleeps, 0)
})

test('Arena profile ownership permits only Windows case normalization, never symlinks or redirected paths', async () => {
  for (const platform of ['win32', 'linux']) {
    const f = managerFixture({ process: { platform } })
    const directory = await f.api.arenaProfileDirectory(profileId, true)
    const directoryRoot = path.dirname(directory)
    f.files.entries.get(directoryRoot).realpath = directoryRoot.toUpperCase()
    f.files.entries.get(directory).realpath = directory.toUpperCase()
    if (platform === 'win32') assert.equal(await f.api.arenaProfileDirectory(profileId), directory)
    else await assert.rejects(f.api.arenaProfileDirectory(profileId), error => error.errorCode === 'profile_unavailable')
    f.files.entries.get(directoryRoot).link = true
    await assert.rejects(f.api.arenaProfileDirectory(profileId), error => error.errorCode === 'profile_unavailable')
    const fresh = await f.manager.startLogin()
    assert.equal(fresh.errorCode, 'profile_unavailable')
    assert.doesNotMatch(JSON.stringify(fresh), /fixture-cookie|arena-unit-profile-fixture/)
  }
})

function launchFixture(options = {}) {
  const { EventEmitter } = require('node:events'), { PassThrough, Writable } = require('node:stream')
  const { CdpPipe } = load('../oauth/cdpPipe')
  const children = [], commands = []
  const f = managerFixture({ setTimeout: (fn, ms) => setTimeout(fn, ms === 5000 ? 1 : ms) }, {
    '../oauth/browserDiscovery': {
      async findInstalledLoginBrowser() { if (options.failure === 'discovery') throw Error(secret); return { name: 'Chrome', executable: 'fixture.exe' } },
      loginBrowserArguments: () => ['--remote-debugging-pipe', 'https://fixture.invalid/'], browserChildEnvironment: () => ({}),
    },
    '../oauth/cdpPipe': { CdpPipe },
    'node:child_process': { spawn() {
      if (options.failure === 'spawn') throw Error(secret)
      const child = new EventEmitter(), output = new PassThrough()
      const input = new Writable({ write(chunk, _encoding, done) {
        const request = JSON.parse(chunk.toString().slice(0, -1)); commands.push(request.method)
        queueMicrotask(() => {
          if (request.method === 'Browser.getVersion' && ['handshake-exit', 'handshake-live', 'spawn-event'].includes(options.failure)) {
            if (options.failure === 'spawn-event') child.emit('error', Error(secret))
            if (options.failure === 'handshake-exit') child.emit('exit', 1)
            output.end(); return
          }
          if (request.method === 'Browser.close' && !options.refuseClose) child.emit('exit', 0)
          output.write(JSON.stringify({ id: request.id, ...(request.method === 'Browser.close' && options.refuseClose
            ? { error: { message: secret } } : { result: {} }) }) + '\0')
        })
        done()
      } })
      child.stdio = [null, null, null, input, output]
      children.push(child)
      return child
    } },
  })
  f.manager.readyPage = async () => ({ targetId: 'owned', sessionId: 'fixture', snapshot })
  return { ...f, children, commands }
}

test('Arena actual launch classifies discovery, spawn and real private-pipe handshake failures for new and existing logins', async () => {
  for (const [failure, expected] of [['discovery', 'browser_not_found'], ['spawn', 'browser_start_failed'],
    ['spawn-event', 'browser_start_failed'], ['handshake-exit', 'browser_connection_failed'], ['handshake-live', 'browser_connection_failed']]) {
    for (const existing of [false, true]) {
      const f = launchFixture({ failure })
      if (existing) await f.api.arenaProfileDirectory(profileId, true)
      const result = existing ? await f.manager.reauthenticate({ profileId, expectedEmail: snapshot.accountInfo.email, isAccountCurrent: () => true }) : await f.manager.startLogin()
      assert.equal(result.success, false, failure)
      assert.equal(result.errorCode, expected, failure)
      assert.doesNotMatch(JSON.stringify(result), /fixture-cookie|fixture\.exe|arena-unit-profile-fixture/)
      assert.equal(f.commands.filter(method => method === 'Browser.getVersion').length, ['discovery', 'spawn'].includes(failure) ? 0 : 1)
      assert.equal(f.commands.includes('Browser.close'), false, 'A lost pipe never closes a possibly visible manual browser')
      if (failure === 'handshake-live') {
        const retainedId = [...f.manager.ownedBrowsers.keys()][0]
        await assert.rejects(f.manager.context(retainedId), error => error.errorCode === 'browser_connection_failed')
        assert.equal(f.children.length, 1)
        f.children[0].emit('exit', 0)
        await f.manager.closeProfile(retainedId)
      }
    }
  }
})

test('Arena real CDP disconnection retains a live browser without reusing, closing or relaunching it', async () => {
  const f = launchFixture()
  await f.api.arenaProfileDirectory(profileId, true)
  const context = await f.manager.context(profileId)
  context.pipe.close()
  assert.equal(context.exited(), false)
  await assert.rejects(f.manager.context(profileId), error => error.errorCode === 'browser_connection_failed')
  assert.deepEqual(plain(await f.manager.status(profileId)), { authenticated: false, ready: false, actionRequired: true, errorCode: 'browser_connection_failed' })
  const result = await f.manager.reauthenticate({ profileId, expectedEmail: snapshot.accountInfo.email, isAccountCurrent: () => true })
  assert.equal(result.errorCode, 'browser_connection_failed')
  assert.equal(f.children.length, 1)
  assert.equal(f.commands.includes('Browser.close'), false)
  f.children[0].emit('exit', 0)
  await f.manager.context(profileId)
  assert.equal(f.children.length, 2, 'Only an exited owned process permits a fresh private pipe')
  await f.manager.destroy()
})

test('Arena failed Browser.close retains ownership until actual process exit and prevents duplicate launch', async () => {
  const f = launchFixture({ refuseClose: true })
  await f.api.arenaProfileDirectory(profileId, true)
  await f.manager.context(profileId)
  await f.manager.closeProfile(profileId)
  assert.equal(f.manager.hasOpenBrowsers(), true)
  assert.equal(f.manager.ownedBrowsers.size, 1)
  await assert.rejects(f.manager.context(profileId), error => error.errorCode === 'browser_connection_failed')
  assert.equal(f.children.length, 1)
  f.children[0].emit('exit', 0)
  await f.manager.closeProfile(profileId)
  assert.equal(f.manager.hasOpenBrowsers(), false)
})

test('Arena unreadable page status reports page_not_ready rather than a confirmed logout', async () => {
  const f = readinessFixture()
  f.manager.evaluate = async () => ({ ...snapshot, ready: false })
  assert.deepEqual(plain(await f.manager.status(profileId)), { authenticated: false, ready: false, actionRequired: true, errorCode: 'page_not_ready' })
  assert.equal(f.elapsed, 30000)
  const g = managerFixture(); g.manager.context = async () => g.context
  let checks = 0
  g.manager.status = async () => { checks++; return { authenticated: false, ready: false, errorCode: 'page_not_ready' } }
  g.manager.closeProfile = async () => undefined
  assert.equal((await g.manager.startLogin()).errorCode, 'page_not_ready')
  assert.equal(checks, 1, 'A failed inspection must not poll as if waiting on a known logged-out account')
})

test('Arena initial props alone never claim hydration; both live user and model stores are required', () => {
  const initial = { initialUser: { email: 'initial@example.test' }, initialModels: [model] }
  assert.equal(runtimeSnapshot([initial]).ready, false)
  assert.equal(runtimeSnapshot([initial, { getState: () => ({ models: [model] }) }]).ready, false)
  assert.equal(runtimeSnapshot([initial, { getState: () => ({ user: { email: 'live@example.test' } }) }, { getState: () => ({ models: [model] }) }]).ready, true)
})

test('Arena failed-submission hints expose only bounded enums and schema issue paths, never actual values', async () => {
  const problem = { error: 'Validation failed: UUID version 7 timestamp required ' + secret,
    issues: [{ path: ['id'], code: 'custom', message: 'Invalid UUID v7' }, { path: [secret], code: secret, received: secret }],
    request: { token: secret, prompt: secret }, details: { actual: secret } }
  const f = pageFixture({ status: 400, problem })
  const result = plain(await f.run(scripts.arenaStartExpression('fixture-hints', '/nextjs-api/stream/create-evaluation', {})))
  assert.deepEqual(result, { error: 'upstream_error', diagnostic: { stage: 'submission', upstreamStatus: 400,
    errorHints: ['uuid', 'v7', 'validation', 'required', 'timestamp', 'time', 'version'], issuePaths: ['id'], issueCodes: ['custom'] } })
  const error = new protocol.ArenaError('upstream_error', { ...result.diagnostic, errorHints: [...result.diagnostic.errorHints, secret],
    issuePaths: ['id', 'userMessage.content', secret], issueCodes: ['custom', secret], response: problem })
  assert.deepEqual(plain(error.diagnostic.issuePaths), ['id', 'userMessage.content'])
  assert.deepEqual(plain(error.diagnostic.issueCodes), ['custom'])
  assert.doesNotMatch(JSON.stringify(error), /fixture-cookie|received|response|actual|prompt/)
  assert.equal(f.requests.length, 1)
})

test('Arena failed-submission body parsing stops at 64 KiB without exporting or retrying the oversized body', async () => {
  const f = pageFixture()
  let reads = 0, cancelled = 0
  f.scope.fetch = async () => ({ ok: false, status: 400, body: { getReader: () => ({
    read: async () => { reads++; return { done: false, value: Buffer.alloc(65537, 65) } },
    async cancel() { cancelled++ }, releaseLock() {},
  }) } })
  const result = plain(await f.run(scripts.arenaStartExpression('oversized-error', '/nextjs-api/stream/create-evaluation', {})))
  assert.deepEqual(result, { error: 'upstream_error', diagnostic: { stage: 'submission', upstreamStatus: 400, errorHints: [] } })
  assert.equal(reads, 1)
  assert.equal(cancelled, 1)
  assert.equal(f.timers.size, 0)
})
