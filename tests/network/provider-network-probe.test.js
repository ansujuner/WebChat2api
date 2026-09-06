const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

test('routing report resolves saved provider metadata only and omits custom addresses and errors', async () => {
  const module = { exports: {} }, calls = []
  const providers = [
    { id: 'zai', type: 'builtin', apiEndpoint: 'https://fixture.test', networkProxyMode: 'system' },
    { id: 'PRIVATE-ID', type: 'custom', name: 'PRIVATE-NAME', apiEndpoint: 'https://PRIVATE-HOST', networkProxyMode: 'custom', networkProxyUrl: 'http://PRIVATE-PROXY:80' },
    { id: 'bad', type: 'custom', apiEndpoint: 'https://bad', networkProxyMode: 'PRIVATE-MODE' },
  ]
  const deps = {
    '../store/store': { storeManager: { getProviders: () => providers, getAccounts: () => assert.fail('Never read accounts') } },
    '../network/proxy': { getNetworkProxyStatus: async (id, target) => {
      calls.push([id, target])
      if (id === 'bad') throw Error('PRIVATE-NETWORK-ERROR')
      return { mode: id === 'zai' ? 'system' : 'custom', route: id === 'zai' ? 'direct' : 'proxy' }
    } },
  }
  const source = readFileSync(join(__dirname, '../../src/main/diagnostics/providerNetworkProbe.ts'), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, require: name => { assert.ok(Object.hasOwn(deps, name)); return deps[name] } })
  const report = await module.exports.runProviderNetworkProbe()
  assert.deepEqual(calls, providers.map(p => [p.id, p.apiEndpoint]))
  assert.equal(report.status, 'needs_attention')
  assert.equal(report.providerRequestsSent, 0)
  assert.equal(report.resolutionOnly, true)
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE/)
  assert.equal(report.checks[0].route, 'direct')
  assert.equal(report.checks[2].source, 'inherit')
})
