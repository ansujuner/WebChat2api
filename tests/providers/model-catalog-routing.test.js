const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const root = join(__dirname, '..', '..')
const catalog = import('../../src/main/providers/builtin/index.ts')

function freezeTree(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freezeTree)
    Object.freeze(value)
  }
  return value
}

async function createRoutingFixture(options = {}) {
  const resolver = await import('../../src/main/proxy/modelMappingResolver.ts')
  const { builtinProviders } = await catalog
  const providers = freezeTree(builtinProviders.map(provider => ({
    ...JSON.parse(JSON.stringify(provider)),
    createdAt: 0,
    updatedAt: 0,
  })))
  const accounts = freezeTree(providers
    .filter(provider => !(options.noAccountFor || []).includes(provider.id))
    .map(provider => ({
      id: `fixture-${provider.id}`,
      name: 'fixture-only',
      providerId: provider.id,
      status: 'active',
      credentials: {},
    })))
  const config = freezeTree({ modelMappings: { ...(options.modelMappings || {}) } })
  // No actual store module is loaded; the only accounts are these frozen fakes.
  const storeManager = Object.freeze({
    getProviders: () => providers,
    getConfig: () => config,
    getEffectiveModels: providerId => {
      const provider = providers.find(entry => entry.id === providerId)
      return freezeTree(provider.supportedModels.map(displayName => ({
        displayName,
        actualModelId: provider.modelMappings[displayName],
        isCustom: false,
      })))
    },
    getAccountsByProviderId: providerId => accounts.filter(account => account.providerId === providerId),
  })
  const fileName = join(root, 'src/main/proxy/loadbalancer.ts')
  const { outputText, diagnostics } = ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  assert.deepEqual(diagnostics.filter(item => item.category === ts.DiagnosticCategory.Error), [])
  const module = { exports: {} }
  vm.runInNewContext(outputText, {
    module,
    exports: module.exports,
    require: name => {
      if (name === '../../shared/accountAvailability') return require('../../src/shared/accountAvailability.ts')
      if (name === '../arena/rateLimit') return { getArenaModelAvailability: () => ({ available: true, reason: 'ready' }) }
      if (name === '../store/store') return { storeManager }
      if (name === './modelMappingResolver') return resolver
      throw new Error(`Routing test forbids unexpected imports, storage and network access: ${name}`)
    },
    console: { log() {}, warn() {}, error() {} },
  }, { filename: fileName })
  return { balancer: new module.exports.LoadBalancer(), providers, accounts }
}

test('all current advertised models reach their exact provider-first upstream ID', async t => {
  const { balancer, providers } = await createRoutingFixture()
  let checkedModels = 0
  for (const provider of providers) {
    await t.test(provider.id, () => {
      for (const model of provider.supportedModels) {
        for (const strategy of ['round-robin', 'fill-first', 'failover']) {
          for (const requested of new Set([model, model.toLowerCase()])) {
            const selected = balancer.selectAccount(requested, strategy, provider.id)
            assert.ok(selected, `${provider.id}: ${requested}`)
            assert.equal(selected.provider.id, provider.id)
            assert.equal(selected.account.id, `fixture-${provider.id}`)
            assert.equal(selected.actualModel, provider.modelMappings[model])
          }
        }
        checkedModels++
      }
    })
  }
  assert.equal(providers.length, 10)
  assert.equal(checkedModels, providers.reduce((total, provider) => total + provider.supportedModels.length, 0))
  t.diagnostic(`${providers.length} providers / ${checkedModels} advertised entries preserve exact upstream IDs`)
})

test('shared GLM display names retain provider-specific Flash IDs despite stale global aliases', async () => {
  const { balancer } = await createRoutingFixture({ modelMappings: {
    'GLM-5.3-Flash': {
      requestModel: 'GLM-5.3-Flash', actualModel: 'GLM-5.1', preferredProviderId: 'zai',
    },
  } })
  assert.equal(balancer.selectAccount('GLM-5.3-Flash', 'round-robin', 'glm').actualModel, 'glm-5.3-flash')
  assert.equal(balancer.selectAccount('GLM-5.3-Flash', 'round-robin', 'zai').actualModel, 'x-preview-l')
})

test('provider-first routing never falls back to another provider when its account is unavailable', async () => {
  const { balancer } = await createRoutingFixture({ noAccountFor: ['zai'] })
  assert.equal(balancer.selectAccount('GLM-5.3-Flash', 'round-robin', 'zai'), null)
  assert.equal(balancer.selectAccount('GLM-5.3-Flash', 'round-robin', 'glm').actualModel, 'glm-5.3-flash')
  assert.equal(balancer.selectAccount('Kimi-K3', 'round-robin', 'mimo'), null)
})

test('the load balancer lists exactly the advertised catalog with fixture accounts', async () => {
  const { balancer, providers } = await createRoutingFixture()
  const expected = [...new Set(providers.flatMap(provider => provider.supportedModels))].sort()
  assert.deepEqual([...balancer.getAvailableModels()].sort(), expected)
})
