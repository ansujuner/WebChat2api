const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
function modules() {
  const cache = {}
  const load = name => {
    if (cache[name]) return cache[name]
    const filename = path.join(root, 'src/main/arena', `${name}.ts`), module = { exports: {} }
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText, { module, exports: module.exports, Buffer, URL, require(name) {
      if (name === './protocol') return load('protocol')
      assert.ok(name.startsWith('node:'), `Unexpected dependency ${name}`)
      return require(name)
    } }, { filename })
    return cache[name] = module.exports
  }
  return { ...load('rateLimit'), ...load('protocol') }
}
const api = modules(), account = 'account-one', modelId = '019f42b5-8c52-7793-9be8-de35eecf7ea9', other = '019b24bb-5caf-71c3-b854-37d0c7086f21'
const seedream = { id: modelId, name: 'seedream-5.0-pro', modality: 'image' }
function fixture() {
  let now = Date.UTC(2026, 8, 6), data = { version: 1, updatedAt: 0, buckets: {} }, fail = false
  const storage = { read: () => data, write: value => { if (fail) throw Error('PRIVATE-LOCAL-PATH'); data = plain(value) } }
  const quota = new api.ArenaRateLimiter(storage, () => now)
  return { quota, storage, get data() { return data }, advance: ms => { now += ms }, now: () => now, fail: () => { fail = true } }
}

test('Seedream user default allows five attempts in a rolling hour, not a wall-clock hour', () => {
  const f = fixture(); f.quota.observeModel(account, seedream)
  for (let n = 0; n < 5; n++) { f.quota.reserve(account, modelId, 'image'); f.advance(1000) }
  const status = f.quota.availability(account, modelId, 'image')
  assert.equal(status.available, false); assert.equal(status.reason, 'model_quota'); assert.equal(status.remaining, 0)
  assert.equal(status.availableAt, f.now() - 5000 + 3600000)
  assert.throws(() => f.quota.reserve(account, modelId, 'image'), error => error.code === 'rate_limited' && error.status === 429 && error.retryAt === status.availableAt)
  f.advance(3594999); assert.equal(f.quota.availability(account, modelId, 'image').available, false)
  f.advance(1); assert.equal(f.quota.availability(account, modelId, 'image').remaining, 1)
})

test('Concurrent last-slot reservations serialize before submission and cannot overspend', async () => {
  const f = fixture(); f.quota.observeModel(account, seedream)
  for (let n = 0; n < 4; n++) f.quota.reserve(account, modelId, 'image')
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => Promise.resolve().then(() => f.quota.reserve(account, modelId, 'image'))))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'rate_limited').length, 24)
  assert.equal(Object.values(f.data.buckets)[0].attempts.length, 5)
})

test('Account, native model and modality scopes are independent; aliases share native-ID quota', () => {
  const f = fixture(); f.quota.observeModel(account, seedream)
  for (let n = 0; n < 5; n++) f.quota.reserve(account, modelId.toUpperCase(), 'image')
  assert.equal(f.quota.availability(account, modelId, 'image').available, false)
  for (const [a, id, modality] of [['account-two', modelId, 'image'], [account, other, 'image'], [account, modelId, 'text']]) {
    assert.equal(f.quota.availability(a, id, modality).available, true)
    assert.equal(f.quota.availability(a, id, modality).limit, undefined)
  }
  f.quota.observeModel('account-two', { ...seedream, name: 'Friendly Seedream label', publicName: seedream.name })
  assert.equal(f.quota.availability('account-two', modelId, 'image').limit, 5)
})

test('Unknown models get no fabricated limit; verified official policies override the user default', () => {
  const f = fixture(); f.quota.observeModel(account, { id: other, name: 'unknown', modality: 'image' })
  for (let n = 0; n < 10005; n++) f.quota.reserve(account, other, 'image')
  assert.equal(f.quota.availability(account, other, 'image').available, true)
  assert.equal(f.quota.availability(account, other, 'image').limit, undefined)
  assert.equal(Object.values(f.data.buckets)[0].attempts.length, 0)
  f.quota.setOfficialPolicy(account, other, 'image', { limit: 3, windowMs: 60000 })
  assert.equal(f.quota.availability(account, other, 'image').remaining, 3)
  f.quota.observeModel(account, seedream)
  f.quota.setOfficialPolicy(account, modelId, 'image', { limit: 2, windowMs: 120000 })
  f.quota.observeModel(account, seedream)
  const value = f.quota.availability(account, modelId, 'image')
  assert.equal(value.limit, 2); assert.equal(value.windowMs, 120000)
})

test('Known models retain only the actual policy window, not thirty days of history', () => {
  const f = fixture(); f.quota.observeModel(account, seedream)
  f.quota.reserve(account, modelId, 'image')
  f.advance(3600000)
  f.quota.reserve(account, modelId, 'image')
  assert.equal(Object.values(f.data.buckets)[0].attempts.length, 1)
  assert.equal(f.quota.availability(account, modelId, 'image').remaining, 4)
})

test('Reservations survive reload/crash; only explicit proven pre-submission release refunds them', () => {
  const f = fixture(); f.quota.observeModel(account, seedream)
  const reservation = f.quota.reserve(account, modelId, 'image')
  let restarted = new api.ArenaRateLimiter(f.storage, f.now)
  assert.equal(restarted.availability(account, modelId, 'image').remaining, 4)
  restarted.releaseBeforeSubmission(reservation)
  restarted.releaseBeforeSubmission(reservation)
  restarted = new api.ArenaRateLimiter(f.storage, f.now)
  assert.equal(restarted.availability(account, modelId, 'image').remaining, 5)
})

