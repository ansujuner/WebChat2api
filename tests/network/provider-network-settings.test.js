const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const settings = require('../../src/shared/providerNetwork.ts')
const plain = value => JSON.parse(JSON.stringify(value))

test('provider routing settings retain inheritance and validate all four explicit modes', () => {
  for (const mode of [undefined, 'inherit', 'none', 'system']) settings.validateProviderNetworkSettings({ networkProxyMode: mode })
  settings.validateProviderNetworkSettings({ networkProxyMode: 'custom', networkProxyUrl: 'http://127.0.0.1:7890' })
  for (const mode of [null, '', false, 123, [], {}, 'direct', '__proto__']) assert.throws(() => settings.validateProviderNetworkSettings({ networkProxyMode: mode }))
  assert.throws(() => settings.validateProviderNetworkSettings({ networkProxyMode: 'custom' }))
})

test('proxy endpoint normalization is deterministic and forbids secret-bearing or PAC-style URLs', () => {
  for (const [input, expected] of [
    [' http://LOCALHOST:07890/ ', 'http://localhost:7890'], ['https://proxy.example.test:443', 'https://proxy.example.test:443'],
    ['socks5://[::1]:1080/', 'socks5://[::1]:1080'], ['http://127.0.0.1:80', 'http://127.0.0.1:80'],
  ]) assert.equal(settings.normalizeProviderProxyUrl(input), expected)
  for (const value of [null, {}, '', '127.0.0.1:7890', 'http://proxy.test', 'http://proxy.test:0', 'http://proxy.test:65536',
    'http://user:SECRET@proxy.test:7890', 'http://proxy.test:7890?SECRET', 'http://proxy.test:7890/#SECRET',
    'http://proxy.test:7890/a.pac', 'file:///proxy:7890', 'ftp://proxy.test:21', 'socks4://proxy.test:1080',
    'http://proxy.test:7890\r\nX-Secret:a', 'http://proxy.test\\:7890', 'http://proxy.test:7890#', 'http://proxy.test:7890?',
    'http://proxy.test;https=evil.test:7890', 'http://proxy.test%3bhttps%3devil.test:7890',
    'socks5://proxy.test,evil.test:1080', 'socks5://proxy.test%00:1080', 'socks5://proxy.test;DIRECT:1080',
    'http:///proxy.test:7890', 'http://-invalid.test:7890', 'http://a..test:7890',
  ]) assert.throws(() => settings.normalizeProviderProxyUrl(value), error => !error.message.includes('SECRET'))
})

function fixture(initial) {
  const source = readFileSync(join(__dirname, '../../src/main/store/store.ts'), 'utf8')
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, console, Date, Buffer, require(name) {
      if (name === '../../shared/providerNetwork') return settings
      if (name === './types') return { BUILTIN_PROVIDERS: [{ id: 'zai', apiEndpoint: 'https://chat.z.ai/api', headers: {}, supportedModels: ['fixture'] }] }
      if (name.startsWith('.') || name === 'electron') return {}
      return require(name)
    } })
  const store = module.exports.storeManager
  let rows = initial, writes = 0
  store.isInitialized = true
  store.store = { get: key => key === 'providers' ? rows : undefined, set: (key, next) => { if (key === 'providers') { rows = next; writes++ } } }
  return { store, rows: () => rows, writes: () => writes }
}

test('real store updates only the selected channel immutably and rejects invalid partial combinations before writing', () => {
  const original = Object.freeze([Object.freeze({ id: 'one', networkProxyMode: 'none' }), Object.freeze({ id: 'two', networkProxyMode: 'system' })])
  const f = fixture(original)
  const updated = f.store.updateProvider('one', { networkProxyMode: 'custom', networkProxyUrl: 'http://LOCALHOST:07890/' })
  assert.equal(updated.networkProxyUrl, 'http://localhost:7890')
  assert.equal(f.rows()[1], original[1]); assert.equal(original[0].networkProxyMode, 'none')
  assert.notEqual(f.rows(), original)
  f.store.updateProvider('one', { networkProxyMode: 'none' })
  assert.equal(f.rows()[0].networkProxyUrl, 'http://localhost:7890', 'Switching direct retains the saved address without using it')
  const baseline = plain(f.rows()), writes = f.writes()
  for (const value of [{ networkProxyMode: 'nonsense' }, { networkProxyUrl: 'http://SECRET@proxy:80' }, { networkProxyMode: 'custom', networkProxyUrl: undefined }]) {
    assert.throws(() => f.store.updateProvider('one', value))
    assert.deepEqual(plain(f.rows()), baseline); assert.equal(f.writes(), writes)
  }
  assert.throws(() => f.store.addProvider({ id: 'bad', networkProxyMode: 'custom' }))
  assert.equal(f.writes(), writes)
})

test('normal builtin synchronization preserves each saved proxy override and does not fill legacy missing mode', async () => {
  const f = fixture([{ id: 'zai', type: 'builtin', networkProxyMode: 'custom', networkProxyUrl: 'http://127.0.0.1:7890' },
    { id: 'custom', type: 'custom', apiEndpoint: 'http://localhost:1234/v1' }])
  await f.store.initializeDefaultProviders()
  assert.equal(f.rows()[0].networkProxyMode, 'custom'); assert.equal(f.rows()[0].networkProxyUrl, 'http://127.0.0.1:7890')
  assert.equal(f.rows()[1].networkProxyMode, undefined)
})

test('provider network IPC accepts only saved provider IDs and never accepts arbitrary target URLs or credentials', () => {
  const handlers = readFileSync(join(__dirname, '../../src/main/ipc/handlers.ts'), 'utf8')
  const start = handlers.indexOf('ipcMain.handle(IpcChannels.PROVIDERS_GET_NETWORK_STATUS,')
  const block = handlers.slice(start, handlers.indexOf('\n  ipcMain.handle(', start + 1))
  assert.ok(start > 0)
  assert.match(block, /id: unknown/)
  assert.match(block, /ProviderManager\.getById\(id\)/)
  assert.match(block, /getNetworkProxyStatus\(id, provider\.apiEndpoint\)/)
  assert.doesNotMatch(block, /getAccounts|credentials\s*[:.=]|\.token/)
})
