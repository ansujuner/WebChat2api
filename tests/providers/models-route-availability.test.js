const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const vm = require('node:vm')
const ts = require('typescript')
const Koa = require('koa')
const root = path.resolve(__dirname, '../..')

async function fixture(t, options = {}) {
  const resolver = await import('../../src/main/proxy/modelMappingResolver.ts')
  const providers = [
    { id: 'deepseek', name: 'DeepSeek', enabled: true, createdAt: 1700000000000 },
    { id: 'glm', name: 'GLM', enabled: true, createdAt: 1700000000000 },
  ].map(provider => ({ ...provider, enabled: !(options.disabled || []).includes(provider.id) }))
  const models = {
    deepseek: [{ displayName: 'deepseek-v4-flash', actualModelId: 'deepseek-chat' }],
    glm: [{ displayName: 'GLM-5.3', actualModelId: 'glm-5.3' }],
  }
  const mappings = options.mappings || {
    'deepseek-v4-flash-think': { actualModel: 'deepseek-v4-flash', preferredProviderId: 'deepseek' },
    'glm-coding': { actualModel: 'GLM-5.3', preferredProviderId: 'glm' },
  }
  const storeManager = {
    getProviders: () => providers,
    getAccountsByProviderId(providerId, includeCredentials) {
      assert.notEqual(includeCredentials, true, 'Model discovery must not decrypt credentials')
      return (options.noAccounts || []).includes(providerId) ? []
        : [{ id: `fixture-${providerId}`, status: (options.expired || []).includes(providerId) ? 'expired' : 'active',
          ...((options.disabledAccounts || []).includes(providerId) ? { enabled: false } : {}),
          ...((options.coolingAccounts || []).includes(providerId) ? { cooldownReason: 'temporary_ban', cooldownUntil: Date.now() + 60000 } : {}) }]
    },
    getEffectiveModels: providerId => models[providerId],
    getConfig: () => ({ modelMappings: mappings }),
  }
  const source = ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/proxy/routes/models.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, Date,
    require(name) {
      if (name.endsWith('/shared/accountAvailability')) return require('../../src/shared/accountAvailability.ts')
      if (name === 'node:timers') return require('node:timers')
      if (name === '../arena/rateLimit') return { getArenaModelAvailability: () => ({ available: true, reason: 'ready' }) }
      if (name === '../../store/store') return { storeManager }
      if (name === '../modelMappingResolver') return resolver
      if (name === '@koa/router') return require('@koa/router')
      throw new Error(`Unexpected discovery dependency: ${name}`)
    },
  })
  const app = new Koa()
  app.use(module.exports.default.routes())
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  return pathname => new Promise((resolve, reject) => {
    const native = pathname.startsWith('anthropic:')
    const req = http.get({ hostname: '127.0.0.1', port: server.address().port,
      path: native ? pathname.slice('anthropic:'.length) : pathname,
      headers: native ? { 'anthropic-version': '2023-06-01' } : {},
    }, response => {
      let data = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { data += chunk })
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: JSON.parse(data) }) } catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
  })
}

test('active DeepSeek and GLM metadata yields a nonempty discovery list without accessing credentials', async t => {
  const get = await fixture(t)
  const response = await get('/v1/models')
  assert.equal(response.status, 200)
  assert.equal(response.body.object, 'list')
  assert.deepEqual(response.body.data.map(model => model.id), ['deepseek-v4-flash', 'GLM-5.3', 'deepseek-v4-flash-think', 'glm-coding'])
})

test('saved default aliases do not pretend a model exists when no accounts are configured', async t => {
  const get = await fixture(t, { noAccounts: ['deepseek', 'glm'] })
  assert.deepEqual((await get('/v1/models')).body.data, [])
  assert.equal((await get('/v1/models/deepseek-v4-flash-think')).status, 404)
  assert.equal((await get('/v1/models/GLM-5.3')).status, 404)
})

test('manual account switches and temporary holds remove unschedulable models and aliases without decrypting accounts', async t => {
  const get = await fixture(t, { disabledAccounts: ['deepseek'], coolingAccounts: ['glm'] })
  assert.deepEqual((await get('/v1/models')).body.data, [])
  assert.equal((await get('/v1/models/deepseek-v4-flash')).status, 404)
  assert.equal((await get('/v1/models/glm-coding')).status, 404)
})

test('disabled or expired providers do not leak unavailable aliases into discovery', async t => {
  const get = await fixture(t, { disabled: ['deepseek'], expired: ['glm'] })
  assert.deepEqual((await get('/v1/models')).body.data, [])
  assert.equal((await get('/v1/models/glm-coding')).status, 404)
})

test('unpreferred aliases need a model target supported by an available provider', async t => {
  const get = await fixture(t, { mappings: {
    valid: { actualModel: 'glm-5.3' },
    absent: { actualModel: 'not-configured-model' },
    disabledTarget: { actualModel: 'GLM-5.3', preferredProviderId: 'not-configured-provider' },
    malformed: null,
  } })
  const ids = (await get('/v1/models')).body.data.map(model => model.id)
  assert.ok(ids.includes('valid'))
  assert.ok(!ids.includes('absent') && !ids.includes('disabledTarget') && !ids.includes('malformed'))
  assert.equal((await get('/v1/models/absent')).status, 404)
})

test('list and detail agree on model ownership, including aliases shadowing a provider model', async t => {
  const get = await fixture(t, { mappings: {
    'GLM-5.3': { actualModel: 'GLM-5.3', preferredProviderId: 'glm' },
    coding: { actualModel: 'GLM-5.3' },
  } })
  const listed = (await get('/v1/models')).body.data
  for (const entry of listed) {
    const detail = await get(`/v1/models/${encodeURIComponent(entry.id)}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.body.id, entry.id)
    assert.equal(detail.body.owned_by, entry.owned_by)
  }
  assert.equal((await get('/v1/models/glm-5.3')).body.owned_by, 'GLM')
})

test('Anthropic discovery list and model details expose the same native metadata', async t => {
  const get = await fixture(t)
  const list = await get('anthropic:/v1/models')
  assert.equal(list.body.has_more, false)
  for (const entry of list.body.data) {
    const detail = await get(`anthropic:/v1/models/${encodeURIComponent(entry.id)}`)
    assert.equal(detail.body.type, 'model')
    assert.equal(detail.body.display_name, entry.display_name)
    assert.equal(detail.body.created_at, entry.created_at)
  }
})

test('load balancing does not log credential or token fragments', () => {
  const source = fs.readFileSync(path.join(root, 'src/main/proxy/loadbalancer.ts'), 'utf8')
  assert.doesNotMatch(source, /console\.(?:log|warn|error)\([^\n]*(?:credentials|Token:|\.token)/)
})

test('wildcard alias details resolve documented patterns with the same active target catalog',async t=>{
 const get=await fixture(t,{mappings:{'gpt-*':{actualModel:'deepseek-v4-flash',preferredProviderId:'deepseek'},'*-turbo':{actualModel:'GLM-5.3',preferredProviderId:'glm'},'claude-*-latest':{actualModel:'GLM-5.3',preferredProviderId:'glm'}}})
 for(const id of ['gpt-4.1','anything-turbo','claude-opus-latest']){
  const response=await get('/v1/models/'+id);assert.equal(response.status,200,id);assert.equal(response.body.id,id)
 }
 assert.equal((await get('/v1/models/nonmatching')).status,404)
})
