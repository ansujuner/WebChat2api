const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const root = path.resolve(__dirname, '../..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function load(file, imports) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(read(file), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, console: { error() {} }, require(name) { assert.ok(Object.hasOwn(imports, name), `Unmocked dialog boundary ${name}`); return imports[name] }, ...imports.globals }, { filename: file })
  return module.exports
}
const accountIdentity = load('src/shared/accountIdentity.ts', {})
function translate(key, args = {}, lang = 'zh-CN') {
  const locale = JSON.parse(read(`src/renderer/src/i18n/locales/${lang}.json`))
  let value = key.split('.').reduce((obj, part) => obj?.[part], locale) || key
  for (const [key, arg] of Object.entries(args)) value = value.replaceAll(`{{${key}}}`, String(arg))
  return value
}
const wrap = ({ children }) => React.createElement('div', null, children)
const Button = ({ children, disabled }) => React.createElement('button', { disabled }, children)
const TabsTrigger = ({ children, value, disabled }) => React.createElement('button', { 'data-tab': value, disabled }, children)
const provider = (id = 'zai', changes = {}) => ({ id, name: id, type: 'builtin', authType: 'token', credentialFields: [{ name: 'token', label: 'Token', type: 'password', required: true }], ...changes })
const account = (changes = {}) => ({ id: 'existing-a', providerId: 'zai', name: 'My custom label', nameSource: 'custom', email: 'same@example.test', providerUserId: 'user-a', credentials: { token: 'OLD-FIXTURE', captcha_verify_param: 'STALE-CAPTCHA-FIXTURE' }, enabled: false, status: 'expired', cooldownUntil: 9999999999999, cooldownReason: 'temporary_ban', ...changes })
const success = changes => ({ success: true, credentials: { token: 'NEW-FIXTURE' }, accountInfo: { userId: 'user-a', email: 'same@example.test' }, ...changes })
function allNodes(tree) { const values = []; const walk = node => { if (React.isValidElement(node)) { values.push(node); React.Children.forEach(node.props.children, walk) } }; walk(tree); return values }
const text = node => typeof node === 'string' ? node : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(text).join('') : ''
function fixture(options = {}) {
  let index = 0, props = { open: true, provider: provider(), editingAccount: account(), ...options.props }
  const values = [], effectSlots = [], pending = [], calls = { login: [], validate: [], add: [], update: [], close: [] }
  const hooks = {
    useState(initial) { const slot = index++; if (!Object.hasOwn(values, slot)) values[slot] = typeof initial === 'function' ? initial() : initial; return [values[slot], value => { values[slot] = typeof value === 'function' ? value(values[slot]) : value }] },
    useRef(initial) { const slot = index++; if (!Object.hasOwn(values, slot)) values[slot] = { current: initial }; return values[slot] },
    useEffect(callback, deps) { const slot = index++, old = effectSlots[slot]; if (!old || deps.some((dep, i) => dep !== old.deps[i])) pending.push(() => { old?.cleanup?.(); effectSlots[slot] = { deps, cleanup: callback() } }) },
  }
  const t = (key, values) => translate(key, values, options.language)
  const { AddAccountDialog } = load('src/renderer/src/components/providers/AddAccountDialog.tsx', {
    react: hooks, 'react/jsx-runtime': require('react/jsx-runtime'), 'react-i18next': { useTranslation: () => ({ t }) },
    'lucide-react': new Proxy({}, { get: () => () => null }),
    '@/components/ui/dialog': Object.fromEntries(['Dialog', 'DialogContent', 'DialogDescription', 'DialogFooter', 'DialogHeader', 'DialogTitle'].map(name => [name, wrap])),
    '@/components/ui/button': { Button }, '@/components/ui/input': { Input: props => React.createElement('input', props) }, '@/components/ui/label': { Label: wrap }, '@/components/ui/badge': { Badge: wrap },
    '@/components/ui/tabs': { Tabs: wrap, TabsContent: wrap, TabsList: wrap, TabsTrigger },
    '../../../../shared/accountIdentity': accountIdentity,
    globals: { window: { electronAPI: { oauth: { startInAppLogin: async (...args) => { calls.login.push(args); return options.login ? options.login() : success() } } } } },
  })
  const callbacks = {
    onOpenChange(open) { calls.close.push(open) },
    async onValidateToken(id, credentials) { calls.validate.push([id, plain(credentials)]); return options.validate ? options.validate() : { valid: true, userInfo: { email: 'same@example.test', userId: 'user-a' } } },
    async onAddAccount(data) { calls.add.push(plain(data)); if (options.add) return options.add() },
    async onUpdateAccount(id, data) { calls.update.push([id, plain(data)]); if (options.update) return options.update() },
  }
  const render = (effects = true) => { index = 0; let tree = AddAccountDialog({ ...callbacks, ...props }); if (effects) pending.splice(0).forEach(fn => fn()); index = 0; tree = AddAccountDialog({ ...callbacks, ...props }); return tree }
  const find = predicate => allNodes(render()).find(predicate)
  return { calls, t, render, find,
    setProps(next, effects = true) { props = { ...props, ...next }; return render(effects) },
    login() { return find(node => node.props['data-testid'] === 'account-oauth-login')?.props.onClick() },
    save() { return find(node => node.type === Button && [t(props.editingAccount ? 'providers.saveChanges' : 'providers.addAccount'), t('providers.saving')].includes(text(node))).props.onClick() },
    validate() { return find(node => node.type === Button && text(node) === t('providers.validateCredentials')).props.onClick() },
    credentials() { return find(node => node.props.fields && node.props.credentials)?.props.credentials },
    name() { return find(node => node.props.id === 'name').props.value },
    status() { return allNodes(render()).filter(node => node.props.role === 'status').map(text).join(' ') },
    close() { find(node => typeof node.props.onOpenChange === 'function').props.onOpenChange(false) },
    unmount() { effectSlots.forEach(effect => effect?.cleanup?.()) },
  }
}

