const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { Readable } = require('node:stream')
const vm = require('node:vm')
const ts = require('typescript')
const { ToolStreamParser } = require('../../src/main/proxy/toolCalling/ToolStreamParser.ts')
const { ToolCallingEngine } = require('../../src/main/proxy/toolCalling/ToolCallingEngine.ts')
const { buildToolCallingRuntimePlan } = require('../../src/main/proxy/toolCalling/runtimePlan.ts')
const { managedXmlProtocol } = require('../../src/main/proxy/toolCalling/protocols/managedXml.ts')
const { DEFAULT_TOOL_CALLING_CONFIG } = require('../../src/shared/toolCalling.ts')

// Actual provider decoders + shared schema-aware streaming parser. Only transport,
// timers and unrelated legacy parsers are replaced, never the tested tool parser.
function evaluate(relative, imports = {}) {
  const filename = join(__dirname, '../../src/main/proxy', relative)
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Buffer, Error, AbortController, URLSearchParams,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: callback => setImmediate(callback), clearTimeout: clearImmediate,
    global: { storeManager: { getConfig: () => ({}) } },
    require: name => Object.hasOwn(imports, name) ? imports[name] : name.startsWith('.') ? {} : require(name),
  })
  return module.exports
}
const legacy = { parseToolCallsFromText() { assert.fail('the unscoped legacy parser must not execute when a plan is supplied') } }
const helpers = evaluate('utils/streamToolHandler.ts', {
  './toolParser': legacy, './toolParser/index': { createStreamState() { assert.fail('the managed path must not create legacy state') } },
  '../toolCalling/ToolStreamParser': { ToolStreamParser },
})
const imports = {
  '../utils/streamToolHandler': helpers, '../utils/toolParser': legacy,
  '../promptToolUse': { hasToolUse() { assert.fail('no second unscoped parser') }, parseToolUse() { assert.fail('no second unscoped parser') } },
  axios: { create: () => ({ request() { assert.fail('no network') } }) },
  './providerModelOptions': { resolveMiniMaxWebModel: () => 'fixture-model' },
}
const Zai = evaluate('adapters/zai.ts', imports).ZaiStreamHandler
const QwenAi = evaluate('adapters/qwen-ai.ts', imports).QwenAiStreamHandler
const Perplexity = evaluate('adapters/perplexity-stream.ts', imports).PerplexityStreamHandler
const MiniMax = evaluate('adapters/minimax.ts', imports).MiniMaxAdapter
const tools = [{ name: 'fixture_echo', source: 'openai', parameters: { type: 'object', properties: {
  text: { type: 'string' }, values: { type: 'array', items: { type: 'integer' } },
}, required: ['text', 'values'], additionalProperties: false } }]
const plan = (providerId, disabled = false) => buildToolCallingRuntimePlan({ providerId,
  config: { ...DEFAULT_TOOL_CALLING_CONFIG, ...(disabled ? { enabled: false, mode: 'off' } : {}) },
  clientRequest: { tools, toolChoice: { mode: 'auto' }, clientAdapterId: 'standard-openai-tools', toolSource: 'openai' },
})
const envelope = (text = 'true', values = [1]) => managedXmlProtocol.formatAssistantToolCalls([
  { id: 'fixture-id', name: 'fixture_echo', arguments: JSON.stringify({ text, values }) },
])
const event = value => `data: ${JSON.stringify(value)}\n\n`
const collect = async stream => { let result = ''; for await (const chunk of stream) result += chunk.toString(); return result }
const frames = text => text.split('\n\n').filter(Boolean).map(frame => frame.slice(6)).filter(data => data !== '[DONE]').map(JSON.parse)
const fragments = text => Array.from({ length: Math.ceil(text.length / 7) }, (_, i) => text.slice(i * 7, (i + 1) * 7))

