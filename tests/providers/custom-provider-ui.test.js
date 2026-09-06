const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const root = path.resolve(__dirname, '../..'), prefix = 'src/renderer/src/'
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
function load(file, imports, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(read(file), { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { module, exports: module.exports, Date, URL, console: { log() {}, error() {} }, require(name) { assert.ok(Object.hasOwn(imports, name), `Unmocked boundary ${name}`); return imports[name] }, ...globals }, { filename: file })
  return module.exports
}
const dictionary = language => JSON.parse(read(`${prefix}i18n/locales/${language}.json`))
const t = (key, args = {}, language = 'zh-CN') => {
  let value = key.split('.').reduce((object, part) => object?.[part], dictionary(language)) || key
  for (const [name, arg] of Object.entries(args)) value = value.replaceAll(`{{${name}}}`, String(arg))
  return value
}
const wrapper = ({ children }) => React.createElement('div', null, children)
const button = ({ children, onClick, disabled }) => React.createElement('button', { onClick, disabled }, children)
const imports = {
  'react/jsx-runtime': require('react/jsx-runtime'), 'react-i18next': { useTranslation: () => ({ t }) },
  'lucide-react': new Proxy({}, { get: () => () => null }),
  '@/components/ui/dialog': Object.fromEntries(['Dialog', 'DialogContent', 'DialogDescription', 'DialogFooter', 'DialogHeader', 'DialogTitle'].map(name => [name, wrapper])),
  '@/components/ui/button': { Button: button }, '@/components/ui/input': { Input: props => React.createElement('input', props) },
  '@/components/ui/textarea': { Textarea: props => React.createElement('textarea', props) }, '@/components/ui/label': { Label: wrapper },
  '@/components/ui/badge': { Badge: wrapper }, '@/components/ui/switch': { Switch: wrapper },
}
function hooks() {
  let index = 0
  const values = [], effectSlots = [], pending = []
  return {
    api: { useState(initial) { const slot = index++; if (!Object.hasOwn(values, slot)) values[slot] = typeof initial === 'function' ? initial() : initial; return [values[slot], next => { values[slot] = typeof next === 'function' ? next(values[slot]) : next }] },
      useRef(initial) { const slot = index++; if (!Object.hasOwn(values, slot)) values[slot] = { current: initial }; return values[slot] },
      useEffect(callback, deps) { const slot = index++, old = effectSlots[slot]; if (!old || deps.some((value, i) => value !== old.deps[i])) pending.push(() => { old?.cleanup?.(); effectSlots[slot] = { deps, cleanup: callback() } }) },
      useMemo: callback => callback(),
    },
    render(component, props, effects = true) { index = 0; let tree = component(props); if (effects) pending.splice(0).forEach(callback => callback()); else pending.length = 0; index = 0; return component(props) },
  }
}
function elements(tree) { const list = []; const walk = node => { if (React.isValidElement(node)) { list.push(node); React.Children.forEach(node.props.children, walk) } }; walk(tree); return list }
function content(node) { if (typeof node === 'string' || typeof node === 'number') return String(node); return React.isValidElement(node) ? React.Children.toArray(node.props.children).map(content).join('') : '' }
function formFixture(extra = {}) {
  const h = hooks(), submitted = [], closed = []
  let props = { open: true, onOpenChange: value => closed.push(value), onSubmit: async value => submitted.push(plain(value)), ...extra }
  const { CustomProviderForm } = load(prefix + 'components/providers/CustomProviderForm.tsx', { ...imports, react: h.api })
  const render = () => h.render(CustomProviderForm, props)
  const find = predicate => elements(render()).find(predicate)
  return { submitted, closed, render, find, setProps(next) { props = { ...props, ...next }; render() },
    change(id, value) { find(item => item.props.id === id).props.onChange({ target: { value } }) },
    click(label) { return find(item => item.type === button && content(item) === label).props.onClick() },
  }
}
const valid = { name: 'Fixture API', apiEndpoint: 'http://127.0.0.1:12345/v1', supportedModels: ['manual-model'], headers: {}, authType: 'token', credentialFields: [{ name: 'apiKey', label: 'API Key', type: 'password', required: true }] }

test('custom form is actionable, OpenAI-compatible and keeps keys out of connection configuration', async () => {
  const f = formFixture({ initialData: valid })
  assert.match(renderToStaticMarkup(f.render()), /OpenAI-compatible/)
  await f.click(t('customProvider.createAndAddKey'))
  assert.equal(f.submitted.length, 1)
  assert.equal(f.submitted[0].authType, 'token')
  assert.deepEqual(f.submitted[0].credentialFields, valid.credentialFields)
  assert.equal(Object.hasOwn(f.submitted[0], 'credentials'), false)
  assert.deepEqual(f.closed, [false])
})

test('custom model input trims/deduplicates IDs and no-key mode is explicit rather than fabricated auth', async () => {
  const f = formFixture({ initialData: valid })
  f.change('custom-provider-models', 'model-a\nmodel-a,model-b\n')
  f.find(item => item.props.id === 'custom-provider-no-auth').props.onCheckedChange(true)
  await f.click(t('customProvider.createAndAddKey'))
  assert.deepEqual(f.submitted[0].supportedModels, ['model-a', 'model-b'])
  assert.equal(f.submitted[0].credentialFields[0].required, false)
})

test('unsafe URLs and authentication headers are rejected without calls or secret-bearing error output', async () => {
  for (const url of ['javascript:alert(1)', 'file:///fixture', 'https://user:secret@example.test', 'https://example.test?key=secret', 'https://example.test/#private']) {
    const f = formFixture({ initialData: { ...valid, apiEndpoint: url } })
    await f.click(t('customProvider.createAndAddKey'))
    assert.equal(f.submitted.length, 0)
    assert.deepEqual(f.closed, [])
    assert.match(renderToStaticMarkup(f.render()), /role="alert"/)
  }
  const f = formFixture({ initialData: { ...valid, headers: { Authorization: 'SENSITIVE-FIXTURE' } } })
  assert.doesNotMatch(renderToStaticMarkup(f.render()), /SENSITIVE-FIXTURE/)
  await f.click(t('customProvider.createAndAddKey')); assert.equal(f.submitted.length, 0)
})

test('failed async save preserves the form and duplicate clicks never create two providers', async () => {
  let reject, calls = 0
  const f = formFixture({ initialData: valid, onSubmit: () => { calls++; return new Promise((_, no) => { reject = no }) } })
  const first = f.click(t('customProvider.createAndAddKey'))
  await f.click(t('customProvider.createAndAddKey'))
  assert.equal(calls, 1)
  assert.equal(f.find(item => item.props.id === 'custom-provider-name').props.disabled, true)
  reject(new Error('SENSITIVE-UPSTREAM-RESPONSE')); await first
  assert.deepEqual(f.closed, [])
  assert.equal(f.find(item => item.props.id === 'custom-provider-name').props.value, valid.name)
  const html = renderToStaticMarkup(f.render())
  assert.match(html, /保存失败/); assert.doesNotMatch(html, /SENSITIVE-UPSTREAM/)
})

test('switching editing provider resets all fields; reopening create never retains another provider', () => {
  const f = formFixture({ initialData: valid, providerId: 'one' })
  f.change('custom-provider-name', 'unsaved')
  f.setProps({ providerId: 'two', initialData: { ...valid, name: 'Second', apiEndpoint: 'https://second.test/v1' } })
  assert.equal(f.find(item => item.props.id === 'custom-provider-name').props.value, 'Second')
  f.setProps({ open: false }); f.setProps({ open: true, providerId: undefined, initialData: undefined })
  assert.equal(f.find(item => item.props.id === 'custom-provider-name').props.value, '')
  assert.equal(f.find(item => item.props.id === 'custom-provider-url').props.value, '')
})

test('model reads are explicit, preserve unsaved entries and cannot use an unsaved Base URL', async () => {
  let calls = 0
  const f = formFixture({ initialData: valid, providerId: 'one', onFetchModels: async () => { calls++; return ['fetched-model'] } })
  f.render(); assert.equal(calls, 0)
  f.change('custom-provider-url', 'https://new.test/v1')
  assert.equal(f.find(item => item.type === button && content(item) === t('customProvider.fetchModels')).props.disabled, true)
  await f.click(t('customProvider.fetchModels')); assert.equal(calls, 0)
  f.change('custom-provider-url', valid.apiEndpoint)
  await f.click(t('customProvider.fetchModels')); assert.equal(calls, 1)
  assert.equal(f.find(item => item.props.id === 'custom-provider-models').props.value, 'manual-model\nfetched-model')
})

test('failed model read leaves manual entries intact without raw error text', async () => {
  const f = formFixture({ initialData: valid, providerId: 'one', onFetchModels: async () => { throw Error('SENSITIVE-FIXTURE') } })
  await f.click(t('customProvider.fetchModels'))
  assert.equal(f.find(item => item.props.id === 'custom-provider-models').props.value, 'manual-model')
  assert.doesNotMatch(renderToStaticMarkup(f.render()), /SENSITIVE-FIXTURE/)
})

function pageFixture({ failSave = false } = {}) {
  const h = hooks(), calls = [], toasts = [], types = Object.fromEntries(['ProviderCard', 'AddProviderDialog', 'CustomProviderForm', 'AccountList', 'AddAccountDialog', 'AccountDetail', 'ProviderFilter'].map(name => [name, wrapper]))
  // Distinct function identities let the test inspect actual page wiring.
  for (const name of Object.keys(types)) types[name] = function Component() { return null }
  const state = { providers: [], accounts: [], builtinProviders: [], providerStatuses: {}, accountCounts: {}, isLoading: false, selectedProviderId: null,
    getProviderById(id) { return state.providers.find(item => item.id === id) }, getAccountsByProvider(id) { return state.accounts.filter(item => item.providerId === id) },
    addProvider(item) { state.providers = [...state.providers, item] }, setSelectedProviderId(id) { state.selectedProviderId = id }, setSelectedAccountId() {},
  }
  const store = () => state; store.getState = () => state
  const { Providers } = load(prefix + 'pages/Providers.tsx', { ...imports, react: h.api,
    '@/hooks/use-toast': { useToast: () => ({ toast: value => toasts.push(value) }) }, '@/stores/providersStore': { useProvidersStore: store },
    '@/components/providers': types, '@/components/models/ModelEditor': { ModelEditor: wrapper }, '@/components/providers/ProviderFilter': {},
    '@/components/ui/scroll-area': { ScrollArea: wrapper }, '../../../shared/accountIdentity': { validatedAccountIdentity: () => ({}) },
    '../../../shared/accountAvailability': { accountAvailability: () => ({ available: true }) }, '@/hooks/useAccountLiveness': { useAccountLiveness: () => ({ busy: false }) },
    '@/components/providers/AccountLivenessPanel': { AccountLivenessPanel: wrapper },
  }, { window: { electronAPI: { providers: { async add(data) { calls.push(plain(data)); if (failSave) throw Error('SECRET-FIXTURE'); return { ...data, id: 'custom-fixture' } } } } } })
  const render = () => h.render(Providers, {}, false)
  return { render, state, calls, toasts, find(name) { return elements(render()).find(item => item.type === types[name]) } }
}

test('real Providers page wiring saves a custom definition then opens its separate API key account dialog', async () => {
  const f = pageFixture()
  await f.find('CustomProviderForm').props.onSubmit(valid)
  assert.equal(f.calls[0].type, 'custom')
  assert.equal(Object.hasOwn(f.calls[0], 'credentials'), false)
  assert.equal(f.state.selectedProviderId, 'custom-fixture')
  const dialog = f.find('AddAccountDialog')
  assert.equal(dialog.props.open, true)
  assert.equal(dialog.props.provider.id, 'custom-fixture')
  assert.equal(dialog.props.provider.credentialFields[0].name, 'apiKey')
})

test('page save failures propagate to the form without closing it or retaining a partial provider', async () => {
  const f = pageFixture({ failSave: true })
  await assert.rejects(() => f.find('CustomProviderForm').props.onSubmit(valid), /Custom provider save failed/)
  assert.equal(f.state.providers.length, 0)
  assert.doesNotMatch(JSON.stringify(f.toasts), /SECRET-FIXTURE/)
})

test('custom creation and CRUD/model controls are reachable; provider deletion requires a dialog', () => {
  const add = read(prefix + 'components/providers/AddProviderDialog.tsx')
  assert.doesNotMatch(add, /TabsTrigger value="custom" disabled/)
  assert.doesNotMatch(add, /customProviderNotSupported/)
  assert.match(add, /providerTab === 'builtin'/)
  const page = read(prefix + 'pages/Providers.tsx')
  assert.match(page, /onDelete=\{id => setDeletingProvider/)
  assert.match(page, /deleteConfirm/)
  assert.match(page, /if \(!success\) throw new Error\('Provider deletion failed'\)/)
  const card = read(prefix + 'components/providers/ProviderCard.tsx')
  assert.match(card, /!isBuiltin && <div/)
  for (const action of ['onEdit', 'onUpdateModels', 'onDelete']) assert.match(card, new RegExp(`${action}\\??\\.?\\(provider.id\\)`))
})

test('tool presentation distinguishes account blockers, actual tool failures and verified success without raw replies', () => {
  const { toolSmokePresentation: view } = load(prefix + 'lib/toolSmokePresentation.ts', {})
  for (const upstreamCategory of ['captcha_required', 'authentication_required', 'account_cooling_down', 'account_busy', 'route_changed', 'conversation_cursor_missing', 'rate_limited', 'upstream_error']) {
    const result = view({ success: false, category: 'provider_or_account_error', upstreamCategory, retryAt: 123456, message: 'SECRET-REPLY', checks: [{ stage: 'tool_call', success: true }, { stage: 'tool_result', success: false }] })
    assert.equal(result.status, 'blocked'); assert.equal(result.messageKey, `toolCalling.smoke.reasons.${upstreamCategory}`)
    assert.equal(result.checks[0].success, true); assert.equal(result.retryAt, 123456)
    assert.doesNotMatch(JSON.stringify(result), /SECRET-REPLY/)
    for (const lang of ['zh-CN', 'en-US']) assert.notEqual(t(result.messageKey, {}, lang), result.messageKey)
  }
  assert.equal(view({ category: 'parser_failed', success: false }).status, 'failed')
  assert.equal(view({ category: 'not_run', success: false }).status, 'blocked')
  assert.equal(view({ category: 'pass', success: true }).status, 'pass')
  assert.equal(view({ category: 'pass', success: false }).status, 'blocked')
  assert.equal(view({ category: 'SECRET-REPLY', success: true, upstreamCategory: '__proto__', retryAt: Infinity }).status, 'blocked')
})

test('all custom form and tool result classification strings are translated in both languages', () => {
  for (const language of ['zh-CN', 'en-US']) {
    const locale = dictionary(language)
    for (const file of ['components/providers/CustomProviderForm.tsx', 'components/providers/ProviderCard.tsx', 'pages/Providers.tsx']) for (const match of read(prefix + file).matchAll(/t\('(customProvider\.[^']+)'/g)) assert.notEqual(t(match[1], {}, language), match[1])
    assert.ok(locale.toolCalling.smoke.blocked)
    assert.equal(typeof locale.toolCalling.smoke.reasons.captcha_required, 'string')
  }
})
