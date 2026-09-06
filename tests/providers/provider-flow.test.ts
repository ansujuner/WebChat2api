import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { deepseekConfig } from '../../src/main/providers/builtin/deepseek.ts'
import { glmConfig } from '../../src/main/providers/builtin/glm.ts'
import { kimiConfig } from '../../src/main/providers/builtin/kimi.ts'
import { minimaxConfig } from '../../src/main/providers/builtin/minimax.ts'
import { mimoConfig } from '../../src/main/providers/builtin/mimo.ts'
import { perplexityConfig } from '../../src/main/providers/builtin/perplexity.ts'
import { qwenConfig } from '../../src/main/providers/builtin/qwen.ts'
import { qwenAiConfig } from '../../src/main/providers/builtin/qwen-ai.ts'
import { zaiConfig } from '../../src/main/providers/builtin/zai.ts'
import {
  DEEPSEEK_PRIMARY_MODELS,
  DEFAULT_DEEPSEEK_MODEL_MAPPINGS,
  LEGACY_DEEPSEEK_AUTO_MODEL_MAPPINGS,
  createDefaultModelMappings,
  isDefaultModelMapping,
  normalizeModelMappingsWithDefaults,
  sanitizeDeepSeekModelOverrides,
} from '../../src/main/store/types.ts'
import {
  createKimiChatPayload,
  encodeKimiGrpcFrame,
  resolveDeepSeekChatOptions,
  resolveKimiScenario,
} from '../../src/main/proxy/adapters/providerModelOptions.ts'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('DeepSeek exposes exactly three official models without auto-created feature aliases', () => {
  assert.deepEqual(DEEPSEEK_PRIMARY_MODELS, ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'])
  assert.deepEqual(deepseekConfig.supportedModels, DEEPSEEK_PRIMARY_MODELS)
  assert.deepEqual(deepseekConfig.modelMappings, {
    'deepseek-v4-flash': 'deepseek-v4-flash',
    'deepseek-v4-pro': 'deepseek-v4-pro',
    'deepseek-v4-flash-vision-exp': 'deepseek-v4-flash-vision-exp',
  })

  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-flash' }),
    { modelType: 'default', searchEnabled: false, thinkingEnabled: false },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro' }),
    { modelType: 'expert', searchEnabled: false, thinkingEnabled: false },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro-think-search' }),
    { modelType: 'expert', searchEnabled: true, thinkingEnabled: true },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-flash-search' }),
    { modelType: 'default', searchEnabled: true, thinkingEnabled: false },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-reasoner' }),
    { modelType: 'default', searchEnabled: false, thinkingEnabled: true },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'DeepSeek-R1-Search' }),
    { modelType: 'default', searchEnabled: true, thinkingEnabled: true },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro', web_search: true, reasoning_effort: 'high' }),
    { modelType: 'expert', searchEnabled: true, thinkingEnabled: true },
  )
  assert.deepEqual(
    resolveDeepSeekChatOptions({ model: 'deepseek-v4-flash' }, 'please use deep thinking if helpful'),
    { modelType: 'default', searchEnabled: false, thinkingEnabled: false },
  )
})

test('DeepSeek persisted model overrides are migrated away from old built-in aliases', () => {
  assert.deepEqual(
    sanitizeDeepSeekModelOverrides({
      addedModels: [
        { displayName: 'deepseek-v4-flash-search', actualModelId: 'deepseek-v4-flash' },
        { displayName: 'DeepSeek-R1', actualModelId: 'deepseek-v4-flash' },
        { displayName: 'custom-deepseek-web', actualModelId: 'custom-upstream-model' },
        { displayName: 'my-flash-alias', actualModelId: 'deepseek-v4-flash' },
      ],
      excludedModels: ['DeepSeek-R1', 'deepseek-v4-flash'],
    }),
    {
      addedModels: [
        { displayName: 'custom-deepseek-web', actualModelId: 'custom-upstream-model' },
        { displayName: 'my-flash-alias', actualModelId: 'deepseek-v4-flash' },
      ],
      excludedModels: ['deepseek-v4-flash'],
    },
  )

  const storeSource = readFileSync(
    join(root, 'src/main/store/store.ts'),
    'utf8',
  )

  assert.match(storeSource, /p\.id === 'deepseek'/)
  assert.match(storeSource, /sanitizeDeepSeekModelOverrides/)
  assert.match(storeSource, /supportedModels: builtinConfig\.supportedModels/)
  assert.match(storeSource, /modelMappings: builtinConfig\.modelMappings/)
})

