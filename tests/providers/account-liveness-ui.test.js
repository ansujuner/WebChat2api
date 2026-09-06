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
const tick = async () => { for (let index = 0; index < 10; index++) await Promise.resolve() }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function load(file, imports, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(read(file), { fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, Date,
    require(name) { assert.ok(Object.hasOwn(imports, name), `Unmocked UI boundary ${name}`); return imports[name] },
    ...globals,
  }, { filename: file })
  return module.exports
}
const result = changes => ({ accountId: 'a', accountName: 'Fixture account', providerId: 'deepseek', status: 'queued', ...changes })
const job = changes => ({ id: 'fixture-job', mode: 'single', state: 'running', startedAt: 1000, updatedAt: 1000, results: [result()], ...changes })
function hookFixture(options = {}) {
  const values = [], effects = [], calls = [], listeners = new Set()
  let index = 0, initialized = false
  const api = {
    livenessGet() { calls.push(['get']); return options.get ? options.get() : Promise.resolve(null) },
    livenessStart(input) { calls.push(['start', plain(input)]); return options.start ? options.start(input) : Promise.resolve(job()) },
    livenessCancel(id) { calls.push(['cancel', id]); return options.cancel ? options.cancel(id) : Promise.resolve(job({ state: 'cancelling', updatedAt: 1001 })) },
    onLivenessChanged(callback) { calls.push(['subscribe']); listeners.add(callback); return () => { calls.push(['unsubscribe']); listeners.delete(callback) } },
  }
  const hooks = {
    useState(initial) { const slot = index++; if (!Object.hasOwn(values, slot)) values[slot] = initial; return [values[slot], next => { values[slot] = typeof next === 'function' ? next(values[slot]) : next }] },
    useRef(initial) { const slot = index++; if (!Object.hasOwn(values, slot)) values[slot] = { current: initial }; return values[slot] },
    useEffect(effect) { if (!initialized) effects.push(effect) },
  }
  const { useAccountLiveness } = load('src/renderer/src/hooks/useAccountLiveness.ts', { react: hooks }, {
    window: { electronAPI: { accounts: new Proxy(api, { get(target, name) { assert.ok(Object.hasOwn(target, name), `Liveness UI must not modify account state: ${String(name)}`); return target[name] } }) } },
  })
  const render = () => { index = 0; return useAccountLiveness() }
  render(); initialized = true
  const cleanup = effects.map(effect => effect())
  return { render, calls, emit(value) { for (const listener of listeners) listener(value) }, unmount() { cleanup.forEach(fn => fn()) }, listeners }
}

test('opening or reopening liveness UI only restores/subscribes and never submits a real request', async () => {
  const f = hookFixture({ get: () => Promise.resolve(job({ state: 'completed', results: [result({ status: 'passed' })] })) })
  await tick()
  assert.equal(f.render().job.state, 'completed')
  assert.equal(f.render().busy, false)
  assert.deepEqual(f.calls, [['subscribe'], ['get']])
  f.unmount()
  assert.equal(f.listeners.size, 0)
  assert.equal(f.calls.at(-1)[0], 'unsubscribe')
})

test('single explicit, provider batch and all-account actions preserve exact backend filter semantics', async () => {
  for (const input of [{ accountIds: ['manually-disabled-account'] }, { providerId: 'one-account-provider' }, {}]) {
    const f = hookFixture()
    await tick()
    await f.render().start(input)
    assert.deepEqual(f.calls.filter(call => call[0] === 'start'), [['start', input]])
    assert.equal(f.render().busy, true)
    assert.equal(f.render().job.id, 'fixture-job')
    f.unmount()
  }
})

test('double clicks and active jobs never dispatch duplicate liveness work', async () => {
  const pending = deferred(), f = hookFixture({ start: () => pending.promise })
  await tick()
  const first = f.render().start({ accountIds: ['a'] })
  await f.render().start({})
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1)
  assert.equal(f.render().pending, true)
  pending.resolve(job()); await first
  await f.render().start({})
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1)
  f.emit(job({ state: 'completed', updatedAt: 1002, results: [result({ status: 'passed' })] }))
  assert.equal(f.render().busy, false)
  f.unmount()
})

test('late restore/start replies cannot overwrite newer serial progress or a completed report', async () => {
  const restore = deferred(), start = deferred()
  const f = hookFixture({ get: () => restore.promise, start: () => start.promise })
  const pending = f.render().start({})
  f.emit(job({ updatedAt: 1000, results: [result({ status: 'passed' })] }))
  restore.resolve(job({ id: 'old-job', startedAt: 900 })); await tick()
  start.resolve(job()); await pending
  assert.equal(f.render().job.results[0].status, 'passed', 'Even same-millisecond responses cannot regress a result')
  f.emit(job({ state: 'completed', updatedAt: 1001, results: [result({ status: 'passed' })] }))
  f.emit(job({ updatedAt: 1002, results: [result({ status: 'passed' })] }))
  assert.equal(f.render().job.state, 'completed')
  f.unmount()
})

