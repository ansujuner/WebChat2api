const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), ts = require('typescript')
const { readFileSync } = require('node:fs')
const plain = value => JSON.parse(JSON.stringify(value))
function execute(source, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, ...globals })
  return module.exports
}
async function fixture() {
  const types = await import('../../src/main/store/types.ts')
  const tooling = await import('../../src/shared/toolCalling.ts')
  const panel = ts.createSourceFile('panel.tsx', readFileSync('src/renderer/src/components/models/ToolCallingPanel.tsx', 'utf8'), ts.ScriptTarget.Latest, true)
  const merge = panel.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'mergeToolCallingConfig')
  assert.ok(merge)
  const mergeToolCallingConfig = execute(merge.getText(panel) + '\nmodule.exports = { mergeToolCallingConfig };').mergeToolCallingConfig
  let config = plain(types.DEFAULT_CONFIG)
  const writes = [], logs = [], events = [], applied = []
  const storeManager = { getConfig: () => config, updateConfig: updates => { writes.push(plain(updates)); config = { ...config, ...updates }; return config }, addLog: (...args) => logs.push(args) }
  const { ConfigManager } = execute(readFileSync('src/main/store/config.ts', 'utf8'), {
    require: name => ({ './store': { storeManager }, './types': types, '../../shared/toolCalling': tooling })[name],
  })
  const { createNetworkConfigUpdater } = execute(readFileSync('src/main/network/configuration.ts', 'utf8'), { require: () => ({ configureNetworkProxy() {} }) })
  const source = ts.createSourceFile('handlers.ts', readFileSync('src/main/ipc/handlers.ts', 'utf8'), ts.ScriptTarget.Latest, true)
  const fragments = []
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle' && node.arguments[0]?.getText(source) === 'IpcChannels.CONFIG_UPDATE') fragments.push(node.getText(source))
    ts.forEachChild(node, visit)
  }
  visit(source); assert.equal(fragments.length, 1)
  let handler
  execute(fragments[0], { IpcChannels: { CONFIG_UPDATE: 'update', CONFIG_CHANGED: 'changed' }, ipcMain: { handle: (_, callback) => { handler = callback } },
    ConfigManager, storeManager, updateNetworkConfiguration: createNetworkConfigUpdater(async mode => { applied.push(mode) }),
    BrowserWindow: { getAllWindows: () => [false, true].map(destroyed => ({ isDestroyed: () => destroyed, webContents: { send: (...args) => events.push(args) } })) },
  })
  return { ConfigManager, types, mergeToolCallingConfig, tooling, writes, logs, applied, events, invoke: value => handler({}, value) }
}

test('actual exported defaults and JSON backup defaults remain valid under strict configuration validation', async () => {
  const f = await fixture()
  for (const config of [f.types.DEFAULT_CONFIG, plain(f.types.DEFAULT_CONFIG)]) {
    const result = f.ConfigManager.validate(config)
    assert.equal(result.valid, true, result.errors.join('; '))
    f.ConfigManager.update(config)
  }
  assert.equal(f.writes.length, 2)
})

test('current settings, proxy, API key, session, tools and logging UI payload shapes all remain accepted', async () => {
  const f = await fixture()
  const payloads = [
    ...['system', 'light', 'dark'].map(theme => ({ theme })),
    ...['zh-CN', 'en-US'].map(language => ({ language })),
    ...['system', 'none'].map(oauthProxyMode => ({ oauthProxyMode })),
    ...['round-robin', 'fill-first', 'failover'].map(loadBalanceStrategy => ({ loadBalanceStrategy })),
    { proxyPort: 8081, proxyHost: '127.0.0.1', enableApiKey: true }, { proxyPort: 65535, proxyHost: '::1' },
    { requestTimeout: 1000, retryCount: 0 }, { requestTimeout: 300000, retryCount: 10 },
    { autoStart: true, autoStartProxy: false, minimizeToTray: true },
    { sessionConfig: { mode: 'single', ...plain(f.types.DEFAULT_SESSION_CONFIG), deleteAfterTimeout: true } },
    { requestLogConfig: { ...plain(f.types.DEFAULT_REQUEST_LOG_CONFIG), includeBodies: true, maxBodyChars: 12000 } },
    { managementApi: { enableManagementApi: true, managementApiSecret: 'fixture-private-management', managementApiPort: 8317 } },
    { contextManagement: { ...plain(f.types.DEFAULT_CONTEXT_MANAGEMENT_CONFIG), enabled: true } },
    { apiKeys: [{ id: 'fixture-key-id', name: 'Fixture', key: 'fixture-private-gateway', enabled: true, createdAt: 1700000000000, usageCount: 0 }] },
    { apiKeys: [], enableApiKey: true },
    { modelMappings: { 'claude-*-latest': { requestModel: 'claude-*-latest', actualModel: 'deepseek-v4-pro', preferredProviderId: 'deepseek', preferredAccountId: 'fixture-account' } } },
    ...['off', 'auto', 'force'].map(mode => ({ toolCallingConfig: f.mergeToolCallingConfig(f.types.DEFAULT_TOOL_CALLING_CONFIG_VALUE, { mode, clientAdapterId: 'standard-openai-tools', advanced: { customPrompt: 'fixture-private-prompt' } }) })),
    { toolCallingConfig: f.mergeToolCallingConfig(f.types.DEFAULT_TOOL_CALLING_CONFIG_VALUE, { clientAdapterId: 'cherry-studio-mcp', diagnosticsEnabled: true }) },
  ]
  for (const payload of payloads) {
    assert.equal(f.ConfigManager.validate(payload).valid, true, Object.keys(payload).join(','))
    assert.equal(await f.invoke(payload), true)
  }
  assert.equal(f.writes.length, payloads.length)
  assert.equal(f.events.length, payloads.length, 'only live windows receive CONFIG_CHANGED')
  assert.deepEqual(f.applied, ['system', 'none'])
  assert.doesNotMatch(JSON.stringify(f.logs), /fixture-private/)
})

test('actual CONFIG_UPDATE IPC rejects invalid scalars before proxy apply, persistence or broadcasts', async () => {
  const f = await fixture()
  for (const payload of [null, [], { proxyPort: '8081' }, { retryCount: false }, { autoStart: 'false' },
    { enableApiKey: 'true' }, { oauthProxyMode: 'invalid' }, { sessionConfig: null }, { unknown: 'fixture' },
    { oauthProxyMode: 'none', proxyPort: 70000 }]) await assert.rejects(f.invoke(payload))
  assert.deepEqual(f.applied, [])
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.events, [])
  assert.deepEqual(f.logs, [])
})