async function streamFor(provider, text, disabled = false, completed = true, nonstream = false) {
  const runtimePlan = plan(provider, disabled)
  const pieces = fragments(text)
  if (provider === 'minimax') {
    const adapter = new MiniMax({ id: 'minimax' }, { credentials: { token: 'fixture-only' } })
    if (nonstream) {
      adapter.requestDeviceInfo = async () => ({})
      adapter.request = async (_method, path, body) => path.endsWith('/send_msg')
        ? { status: 200, data: { base_resp: { status_code: 0 }, chat_id: 'fixture-chat', msg_id: 'fixture-user' } }
        : { status: 200, data: { base_resp: { status_code: 0 }, chat: { chat_status: 2 },
          messages: [{ msg_type: 1, msg_id: 'fixture-user' }, { msg_type: 2, msg_id: 'fixture-assistant', msg_content: text }] } }
      return (await adapter.chatCompletion({ model: 'fixture-model', messages: [{ role: 'user', content: 'fixture' }],
        stream: false, retainConversation: true, toolCallingPlan: runtimePlan })).response.data
    }
    let polls = 0
    adapter.request = async () => {
      polls++
      return { status: 200, data: { base_resp: { status_code: 0 }, chat: { chat_status: completed && polls >= pieces.length ? 2 : 1 },
        messages: [{ msg_type: 1, msg_id: 'fixture-user' }, { msg_type: 2, msg_id: 'fixture-assistant', msg_content: pieces.slice(0, polls).join('') }] } }
    }
    return adapter.createPollingStream('fixture-chat', {}, 'fixture-model', 'fixture-user', undefined, undefined, runtimePlan)
  }
  let handler, data
  if (provider === 'zai') {
    handler = new Zai('fixture-model', undefined, runtimePlan)
    handler.setChatId('fixture-chat')
    data = pieces.map(delta_content => event({ type: 'chat:completion', data: { role: 'assistant', id: 'fixture-assistant', phase: 'answer', delta_content } })).join('')
    if (completed) data += event({ type: 'chat:completion', data: { phase: 'done', done: true } })
  } else if (provider === 'qwen-ai') {
    handler = new QwenAi('fixture-model', undefined, runtimePlan)
    handler.setChatId('fixture-chat')
    data = event({ 'response.created': { response_id: 'fixture-assistant' } }) + pieces.map(content => event({ choices: [{ delta: { phase: 'answer', status: 'streaming', content } }] })).join('')
    if (completed) data += event({ choices: [{ delta: { phase: 'answer', status: 'finished', content: '' } }] })
  } else {
    handler = new Perplexity('fixture-model', 'fixture-chat', undefined, undefined, runtimePlan)
    data = pieces.map((_, index) => event({ blocks: [{ diff_block: { field: 'markdown_block', patches: [{ path: '/answer', value: pieces.slice(0, index + 1).join('') }] } }] })).join('')
    if (completed) data += 'data: [DONE]\n\n'
  }
  // Split UTF-8 network packets independently from model text fragments.
  const bytes = Buffer.from(data)
  const packets = Array.from({ length: Math.ceil(bytes.length / 11) }, (_, i) => bytes.subarray(i * 11, (i + 1) * 11))
  return nonstream ? handler.handleNonStream(Readable.from(packets)) : handler.handleStream(Readable.from(packets))
}

for (const provider of ['zai', 'qwen-ai', 'perplexity', 'minimax']) {
  for (const [label, text, disabled, expectedCalls] of [
    ['declared XML call', envelope('你好 true <tag>'), false, 1],
    ['disabled tool parsing', envelope(), true, 0],
    ['undeclared XML call', envelope().replace('fixture_echo', 'unauthorized_fixture'), false, 0],
    ['fenced XML example', `\`\`\`xml\n${envelope()}\n\`\`\``, false, 0],
  ]) test(`${provider} nonstream ${label} is schema-checked once after collection`, async () => {
    const result = await streamFor(provider, text, disabled, true, true)
    assert.equal(result.choices[0].message.content, text, 'adapter preserves raw content until the declared plan is applied')
    assert.equal(result.choices[0].message.tool_calls, undefined)
    new ToolCallingEngine().applyNonStreamResponse(result, plan(provider, disabled))
    const calls = result.choices[0].message.tool_calls || []
    assert.equal(calls.length, expectedCalls)
    if (expectedCalls) assert.deepEqual(JSON.parse(calls[0].function.arguments), { text: '你好 true <tag>', values: [1] })
    else assert.equal(result.choices[0].message.content, text)
  })
  test(`${provider} streams managed XML as declared native tool_calls once, preserving strings and [1] arrays`, async () => {
    const output = await collect(await streamFor(provider, envelope('你好 true <tag>')))
    const chunks = frames(output)
    const calls = chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls || [])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].function.name, 'fixture_echo')
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { text: '你好 true <tag>', values: [1] })
    assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.finish_reason === 'tool_calls').length, 1)
    assert.equal((output.match(/data: \[DONE\]/g) || []).length, 1)
    assert.equal(chunks.map(chunk => chunk.choices?.[0]?.delta?.content || '').join(''), '')
  })
  for (const [label, text, disabled] of [
    ['disabled configuration', envelope(), true],
    ['undeclared tool', envelope().replace('fixture_echo', 'unauthorized_fixture'), false],
    ['fenced example', `\`\`\`xml\n${envelope()}\n\`\`\``, false],
  ]) test(`${provider} never executes ${label}`, async () => {
    const output = await collect(await streamFor(provider, text, disabled))
    const chunks = frames(output)
    assert.equal(chunks.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls || []).length, 0)
    assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.finish_reason === 'tool_calls').length, 0)
    assert.match(output, /data: \[DONE\]/)
    assert.ok(chunks.map(chunk => chunk.choices?.[0]?.delta?.content || '').join('').includes('CHAT2API'))
  })
  test(`${provider} incomplete upstream stream never produces a successful terminal response`, async () => {
    const output = await streamFor(provider, envelope(), false, false)
    let seen = ''
    output.on('data', chunk => { seen += chunk.toString() })
    await assert.rejects(collect(output))
    assert.doesNotMatch(seen, /data: \[DONE\]/)
  })
}

test('managed bridge preserves native tool order and mixed text without parsing a tool result as a new call', () => {
  const state = helpers.createToolCallState(plan('zai'))
  const base = helpers.createBaseChunk('fixture', 'fixture', 1)
  const input = `before${envelope('one')}between${envelope('two')}after`
  const chunks = fragments(input).flatMap(fragment => helpers.processStreamContent(fragment, state, base, false).chunks)
    .concat(helpers.flushToolCallBuffer(state, base))
  const calls = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls || [])
  assert.deepEqual(calls.map(call => call.index), [0, 1])
  assert.notEqual(calls[0].id, calls[1].id)
  assert.equal(chunks.map(chunk => chunk.choices[0].delta.content || '').join(''), 'beforebetweenafter')
})
