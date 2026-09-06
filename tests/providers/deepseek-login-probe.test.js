const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const root = join(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
const secret = 'fixture-secret-never-in-login-report'
const normal = Object.freeze({ browser: 'Chrome', userAgent: 'fixture-Chrome-runtime',
  providerPages: Object.freeze([Object.freeze({ electron: false, tauri: false, unsafeWarningVisible: false })]) })
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

function fixture(options = {}) {
  const calls = [], reports = [], timers = new Map()
  let nextTimer = 0, configReads = 0, resolveLogin, rejectLogin
  const login = new Promise((resolve, reject) => { resolveLogin = resolve; rejectLogin = reject })
  const config = Object.freeze({ oauthProxyMode: options.proxyMode, apiKeys: [{ key: secret }] })
  const success = { success: true, credentials: { userToken: secret }, accountInfo: { email: 'private-fixture@example.test' } }
  const oauthManager = {
    isInAppLoginOpen: () => options.busy ?? false,
    startInAppLogin(...args) {
      calls.push({ operation: 'start', args })
      if (options.loginError) rejectLogin(new Error(secret))
      return login
    },
    cancelInAppLogin() {
      calls.push({ operation: 'cancel' })
      if (options.cancelError) throw new Error(secret)
      resolveLogin({ success: false, error: secret })
    },
  }
  const externalBrowserLoginManager = {
    async getBrowserEnvironment() {
      calls.push({ operation: 'environment' })
      if (options.environmentError) throw new Error(secret)
      return options.environment === undefined ? normal : options.environment
    },
  }
  const storeManager = new Proxy({ getConfig() {
    configReads++
    if (options.configError) throw new Error(secret)
    return config
  } }, {
    get(target, key) {
      assert.equal(key, 'getConfig', `Login diagnostics must not read/write saved accounts or settings: ${String(key)}`)
      return target[key]
    },
  })
  const dependencies = {
    '../oauth/manager': { oauthManager }, '../oauth/externalBrowserLogin': { externalBrowserLoginManager },
    '../store/store': { storeManager },
    '../network/proxy': { getProviderProxyConfig(id) {
      assert.equal(id, 'deepseek')
      const selected = storeManager.getConfig()
      return options.proxyConfig ?? { mode: selected.oauthProxyMode || 'system' }
    } },
  }
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(join(root, 'src/main/diagnostics/deepseekLoginProbe.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(code, {
    module, exports: module.exports,
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id },
    clearTimeout(id) { timers.delete(id) },
    console: new Proxy({}, { get() { return () => { throw new Error('Diagnostics must not log errors or credentials') } } }),
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `No browser, filesystem or network dependency allowed: ${name}`)
      return dependencies[name]
    },
  })
  return {
    calls, reports, timers, get configReads() { return configReads },
    complete: (result = success) => resolveLogin(result),
    run: () => module.exports.runDeepSeekLoginProbe(async report => {
      reports.push(plain(report))
      if (options.progressError) throw new Error(secret)
      if (!options.waitForUser) resolveLogin(options.result ?? success)
    }),
  }
}

test('successful verified login passes only with a normal provider page and never saves or exports an account', async () => {
  const f = fixture({ proxyMode: 'none' })
  const result = plain(await f.run())
  assert.equal(result.status, 'passed')
  assert.equal(result.accountVerified, true)
  assert.deepEqual(result.environment, normal)
  assert.equal(result.live, false)
  assert.equal(result.stream, false)
  assert.equal(result.protocol, 'openai')
  assert.deepEqual(f.calls[0], { operation: 'start', args: ['deepseek', 'deepseek', 600000, { mode: 'none' }] })
  assert.equal(f.calls.filter(call => call.operation === 'cancel').length, 0)
  assert.equal(f.configReads, 1)
  assert.equal(f.timers.size, 0)
  assert.deepEqual(f.reports.map(report => report.status), ['awaiting_login'])
  assert.doesNotMatch(JSON.stringify([result, ...f.reports]), /fixture-secret|credentials|apiKeys|private-fixture/)
})

