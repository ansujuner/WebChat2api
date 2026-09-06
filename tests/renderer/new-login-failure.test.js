const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.join(__dirname, '../..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const compile = file => ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
const mapping = { exports: {} }
vm.runInNewContext(compile('src/renderer/src/lib/loginFailure.ts'), { module: mapping, exports: mapping.exports })
const keyOf = mapping.exports.newLoginFailureKey
const translate = (key, lang = 'zh-CN') => key.split('.').reduce((value, part) => value?.[part], JSON.parse(read(`src/renderer/src/i18n/locales/${lang}.json`))) || key
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function providerDialog({ result, throws, lang = 'zh-CN' } = {}) {
  const state = [], effects = [], pending = [], calls = [], logs = []
  let index = 0, tree
  const props = { open: true, builtinProviders: [{ id: 'arena', name: 'Arena', type: 'builtin', description: 'Fixture', supportedModels: [], credentialFields: [{ name: 'browserProfileId', required: true, label: 'Profile', type: 'password' }] }], onOpenChange() {}, onSelectBuiltin() {}, onCreateCustom() {} }
  const hooks = {
    useState(initial) { const slot = index++; if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial; return [state[slot], value => { state[slot] = typeof value === 'function' ? value(state[slot]) : value }] },
    useRef(initial) { return hooks.useState(() => ({ current: initial }))[0] },
    useEffect(callback, deps) { const slot = index++; if (!effects[slot] || deps.some((dep, i) => dep !== effects[slot].deps[i])) pending.push(() => { effects[slot]?.cleanup?.(); effects[slot] = { deps, cleanup: callback() } }) },
  }
  const module = { exports: {} }
  vm.runInNewContext(compile('src/renderer/src/components/providers/AddProviderDialog.tsx'), {
    module, exports: module.exports, console: { log: (...value) => logs.push(value), error: (...value) => logs.push(value) },
    window: { electronAPI: { oauth: { startInAppLogin: async (...args) => { calls.push(args); if (throws) throw Error('PRIVATE-SENTINEL'); return typeof result === 'function' ? result() : result } } } },
    require(name) {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
      if (name === 'react-i18next') return { useTranslation: () => ({ t: key => translate(key, lang) }) }
      if (name === '@/lib/loginFailure') return mapping.exports
      if (name === '@/lib/providerIcons') return { providerIcons: {} }
      if (name === '@/lib/utils') return { cn: () => '' }
      return new Proxy({}, { get: (_, key) => key })
    },
  })
  const walk = node => Array.isArray(node) ? node.flatMap(walk) : !node || typeof node !== 'object' ? [] : [node, ...walk(node.props?.children)]
  const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' ? node : node?.props ? text(node.props.children) : ''
  const render = () => { index = 0; tree = module.exports.AddProviderDialog(props); if (pending.length) { pending.splice(0).forEach(callback => callback()); return render() }; return tree }
  const find = predicate => walk(tree).find(predicate)
  const button = key => find(node => node.type === 'Button' && text(node).trim() === translate(key, lang))
  render()
  find(node => node.type === 'div' && node.props.onClick && text(node).includes('Arena')).props.onClick()
  render(); button('common.next').props.onClick(); render()
  return { calls, logs, render, props,
    async login() { const pending = find(node => node.props['data-testid'] === 'provider-oauth-login').props.onClick(); render(); await pending; render() },
    status: () => text(find(node => node.props.role === 'status')),
    close() { props.open = false; render() },
    back() { button('common.previous').props.onClick(); render() },
    submitDisabled: () => button('providers.addAccount').props.disabled,
  }
}

test('all new-login fixed codes and generic failure resolve in both languages, never to literal keys', () => {
  for (const lang of ['zh-CN', 'en-US']) {
    const codes = Object.keys(JSON.parse(read(`src/renderer/src/i18n/locales/${lang}.json`)).providers.loginErrors)
    for (const errorCode of codes) {
      const key = keyOf({ errorCode, error: 'PRIVATE-SENTINEL' })
      assert.equal(key, `providers.loginErrors.${errorCode}`)
      assert.notEqual(translate(key, lang), key)
      assert.doesNotMatch(translate(key, lang), /PRIVATE-SENTINEL/)
    }
    for (const result of [null, { error: 'PRIVATE-SENTINEL' }, { errorCode: '__proto__', error: 'PRIVATE-SENTINEL' }, { errorCode: 'providers.loginFailed' }, { error: { toString: () => 'PRIVATE-SENTINEL' } }]) {
      assert.equal(keyOf(result), 'providers.loginFailed')
      assert.notEqual(translate(keyOf(result), lang), keyOf(result))
    }
  }
})

test('legacy internal fixed errors remain translated without substring classification', () => {
  assert.equal(keyOf({ error: 'Login window was closed.' }), 'providers.loginWindowClosed')
  assert.equal(keyOf({ error: 'A login process is already in progress' }), 'providers.loginWindowAlreadyOpen')
  assert.equal(keyOf({ error: 'Guest account not allowed, please login with a real account' }), 'providers.guestAccountNotAllowed')
  assert.equal(keyOf({ error: 'Guest account PRIVATE-SENTINEL' }), 'providers.loginFailed')
})

test('AddProviderDialog displays only localized safe failures and never logs raw result/exception prose', async () => {
  for (const lang of ['zh-CN', 'en-US']) {
    for (const options of [{ result: { success: false, error: 'PRIVATE-SENTINEL' } }, { throws: true }, { result: { success: false, errorCode: 'network_error', error: 'PRIVATE-SENTINEL' } }]) {
      const f = providerDialog({ lang, ...options }); await f.login()
      assert.equal(f.status(), translate(options.result?.errorCode ? 'providers.loginErrors.network_error' : 'providers.loginFailed', lang))
      assert.doesNotMatch(JSON.stringify([f.logs, f.status()]), /PRIVATE-SENTINEL|providers\.loginFailed/)
      assert.equal(f.submitDisabled(), true)
    }
  }
})

test('new provider login ignores duplicates and late replies after leaving the form', async () => {
  for (const close of ['back', 'close']) {
    const pending = deferred(), f = providerDialog({ result: () => pending.promise })
    const first = f.login(), second = f.login()
    assert.equal(f.calls.length, 1)
    f[close]()
    pending.resolve({ success: false, errorCode: 'network_error' })
    await Promise.all([first, second])
    assert.equal(f.status(), '')
  }
})

test('success without complete credentials cannot show login success or unlock adding Arena', async () => {
  for (const credentials of [{}, { browserProfileId: '' }, { browserProfileId: 1 }, []]) {
    const f = providerDialog({ result: { success: true, providerId: 'arena', credentials } }); await f.login()
    assert.equal(f.status(), translate('providers.loginErrors.identity_unverified'))
    assert.equal(f.submitDisabled(), true)
  }
})
