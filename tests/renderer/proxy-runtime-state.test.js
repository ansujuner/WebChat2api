const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = join(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))

function evaluate(source, globals = {}) {
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, console: { error() {} }, ...globals })
  return module.exports
}
const { ProxyStatusManager } = evaluate(readFileSync(join(root, 'src/main/proxy/status.ts'), 'utf8'))
const { observeProxyStatus, localProxyOrigin } = evaluate(readFileSync(join(root, 'src/renderer/src/lib/proxyStatusObserver.ts'), 'utf8'))
const stopped = { isRunning: false, port: 8081, host: '0.0.0.0', uptime: 0, connections: 0 }
const running = { ...stopped, isRunning: true }
const turn = () => new Promise(resolve => setImmediate(resolve))

test('stopped status uses configured 8081 rather than hardcoded 8080 or last bound port', () => {
  const status = new ProxyStatusManager()
  assert.equal(status.getPort(), 8080)
  assert.deepEqual(plain(status.getPublicStatus({ port: 8081, host: '0.0.0.0' })), stopped)
  status.setPort(8888); status.setHost('127.0.0.1'); status.start(); status.stop()
  assert.deepEqual(plain(status.getPublicStatus({ port: 8081, host: '0.0.0.0' })), stopped)
})

test('running status never changes to newly configured port until listener restarts', () => {
  const status = new ProxyStatusManager()
  status.setPort(8081); status.setHost('0.0.0.0'); status.start()
  const current = status.getPublicStatus({ port: 8080, host: '127.0.0.1' })
  assert.equal(current.port, 8081)
  assert.equal(current.host, '0.0.0.0')
  status.stop()
  assert.equal(status.getPublicStatus({ port: 8080, host: '127.0.0.1' }).port, 8080)
  assert.equal(status.getPublicStatus({ port: 8080, host: '127.0.0.1' }).uptime, 0)
})

test('renderer discards stale initial getStatus after a newer running-status event', async () => {
  let resolveInitial, statusEvent, configEvent
  const received = []
  const api = { proxy: {
    getStatus: () => new Promise(resolve => { resolveInitial = resolve }),
    onStatusChanged: callback => { statusEvent = callback; return () => {} },
  }, config: { onConfigChanged: callback => { configEvent = callback; return () => {} } } }
  const observer = observeProxyStatus(api, value => received.push(value), error => assert.fail(error))
  statusEvent(running)
  resolveInitial({ ...stopped, port: 8080 })
  await turn()
  assert.deepEqual(received, [running])
  api.proxy.getStatus = async () => running
  configEvent({ proxyPort: 8080, proxyHost: '127.0.0.1' })
  await turn()
  assert.equal(received.at(-1).port, 8081)
  observer.dispose()
})

test('config changes while stopped requery the actual status instead of guessing an address', async () => {
  let configEvent
  const received = [], errors = []
  const api = { proxy: { getStatus: async () => stopped, onStatusChanged: () => () => {} },
    config: { onConfigChanged: callback => { configEvent = callback; return () => {} } } }
  const observer = observeProxyStatus(api, value => received.push(value), error => errors.push(error))
  await turn()
  api.proxy.getStatus = async () => ({ ...stopped, port: 8082 })
  configEvent({ proxyPort: 9999 })
  await turn()
  assert.equal(received.at(-1).port, 8082)
  assert.deepEqual(errors, [])
  observer.dispose()
})

test('unmounted renderer ignores delayed replies and unsubscribes both events', async () => {
  let reply, unsubscribed = 0
  const observer = observeProxyStatus({ proxy: {
    getStatus: () => new Promise(resolve => { reply = resolve }), onStatusChanged: () => () => { unsubscribed++ },
  }, config: { onConfigChanged: () => () => { unsubscribed++ } } }, () => assert.fail('disposed'), error => assert.fail(error))
  observer.dispose(); reply(running); await turn()
  assert.equal(unsubscribed, 2)
})

test('copyable local URL uses actual port and does not use wildcard bind hosts', () => {
  assert.equal(localProxyOrigin(running), 'http://127.0.0.1:8081')
  assert.equal(localProxyOrigin({ host: '::', port: 8081 }), 'http://127.0.0.1:8081')
  assert.equal(localProxyOrigin({ host: '::1', port: 8081 }), 'http://[::1]:8081')
})

