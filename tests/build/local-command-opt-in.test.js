const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = join(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
const livenessSource = ts.createSourceFile('accountLiveness.ts', readFileSync(join(root, 'src/main/diagnostics/accountLiveness.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
const summaryDeclaration = livenessSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'summarizeAccountLivenessJob')
assert.ok(summaryDeclaration)
const summaryModule = { exports: {} }
vm.runInNewContext(ts.transpileModule(summaryDeclaration.getText(livenessSource), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { module: summaryModule, exports: summaryModule.exports })

// Execute the real app entry point with only local in-memory fakes. No Electron
// process, user profile, proxy setting, filesystem write or generation is used.
function application(options = {}) {
  const events = new Map(), calls = [], writes = [], logs = []
  let quits = 0
  let quotaInitializations = 0
  const window = { isMinimized: () => false, restore() {}, show() {}, focus() {} }
  const app = {
    requestSingleInstanceLock: () => options.lock ?? true,
    on: (name, callback) => events.set(name, callback),
    quit: () => { quits++ },
    getAppPath: () => join(root, 'fixture-local-command-app'),
    isPackaged: options.packaged ?? false,
    getPath: () => join(root, 'fixture-local-command-user-data'),
    getVersion: () => 'fixture',
  }
  const dependencies = {
    './network/bootstrap': {},
    './arena/rateLimit': { initializeArenaRateLimits(directory) {
      quotaInitializations++
      assert.equal(directory, app.getPath('userData'))
      if (options.quotaFailure) throw Error('private-quota-storage-path')
    } },
    electron: { app },
    path: require('node:path'),
    './window/manager': {
      createWindow: () => window, getMainWindow: () => window,
      loadUrl: async () => {}, loadFile: async () => {}, openDevTools() {},
    },
    './tray/TrayManager': { createTrayManager: () => ({ destroy() {} }) },
    './ipc/handlers': {
      registerIpcHandlers: async () => { assert.equal(quotaInitializations, 1); calls.push({ operation: 'initialize' }) },
      startProxyService: async () => { calls.push({ operation: 'start' }); return options.startSuccess ?? true },
    },
    './updater': { UpdaterManager: { getInstance: () => ({ destroy() {} }) } },
    './store/store': { storeManager: { flushPendingWrites() {} } },
    './oauth/zaiAccountBrowser': { zaiAccountBrowserManager: {
      hasOpenBrowsers: () => !!options.zaiOpen,
      destroy: async () => { calls.push({ operation: 'closeZai' }); if (options.closeZai) await options.closeZai() },
    } },
    './diagnostics/zaiAccountLoginProbe': { runZaiAccountLoginProbe: async save => {
      calls.push({ operation: 'zaiLogin' })
      await save({ live: false, stream: false, protocol: 'openai', status: 'awaiting_login', chatTested: false })
      return { live: false, stream: false, protocol: 'openai', status: 'passed', accountVerified: true, chatTested: false }
    } },
    './diagnostics/accountLiveness': {
      runAccountLivenessProbe: async input => {
        calls.push({ operation: 'accountProbe', input: plain(input) })
        if (options.accountFailure) throw Error('fixture-private-account-error')
        return { status: 'passed', state: 'completed', counts: { total: 1, passed: 1, failed: 0, skipped: 0, cancelled: 0 }, checks: [] }
      },
      getAccountLiveness: async () => { calls.push({ operation: 'accountStatus' }); if (options.accountFailure) throw Error('fixture-private-account-error'); return options.accountJob ?? null },
      summarizeAccountLivenessJob: summaryModule.exports.summarizeAccountLivenessJob,
    },
    './arena/browserManager': { arenaBrowserManager: {
      hasOpenBrowsers: () => !!options.arenaOpen,
      destroy: async () => { calls.push({ operation: 'closeArena' }); if (options.closeArena) await options.closeArena() },
    } },
    './diagnostics/arenaProbe': {
      runArenaLoginProbe: async save => {
        calls.push({ operation: 'arenaLogin' })
        await save({ live: false, stream: false, protocol: 'openai', status: 'awaiting_login' })
        return { live: false, stream: false, protocol: 'openai', status: 'passed', accountVerified: true }
      },
      runArenaProbe: async () => { calls.push({ operation: 'arenaProbe' }); return { status: 'passed', live: true, stream: false, protocol: 'openai' } },
    },
    './oauth/externalBrowserLogin': { externalBrowserLoginManager: {
      isWindowOpen: () => !!options.browserOpen,
      cancelAndWait: async () => { calls.push({ operation: 'closeLogin' }); if (options.closeLogin) await options.closeLogin() },
    } },
    './diagnostics/toolCallingSmoke': { runToolCallingSmoke: async () => {
      calls.push({ operation: 'toolSmoke' })
      if (options.toolFailure) throw new Error('fixture-private-tool-error')
      return options.toolResult || { success: true, checks: [] }
    } },
    './diagnostics/localProbe': { runLocalProbe: async probe => {
      calls.push({ operation: 'probe', options: plain(probe) })
      if (options.probeFailure) throw new Error('fixture-private-error-must-not-export')
      if (options.probe) return options.probe(probe)
      return { status: probe.live ? 'passed' : 'ready', port: 8081, live: probe.live }
    }, runDeepSeekModesProbe: async () => {
      calls.push({ operation: 'deepseekProbe' })
      if (options.deepseekFailure) throw new Error('fixture-private-deepseek-error')
      return { status: 'passed', port: 8081, live: true, stream: false, protocol: 'openai' }
    } },
    './diagnostics/deepseekLoginProbe': { runDeepSeekLoginProbe: async save => {
      calls.push({ operation: 'loginProbe' })
      if (options.loginFailure) throw new Error('fixture-private-login-error')
      const report = { live: false, stream: false, protocol: 'openai', accountVerified: false }
      await save({ ...report, status: 'awaiting_login' })
      if (options.login) return options.login(save)
      return { ...report, status: 'passed', accountVerified: true }
    } },
    'node:fs/promises': {
      mkdir: async () => { if (options.mkdirFailure) throw new Error('fixture unwritable directory') },
      writeFile: async (file, data) => { writes.push({ file, data: JSON.parse(data) }) },
    },
  }
  const source = readFileSync(join(root, 'src/main/index.ts'), 'utf8') + `
export const __fixture = {
  enqueue: enqueueLocalCommand,
  drain: () => localCommands,
}
`
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, {
    module, exports: module.exports, __dirname: join(root, 'fixture-local-command-app/out/main'),
    process: { platform: 'win32', argv: options.argv ?? ['fixture-electron.exe', 'fixture-app'], env: {}, on() {} },
    console: { log: value => logs.push(String(value)), error: value => logs.push(String(value)) },
    require: name => { assert.ok(Object.hasOwn(dependencies, name), `unmocked dependency ${name}`); return dependencies[name] },
  })
  const controls = module.exports.__fixture
  return {
    calls, writes, logs, get quits() { return quits },
    beforeQuit: event => events.get('before-quit')(event),
    async ready() { if (events.has('ready')) await events.get('ready')(); await controls.drain() },
    dispatch(argv) { events.get('second-instance')({}, argv) },
    async second(argv) { events.get('second-instance')({}, argv); await controls.drain() },
  }
}

test('existing Z.ai account restore is explicitly dispatched without proxy startup or chat generation', async () => {
  const fixture = application()
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=zai-login'])
  assert.equal(fixture.calls.filter(call => call.operation === 'zaiLogin').length, 1)
  assert.ok(fixture.calls.every(call => !['start', 'probe', 'toolSmoke'].includes(call.operation)))
  assert.equal(fixture.writes.at(-1).data.accountVerified, true)
  assert.equal(fixture.writes.at(-1).data.chatTested, false)
  assert.equal(fixture.writes.at(-1).data.live, false)
})

test('quit waits for retained Z.ai account browsers and never opens a new one', async () => {
  let release
  const closing = new Promise(resolve => { release = resolve })
  const fixture = application({ zaiOpen: true, closeZai: () => closing })
  let prevented = 0
  fixture.beforeQuit({ preventDefault() { prevented++ } })
  assert.equal(prevented, 1)
  assert.equal(fixture.calls.filter(call => call.operation === 'closeZai').length, 1)
  assert.equal(fixture.quits, 0)
  release()
  for (let i = 0; i < 12; i++) await Promise.resolve()
  assert.equal(fixture.quits, 1)
})

test('quit waits once for the owned login browser then allows normal exit', async () => {
  let release
  const closing = new Promise(resolve => { release = resolve })
  const fixture = application({ browserOpen: true, closeLogin: () => closing })
  let prevented = 0
  const event = { preventDefault() { prevented++ } }
  fixture.beforeQuit(event)
  fixture.beforeQuit(event)
  assert.equal(prevented, 2)
  assert.equal(fixture.quits, 0)
  assert.equal(fixture.calls.filter(call => call.operation === 'closeLogin').length, 1)
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.quits, 1)
  fixture.beforeQuit(event)
  assert.equal(prevented, 2)
})

test('quit without an isolated browser does not delay exit or open a login', () => {
  const fixture = application()
  fixture.beforeQuit({ preventDefault() { assert.fail('unexpected delay') } })
  assert.deepEqual(fixture.calls, [])
})

test('Arena quota initialization failure does not expose filesystem details or block unrelated app startup', async () => {
  const fixture = application({ quotaFailure: true })
  await fixture.ready()
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }])
  assert.match(fixture.logs.join('\n'), /Quota storage is unavailable/)
  assert.doesNotMatch(fixture.logs.join('\n'), /private-quota-storage-path/)
})