test('stop remaining checks addresses exactly the running job and waits for backend cancellation', async () => {
  const f = hookFixture()
  await tick(); await f.render().start({})
  await f.render().cancel()
  assert.deepEqual(f.calls.filter(call => call[0] === 'cancel'), [['cancel', 'fixture-job']])
  assert.equal(f.render().job.state, 'cancelling')
  assert.equal(f.render().busy, true)
  await f.render().cancel()
  assert.equal(f.calls.filter(call => call[0] === 'cancel').length, 1)
  f.emit(job({ state: 'cancelled', updatedAt: 1002, results: [result({ status: 'cancelled', reason: 'cancelled' })] }))
  assert.equal(f.render().busy, false)
  f.unmount()
})

test('failed control requests expose a boolean only and never auto-retry or leak raw exception text', async () => {
  const f = hookFixture({ start: () => Promise.reject(Error('fixture-secret-token-and-provider-body')) })
  await tick(); await f.render().start({ accountIds: ['a'] }); await tick()
  assert.equal(f.render().error, true)
  assert.equal(f.render().pending, false)
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1)
  assert.doesNotMatch(JSON.stringify(f.render()), /fixture-secret|provider-body/)
  f.unmount()
})

test('unmount unsubscribes and ignores delayed report reads without initiating cancellation or another request', async () => {
  const restore = deferred(), f = hookFixture({ get: () => restore.promise })
  f.unmount(); restore.resolve(job()); await tick()
  assert.equal(f.render().job, null)
  assert.deepEqual(f.calls, [['subscribe'], ['get'], ['unsubscribe']])
})