test('Runtime model cooldown and upstream429 persist without disabling another model/account', () => {
  const f = fixture(), reset = f.now() + 120000
  f.quota.observeModel(account, { ...seedream, rateLimitedUntil: reset })
  assert.equal(f.quota.availability(account, modelId, 'image').availableAt, reset)
  f.quota.cooldown(account, modelId, 'image', f.now() + 1000)
  const restarted = new api.ArenaRateLimiter(f.storage, f.now)
  assert.equal(restarted.availability(account, modelId, 'image').reason, 'upstream_cooldown')
  assert.equal(restarted.availability(account, modelId, 'image').availableAt, reset)
  assert.equal(restarted.availability(account, other, 'image').available, true)
  assert.equal(restarted.availability('account-two', modelId, 'image').available, true)
  f.advance(120000); assert.equal(restarted.availability(account, modelId, 'image').available, true)
})

test('Expired or malformed upstream reset uses a conservative one-minute cooldown, not permanent disable', () => {
  const f = fixture()
  for (const value of [undefined, NaN, Infinity, -1, f.now() - 10]) {
    assert.equal(f.quota.cooldown(account, modelId, 'image', value), f.now() + 60000)
  }
  f.advance(60000); assert.equal(f.quota.availability(account, modelId, 'image').available, true)
})

test('Persistence failures fail closed before sending and never leak raw filesystem errors', () => {
  const f = fixture(); f.quota.observeModel(account, seedream); f.fail()
  assert.throws(() => f.quota.reserve(account, modelId, 'image'), error => error.code === 'quota_unavailable' && error.status === 503 && !error.message.includes('PRIVATE'))
  assert.equal(f.quota.availability(account, modelId, 'image').reason, 'storage_error')
  assert.throws(() => f.quota.reserve(account, other, 'image'), { code: 'quota_unavailable' })
  assert.equal(Object.values(f.data.buckets)[0].attempts.length, 0)
})

test('Clock rollback cannot restore a consumed slot and expiration getter is read-only', () => {
  const f = fixture(); f.quota.observeModel(account, seedream)
  for (let n = 0; n < 5; n++) f.quota.reserve(account, modelId, 'image')
  const before = JSON.stringify(f.data); f.advance(-86400000)
  assert.equal(f.quota.availability(account, modelId, 'image').available, false)
  assert.equal(JSON.stringify(f.data), before)
})

test('Corrupt ledger and invalid identities/policies are rejected rather than resetting history', () => {
  for (const value of [null, [], {}, { version: 1, updatedAt: 0, buckets: { secret: {} } }]) {
    assert.throws(() => new api.ArenaRateLimiter({ read: () => value, write() { assert.fail('must not write') } }))
  }
  const f = fixture()
  for (const value of ['', '../account', 'private@email.test', 'a:b', 'x'.repeat(161)]) assert.throws(() => f.quota.reserve(value, modelId, 'image'), { code: 'invalid_request' })
  for (const policy of [{ limit: 0, windowMs: 1 }, { limit: 1.5, windowMs: 1000 }, { limit: 1, windowMs: Infinity }]) assert.throws(() => f.quota.setOfficialPolicy(account, modelId, 'image', policy), { code: 'invalid_request' })
  assert.equal(api.getArenaModelAvailability(account, modelId, 'image').reason, 'uninitialized')
})

test('Actual atomic app-owned ledger survives restart and corruption without reading user profiles', t => {
  const base = path.join(root, '.audit-cache'); fs.mkdirSync(base, { recursive: true })
  const directory = fs.mkdtempSync(path.join(base, 'arena-quota-unit-'))
  t.after(() => { const resolved = path.resolve(directory); assert.ok(resolved.startsWith(base + path.sep)); fs.rmSync(resolved, { recursive: true, force: true }) })
  const storage = api.createArenaRateLimitStorage(directory), quota = new api.ArenaRateLimiter(storage)
  quota.observeModel(account, seedream); quota.reserve(account, modelId, 'image')
  const again = new api.ArenaRateLimiter(api.createArenaRateLimitStorage(directory))
  assert.equal(again.availability(account, modelId, 'image').remaining, 4)
  const ledgerDirectory = path.join(directory, 'arena-rate-limits')
  assert.deepEqual(fs.readdirSync(ledgerDirectory), ['ledger-v1.json'])
  const ledgerPath = path.join(ledgerDirectory, 'ledger-v1.json')
  assert.doesNotMatch(fs.readFileSync(ledgerPath, 'utf8'), /cookie|token|email|profile|prompt/i)
  fs.writeFileSync(ledgerPath, '{truncated')
  assert.throws(() => new api.ArenaRateLimiter(api.createArenaRateLimitStorage(directory)))
  assert.equal(fs.readFileSync(ledgerPath, 'utf8'), '{truncated')
})

test('Actual storage refuses an owned-directory junction', t => {
  const base = path.join(root, '.audit-cache'), directory = fs.mkdtempSync(path.join(base, 'arena-quota-unit-'))
  t.after(() => { const resolved = path.resolve(directory); assert.ok(resolved.startsWith(base + path.sep)); fs.rmSync(resolved, { recursive: true, force: true }) })
  const linked = path.join(directory, 'outside-fixture'); fs.mkdirSync(linked)
  fs.symlinkSync(linked, path.join(directory, 'arena-rate-limits'), 'junction')
  assert.throws(() => api.createArenaRateLimitStorage(directory), { code: 'quota_unavailable' })
})