test('quit awaits retained Arena browsers even when login has completed', async () => {
  let release
  const closing = new Promise(resolve => { release = resolve })
  const fixture = application({ arenaOpen: true, closeArena: () => closing })
  let prevented = 0
  fixture.beforeQuit({ preventDefault() { prevented++ } })
  assert.equal(prevented, 1)
  assert.equal(fixture.quits, 0)
  assert.equal(fixture.calls.filter(call => call.operation === 'closeArena').length, 1)
  release()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.quits, 1)
})

test('Arena login is explicit and never requests a generation', async () => {
  const fixture = application()
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', 'fixture-app', '--chat2api-probe=arena-login'])
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }, { operation: 'arenaLogin' }])
  assert.equal(fixture.writes.at(-1).data.live, false)
  assert.equal(fixture.writes.at(-1).data.status, 'passed')
})

test('Arena live checks dispatch only after an explicit opt-in', async () => {
  const fixture = application()
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', 'fixture-app', '--chat2api-probe=arena'])
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }, { operation: 'start' }, { operation: 'arenaProbe' }])
  assert.equal(fixture.writes.at(-1).data.live, true)
})

test('ordinary app startup and ordinary second-instance focus never start a diagnostic or generation', async () => {
  const fixture = application()
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', 'fixture-app'])
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }])
  assert.deepEqual(fixture.writes, [])
  assert.equal(fixture.quits, 0)
})