function controls() {
  let configured = { proxyPort: 8081, proxyHost: '0.0.0.0' }
  let failStart = false, actualRunning = false
  const manager = new ProxyStatusManager(), calls = [], events = []
  const source = readFileSync(join(root, 'src/main/ipc/handlers.ts'), 'utf8')
  const barrel = readFileSync(join(root, 'src/main/ipc/index.ts'), 'utf8')
  assert.doesNotMatch(barrel, /\bsetProxyStatus\b/)
  for (const name of ['getProxyStatus', 'publishProxyStatus', 'startProxyService', 'stopProxyService']) assert.ok(barrel.includes(name))
  const start = source.indexOf('export function getProxyStatus(): ProxyStatus {')
  const end = source.indexOf('function registerErrorRecoveryHandlers', start)
  assert.match(source, /import \{ proxyServer \} from '\.\.\/proxy\/server'/)
  assert.doesNotMatch(source, /new ProxyServer\(/)
  const api = evaluate(source.slice(start, end), {
    storeManager: { getConfig: () => configured }, proxyStatusManager: manager,
    proxyServer: {
      isRunning: () => actualRunning,
      async start(port, host) { calls.push({ port, host }); if (failStart) return false; actualRunning = true; manager.setPort(port); manager.setHost(host); manager.start(); return true },
      async stop() { actualRunning = false; manager.stop(); return true },
    },
    BrowserWindow: { getAllWindows: () => [0, 1].map(window => ({ isDestroyed: () => false, webContents: { send: (channel, status) => events.push({ window, channel, status: plain(status) }) } })) },
    IpcChannels: { PROXY_STATUS_CHANGED: 'proxy:statusChanged' },
    TrayManager: { getInstance: () => ({ updateProxyStatus() {} }) },
  })
  return { ...api, calls, events, configure: value => { configured = value }, fail: () => { failStart = true } }
}

test('IPC controls share actual running instance and preserve configured versus active address', async () => {
  const api = controls()
  assert.equal(api.getProxyStatus().port, 8081)
  assert.equal(await api.startProxyService(), true)
  assert.deepEqual(api.calls, [{ port: 8081, host: '0.0.0.0' }])
  api.configure({ proxyPort: 8080, proxyHost: '127.0.0.1' })
  assert.equal(api.getProxyStatus().port, 8081)
  assert.equal(await api.startProxyService(), true)
  assert.equal(api.calls.length, 1, 'no duplicate listener is created')
  assert.equal(await api.stopProxyService(), true)
  assert.equal(api.getProxyStatus().port, 8080)
  assert.equal(api.getProxyStatus().isRunning, false)
  assert.deepEqual(api.events.slice(-2).map(event => [event.window, event.status.port, event.status.isRunning]), [[0, 8080, false], [1, 8080, false]])
})

test('failed start remains stopped and never changes or retries the requested port', async () => {
  const api = controls(); api.fail()
  assert.equal(await api.startProxyService(), false)
  assert.equal(api.getProxyStatus().isRunning, false)
  assert.deepEqual(api.calls, [{ port: 8081, host: '0.0.0.0' }])
  assert.ok(api.events.every(event => event.status.isRunning === false))
  for (const badPort of [0, -1, 65536, 8080.5]) assert.equal(await api.startProxyService(badPort), false)
  assert.equal(api.calls.length, 1)
})

test('UI never optimistically reports start success and form aborts restart after failed save/stop', () => {
  const header = readFileSync(join(root, 'src/renderer/src/components/layout/Header.tsx'), 'utf8')
  const tray = readFileSync(join(root, 'src/renderer/src/components/Tray/TrayView.tsx'), 'utf8')
  const form = readFileSync(join(root, 'src/renderer/src/components/proxy/ProxyConfigForm.tsx'), 'utf8')
  for (const source of [header, tray]) {
    assert.match(source, /observeProxyStatus/)
    assert.doesNotMatch(source, /setP(?:roxyEnabled|roxyRunning)\(true\)/)
    assert.doesNotMatch(source, /setPort\(config\.proxyPort/)
  }
  assert.match(form, /if \(!saved\) return/)
  assert.match(form, /if \(!stopped\) \{/)
})