test('existing supported builtin accounts expose OAuth login beside manual credentials; Arena and custom stay excluded', () => {
  for (const id of ['deepseek', 'glm', 'kimi', 'mimo', 'minimax', 'qwen', 'qwen-ai', 'zai', 'perplexity']) {
    const f = fixture({ props: { provider: provider(id), editingAccount: account({ providerId: id }) } })
    const tabs = allNodes(f.render()).filter(node => node.type === TabsTrigger)
    assert.deepEqual(tabs.map(node => node.props.value), ['manual', 'oauth'])
    assert.equal(text(tabs[1]), f.t('providers.oauthLogin'))
    assert.equal(text(f.find(node => node.props['data-testid'] === 'account-oauth-login')), f.t('providers.relogin'))
  }
  for (const p of [provider('arena'), provider('zai', { type: 'custom' }), provider('custom-id', { type: 'custom' })]) {
    const f = fixture({ props: { provider: p, editingAccount: account({ providerId: p.id }) } })
    assert.equal(f.find(node => node.props['data-testid'] === 'account-oauth-login'), undefined)
  }
})

test('successful re-login is draft-only until explicit save, updates exactly the existing ID and drops stale CAPTCHA', async () => {
  const original = Object.freeze(account())
  const f = fixture({ props: { editingAccount: original } })
  await f.login()
  assert.deepEqual(f.calls.login, [['zai', 'zai']])
  assert.deepEqual(f.calls.add, []); assert.deepEqual(f.calls.update, [])
  assert.equal(f.name(), original.name)
  assert.deepEqual(plain(f.credentials()), { token: 'NEW-FIXTURE' })
  assert.equal(f.status(), f.t('providers.reloginSaveRequired'))
  await f.save()
  assert.equal(f.calls.update.length, 1)
  assert.equal(f.calls.update[0][0], original.id)
  assert.equal(f.calls.update[0][1].name, original.name)
  assert.equal(f.calls.update[0][1].nameSource, 'custom')
  assert.deepEqual(f.calls.update[0][1].credentials, { token: 'NEW-FIXTURE' })
  for (const key of ['enabled', 'status', 'cooldownUntil', 'cooldownReason', 'id', 'providerId']) assert.equal(Object.hasOwn(f.calls.update[0][1], key), false)
  assert.deepEqual(original.credentials, { token: 'OLD-FIXTURE', captcha_verify_param: 'STALE-CAPTCHA-FIXTURE' })
  assert.deepEqual(f.calls.add, [])
})