test('command-only helper refuses to boot a new app/profile when no existing instance accepts it', async () => {
  for (const flag of ['--chat2api-probe=catalog', '--chat2api-probe=live', '--chat2api-probe=stream', '--chat2api-probe=deepseek', '--chat2api-probe=login', '--chat2api-probe=tools', '--chat2api-probe=zai-liveness', '--chat2api-probe=accounts-status', '--chat2api-quit']) {
    const fixture = application({ argv: ['fixture-electron.exe', flag] })
    await fixture.ready()
    assert.deepEqual(fixture.calls, [])
    assert.deepEqual(fixture.writes, [])
    assert.equal(fixture.quits, 1)
  }
})

test('a helper which fails the single-instance lock never initializes or runs commands itself', async () => {
  for (const mode of ['catalog', 'live', 'stream', 'deepseek', 'login', 'tools', 'zai-liveness', 'accounts-status']) {
    const fixture = application({ lock: false, argv: ['fixture-electron.exe', `--chat2api-probe=${mode}`] })
    await fixture.ready()
    assert.deepEqual(fixture.calls, [])
    assert.deepEqual(fixture.writes, [])
    assert.equal(fixture.quits, 1)
  }
})

test('early second-instance catalog command waits for initialization without being dropped', async () => {
  const fixture = application()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=catalog'])
  assert.deepEqual(fixture.calls, [])
  await fixture.ready()
  assert.equal(fixture.calls[0].operation, 'initialize')
  assert.deepEqual(fixture.calls.filter(call => call.operation === 'probe'), [
    { operation: 'probe', options: { live: false, stream: false, protocol: 'openai' } },
  ])
})

test('malformed or unknown probe flags never enable live generation', async () => {
  const fixture = application()
  await fixture.ready()
  for (const flag of ['--chat2api-probe=LIVE', '--chat2api-probe', '--chat2api-probe=', '--chat2api-probe=live-extra', 'prefix--chat2api-probe=live', '--chat2api-probe=anything', '--chat2api-probe=DeepSeek', '--chat2api-probe=login-extra', '--chat2api-probe=../../login']) {
    await fixture.second(['fixture-electron.exe', flag])
  }
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }])
  assert.deepEqual(fixture.writes, [])
})

