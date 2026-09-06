const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.join(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const source = file => ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText
const network = { exports: {} }
vm.runInNewContext(source('src/shared/providerNetwork.ts'), { module: network, exports: network.exports, URL })

function harness({ mode, url, globalMode = 'system', type = 'builtin', update, status } = {}) {
  const slots = [], effects = [], calls = { update: [], status: [], store: [] }
  let cursor = 0, tree, currentId = 'provider-a'
  const state = { providers: [
    { id: 'provider-a', name: 'Provider A', type, apiEndpoint: 'https://example.invalid', ...(mode ? { networkProxyMode: mode } : {}), ...(url ? { networkProxyUrl: url } : {}) },
    { id: 'provider-b', name: 'Provider B', type: 'custom', apiEndpoint: 'https://second.invalid', networkProxyMode: 'none' },
  ], updateProvider(id, updates) {
    calls.store.push([id, plain(updates)])
    state.providers = state.providers.map(item => item.id === id ? { ...item, ...updates } : item)
  } }
  const settings = { oauthProxyMode: globalMode }
  const react = {
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] },
    useRef(initial) { return react.useState(() => ({ current: initial }))[0] },
    useEffect(fn, deps) {
      const index = cursor++, old = slots[index]
      if (!old || deps.some((value, i) => value !== old.deps[i])) {
        slots[index] = { deps, cleanup: old?.cleanup }
        effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = fn() })
      }
    },
  }
  const module = { exports: {} }
  const useSettingsStore = selector => selector(settings)
  useSettingsStore.getState = () => settings
  vm.runInNewContext(source('src/renderer/src/components/providers/ProviderNetworkSettings.tsx'), {
    module, exports: module.exports,
    window: { electronAPI: { providers: {
      update: async (id, updates) => { calls.update.push([id, plain(updates)]); return update ? update(id, updates) : { ...state.providers.find(item => item.id === id), ...updates } },
      getNetworkStatus: async id => { calls.status.push(id); return status ? status(id) : { mode: settings.oauthProxyMode, route: 'direct' } },
    } } },
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' }
      if (name === 'react-i18next') return { useTranslation: () => ({ t: key => key }) }
      if (name.endsWith('providerNetwork')) return network.exports
      if (name.endsWith('providersStore')) return { useProvidersStore: { getState: () => state } }
      if (name.endsWith('settingsStore')) return { useSettingsStore }
      return new Proxy({}, { get: (_, key) => key })
    },
  })
  const render = () => {
    cursor = 0
    tree = module.exports.ProviderNetworkSettings({ provider: state.providers.find(item => item.id === currentId) })
    if (effects.length) { effects.splice(0).forEach(fn => fn()); return render() }
    return tree
  }
  const walk = (node, predicate) => Array.isArray(node) ? node.flatMap(item => walk(item, predicate)) : !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)]
  const text = node => Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'string' ? node : node?.props ? text(node.props.children) : ''
  const find = type => walk(tree, node => node.type === type)[0]
  const control = suffix => walk(tree, node => node.props?.['data-testid'] === `provider-network-${suffix}-${currentId}`)[0]
  const h = { calls, state, settings, render, text: () => text(tree), find, control,
    choose(value) { find('Select').props.onValueChange(value) },
    input(value) { control('url').props.onChange({ target: { value } }); render() },
    click(suffix) { control(suffix).props.onClick() },
    switchProvider(id) { currentId = id; render() },
    unmount() { for (const slot of slots) if (slot && typeof slot.cleanup === 'function') slot.cleanup() },
    async settle() { await tick(); render() },
  }
  render()
  return h
}

test('default UI exposes four provider-only routes and performs no request on mount', () => {
  const h = harness()
  assert.equal(h.find('Select').props.value, 'inherit')
  for (const key of ['inherit', 'system', 'none', 'custom', 'scope', 'routeOnly']) assert.match(h.text(), new RegExp(`provider.proxy.${key}`))
  assert.deepEqual(h.calls, { update: [], status: [], store: [] })
})

