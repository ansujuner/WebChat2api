import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { Readable } from 'node:stream'

import { zaiConfig } from '../../src/main/providers/builtin/zai.ts'
import { glmConfig } from '../../src/main/providers/builtin/glm.ts'
import { mimoConfig } from '../../src/main/providers/builtin/mimo.ts'
import { DEFAULT_ZAI_WEB_MODEL, isZaiThinkingRequired, resolveZaiWebModel } from '../../src/main/proxy/adapters/zai-model-options.ts'
import { MimoAdapter, MimoStreamHandler, resolveMimoModelConfig } from '../../src/main/proxy/adapters/mimo.ts'
import { DEFAULT_GLM_ASSISTANT_ID, resolveGlmModelOptions } from '../../src/main/proxy/adapters/glm-model-options.ts'

const readEvidence = (name: string) => JSON.parse(readFileSync(
  new URL(`../../docs/providers/evidence/${name}-models-2026-09-06.json`, import.meta.url),
  'utf8',
).replace(/^\uFEFF/, ''))

test('GLM current models resolve to the website selected_model rather than ignored labels', () => {
  const evidence = readEvidence('glm')
  assert.deepEqual(glmConfig.supportedModels, ['GLM-5.3-Flash', 'GLM-5.3'])
  for (const model of glmConfig.supportedModels ?? []) {
    const actualModel = glmConfig.modelMappings![model]
    const captured = evidence.models.find((entry: any) => entry.selected_model === actualModel)
    assert.equal(captured?.chat_switch, true)
    assert.equal(resolveGlmModelOptions({ model }).selectedModel, captured.selected_model)
    assert.equal(resolveGlmModelOptions({ model: actualModel }).selectedModel, captured.selected_model)
  }
  assert.equal(glmConfig.modelMappings![glmConfig.supportedModels![0]], evidence.defaults.guest)
  assert.equal(glmConfig.modelMappings?.['GLM-5.1'], undefined)
  assert.equal(resolveGlmModelOptions({ model: 'GLM-Flash' }).selectedModel, 'glm-5.3-flash')
  const source = readFileSync(new URL('../../src/main/proxy/adapters/glm.ts', import.meta.url), 'utf8')
  assert.match(source, /resolveGlmModelOptions\(request\)/)
  assert.match(source, /meta_data:\s*\{\s*channel: '',\s*chat_mode: chatMode,\s*selected_model: selectedModel/)
  assert.doesNotMatch(source, /if_plus_model: true/)
})

test('GLM current reasoning levels follow the available_models web effort values', () => {
  const evidence = readEvidence('glm')
  const captured = evidence.models.find((entry: any) => entry.selected_model === 'glm-5.3')
  for (const effort of ['low', 'high', 'max'] as const) {
    assert.equal(
      resolveGlmModelOptions({ model: 'glm-5.3', reasoning_effort: effort }).chatMode,
      captured.reasoning_efforts.find((entry: any) => entry.am_effort === effort).effort,
    )
  }
  assert.equal(resolveGlmModelOptions({ model: 'glm-5.3', reasoning_effort: 'medium' }).chatMode, 'thinking')
  const request = Object.freeze({ model: 'glm-5.3-flash', reasoning_effort: 'max' as const, web_search: true })
  assert.deepEqual(resolveGlmModelOptions(request), {
    assistantId: DEFAULT_GLM_ASSISTANT_ID, selectedModel: 'glm-5.3-flash', chatMode: 'deep_thinking', isNetworking: true,
  })
  assert.equal(resolveGlmModelOptions({ ...request, deep_research: true }).chatMode, 'deep_research')
  assert.equal(request.reasoning_effort, 'max')
})

test('GLM explicit assistant IDs and legacy modes remain distinct from current model IDs', () => {
  const assistantId = '65a232c082ff90a2ad2f15e2'
  assert.deepEqual(resolveGlmModelOptions({ model: assistantId, reasoning_effort: 'high' }), {
    assistantId, selectedModel: undefined, chatMode: 'zero', isNetworking: false,
  })
  assert.equal(resolveGlmModelOptions({ model: 'custom-CaseSensitive-model' }).selectedModel, 'custom-CaseSensitive-model')
})

test('Z.ai advertised models match the current public web model catalog, not paid API IDs', () => {
  const evidence = readEvidence('zai')
  assert.deepEqual(zaiConfig.supportedModels, [
    'GLM-5.3-Flash', 'GLM-5.3', 'GLM-5.2', 'GLM-5-Turbo', 'GLM-5V-Turbo', 'GLM-4.7',
  ])
  for (const model of zaiConfig.supportedModels ?? []) {
    const actualModel = zaiConfig.modelMappings?.[model]
    const captured = evidence.models.find((entry: any) => entry.name === model)
    assert.equal(captured?.active, true, model)
    assert.equal(actualModel, captured.id, model)
    assert.equal(resolveZaiWebModel(model), actualModel)
    assert.equal(resolveZaiWebModel(model.toLowerCase()), actualModel)
    assert.equal(resolveZaiWebModel(actualModel!), actualModel)
  }
  assert.equal(DEFAULT_ZAI_WEB_MODEL, 'x-preview-l')
  assert.equal(zaiConfig.modelMappings?.['GLM-5.3-Flash'], 'x-preview-l')
  assert.equal(zaiConfig.modelMappings?.['GLM-5.1'], undefined)
  assert.equal(zaiConfig.modelMappings?.['GLM-5'], undefined)
})

test('Z.ai new models preserve mandatory thinking while explicit custom IDs are not renamed', () => {
  const evidence = readEvidence('zai')
  for (const model of ['GLM-5.3-Flash', 'x-preview-l', 'GLM-5.3', 'glm-5.3']) {
    assert.equal(isZaiThinkingRequired(model), true)
    assert.equal(evidence.models.find((entry: any) => entry.id === resolveZaiWebModel(model)).capabilities.skip_think, false)
  }
  assert.equal(isZaiThinkingRequired('GLM-5.2'), false)
  assert.equal(resolveZaiWebModel('my-CaseSensitive-model'), 'my-CaseSensitive-model')
  assert.equal(resolveZaiWebModel('constructor'), 'constructor')
  assert.equal(resolveZaiWebModel('GLM-5.1'), 'GLM-5.1')
  assert.equal(resolveZaiWebModel('GLM-5'), 'glm-5')
  const source = readFileSync(new URL('../../src/main/proxy/adapters/zai.ts', import.meta.url), 'utf8')
  assert.match(source, /const mappedModel = resolveZaiWebModel\(request\.model\)/)
  assert.match(source, /model: mappedModel/)
  assert.match(source, /isZaiThinkingRequired\(mappedModel\)/)
  assert.match(source, /const X_FE_VERSION = 'prod-fe-1\.1\.93'/)
  assert.equal(zaiConfig.headers['X-FE-Version'], 'prod-fe-1.1.93')
})

test('MiMo exposes only supported chat models and applies captured Studio defaults', () => {
  const evidence = readEvidence('mimo')
  assert.deepEqual(mimoConfig.supportedModels, ['MiMo-V2.5-Pro', 'MiMo-V2.5'])
  assert.equal(mimoConfig.modelMappings?.['MiMo-V2-Flash'], undefined)
  for (const model of mimoConfig.supportedModels ?? []) {
    const actualModel = mimoConfig.modelMappings![model]
    const captured = evidence.models.find((entry: any) => entry.model === actualModel)
    const options = resolveMimoModelConfig({ model: actualModel })
    assert.equal(options.model, captured.model)
    assert.equal(options.enableThinking, captured.thinkingDefaultOn)
    assert.equal(options.webSearchStatus, captured.webSearchDefaultStatus)
    assert.equal(options.temperature, captured.temperature)
    assert.equal(options.topP, captured.topP)
  }
})

test('MiMo options honor explicit settings without mutating a frozen request', () => {
  const request = Object.freeze({ model: 'MiMo-V2.5', reasoning_effort: false, web_search: false, temperature: 0 })
  assert.deepEqual(resolveMimoModelConfig(request), {
    model: 'mimo-v2.5', enableThinking: false, webSearchStatus: 'disabled', temperature: 0, topP: 0.95,
  })
  assert.equal(request.model, 'MiMo-V2.5')
  assert.equal(resolveMimoModelConfig({ model: 'Custom-ID', reasoning_effort: 'high', web_search: true }).model, 'Custom-ID')
})

test('MiMo default thinking stream matches non-stream output at every think-tag split', async () => {
  const toEvents = (parts: string[]) => [...parts.map(content => `event: message\ndata: ${JSON.stringify({ content })}\n\n`), 'event: finish\ndata: {}\n\n']
  for (const endTag of ['</think>', '</thinkgt;']) {
    const fullText = `<think>reason${endTag}answer`
    const expected = JSON.parse(await new MimoStreamHandler('mimo-v2.5-pro', 'fixture', 'separate')
      .handleNonStream(Readable.from(toEvents([fullText])))).choices[0].message
    const cases = [
      ...Array.from({ length: fullText.length - 1 }, (_, index) => [fullText.slice(0, index + 1), fullText.slice(index + 1)]),
      [...fullText],
    ]
    for (const parts of cases) {
      const handler = new MimoStreamHandler('mimo-v2.5-pro', 'fixture', 'separate')
      let content = ''
      let reasoning = ''
      for await (const chunk of handler.handleStream(Readable.from(toEvents(parts)))) {
        if (chunk.includes('data: [DONE]')) continue
        const delta = JSON.parse(chunk.slice(6)).choices[0].delta
        content += delta.content ?? ''
        reasoning += delta.reasoning_content ?? ''
      }
      assert.equal(content, expected.content, JSON.stringify(parts))
      assert.equal(reasoning, expected.reasoning_content, JSON.stringify(parts))
    }
  }
})

test('MiMo V2.5 mappings and defaults reach actual HTTP requests against a local fixture', async (t) => {
  const requests: Array<{ path: string; data: any }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push({ path: request.url!, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
    if (request.url === '/open-apis/chat/conversation/save') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 0 }))
    } else if (request.url === '/open-apis/bot/chat') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end('event: message\ndata: {"content":"local fixture"}\n\nevent: finish\ndata: {}\n\n')
    } else {
      response.writeHead(404)
      response.end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const adapter = new MimoAdapter(mimoConfig as any, {
    credentials: { service_token: 'fixture-only', user_id: 'fixture-user', ph_token: 'fixture-only' },
  } as any)
  // Redirect every adapter request to this ephemeral server; never use a live account.
  t.mock.method(adapter as any, 'buildUrl', (path: string) => `${origin}${path}`)
  for (const model of mimoConfig.supportedModels ?? []) {
    const result = await adapter.chatCompletion({
      model: mimoConfig.modelMappings![model], messages: [{ role: 'user', content: 'fixture request' }], stream: true,
    })
    let output = ''
    for await (const chunk of result.response.data) output += chunk.toString()
    assert.match(output, /local fixture/)
    const sent = requests.at(-1)!
    assert.equal(sent.path, '/open-apis/bot/chat')
    assert.equal(sent.data.query, 'fixture request')
    assert.deepEqual(sent.data.modelConfig, resolveMimoModelConfig({ model: mimoConfig.modelMappings![model] }))
    assert.equal(sent.data.conversationId, result.conversationId)
  }
  assert.equal(requests.length, 4)
})
