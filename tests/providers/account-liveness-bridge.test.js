const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { EventEmitter } = require('node:events')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
const secret = 'fixture-private-provider-response-token'
const job = { id: 'fixture-job', mode: 'single', state: 'running', startedAt: 1, updatedAt: 1,
  results: [{ accountId: 'fixture-account', accountName: 'Fixture', providerId: 'fixture-provider', status: 'queued' }] }
function evaluate(source, globals) {
  const module = { exports: {} }
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(javascript, { module, exports: module.exports, ...globals })
  return module.exports
}
const { IpcChannels } = evaluate(readFileSync(path.join(root, 'src/main/ipc/channels.ts'), 'utf8'))
function bridge(options = {}) {
  const handlers = new Map(), calls = [], sent = [], app = new EventEmitter(), backendEvents = new EventEmitter()
  const directory = path.join(root, 'out/main')
  const appURL = pathToFileURL(path.join(directory, '../renderer/index.html')).href
  let registrations = 0, subscriptions = 0, unsubscriptions = 0
  const windows = []
  function window(url = appURL, state = {}) {
    const webContents = { mainFrame: {}, isDestroyed: () => !!state.contentsDestroyed, getURL() { if (state.urlThrows) throw Error(secret); return url },
      send(channel, value) { if (state.sendThrows) throw Error(secret); sent.push({ channel, value, window: instance }) } }
    const instance = { webContents, isDestroyed: () => !!state.destroyed }
    windows.push(instance)
    return { instance, state, event: { sender: webContents, senderFrame: webContents.mainFrame }, setURL: value => { url = value } }
  }
  class AccountLivenessError extends Error { constructor(code) { super(code === 'busy' ? 'A liveness check is already running.' : 'Invalid account liveness selection.'); this.code = code } }
  const backend = {
    AccountLivenessError,
    startAccountLiveness(input) { calls.push(['start', input]); if (options.start) return options.start(input, AccountLivenessError); return job },
    getAccountLiveness() { calls.push(['get']); if (options.get) return options.get(); return options.empty ? null : job },
    cancelAccountLiveness(id) { calls.push(['cancel', id]); if (options.cancel) return options.cancel(id, AccountLivenessError); return { ...job, state: 'cancelling' } },
    async subscribeAccountLiveness(listener) { subscriptions++; if (options.subscribeReady) await options.subscribeReady
      backendEvents.on('change', listener); return () => { unsubscriptions++; backendEvents.removeListener('change', listener) } },
  }
  const source = ts.createSourceFile('handlers.ts', readFileSync(path.join(root, 'src/main/ipc/handlers.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const selected = source.statements.filter(node =>
    ts.isFunctionDeclaration(node) && ['isLivenessAppWindow', 'registerAccountLivenessHandlers'].includes(node.name?.text)
    || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => declaration.name.getText(source) === 'livenessRegistration'))
  assert.equal(selected.length, 3, 'Execute the actual complete liveness registration, not a rewritten fixture')
  const api = evaluate(selected.map(node => node.getText(source)).join('\n'), {
    IpcChannels, app, URL, join: path.join, pathToFileURL, __dirname: directory,
    process: { env: options.env || {} },
    BrowserWindow: { getAllWindows: () => windows },
    ipcMain: { handle(channel, handler) { assert.ok(!handlers.has(channel), 'Handlers must not accumulate'); handlers.set(channel, handler); registrations++ } },
    console: new Proxy({}, { get() { return () => assert.fail('No raw bridge logging') } }),
    require(name) { assert.equal(name, '../diagnostics/accountLiveness'); return backend },
  })
  return { ...api, appURL, window, app, handlers, calls, sent, emit: value => backendEvents.emit('change', value),
    invoke: (name, event, ...args) => handlers.get(IpcChannels[name])(event, ...args),
    counts: () => ({ registrations, subscriptions, unsubscriptions }) }
}

test('liveness IPC registers exactly once, remains idle, and delegates unmodified inputs/results', async () => {
  const f = bridge(), window = f.window()
  await Promise.all(Array.from({ length: 8 }, () => f.registerAccountLivenessHandlers()))
  assert.deepEqual(f.counts(), { registrations: 3, subscriptions: 1, unsubscriptions: 0 })
  assert.deepEqual(f.calls, [])
  const input = { accountIds: ['fixture-account'] }
  assert.equal(await f.invoke('ACCOUNTS_LIVENESS_START', window.event, input), job)
  assert.equal(f.calls[0][1], input)
  assert.equal(await f.invoke('ACCOUNTS_LIVENESS_GET', window.event), job)
  assert.equal((await f.invoke('ACCOUNTS_LIVENESS_CANCEL', window.event, 'fixture-job')).state, 'cancelling')
  assert.deepEqual(f.calls, [['start', input], ['get'], ['cancel', 'fixture-job']])
  assert.equal(f.counts().subscriptions, 1)
  const empty = bridge({ empty: true }), owner = empty.window(); await empty.registerAccountLivenessHandlers()
  assert.equal(await empty.invoke('ACCOUNTS_LIVENESS_GET', owner.event), null)
})

test('liveness IPC rejects remote pages, unexpected files, destroyed senders, unknown windows and subframes', async () => {
  const f = bridge(); await f.registerAccountLivenessHandlers()
  const cases = [f.window('https://chat.deepseek.com/'), f.window('file:///unrelated/index.html'),
    f.window('about:blank'), f.window(undefined, { destroyed: true }), f.window(undefined, { contentsDestroyed: true }),
    f.window(undefined, { urlThrows: true })]
  for (const item of cases) await assert.rejects(f.invoke('ACCOUNTS_LIVENESS_START', item.event, {}), /only in the main application/)
  const valid = f.window()
  for (const event of [{ sender: valid.event.sender, senderFrame: {} }, { sender: valid.event.sender, senderFrame: null },
    { sender: { ...valid.event.sender }, senderFrame: valid.event.senderFrame }]) {
    await assert.rejects(f.invoke('ACCOUNTS_LIVENESS_GET', event), /only in the main application/)
  }
  assert.deepEqual(f.calls, [])
})

test('liveness initialization awaits the single asynchronous subscription before exposing IPC handlers', async () => {
  let ready
  const f = bridge({ subscribeReady: new Promise(resolve => { ready = resolve }) })
  const first = f.registerAccountLivenessHandlers(), second = f.registerAccountLivenessHandlers()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.counts(), { registrations: 0, subscriptions: 1, unsubscriptions: 0 })
  ready(); await Promise.all([first, second])
  assert.deepEqual(f.counts(), { registrations: 3, subscriptions: 1, unsubscriptions: 0 })
})

