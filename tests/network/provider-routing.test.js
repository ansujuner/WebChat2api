const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const context = require('../../src/main/network/providerContext.ts')

test('same-host providers resolve independently and unknown settings fail closed', async () => {
  const settings = { a: { mode: 'custom', url: 'http://127.0.0.1:8123' }, b: { mode: 'none' } }
  let global = 'system'
  context.setProviderProxyResolver(id => settings[id], () => global)
  assert.deepEqual(context.getProviderProxyConfig('a'), settings.a)
  assert.deepEqual(context.getProviderProxyConfig('b'), settings.b)
  assert.equal(context.getProviderProxyMode('inherited'), 'system')
  global = 'none'
  assert.equal(context.getProviderProxyMode('inherited'), 'none')
  settings.a = { mode: 'custom', url: 'http://user:secret@127.0.0.1:8123' }
  assert.throws(() => context.getProviderProxyConfig('a'), /without credentials/)
  assert.throws(() => context.withProviderNetwork('', () => assert.fail('invalid provider must not execute')))
  context.setProviderProxyResolver(() => undefined, () => 'system')
})

test('concurrent async scopes keep their own proxy URL/mode through awaits and nested providers', async () => {
  const settings = { a: { mode: 'custom', url: 'http://127.0.0.1:8123' }, b: { mode: 'none' } }
  context.setProviderProxyResolver(id => settings[id], () => 'system')
  const values = await Promise.all(['a', 'b'].map(id => context.withProviderNetwork(id, async () => {
    const original = context.getProviderProxyConfig(id)
    await sleep(id === 'a' ? 8 : 1)
    assert.deepEqual(context.getProviderNetworkScope(), { providerId: id, config: original })
    await context.withProviderNetwork(id === 'a' ? 'b' : 'a', async () => { await sleep(2) })
    assert.deepEqual(context.getProviderProxyConfig(id), original)
    return original
  })))
  assert.deepEqual(values, [settings.a, settings.b])
  assert.equal(context.getProviderNetworkScope(), undefined)
  context.setProviderProxyResolver(() => undefined, () => 'system')
})

test('settings edits affect the next operation, never the already-started task or its nested same-provider calls', async () => {
  let route = { mode: 'custom', url: 'http://127.0.0.1:8123' }
  context.setProviderProxyResolver(() => route, () => 'system')
  await context.withProviderNetwork('a', async () => {
    const original = context.getProviderProxyConfig('a')
    route = { mode: 'custom', url: 'http://127.0.0.1:8124' }
    await sleep(1)
    assert.deepEqual(context.getProviderProxyConfig('a'), original)
    context.withProviderNetwork('a', () => assert.deepEqual(context.getProviderProxyConfig('a'), original))
  })
  assert.equal(context.withProviderNetwork('a', () => context.getProviderProxyConfig('a').url), route.url)
  await assert.rejects(context.withProviderNetwork('a', async () => { throw Error('synthetic failure') }))
  assert.equal(context.getProviderNetworkScope(), undefined)
  context.setProviderProxyResolver(() => undefined, () => 'system')
})

test('bound external/native callbacks retain the originating route rather than the emitter current provider', () => {
  let route = { mode: 'custom', url: 'socks5://127.0.0.1:8123' }
  context.setProviderProxyResolver(() => route, () => 'system')
  const emitter = new EventEmitter(), observed = []
  context.withProviderNetwork('a', () => emitter.on('data', context.bindProviderNetwork('a', () => {
    observed.push(context.getProviderNetworkScope())
  })))
  route = { mode: 'none' }
  context.withProviderNetwork('b', () => emitter.emit('data'))
  assert.deepEqual(observed, [{ providerId: 'a', config: { mode: 'custom', url: 'socks5://127.0.0.1:8123' } }])
  assert.equal(context.getProviderNetworkScope(), undefined)
  context.setProviderProxyResolver(() => undefined, () => 'system')
})
