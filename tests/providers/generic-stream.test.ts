import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable, PassThrough } from 'node:stream'
import { once } from 'node:events'
import { StreamHandler, SSEParser, SSEFormatter } from '../../src/main/proxy/stream.ts'

const frame = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const chunk = (content: string, finish_reason: string | null = null) => frame({ id: 'native-id', model: 'native-model', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason }] })
const ending = chunk('', 'stop') + frame('[DONE]')
async function collect(stream: NodeJS.ReadableStream): Promise<string> { let value = ''; for await (const chunk of stream as any) value += chunk.toString(); return value }

test('SSE parser retains multiline event fields across arbitrary calls and respects CR/CRLF delimiters', () => {
  for (const newline of ['\n', '\r', '\r\n']) {
    const parser = new SSEParser(), events: unknown[] = []
    for (const char of ['event: message', 'data: {', 'data: "a":1}', 'id: fixture', 'retry: 123', '', ''].join(newline)) events.push(...parser.parse(char))
    events.push(...parser.end())
    assert.deepEqual(events, [{ event: 'message', data: '{\n"a":1}', id: 'fixture', retry: 123 }])
  }
})

test('generic streams sharing one handler never share partial JSON or UTF-8 parser state', async () => {
  const handler = new StreamHandler(), first = handler.createTransformStream('one', 'one'), second = handler.createTransformStream('two', 'two')
  const a = collect(first), b = collect(second)
  first.write(chunk('first').slice(0, 25))
  second.end(Buffer.from(chunk('second') + ending))
  first.end(Buffer.from(chunk('first').slice(25) + ending))
  assert.equal(await a, chunk('first') + ending)
  assert.equal(await b, chunk('second') + ending)
  const unicode = handler.createTransformStream('model', 'id'), result = collect(unicode)
  const bytes = Buffer.from((chunk('你好🙂') + ending).replace(/\n/g, '\r\n'))
  for (const byte of bytes) unicode.write(Buffer.from([byte]))
  unicode.end()
  assert.equal(await result, bytes.toString())
})

test('generic path preserves native tool fragments and ordinary tool-looking examples byte-for-byte', async () => {
  const payload = chunk('Example: [function_calls][{"name":"not_authorized","arguments":{}}][/function_calls]') +
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'native-call', type: 'function', function: { name: 'echo', arguments: '{' } }] } }] }) +
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"value":"ok"}' } }] }, finish_reason: 'tool_calls' }] }) + frame('[DONE]')
  const stream = new StreamHandler().createTransformStream('model', 'id'), result = collect(stream)
  stream.end(payload)
  assert.equal(await result, payload)
})

for (const [name, payload] of [
  ['missing finish', chunk('partial') + frame('[DONE]')], ['missing DONE', chunk('partial', 'stop')],
  ['plain EOF', chunk('partial')], ['malformed JSON', 'data: {fixture-sensitive-fragment}\n\n'],
  ['upstream error', 'event: error\n' + frame({ message: 'fixture-sensitive-fragment' }) + ending],
  ['multiple choices', frame({ choices: [{ index: 0, delta: {} }, { index: 1, delta: {} }] }) + ending],
] as const) test(`generic streams reject ${name} without creating a terminal or invoking the success callback`, async () => {
  let ended = 0, output = ''
  const stream = new StreamHandler().createTransformStream('model', 'id', () => ended++)
  stream.on('data', chunk => { output += chunk.toString() })
  const result = assert.rejects(collect(stream), error => { assert.doesNotMatch(String(error), /fixture-sensitive-fragment/); return true })
  stream.end(payload)
  await result
  assert.equal(ended, 0)
  assert.doesNotMatch(output, /\[DONE\]/)
})

test('generic successful terminal is forwarded exactly once and only after clean EOF', async () => {
  let ended = 0, output = ''
  const stream = new StreamHandler().createTransformStream('model', 'id', () => ended++)
  stream.on('data', chunk => { output += chunk.toString() })
  stream.write(chunk('hello') + ending)
  assert.doesNotMatch(output, /\[DONE\]/)
  const complete = once(stream, 'end')
  stream.end()
  await complete
  assert.equal(ended, 1)
  assert.equal(output.split('[DONE]').length - 1, 1)
})

test('stream-to-JSON preserves text around native tools, reasoning and actual cumulative usage', async () => {
  const payload = frame({ choices: [{ index: 0, delta: { content: 'before and after', reasoning_content: 'reasoning', tool_calls: [{ index: 0, id: 'call', function: { name: 'echo', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }) + frame('[DONE]')
  const result = await new StreamHandler().streamToResponse(Readable.from([Buffer.from(payload)]), 'public', 'public-id')
  assert.equal(result.choices[0].message?.content, 'before and after')
  assert.equal(result.choices[0].message?.reasoning_content, 'reasoning')
  assert.equal(result.choices[0].message?.tool_calls?.[0].id, 'call')
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.deepEqual(result.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })
})

test('stream-to-JSON rejects incomplete, errored and already ended sources without hanging', async () => {
  const handler = new StreamHandler()
  await assert.rejects(handler.streamToResponse(Readable.from([chunk('partial')]), 'model', 'id'))
  const source = new PassThrough(), pending = handler.streamToResponse(source, 'model', 'id')
  source.destroy(new Error('fixture-sensitive-network-details'))
  await assert.rejects(pending, error => { assert.doesNotMatch(String(error), /fixture-sensitive/); return true })
  const ended = Readable.from([])
  await collect(ended)
  await assert.rejects(handler.streamToResponse(ended, 'model', 'id'), /unavailable/)
})

test('error helper emits an error, never assistant success or DONE; formatter does not inject multiline fields', async () => {
  const text = await collect(new StreamHandler().createErrorStream('model', 'id', 'Known failure'))
  assert.match(text, /"error"/)
  assert.doesNotMatch(text, /finish_reason|\[DONE\]|"choices"/)
  const parser = new SSEParser()
  assert.deepEqual(parser.parse(new SSEFormatter().format({ data: 'one\ntwo' })), [{ data: 'one\ntwo' }])
})
