const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = join(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
const channels = { TOOL_CALLING_GET_STATUS: 'toolCalling:getStatus', TOOL_CALLING_RUN_SMOKE: 'toolCalling:runSmoke' }

function execute(source, globals) {
  const module = { exports: {} }
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(output, { module, exports: module.exports, ...globals })
  return module.exports
}

function registration(settings = {}) {
  const filename = join(root, 'src/main/ipc/handlers.ts')
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const fragments = []
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle'
      && /^IpcChannels\.TOOL_CALLING_(?:GET_STATUS|RUN_SMOKE)$/.test(node.arguments[0]?.getText(source))) fragments.push(node.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(fragments.length, 2, 'execute the actual production IPC callbacks, not recreated equivalents')
  const callbacks = new Map(), calls = []
  const validatorFile = join(root, 'src/main/diagnostics/toolCallingSmoke.ts')
  const validatorSource = ts.createSourceFile(validatorFile, readFileSync(validatorFile, 'utf8'), ts.ScriptTarget.Latest, true)
  const validatorFragments = validatorSource.statements.filter(node =>
    (ts.isFunctionDeclaration(node) && node.name?.text === 'validateToolCallingSmokeInput') ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(validatorSource) === 'CLIENTS')))
  assert.equal(validatorFragments.length, 2)
  const validator = execute(validatorFragments.map(node => node.getText(validatorSource)).join('\n'), {})
  const report = settings.report || { success: false, category: 'model_did_not_call_tool', message: 'The model did not call the tool.', checks: [{ stage: 'tool_call', success: false }] }
  const service = {
    validateToolCallingSmokeInput: input => { calls.push({ kind: 'validate' }); return validator.validateToolCallingSmokeInput(input) },
    getToolCallingSmokeStatus: async () => { calls.push({ kind: 'status' }); return { models: [], latestSmokeResult: report } },
    runToolCallingSmoke: async input => { calls.push({ kind: 'run', input: plain(input) }); if (settings.fail) throw new Error('fixture diagnostic failure'); return report },
  }
  execute(fragments.map(fragment => `${fragment};`).join('\n'), {
    IpcChannels: channels, ipcMain: { handle: (channel, callback) => callbacks.set(channel, callback) },
    startProxyService: async () => { calls.push({ kind: 'start' }); if (settings.start) await settings.start(); return settings.startSuccess ?? true },
    require(name) { assert.equal(name, '../diagnostics/toolCallingSmoke'); return service },
  })
  return { calls, report, invoke: (channel, value = {}) => callbacks.get(channels[channel])({}, value) }
}

test('desktop tool status is independent of HTTP management enablement, secret and proxy startup', async () => {
  const f = registration()
  const status = await f.invoke('TOOL_CALLING_GET_STATUS')
  assert.deepEqual(f.calls, [{ kind: 'status' }])
  assert.equal(status.latestSmokeResult.success, false)
})

test('desktop tool smoke awaits service startup and returns genuine failure rather than IPC transport success', async () => {
  let release
  const f = registration({ start: () => new Promise(resolve => { release = resolve }) })
  const input = { clientAdapterId: 'standard-openai-tools', model: 'deepseek-v4-flash', providerId: 'deepseek' }
  const pending = f.invoke('TOOL_CALLING_RUN_SMOKE', input)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls, [{ kind: 'validate' }, { kind: 'start' }])
  release()
  const result = await pending
  assert.equal(result.success, false)
  assert.equal(result.message, f.report.message)
  assert.deepEqual(f.calls, [{ kind: 'validate' }, { kind: 'start' }, { kind: 'run', input }])
})

test('desktop tool smoke startup failure never invokes a model or claims a pass', async () => {
  const f = registration({ startSuccess: false })
  const result = await f.invoke('TOOL_CALLING_RUN_SMOKE')
  assert.equal(result.success, false)
  assert.equal(result.category, 'provider_or_account_error')
  assert.match(result.message, /port|start/i)
  assert.deepEqual(f.calls, [{ kind: 'validate' }, { kind: 'start' }])
})

test('desktop smoke rejects malformed IPC input before starting the proxy or reading model/account state', async () => {
  for (const input of [null, [], 'auto', { model: '' }, { model: 7 }, { providerId: ' ' }, { clientAdapterId: 'unsupported' }, { command: 'not permitted' }]) {
    const f = registration()
    await assert.rejects(f.invoke('TOOL_CALLING_RUN_SMOKE', input), /Invalid tool test/)
    assert.deepEqual(f.calls, [{ kind: 'validate' }])
  }
})

