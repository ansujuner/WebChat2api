const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')
const ts = require('typescript')
const root = join(__dirname, '..', '..')
const plain = value => JSON.parse(JSON.stringify(value))

async function setupDialog({ customName, email = 'login@example.test' } = {}) {
  const identity = await import(pathToFileURL(join(root, 'src/shared/accountIdentity.ts')))
  const slots = [], pending = [], created = []
  let cursor = 0
  const hook = initial => {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
  }
  const react = {
    useState: hook,
    useRef(initial) { return hook(() => ({ current: initial }))[0] },
    useEffect(fn, deps) {
      const index = cursor++
      if (!slots[index] || deps.some((value, i) => value !== slots[index][i])) pending.push(fn)
      slots[index] = deps
    },
  }
  const jsx = (type, props) => ({ type, props })
  const componentFile = join(root, 'src/renderer/src/components/providers/AddAccountDialog.tsx')
  const source = ts.transpileModule(readFileSync(componentFile, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, console: { log() {}, error() {} },
    window: { electronAPI: { oauth: { startInAppLogin: async () => ({
      success: true, credentials: { token: 'fixture' }, accountInfo: { email, userId: 'public-uid', name: 'Generic User' },
    }) } } },
    require(name) {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' }
      if (name === 'react-i18next') return { useTranslation: () => ({ t: key => key }) }
      if (name.endsWith('shared/accountIdentity')) return identity
      return new Proxy({}, { get: (_, key) => key })
    },
  }, { filename: componentFile })
  const props = {
    open: true, provider: { id: 'deepseek', type: 'builtin', name: 'DeepSeek', credentialFields: [{ name: 'token', required: true }] },
    onOpenChange() {}, onAddAccount: async data => { created.push(plain(data)) },
    onValidateToken: async () => ({ valid: true, userInfo: { email, userId: 'public-uid', name: 'Generic User' } }),
  }
  let tree
  const render = () => {
    cursor = 0
    tree = module.exports.AddAccountDialog(props)
    if (pending.length) {
      pending.splice(0).forEach(fn => fn())
      return render()
    }
    return tree
  }
  const walk = (node, predicate) => {
    if (Array.isArray(node)) return node.flatMap(item => walk(item, predicate))
    if (!node || typeof node !== 'object') return []
    return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)]
  }
  const text = node => Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'string' ? node : node?.props ? text(node.props.children) : ''
  const input = () => walk(tree, node => node.type === 'Input' && node.props.id === 'name')[0]
  const button = label => walk(tree, node => node.type === 'Button' && text(node).includes(label))[0]
  render()
  if (customName) { input().props.onChange({ target: { value: customName } }); render() }
  return { created, render, input, button, setCredential(value) {
    const fields = walk(tree, node => typeof node.type === 'function' && node.type.name === 'CredentialFieldsForm')[0]
    fields.props.onChange('token', value)
    render()
  } }
}

test('OAuth add uses verified email, retains identity and never persists a shared provider nickname', async () => {
  const h = await setupDialog()
  await h.button('providers.openOAuthLogin').props.onClick(); h.render()
  assert.equal(h.input().props.value, 'login@example.test')
  await h.button('providers.addAccount').props.onClick()
  assert.deepEqual(h.created[0], { name: 'login@example.test', nameSource: 'auto', email: 'login@example.test', providerUserId: 'public-uid', credentials: { token: 'fixture' } })
})

test('OAuth preserves a custom label and saves verified email separately', async () => {
  const h = await setupDialog({ customName: 'My work login' })
  await h.button('providers.openOAuthLogin').props.onClick(); h.render()
  assert.equal(h.input().props.value, 'My work login')
  await h.button('providers.addAccount').props.onClick()
  assert.equal(h.created[0].nameSource, 'custom')
  assert.equal(h.created[0].email, 'login@example.test')
})

test('manual validation uses the same email identity and credential changes discard stale validation', async () => {
  const h = await setupDialog()
  h.setCredential('fixture')
  await h.button('providers.validateCredentials').props.onClick(); h.render()
  assert.equal(h.input().props.value, 'login@example.test')
  h.setCredential('different-fixture')
  assert.equal(h.input().props.value, '')
  await h.button('providers.addAccount').props.onClick()
  assert.equal(h.created[0].nameSource, 'auto')
  assert.equal(h.created[0].email, undefined)
})

test('provider creation passes validation identity rather than a hard-coded generic account name', () => {
  const page = readFileSync(join(root, 'src/renderer/src/pages/Providers.tsx'), 'utf8')
  const dialog = readFileSync(join(root, 'src/renderer/src/components/providers/AddProviderDialog.tsx'), 'utf8')
  assert.match(dialog, /onSelectBuiltin\(selectedProviderData, credentials, validationResult\.valid \? validationResult\.userInfo : undefined\)/)
  assert.match(page, /nameSource: 'auto',\s*\.\.\.validatedAccountIdentity\(accountInfo\)/)
  assert.doesNotMatch(page, /name: `\$\{provider\.name\} \$\{t\('providers\.accounts'\)\}`/)
})
