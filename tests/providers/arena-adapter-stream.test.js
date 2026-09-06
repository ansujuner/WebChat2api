const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const { resolve, dirname } = require('node:path')
const { Readable, PassThrough } = require('node:stream')
const vm = require('node:vm')
const ts = require('typescript')

// All code paths below use a mocked browser manager and in-memory byte streams.
function modules(browser = { chat: async () => { throw new Error('No browser access in tests') } }) {
  const cache = new Map()
  function load(file) {
    const filename = resolve(__dirname, '../..', file)
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const { outputText } = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
    vm.runInNewContext(outputText, {
      module, exports: module.exports, Buffer, TextDecoder, setTimeout, clearTimeout, AbortController,
      console: { log() {}, warn() {}, error() {} },
      require(name) {
        if (name.endsWith('/arena/browserManager')) return { arenaBrowserManager: browser }
        if (!name.startsWith('.')) return require(name)
        const target = resolve(dirname(filename), name)
        return load(existsSync(target) && target.endsWith('.ts') ? target : existsSync(`${target}.ts`) ? `${target}.ts` : `${target}/index.ts`)
      },
    }, { filename })
    return module.exports
  }
  return { ...load('src/main/proxy/adapters/arena.ts'), ...load('src/main/proxy/adapters/arena-stream.ts'),
    ...load('src/main/arena/protocol.ts') }
}

const MODEL = '019b24bb-5caf-71c3-b854-37d0c7086f21'
const SESSION = 'cf89c240-bdfb-4e7b-a674-682f18c435af'
const conversation = { id: SESSION, modelId: MODEL, modality: 'text' }
const state = { sessionId: SESSION, extras: { modelId: MODEL, modality: 'text' } }
const account = { id: 'fixture-account', credentials: { browserProfileId: 'fixture-profile', token: 'SECRET-unused-token' } }
const plain = value => JSON.parse(JSON.stringify(value))
const line = (code, value) => `a${code}:${JSON.stringify(value)}\n`
const finished = reason => line('d', { finishReason: reason || 'stop' })
const byteStream = text => Readable.from([...Buffer.from(text)].map(value => Buffer.from([value])))
async function collect(handler, input) {
  const stream = await handler.handleStream(input)
  let text = '', error
  try { for await (const chunk of stream) text += chunk.toString() } catch (failure) { error = failure }
  const chunks = text.split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)))
  return { text, error, chunks }
}

test('Arena adapter forwards only the exact new prompt and a verified per-conversation identity', async () => {
  const calls = [], states = []
  const { ArenaAdapter } = modules({ chat: async input => { calls.push(input); return { stream: byteStream(line('0', 'reply') + finished()), conversation } } })
  const adapter = new ArenaAdapter({ id: 'arena' }, account)
  const first = { model: MODEL, messages: [{ role: 'user', content: '  你好 😀\n' }], onConversation: value => states.push(value) }
  const snapshot = JSON.stringify(first)
  assert.equal((await adapter.chatCompletion(first)).sessionId, SESSION)
  await adapter.chatCompletion({ model: MODEL, conversation: state, messages: [{ role: 'user', content: '下一句原样输入' }], onConversation: value => states.push(value) })
  assert.equal(JSON.stringify(first), snapshot)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].prompt, '  你好 😀\n')
  assert.equal(calls[0].conversation, undefined)
  assert.equal(calls[1].prompt, '下一句原样输入')
  assert.deepEqual(plain(calls[1].conversation), conversation)
  assert.deepEqual(plain(states), [state, state])
  assert.equal(calls[0].profileId, 'fixture-profile')
  assert.equal(calls[0].accountId, 'fixture-account')
  assert.ok(!JSON.stringify(calls).includes('SECRET-unused-token'))
})

test('Arena tool history uses managed XML and new tool results do not contain prior user text', () => {
  const { arenaMessagesToPrompt } = modules()
  const prompt = arenaMessagesToPrompt([{ role: 'system', content: 'initial rules' }, { role: 'assistant', content: 'checking', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'Read', arguments: '{"file_path":"fixture"}' } }] }])
  assert.ok(prompt.includes('System: initial rules'))
  assert.ok(prompt.includes('checking'))
  assert.ok(prompt.includes('<|CHAT2API|invoke name="Read">'))
  const result = arenaMessagesToPrompt([{ role: 'tool', tool_call_id: 'call1', content: 'mock ]]> result' }])
  assert.ok(result.includes('tool_call_id="call1"'))
  assert.ok(result.includes(']]]]><![CDATA[>'))
  assert.ok(!result.includes('initial rules'))
})

