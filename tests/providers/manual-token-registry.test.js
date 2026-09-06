const test = require('node:test'), assert = require('node:assert/strict'), ts = require('typescript'), vm = require('node:vm')
const { readFileSync } = require('node:fs')
const { EventEmitter } = require('node:events')
function load(file, mocks) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, console: { log() {}, error() {} }, require(name) {
      if (name === '../network/providerContext.ts' || name === '../network/providerContext') return require('../../src/main/network/providerContext.ts')
      if (name === '../network/proxy') return require('../../src/main/network/providerContext.ts')
      assert.ok(Object.hasOwn(mocks, name), `Unmocked dependency forbidden: ${name}`); return mocks[name]
    } })
  return module.exports
}
const plain = value => JSON.parse(JSON.stringify(value))

test('public manual-login metadata covers every registered provider without enabling manual Arena credentials', async () => {
  const { MANUAL_TOKEN_CONFIGS } = await import('../../src/main/oauth/types.ts')
  const { builtinProviders } = await import('../../src/main/providers/builtin/index.ts')
  assert.deepEqual(Object.keys(MANUAL_TOKEN_CONFIGS).sort(), builtinProviders.map(p => p.id).sort())
  assert.deepEqual(MANUAL_TOKEN_CONFIGS.arena, [])
  for (const [id, configs] of Object.entries(MANUAL_TOKEN_CONFIGS)) for (const config of configs) {
    assert.equal(config.providerType, id)
    assert.ok(['jwt', 'refresh', 'access', 'cookie', 'token'].includes(config.tokenType))
    assert.ok(config.label && config.placeholder && config.description)
  }
})

test('MiMo metadata identifies all three required cookies and Z.ai identifies its canonical JWT field', async () => {
  const { MANUAL_TOKEN_CONFIGS } = await import('../../src/main/oauth/types.ts')
  const { mimoConfig } = await import('../../src/main/providers/builtin/mimo.ts')
  const { zaiConfig } = await import('../../src/main/providers/builtin/zai.ts')
  for (const provider of [mimoConfig, zaiConfig]) {
    assert.deepEqual(MANUAL_TOKEN_CONFIGS[provider.id].map(c => c.credentialKey), provider.credentialFields.filter(c => c.required).map(c => c.name))
    assert.ok(MANUAL_TOKEN_CONFIGS[provider.id].every(c => c.helpUrl === (provider.id === 'mimo' ? provider.apiEndpoint : 'https://chat.z.ai')))
  }
  assert.equal(MANUAL_TOKEN_CONFIGS.zai[0].tokenType, 'jwt')
  assert.ok(MANUAL_TOKEN_CONFIGS.mimo.every(c => c.tokenType === 'cookie'))
})

test('actual MiMo/Z.ai manual manager routes preserve canonical fields without browser or network calls', async () => {
  class BaseOAuthAdapter {
    constructor(config) { this.config = config }
    setProgressCallback() {} setMainWindow() {} emitProgress() {}
  }
  const { MimoAdapter } = load('src/main/oauth/adapters/mimo.ts', { './base': { BaseOAuthAdapter } })
  const { ZaiAdapter } = load('src/main/oauth/adapters/zai.ts', { './base': { BaseOAuthAdapter }, axios: { default() { throw new Error('Network calls forbidden') } } })
  const seen = []
  const { OAuthManager } = load('src/main/oauth/manager.ts', {
    events: { EventEmitter }, electron: { shell: { openExternal() { throw new Error('Browser launch forbidden') } } },
    './adapters': { createAdapter(type, config) {
      if (type === 'mimo') return new MimoAdapter(config)
      const adapter = new ZaiAdapter(config)
      // This fixture only proves dispatch and field mapping, not account authentication.
      adapter.validateToken = async credentials => { seen.push(plain(credentials)); return { valid: true, accountInfo: { email: 'fixture@example.test' } } }
      return adapter
    } },
    './inAppLogin': { inAppLoginManager: {} }, './externalBrowserLogin': { externalBrowserLoginManager: {} }, '../arena/browserManager': { arenaBrowserManager: {} },
  })
  const manager = new OAuthManager()
  const missing = await manager.loginWithToken('mimo', 'mimo', 'service-fixture')
  assert.equal(missing.success, false)
  assert.match(missing.error, /userId and phToken/)
  const mimo = await manager.loginWithToken('mimo', 'mimo', 'service-fixture', undefined, 'user-fixture', 'ph-fixture')
  assert.equal(mimo.success, true)
  assert.deepEqual(plain(mimo.credentials), { service_token: 'service-fixture', user_id: 'user-fixture', ph_token: 'ph-fixture' })
  const zai = await manager.loginWithToken('zai', 'zai', 'token-fixture')
  assert.equal(zai.success, true)
  assert.deepEqual(plain(zai.credentials), { token: 'token-fixture' })
  assert.deepEqual(seen, [{ token: 'token-fixture' }])
})
