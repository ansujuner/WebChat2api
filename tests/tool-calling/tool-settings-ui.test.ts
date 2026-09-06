import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { toolSmokePresentation } from '../../src/renderer/src/lib/toolSmokePresentation.ts'

test('normal tool-calling UI exposes client adapter and managed mode controls', () => {
  const panel = readFileSync('src/renderer/src/components/models/ToolCallingPanel.tsx', 'utf8')

  assert.match(panel, /toolCallingConfig/)
  assert.match(panel, /standard-openai-tools/)
  assert.match(panel, /cherry-studio-mcp/)
  assert.match(panel, /mode.*off/s)
  assert.match(panel, /mode.*auto/s)
  assert.match(panel, /mode.*force/s)
})

test('normal UI hides protocol and prompt-template internals', () => {
  const panel = readFileSync('src/renderer/src/components/models/ToolCallingPanel.tsx', 'utf8')

  assert.doesNotMatch(panel, /defaultFormat/)
  assert.doesNotMatch(panel, /ProtocolFormat/)
  assert.doesNotMatch(panel, /provider\.protocolId/)
  assert.doesNotMatch(panel, /skipKnownClient/i)
  assert.match(panel, /advanced\.customPromptTemplate/)
})

test('provider support matrix shows display labels instead of provider ids', () => {
  const panel = readFileSync('src/renderer/src/components/models/ToolCallingPanel.tsx', 'utf8')

  assert.match(panel, /provider\.label/)
  assert.doesNotMatch(panel, /<span className="text-sm font-medium">\{provider\.providerId\}<\/span>/)
})

test('Models page delegates tool settings to ToolCallingPanel', () => {
  const models = readFileSync('src/renderer/src/pages/Models.tsx', 'utf8')

  assert.match(models, /ToolCallingPanel/)
  assert.doesNotMatch(models, /PromptTemplateCard/)
  assert.doesNotMatch(models, /InjectionConfigCard/)
})

