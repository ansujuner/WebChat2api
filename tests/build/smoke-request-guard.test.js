const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { createSmokeRequestIsolation } = require('../../scripts/smoke-request-guard.cjs')
const tick = () => new Promise(resolve => setImmediate(resolve))

function fixture() {
  const handlers = {}, protocols = new Set(), loopback = []
  let count = 0, nativeRegistrations = 0
  const session = {
    webRequest: {
      onBeforeRequest(value) { handlers.before = value; nativeRegistrations++ },
      onCompleted(value) { handlers.completed = value },
      onErrorOccurred(value) { handlers.error = value },
    },
    protocol: {
      handle(scheme) { protocols.add(scheme) }, unhandle(scheme) { protocols.delete(scheme) },
      isProtocolHandled: () => true, // Built-in HTTPS must NOT grant an exemption.
    },
    closeAllConnections: async () => {},
  }
  const isolation = createSmokeRequestIsolation({ onLoopbackRequest: route => loopback.push(route) })
  isolation.install(session)
  return { session, handlers, isolation, loopback, protocols,
    registrations: () => nativeRegistrations,
    send(url, id = ++count) { return new Promise(resolve => handlers.before({ url, id }, resolve)) },
  }
}

test('permanent fixture guard blocks remote traffic after real listener replacement or removal', async () => {
  const f = fixture(), calls = []
  f.session.webRequest.onBeforeRequest((details, callback) => { calls.push(details.id); callback({}) })
  assert.equal((await f.send('https://not-a-fixture.invalid/')).cancel, true)
  assert.equal(calls.length, 0)
  assert.deepEqual(await f.send('http://127.0.0.1:1234/test?private=not-recorded'), {})
  assert.equal(calls.length, 1)
  assert.deepEqual(f.loopback, [{ host: '127.0.0.1', port: 1234, path: '/test' }])
  f.session.webRequest.onBeforeRequest(null)
  assert.equal((await f.send('https://not-a-fixture.invalid/')).cancel, true)
  assert.deepEqual(await f.send('http://127.0.0.1:1234/'), {})
  assert.equal(f.registrations(), 1, 'Only the isolation composite is registered natively')
})

test('latest listener replacement, filters, cancellation and asynchronous callbacks are preserved', async () => {
  const f = fixture(), observed = []
  f.session.webRequest.onBeforeRequest((_details, callback) => { observed.push('old'); callback({}) })
  f.session.webRequest.onBeforeRequest({ urls: ['http://127.0.0.1:1234/selected*'] }, (_details, callback) => {
    observed.push('current'); setImmediate(() => callback({ cancel: true }))
  })
  assert.deepEqual(await f.send('http://127.0.0.1:1234/other'), {})
  assert.equal((await f.send('http://127.0.0.1:1234/selected')).cancel, true)
  assert.deepEqual(observed, ['current'])
  f.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, null)
  assert.deepEqual(await f.send('file:///isolated/renderer/index.html'), {})
})

test('fixture exemptions require a locally registered protocol and exact HTTPS origin', async () => {
  const f = fixture()
  const revoke = f.isolation.allowFixtureOrigin(f.session, 'https://fixture.invalid')
  assert.equal((await f.send('https://fixture.invalid/')).cancel, true, 'Built-in HTTPS does not count as an installed fixture')
  f.session.protocol.handle('https', () => new Response('fixture'))
  assert.deepEqual(await f.send('https://fixture.invalid/'), {})
  for (const url of ['https://other.invalid/', 'https://fixture.invalid:8443/', 'http://fixture.invalid/', 'wss://fixture.invalid/', 'ftp://fixture.invalid/']) {
    assert.equal((await f.send(url)).cancel, true, url)
  }
  revoke()
  assert.equal((await f.send('https://fixture.invalid/')).cancel, true)
})

test('protocol removal and revocation while the production listener is waiting both fail closed', async () => {
  for (const action of ['unhandle', 'revoke']) {
    const f = fixture()
    f.session.protocol.handle('https', () => new Response('fixture'))
    const revoke = f.isolation.allowFixtureOrigin(f.session, 'https://fixture.invalid')
    let release
    f.session.webRequest.onBeforeRequest((_details, callback) => { release = callback })
    const pending = f.send('https://fixture.invalid/')
    await tick(); assert.equal(typeof release, 'function')
    if (action === 'unhandle') f.session.protocol.unhandle('https')
    else revoke()
    release({})
    assert.equal((await pending).cancel, true)
  }
})

test('production redirects cannot escape isolation and thrown listeners fail closed', async () => {
  const f = fixture()
  f.session.webRequest.onBeforeRequest((_details, callback) => callback({ redirectURL: 'https://outside.invalid/' }))
  assert.equal((await f.send('http://127.0.0.1:1234/')).cancel, true)
  f.session.webRequest.onBeforeRequest(() => { throw new Error('fixture-private-error') })
  assert.equal((await f.send('http://127.0.0.1:1234/')).cancel, true)
})

test('actual OwnedSessionProxy listener still tracks active/queued requests and dispose cannot remove isolation', async () => {
  const f = fixture(), module = { exports: {} }
  let releaseApply, closes = 0
  f.session.closeAllConnections = async () => { closes++ }
  const file = path.join(__dirname, '../../src/main/network/sessionProxy.ts')
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports,
    require(name) {
      if (name === './proxy') return { applyProxyToSession: async () => new Promise(resolve => { releaseApply = resolve }) }
      if (name === './providerContext.ts') return { normalizeNetworkProxyConfig: value => value }
      throw Error('Unexpected production dependency')
    },
  })
  const owned = new module.exports.OwnedSessionProxy(f.session)
  assert.deepEqual(await f.send('http://127.0.0.1:1234/active', 41), {})
  await assert.rejects(owned.apply({ mode: 'none' }), error => error.code === 'busy')
  f.handlers.completed({ id: 41 })
  const apply = owned.apply({ mode: 'none' })
  let ended = false
  const queued = f.send('http://127.0.0.1:1234/queued', 42).then(value => { ended = true; return value })
  await tick(); assert.equal(ended, false, 'The real main listener queues requests during a route change')
  releaseApply(); await apply
  assert.deepEqual(await queued, {})
  assert.equal(closes, 1)
  assert.equal((await f.send('https://outside.invalid/')).cancel, true)
  f.handlers.completed({ id: 42 }); owned.dispose()
  assert.equal((await f.send('https://outside.invalid/')).cancel, true)
  assert.deepEqual(await f.send('http://127.0.0.1:1234/after-dispose'), {})
})

test('composition is test-only and production smoke passes an explicit revocable origin capability', () => {
  const root = path.join(__dirname, '../..')
  const smoke = fs.readFileSync(path.join(root, 'scripts/smoke-app.cjs'), 'utf8')
  assert.match(smoke, /createSmokeRequestIsolation/)
  assert.match(smoke, /app\.on\('session-created', isolateRequests\)/)
  assert.match(smoke, /request, allowFixtureOrigin/)
  assert.match(fs.readFileSync(path.join(root, 'src/main/network/sessionProxy.ts'), 'utf8'), /onBeforeRequest\(\(details, callback\)/)
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'src/main/network/sessionProxy.ts'), 'utf8'), /smoke-request-guard|allowFixtureOrigin/)
})
