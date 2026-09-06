import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { managedXmlProtocol as xml } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { ToolStreamParser } from '../../src/main/proxy/toolCalling/ToolStreamParser.ts'
import { buildToolCallingRuntimePlan } from '../../src/main/proxy/toolCalling/runtimePlan.ts'
import { DEFAULT_TOOL_CALLING_CONFIG } from '../../src/shared/toolCalling.ts'
import { AnthropicStream } from '../../src/main/proxy/anthropic/stream.ts'
import { convertAnthropicRequest, convertOpenAIResponse } from '../../src/main/proxy/anthropic/messages.ts'

const tools = [{ name: 'Write', source: 'openai' as const, parameters: {
  type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' }, enabled: { type: 'boolean' }, count: { type: 'integer' }, items: { type: 'array' } },
  required: ['file_path', 'content'], additionalProperties: false,
} }]
const context = { tools, protocol: 'managed_xml' as const }
const plan = () => buildToolCallingRuntimePlan({ providerId: 'deepseek', config: DEFAULT_TOOL_CALLING_CONFIG,
  clientRequest: { tools, toolChoice: { mode: 'auto' }, clientAdapterId: 'standard-openai-tools', toolSource: 'openai' } })
const block = (content: string, extra = {}) => xml.formatAssistantToolCalls([{ id: 'fixture-id', name: 'Write', arguments: JSON.stringify({ file_path: 'fixture.txt', content, ...extra }) }])
const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture' }
const parsed = (text: string) => xml.parse(text, context)

for (const value of ['true', '123', 'null', '{"key":1}', '[1,2]', '  leading\ntrailing\n', '```ts\nconst x = 1\n```', '</|CHAT2API|parameter></|CHAT2API|invoke></|CHAT2API|tool_calls>', 'literal ]]> suffix &amp;']) {
  test(`XML preserves schema-string content exactly: ${JSON.stringify(value)}`, () => {
    const result = parsed(block(value))
    assert.equal(result.toolCalls.length, 1)
    assert.equal(JSON.parse(result.toolCalls[0].function.arguments).content, value)
  })
}

test('XML parses declared non-string types without changing literal string fields', () => {
  const result = parsed(block('false', { enabled: false, count: 2, items: ['a', 'b'] }))
  assert.deepEqual(JSON.parse(result.toolCalls[0].function.arguments), { file_path: 'fixture.txt', content: 'false', enabled: false, count: 2, items: ['a', 'b'] })
})

test('XML missing/duplicate/wrong-type arguments never authorize a partial action', () => {
  for (const raw of [
    '<tool_calls><invoke name="Write"><parameter name="content">x</parameter></invoke></tool_calls>',
    block('x').replace('</|CHAT2API|invoke>', '<|CHAT2API|parameter name="content">duplicate</|CHAT2API|parameter></|CHAT2API|invoke>'),
    block('x', { enabled: 'not a boolean' }),
  ]) {
    const result = parsed(raw)
    assert.equal(result.toolCalls.length, 0)
    assert.equal(result.content, raw)
    assert.equal(result.malformedReason, 'invalid_xml_tool_arguments')
  }
})

test('nonstream XML preserves unrelated fenced examples and keeps tool order across both XML spellings', () => {
  const example = `\`\`\`xml\n${block('example-only')}\n\`\`\``
  const legacy = '<tool_calls><invoke name="Write"><parameter name="file_path">fixture.txt</parameter><parameter name="content">first</parameter></invoke></tool_calls>'
  const result = parsed(`${example}\nbefore ${legacy} between ${block('second')} after`)
  assert.equal(result.toolCalls.length, 2)
  assert.deepEqual(result.toolCalls.map(call => JSON.parse(call.function.arguments).content), ['first', 'second'])
  assert.ok(result.content.includes(example))
  assert.ok(result.content.includes('between'))
})

test('streaming preserves a partial second envelope and uses globally unique call IDs', () => {
  const parser = new ToolStreamParser(plan())
  const second = block('second')
  const chunks = [...parser.push(`before ${block('first')} between ${second.slice(0, 19)}`, base), ...parser.push(`${second.slice(19)} after`, base), ...parser.flush(base)]
  const calls = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls || [])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.index), [0, 1])
  assert.notEqual(calls[0].id, calls[1].id)
  assert.equal(chunks.map(chunk => chunk.choices[0].delta.content || '').join(''), 'before  between  after')
  assert.notEqual(parsed(block('third')).toolCalls[0].id, calls[0].id)
})