test('development liveness IPC accepts only the exact configured origin, not a hostname prefix', async () => {
  const f = bridge({ env: { NODE_ENV: 'development', ELECTRON_RENDERER_URL: 'http://localhost:5173' } })
  await f.registerAccountLivenessHandlers()
  assert.equal(await f.invoke('ACCOUNTS_LIVENESS_GET', f.window('http://localhost:5173/providers').event), job)
  for (const url of ['http://localhost:5173.evil.test', 'http://localhost:5174', 'https://localhost:5173', 'file:///index.html']) {
    await assert.rejects(f.invoke('ACCOUNTS_LIVENESS_GET', f.window(url).event), /only in the main application/)
  }
})

test('an invoking window that closes or navigates while awaiting the backend cannot receive a late job result', async () => {
  for (const change of ['close', 'navigate']) {
    let finish
    const f = bridge({ start: () => new Promise(resolve => { finish = resolve }) }), owner = f.window()
    await f.registerAccountLivenessHandlers()
    const pending = f.invoke('ACCOUNTS_LIVENESS_START', owner.event, {})
    if (change === 'close') owner.state.contentsDestroyed = true
    else owner.setURL('https://arena.ai/text/direct')
    finish(job)
    await assert.rejects(pending, /only in the main application/)
    assert.equal(f.calls.length, 1, 'Do not cancel or repeat the already submitted backend job')
  }
})

