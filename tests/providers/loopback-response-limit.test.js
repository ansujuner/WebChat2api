const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
function fixture(size) {
  let requests = 0, destroyed = false
  const http = { request(options, callback) {
    requests++
    assert.ok(['127.0.0.1', '::1'].includes(options.hostname))
    assert.equal(options.agent, false)
    const request = new EventEmitter()
    request.destroy = error => { destroyed = true; request.emit('error', error); request.emit('close') }
    request.end = () => {
      const response = new EventEmitter()
      response.statusCode = 200; response.headers = {}; response.destroy = () => { destroyed = true }
      callback(response)
      response.emit('data', Buffer.alloc(size, 65))
      if (!destroyed) response.emit('end')
      request.emit('close')
    }
    return request
  } }
  const module = { exports: {} }
  const source = readFileSync(join(__dirname, '../../src/main/diagnostics/localProbe.ts'), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText,
    { module, exports: module.exports, Buffer, setTimeout, clearTimeout, require(name) {
      if (name === 'node:http') return http
      if (name === 'node:crypto') return require(name)
      if (name === './visionFixture.ts') return {}
      if (name === '../../shared/accountAvailability.ts') return require('../../src/shared/accountAvailability.ts')
      throw Error('No unmocked local profile/network dependency permitted: ' + name)
    } })
  return { get requests() { return requests }, get destroyed() { return destroyed }, run: maxResponseBytes => module.exports.requestLoopback({ hostname: '127.0.0.1', port: 12345, path: '/fixture', headers: {}, maxResponseBytes }) }
}

test('Loopback responses keep the default 1 MiB ceiling and terminate oversized replies', async () => {
  const normal = fixture(1024 * 1024)
  assert.equal((await normal.run()).text.length, 1024 * 1024)
  const oversized = fixture(1024 * 1024 + 1)
  await assert.rejects(oversized.run(), /connection_failed/)
  assert.equal(oversized.destroyed, true)
  assert.equal(oversized.requests, 1)
})

test('An explicit bounded image limit permits larger responses without raising other requests limits', async () => {
  const f = fixture(1024 * 1024 + 1)
  assert.equal((await f.run(48 * 1024 * 1024)).text.length, 1024 * 1024 + 1)
  assert.equal(f.destroyed, false)
  const custom = fixture(2049)
  await assert.rejects(custom.run(2048), /connection_failed/)
})

test('Invalid or unbounded loopback limits fail before any HTTP request', async () => {
  for (const limit of [0, -1, 1.2, NaN, Infinity, 48 * 1024 * 1024 + 1, '2048', null]) {
    const f = fixture(1)
    await assert.rejects(f.run(limit), /invalid_response_limit/)
    assert.equal(f.requests, 0)
  }
})
