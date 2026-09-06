import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { AnthropicStream } from '../../src/main/proxy/anthropic/stream.ts'

type Event = Record<string, any>
const frame = (value: unknown, newline = '\n'): string => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}${newline}${newline}`
const chunk = (delta: unknown, finish_reason: string | null = null, extras = {}): string => frame({
  id: 'upstream-private-id', model: 'actual-upstream-model',
  choices: [{ index: 0, delta, finish_reason }], ...extras,
})
const stop = (reason = 'stop'): string => chunk({}, reason)
const done = frame('[DONE]')

function parse(output: string): Event[] {
  return output.split('\n\n').filter(Boolean).map(value => {
    const [name, data] = value.split('\n')
    const event = JSON.parse(data.slice(6))
    assert.equal(name, `event: ${event.type}`)
    return event
  })
}
function collect(stream: AnthropicStream): Promise<Event[]> {
  return (async () => {
    let result = ''
    for await (const data of stream) result += data.toString()
    return parse(result)
  })()
}
async function convert(input: string | Buffer, options = {}): Promise<Event[]> {
  const stream = new AnthropicStream(options)
  const result = collect(stream)
  stream.end(input)
  return result
}
function accumulate(events: Event[]): Event {
  const start = events.find(event => event.type === 'message_start')
  assert.ok(start)
  const message = { ...start.message, content: [] as Event[] }
  const args = new Map<number, string>()
  const stopped = new Set<number>()
  for (const event of events) {
    if (event.type === 'content_block_start') {
      assert.equal(message.content[event.index], undefined)
      message.content[event.index] = { ...event.content_block }
    } else if (event.type === 'content_block_delta') {
      assert.ok(message.content[event.index])
      assert.ok(!stopped.has(event.index))
      if (event.delta.type === 'text_delta') message.content[event.index].text += event.delta.text
      else if (event.delta.type === 'input_json_delta') args.set(event.index, (args.get(event.index) ?? '') + event.delta.partial_json)
      else assert.fail(`Unexpected delta ${event.delta.type}`)
    } else if (event.type === 'content_block_stop') {
      assert.ok(!stopped.has(event.index))
      stopped.add(event.index)
      if (args.has(event.index)) message.content[event.index].input = JSON.parse(args.get(event.index)!)
    } else if (event.type === 'message_delta') {
      Object.assign(message, event.delta)
      message.usage = { ...message.usage, ...event.usage }
    }
  }
  assert.equal(events.at(-1)?.type, 'message_stop')
  assert.equal(stopped.size, message.content.length)
  return message
}
function assertNativeFailure(events: Event[], pattern?: RegExp): void {
  assert.equal(events.filter(event => event.type === 'error').length, 1)
  assert.equal(events.at(-1)?.type, 'error')
  assert.ok(!events.some(event => event.type === 'message_stop'))
  assert.ok(!events.some(event => event.type === 'message_delta'))
  if (pattern) assert.match(events.at(-1)!.error.message, pattern)
}

test('Anthropic SSE emits standard text event sequence and preserves requested model', async () => {
  const events = await convert(chunk({ role: 'assistant', content: '' }) + chunk({ content: '你好' }) + chunk({ content: '世界' }) + stop() + done,
    { model: 'public-model', requestId: 'request-fixture', inputTokens: 12 })
  assert.deepEqual(events.map(event => event.type), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_delta',
    'content_block_stop', 'message_delta', 'message_stop',
  ])
  assert.deepEqual(accumulate(events), {
    id: 'msg_request-fixture', type: 'message', role: 'assistant', model: 'public-model',
    content: [{ type: 'text', text: '你好世界' }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 0 },
  })
  assert.ok(!JSON.stringify(events).includes('upstream-private-id'))
})

test('Anthropic SSE handles UTF-8 characters and CRLF split at every byte', async () => {
  const input = Buffer.from((chunk({ content: '你好🙂 café' }) + stop() + done).replace(/\n/g, '\r\n'))
  const stream = new AnthropicStream()
  const result = collect(stream)
  for (const byte of input) stream.write(Buffer.from([byte]))
  stream.end()
  assert.equal(accumulate(await result).content[0].text, '你好🙂 café')
})

test('Anthropic SSE supports CR-only separators and multi-line data fields', async () => {
  const json = 'data: {"choices":\rdata: [{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}\r\r'
  const events = await convert(json + frame('[DONE]', '\r'))
  assert.equal(accumulate(events).content[0].text, 'hello')
})

test('Anthropic SSE ignores comments and forwards valid ping events', async () => {
  const events = await convert(': keepalive\n\n' + chunk({ content: 'hello' }) +
    'event: ping\ndata: {"type":"ping"}\n\n' + ': between\n\n' + stop() + done + ': trailing comment')
  assert.equal(events[0].type, 'message_start')
  assert.equal(events.filter(event => event.type === 'ping').length, 1)
  assert.equal(accumulate(events).content[0].text, 'hello')
})

test('Anthropic SSE keeps text streaming before upstream EOF', async () => {
  const stream = new AnthropicStream()
  const received: string[] = []
  stream.on('data', bytes => received.push(bytes.toString()))
  stream.write(chunk({ content: 'visible now' }))
  assert.match(received.join(''), /visible now/)
  assert.doesNotMatch(received.join(''), /message_stop/)
  const ended = once(stream, 'end')
  stream.end(stop() + done)
  await ended
})

test('Anthropic SSE withholds terminal message_stop until clean EOF, even after DONE', async () => {
  const stream = new AnthropicStream()
  const received: string[] = []
  stream.on('data', bytes => received.push(bytes.toString()))
  stream.write(chunk({ content: 'hello' }) + stop() + done)
  assert.doesNotMatch(received.join(''), /message_stop/)
  assert.doesNotMatch(received.join(''), /content_block_stop/)
  const ended = once(stream, 'end')
  stream.end()
  await ended
  assert.equal(parse(received.join('')).at(-1)?.type, 'message_stop')
})

test('Anthropic SSE preserves cumulative usage rather than adding repeated totals', async () => {
  const events = await convert(chunk({ content: 'hello' }, null, { usage: { prompt_tokens: 7, completion_tokens: 2 } }) +
    chunk({ content: '!' }, 'stop', { usage: { prompt_tokens: 7, completion_tokens: 3 } }) +
    frame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 5 } }) + done,
  { inputTokens: 99 })
  assert.deepEqual(events[0].message.usage, { input_tokens: 7, output_tokens: 0 })
  assert.deepEqual(accumulate(events).usage, { input_tokens: 7, output_tokens: 5 })
})

test('Anthropic SSE late actual input usage replaces estimated fallback', async () => {
  const events = await convert(chunk({ content: 'hello' }) + stop() + frame({ usage: { prompt_tokens: 6, completion_tokens: 2 }, choices: [] }) + done,
    { inputTokens: 100 })
  assert.equal(events[0].message.usage.input_tokens, 100)
  assert.deepEqual(accumulate(events).usage, { input_tokens: 6, output_tokens: 2 })
})

test('Anthropic SSE ignores malformed usage values and does not invent caching support', async () => {
  const events = await convert(chunk({ content: 'hello' }, 'stop', { usage: { prompt_tokens: -1, completion_tokens: '123', prompt_tokens_details: { cached_tokens: 9 } } }) + done,
    { inputTokens: 8 })
  assert.deepEqual(accumulate(events).usage, { input_tokens: 8, output_tokens: 0 })
})

test('Anthropic SSE preserves multiple interleaved tool fragments in canonical index order', async () => {
  const events = await convert(chunk({ content: 'Checking: ' }) +
    chunk({ tool_calls: [{ index: 1, id: 'call_time', type: 'function', function: { name: 'time', arguments: '{' } }] }) +
    chunk({ tool_calls: [{ index: 0, id: 'call_weather', type: 'function', function: { name: 'weather', arguments: '{"city":' } }] }) +
    chunk({ content: 'two tools', tool_calls: [{ index: 1, function: { arguments: '}' } }, { index: 0, function: { arguments: '"上海"}' } }] }) +
    stop('tool_calls') + done)
  const message = accumulate(events)
  assert.equal(message.stop_reason, 'tool_use')
  assert.deepEqual(message.content, [
    { type: 'text', text: 'Checking: two tools' },
    { type: 'tool_use', id: 'call_weather', name: 'weather', input: { city: '上海' } },
    { type: 'tool_use', id: 'call_time', name: 'time', input: {} },
  ])
  assert.deepEqual(events.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json), ['{"city":', '"上海"}', '{', '}'])
})

test('Anthropic SSE assembles fragmented tool names/ids and accepts repeated complete identity', async () => {
  const events = await convert(
    chunk({ tool_calls: [{ index: 0, id: 'call_', function: { name: 'get_', arguments: '{' } }] }) +
    chunk({ tool_calls: [{ index: 0, id: 'one', function: { name: 'weather', arguments: '}' } }] }) +
    chunk({ tool_calls: [{ index: 0, id: 'call_one', function: { name: 'get_weather' } }] }, 'tool_calls') + done)
  assert.deepEqual(accumulate(events).content, [{ type: 'tool_use', id: 'call_one', name: 'get_weather', input: {} }])
})

test('Anthropic SSE empty no-argument tool produces an object input', async () => {
  const events = await convert(chunk({ tool_calls: [{ index: 0, id: 'call_zero', function: { name: 'now', arguments: '' } }] }, 'tool_calls') + done)
  assert.deepEqual(accumulate(events).content[0].input, {})
})

test('Anthropic SSE whitespace-only no-argument tool produces valid JSON deltas', async () => {
  const events = await convert(chunk({ tool_calls: [{ index: 0, id: 'call_zero', function: { name: 'now', arguments: ' \n ' } }] }, 'tool_calls') + done)
  assert.deepEqual(accumulate(events).content[0].input, {})
})

test('Anthropic SSE does not complete tools before receiving verified EOF', async () => {
  const stream = new AnthropicStream()
  const bytes: string[] = []
  stream.on('data', value => bytes.push(value.toString()))
  stream.write(chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'tool', arguments: '{}' } }] }, 'tool_calls') + done)
  assert.doesNotMatch(bytes.join(''), /content_block_stop|message_stop|tool_use/)
  const ended = once(stream, 'end')
  stream.end()
  await ended
  assert.equal(accumulate(parse(bytes.join(''))).content[0].type, 'tool_use')
})

for (const [upstream, expected] of [['stop', 'end_turn'], ['length', 'max_tokens'], ['content_filter', 'refusal']]) {
  test(`Anthropic SSE maps ${upstream} to ${expected}`, async () => {
    assert.equal(accumulate(await convert(chunk({ content: 'reply' }, upstream) + done)).stop_reason, expected)
  })
}

test('Anthropic SSE maps stop with tools to tool_use, matching nonstream responses', async () => {
  const events = await convert(chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'tool', arguments: '{}' } }] }, 'stop') + done)
  assert.equal(accumulate(events).stop_reason, 'tool_use')
})

test('Anthropic SSE omits provider reasoning instead of forging Anthropic thinking signatures', async () => {
  const events = await convert(chunk({ reasoning_content: 'private reasoning text' }) + chunk({ content: 'answer' }, 'stop') + done)
  assert.deepEqual(accumulate(events).content, [{ type: 'text', text: 'answer' }])
  assert.doesNotMatch(JSON.stringify(events), /reasoning|signature|thinking/)
})

test('Anthropic SSE accepts empty successfully completed messages', async () => {
  assert.deepEqual(accumulate(await convert(stop() + done)).content, [{ type: 'text', text: '' }])
})

for (const [name, input, message] of [
  ['missing DONE', chunk({ content: 'partial' }) + stop(), /interrupted/],
  ['missing finish reason', chunk({ content: 'partial' }) + done, /finish reason/],
  ['missing both terminals', chunk({ content: 'partial' }), /interrupted/],
  ['incomplete trailing frame', chunk({ content: 'partial' }) + stop() + done + 'data: {', /incomplete/],
  ['data after DONE', stop() + done + chunk({ content: 'late' }), /after stream completion/],
  ['malformed JSON', 'data: {broken}\n\n', /invalid JSON/],
  ['non-object JSON', frame([]), /invalid event/],
  ['unsupported event', frame({ response: { text: 'lost' } }), /not an OpenAI/],
  ['non-string content', chunk({ content: [{ text: 'unsupported' }] }), /non-text/],
  ['multiple choices', frame({ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] }), /Multiple/],
  ['unsupported finish reason', stop('unknown') + done, /unsupported finish/],
  ['conflicting finish reasons', stop() + stop('length') + done, /conflicting/],
  ['content after finish', stop() + chunk({ content: 'late' }) + done, /after its finish/],
  ['legacy function_call', chunk({ function_call: { name: 'tool' } }), /Legacy/],
  ['invalid original role', chunk({ role: 'user', content: 'wrong role' }) + stop() + done, /role must be assistant/],
  ['tools finish without tools', stop('tool_calls') + done, /supplied no tools/],
] as const) {
  test(`Anthropic SSE returns native error without false success for ${name}`, async () => {
    assertNativeFailure(await convert(input), message)
  })
}

for (const args of ['{', '[]', 'null', '"string"', '123']) {
  test(`Anthropic SSE rejects incomplete or non-object tool input ${args}`, async () => {
    const events = await convert(chunk({ tool_calls: [{ index: 0, id: 'call_a', function: { name: 'tool', arguments: args } }] }, 'tool_calls') + done)
    assertNativeFailure(events, /JSON/)
    assert.ok(!events.some(event => event.type === 'content_block_stop'))
  })
}

test('Anthropic SSE validates all tools before completing even the first tool', async () => {
  const events = await convert(chunk({ tool_calls: [
    { index: 0, id: 'call_a', function: { name: 'valid', arguments: '{}' } },
    { index: 1, id: 'call_b', function: { name: 'invalid', arguments: '{' } },
  ] }, 'tool_calls') + done)
  assertNativeFailure(events)
  assert.ok(!events.some(event => event.type === 'content_block_start'))
})

test('Anthropic SSE rejects duplicate tool identities', async () => {
  const events = await convert(chunk({ tool_calls: [
    { index: 0, id: 'same', function: { name: 'one', arguments: '{}' } },
    { index: 1, id: 'same', function: { name: 'two', arguments: '{}' } },
  ] }, 'tool_calls') + done)
  assertNativeFailure(events, /duplicate/)
})

test('Anthropic SSE rejects a missing tool index and missing identity', async () => {
  assertNativeFailure(await convert(chunk({ tool_calls: [{ id: 'call_a', function: { name: 'tool', arguments: '{}' } }] })), /index/)
  assertNativeFailure(await convert(chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }, 'tool_calls') + done), /identity/)
  assertNativeFailure(await convert(chunk({ tool_calls: [{ index: 0, id: '  ', function: { name: 'tool', arguments: '{}' } }] }, 'tool_calls') + done), /identity/)
  assertNativeFailure(await convert(chunk({ tool_calls: [{ index: 0, id: 'valid', function: { name: '  ', arguments: '{}' } }] }, 'tool_calls') + done), /identity/)
})

test('Anthropic SSE forwards native typed upstream errors once', async () => {
  const events = await convert(chunk({ content: 'partial' }) + 'event: error\ndata: {"error":{"type":"overloaded_error","message":"Busy"}}\n\n' + stop() + done)
  assertNativeFailure(events)
  assert.deepEqual(events.at(-1)?.error, { type: 'overloaded_error', message: 'Busy' })
})

test('Anthropic SSE rejects an empty explicit error event even after terminal data', async () => {
  assertNativeFailure(await convert(chunk({ content: 'partial' }) + stop() + done + 'event: error\ndata:\n\n'), /error/)
})

test('Anthropic SSE converts OpenAI error payloads instead of treating errors as assistant text', async () => {
  const events = await convert(frame({ error: { code: 'provider_error', message: 'Upstream unavailable' } }))
  assertNativeFailure(events)
  assert.deepEqual(events.at(-1)?.error, { type: 'api_error', message: 'Upstream unavailable' })
})

test('Anthropic SSE fail() delivers a native network error and clean EOF', async () => {
  const stream = new AnthropicStream({ requestId: 'network-fixture' })
  const result = collect(stream)
  stream.write(chunk({ content: 'partial' }))
  stream.fail(new Error('Upstream connection closed'))
  stream.fail(new Error('duplicate'))
  const events = await result
  assertNativeFailure(events, /connection closed/)
  assert.equal(events.at(-1)?.request_id, 'network-fixture')
})

test('Anthropic SSE conversionError allows route to cancel source without losing native error bytes', async () => {
  const source = new PassThrough()
  const stream = new AnthropicStream()
  const result = collect(stream)
  stream.once('conversionError', error => {
    source.unpipe(stream)
    source.destroy()
    stream.fail(error)
  })
  source.pipe(stream)
  source.write('data: {invalid}\n\n')
  const events = await result
  assert.equal(source.destroyed, true)
  assertNativeFailure(events, /invalid JSON/)
})

test('Anthropic SSE late failure after DONE cannot become message_stop', async () => {
  const stream = new AnthropicStream()
  const result = collect(stream)
  stream.write(chunk({ content: 'partial' }) + stop() + done)
  stream.fail(new Error('Socket failed after terminal frame'))
  assertNativeFailure(await result, /Socket failed/)
})

test('Anthropic SSE rejects incomplete UTF-8 rather than corrupting tool arguments', async () => {
  assertNativeFailure(await convert(Buffer.concat([Buffer.from(chunk({ content: 'hello' }) + stop() + done), Buffer.from([0xe4, 0xbd])])), /encoded data|encoding/i)
})

test('Anthropic SSE bounds unfinished event buffering', async () => {
  assertNativeFailure(await convert('data: ' + 'x'.repeat(4 * 1024 * 1024 + 1)), /supported size/)
})

test('Anthropic SSE permits harmless duplicate DONE markers', async () => {
  assert.equal(accumulate(await convert(chunk({ content: 'hello' }, 'stop') + done + done)).stop_reason, 'end_turn')
})