test('model mapping UI protects built-in mappings and confirms restore defaults', () => {
  const panel = readFileSync('src/renderer/src/components/proxy/ModelMappingConfig.tsx', 'utf8')

  assert.match(panel, /DEFAULT_MODEL_MAPPINGS/)
  assert.match(panel, /isBuiltInMapping/)
  assert.match(panel, /mappingSource/)
  assert.match(panel, /builtInMapping/)
  assert.match(panel, /customMapping/)
  assert.match(panel, /restoreDefaults/)
  assert.match(panel, /confirmRestoreDefaults/)
  assert.match(panel, /handleRestoreDefaults/)
  assert.match(panel, /disabled=\{isBuiltInMapping/)
  assert.match(panel, /actualModel[\s\S]*mappingSource/)
  assert.match(panel, /whitespace-nowrap/)
})

test('model mapping UI keeps save controls above the mapping list', () => {
  const panel = readFileSync('src/renderer/src/components/proxy/ModelMappingConfig.tsx', 'utf8')

  assert.match(panel, /proxy\.saveConfig[\s\S]*proxy\.searchMappings/)
})

test('model mapping provider choices are filtered by selected actual model', () => {
  const panel = readFileSync('src/renderer/src/components/proxy/ModelMappingConfig.tsx', 'utf8')

  assert.match(panel, /modelMatchedProviders/)
  assert.match(panel, /provider\.supportedModels\?\.includes\(formData\.actualModel\)/)
  assert.match(panel, /providerOptions\.map/)
  assert.match(panel, /preferredProviderId: ''/)
  assert.match(panel, /preferredAccountId: ''/)
})

test('model mapping model selection carries provider identity', () => {
  const panel = readFileSync('src/renderer/src/components/proxy/ModelMappingConfig.tsx', 'utf8')

  assert.match(panel, /createModelOptionValue\(provider\.id, model\)/)
  assert.match(panel, /parseModelOptionValue\(value\)/)
  assert.match(panel, /actualModel: selectedModel/)
  assert.match(panel, /preferredProviderId: selectedProviderId/)
  assert.match(panel, /const selectedModelOptionValue/)
})

test('dashboard chart avoids the broken recharts dependency path', () => {
  const chart = readFileSync('src/renderer/src/components/dashboard/RequestChart.tsx', 'utf8')

  assert.doesNotMatch(chart, /from 'recharts/)
  assert.match(chart, /<svg/)
})

test('tool smoke UI selects a concrete provider/model and translates allowlisted diagnostic codes', () => {
  const panel = readFileSync('src/renderer/src/components/models/ToolCallingPanel.tsx', 'utf8')
  assert.match(panel, /toolCalling\?\.getStatus\(\)/)
  assert.match(panel, /setSmokeModels\(status\.models \?\? \[\]\)/)
  assert.match(panel, /value=\{smokeSelection\}/)
  assert.match(panel, /model: selected\.model, providerId: selected\.providerId/)
  assert.match(panel, /toolSmokePresentation\(result\)/)
  assert.match(panel, /setSmokeStatus\(view\.status\)/)
  assert.match(panel, /setSmokeMessage\(view\.messageKey\)/)
  assert.match(panel, /role="status"[^>]*>\{t\(smokeMessage\)\}/)
  assert.doesNotMatch(panel, /setSmokeMessage\(result\??\.message/)
  assert.match(panel, /smokeView\.checks\.map/)
  assert.match(panel, /smokeStatus === 'blocked'/)
  assert.doesNotMatch(panel, /managementApi|managementSecret|result\?\.data\?\.success|buildSmokeFixture/)
})

test('tool test disables repeated clicks while running and shows an explicit error when IPC is unavailable', () => {
  const panel = readFileSync('src/renderer/src/components/models/ToolCallingPanel.tsx', 'utf8')
  assert.match(panel, /onClick=\{runSmoke\} disabled=\{smokeStatus === 'running'\}/)
  assert.match(panel, /catch \{[\s\S]*?setSmokeStatus\('blocked'\)[\s\S]*?setSmokeMessage\('toolCalling\.smoke\.unavailable'\)/)
  assert.match(panel, /if \(smokeRunning\.current\) return/)
  assert.match(panel, /setSmokeMessage\(''\)/)
})

function smokeUiFixture(selection: string, models: Array<{ model: string; providerId: string; providerName: string }> = [],
  options: { respond?: () => Promise<unknown>; missingApi?: boolean } = {}) {
  const file = 'src/renderer/src/components/models/ToolCallingPanel.tsx'
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let initializer: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'runSmoke') initializer = node.initializer
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(initializer, 'execute the production click handler without booting Electron or React')
  const requests: unknown[] = [], statuses: string[] = [], messages: string[] = [], views: unknown[] = []
  const smokeRunning = { current: false }
  const module = { exports: {} as { runSmoke?: () => Promise<void> } }
  const compiled = ts.transpileModule(`const runSmoke = ${initializer.getText(source)}; module.exports.runSmoke = runSmoke`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(compiled, {
    module, smokeSelection: selection, smokeModels: models, config: { clientAdapterId: 'standard-openai-tools' },
    smokeRunning, toolSmokePresentation, setSmokeView: (value: unknown) => views.push(value),
    setSmokeStatus: (value: string) => statuses.push(value), setSmokeMessage: (value: string) => messages.push(value), t: (key: string) => key,
    window: options.missingApi ? {} : { electronAPI: { toolCalling: { runSmoke: async (input: unknown) => {
      requests.push(JSON.parse(JSON.stringify(input)))
      return options.respond ? options.respond() : { success: false, category: 'parser_failed', message: 'SECRET-RAW-DIAGNOSTIC-FIXTURE' }
    } } } },
  })
  return { run: module.exports.runSmoke!, requests, statuses, messages, views, smokeRunning }
}

test('a stale explicit model selection fails visibly without falling back to an automatic model or invoking IPC', async () => {
  const f = smokeUiFixture('arena/arena/text/model-no-longer-available')
  await f.run()
  assert.deepEqual(f.requests, [])
  assert.deepEqual(f.statuses, ['running', 'blocked'])
  assert.equal(f.smokeRunning.current, false)
  assert.equal(f.messages.at(-1), 'toolCalling.smoke.modelUnavailable')
  for (const language of ['zh-CN', 'en-US']) {
    const locale = JSON.parse(readFileSync(`src/renderer/src/i18n/locales/${language}.json`, 'utf8'))
    assert.ok(locale.toolCalling.smoke.modelUnavailable)
  }
})

test('automatic and valid explicit model selections invoke exactly one IPC test and preserve genuine failure', async () => {
  const model = { model: 'arena/text/model-with-slashes', providerId: 'arena', providerName: 'Arena' }
  for (const selection of ['auto', `${model.providerId}/${model.model}`]) {
    const f = smokeUiFixture(selection, [model])
    await f.run()
    assert.deepEqual(f.requests, [{ clientAdapterId: 'standard-openai-tools', ...(selection === 'auto' ? {} : { model: model.model, providerId: model.providerId }) }])
    assert.deepEqual(f.statuses, ['running', 'failed'])
    assert.equal(f.messages.at(-1), 'toolCalling.smoke.reasons.parser_failed')
    assert.doesNotMatch(JSON.stringify([f.messages, f.views]), /SECRET-RAW-DIAGNOSTIC-FIXTURE/)
  }
})

test('upstream authentication and throttling blockers never claim tool incompatibility or erase an earlier passed stage', async () => {
  for (const upstreamCategory of ['authentication_required', 'captcha_required', 'rate_limited', 'account_cooling_down']) {
    const f = smokeUiFixture('auto', [], { respond: async () => ({ success: false, category: 'provider_or_account_error', upstreamCategory,
      retryAt: 1700000000000, message: 'SECRET-UPSTREAM-RESPONSE', checks: [{ stage: 'tool_call', success: true }, { stage: 'tool_result', success: false }] }) })
    await f.run()
    assert.equal(f.requests.length, 1)
    assert.deepEqual(f.statuses, ['running', 'blocked'])
    assert.equal(f.messages.at(-1), `toolCalling.smoke.reasons.${upstreamCategory}`)
    assert.deepEqual(f.views.at(-1), { status: 'blocked', messageKey: `toolCalling.smoke.reasons.${upstreamCategory}`,
      checks: [{ stage: 'tool_call', success: true }, { stage: 'tool_result', success: false }], retryAt: 1700000000000 })
    assert.doesNotMatch(JSON.stringify([f.messages, f.views]), /SECRET-UPSTREAM-RESPONSE/)
  }
})

test('production smoke click handler blocks same-turn duplicate clicks until completion and releases its lock', async () => {
  let resolve!: (value: unknown) => void
  const pending = new Promise<unknown>(yes => { resolve = yes })
  const f = smokeUiFixture('auto', [], { respond: () => pending })
  const first = f.run()
  await f.run(); await f.run()
  assert.equal(f.requests.length, 1)
  assert.deepEqual(f.statuses, ['running'])
  assert.equal(f.smokeRunning.current, true)
  resolve({ success: true, category: 'pass', message: 'RAW-SUCCESS-REPLY', checks: [{ stage: 'tool_call', success: true }, { stage: 'tool_result', success: true }] })
  await first
  assert.equal(f.smokeRunning.current, false)
  assert.deepEqual(f.statuses, ['running', 'pass'])
  assert.equal(f.messages.at(-1), 'toolCalling.smoke.reasons.passed')
  assert.doesNotMatch(JSON.stringify([f.messages, f.views]), /RAW-SUCCESS-REPLY/)
})

test('unavailable or rejected IPC produces a visible blocked verdict and never auto-retries', async () => {
  for (const options of [{ missingApi: true }, { respond: async () => { throw new Error('SECRET-IPC-ERROR') } }]) {
    const f = smokeUiFixture('auto', [], options)
    await f.run()
    assert.deepEqual(f.statuses, ['running', 'blocked'])
    assert.equal(f.smokeRunning.current, false)
    assert.equal(f.requests.length, options.missingApi ? 0 : 1)
    assert.doesNotMatch(JSON.stringify([f.messages, f.views]), /SECRET-IPC-ERROR/)
    assert.ok(f.messages.at(-1)?.endsWith('unavailable'))
  }
})