test('auto identity labels use actual verified metadata while custom and display-name-only identities are preserved', async () => {
  const auto = fixture({ props: { editingAccount: account({ nameSource: 'auto', name: 'zai · account-a', email: undefined, providerUserId: undefined }) } })
  await auto.login(); assert.equal(auto.name(), 'same@example.test')
  const named = fixture({ props: { editingAccount: account({ name: 'not-the-login@example.test', email: undefined, providerUserId: undefined }) } })
  await named.login(); assert.equal(named.name(), 'not-the-login@example.test')
  assert.deepEqual(plain(named.credentials()), { token: 'NEW-FIXTURE' })
})

test('a different known provider identity or email never replaces the original account credentials', async () => {
  for (const accountInfo of [{ userId: 'other-user', email: 'same@example.test' }, { userId: 'user-a', email: 'other@example.test' }]) {
    const f = fixture({ login: async () => success({ accountInfo }) })
    await f.login()
    assert.deepEqual(plain(f.credentials()), account().credentials)
    assert.equal(f.status(), f.t('providers.reloginIdentityMismatch'))
    assert.deepEqual(f.calls.update, []); assert.deepEqual(f.calls.add, [])
  }
  const sameCase = fixture({ login: async () => success({ accountInfo: { userId: 'user-a', email: 'SAME@example.test' } }) })
  await sameCase.login(); assert.equal(sameCase.credentials().token, 'NEW-FIXTURE')
})

test('failed, cancelled and incomplete OAuth results keep original credentials and do not expose raw errors', async () => {
  for (const login of [async () => ({ success: false, error: 'SECRET-ERROR-FIXTURE' }), async () => ({ success: false, error: 'Login window was closed' }),
    async () => { throw Error('SECRET-ERROR-FIXTURE') }, async () => success({ credentials: {} }), async () => success({ credentials: { token: { invalid: true } } })]) {
    const f = fixture({ login })
    await f.login()
    assert.deepEqual(plain(f.credentials()), account().credentials)
    assert.ok(f.status()); assert.doesNotMatch(f.status(), /SECRET-ERROR-FIXTURE/)
    assert.equal(f.find(node => node.props['data-testid'] === 'account-oauth-login').props.disabled, false)
    assert.deepEqual(f.calls.update, []); assert.deepEqual(f.calls.add, [])
  }
})

test('OAuth synchronously excludes duplicate login, credential edits, validation and save until completion', async () => {
  const pending = deferred(), f = fixture({ login: () => pending.promise })
  const first = f.login()
  await f.login(); await f.save(); await f.validate()
  const fields = f.find(node => node.props.fields && node.props.credentials)
  assert.equal(fields.props.disabled, true)
  fields.props.onChange('token', 'RACING-MANUAL-FIXTURE')
  assert.equal(f.credentials().token, 'OLD-FIXTURE')
  assert.equal(f.calls.login.length, 1); assert.equal(f.calls.validate.length, 0); assert.equal(f.calls.update.length, 0)
  pending.resolve(success()); await first
  assert.equal(f.credentials().token, 'NEW-FIXTURE')
  await f.save(); assert.equal(f.calls.update.length, 1)
})