test('liveness IPC preserves only known fixed errors and delegates invalid input rejection to backend', async () => {
  const input = { unexpected: true }, f = bridge({ start(value, ErrorType) {
    assert.equal(value, input); throw new ErrorType('invalid_input')
  }, cancel(_id, ErrorType) { throw new ErrorType('busy') }, get() { throw Error(secret) } }), window = f.window()
  await f.registerAccountLivenessHandlers()
  await assert.rejects(f.invoke('ACCOUNTS_LIVENESS_START', window.event, input), /Invalid account liveness selection/)
  await assert.rejects(f.invoke('ACCOUNTS_LIVENESS_CANCEL', window.event, null), /already running/)
  await assert.rejects(f.invoke('ACCOUNTS_LIVENESS_GET', window.event), error => /request failed/.test(error.message) && !error.message.includes(secret))
  assert.equal(f.calls[1][1], null)
})

test('one liveness subscription safely pushes to current app windows, including recreated windows, until quit', async () => {
  const f = bridge(), original = f.window(f.appURL + '#/providers')
  f.window('https://arena.ai/text/direct')
  f.window(undefined, { destroyed: true }); f.window(undefined, { contentsDestroyed: true }); f.window(undefined, { sendThrows: true })
  await f.registerAccountLivenessHandlers()
  f.emit(job)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].window, original.instance)
  assert.equal(f.sent[0].value, job)
  assert.equal(f.sent[0].channel, IpcChannels.ACCOUNTS_LIVENESS_CHANGED)
  original.state.destroyed = true
  const recreated = f.window(); f.emit({ ...job, state: 'completed' })
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].window, recreated.instance)
  f.app.emit('will-quit'); f.emit(job)
  assert.equal(f.sent.length, 2)
  assert.deepEqual(f.counts(), { registrations: 3, subscriptions: 1, unsubscriptions: 1 })
})

test('actual preload exposes typed liveness methods and strips Electron event objects from callbacks', async () => {
  const events = new EventEmitter(), calls = [], values = []
  let exposed
  evaluate(readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8'), {
    require(name) {
      if (name === '../main/ipc/channels') return { IpcChannels }
      assert.equal(name, 'electron')
      return { contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'electronAPI'); exposed = api } },
        ipcRenderer: { invoke: async (...args) => { calls.push(args); return job }, on: events.on.bind(events), removeListener: events.removeListener.bind(events) } }
    },
  })
  assert.deepEqual(calls, [])
  const accounts = exposed.accounts, input = { providerId: 'fixture-provider' }
  assert.equal(await accounts.livenessStart(input), job)
  assert.equal(await accounts.livenessGet(), job)
  assert.equal(await accounts.livenessCancel(job.id), job)
  assert.deepEqual(calls, [['accounts:livenessStart', input], ['accounts:livenessGet'], ['accounts:livenessCancel', job.id]])
  const stop = accounts.onLivenessChanged((...args) => values.push(args))
  const other = accounts.onLivenessChanged(() => values.push(['other']))
  events.emit('accounts:livenessChanged', { sender: secret }, job)
  assert.deepEqual(plain(values), [[job], ['other']])
  stop(); stop(); events.emit('accounts:livenessChanged', { sender: secret }, job)
  assert.equal(values.length, 3); assert.deepEqual(values[2], ['other'])
  other(); assert.equal(events.listenerCount('accounts:livenessChanged'), 0)
  assert.doesNotMatch(JSON.stringify(values), /fixture-private/)
})

test('liveness registration is wired once into normal IPC initialization and uses shared renderer types', () => {
  const handlers = readFileSync(path.join(root, 'src/main/ipc/handlers.ts'), 'utf8')
  assert.equal((handlers.match(/await registerAccountLivenessHandlers\(\)/g) || []).length, 1)
  const declaration = readFileSync(path.join(root, 'src/renderer/src/types/electron.d.ts'), 'utf8')
  assert.match(declaration, /import type \{ AccountLivenessInput, AccountLivenessJob \} from '\.\.\/\.\.\/\.\.\/shared\/accountLiveness'/)
  for (const method of ['livenessStart', 'livenessGet', 'livenessCancel', 'onLivenessChanged']) {
    assert.equal((declaration.match(new RegExp(`  ${method}:`, 'g')) || []).length, 1)
  }
  assert.match(declaration, /onLivenessChanged: \(callback: \(job: AccountLivenessJob\) => void\) => \(\) => void/)
})