test('DeepSeek feature aliases are retained only as migration evidence and never seeded', () => {
  assert.deepEqual(DEFAULT_DEEPSEEK_MODEL_MAPPINGS, {})
  assert.deepEqual(createDefaultModelMappings(), {})
  assert.deepEqual(Object.keys(LEGACY_DEEPSEEK_AUTO_MODEL_MAPPINGS), [
    'deepseek-v4-flash-think',
    'deepseek-v4-flash-search',
    'deepseek-v4-flash-think-search',
    'deepseek-v4-pro-think',
    'deepseek-v4-pro-search',
    'deepseek-v4-pro-think-search',
  ])
  assert.deepEqual(LEGACY_DEEPSEEK_AUTO_MODEL_MAPPINGS['deepseek-v4-flash-think'], {
    requestModel: 'deepseek-v4-flash-think',
    actualModel: 'deepseek-v4-flash',
    preferredProviderId: 'deepseek',
  })
  assert.deepEqual(LEGACY_DEEPSEEK_AUTO_MODEL_MAPPINGS['deepseek-v4-pro-search'], {
    requestModel: 'deepseek-v4-pro-search',
    actualModel: 'deepseek-v4-pro',
    preferredProviderId: 'deepseek',
  })
  assert.equal(DEFAULT_DEEPSEEK_MODEL_MAPPINGS['deepseek-chat'], undefined)
  assert.equal(DEFAULT_DEEPSEEK_MODEL_MAPPINGS['deepseek-reasoner'], undefined)
  assert.equal(DEFAULT_DEEPSEEK_MODEL_MAPPINGS['DeepSeek-R1'], undefined)
  assert.equal(DEFAULT_DEEPSEEK_MODEL_MAPPINGS['DeepSeek-R1-Search'], undefined)
})

test('migration removes only recognized old defaults and preserves deliberate custom retargeting', () => {
  assert.equal(isDefaultModelMapping('deepseek-v4-flash-search'), false)
  assert.equal(isDefaultModelMapping('deepseek-chat'), false)

  assert.deepEqual(
    normalizeModelMappingsWithDefaults({
      ...LEGACY_DEEPSEEK_AUTO_MODEL_MAPPINGS,
      'deepseek-v4-flash-search': {
        requestModel: 'deepseek-v4-flash-search',
        actualModel: 'tampered',
        preferredProviderId: 'custom',
      },
      'custom-alias': {
        requestModel: 'custom-alias',
        actualModel: 'deepseek-v4-flash',
      },
    }),
    {
      'deepseek-v4-flash-search': {
        requestModel: 'deepseek-v4-flash-search',
        actualModel: 'tampered',
        preferredProviderId: 'custom',
      },
      'custom-alias': {
        requestModel: 'custom-alias',
        actualModel: 'deepseek-v4-flash',
      },
    },
  )
})

test('DeepSeek migration does not reseed aliases and returns independent mapping objects', () => {
  const first = createDefaultModelMappings()
  first['custom'] = { requestModel: 'custom', actualModel: 'mutated' }
  assert.deepEqual(createDefaultModelMappings(), {})

  const storeSource = readFileSync(
    join(root, 'src/main/store/store.ts'),
    'utf8',
  )

  assert.match(storeSource, /initializeDefaultModelMappings\(\)/)
  assert.match(storeSource, /normalizeModelMappingsWithDefaults/)
  assert.doesNotMatch(storeSource, /modelMappings:\s*this\.normalizeModelMappings\(rawConfig\.modelMappings\)/)
})

test('DeepSeek provider config uses Web 2.0 browser headers', () => {
  assert.equal(deepseekConfig.headers['X-App-Version'], '2.0.0')
  assert.equal(deepseekConfig.headers['X-Client-Version'], '2.0.0')
  assert.equal(deepseekConfig.headers['X-Client-Locale'], 'zh_CN')
  assert.match(deepseekConfig.headers['User-Agent'], /Chrome\/148\.0\.0\.0/)
  assert.match(deepseekConfig.headers['Sec-Ch-Ua'], /Chromium";v="148/)
})

