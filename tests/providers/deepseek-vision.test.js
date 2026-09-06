const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function load(name, overrides = {}, globals = {}) {
  const filename = resolve(__dirname, '../../src/main/proxy/adapters', name)
  const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  })
  const module = { exports: {} }
  vm.runInNewContext(outputText, {
    module, exports: module.exports, Buffer, setTimeout, clearTimeout,
    console: { log() {}, warn() {}, error() {} },
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name),
    ...globals,
  }, { filename })
  return module.exports
}

const images = load('deepseek-images.ts')
const options = load('providerModelOptions.ts')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7ioAAAAASUVORK5CYII='
const IMAGE_URL = `data:image/png;base64,${PNG}`
const imageBlock = (url = IMAGE_URL) => ({ type: 'image_url', image_url: { url } })
const plain = value => JSON.parse(JSON.stringify(value))
const envelope = biz_data => ({ status: 200, data: { code: 0, data: { biz_code: 0, biz_data } } })

function setup(settings = {}) {
  const calls = []
  let time = 1000
  let sequence = 0
  class Clock extends Date { static now() { return time } }
  const axios = {
    async get(url, config) {
      calls.push({ url, config })
      if (url.endsWith('/users/current')) return envelope({ token: 'fixture-access' })
      assert.ok(url.endsWith('/file/fetch_files'))
      return settings.pollResult || envelope({ files: [{ id: 'file-fixture', status: settings.pollStatus || 'SUCCESS' }] })
    },
    async post(url, body, config) {
      calls.push({ url, body, config })
      if (url.endsWith('/create_pow_challenge')) return envelope({ challenge: {
        algorithm: 'DeepSeekHashV1', challenge: 'fixture-challenge', salt: 'fixture-salt',
        signature: 'fixture-proof', difficulty: 1, expire_at: 9999999999,
      } })
      if (url.endsWith('/file/upload_file')) return settings.uploadResult || envelope({ id: 'file-fixture', status: settings.uploadStatus || 'SUCCESS' })
      if (url.endsWith('/chat_session/create')) return envelope({ chat_session: { id: `session-${++sequence}` } })
      assert.ok(url.endsWith('/chat/completion'))
      return { status: 200, data: 'stream-fixture' }
    },
  }
  const { DeepSeekAdapter } = load('deepseek.ts', {
    './deepseek-restrictions': load('deepseek-restrictions.ts'),
    axios: { default: axios }, './deepseek-images': images,
    './providerModelOptions': options,
    '../../lib/challenge': { getDeepSeekHash: async () => ({ calculateHash: () => 1 }) },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
  }, { Date: Clock, setTimeout: callback => { time += 3000; queueMicrotask(callback) } })
  const adapter = new DeepSeekAdapter({ id: 'deepseek' }, { credentials: { token: 'fixture-account' } })
  return { adapter, calls }
}

function request(overrides = {}) {
  return {
    model: 'deepseek-v4-flash-vision-exp',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What number is shown?' }, imageBlock()] }],
    ...overrides,
  }
}

test('DeepSeek validates image bytes and constructs real multipart file contents', () => {
  const image = images.decodeDeepSeekImage(IMAGE_URL)
  assert.equal(image.mime, 'image/png')
  assert.equal(image.extension, 'png')
  assert.ok(image.bytes.equals(Buffer.from(PNG, 'base64')))
  const multipart = images.createDeepSeekImageMultipart(image)
  assert.match(multipart.contentType, /^multipart\/form-data; boundary=----Chat2API/)
  assert.match(multipart.body.toString(), /name="file"; filename="image.png"/)
  assert.ok(multipart.body.includes(image.bytes))
  assert.ok(!multipart.body.includes(Buffer.from(IMAGE_URL)))
})

for (const [name, url] of [
  ['HTTP URL', 'http://127.0.0.1/private'],
  ['HTTPS URL', 'https://example.org/picture.png'],
  ['file URL', 'file:///private.png'],
  ['SVG', 'data:image/svg+xml;base64,PHN2Zy8+'],
  ['false MIME', `data:image/jpeg;base64,${PNG}`],
  ['malformed base64', 'data:image/png;base64,AAAA!'],
  ['empty bytes', 'data:image/png;base64,'],
  ['truncated signature', 'data:image/png;base64,iVBORw0KGgo='],
]) {
  test(`DeepSeek rejects ${name} before any authenticated request`, async () => {
    const { adapter, calls } = setup()
    await assert.rejects(adapter.chatCompletion(request({ messages: [{ role: 'user', content: [imageBlock(url)] }] })))
    assert.equal(calls.length, 0)
  })
}

test('DeepSeek bounds image size/count/total bytes before upload', () => {
  assert.throws(() => images.decodeDeepSeekImage(`data:image/png;base64,${'A'.repeat(Math.ceil(images.DEEPSEEK_MAX_IMAGE_BYTES / 3) * 4 + 81)}`), /10 MiB/)
  assert.throws(() => images.collectDeepSeekImages([{ role: 'user', content: Array.from({ length: 11 }, () => imageBlock()) }]), /at most 10/)
  const big = Buffer.alloc(8 * 1024 * 1024)
  Buffer.from(PNG, 'base64').copy(big)
  const bigUrl = `data:image/png;base64,${big.toString('base64')}`
  assert.throws(() => images.collectDeepSeekImages([{ role: 'user', content: Array.from({ length: 3 }, () => imageBlock(bigUrl)) }]), /20 MiB/)
})

