const test = require('node:test'), assert = require('node:assert/strict')
const { readFileSync } = require('node:fs'), vm = require('node:vm'), ts = require('typescript')
const { once, EventEmitter } = require('node:events')
const Koa = require('koa'), Router = require('@koa/router'), bodyParser = require('koa-bodyparser')
const immediate = () => new Promise(resolve => setImmediate(resolve))
async function fixture(t, options = {}) {
  let server, port, running = true, calls = [], logs = [], complete
  const completed = () => new Promise(resolve => { complete = resolve })
  const app = new Koa(); app.on('error', () => {})
  const close = async () => { const current = server; await new Promise((resolve, reject) => current.close(error => error ? reject(error) : resolve())); running = false }
  const start = async () => { server = app.listen(port || 0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port; running = true }
  const proxy = {
    isRunning: () => running,
    async start() { calls.push('start'); return true },
    async stop() { calls.push('stop'); if (options.gate) await options.gate; if (options.fail) { complete?.(); return false }; await close(); complete?.(); return true },
    async restart(nextPort, host) { calls.push(['restart', nextPort, host]); await close(); port = nextPort; await start(); complete?.(); return true },
  }
  const dependencies = {
    '@koa/router': { default: Router }, 'node:net': require('node:net'),
    '../../middleware/managementAuth': { managementAuthMiddleware: async (ctx, next) => next() },
    '../../server': { proxyServer: proxy }, '../../../store/store': { storeManager: {
      getConfig: () => ({ proxyPort: port, proxyHost: '127.0.0.1' }), addLog: (...args) => logs.push(args),
    } },
    '../../status': { proxyStatusManager: { getRunningStatus: () => ({ isRunning: running, uptime: 0 }),
      getPort: () => port, getHost: () => '127.0.0.1', getStatistics: () => ({ activeConnections: 0 }) } },
  }
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync('src/main/proxy/routes/management/proxy.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports, Date, require: name => { assert.ok(dependencies[name], name); return dependencies[name] } })
  const route = module.exports.default
  app.use(bodyParser()).use(route.routes()).use(route.allowedMethods())
  await start()
  t.after(async () => { server.closeAllConnections(); if (server.listening) await close() })
  return { calls, logs, completed, route,
    request: (action, body, method = 'POST') => fetch(`http://127.0.0.1:${port}/v0/management/proxy/${action}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(2000),
    }),
  }
}

test('management self-stop acknowledges 202 before closing the same active HTTP listener', async t => {
  const f = await fixture(t), finished = f.completed()
  const response = await f.request('stop')
  assert.equal(response.status, 202)
  assert.deepEqual((await response.json()).data, { operation: 'stop', status: 'scheduled' })
  await finished
  assert.deepEqual(f.calls, ['stop'])
})

test('management self-restart completes on the same selected port after its response finishes', async t => {
  const f = await fixture(t), finished = f.completed()
  const response = await f.request('restart', {})
  assert.equal(response.status, 202)
  assert.equal((await response.json()).data.status, 'scheduled')
  await finished; await immediate()
  const status = await (await f.request('status', undefined, 'GET')).json()
  assert.equal(status.data.isRunning, true)
  assert.equal(status.data.pendingOperation, null)
  assert.equal(status.data.lastOperation.success, true)
  assert.equal(f.calls[0][1], status.data.port)
  assert.equal(f.calls[0][2], '127.0.0.1')
})

test('invalid restart addresses never stop the existing healthy listener', async t => {
  const f = await fixture(t)
  for (const body of [null, [], { port: 0 }, { port: 70000 }, { port: 8080.5 }, { port: '8080' }, { port: null }, { host: '' }, { host: 'file://fixture' }, { host: '127.0.0.1\n' }, { proxyPort: 8080 }]) {
    const response = await f.request('restart', body)
    assert.equal(response.status, 400, JSON.stringify(body)); await response.text()
  }
  assert.deepEqual(f.calls, [])
  assert.equal((await f.request('status', undefined, 'GET')).status, 200)
})

test('scheduled operation rejects overlap, reports pending state, and records safe failure details', async t => {
  let release
  const f = await fixture(t, { gate: new Promise(resolve => { release = resolve }), fail: true })
  const finished = f.completed()
  assert.equal((await f.request('stop')).status, 202)
  assert.equal((await f.request('restart', {})).status, 409)
  const pending = await (await f.request('status', undefined, 'GET')).json()
  assert.equal(pending.data.pendingOperation, 'stop')
  release(); await finished; await immediate()
  const status = await (await f.request('status', undefined, 'GET')).json()
  assert.equal(status.data.pendingOperation, null)
  assert.equal(status.data.lastOperation.success, false)
  assert.equal(f.logs.length, 1)
})

test('a disconnected unacknowledged management response cannot stop the server or hold the operation lock', async t => {
  const f = await fixture(t)
  const handler = f.route.stack.find(layer => layer.path.endsWith('/stop')).stack.at(-1)
  const ctx = { res: new EventEmitter(), set() {} }
  handler(ctx)
  ctx.res.emit('close')
  assert.deepEqual(f.calls, [])
  assert.equal((await f.request('status', undefined, 'GET')).status, 200)
  const finished = f.completed()
  assert.equal((await f.request('stop')).status, 202)
  await finished
})