test('explicit catalog flag starts only catalog inspection and never enables inference', async () => {
  const fixture = application()
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=catalog'])
  assert.deepEqual(fixture.calls, [
    { operation: 'initialize' }, { operation: 'start' },
    { operation: 'probe', options: { live: false, stream: false, protocol: 'openai' } },
  ])
  assert.equal(fixture.writes.length, 2)
  assert.equal(fixture.writes[0].data.status, 'running')
  assert.equal(fixture.writes[1].data.live, false)
  assert.equal(fixture.writes[1].data.port, 8081)
  assert.ok(fixture.writes[1].file.endsWith('proxy-catalog-probe.json'))
})

test('explicit live and stream flags select their intended protocol exactly once each', async () => {
  const fixture = application()
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=live'])
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=stream'])
  assert.deepEqual(fixture.calls.filter(call => call.operation === 'probe'), [
    { operation: 'probe', options: { live: true, stream: false, protocol: 'openai' } },
    { operation: 'probe', options: { live: true, stream: true, protocol: 'anthropic' } },
  ])
  assert.equal(fixture.writes.length, 4)
})

test('explicit normal quit never falls through to probe flags in the same invocation', async () => {
  const fixture = application()
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', '--chat2api-quit', '--chat2api-probe=live'])
  assert.equal(fixture.quits, 1)
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }])
  assert.deepEqual(fixture.writes, [])
})

test('explicit DeepSeek all-modes dispatch uses only its dedicated probe once', async () => {
  const fixture = application()
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=deepseek'])
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }, { operation: 'start' }, { operation: 'deepseekProbe' }])
  assert.equal(fixture.writes.length, 2)
  assert.ok(fixture.writes.every(item => item.file.endsWith('proxy-deepseek-probe.json')))
  assert.equal(fixture.writes[0].data.status, 'running')
  assert.equal(fixture.writes[1].data.live, true)
  assert.equal(fixture.writes[1].data.stream, false)
  assert.equal(fixture.writes[1].data.protocol, 'openai')
})

test('explicit interactive login dispatch writes progress and completion without starting proxy or generation', async () => {
  const fixture = application()
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=login'])
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }, { operation: 'loginProbe' }])
  assert.deepEqual(fixture.writes.map(item => item.data.status), ['running', 'awaiting_login', 'passed'])
  assert.ok(fixture.writes.every(item => item.file.endsWith('proxy-login-probe.json') && !Number.isNaN(Date.parse(item.data.checkedAt))))
  for (const item of fixture.writes.slice(1)) {
    assert.equal(item.data.live, false)
    assert.equal(item.data.stream, false)
    assert.equal(item.data.protocol, 'openai')
  }
})

test('early interactive login commands wait for app readiness and are executed once', async () => {
  const fixture = application()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=login'])
  assert.deepEqual(fixture.calls, [])
  await fixture.ready()
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }, { operation: 'loginProbe' }])
})

test('new probe modes fail closed before dispatch if their report directory is unwritable', async () => {
  for (const mode of ['deepseek', 'login']) {
    const fixture = application({ mkdirFailure: true })
    await fixture.ready()
    await fixture.second(['fixture-electron.exe', `--chat2api-probe=${mode}`])
    assert.deepEqual(fixture.calls, [{ operation: 'initialize' }])
  }
})

test('new probe failures write a final safe report with matching mode metadata and no fallback or retry', async () => {
  for (const mode of ['deepseek', 'login']) {
    const fixture = application({ deepseekFailure: true, loginFailure: true })
    await fixture.ready()
    await fixture.second(['fixture-electron.exe', `--chat2api-probe=${mode}`])
    assert.equal(fixture.calls.filter(call => call.operation === `${mode}Probe`).length, 1)
    assert.equal(fixture.calls.filter(call => call.operation === 'probe').length, 0)
    assert.equal(fixture.writes.at(-1).data.status, 'local_probe_failed')
    assert.equal(fixture.writes.at(-1).data.live, mode === 'deepseek')
    assert.equal(fixture.writes.at(-1).data.stream, false)
    assert.doesNotMatch(JSON.stringify(fixture.writes) + fixture.logs.join('\n'), /fixture-private/)
  }
})

test('normal quit does not wait for an in-flight diagnostic to finish', async () => {
  let complete
  const fixture = application({ probe: () => new Promise(resolve => { complete = resolve }) })
  await fixture.ready()
  const running = fixture.second(['fixture-electron.exe', '--chat2api-probe=live'])
  await new Promise(resolve => setImmediate(resolve))
  fixture.dispatch(['fixture-electron.exe', '--chat2api-quit'])
  assert.equal(fixture.quits, 1)
  complete({ status: 'passed', port: 8081 })
  await running
})