test('DeepSeek disallows assistant/system image blocks instead of silently dropping them', () => {
  for (const role of ['assistant', 'system', 'tool']) {
    assert.throws(() => images.collectDeepSeekImages([{ role, content: [imageBlock()] }]), /only in user/)
  }
})

test('DeepSeek image understanding is never silently downgraded to text mode or search', async () => {
  for (const overrides of [{ model: 'deepseek-v4-flash' }, { model: 'deepseek-v4-pro' }, { web_search: true }]) {
    const { adapter, calls } = setup()
    await assert.rejects(adapter.chatCompletion(request(overrides)))
    assert.equal(calls.length, 0)
  }
})

test('DeepSeek uploads bytes using website headers and upload-specific proof then references the returned file ID', async () => {
  const { adapter, calls } = setup()
  const input = request()
  const snapshot = JSON.stringify(input)
  const result = await adapter.chatCompletion(input)
  assert.equal(JSON.stringify(input), snapshot)
  assert.equal(result.sessionId, 'session-1')
  const upload = calls.find(c => c.url.endsWith('/file/upload_file'))
  assert.ok(Buffer.isBuffer(upload.body))
  assert.ok(upload.body.includes(Buffer.from(PNG, 'base64')))
  assert.equal(upload.config.headers['x-model-type'], 'vision')
  assert.equal(upload.config.headers['x-thinking-enabled'], '0')
  assert.equal(upload.config.headers['x-file-size'], String(Buffer.from(PNG, 'base64').length))
  assert.equal(upload.config.maxRedirects, 0)
  assert.equal(JSON.parse(Buffer.from(upload.config.headers['X-Ds-Pow-Response'], 'base64')).target_path, '/api/v0/file/upload_file')
  const completion = calls.find(c => c.url.endsWith('/chat/completion'))
  assert.deepEqual(plain(completion.body.ref_file_ids), ['file-fixture'])
  assert.equal(completion.body.model_type, 'vision')
  assert.equal(completion.body.prompt, 'What number is shown?')
  assert.equal(completion.body.parent_message_id, null)
  assert.equal(JSON.parse(Buffer.from(completion.config.headers['X-Ds-Pow-Response'], 'base64')).target_path, '/api/v0/chat/completion')
})

test('DeepSeek waits for asynchronous file processing and polls only the returned file', async () => {
  const { adapter, calls } = setup({ uploadStatus: 'PARSING' })
  await adapter.chatCompletion(request())
  const polls = calls.filter(c => c.url.endsWith('/file/fetch_files'))
  assert.equal(polls.length, 1)
  assert.equal(polls[0].config.params.file_ids, 'file-fixture')
  assert.ok(calls.indexOf(polls[0]) < calls.findIndex(c => c.url.endsWith('/chat/completion')))
})

test('DeepSeek continuation uploads no old image and keeps the true parent cursor and only new text', async () => {
  const { adapter, calls } = setup()
  await adapter.chatCompletion(request())
  const states = []
  await adapter.chatCompletion(request({
    conversation: { sessionId: 'session-1', parentMessageId: '2' },
    messages: [{ role: 'user', content: 'And what color is it?' }],
    onConversation: state => states.push(state),
  }))
  const completions = calls.filter(c => c.url.endsWith('/chat/completion'))
  assert.equal(calls.filter(c => c.url.endsWith('/file/upload_file')).length, 1)
  assert.equal(calls.filter(c => c.url.endsWith('/chat_session/create')).length, 1)
  assert.equal(completions[1].body.chat_session_id, 'session-1')
  assert.equal(completions[1].body.parent_message_id, 2)
  assert.equal(completions[1].body.prompt, 'And what color is it?')
  assert.deepEqual(plain(completions[1].body.ref_file_ids), [])
  assert.equal(states[0].parentMessageId, '2')
})

for (const [name, settings, expected] of [
  ['HTTP upload failure', { uploadResult: { status: 413 } }, /upload failed/],
  ['business upload failure', { uploadResult: { status: 200, data: { code: 0, data: { biz_code: 9, biz_msg: 'SECRET_REMOTE_TEXT' } } } }, /upload failed/],
  ['missing file ID', { uploadResult: envelope({ status: 'SUCCESS' }) }, /invalid file ID/],
  ['file parse failure', { uploadStatus: 'CONTENT_FILTER' }, /processing failed/],
  ['unknown status', { uploadStatus: 'DONE' }, /processing failed/],
  ['audit rejection', { uploadResult: envelope({ id: 'file-fixture', status: 'SUCCESS', audit_result: 'reject' }) }, /rejected/],
  ['poll failure', { uploadStatus: 'PENDING', pollResult: { status: 500 } }, /status check failed/],
  ['mismatched polled file ID', { uploadStatus: 'PENDING', pollResult: envelope({ files: [{ id: 'other-file', status: 'SUCCESS' }] }) }, /invalid file ID/],
  ['bounded parse timeout', { uploadStatus: 'PENDING', pollStatus: 'PENDING' }, /timed out/],
]) {
  test(`DeepSeek ${name} prevents completion and never retries upload`, async () => {
    const { adapter, calls } = setup(settings)
    await assert.rejects(adapter.chatCompletion(request()), error => expected.test(error.message) && !error.message.includes('SECRET_REMOTE_TEXT'))
    assert.equal(calls.filter(c => c.url.endsWith('/file/upload_file')).length, 1)
    assert.equal(calls.filter(c => c.url.endsWith('/chat/completion')).length, 0)
    assert.equal(calls.filter(c => c.url.endsWith('/chat_session/create')).length, 0)
    assert.ok(calls.length < 30)
  })
}