test('Arena validates model, text-only input and continuation binding before browser access', async () => {
  let calls = 0
  const { ArenaAdapter } = modules({ chat: async () => { calls++; throw new Error('must not send') } })
  const adapter = new ArenaAdapter({ id: 'arena' }, account)
  for (const request of [
    { model: 'made-up-model', messages: [{ role: 'user', content: 'hello' }] },
    { model: MODEL, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.org/image.png' } }] }] },
    { model: MODEL, messages: [{ role: 'user', content: 'hello' }], conversation: { sessionId: SESSION } },
    { model: MODEL, messages: [{ role: 'user', content: 'hello' }], conversation: { ...state, extras: { ...state.extras, modality: 'image' } } },
    { model: MODEL, messages: [{ role: 'user', content: ' '.repeat(3) }] },
  ]) await assert.rejects(adapter.chatCompletion(request), error => error.code === 'invalid_request')
  assert.equal(calls, 0)
})

test('Arena account browser errors are safe and no unrelated credentials or browser launch is used', async () => {
  const { ArenaAdapter } = modules({ chat: async () => { throw new Error('SECRET-browser-failure') } })
  const request = { model: MODEL, messages: [{ role: 'user', content: 'hello' }] }
  await assert.rejects(new ArenaAdapter({ id: 'arena' }, account).chatCompletion(request), error => error.code === 'upstream_error' && !error.message.includes('SECRET'))
  await assert.rejects(new ArenaAdapter({ id: 'arena' }, { credentials: { token: 'SECRET' } }).chatCompletion(request), error => error.code === 'browser_unavailable')
})

for (const streaming of [false, true]) {
  test(`Arena ${streaming ? 'stream' : 'JSON'} preserves byte-split UTF-8 and reasoning and reports completion only after terminal EOF`, async () => {
    const { ArenaStreamHandler } = modules()
    const handler = new ArenaStreamHandler('arena/text/max', SESSION, undefined, conversation)
    const states = []
    handler.setConversationListener(value => states.push(value))
    const input = byteStream(line('g', 'reason 😀') + line('0', '你好') + 'b0:"ignored participant"\n' + line('0', ' world 😀') + finished())
    if (streaming) {
      const result = await collect(handler, input)
      assert.equal(result.error, undefined)
      assert.equal(result.chunks.map(chunk => chunk.choices[0].delta.content || '').join(''), '你好 world 😀')
      assert.equal(result.chunks.map(chunk => chunk.choices[0].delta.reasoning_content || '').join(''), 'reason 😀')
      assert.equal(result.chunks.at(-1).choices[0].finish_reason, 'stop')
      assert.equal((result.text.match(/\[DONE\]/g) || []).length, 1)
      assert.ok(!result.text.includes(SESSION))
    } else {
      const result = await handler.handleNonStream(input)
      assert.equal(result.choices[0].message.content, '你好 world 😀')
      assert.equal(result.choices[0].message.reasoning_content, 'reason 😀')
      assert.equal(result.choices[0].finish_reason, 'stop')
      assert.ok(!JSON.stringify(result).includes(SESSION))
    }
    assert.deepEqual(plain(states), [state])
  })
}

for (const [name, raw] of [
  ['truncated response', line('0', 'partial')],
  ['upstream error', line('3', 'SECRET-provider-error')],
  ['malformed JSON', 'a0:not json\n'],
  ['unknown terminal', line('0', 'text') + finished('unknown')],
  ['native tools without converted calls', finished('tool-calls')],
  ['image in text route', line('2', [{ type: 'image', image: 'https://example.org/image.png' }]) + finished()],
  ['post-terminal data', finished() + line('0', 'extra')],
  ['only secondary participant', 'b0:"secondary"\nbd:{"finishReason":"stop"}\n'],
]) {
  test(`Arena rejects ${name} in both output modes without a false final marker`, async () => {
    const { ArenaStreamHandler } = modules()
    let complete = 0
    const handler = new ArenaStreamHandler('arena/text/max', SESSION)
    handler.setConversationListener(() => { complete++ })
    const result = await collect(handler, byteStream(raw))
    assert.ok(result.error)
    assert.ok(!result.text.includes('[DONE]'))
    assert.ok(!result.error.message.includes('SECRET'))
    assert.equal(complete, 0)
    await assert.rejects(new ArenaStreamHandler('arena/text/max', SESSION).handleNonStream(byteStream(raw)))
  })
}

test('Arena streaming client cancellation aborts the browser-owned source', async () => {
  const { ArenaStreamHandler } = modules()
  const source = new PassThrough()
  const output = await new ArenaStreamHandler('arena/text/max', SESSION).handleStream(source)
  output.destroy()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(source.destroyed, true)
})

test('Arena safely propagates network errors and terminates already ended input', async () => {
  const { ArenaStreamHandler } = modules()
  const source = new PassThrough()
  const pending = collect(new ArenaStreamHandler('arena/text/max', SESSION), source)
  source.destroy(new Error('SECRET network failure'))
  const result = await pending
  assert.ok(result.error)
  assert.ok(!result.error.message.includes('SECRET'))
  const ended = new PassThrough()
  ended.resume(); ended.end()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok((await collect(new ArenaStreamHandler('arena/text/max', SESSION), ended)).error)
})

test('Arena managed tool parsing is consistent between streaming and JSON output', async () => {
  const { ArenaStreamHandler } = modules()
  const plan = { mode: 'managed', protocol: 'managed_xml', tools: [{ name: 'Write', parameters: { type: 'object', properties: { content: { type: 'string' } } }, source: 'openai' }], shouldParseResponse: true, shouldInjectPrompt: true }
  const xml = '<|CHAT2API|tool_calls><|CHAT2API|invoke name="Write"><|CHAT2API|parameter name="content"><![CDATA[true]]></|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>'
  const raw = line('0', xml) + finished()
  const streamed = await collect(new ArenaStreamHandler('arena/text/max', SESSION, plan), byteStream(raw))
  assert.equal(streamed.error, undefined)
  const call = streamed.chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls || [])[0]
  const result = await new ArenaStreamHandler('arena/text/max', SESSION, plan).handleNonStream(byteStream(raw))
  assert.deepEqual(plain(call.function), plain(result.choices[0].message.tool_calls[0].function))
  assert.deepEqual(JSON.parse(call.function.arguments), { content: 'true' })
  assert.equal(result.choices[0].message.tool_calls[0].rawText, undefined)
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(streamed.chunks.at(-1).choices[0].finish_reason, 'tool_calls')
})
