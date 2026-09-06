const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')
const ts = require('typescript')
const root = join(__dirname, '..', '..')
const plain = value => JSON.parse(JSON.stringify(value))

function load(file, mocks) {
  const module = { exports: {} }
  const source = ts.transpileModule(readFileSync(join(root, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(source, { module, exports: module.exports, Date, console: { log() {}, error() {} },
    require(name) {
      if (name.endsWith('/shared/accountAvailability')) return require('../../src/shared/accountAvailability.ts')
      if (name === 'node:timers') return require('node:timers')
      if (name === '../arena/rateLimit') return { getArenaModelAvailability: () => ({ available: true, reason: 'ready' }) }
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('.')) return {}
      return require(name)
    },
  }, { filename: file })
  return module.exports
}

async function setup(initial = []) {
  const identity = await import(pathToFileURL(join(root, 'src/shared/accountIdentity.ts')))
  const { storeManager } = load('src/main/store/store.ts', {
    electron: {}, '../../shared/accountIdentity': identity,
  })
  let data = { accounts: initial, providers: [{ id: 'deepseek', name: 'DeepSeek' }] }
  storeManager.store = { get: key => data[key], set: (key, value) => { data = { ...data, [key]: value } } }
  storeManager.isInitialized = true
  storeManager.encryptCredentials = value => ({ token: `encrypted:${value.token}` })
  storeManager.decryptCredentials = value => ({ token: value.token.replace(/^encrypted:/, '') })
  storeManager.addLog = () => {}
  let serial = 0
  storeManager.generateId = () => `account-id-${++serial}`
  let validation = { valid: true, accountInfo: { email: 'verified@example.test', userId: 'provider-1' } }
  const { AccountManager } = load('src/main/store/accounts.ts', {
    './store': { storeManager }, '../../shared/accountIdentity': identity,
    './validator': { validateCredentials: async () => validation },
  })
  return { storeManager, AccountManager, getData: () => data, setValidation: value => { validation = value } }
}

test('new account creation uses email or independent fallback and encrypted persistent copies', async () => {
  const { AccountManager, getData } = await setup()
  const first = AccountManager.create({ providerId: 'deepseek', email: 'one@example.test', credentials: { token: 'fixture-1' } })
  const second = AccountManager.create({ providerId: 'deepseek', credentials: { token: 'fixture-2' } })
  const third = AccountManager.create({ providerId: 'deepseek', credentials: { token: 'fixture-3' } })
  assert.equal(first.name, 'one@example.test')
  assert.equal(first.nameSource, 'auto')
  assert.notEqual(second.name, third.name)
  assert.equal(getData().accounts[0].credentials.token, 'encrypted:fixture-1')
  assert.equal(first.credentials.token, 'fixture-1')
})

test('migration persists labels without decrypting stored credentials and preserves custom labels', async () => {
  const initial = [
    { id: 'a', providerId: 'deepseek', name: 'DeepSeek 账户', email: 'old@example.test', credentials: { token: 'encrypted:fixture' } },
    { id: 'b', providerId: 'deepseek', name: 'My custom name', email: 'other@example.test', credentials: { token: 'encrypted:other' } },
  ]
  const { storeManager, getData } = await setup(initial)
  storeManager.decryptCredentials = () => { throw new Error('Migration must not decrypt') }
  storeManager.initializeAccountNames()
  assert.equal(getData().accounts[0].name, 'old@example.test')
  assert.equal(getData().accounts[1].name, 'My custom name')
  assert.equal(initial[0].name, 'DeepSeek 账户')
  assert.equal(getData().accounts[0].credentials, initial[0].credentials)
  const migrated = getData().accounts
  storeManager.initializeAccountNames()
  assert.equal(getData().accounts, migrated)
})

test('successful validation enriches automatic labels; edits freeze custom names; invalid validation does not rename', async () => {
  const { AccountManager, getData, setValidation } = await setup()
  const created = AccountManager.create({ providerId: 'deepseek', credentials: { token: 'fixture' } })
  await AccountManager.validate(created.id)
  assert.equal(getData().accounts[0].name, 'verified@example.test')
  assert.equal(getData().accounts[0].providerUserId, 'provider-1')
  const updated = AccountManager.update(created.id, { name: 'Work' })
  assert.equal(updated.nameSource, 'custom')
  await AccountManager.validate(created.id)
  assert.equal(getData().accounts[0].name, 'Work')
  setValidation({ valid: false, error: 'invalid', accountInfo: { email: 'wrong@example.test' } })
  await AccountManager.validate(created.id)
  assert.equal(getData().accounts[0].email, 'verified@example.test')
  assert.equal(getData().accounts[0].status, 'error')
  AccountManager.update(created.id, { name: '' })
  assert.equal(getData().accounts[0].name, 'verified@example.test')
})

test('successful validation without an email does not clear a previously saved identity', async () => {
  const { AccountManager, getData, setValidation } = await setup()
  const created = AccountManager.create({ providerId: 'deepseek', email: 'existing@example.test', credentials: { token: 'fixture' } })
  setValidation({ valid: true, accountInfo: { name: 'Generic User' } })
  await AccountManager.validate(created.id)
  assert.equal(getData().accounts[0].name, 'existing@example.test')
  assert.equal(getData().accounts[0].email, 'existing@example.test')
})

test('account updates do not mutate earlier snapshots or log credential contents', async () => {
  const { AccountManager, getData } = await setup()
  const created = AccountManager.create({ providerId: 'deepseek', credentials: { token: 'fixture' } })
  const before = plain(getData())
  const snapshot = getData().accounts
  AccountManager.update(created.id, { name: 'Changed', credentials: { token: 'replacement' } })
  assert.deepEqual(plain(snapshot), before.accounts)
  const source = readFileSync(join(root, 'src/main/store/store.ts'), 'utf8')
  const update = source.slice(source.indexOf('  updateAccount('), source.indexOf('  deleteAccount('))
  assert.doesNotMatch(update, /console\.(log|error|warn)/)
})
