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
    '../../../../shared/accountReauthentication': require('../../src/shared/accountReauthentication.ts'),
    globals: { window: { electronAPI: {
      oauth: { startInAppLogin: async (...args) => { calls.login.push(args); return options.login ? options.login() : success() } },
      accounts: {
        reauthenticate: async (...args) => { calls.reauthenticate.push(args); return options.reauthenticate ? options.reauthenticate() : { success: true, accountId: 'existing-a', state: 'updated' } },
        getById: async (...args) => { calls.getById.push(args); return options.getById ? options.getById() : account({ id: args[0], providerId: props.provider.id, credentials: { token: 'SAVED-FIXTURE' } }) },
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

test('every existing builtin including Arena exposes a direct account-bound sign-in; custom has only credential editing', () => {
  for (const id of ['deepseek', 'glm', 'kimi', 'mimo', 'minimax', 'qwen', 'qwen-ai', 'zai', 'perplexity', 'arena']) {
    const f = fixture({ props: { provider: provider(id), editingAccount: account({ providerId: id }) } })
    const tabs = allNodes(f.render()).filter(node => node.type === TabsTrigger)
    assert.deepEqual(tabs.map(node => node.props.value), id === 'arena' ? ['oauth'] : ['manual', 'oauth'])
    assert.equal(text(f.find(node => node.props['data-testid'] === 'account-oauth-login')), f.t(id === 'zai' ? 'providers.openAccountLogin' : 'providers.relogin'))
  }
  for (const p of [provider('zai', { type: 'custom' }), provider('custom-id', { type: 'custom' })]) {
    const f = fixture({ props: { provider: p, editingAccount: account({ providerId: p.id }) } })
    assert.equal(f.find(node => node.props['data-testid'] === 'account-oauth-login'), undefined)
    assert.ok(renderToStaticMarkup(f.render()).includes(f.t('providers.updateCredentials')))
  }
})

test('all existing builtin sign-ins use only account ID and never re-submit credentials on a later metadata save', async () => {
  for (const id of ['deepseek', 'glm', 'kimi', 'mimo', 'minimax', 'qwen', 'qwen-ai', 'zai', 'perplexity', 'arena']) {
    const original = account({ providerId: id })
    const f = fixture({ props: { provider: provider(id), editingAccount: original } })
    await f.login()
    assert.deepEqual(f.calls.reauthenticate, [['existing-a']])
    assert.deepEqual(f.calls.login, []); assert.deepEqual(f.calls.update, []); assert.deepEqual(f.calls.add, [])
    assert.equal(f.name(), original.name)
    assert.equal(f.status(), f.t('providers.accountLoginUpdated'))
    await f.save()
    assert.equal(f.calls.update[0][0], original.id)
    for (const key of ['credentials', 'enabled', 'status', 'cooldownUntil', 'cooldownReason', 'id', 'providerId']) assert.equal(Object.hasOwn(f.calls.update[0][1], key), false)
    assert.deepEqual(original.credentials, { token: 'OLD-FIXTURE', captcha_verify_param: 'STALE-CAPTCHA-FIXTURE' })
  }
})

test('auto identity names use the refreshed verified baseline but never reinterpret a custom label', async () => {
  const auto = fixture({ props: { editingAccount: account({ nameSource: 'auto', name: 'old auto label' }) } })
  await auto.login(); assert.equal(auto.name(), 'same@example.test')
  const named = fixture({ props: { editingAccount: account({ name: 'not-the-login@example.test' }) } })
  await named.login(); assert.equal(named.name(), 'not-the-login@example.test')
})

test('generic failed or mismatched re-login preserves old credentials and displays only fixed safe errors', async () => {
  for (const errorCode of ['identity_mismatch', 'identity_unverified', 'cancelled', 'browser_error', 'PRIVATE-ERROR']) {
    const f = fixture({ reauthenticate: async () => ({ success: false, accountId: 'existing-a', state: 'failed', errorCode }) })
    await f.login()
    assert.deepEqual(plain(f.credentials()), account().credentials)
    assert.equal(f.status(), f.t('providers.accountLoginErrors.' + (errorCode === 'PRIVATE-ERROR' ? 'browser_error' : errorCode)))
    assert.deepEqual(f.calls.getById, []); assert.deepEqual(f.calls.update, []); assert.deepEqual(f.calls.add, [])
  }
})

test('generic re-login synchronously excludes duplicate login, credential edits, validation and save', async () => {
  const pending = deferred(), f = fixture({ reauthenticate: () => pending.promise })
  const first = f.login()
  await f.login(); await f.save(); await f.validate()
  const fields = f.find(node => node.props.fields && node.props.credentials)
  assert.equal(fields.props.disabled, true)
  fields.props.onChange('token', 'RACING-MANUAL-FIXTURE')
  assert.equal(f.credentials().token, 'OLD-FIXTURE')
  assert.equal(f.calls.reauthenticate.length, 1); assert.equal(f.calls.validate.length, 0); assert.equal(f.calls.update.length, 0)
  pending.resolve({ success: true, accountId: 'existing-a', state: 'updated' }); await first
  assert.equal(f.credentials().token, 'SAVED-FIXTURE')
})

test('generic account switches and closes cannot receive late login results', async () => {
  for (const change of ['close', 'account', 'provider', 'reopen']) {
    const pending = deferred(), f = fixture({ reauthenticate: () => pending.promise })
    const first = f.login()
    if (change === 'close') f.close()
    else if (change === 'account') f.setProps({ editingAccount: account({ id: 'account-b', name: 'B', credentials: { token: 'B-FIXTURE' } }) })
    else if (change === 'provider') f.setProps({ provider: provider('kimi'), editingAccount: account({ providerId: 'kimi', credentials: { token: 'B-FIXTURE' } }) })
    else { f.setProps({ open: false }); f.setProps({ open: true }) }
    const expected = plain(f.credentials())
    pending.resolve({ success: true, accountId: 'existing-a', state: 'updated' }); await first
    assert.deepEqual(plain(f.credentials()), expected)
    assert.deepEqual(f.calls.getById, []); assert.deepEqual(f.calls.update, [])
  }
})

test('manual editing still saves the original account and failed saves never fall back to creation', async () => {
  const f = fixture({ update: async () => { throw Error('save failed') } })
  f.find(node => node.props.fields && node.props.credentials).props.onChange('token', 'MANUAL-FIXTURE')
  await f.save()
  assert.equal(f.calls.update[0][0], 'existing-a')
  assert.equal(f.calls.update[0][1].credentials.token, 'MANUAL-FIXTURE')
  assert.equal(f.credentials().token, 'MANUAL-FIXTURE')
  assert.deepEqual(f.calls.close, []); assert.deepEqual(f.calls.add, [])
  await f.login(); assert.deepEqual(f.calls.reauthenticate, [])
})

test('pending metadata save cannot duplicate, start login/validation or close a newly selected account', async () => {
  const pending = deferred(), f = fixture({ update: () => pending.promise })
  const first = f.save()
  await f.save(); await f.login(); await f.validate()
  assert.equal(f.calls.update.length, 1); assert.equal(f.calls.reauthenticate.length, 0); assert.equal(f.calls.validate.length, 0)
  f.setProps({ editingAccount: account({ id: 'account-b', credentials: { token: 'B-FIXTURE' } }) })
  pending.resolve(); await first
  assert.equal(f.credentials().token, 'B-FIXTURE'); assert.deepEqual(f.calls.close, [])
})

test('new accounts keep OAuth draft/save and late-result protection without invoking account reauthentication', async () => {
  const fresh = fixture({ props: { editingAccount: null } })
  await fresh.login()
  assert.deepEqual(fresh.calls.login, [['deepseek', 'deepseek']]); assert.deepEqual(fresh.calls.reauthenticate, [])
  assert.equal(fresh.calls.add.length, 0)
  await fresh.save(); assert.deepEqual(fresh.calls.add[0].credentials, { token: 'NEW-FIXTURE' })
  const pending = deferred(), late = fixture({ props: { editingAccount: null }, login: () => pending.promise })
  const job = late.login(); late.close(); pending.resolve(success()); await job
  assert.deepEqual(plain(late.credentials()), {})
  assert.deepEqual(late.calls.add, [])
})

test('generic/Arena help distinguishes existing-profile reuse, verified saving and manual fallback from chat verification', () => {
  for (const language of ['zh-CN', 'en-US']) {
    for (const id of ['deepseek', 'arena']) {
      const f = fixture({ language, props: { provider: provider(id), editingAccount: account({ providerId: id }) } })
      const html = renderToStaticMarkup(f.render())
      assert.ok(html.includes(f.t(id === 'arena' ? 'providers.arenaAccountReloginHelp' : 'providers.accountReloginHelp')))
      assert.ok(html.includes(f.t(id === 'arena' ? 'providers.accountLoginSessionHelp' : 'providers.accountReloginSessionHelp')))
    }
    assert.match(translate('providers.accountLoginErrors.identity_unverified', {}, language), language === 'zh-CN' ? /手动输入/ : /Manual Input/)
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
  const errors = ['invalid_account', 'unsupported_provider', 'busy', 'cancelled', 'timeout', 'identity_mismatch', 'identity_unverified', 'login_required', 'network_error', 'route_changed', 'browser_error', 'account_changed', 'save_failed']
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