for (const type of ['builtin', 'custom']) test(`${type} provider route saves independently without replacing other fields or global config`, async () => {
  const h = harness({ type })
  h.choose('none'); await h.settle()
  assert.deepEqual(h.calls.update, [['provider-a', { networkProxyMode: 'none' }]])
  assert.deepEqual(h.calls.store, h.calls.update)
  assert.equal(h.settings.oauthProxyMode, 'system')
  assert.equal(h.state.providers[1].networkProxyMode, 'none')
  assert.equal(h.state.providers[0].name, 'Provider A')
  assert.equal(h.find('Select').props.value, 'none')
  assert.match(h.text(), /provider.proxy.saved/)
})

test('same-tick repeated selection submits only one save and disables controls', async () => {
  const pending = deferred(), h = harness({ update: () => pending.promise })
  h.choose('none'); h.choose('system'); h.render()
  assert.equal(h.calls.update.length, 1)
  assert.equal(h.find('Select').props.disabled, true)
  assert.equal(h.control('check').props.disabled, true)
  pending.resolve({ id: 'provider-a', networkProxyMode: 'none' }); await h.settle()
  assert.equal(h.find('Select').props.disabled, false)
})

for (const result of [null, { id: 'wrong', networkProxyMode: 'none' }, { id: 'provider-a', networkProxyMode: 'system' }]) {
  test(`invalid save acknowledgment retains old route (${JSON.stringify(result)})`, async () => {
    const h = harness({ update: async () => result })
    h.choose('none'); await h.settle()
    assert.equal(h.find('Select').props.value, 'inherit')
    assert.equal(h.calls.store.length, 0)
    assert.match(h.text(), /provider.proxy.saveFailed/)
  })
}

test('raw save errors never enter feedback or mutate the stored route', async () => {
  const h = harness({ update: async () => { throw new Error('PRIVATE_SENTINEL') } })
  h.choose('none'); await h.settle()
  assert.match(h.text(), /provider.proxy.saveFailed/)
  assert.doesNotMatch(h.text(), /PRIVATE_SENTINEL/)
  assert.equal(h.calls.store.length, 0)
})

test('late saves do not overwrite a different provider, an externally changed provider, or an unmounted view', async () => {
  for (const change of ['switch', 'external', 'unmount']) {
    const pending = deferred(), h = harness({ update: () => pending.promise })
    h.choose('system')
    if (change === 'switch') h.switchProvider('provider-b')
    if (change === 'external') { h.state.providers[0] = { ...h.state.providers[0], networkProxyMode: 'none' }; h.render() }
    if (change === 'unmount') h.unmount()
    pending.resolve({ id: 'provider-a', networkProxyMode: 'system' }); await tick()
    assert.equal(h.calls.store.length, 0, change)
  }
})

for (const [mode, route, key] of [['system', 'direct', 'systemDirect'], ['system', 'proxy', 'resolvedProxy'], ['none', 'direct', 'direct'], ['system', 'unknown', 'routeUnknown'], ['custom', 'proxy', 'resolvedCustomProxy']]) {
  test(`route preview ${mode}/${route} uses honest route-only wording`, async () => {
    const h = harness({ mode, url: mode === 'custom' ? 'http://127.0.0.1:7890' : undefined, status: async () => ({ mode, route }) })
    h.click('check'); h.click('check'); await h.settle()
    assert.equal(h.calls.status.length, 1)
    assert.match(h.text(), new RegExp(`provider.proxy.${key}`))
    assert.match(h.text(), /provider.proxy.routeOnly/)
    assert.equal(h.calls.update.length, 0)
  })
}

test('invalid route metadata and thrown private errors become safe failures', async () => {
  for (const status of [async () => ({ mode: 'none', route: 'proxy' }), async () => ({ mode: 'system', route: 'PRIVATE_SENTINEL' }), async () => { throw new Error('PRIVATE_SENTINEL') }]) {
    const h = harness({ status }); h.click('check'); await h.settle()
    assert.match(h.text(), /provider.proxy.checkFailed/)
    assert.doesNotMatch(h.text(), /PRIVATE_SENTINEL|provider.proxy.resolvedProxy/)
  }
})