test('GLM, Kimi, and MiniMax expose verified web selections rather than API-only labels', () => {
  assert.deepEqual(glmConfig.supportedModels, ['GLM-5.3-Flash', 'GLM-5.3'])
  assert.deepEqual(glmConfig.modelMappings, { 'GLM-5.3-Flash': 'glm-5.3-flash', 'GLM-5.3': 'glm-5.3' })
  assert.deepEqual(kimiConfig.supportedModels, ['Kimi-K3', 'Kimi-K2.6'])
  assert.deepEqual(kimiConfig.modelMappings, { 'Kimi-K3': 'k3-agent', 'Kimi-K2.6': 'k2d6-chat' })
  assert.deepEqual(minimaxConfig.supportedModels, ['MiniMax-Agent'])
  assert.equal(minimaxConfig.modelMappings?.['MiniMax-Agent'], 'minimax-agent')
  const adapter = readFileSync(join(root, 'src/main/proxy/adapters/minimax.ts'), 'utf8')
  assert.match(adapter, /resolveMiniMaxWebModel/)
  assert.equal(minimaxConfig.modelMappings?.['MiniMax-M3'], undefined)
})

test('Kimi K2.6 model mapping reaches the web chat request payload', () => {
  assert.deepEqual(kimiConfig.supportedModels, ['Kimi-K3', 'Kimi-K2.6'])
  assert.equal(kimiConfig.modelMappings?.['Kimi-K2.6'], 'k2d6-chat')
  assert.equal(resolveKimiScenario('kimi-k2.6'), 'SCENARIO_K2D5')
  assert.equal(resolveKimiScenario('kimi-k2.5'), 'SCENARIO_K2D5')

  const payload = createKimiChatPayload({
    model: 'kimi-k2.6',
    content: 'hello',
    enableWebSearch: true,
    enableThinking: true,
  })

  assert.equal(payload.scenario, 'SCENARIO_K2D5')
  assert.equal(payload.message.scenario, 'SCENARIO_K2D5')
  assert.deepEqual(payload.tools, [{ type: 'TOOL_TYPE_SEARCH', search: {} }])
  assert.equal(payload.options.thinking, true)
  assert.equal(payload.options.model, 'k2d6-chat')
  assert.equal(payload.options.reasoning_effort, 'REASONING_EFFORT_LOW')

  const frame = encodeKimiGrpcFrame(payload)
  assert.equal(frame.readUInt8(0), 0)
  assert.equal(frame.readUInt32BE(1), frame.length - 5)
  assert.equal(JSON.parse(frame.subarray(5).toString('utf8')).scenario, 'SCENARIO_K2D5')
})

test('Kimi and domestic Qwen support account-level chat cleanup', () => {
  const handlersSource = readFileSync(join(root, 'src/main/ipc/handlers.ts'), 'utf8')
  const accountListSource = readFileSync(join(root, 'src/renderer/src/components/providers/AccountList.tsx'), 'utf8')
  const kimiAdapterSource = readFileSync(join(root, 'src/main/proxy/adapters/kimi.ts'), 'utf8')
  const qwenAdapterSource = readFileSync(join(root, 'src/main/proxy/adapters/qwen.ts'), 'utf8')

  assert.match(handlersSource, /import \{ KimiAdapter \} from '\.\.\/proxy\/adapters\/kimi'/)
  assert.match(handlersSource, /import \{ QwenAdapter \} from '\.\.\/proxy\/adapters\/qwen'/)
  assert.match(handlersSource, /kimi: async \(provider, account\) => new KimiAdapter\(provider, account\)\.deleteAllChats\(\)/)
  assert.match(handlersSource, /qwen: async \(provider, account\) => new QwenAdapter\(provider, account\)\.deleteAllChats\(\)/)
  assert.match(accountListSource, /providerId === 'kimi'/)
  assert.match(accountListSource, /providerId === 'qwen'/)

  assert.match(kimiAdapterSource, /async deleteAllChats\(\): Promise<boolean>/)
  assert.match(kimiAdapterSource, /kimi\.chat\.v1\.ChatService\/ListChats/)
  assert.match(kimiAdapterSource, /kimi\.chat\.v1\.ChatService\/BatchDeleteChats/)
  assert.match(kimiAdapterSource, /chat_ids/)

  assert.match(qwenAdapterSource, /async deleteAllChats\(\): Promise<boolean>/)
  assert.match(qwenAdapterSource, /api\/v2\/session\/page\/list/)
  assert.match(qwenAdapterSource, /api\/v1\/session\/delete\/batch/)
  assert.match(qwenAdapterSource, /api\/v2\/file\/record\/delete/)
  assert.match(qwenAdapterSource, /session_ids/)
  assert.match(qwenAdapterSource, /sessionIds/)
})

