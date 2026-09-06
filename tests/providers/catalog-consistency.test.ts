import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { builtinProviders } from '../../src/main/providers/builtin/index.ts'
import { BUILTIN_PROVIDERS } from '../../src/main/store/types.ts'

const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))

test('store startup catalog and provider registry share one source of truth', () => {
  assert.equal(BUILTIN_PROVIDERS, builtinProviders)
  assert.equal(new Set(builtinProviders.map(provider => provider.id)).size, 10)
})

test('current reasoning max level is preserved through request and log type boundaries', () => {
  for (const path of [
    '../../src/main/proxy/types.ts',
    '../../src/main/store/types.ts',
    '../../src/renderer/src/types/electron.d.ts',
    '../../src/renderer/src/components/logs/RequestLogDetail.tsx',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /reasoning(?:Effort|_effort)\?:[^\n]*'max'/, path)
  }
})

for (const provider of builtinProviders) {
  test(`${provider.id}: all advertised models have unique, nonempty mappings and locale entries`, () => {
    const models = provider.supportedModels ?? []
    assert.ok(provider.id === 'arena' ? models.length === 0 : models.length > 0)
    assert.equal(new Set(models).size, models.length)
    for (const model of models) {
      assert.equal(model, model.trim())
      assert.ok(provider.modelMappings?.[model]?.trim(), model)
    }
    for (const locale of ['zh-CN', 'en-US']) {
      const labels = readJson(`../../src/renderer/src/i18n/locales/${locale}.json`)[provider.id].models || {}
      assert.deepEqual(Object.keys(labels).sort(), [...models].sort(), `${provider.id} ${locale}`)
    }
  })
}

test('Qwen international catalog exactly matches the current public web endpoint', () => {
  const evidence = readJson('../../docs/providers/evidence/qwen-ai-models-2026-09-06.json')
  const provider = builtinProviders.find(provider => provider.id === 'qwen-ai')!
  assert.equal(evidence.status, 200)
  assert.deepEqual(provider.modelMappings, Object.fromEntries(evidence.models.map(model => [model.name, model.id])))
  assert.deepEqual(provider.supportedModels, evidence.models.map(model => model.name))
})

test('domestic Qwen defaults map only to visible model codes from its own web catalog', () => {
  const evidence = readJson('../../docs/providers/evidence/qwen-models-2026-09-06.json')
  const provider = builtinProviders.find(provider => provider.id === 'qwen')!
  assert.deepEqual(Object.values(provider.modelMappings!), evidence.models.filter(model => model.show).map(model => model.modelCode))
})

test('Z.ai advertised display names resolve to exact current web IDs including opaque Flash ID', () => {
  const evidence = readJson('../../docs/providers/evidence/zai-models-2026-09-06.json')
  const provider = builtinProviders.find(provider => provider.id === 'zai')!
  for (const model of provider.supportedModels!) {
    const current = evidence.models.find(item => item.name === model && item.active)
    assert.ok(current, model)
    assert.equal(provider.modelMappings?.[model], current.id)
  }
  assert.equal(provider.modelMappings?.['GLM-5.3-Flash'], 'x-preview-l')
})

test('GLM configured models match chat-enabled entries, not the separate API catalog', () => {
  const evidence = readJson('../../docs/providers/evidence/glm-models-2026-09-06.json')
  const provider = builtinProviders.find(provider => provider.id === 'glm')!
  assert.deepEqual(
    Object.values(provider.modelMappings!).sort(),
    evidence.models.filter(model => model.chat_switch).map(model => model.selected_model).sort(),
  )
})
