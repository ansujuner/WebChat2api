import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { createVisionFixture } from '../../src/main/diagnostics/visionFixture.ts'
import { probeLocalApp, type LocalProbeDependencies, type LocalProbeOptions } from '../../src/main/diagnostics/localProbe.ts'

const MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'] as const
const SECRET = 'fixture-gateway-secret-not-for-reports'
const MARKER = 'CHAT2API_SMOKE_OK'

// Independent PNG framing/CRC/pixel reader, not a production fixture import.
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
const FONT = [
  '11111/10001/10001/10001/10001/10001/11111',
  '00100/01100/00100/00100/00100/00100/01110',
  '11111/00001/00001/11111/10000/10000/11111',
  '11111/00001/00001/11111/00001/00001/11111',
  '10001/10001/10001/11111/00001/00001/00001',
  '11111/10000/10000/11111/00001/00001/11111',
  '11111/10000/10000/11111/10001/10001/11111',
  '11111/00001/00010/00100/01000/01000/01000',
  '11111/10001/10001/11111/10001/10001/11111',
  '11111/10001/10001/11111/00001/00001/11111',
]
function readImageDigits(dataUrl: string): string {
  assert.ok(dataUrl.startsWith('data:image/png;base64,'))
  const bytes = Buffer.from(dataUrl.split(',')[1], 'base64')
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const chunks: Array<{ type: string; data: Buffer }> = []
  let offset = 8
  while (offset < bytes.length) {
    const size = bytes.readUInt32BE(offset)
    assert.ok(offset + size + 12 <= bytes.length)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + size)
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + size)), bytes.readUInt32BE(offset + 8 + size))
    chunks.push({ type, data })
    offset += size + 12
  }
  assert.equal(offset, bytes.length)
  assert.deepEqual(chunks.map(chunk => chunk.type), ['IHDR', 'IDAT', 'IEND'])
  const header = chunks[0].data
  assert.equal(header.readUInt32BE(0), 256)
  assert.equal(header.readUInt32BE(4), 96)
  assert.deepEqual([...header.subarray(8)], [8, 2, 0, 0, 0])
  assert.equal(chunks[2].data.length, 0)
  const scanlines = inflateSync(chunks[1].data)
  assert.equal(scanlines.length, 96 * (1 + 256 * 3))
  for (let y = 0; y < 96; y++) assert.equal(scanlines[y * 769], 0)
  const pixel = (x: number, y: number) => {
    const p = y * 769 + 1 + x * 3
    assert.equal(scanlines[p], scanlines[p + 1])
    assert.equal(scanlines[p], scanlines[p + 2])
    assert.ok(scanlines[p] === 0 || scanlines[p] === 255)
    return scanlines[p] === 0 ? '1' : '0'
  }
  assert.equal(pixel(0, 0), '0')
  return Array.from({ length: 4 }, (_, digit) => {
    const glyph = Array.from({ length: 7 }, (_, y) => Array.from({ length: 5 }, (_, x) => pixel(16 + digit * 60 + x * 8 + 4, 20 + y * 8 + 4)).join('')).join('/')
    const decoded = FONT.indexOf(glyph)
    assert.notEqual(decoded, -1, 'all four glyphs must be readable from the image pixels')
    return String(decoded)
  }).join('')
}

function fixture(overrides: Partial<LocalProbeDependencies> = {}) {
  const requests: any[] = []
  const config = Object.freeze({ proxyPort: 8080, enableApiKey: true, apiKeys: [{ enabled: true, key: SECRET }] })
  const deps: LocalProbeDependencies = {
    getConfig: () => config,
    getStatus: () => ({ isRunning: true, port: 8081, host: '0.0.0.0' }),
    getProviders: () => [
      { id: 'deepseek', name: 'DeepSeek', enabled: true },
      { id: 'zai', name: 'Z.ai', enabled: true },
      { id: 'glm', name: 'GLM', enabled: true },
    ],
    getEffectiveModels: id => (id === 'deepseek' ? MODELS : ['GLM-other']).map(displayName => ({ displayName })),
    getActiveAccountCount: () => 1,
    request: async options => {
      requests.push(options)
      if (options.path === '/health') return { status: 200, headers: {}, text: '{"status":"running"}' }
      if (options.path === '/v1/models') return { status: 200, headers: {}, text: JSON.stringify({ data: [...MODELS.map(id => ({ id, owned_by: 'DeepSeek' })), { id: 'GLM-other', owned_by: 'Z.ai' }] }) }
      const body = options.body as any
      const content = body.messages[0].content
      const text = Array.isArray(content) ? readImageDigits(content[1].image_url.url) : MARKER
      return { status: 200, headers: { 'x-chat2api-session-id': 'private-session-not-for-report' }, text: JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }) }
    },
    ...overrides,
  }
  return { deps, requests, config }
}

test('vision fixture is a valid PNG with independent CRC and pixel verification for all decimal glyphs', () => {
  for (const expected of ['0123', '4567', '8901', '9999']) {
    const result = createVisionFixture(expected)
    assert.equal(result.expected, expected)
    assert.equal(readImageDigits(result.dataUrl), expected)
  }
  const randomized = createVisionFixture()
  assert.match(randomized.expected, /^[1-9]\d{3}$/)
  assert.equal(readImageDigits(randomized.dataUrl), randomized.expected)
})

