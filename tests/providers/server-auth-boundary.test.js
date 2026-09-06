const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { once } = require('node:events')
const ts = require('typescript')
const Koa = require('koa')
const Router = require('@koa/router')
const root = join(__dirname, '../..')

async function fixture(t, options) {
  let config = { enableApiKey: true, apiKeys: [], ...options }
  let calls = 0, writes = 0
  const route = new Router()
  route.get('/v1/models', ctx => { calls++; ctx.body = { object: 'list', data: [] } })
  route.post('/v1/messages', ctx => { calls++; ctx.body = { type: 'message' } })
  const dependencies = {
    koa: { default: Koa }, '@koa/router': { default: Router }, 'koa-bodyparser': { default: require('koa-bodyparser') },
    './routes': { default: [route] }, './routes/management': { default: [] },
    './anthropic/errors': await import('../../src/main/proxy/anthropic/errors.ts'),
    './status': { proxyStatusManager: { getRunningStatus: () => ({ isRunning: true, uptime: 1 }), getStatistics: () => ({}) } },
    './sessionManager': { sessionManager: {} }, './conversationContinuity': { conversationContinuity: {} },
    '../store/store': { storeManager: { getConfig: () => config, updateConfig(value) { writes++; config = { ...config, ...value } }, addLog() {} } },
  }
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(join(root, 'src/main/proxy/server.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, console, require: name => dependencies[name] || require(name) })
  const server = new module.exports.ProxyServer().app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return { request: (path, headers = {}, method = 'GET') => fetch(base + path, { method, headers }), get calls() { return calls }, get writes() { return writes }, get config() { return config } }
}

test('enabled API-key protection rejects empty, missing or disabled key configurations', async t => {
  for (const apiKeys of [[], undefined, [{ id: 'disabled', key: 'fixture-key', enabled: false }]]) {
    const f = await fixture(t, { apiKeys })
    const missing = await f.request('/v1/models')
    assert.equal(missing.status, 401)
    assert.equal((await missing.json()).error.code, 'missing_api_key')
    const provided = await f.request('/v1/models', { Authorization: 'Bearer fixture-key' })
    assert.equal(provided.status, 401)
    assert.equal((await provided.json()).error.code, 'invalid_api_key')
    assert.equal(f.calls, 0)
    assert.equal(f.writes, 0)
    const health = await f.request('/health')
    assert.equal(health.status, 200)
    await health.json()
  }
})

test('Bearer and X-API-Key work consistently and persist usage only after successful authentication', async t => {
  const f = await fixture(t, { apiKeys: [{ id: 'fixture', key: 'fixture-key', enabled: true, usageCount: 0 }] })
  for (const headers of [{ Authorization: 'Bearer fixture-key' }, { Authorization: 'bearer fixture-key' }, { 'X-API-Key': 'fixture-key' }]) {
    const response = await f.request('/v1/models', headers)
    assert.equal(response.status, 200)
    await response.json()
  }
  const repeated = await f.request('/v1/models?api_key=fixture-key&api_key=wrong')
  assert.equal(repeated.status, 401)
  await repeated.json()
  assert.equal(f.calls, 3)
  assert.equal(f.config.apiKeys[0].usageCount, 3)
  assert.equal(f.writes, 3)
})

test('disabled protection remains explicit and Anthropic auth failures retain protocol envelope', async t => {
  const unprotected = await fixture(t, { enableApiKey: false })
  assert.equal((await unprotected.request('/v1/models')).status, 200)
  const protectedFixture = await fixture(t, {})
  const response = await protectedFixture.request('/v1/messages', { 'anthropic-version': '2023-06-01' }, 'POST')
  assert.equal(response.status, 401)
  const body = await response.json()
  assert.equal(body.type, 'error')
  assert.equal(body.error.type, 'authentication_error')
  assert.equal(protectedFixture.calls, 0)
})