test('domestic Qwen models match the current visible website catalog', () => {
  const expectedMappings = { 'Qwen3.7': 'Qwen', 'Qwen3.8-Max': 'Qwen3.8-Max', 'Qwen3.7-Max': 'Qwen3.7-Max', 'Qwen3.6-Flash': 'Qwen3.6-Flash' }
  assert.deepEqual(qwenConfig.supportedModels, Object.keys(expectedMappings))
  assert.deepEqual(qwenConfig.modelMappings, expectedMappings)
  for (const locale of ['zh-CN', 'en-US']) {
    const data = JSON.parse(readFileSync(join(root, 'src/renderer/src/i18n/locales', locale + '.json'), 'utf8'))
    assert.deepEqual(data.qwen.models, expectedMappings)
  }
})

test('Qwen AI defaults match the public Studio catalog, not historic or API-only models', () => {
  assert.deepEqual(qwenAiConfig.supportedModels, ['Qwen3.7-Plus', 'Qwen3.8-Max'])
  assert.deepEqual(qwenAiConfig.modelMappings, { 'Qwen3.7-Plus': 'qwen3.7-plus', 'Qwen3.8-Max': 'qwen3.8-max' })
  for (const removed of ['Qwen3.7-Max', 'Qwen3.6-Plus', 'Qwen3-Coder', 'Qwen3.7-Max-Preview']) {
    assert.equal(qwenAiConfig.modelMappings?.[removed], undefined)
  }
})

test('Z.ai default models match current web IDs and frontend version', () => {
  const expected = { 'GLM-5.3-Flash': 'x-preview-l', 'GLM-5.3': 'glm-5.3', 'GLM-5.2': 'glm-5.2', 'GLM-5-Turbo': 'GLM-5-Turbo', 'GLM-5V-Turbo': 'GLM-5v-Turbo', 'GLM-4.7': 'glm-4.7' }
  assert.deepEqual(zaiConfig.supportedModels, Object.keys(expected))
  assert.deepEqual(zaiConfig.modelMappings, expected)
  const adapter = readFileSync(join(root, 'src/main/proxy/adapters/zai.ts'), 'utf8')
  assert.match(adapter, /resolveZaiWebModel/)
  assert.match(adapter, /runZaiWebsiteChat/)
  assert.doesNotMatch(adapter, /FAKE_HEADERS|generateSignature|axios\.post/)
})

test('Chinese and English READMEs document the website transport without equating login with liveness', () => {
  const readmeCn = readFileSync(join(root, 'README.md'), 'utf8')
  const readmeEn = readFileSync(join(root, 'README_EN.md'), 'utf8')
  const doc = readFileSync(join(root, 'docs/providers/zai.md'), 'utf8')

  assert.match(readmeCn, /Z\.ai[^\n]*账号独立网页[^\n]*网页登录成功不等于测活通过/)
  assert.match(readmeEn, /Z\.ai[^\n]*account-owned website session[^\n]*sign-in alone is not a successful liveness check/)
  for (const readme of [readmeCn, readmeEn]) {
    assert.match(readme, /FRONTEND_CAPTCHA_REQUIRED/)
    assert.ok(readme.includes('docs/providers/zai.md'))
  }
  assert.match(doc, /当前状态 \| v1\.6\.4 账号网页通道/)
  assert.match(doc, /FRONTEND_CAPTCHA_REQUIRED/)
  assert.match(doc, /captcha_verify_param.*调试字段/)
})

test('provider guides cover the updated default catalog and verification boundaries', () => {
  for (const provider of [deepseekConfig, glmConfig, kimiConfig, minimaxConfig, mimoConfig, perplexityConfig, qwenConfig, qwenAiConfig, zaiConfig]) {
    const doc = readFileSync(join(root, 'docs/providers', provider.id + '.md'), 'utf8')
    assert.ok(doc.includes(provider.id), provider.id)
    assert.match(doc, /默认模型|Default models/)
    for (const model of provider.supportedModels!) assert.ok(doc.includes(model), provider.id + ': ' + model)
  }
})

