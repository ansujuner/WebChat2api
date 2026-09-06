const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = join(__dirname, '../..')

function load(relative, dependencies, globals = {}) {
  const source = ts.transpileModule(readFileSync(join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, console,
    require: name => {
      if (name in dependencies) return dependencies[name]
      throw new Error(`Unexpected dependency: ${name}`)
    }, ...globals })
  return module.exports
}

function fixture(save) {
  let state
  let persistence
  load('src/renderer/src/stores/settingsStore.ts', {
    zustand: { create: () => factory => {
      const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }
      state = factory(set, () => state)
      return { getState: () => state }
    } },
    'zustand/middleware': { persist: (factory, options) => { persistence = options; return factory } },
    '@/i18n': { default: { changeLanguage: async () => {} } },
  }, { window: { electronAPI: { config: { update: save } } } })
  return { get: () => state, persistence }
}

test('network selection changes only after the main process applies and saves it', async () => {
  let complete
  const f = fixture(() => new Promise(resolve => { complete = resolve }))
  f.get().setConfig({ oauthProxyMode: 'system', theme: 'light' })
  const pending = f.get().setOauthProxyMode('none')
  assert.equal(f.get().oauthProxyMode, 'system')
  assert.equal(f.get().proxyModeSaving, true)
  complete(true)
  await pending
  assert.equal(f.get().oauthProxyMode, 'none')
  assert.equal(f.get().config.oauthProxyMode, 'none')
  assert.equal(f.get().config.theme, 'light')
  assert.equal(f.get().proxyModeSaving, false)
})

test('failed or rejected proxy saves keep the prior displayed mode and propagate an error', async () => {
  for (const save of [async () => false, async () => { throw new Error('fixture failure') }]) {
    const f = fixture(save)
    await assert.rejects(f.get().setOauthProxyMode('none'))
    assert.equal(f.get().oauthProxyMode, 'system')
    assert.equal(f.get().proxyModeSaving, false)
  }
})

test('invalid and concurrent proxy changes never reach persistence', async () => {
  let calls = 0
  let complete
  const f = fixture(() => { calls++; return new Promise(resolve => { complete = resolve }) })
  await assert.rejects(f.get().setOauthProxyMode('invalid'))
  assert.equal(calls, 0)
  const pending = f.get().setOauthProxyMode('none')
  await assert.rejects(f.get().setOauthProxyMode('system'))
  assert.equal(calls, 1)
  complete(true)
  await pending
})

test('config broadcasts update the proxy label and pending state cannot survive rehydration', () => {
  const f = fixture(async () => true)
  f.get().setConfig({ oauthProxyMode: 'none' })
  assert.equal(f.get().oauthProxyMode, 'none')
  assert.equal('proxyModeSaving' in f.persistence.partialize(f.get()), false)
  assert.equal(f.persistence.merge({ proxyModeSaving: true, oauthProxyMode: 'none' }, f.get()).proxyModeSaving, false)
})

const { createNetworkConfigUpdater } = load('src/main/network/configuration.ts', { './proxy': { configureNetworkProxy: async () => {} } })

test('configuration applies network before persisting and does not save on apply failure', async () => {
  const events = []
  const update = createNetworkConfigUpdater(async mode => { events.push(mode); if (mode === 'none') throw new Error('proxy failure') })
  await assert.rejects(update({ oauthProxyMode: 'none' }, () => 'system', () => events.push('saved')))
  assert.deepEqual(events, ['none'])
  const result = await update({ oauthProxyMode: 'system' }, () => 'system', () => { events.push('saved'); return 42 })
  assert.equal(result, 42)
  assert.deepEqual(events, ['none', 'system', 'saved'])
})

test('persistence failure restores the previous proxy setting; concurrent writes are serialized', async () => {
  const events = []
  const update = createNetworkConfigUpdater(async mode => { events.push(mode) })
  await assert.rejects(update({ oauthProxyMode: 'none' }, () => 'system', () => { throw new Error('disk full') }), /disk full/)
  assert.deepEqual(events, ['none', 'system'])
  events.length = 0
  let saved = 'system'
  await Promise.all([
    update({ oauthProxyMode: 'none' }, () => saved, () => { saved = 'none'; events.push('saved-none') }),
    update({ oauthProxyMode: 'system' }, () => saved, () => { saved = 'system'; events.push('saved-system') }),
  ])
  assert.deepEqual(events, ['none', 'saved-none', 'system', 'saved-system'])
})

test('invalid proxy modes and malformed update objects never apply or persist', async () => {
  const update = createNetworkConfigUpdater(async () => assert.fail('must not apply'))
  for (const updates of [null, [], { oauthProxyMode: null }, { oauthProxyMode: undefined }, { oauthProxyMode: 'direct' }]) {
    await assert.rejects(update(updates, () => 'system', () => assert.fail('must not save')))
  }
  assert.equal(await update({}, () => 'system', () => 'unrelated setting'), 'unrelated setting')
})

test('production bootstrap is installed before modules construct Axios instances', () => {
  const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  assert.ok(main.indexOf("import './network/bootstrap'") < main.indexOf("from './ipc/handlers'"))
  const settings = readFileSync(join(root, 'src/renderer/src/components/settings/GeneralSettings.tsx'), 'utf8')
  assert.match(settings, /disabled=\{proxyModeSaving\}/)
  assert.match(settings, /networkProxySaveFailed/)
  assert.match(settings, /getRuntimeInfo/)
})