for (const change of ['save', 'global', 'endpoint', 'customDraft', 'switch']) test(`stale route preview is discarded after ${change}`, async () => {
  const pending = deferred(), h = harness({ status: () => pending.promise })
  h.click('check')
  if (change === 'save') { h.choose('none'); await h.settle() }
  if (change === 'global') { h.settings.oauthProxyMode = 'none'; h.render() }
  if (change === 'endpoint') { h.state.providers[0] = { ...h.state.providers[0], apiEndpoint: 'https://changed.invalid' }; h.render() }
  if (change === 'customDraft') { h.choose('custom'); h.render() }
  if (change === 'switch') h.switchProvider('provider-b')
  pending.resolve({ mode: 'system', route: 'proxy' }); await h.settle()
  assert.doesNotMatch(h.text(), /provider.proxy.resolvedProxy/)
})

test('custom URL needs explicit save; invalid input never reaches IPC; canonical URL is stored', async () => {
  const h = harness()
  h.choose('custom'); h.render()
  assert.equal(h.calls.update.length, 0)
  assert.equal(h.control('check').props.disabled, true)
  h.input('http://user:PRIVATE_SENTINEL@127.0.0.1:7890'); h.click('save'); await h.settle()
  assert.match(h.text(), /provider.proxy.invalidUrl/)
  assert.equal(h.calls.update.length, 0)
  h.input(' http://LOCALHOST:07890/ '); h.click('save'); await h.settle()
  assert.deepEqual(h.calls.update, [['provider-a', { networkProxyMode: 'custom', networkProxyUrl: 'http://localhost:7890' }]])
  assert.equal(h.control('url').props.value, 'http://localhost:7890')
  assert.equal(h.settings.oauthProxyMode, 'system')
})

test('same-tick custom editing cannot check an old route or submit an old address', async () => {
  const h = harness({ mode: 'custom', url: 'http://127.0.0.1:7890' })
  h.choose('custom'); h.click('check')
  assert.equal(h.calls.status.length, 0)
  h.render()
  h.control('url').props.onChange({ target: { value: 'socks5://127.0.0.1:1080' } })
  h.click('save'); await h.settle()
  assert.equal(h.calls.update[0][1].networkProxyUrl, 'socks5://127.0.0.1:1080')
})

test('cancel discards custom draft and switching away preserves the saved proxy address', async () => {
  const h = harness({ mode: 'custom', url: 'socks5://127.0.0.1:1080' })
  h.input('https://localhost:8443'); h.click('cancel'); h.render()
  assert.equal(h.control('url').props.value, 'socks5://127.0.0.1:1080')
  assert.equal(h.calls.update.length, 0)
  h.choose('none'); await h.settle()
  assert.deepEqual(h.calls.update, [['provider-a', { networkProxyMode: 'none' }]])
  assert.equal(h.state.providers[0].networkProxyUrl, 'socks5://127.0.0.1:1080')
})

test('bilingual proxy text distinguishes global defaults, DIRECT rules and route checks from live tests', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/src/i18n/locales/zh-CN.json')))
  const en = JSON.parse(fs.readFileSync(path.join(root, 'src/renderer/src/i18n/locales/en-US.json')))
  assert.deepEqual(Object.keys(zh.provider.proxy).sort(), Object.keys(en.provider.proxy).sort())
  assert.match(zh.provider.proxy.systemDirect, /DIRECT（直连）/)
  assert.match(en.provider.proxy.systemDirect, /DIRECT/)
  assert.match(zh.provider.proxy.routeOnly, /不发送聊天/)
  assert.match(en.provider.proxy.routeOnly, /does not send a chat/)
  assert.match(zh.settings.oauthProxyModeHelp, /独立设置优先/)
  assert.match(en.settings.oauthProxyModeHelp, /independent override/)
  assert.match(fs.readFileSync(path.join(root, 'src/renderer/src/components/providers/ProviderCard.tsx'), 'utf8'), /<ProviderNetworkSettings provider=\{provider\}/)
})