test('README provider links cover defaults without duplicating catalogs or claiming free Perplexity access', () => {
  for (const path of ['README.md', 'README_EN.md']) {
    const readme = readFileSync(join(root, path), 'utf8')
    for (const provider of [deepseekConfig, glmConfig, kimiConfig, minimaxConfig, mimoConfig, perplexityConfig, qwenConfig, qwenAiConfig, zaiConfig]) {
      assert.ok(readme.includes(`docs/providers/${provider.id}.md`), provider.id)
    }
    assert.ok(readme.includes('docs/providers/arena.md'))
    assert.match(readme, /Perplexity.*(?:订阅|plan)/)
  }
  assert.equal(perplexityConfig.modelMappings?.Auto, 'turbo')
  assert.equal(perplexityConfig.modelMappings?.Best, 'turbo')
})

test('Mimo model names and conversation flow match Xiaomi AI Studio web requests', () => {
  assert.deepEqual(mimoConfig.supportedModels, ['MiMo-V2.5-Pro', 'MiMo-V2.5'])
  assert.equal(mimoConfig.modelMappings?.['MiMo-V2.5-Pro'], 'mimo-v2.5-pro')
  assert.equal(mimoConfig.modelMappings?.['MiMo-V2.5'], 'mimo-v2.5')
  assert.equal(mimoConfig.modelMappings?.['MiMo-V2-Flash'], undefined)

  const forwarderSource = readFileSync(
    join(root, 'src/main/proxy/forwarder.ts'),
    'utf8',
  )
  const forwardMimoStart = forwarderSource.indexOf('private async forwardMimo')
  const forwardMimoEnd = forwarderSource.indexOf('private async forwardPerplexity')
  const forwardMimoSource = forwarderSource.slice(forwardMimoStart, forwardMimoEnd)

  assert.match(forwardMimoSource, /model:\s*actualModel/)
  assert.doesNotMatch(forwardMimoSource, /model:\s*request\.model/)
  assert.match(forwardMimoSource, /const transformed = this\.transformRequestForPromptToolUse\(request, provider\)/)
  assert.match(forwardMimoSource, /messages:\s*transformedRequest\.messages/)
  assert.match(forwardMimoSource, /new MimoStreamHandler\(actualModel, conversationId, 'separate', transformed\.plan\)/)
  assert.match(forwardMimoSource, /this\.applyToolCallsToResponse\(.*transformed/s)

  const mimoAdapterSource = readFileSync(
    join(root, 'src/main/proxy/adapters/mimo.ts'),
    'utf8',
  )

  assert.match(mimoAdapterSource, /open-apis\/chat\/conversation\/save/)
  assert.match(mimoAdapterSource, /open-apis\/chat\/conversation\/genTitle/)
  assert.match(mimoAdapterSource, /async deleteSession\(conversationId: string\)/)
  assert.match(mimoAdapterSource, /await this\.deleteConversations\(\[conversationId\]\)/)
  assert.match(mimoAdapterSource, /await this\.saveConversation\([^)]*conversationId/)
  assert.match(forwardMimoSource, /await adapter\.generateConversationTitle\(/)
  assert.match(forwardMimoSource, /handler\.getAssistantContentForTitle\(\)/)
  assert.match(forwardMimoSource, /const deleteSessionCallback = shouldDeleteSession\(request\)/)
  assert.match(forwardMimoSource, /await deleteSessionCallback\(conversationId\)/)
})

test('Add provider dialog uses IPC built-in providers instead of duplicated model templates', () => {
  const source = readFileSync(
    join(root, 'src/renderer/src/components/providers/AddProviderDialog.tsx'),
    'utf8',
  )

  assert.match(source, /const providers = builtinProviders/)
  assert.doesNotMatch(source, /DEFAULT_BUILTIN_PROVIDERS/)
  assert.doesNotMatch(source, /supportedModels:\s*\[/)
  assert.doesNotMatch(source, /DeepSeek-V3\.2|DeepSeek-R1|deepseek-reasoner|Kimi-K2\.5|MiniMax-M2\.5/)
})

test('built-in model reset restores source defaults instead of stale persisted provider models', () => {
  const source = readFileSync(
    join(root, 'src/main/store/store.ts'),
    'utf8',
  )

  assert.doesNotMatch(source, /shouldUseBuiltinModels/)
  assert.match(source, /supportedModels: builtinConfig\.supportedModels/)
  assert.match(source, /modelMappings: builtinConfig\.modelMappings/)
  assert.match(source, /resetModels\(providerId: string\): EffectiveModel\[\][\s\S]*BUILTIN_PROVIDERS\.find/)
  assert.match(source, /resetModels\(providerId: string\): EffectiveModel\[\][\s\S]*this\.store!\.set\('providers', providers\)/)
})

test('DeepSeek locale model labels only describe primary provider models', () => {
  const zh = readFileSync(join(root, 'src/renderer/src/i18n/locales/zh-CN.json'), 'utf8')
  const en = readFileSync(join(root, 'src/renderer/src/i18n/locales/en-US.json'), 'utf8')
  const zhData = JSON.parse(zh)
  const enData = JSON.parse(en)

  assert.deepEqual(zhData.deepseek.models, {
    'deepseek-v4-flash': '快速 · DeepSeek V4 Flash',
    'deepseek-v4-pro': '专家 · DeepSeek V4 Pro',
    'deepseek-v4-flash-vision-exp': '视觉 · DeepSeek V4 Flash Vision Exp',
  })
  assert.deepEqual(enData.deepseek.models, {
    'deepseek-v4-flash': 'Fast · DeepSeek V4 Flash',
    'deepseek-v4-pro': 'Expert · DeepSeek V4 Pro',
    'deepseek-v4-flash-vision-exp': 'Vision · DeepSeek V4 Flash Vision Exp',
  })
  assert.equal('DeepSeek-R1' in zhData.deepseek.models, false)
  assert.equal('deepseek-reasoner' in enData.deepseek.models, false)
})

test('forwarder delegates managed tool transformation to ToolCallingEngine', () => {
  const source = readFileSync(
    join(root, 'src/main/proxy/forwarder.ts'),
    'utf8',
  )

  assert.match(source, /import \{ ToolCallingEngine \} from '\.\/toolCalling\/ToolCallingEngine'/)
  assert.match(source, /engine\.transformRequest\(/)
  assert.match(source, /engine\.applyNonStreamResponse\(result, transformed\.plan\)/)
  assert.doesNotMatch(source, /promptInjectionService\.process\(/)
  assert.doesNotMatch(source, /transformMCPToolProtocol\(/)
  assert.doesNotMatch(source, /generateToolPrompt\(/)
  assert.match(source, /tools: transformed\.tools/)
  assert.match(source, /messages: transformed\.messages/)
})

test('forwarder reads toolCallingConfig and does not use legacy prompt config for P0 tool calls', () => {
  const source = readFileSync(
    join(root, 'src/main/proxy/forwarder.ts'),
    'utf8',
  )

  assert.match(source, /toolCallingConfig/)
  assert.match(source, /new ToolCallingEngine\(/)
  assert.doesNotMatch(source, /toolPromptConfig\.defaultFormat/)
  assert.doesNotMatch(source, /promptInjectionService\.process\(/)
})

test('built-in provider sync keeps credential field updates on existing providers', () => {
  const source = readFileSync(
    join(root, 'src/main/store/store.ts'),
    'utf8',
  )

  assert.match(source, /credentialFields: builtinConfig\.credentialFields/)
})

test('DeepSeek forwarder preserves requested model aliases for response parsing semantics', () => {
  const source = readFileSync(
    join(root, 'src/main/proxy/forwarder.ts'),
    'utf8',
  )

  assert.match(source, /new DeepSeekStreamHandler\(\s*actualModel,[\s\S]*transformed\.plan,\s*request\.model\s*\)/)
})

test('active source no longer exposes DS2API or DSML tool protocol markers', () => {
  const activeFiles = [
    'src/main/proxy/toolCalling/ToolCallingEngine.ts',
    'src/main/proxy/toolCalling/providerProfiles.ts',
    'src/main/proxy/toolCalling/protocols/managedXml.ts',
    'src/renderer/src/pages/Models.tsx',
  ]

  for (const file of activeFiles) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.doesNotMatch(source, /DS2API|DSML/i, file)
  }
})

test('tool calling UI copy hides internal managed protocol ids', () => {
  const localeFiles = [
    'src/renderer/src/i18n/locales/zh-CN.json',
    'src/renderer/src/i18n/locales/en-US.json',
  ]

  for (const file of localeFiles) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.doesNotMatch(source, /managed_xml/, file)
  }
})