test('desktop smoke invokes the real service once and preserves its success result', async () => {
  const f = registration({ report: { success: true, category: 'pass', message: 'Both real turns passed.', checks: [{ stage: 'tool_call', success: true }, { stage: 'tool_result', success: true }] } })
  assert.deepEqual(await f.invoke('TOOL_CALLING_RUN_SMOKE'), f.report)
  assert.equal(f.calls.filter(call => call.kind === 'run').length, 1)
})

test('desktop smoke service exception rejects without retry or a fabricated result', async () => {
  const f = registration({ fail: true })
  await assert.rejects(f.invoke('TOOL_CALLING_RUN_SMOKE'), /fixture diagnostic failure/)
  assert.equal(f.calls.filter(call => call.kind === 'run').length, 1)
})

test('preload exposes only direct IPC calls for tool tests and forwards model/provider without retrieving secrets', async () => {
  const filename = join(root, 'src/preload/index.ts')
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const statement = source.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(source) === 'toolCallingAPI'))
  assert.ok(statement)
  const calls = []
  const { toolCallingAPI } = execute(`${statement.getText(source)}\nexports.toolCallingAPI = toolCallingAPI`, {
    IpcChannels: channels, ipcRenderer: { invoke: async (...args) => { calls.push(args); return { success: false } } },
  })
  await toolCallingAPI.getStatus()
  const input = { model: 'model', providerId: 'provider', clientAdapterId: 'cherry-studio-mcp' }
  assert.equal((await toolCallingAPI.runSmoke(input)).success, false)
  assert.deepEqual(calls, [[channels.TOOL_CALLING_GET_STATUS], [channels.TOOL_CALLING_RUN_SMOKE, input]])
  assert.doesNotMatch(statement.getText(source), /fetch|management|apiKey|secret|storeAPI|proxyAPI/i)
})

function management(settings = {}) {
  let router
  const calls = []
  const auth = async (_ctx, next) => next()
  class Router {
    constructor(options) { this.options = options; this.middlewares = []; this.routes = new Map(); router = this }
    use(middleware) { this.middlewares.push(middleware) }
    get(path, callback) { this.routes.set(`GET ${path}`, callback) }
    post(path, callback) { this.routes.set(`POST ${path}`, callback) }
  }
  const report = settings.report || { success: false, category: 'parser_failed', message: 'Tool parser did not produce a valid call.' }
  execute(readFileSync(join(root, 'src/main/proxy/routes/management/toolCalling.ts'), 'utf8'), {
    require(name) {
      if (name === '@koa/router') return { default: Router }
      if (name.endsWith('/managementAuth')) return { managementAuthMiddleware: auth }
      if (name.endsWith('/toolCallingSmoke')) return {
        getToolCallingSmokeStatus: async () => ({ models: [], latestSmokeResult: report }),
        runToolCallingSmoke: async input => { calls.push(plain(input)); if (settings.fail) throw new Error('fixture service failure'); return report },
      }
      throw new Error(`Unexpected management dependency: ${name}`)
    },
  })
  return { router, auth, calls, report }
}

test('authenticated HTTP management smoke reuses the real service and reports its failure, never a fixture-generated pass', async () => {
  const f = management()
  assert.deepEqual(f.router.middlewares, [f.auth])
  const input = { model: 'deepseek-v4-flash', providerId: 'deepseek' }
  const ctx = { request: { body: input } }
  await f.router.routes.get('POST /smoke')(ctx)
  assert.equal(ctx.body.success, false)
  assert.deepEqual(ctx.body.data.result, f.report)
  assert.deepEqual(f.calls, [input])
  assert.equal(ctx.body.data.fixture, undefined)
})

test('management status does not run inference and HTTP smoke success requires real service success', async () => {
  const f = management({ report: { success: true, category: 'pass', message: 'Both real turns passed.' } })
  const status = {}
  await f.router.routes.get('GET /status')(status)
  assert.equal(f.calls.length, 0)
  const ctx = { request: { body: {} } }
  await f.router.routes.get('POST /smoke')(ctx)
  assert.equal(ctx.body.success, true)
  assert.equal(f.calls.length, 1)
})

test('management service failure is not retried or translated into a false success body', async () => {
  const f = management({ fail: true })
  const ctx = { request: { body: {} } }
  await assert.rejects(f.router.routes.get('POST /smoke')(ctx), /fixture service failure/)
  assert.equal(ctx.body, undefined)
  assert.equal(f.calls.length, 1)
})
