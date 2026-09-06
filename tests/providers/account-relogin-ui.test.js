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
const provider = (id = 'deepseek', changes = {}) => ({ id, name: id, type: 'builtin', authType: 'token', credentialFields: [{ name: 'token', label: 'Token', type: 'password', required: true }], ...changes })
const account = (changes = {}) => ({ id: 'existing-a', providerId: 'deepseek', name: 'My custom label', nameSource: 'custom', email: 'same@example.test', providerUserId: 'user-a', credentials: { token: 'OLD-FIXTURE', captcha_verify_param: 'STALE-CAPTCHA-FIXTURE' }, enabled: false, status: 'expired', cooldownUntil: 9999999999999, cooldownReason: 'temporary_ban', ...changes })
const success = changes => ({ success: true, credentials: { token: 'NEW-FIXTURE' }, accountInfo: { userId: 'user-a', email: 'same@example.test' }, ...changes })
function allNodes(tree) { const values = []; const walk = node => { if (React.isValidElement(node)) { values.push(node); React.Children.forEach(node.props.children, walk) } }; walk(tree); return values }
const text = node => typeof node === 'string' ? node : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(text).join('') : ''
function fixture(options = {}) {
  let index = 0, props = { open: true, provider: provider(), editingAccount: account(), ...options.props }
  const values = [], effectSlots = [], pending = [], calls = { login: [], reauthenticate: [], getById: [], validate: [], add: [], update: [], close: [] }
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
    globals: { window: { electronAPI: {
      oauth: { startInAppLogin: async (...args) => { calls.login.push(args); return options.login ? options.login() : success() } },
      accounts: {
        reauthenticate: async (...args) => { calls.reauthenticate.push(args); return options.reauthenticate ? options.reauthenticate() : { success: true, accountId: 'existing-a', state: 'updated' } },
        getById: async (...args) => { calls.getById.push(args); return options.getById ? options.getById() : account({ providerId: 'zai', credentials: { token: 'SAVED-FIXTURE' } }) },
      },
    } } },
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
    assert.equal(text(f.find(node => node.props['data-testid'] === 'account-oauth-login')), f.t(id === 'zai' ? 'providers.openAccountLogin' : 'providers.relogin'))
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
  assert.deepEqual(f.calls.login, [['deepseek', 'deepseek']])
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

const zaiFixture = (options = {}) => fixture({ ...options, props: { provider: provider('zai'), editingAccount: account({ providerId: 'zai' }), ...options.props } })

test('existing Zai login binds only the account ID, refreshes the backend-saved baseline and never needs a second credential save', async () => {
  for (const state of ['restored', 'updated']) {
    const f = zaiFixture({ reauthenticate: async () => ({ success: true, accountId: 'existing-a', state }) })
    await f.login()
    assert.deepEqual(f.calls.reauthenticate, [['existing-a']])
    assert.deepEqual(f.calls.login, []); assert.deepEqual(f.calls.update, []); assert.deepEqual(f.calls.add, [])
    assert.deepEqual(f.calls.getById, [['existing-a', true]])
    assert.deepEqual(plain(f.credentials()), { token: 'SAVED-FIXTURE' })
    assert.equal(f.status(), f.t(state === 'updated' ? 'providers.accountLoginUpdated' : 'providers.accountLoginRestored'))
    assert.equal(f.name(), 'My custom label')
    assert.equal(allNodes(f.render()).some(node => text(node) === f.t('providers.validationSuccess')), false)
    await f.save()
    assert.equal(f.calls.update.length, 1)
    assert.equal(f.calls.update[0][0], 'existing-a')
    for (const key of ['credentials', 'status', 'enabled', 'cooldownUntil', 'cooldownReason']) assert.equal(Object.hasOwn(f.calls.update[0][1], key), false)
  }
})

test('unchanged credential edits never overwrite the backend; a deliberate edit saves the complete latest baseline', async () => {
  const untouched = fixture({ props: { editingAccount: account({ credentials: {} }) } })
  await untouched.save()
  assert.equal(untouched.calls.update.length, 1)
  assert.equal(Object.hasOwn(untouched.calls.update[0][1], 'credentials'), false)
  const f = zaiFixture({ getById: async () => account({ providerId: 'zai', credentials: { token: 'ROTATED-FIXTURE', other: 'LATEST-FIELD' } }) })
  await f.login()
  assert.deepEqual(f.calls.reauthenticate, [['existing-a']])
  assert.deepEqual(plain(f.credentials()), { token: 'ROTATED-FIXTURE', other: 'LATEST-FIELD' })
  f.find(node => node.props.fields && node.props.credentials).props.onChange('token', 'MANUAL-FIXTURE')
  assert.equal(f.status(), f.t('providers.accountLoginSaveDraftFirst'))
  await f.save()
  assert.deepEqual(f.calls.update[0][1].credentials, { token: 'MANUAL-FIXTURE', other: 'LATEST-FIELD' })
})

test('unsaved manual Zai credentials block restoration synchronously without discarding the draft', async () => {
  const f = zaiFixture()
  f.find(node => node.props.fields && node.props.credentials).props.onChange('token', 'UNSAVED-FIXTURE')
  assert.equal(f.find(node => node.props['data-testid'] === 'account-oauth-login').props.disabled, true)
  await f.login()
  assert.deepEqual(f.calls.reauthenticate, []); assert.deepEqual(f.calls.login, []); assert.deepEqual(f.calls.getById, [])
  assert.equal(f.credentials().token, 'UNSAVED-FIXTURE')
  assert.equal(f.status(), f.t('providers.accountLoginSaveDraftFirst'))
  await f.save()
  assert.equal(f.calls.update[0][1].credentials.token, 'UNSAVED-FIXTURE')
})

test('new Zai accounts still use the normal OAuth draft flow instead of restoring another account', async () => {
  const f = zaiFixture({ props: { editingAccount: null } })
  await f.login()
  assert.deepEqual(f.calls.login, [['zai', 'zai']]); assert.deepEqual(f.calls.reauthenticate, [])
  await f.save()
  assert.deepEqual(f.calls.add[0].credentials, { token: 'NEW-FIXTURE' })
})

test('Zai restoration failures preserve the original draft, translate all safe errors and never render provider text', async () => {
  const errors = ['invalid_account', 'unsupported_provider', 'busy', 'cancelled', 'timeout', 'identity_mismatch', 'identity_unverified', 'login_required', 'network_error', 'browser_error', 'account_changed', 'save_failed']
  for (const language of ['zh-CN', 'en-US']) {
    for (const errorCode of [...errors, 'SECRET-ERROR-FIXTURE', '__proto__']) {
      const f = zaiFixture({ language, reauthenticate: async () => ({ success: false, accountId: 'existing-a', state: 'failed', errorCode, error: 'SECRET-ERROR-FIXTURE' }) })
      await f.login()
      const key = `providers.accountLoginErrors.${errors.includes(errorCode) ? errorCode : 'browser_error'}`
      assert.equal(f.status(), f.t(key)); assert.notEqual(f.status(), key)
      assert.deepEqual(plain(f.credentials()), account().credentials)
      assert.deepEqual(f.calls.getById, []); assert.deepEqual(f.calls.update, [])
      assert.doesNotMatch(f.status(), /SECRET-ERROR-FIXTURE|__proto__/)
    }
  }
  for (const result of [null, { success: true, accountId: 'other-account', state: 'updated' }, { success: true, accountId: 'existing-a', state: 'unverified' }]) {
    const f = zaiFixture({ reauthenticate: async () => result })
    await f.login(); assert.deepEqual(f.calls.getById, []); assert.deepEqual(plain(f.credentials()), account().credentials)
  }
  const thrown = zaiFixture({ reauthenticate: async () => { throw Error('SECRET-ERROR-FIXTURE') } })
  await thrown.login(); assert.equal(thrown.status(), thrown.t('providers.accountLoginErrors.browser_error'))
})

test('restoration has a single busy operation through the saved-baseline read and forbids duplicate login/save/validation', async () => {
  const pending = deferred(), refresh = deferred(), f = zaiFixture({ reauthenticate: () => pending.promise, getById: () => refresh.promise })
  const first = f.login()
  assert.equal(text(f.find(node => node.props['data-testid'] === 'account-oauth-login')), f.t('providers.accountLoginRestoring'))
  await f.login(); await f.save(); await f.validate()
  assert.equal(f.calls.reauthenticate.length, 1); assert.deepEqual(f.calls.update, []); assert.deepEqual(f.calls.validate, [])
  pending.resolve({ success: true, accountId: 'existing-a', state: 'updated' })
  await Promise.resolve(); await Promise.resolve()
  await f.login(); await f.save(); await f.validate()
  assert.equal(f.calls.reauthenticate.length, 1); assert.equal(f.find(node => node.props.fields && node.props.credentials).props.disabled, true)
  refresh.resolve(account({ providerId: 'zai', credentials: { token: 'LATEST-FIXTURE' } })); await first
  assert.equal(f.find(node => node.props['data-testid'] === 'account-oauth-login').props.disabled, false)
  assert.equal(f.credentials().token, 'LATEST-FIXTURE')
})

test('closing or switching accounts discards both late restoration and late saved-baseline reads', async () => {
  for (const stage of ['reauthenticate', 'getById']) {
    for (const target of ['close', 'account', 'provider', 'reopen']) {
      const pending = deferred(), f = zaiFixture({ [stage]: () => pending.promise })
      const first = f.login()
      await Promise.resolve(); await Promise.resolve()
      if (target === 'close') f.close()
      else if (target === 'account') f.setProps({ editingAccount: account({ id: 'account-b', providerId: 'zai', credentials: { token: 'B-FIXTURE' } }) })
      else if (target === 'provider') f.setProps({ provider: provider('kimi'), editingAccount: account({ providerId: 'kimi', credentials: { token: 'K-FIXTURE' } }) })
      else { f.setProps({ open: false }); f.setProps({ open: true }) }
      const before = plain(f.credentials())
      pending.resolve(stage === 'reauthenticate' ? { success: true, accountId: 'existing-a', state: 'updated' } : account({ providerId: 'zai', credentials: { token: 'LATE-FIXTURE' } }))
      await first
      assert.deepEqual(plain(f.credentials()), before)
      if (stage === 'reauthenticate') assert.deepEqual(f.calls.getById, [])
      assert.deepEqual(f.calls.update, []); assert.deepEqual(f.calls.add, [])
    }
  }
})

test('a failed baseline read reports backend success separately and never permits stale credential editing or overwrite', async () => {
  for (const getById of [async () => null, async () => account({ id: 'other-account' }), async () => { throw Error('SECRET-READ-FIXTURE') }]) {
    const f = zaiFixture({ getById })
    await f.login()
    assert.equal(f.status(), f.t('providers.accountLoginSavedRefreshFailed'))
    const fields = f.find(node => node.props.fields && node.props.credentials)
    assert.equal(fields.props.disabled, true)
    fields.props.onChange('token', 'STALE-EDIT-FIXTURE'); await f.validate()
    assert.deepEqual(plain(f.credentials()), {}); assert.deepEqual(f.calls.validate, [])
    await f.save()
    assert.equal(f.calls.update.length, 1); assert.equal(Object.hasOwn(f.calls.update[0][1], 'credentials'), false)
  }
})

test('Zai restored login help distinguishes opening, verified identity, automatic save and old webpage sessions', () => {
  for (const language of ['zh-CN', 'en-US']) {
    const f = zaiFixture({ language }), html = renderToStaticMarkup(f.render())
    for (const key of ['openAccountLogin', 'accountLoginHelp', 'accountLoginSessionHelp']) {
      assert.notEqual(f.t(`providers.${key}`), `providers.${key}`)
      assert.ok(html.includes(f.t(`providers.${key}`)))
    }
    assert.equal(html.includes(f.t('providers.reloginHelp')), false)
  }
})

test('account page rejects a disappeared account rather than reporting a no-write save as success', async () => {
  const filename = 'src/renderer/src/pages/Providers.tsx', source = read(filename)
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let handler
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'handleUpdateAccount') handler = node.initializer; ts.forEachChild(node, visit) }
  visit(ast); assert.ok(handler)
  const notifications = [], module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(`module.exports = ${handler.getText(ast)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, store: { getAccountById: () => undefined }, t: key => key, toast: value => notifications.push(value), window: { electronAPI: { accounts: { update() { assert.fail('Missing account must not be updated') } } } } })
  await assert.rejects(module.exports('deleted-account', {}), /providers.operationFailed/)
  assert.equal(notifications.length, 1); assert.equal(notifications[0].variant, 'destructive')
})