test('unwritable diagnostics directory prevents a live probe before any network generation', async () => {
  const fixture = application({ mkdirFailure: true })
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=live'])
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }])
  assert.ok(fixture.logs.some(value => value.includes('Local probe failed')))
})

test('packaged app reports use writable app user data rather than app.asar path', async () => {
  const fixture = application({ packaged: true })
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=catalog'])
  assert.ok(fixture.writes.every(item => item.file === join(root, 'fixture-local-command-user-data', 'diagnostics', 'proxy-catalog-probe.json')))
})

test('failed diagnostic does not retry or export arbitrary private errors', async () => {
  const fixture = application({ probeFailure: true })
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=live'])
  assert.equal(fixture.calls.filter(call => call.operation === 'probe').length, 1)
  assert.equal(fixture.writes.at(-1).data.status, 'local_probe_failed', 'a failed probe must not leave a running report forever')
  assert.doesNotMatch(JSON.stringify(fixture.writes), /fixture-private-error/)
  assert.ok(fixture.logs.some(value => value.includes('Local probe failed')))
  assert.doesNotMatch(fixture.logs.join('\n'), /fixture-private-error/)
})

test('health metadata derives all client URLs from bound server state, not persisted config', () => {
  const source = readFileSync(join(root, 'src/main/proxy/server.ts'), 'utf8')
  const body = source.slice(source.indexOf("this.router.get('/health'"), source.indexOf("this.router.get('/stats'"))
  assert.match(body, /port: this\.port/)
  assert.match(body, /host: this\.host/)
  assert.match(body, /localBaseUrl: this\.getLocalBaseUrl\(\)/)
  assert.match(body, /modelsUrl: `\$\{this\.getLocalBaseUrl\(\)\}\/v1\/models`/)
  assert.doesNotMatch(body, /storeManager|getConfig\(|8080|8081/)
})

test('explicit tools command starts exactly its two-turn smoke service and maps true/false result honestly', async () => {
  for (const success of [true, false]) {
    const fixture = application({ toolResult: { success, category: success ? 'pass' : 'model_did_not_call_tool', message: 'safe diagnostic fixture' } })
    await fixture.ready()
    await fixture.second(['fixture-electron.exe', '--chat2api-probe=tools'])
    assert.deepEqual(fixture.calls, [{ operation: 'initialize' }, { operation: 'start' }, { operation: 'toolSmoke' }])
    assert.equal(fixture.writes.length, 2)
    const final = fixture.writes.at(-1)
    assert.ok(final.file.endsWith('proxy-tools-probe.json'))
    assert.equal(final.data.live, true)
    assert.equal(final.data.stream, false)
    assert.equal(final.data.protocol, 'openai')
    assert.equal(final.data.status, success ? 'passed' : 'needs_attention')
    assert.equal(final.data.result.success, success)
  }
})

test('tools command failure cannot leave a success/running report and never retries', async () => {
  const fixture = application({ toolFailure: true })
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=tools'])
  assert.equal(fixture.calls.filter(call => call.operation === 'toolSmoke').length, 1)
  assert.equal(fixture.writes.at(-1).data.status, 'local_probe_failed')
  assert.equal(fixture.writes.at(-1).data.live, true)
  assert.doesNotMatch(JSON.stringify(fixture.writes) + fixture.logs.join('\n'), /fixture-private-tool-error/)
})

test('tools command waits for app initialization and report writability before any generation', async () => {
  const early = application()
  await early.second(['fixture-electron.exe', '--chat2api-probe=tools'])
  assert.deepEqual(early.calls, [])
  await early.ready()
  assert.equal(early.calls.filter(call => call.operation === 'toolSmoke').length, 1)
  const unwritable = application({ mkdirFailure: true })
  await unwritable.ready()
  await unwritable.second(['fixture-electron.exe', '--chat2api-probe=tools'])
  assert.deepEqual(unwritable.calls, [{ operation: 'initialize' }])
})

test('unknown tools flag variants never submit a tool smoke request', async () => {
  const fixture = application()
  await fixture.ready()
  for (const flag of ['--chat2api-probe=TOOLS', '--chat2api-probe=tool', '--chat2api-probe=tools-extra', 'prefix--chat2api-probe=tools']) await fixture.second(['fixture-electron.exe', flag])
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }])
})

