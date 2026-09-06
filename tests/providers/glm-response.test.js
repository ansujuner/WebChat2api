const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const { Readable, PassThrough } = require('node:stream')
const root = path.resolve(__dirname, '../..')
function load(file, imports = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    { module, exports: module.exports, Buffer, TextDecoder, setTimeout, clearTimeout, console: { log() {}, error() {} },
      require(name) { if (Object.hasOwn(imports, name)) return imports[name]; assert.ok(!name.startsWith('.'), `Unmocked dependency ${name}`); return require(name) } }, { filename: file })
  return module.exports
}
function fixture(options = {}) {
  const calls = [], rejectedBody = new PassThrough()
  const api = load('src/main/proxy/adapters/glm.ts', {
    axios: { default: { post: async (url, body) => {
      calls.push(url)
      if (url.endsWith('/user/refresh')) return options.refresh ?? { status: 200, data: { code: 0, result: { access_token: 'FIXTURE-ACCESS', refresh_token: 'FIXTURE-REFRESH' } } }
      return { status: options.status ?? 200, headers: options.headers ?? {}, data: rejectedBody }
    } } },
    crypto: { default: require('node:crypto') },
    '../../store/store': { storeManager: { rotateAccountCredentials() { assert.fail('No token rotation in this fixture') } } },
    '../utils/tools': { hasToolPromptInjected: () => false, toolsToSystemPrompt: () => '', TOOL_WRAP_HINT: '' },
    '../utils/toolParser': { parseToolCallsFromText: content => ({ content, toolCalls: [] }) },
    '../utils/streamToolHandler': { createBaseChunk: (id, model, created) => ({ id, model, created, object: 'chat.completion.chunk' }) },
    '../toolCalling/providerProfiles': { getProviderToolProfile: () => ({}) },
    '../toolCalling/ToolStreamParser': {},
    './glm-model-options.ts': load('src/main/proxy/adapters/glm-model-options.ts'),
  })
  const adapter = new api.GLMAdapter({ id: 'glm', apiEndpoint: 'https://fixture.invalid' }, { id: 'fixture-account', credentials: { refresh_token: 'FIXTURE-REFRESH' } })
  return { ...api, calls, rejectedBody, request: () => adapter.chatCompletion({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'fixture input' }] }) }
}
const part = (text, logic_id = 1, think) => ({ logic_id, status: 'finish', content: [
  ...(think ? [{ type: 'think', think }] : []), { type: 'text', text },
] })
const event = (status, parts) => ({ conversation_id: 'fixture-conversation', status, ...(parts ? { parts } : {}) })
function sse(events) {
  const data = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  return Readable.from(Array.from(data, (_, index) => data.subarray(index, index + 1)))
}
async function consume(api, events, streaming) {
  const handler = new api.GLMStreamHandler('glm-5.3-flash')
  if (!streaming) {
    const result = await handler.handleNonStream(sse(events))
    return { content: result.choices[0].message.content, reasoning: result.choices[0].message.reasoning_content || '', reason: result.choices[0].finish_reason }
  }
  let output = ''
  for await (const chunk of await handler.handleStream(sse(events))) output += String(chunk)
  assert.equal((output.match(/data: \[DONE\]/g) || []).length, 1)
  const chunks = output.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)))
  assert.equal(chunks.filter(chunk => chunk.choices[0].finish_reason).length, 1)
  return { content: chunks.map(chunk => chunk.choices[0].delta.content || '').join(''), reasoning: chunks.map(chunk => chunk.choices[0].delta.reasoning_content || '').join(''), reason: chunks.at(-1).choices[0].finish_reason }
}

test('GLM HTTP rejection preserves typed 401/403/429 status and destroys the unread response without exposing request/response data', async () => {
  for (const [status, code] of [[401, 'authentication_required'], [403, 'action_required'], [429, 'rate_limited'], [503, 'upstream_error']]) {
    const f = fixture({ status, headers: { 'retry-after': '27', secret: 'PRIVATE-HEADER' } })
    await assert.rejects(f.request(), error => {
      assert.equal(error.status, status)
      assert.ok(error instanceof f.GLMUpstreamError)
      assert.equal(error.code, code)
      if (status === 429) assert.equal(error.retryAfter, 27)
      assert.doesNotMatch(JSON.stringify(error) + error.message, /PRIVATE|FIXTURE-ACCESS|FIXTURE-REFRESH|Authorization|config|headers|response/)
      return true
    })
    assert.equal(f.calls.length, 2); assert.equal(f.rejectedBody.destroyed, true)
  }
})

test('GLM token refresh rejection keeps HTTP classification and never echoes a remote error or submits a chat', async () => {
  for (const status of [401, 403, 429, 200]) {
    const f = fixture({ refresh: { status, headers: { 'retry-after': '9' }, data: { code: 9, message: 'PRIVATE-TOKEN-ERROR', result: { token: 'PRIVATE-TOKEN' } } } })
    await assert.rejects(f.request(), error => {
      assert.equal(error.status, status === 200 ? 502 : status)
      assert.ok(error instanceof f.GLMUpstreamError)
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE/)
      return true
    })
    assert.equal(f.calls.length, 1)
  }
})

test('GLM typed errors allow only bounded numeric HTTP and retry metadata', () => {
  const { GLMUpstreamError } = fixture()
  for (const status of [undefined, 200, 399, 600, NaN, Infinity, '401']) assert.equal(new GLMUpstreamError(status).status, 502)
  for (const retryAfter of ['0', '-1', '1.5', '604801', '999999999', 'PRIVATE-TOKEN', ['27'], 27, {}, null]) {
    const error = new GLMUpstreamError(429, retryAfter)
    assert.equal(error.retryAfter, undefined)
    assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE-TOKEN/)
  }
  assert.equal(new GLMUpstreamError(429, '604800').retryAfter, 604800)
})

for (const streaming of [false, true]) {
  test(`GLM ${streaming ? 'stream' : 'non-stream'} retains text and reasoning contained only in the finish event`, async () => {
    const result = await consume(fixture(), [event('finish', [part('终帧答案', 1, '思考')])], streaming)
    assert.deepEqual(result, { content: '终帧答案', reasoning: '思考', reason: 'stop' })
  })
  test(`GLM ${streaming ? 'stream' : 'non-stream'} applies terminal snapshots and new parts without repeating prior content`, async () => {
    for (const [events, content] of [
      [[event('processing', [part('答')]), event('finish', [part('答案')])], '答案'],
      [[event('processing', [part('答案')]), event('finish', [part('答案')])], '答案'],
      [[event('processing', [part('答案')]), event('finish', [part('补充', 2)])], '答案\n补充'],
      [[event('processing', [part('答')]), event('processing', [part('答案')]), event('finish', [part('答案'), part('补充', 2)])], '答案\n补充'],
    ]) assert.deepEqual(await consume(fixture(), events, streaming), { content, reasoning: '', reason: 'stop' })
    assert.deepEqual(await consume(fixture(), [event('processing', [part('答', 1, '思')]), event('finish', [part('答案', 1, '思考')]), event('finish', [part('重复')])], streaming),
      { content: '答案', reasoning: '思考', reason: 'stop' })
  })
  test(`GLM ${streaming ? 'stream' : 'non-stream'} still rejects EOF or upstream error before the finish marker`, async () => {
    for (const events of [[event('processing', [part('partial')])], [event('processing', [part('partial')]), event('error')]]) {
      await assert.rejects(consume(fixture(), events, streaming), /completion marker|upstream error/)
    }
  })
}
