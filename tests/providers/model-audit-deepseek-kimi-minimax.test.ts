import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deepseekConfig } from '../../src/main/providers/builtin/deepseek.ts'
import { kimiConfig } from '../../src/main/providers/builtin/kimi.ts'
import { minimaxConfig } from '../../src/main/providers/builtin/minimax.ts'
import {
  createKimiChatPayload,
  encodeKimiGrpcFrame,
  resolveDeepSeekChatOptions,
  resolveKimiScenario,
  resolveKimiWebModel,
  resolveMiniMaxWebModel,
} from '../../src/main/proxy/adapters/providerModelOptions.ts'

test('DeepSeek maps the three verified website selectors without accepting invented vision IDs', () => {
  assert.deepEqual(deepseekConfig.supportedModels, ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'])
  assert.deepEqual(resolveDeepSeekChatOptions({ model: 'deepseek-v4-flash-vision-exp' }), {
    modelType: 'vision', searchEnabled: false, thinkingEnabled: false,
  })
  assert.throws(() => resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro-vision' }), /Unsupported DeepSeek vision model/)
})

test('DeepSeek uses the mapped model for selection and original alias for features', () => {
  const request = Object.freeze({ model: 'deepseek-v4-pro', originalModel: 'my-fast-think-search' })
  assert.deepEqual(resolveDeepSeekChatOptions(request), {
    modelType: 'expert', searchEnabled: true, thinkingEnabled: true,
  })
  assert.deepEqual(resolveDeepSeekChatOptions({ model: 'deepseek-v4-flash', originalModel: 'expert-alias' }), {
    modelType: 'default', searchEnabled: false, thinkingEnabled: false,
  })
})

test('DeepSeek keeps legacy reasoning aliases and max effort without changing web model IDs', () => {
  assert.equal(resolveDeepSeekChatOptions({ model: 'deepseek-v4-flash', originalModel: 'DeepSeek-R1' }).thinkingEnabled, true)
  assert.equal(resolveDeepSeekChatOptions({ model: 'deepseek-v4-pro', reasoning_effort: 'max' }).thinkingEnabled, true)
})

test('Kimi rejects unknown API model IDs instead of silently routing them to K2.5', () => {
  for (const model of ['unknown', 'kimi-k2.60', 'kimi-for-coding', 'k3-256k', 'k3-agent-swarm', '']) {
    assert.throws(() => resolveKimiScenario(model), /Unsupported Kimi web model/)
  }
})

test('Kimi payload matches the captured live model catalog and not an invented K2D6 enum', () => {
  const evidence = JSON.parse(readFileSync(new URL('../../docs/providers/evidence/kimi-models-2026-09-06.json', import.meta.url), 'utf8'))
  const instant = evidence.data.availableModels.find(model => model.key === 'k2d6')
  const k3 = evidence.data.availableModels.find(model => model.key === 'k3')
  assert.equal(resolveKimiScenario('kimi-k2.6'), instant.scenario)
  assert.equal(resolveKimiWebModel('kimi-k2.6'), evidence.data.defaultScenario.model)
  const payload = createKimiChatPayload({ model: 'Kimi-K3', content: 'hello', enableWebSearch: false })
  assert.equal(payload.scenario, k3.scenario)
  assert.equal(payload.kimiplus_id, k3.kimiPlusId)
  assert.equal(payload.options.reasoning_effort, k3.defaultReasoningEffort)
  assert.equal(payload.options.context_length, k3.defaultContextLength)
  assert.equal(payload.options.model, 'k3-agent')
  assert.equal(payload.options.thinking, true)
})

test('Kimi reasoning uses supported web effort levels without silently disabling K3 thinking', () => {
  const options = { content: 'hello', enableWebSearch: false }
  const k3Efforts = { low: 'LOW', medium: 'HIGH', high: 'HIGH', max: 'MAX' } as const
  for (const [effort, expected] of Object.entries(k3Efforts)) {
    const payload = createKimiChatPayload({ ...options, model: 'k3-agent', reasoning_effort: effort as keyof typeof k3Efforts, enableThinking: false })
    assert.equal(payload.options.reasoning_effort, `REASONING_EFFORT_${expected}`)
    assert.equal(payload.options.thinking, true)
  }
  assert.throws(() => createKimiChatPayload({ ...options, model: 'k3-agent', reasoning_effort: 'none' }), /requires thinking/)
  assert.equal(createKimiChatPayload({ ...options, model: 'k2d6-chat' }).options.reasoning_effort, 'REASONING_EFFORT_LOW')
  assert.equal(createKimiChatPayload({ ...options, model: 'k2d6-chat', reasoning_effort: 'none' }).options.reasoning_effort, 'REASONING_EFFORT_NONE')
})

test('every advertised Kimi model has an explicit scenario and valid Connect envelope', () => {
  for (const model of kimiConfig.supportedModels || []) {
    const input = Object.freeze({
      model: kimiConfig.modelMappings?.[model] || model,
      content: '模型核验 😀', enableWebSearch: true, enableThinking: true,
    })
    const payload = createKimiChatPayload(input)
    assert.equal(payload.scenario, resolveKimiScenario(input.model))
    assert.equal(payload.message.scenario, payload.scenario)
    const frame = encodeKimiGrpcFrame(payload)
    assert.equal(frame[0], 0)
    assert.equal(frame.readUInt32BE(1), Buffer.byteLength(JSON.stringify(payload)))
    assert.deepEqual(JSON.parse(frame.subarray(5).toString('utf8')), payload)
  }
})

test('MiniMax advertises only the server-selected Agent route, not a guaranteed M2.7/M3', () => {
  assert.deepEqual(minimaxConfig.supportedModels, ['MiniMax-Agent'])
  assert.equal(minimaxConfig.modelMappings?.['MiniMax-Agent'], 'minimax-agent')
  assert.equal(minimaxConfig.modelMappings?.['MiniMax-M2.7'], 'minimax-agent')
  assert.equal(resolveMiniMaxWebModel('MiniMax-M2.7'), 'MiniMax-Agent')
  assert.equal(resolveMiniMaxWebModel('minimax-agent'), 'MiniMax-Agent')
  assert.equal(resolveMiniMaxWebModel(), 'MiniMax-Agent')
  for (const model of ['MiniMax-M3', 'MiniMax-M2.7-highspeed', 'future-model']) {
    assert.throws(() => resolveMiniMaxWebModel(model), /server-selected Agent route/)
  }
})