test('Zai liveness is scoped to its provider and never falls back to all accounts, proxy startup or other probes', async () => {
  const fixture = application()
  await fixture.ready()
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=zai-liveness'])
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }, { operation: 'accountProbe', input: { providerId: 'zai' } }])
  const final = fixture.writes.at(-1)
  assert.ok(final.file.endsWith('proxy-zai-liveness-probe.json'))
  assert.equal(final.data.live, true); assert.equal(final.data.stream, false); assert.equal(final.data.protocol, 'openai')
  await fixture.second(['fixture-electron.exe', '--chat2api-probe=accounts'])
  assert.deepEqual(fixture.calls.at(-1), { operation: 'accountProbe', input: {} })
})

test('account status reads and summarizes the existing job without generation, waiting, restart or identity export', async () => {
  for (const state of ['running', 'completed', 'cancelled']) {
    const fixture = application({ accountJob: { id: 'SECRET-JOB-ID', state, mode: 'batch', startedAt: 1, updatedAt: 2,
      results: [{ accountId: 'SECRET-ACCOUNT-ID', accountName: 'PRIVATE@example.test', providerId: 'zai', status: 'failed',
        reason: 'action_required', httpStatus: 403, latencyMs: 27, credentials: { token: 'SECRET-TOKEN' }, response: 'SECRET-REPLY' }] } })
    await fixture.ready()
    await fixture.second(['fixture-electron.exe', '--chat2api-probe=accounts-status'])
    assert.deepEqual(fixture.calls, [{ operation: 'initialize' }, { operation: 'accountStatus' }])
    const final = fixture.writes.at(-1)
    assert.ok(final.file.endsWith('proxy-accounts-status-probe.json'))
    assert.equal(final.data.live, false); assert.equal(final.data.stream, false); assert.equal(final.data.protocol, 'openai')
    assert.equal(final.data.state, state); assert.equal(final.data.status, 'needs_attention')
    assert.deepEqual(final.data.counts, { total: 1, passed: 0, failed: 1, skipped: 0, cancelled: 0 })
    assert.deepEqual(final.data.checks, [{ provider: 'zai', status: 'failed', reason: 'action_required', httpStatus: 403, latencyMs: 27 }])
    assert.doesNotMatch(JSON.stringify(fixture.writes), /SECRET|PRIVATE|accountId|accountName|credentials/)
  }
})

test('account status without any prior job reports no_result and never starts a check', async () => {
  const fixture = application()
  await fixture.ready(); await fixture.second(['fixture-electron.exe', '--chat2api-probe=accounts-status'])
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }, { operation: 'accountStatus' }])
  assert.equal(fixture.writes.at(-1).data.status, 'no_result')
  assert.equal(fixture.writes.at(-1).data.live, false)
})

test('new account modes enforce readiness/writability and fail safely without retries or fallback generation', async () => {
  for (const mode of ['zai-liveness', 'accounts-status']) {
    const early = application()
    await early.second(['fixture-electron.exe', `--chat2api-probe=${mode}`]); assert.deepEqual(early.calls, [])
    await early.ready(); assert.equal(early.calls.length, 2)
    const unwritable = application({ mkdirFailure: true })
    await unwritable.ready(); await unwritable.second(['fixture-electron.exe', `--chat2api-probe=${mode}`])
    assert.deepEqual(unwritable.calls, [{ operation: 'initialize' }])
    const failed = application({ accountFailure: true })
    await failed.ready(); await failed.second(['fixture-electron.exe', `--chat2api-probe=${mode}`])
    assert.equal(failed.calls.length, 2)
    assert.equal(failed.writes.at(-1).data.status, 'local_probe_failed')
    assert.equal(failed.writes.at(-1).data.live, mode === 'zai-liveness')
    assert.doesNotMatch(JSON.stringify(failed.writes) + failed.logs.join('\n'), /fixture-private/)
  }
})

test('ambiguous or misspelled account mode names never dispatch a generation', async () => {
  const fixture = application(); await fixture.ready()
  for (const flag of ['--chat2api-probe=Zai-Liveness', '--chat2api-probe=zai-liveness-extra', '--chat2api-probe=account-status', '--chat2api-probe=accounts-status-extra', 'prefix--chat2api-probe=zai-liveness']) {
    await fixture.second(['fixture-electron.exe', flag])
  }
  assert.deepEqual(fixture.calls, [{ operation: 'initialize' }]); assert.deepEqual(fixture.writes, [])
})