test('vision fixture accepts only four decimal digits and contains no answer metadata chunks', () => {
  for (const invalid of ['', '123', '12345', 'a123', '12 3', '../x']) assert.throws(() => createVisionFixture(invalid), /four digits/)
  assert.equal(readImageDigits(createVisionFixture('0000').dataUrl), '0000')
})

for (const model of MODELS) {
  test(`DeepSeek mode probe selects only ${model} without triggering GLM/Z.ai`, async () => {
    const f = fixture()
    const originalConfig = JSON.stringify(f.config)
    const report = await probeLocalApp(f.deps, { live: true, providers: ['deepseek'], deepseekModel: model })
    assert.equal(report.status, 'passed')
    assert.equal(report.providers.length, 1)
    assert.equal(report.providers[0].provider, 'deepseek')
    assert.equal(report.providers[0].model, model)
    const generations = f.requests.filter(request => request.body)
    assert.equal(generations.length, 1)
    assert.equal(generations[0].path, '/v1/chat/completions')
    assert.equal(generations[0].body.model, model)
    assert.equal(generations[0].headers['X-Chat2API-New-Conversation'], 'true')
    assert.equal(generations[0].headers.Authorization, `Bearer ${SECRET}`)
    assert.ok(f.requests.every(request => request.hostname === '127.0.0.1' && request.port === 8081))
    assert.equal(JSON.stringify(f.config), originalConfig)
    assert.doesNotMatch(JSON.stringify(report), /fixture-gateway|private-session|data:image|apiKeys|Authorization|credentials/)
    if (model.endsWith('vision-exp')) {
      const content = generations[0].body.messages[0].content
      assert.equal(content.length, 2)
      assert.equal(content[0].type, 'text')
      assert.equal(content[1].type, 'image_url')
      const expected = readImageDigits(content[1].image_url.url)
      assert.ok(!content[0].text.includes(expected), 'the model must obtain the answer from image pixels, not the prompt')
      assert.doesNotMatch(content[0].text, /\d{4}/)
      assert.equal(report.providers[0].inputImage, true)
      assert.equal(report.providers[0].checks[0].reply, expected)
    } else {
      assert.equal(typeof generations[0].body.messages[0].content, 'string')
      assert.equal(report.providers[0].inputImage, undefined)
    }
  })
}

test('DeepSeek model-specific catalogue probes never generate without live opt-in', async () => {
  for (const model of MODELS) {
    const f = fixture()
    const report = await probeLocalApp(f.deps, { providers: ['deepseek'], deepseekModel: model })
    assert.equal(report.status, 'ready')
    assert.deepEqual(f.requests.map(request => request.path), ['/health', '/v1/models'])
    assert.equal(report.providers[0].inputImage, undefined)
  }
})

test('DeepSeek mode probe refuses unavailable account or missing selected model without fallback', async () => {
  for (const overrides of [
    { getActiveAccountCount: (id: string) => id === 'deepseek' ? 0 : 1 },
    { getEffectiveModels: () => [{ displayName: 'deepseek-v4-flash' }] },
  ]) {
    const f = fixture(overrides)
    const report = await probeLocalApp(f.deps, { live: true, providers: ['deepseek'], deepseekModel: MODELS[2] })
    assert.equal(report.status, 'needs_attention')
    assert.equal(report.providers.length, 1)
    assert.equal(report.providers[0].provider, 'deepseek')
    assert.equal(f.requests.filter(request => request.body).length, 0)
  }
})

test('DeepSeek mode-specific probe rejects arbitrary models/providers/protocol before reading app state', async () => {
  const f = fixture({ getConfig: () => { throw new Error('must not inspect account configuration') } })
  const valid = { live: true, providers: ['deepseek'], deepseekModel: MODELS[0] }
  for (const invalid of [
    { ...valid, deepseekModel: 'unknown-model' },
    { ...valid, deepseekModel: 'deepseek-v4-pro-vision' },
    { ...valid, deepseekModel: 'DEEPSEEK-V4-FLASH' },
    { ...valid, deepseekModel: 'deepseek-v4-flash-search' },
    { ...valid, providers: ['zai'] },
    { ...valid, providers: ['deepseek', 'zai'] },
    { ...valid, protocol: 'anthropic' },
    { ...valid, protocol: 'unsupported' },
    { ...valid, deepseekModel: 1 },
  ]) await assert.rejects(probeLocalApp(f.deps, invalid as LocalProbeOptions), /invalid_probe_options/)
  assert.equal(f.requests.length, 0)
})

test('vision probe redacts incorrect arbitrary replies and never retries failed image recognition', async () => {
  const f = fixture()
  const normalRequest = f.deps.request!
  f.deps.request = async options => {
    if (!options.body) return normalRequest(options)
    f.requests.push(options)
    return { status: 200, headers: {}, text: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'SECRET arbitrary provider reply' }, finish_reason: 'stop' }] }) }
  }
  const report = await probeLocalApp(f.deps, { live: true, providers: ['deepseek'], deepseekModel: MODELS[2], turns: 2 })
  assert.equal(report.status, 'needs_attention')
  assert.equal(report.providers[0].checks[0].error, 'unexpected_reply')
  assert.equal(f.requests.filter(request => request.body).length, 1)
  assert.doesNotMatch(JSON.stringify(report), /SECRET|data:image/)
})
