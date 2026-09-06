const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const ts = require('typescript')
const context = require('../../src/main/network/providerContext.ts')
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const route = { mode: 'custom', url: 'http://127.0.0.1:18421' }
const plain = value => JSON.parse(JSON.stringify(value))
function fixture() {
  let setter, closeWait
  const calls = [], events = {}
  const target = { webRequest: {
    onBeforeRequest: handler => { events.before = handler }, onCompleted: handler => { events.completed = handler }, onErrorOccurred: handler => { events.error = handler },
  }, async closeAllConnections() { calls.push('close'); if (closeWait) await closeWait.promise } }
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync(join(__dirname, '../../src/main/network/sessionProxy.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports, Error, require(name) {
    if (name === './providerContext.ts') return context
    if (name === './proxy') return { async applyProxyToSession(_target, value, close) { calls.push({ config: plain(value), close }); if (setter) await setter.promise } }
    throw Error(`Unexpected ${name}`)
  } })
  const controller = new module.exports.OwnedSessionProxy(target)
  return { controller, calls, events, setSetter: gate => { setter = gate }, setCloser: gate => { closeWait = gate } }
}

test('owned session route change never sets proxy or closes sockets while a manual webpage request is active', async () => {
  const f = fixture(), replies = []
  f.events.before({ id: 1 }, value => replies.push(plain(value)))
  assert.deepEqual(replies, [{}])
  await assert.rejects(f.controller.apply(route), error => error.code === 'busy')
  assert.deepEqual(f.calls, [])
  f.events.completed({ id: 1 })
  await f.controller.apply(route)
  assert.deepEqual(f.calls, [{ config: route, close: false }, 'close'])
  f.controller.dispose()
})

test('requests arriving during a successful switch wait until idle socket retirement finishes', async () => {
  const f = fixture(), setter = deferred(), closer = deferred(), replies = []
  f.setSetter(setter); f.setCloser(closer)
  const switching = f.controller.apply(route)
  f.events.before({ id: 2 }, value => replies.push(plain(value)))
  assert.deepEqual(replies, [])
  setter.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(replies, [])
  closer.resolve(); await switching
  assert.deepEqual(replies, [{}])
  await assert.rejects(f.controller.apply({ mode: 'none' }), error => error.code === 'busy')
  f.events.error({ id: 2 })
  f.setSetter(); f.setCloser()
  await f.controller.apply({ mode: 'none' })
  f.controller.dispose()
})

test('proxy setter failure never retires old sockets, cancels held requests and requires successful configuration before resuming', async () => {
  const f = fixture(), setter = deferred(), replies = []
  f.setSetter(setter)
  const switching = f.controller.apply(route)
  f.events.before({ id: 3 }, value => replies.push(plain(value)))
  setter.reject(new Error('synthetic setProxy failure'))
  await assert.rejects(switching)
  assert.deepEqual(replies, [{ cancel: true }]); assert.equal(f.calls.includes('close'), false)
  f.events.before({ id: 4 }, value => replies.push(plain(value)))
  assert.deepEqual(replies, [{ cancel: true }, { cancel: true }])
  f.setSetter(); await f.controller.apply(route)
  f.events.before({ id: 5 }, value => replies.push(plain(value)))
  assert.deepEqual(replies.at(-1), {})
  f.controller.dispose()
})

test('destroy during a proxy switch cancels each callback once and cannot create a late socket retirement', async () => {
  const f = fixture(), setter = deferred(), replies = []
  f.setSetter(setter)
  const switching = f.controller.apply(route)
  f.events.before({ id: 6 }, value => replies.push(plain(value)))
  f.controller.dispose(); f.controller.dispose()
  assert.deepEqual(replies, [{ cancel: true }])
  assert.deepEqual(f.events, { before: null, completed: null, error: null })
  setter.resolve(); await assert.rejects(switching, error => error.code === 'cancelled')
  assert.equal(f.calls.includes('close'), false)
  assert.equal(replies.length, 1)
})