test('streaming code fences remain non-executable when split at every character', () => {
  const parser = new ToolStreamParser(plan())
  const example = `\`\`\`xml\n${block('not-executed')}\n\`\`\``
  const chunks = [...example].flatMap(char => parser.push(char, base)).concat(parser.flush(base))
  assert.equal(chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls || []).length, 0)
  assert.equal(chunks.map(chunk => chunk.choices[0].delta.content || '').join(''), example)
})

test('long Markdown fences do not execute nested shorter-fence tool examples', () => {
  for (const delimiter of ['````', '~~~~~']) {
    const shorter = delimiter[0].repeat(3)
    const example = `${delimiter}\n${shorter}xml\n${block('not-executed')}\n${shorter}\n${delimiter}`
    const parser = new ToolStreamParser(plan())
    const chunks = [...example].flatMap(char => parser.push(char, base)).concat(parser.flush(base))
    assert.equal(chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls || []).length, 0)
    assert.equal(chunks.map(chunk => chunk.choices[0].delta.content || '').join(''), example)
    assert.equal(parsed(example).toolCalls.length, 0)
  }
})

test('inline fence runs and incomplete closing lines never expose executable example tools', () => {
  for (const delimiter of ['```', '~~~~']) {
    for (const falseClose of [`inside a sentence ${delimiter} is not a closing fence`, `${delimiter}not-a-closing-line`]) {
      const example = `${delimiter}text\n${falseClose}\n${block('example-must-not-run')}\n${delimiter}`
      assert.equal(parsed(example).toolCalls.length, 0)
      for (const fragments of [[example], [...example]]) {
        const parser = new ToolStreamParser(plan())
        const chunks = fragments.flatMap(fragment => parser.push(fragment, base)).concat(parser.flush(base))
        assert.equal(chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls || []).length, 0)
        assert.equal(chunks.map(chunk => chunk.choices[0].delta.content || '').join(''), example)
      }
    }
  }
})

test('a confirmed complete closing fence still allows an intentional following tool call', () => {
  const example = `\`\`\`xml\n${block('example-only')}\n  \`\`\`\`  \n`
  const raw = `${example}${block('intentional')}`
  const parser = new ToolStreamParser(plan())
  const chunks = [...raw].flatMap(fragment => parser.push(fragment, base)).concat(parser.flush(base))
  const calls = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls || [])
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].function.arguments).content, 'intentional')
  assert.equal(chunks.map(chunk => chunk.choices[0].delta.content || '').join(''), example)
  assert.equal(parsed(raw).toolCalls.length, 1)
})

test('multiple streamed tool calls roundtrip through Anthropic SSE and tool results without duplicate identity failure', async () => {
  const parser = new ToolStreamParser(plan())
  const chunks = [...parser.push(block('first'), base), ...parser.push(block('second'), base), ...parser.flush(base)]
  const converter = new AnthropicStream({ model: 'fixture' })
  let output = ''
  converter.on('data', chunk => { output += chunk.toString() })
  const done = once(converter, 'end')
  for (const chunk of chunks) converter.write(`data: ${JSON.stringify(chunk)}\n\n`)
  converter.end(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  await done
  assert.ok(output.includes('event: message_stop'))
  assert.ok(!output.includes('event: error'))
  const calls = chunks.flatMap(chunk => chunk.choices[0].delta.tool_calls || [])
  const response = convertOpenAIResponse({ choices: [{ message: { role: 'assistant', content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] }, 'fixture') as any
  const next = convertAnthropicRequest({ model: 'fixture', max_tokens: 100,
    messages: [{ role: 'assistant', content: response.content }, { role: 'user', content: response.content.map((call: any) => ({ type: 'tool_result', tool_use_id: call.id, content: 'mock result' })) }],
  })
  assert.equal(next.messages[0].tool_calls?.length, 2)
  assert.deepEqual(next.messages.slice(1).map(message => message.tool_call_id), calls.map(call => call.id))
})