test('closing the dialog immediately discards late OAuth even before the parent rerenders', async () => {
  const pending = deferred(), f = fixture({ login: () => pending.promise })
  const first = f.login(); f.close()
  pending.resolve(success()); await first
  assert.equal(f.credentials().token, 'OLD-FIXTURE')
  assert.deepEqual(f.calls.close, [false]); assert.deepEqual(f.calls.update, [])
})

test('switching account/provider or reopening the same account ignores old OAuth results', async () => {
  for (const change of ['account', 'provider', 'reopen']) {
    const pending = deferred(), f = fixture({ login: () => pending.promise })
    const first = f.login()
    if (change === 'account') f.setProps({ editingAccount: account({ id: 'account-b', name: 'B', credentials: { token: 'B-FIXTURE' } }) })
    else if (change === 'provider') f.setProps({ provider: provider('kimi'), editingAccount: account({ providerId: 'kimi', credentials: { token: 'B-FIXTURE' } }) })
    else { f.setProps({ open: false }); f.setProps({ open: true }) }
    const expected = plain(f.credentials())
    pending.resolve(success()); await first
    assert.deepEqual(plain(f.credentials()), expected)
    assert.equal(f.status(), '')
    assert.deepEqual(f.calls.update, [])
  }
})

test('a late rejected validation cannot overwrite a different account or unlock its pending login', async () => {
  const validation = deferred(), login = deferred(), f = fixture({ validate: () => validation.promise, login: () => login.promise })
  const old = f.validate()
  await f.login(); await f.save(); assert.equal(f.calls.login.length, 0); assert.equal(f.calls.update.length, 0)
  f.setProps({ editingAccount: account({ id: 'account-b', credentials: { token: 'B-FIXTURE' } }) })
  const current = f.login()
  validation.reject(Error('STALE-VALIDATION-FIXTURE')); await old
  assert.equal(f.find(node => node.props['data-testid'] === 'account-oauth-login').props.disabled, true)
  assert.equal(f.credentials().token, 'B-FIXTURE')
  login.resolve(success()); await current
  assert.equal(f.credentials().token, 'NEW-FIXTURE')
})

test('manual editing still saves the existing account; failed save preserves draft and cannot fall back to create', async () => {
  const f = fixture({ update: async () => { throw Error('save failed') } })
  f.find(node => node.props.fields && node.props.credentials).props.onChange('token', 'MANUAL-FIXTURE')
  await f.save()
  assert.equal(f.calls.update[0][0], 'existing-a')
  assert.equal(f.calls.update[0][1].credentials.token, 'MANUAL-FIXTURE')
  assert.equal(f.credentials().token, 'MANUAL-FIXTURE')
  assert.deepEqual(f.calls.close, []); assert.deepEqual(f.calls.add, [])
  const missing = fixture({ props: { onUpdateAccount: undefined } })
  await missing.save(); assert.deepEqual(missing.calls.add, [])
})

test('pending save cannot duplicate, start OAuth/validation or close a newly selected account on completion', async () => {
  const pending = deferred(), f = fixture({ update: () => pending.promise })
  const first = f.save()
  await f.save(); await f.login(); await f.validate()
  assert.equal(f.calls.update.length, 1); assert.equal(f.calls.login.length, 0); assert.equal(f.calls.validate.length, 0)
  f.setProps({ editingAccount: account({ id: 'account-b', credentials: { token: 'B-FIXTURE' } }) })
  pending.resolve(); await first
  assert.equal(f.credentials().token, 'B-FIXTURE'); assert.deepEqual(f.calls.close, [])
})

test('help and saved-draft notices describe credential validation/liveness and never promise restriction recovery', () => {
  for (const language of ['zh-CN', 'en-US']) {
    const f = fixture({ language })
    const tree = f.render()
    const html = renderToStaticMarkup(tree)
    assert.ok(html.includes(f.t('providers.reloginHelp')))
    for (const key of ['relogin', 'reloginHelp', 'reloginSaveRequired', 'reloginIdentityMismatch', 'reloginInvalidCredentials']) assert.notEqual(f.t(`providers.${key}`), `providers.${key}`)
  }
})