test('the saved system/direct proxy mode is forwarded exactly like ordinary OAuth IPC login', async () => {
  for (const [proxyMode, expected] of [['none', 'none'], ['system', 'system'], [undefined, 'system']]) {
    const f = fixture({ proxyMode })
    await f.run()
    assert.deepEqual(f.calls[0].args[3], { mode: expected })
    assert.equal(f.configReads, 1)
  }
})

test('unsafe warning, embedded identity, or missing provider page cannot produce a passed login report', async () => {
  for (const environment of [null, { ...normal, providerPages: [] },
    ...['electron', 'tauri', 'unsafeWarningVisible'].map(flag => ({ ...normal, providerPages: [{ ...normal.providerPages[0], [flag]: true }] })),
  ]) {
    const f = fixture({ environment })
    const result = await f.run()
    assert.equal(result.status, 'login_not_completed')
    assert.equal(result.accountVerified, true, 'Environment failure is distinct from account verification')
    assert.equal(f.timers.size, 0)
  }
})

test('user cancellation finishes without retrying, saving an account, or retaining poll timers', async () => {
  const f = fixture({ waitForUser: true })
  const running = f.run()
  await tick()
  assert.equal(f.reports.length, 1)
  assert.equal(f.timers.size, 1)
  f.complete({ success: false, error: secret })
  const result = await running
  assert.equal(result.status, 'login_not_completed')
  assert.equal(result.accountVerified, false)
  assert.equal(f.calls.filter(call => call.operation === 'start').length, 1)
  assert.equal(f.timers.size, 0)
  assert.doesNotMatch(JSON.stringify([result, ...f.reports]), /fixture-secret/)
})

test('a pre-existing busy login is neither changed nor cancelled and does not read saved settings', async () => {
  const f = fixture({ busy: true })
  const result = await f.run()
  assert.equal(result.status, 'login_busy')
  assert.equal(result.accountVerified, false)
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.reports, [])
  assert.equal(f.configReads, 0)
})

test('a progress write failure cancels the probe-owned login and exports only a static error', async () => {
  const f = fixture({ progressError: true })
  await assert.rejects(f.run(), error => {
    assert.match(error.message, /diagnostic could not be completed/)
    assert.doesNotMatch(error.message, /fixture-secret/)
    return true
  })
  assert.equal(f.calls.filter(call => call.operation === 'cancel').length, 1)
  assert.equal(f.calls.filter(call => call.operation === 'start').length, 1)
  assert.equal(f.timers.size, 0)
  assert.doesNotMatch(JSON.stringify(f.reports), /fixture-secret/)
})

test('an environment diagnostic failure cancels pending login rather than looping or persisting raw errors', async () => {
  const f = fixture({ environmentError: true })
  await assert.rejects(f.run(), error => {
    assert.match(error.message, /diagnostic could not be completed/)
    assert.doesNotMatch(error.message, /fixture-secret/)
    return true
  })
  assert.deepEqual(f.calls.map(call => call.operation), ['start', 'environment', 'cancel'])
  assert.deepEqual(f.reports, [])
  assert.equal(f.timers.size, 0)
})

test('config-read failure never starts login or exports secret-bearing errors', async () => {
  const f = fixture({ configError: true })
  await assert.rejects(f.run(), error => !error.message.includes(secret) && /could not be completed/.test(error.message))
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.reports, [])
})

test('login rejection and missing returned credentials are unsuccessful and never export arbitrary errors', async () => {
  for (const options of [{ loginError: true }, { result: { success: true } }, { result: { success: false, error: secret, credentials: { token: secret } } }]) {
    const f = fixture(options)
    const result = await f.run()
    assert.equal(result.status, 'login_not_completed')
    assert.equal(result.accountVerified, false)
    assert.equal(f.calls.filter(call => call.operation === 'start').length, 1)
    assert.equal(f.timers.size, 0)
    assert.doesNotMatch(JSON.stringify([result, ...f.reports]), /fixture-secret/)
  }
})

test('a cancellation failure is also sanitized rather than leaking its raw browser exception', async () => {
  const f = fixture({ progressError: true, cancelError: true })
  await assert.rejects(f.run(), error => {
    assert.match(error.message, /could not close its login window/)
    assert.doesNotMatch(error.message, /fixture-secret/)
    return true
  })
  assert.equal(f.calls.filter(call => call.operation === 'cancel').length, 1)
  f.complete({ success: false })
})