function panel(value, language = 'zh-CN') {
  const locale = JSON.parse(read(`src/renderer/src/i18n/locales/${language}.json`))
  const t = (key, values = {}) => {
    let text = key.split('.').reduce((current, part) => current?.[part], locale) || key
    for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{{${name}}}`, String(value))
    return text
  }
  const element = tag => ({ children, ...props }) => React.createElement(tag, props, children)
  const { AccountLivenessPanel } = load('src/renderer/src/components/providers/AccountLivenessPanel.tsx', {
    'react/jsx-runtime': require('react/jsx-runtime'), 'react-i18next': { useTranslation: () => ({ t }) },
    '@/components/ui/button': { Button: element('button') },
    '@/components/ui/card': { Card: element('article'), CardContent: element('div'), CardHeader: element('header'), CardTitle: element('h2') },
    '@/components/ui/progress': { Progress: element('progress') },
  })
  return renderToStaticMarkup(React.createElement(AccountLivenessPanel, { controller: { job: value, pending: false, error: false, cancel() {} } }))
}

test('rendered liveness report includes serial counts, safe reasons, model/latency/time and no reply or credentials', () => {
  const html = panel(job({ mode: 'batch', results: [
    result({ status: 'passed', model: 'deepseek-v4-flash', latencyMs: 321, finishedAt: 1700000000000, reply: 'fixture-sensitive-reply', credentials: 'fixture-secret' }),
    result({ accountId: 'b', status: 'failed', reason: 'incomplete_response' }),
    result({ accountId: 'c', status: 'skipped', reason: 'disabled' }),
    result({ accountId: 'd', status: 'cancelled', reason: 'cancelled' }),
    result({ accountId: 'e', status: 'running', model: 'GLM-5' }), result({ accountId: 'f' }),
  ] }))
  for (const text of ['已完成 4/6', '通过 1', '失败 1', '跳过 1', '已取消 1', 'deepseek-v4-flash', '321 ms', 'GLM-5', '账号已手动关闭', '停止后续测活', '不代表撤回']) assert.ok(html.includes(text), text)
  assert.doesNotMatch(html, /fixture-sensitive-reply|fixture-secret|credentials/)
})

test('an unknown reason cannot become raw output, and all backend reason enums have translations', () => {
  assert.doesNotMatch(panel(job({ results: [result({ status: 'failed', reason: 'fixture-secret-token' })] })), /fixture-secret-token/)
  const reasons = read('src/shared/accountLiveness.ts').split('export interface')[0].match(/'([a-z_]+)'/g).map(value => value.slice(1, -1)).sort()
  for (const language of ['zh-CN', 'en-US']) {
    const locale = JSON.parse(read(`src/renderer/src/i18n/locales/${language}.json`))
    assert.deepEqual(Object.keys(locale.accountLiveness.reasons).sort(), reasons)
    for (const reason of reasons) assert.ok(panel(job({ results: [result({ status: 'failed', reason })] }), language).includes(locale.accountLiveness.reasons[reason]), `${language}: panel must render ${reason}`)
    assert.ok(locale.accountLiveness.notice)
    assert.ok(locale.accountLiveness.sessionOnly)
    assert.match(locale.accountLiveness.sessionOnly, language === 'zh-CN' ? /测活通过不会自动启用账号[\s\S]*新发现的官方限制仍会自动暂停账号/ : /successful check does not enable[\s\S]*newly detected provider restrictions still pause/)
  }
})

test('browser readiness and model access failures render actionable guidance, not a permanent account verdict', () => {
  for (const language of ['zh-CN', 'en-US']) {
    const html = panel(job({ state: 'completed', results: [
      result({ status: 'failed', reason: 'browser_unavailable' }),
      result({ accountId: 'b', status: 'failed', reason: 'model_unavailable' }),
    ] }), language)
    assert.match(html, language === 'zh-CN' ? /浏览器尚未就绪[\s\S]*打开登录窗口[\s\S]*网站可访问/ : /browser is not ready[\s\S]*login window[\s\S]*website is available/)
    assert.match(html, language === 'zh-CN' ? /模型当前不可用或账号无访问权限[\s\S]*不代表账号永久不可用/ : /model is unavailable or not permitted[\s\S]*does not mean the account is permanently unusable/)
    assert.doesNotMatch(html, /accountLiveness\.reasons\.|fixture-secret/)
  }
})

test('UI entry points keep credential validation separate and single tests are not gated by account enabled/auth status', () => {
  const page = read('src/renderer/src/pages/Providers.tsx')
  assert.match(page, /liveness.start\(\{ accountIds: \[selectedAccount.id\] \}\)/)
  assert.match(page, /liveness.start\(\{ accountIds: \[id\] \}\)/)
  assert.match(page, /liveness.start\(\{ providerId: selectedProvider.id \}\)/)
  assert.match(page, /liveness.start\(\{\}\)/)
  for (const component of ['AccountList', 'AccountDetail']) {
    const source = read(`src/renderer/src/components/providers/${component}.tsx`)
    assert.match(source, /disabled=\{livenessBusy\}/)
    assert.match(source, /accountLiveness.single/)
    assert.match(source, /providers.validateCredentials/)
    assert.doesNotMatch(source, /disabled=\{[^}]*account\.(?:enabled|status)[^}]*\}[^>]*onTest/)
  }
  const locale = JSON.parse(read('src/renderer/src/i18n/locales/zh-CN.json'))
  assert.equal(locale.providers.validateCredentials, '验证凭据')
  const sources = read('src/renderer/src/hooks/useAccountLiveness.ts') + read('src/renderer/src/components/providers/AccountLivenessPanel.tsx')
  assert.doesNotMatch(sources, /setEnabled\(|clearSuspension\(|accounts\.update\(|\.credentials|\.reply|\.responseBody|\.message\b|setInterval\(|setTimeout\(/)
})

test('chat verification guidance points to the actual chat context, acknowledges invisible prompts and never promises liveness from sign-in', () => {
  for (const language of ['zh-CN', 'en-US']) {
    const locale = JSON.parse(read(`src/renderer/src/i18n/locales/${language}.json`))
    const messages = [locale.accountLiveness.reasons.action_required,
      ...['captcha_required', 'verification_required', 'action_required'].map(code => locale.toolCalling.smoke.reasons[code])]
    for (const message of messages) {
      assert.match(message, language === 'zh-CN' ? /实际聊天\/验证窗口/ : /actual chat\/verification window/)
      assert.match(message, language === 'zh-CN' ? /可能尚无可见窗口或提示/ : /may be no visible window or prompt/)
      assert.match(message, language === 'zh-CN' ? /已登录不代表/ : /signed in does not mean/)
      assert.doesNotMatch(message, /登录窗口|重新登录|login window|sign in again/i)
    }
    assert.match(locale.accountLiveness.reasons.auth_required, language === 'zh-CN' ? /重新登录/ : /sign in again/i)
    const html = panel(job({ state: 'completed', results: [result({ status: 'failed', reason: 'account_busy' })] }), language)
    assert.ok(html.includes(locale.accountLiveness.reasons.account_busy))
    assert.match(html, language === 'zh-CN' ? /当前请求未发送/ : /current request was not sent/)
    assert.doesNotMatch(locale.accountLiveness.reasons.account_busy, /登录|sign in|login/i)
  }
})
