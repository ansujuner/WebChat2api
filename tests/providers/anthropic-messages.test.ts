import test from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicProtocolError, convertAnthropicRequest, convertOpenAIResponse, estimateAnthropicInputTokens } from '../../src/main/proxy/anthropic/messages.ts'

const basic = (extra: Record<string, unknown> = {}) => ({ model: 'DeepSeek-V4', max_tokens: 4096, messages: [{ role: 'user', content: '你好' }], ...extra })
const tool = { name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
const response = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 'chatcmpl-one', model: 'DeepSeek-V4', choices: [{ message: { role: 'assistant', ...message }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 7 }, ...extra })
function invalid(value: unknown, pattern?: RegExp) {
  assert.throws(() => convertAnthropicRequest(value), (error: unknown) => error instanceof AnthropicProtocolError && error.status === 400 && error.type === 'invalid_request_error' && (!pattern || pattern.test(error.message)))
}

test('converts a plain Messages request without modifying caller-owned objects', () => {
  const input = basic({ stream: true, temperature: 0.4, top_p: 0.8, stop_sequences: ['STOP'] })
  const original = structuredClone(input)
  assert.deepEqual(convertAnthropicRequest(input), { model: 'DeepSeek-V4', max_tokens: 4096, messages: [{ role: 'user', content: '你好' }], stream: true, temperature: 0.4, top_p: 0.8, stop: ['STOP'] })
  assert.deepEqual(input, original)
})

test('system text and cached blocks become one initial system message', () => {
  assert.deepEqual(convertAnthropicRequest(basic({ system: 'Be concise' })).messages[0], { role: 'system', content: 'Be concise' })
  assert.deepEqual(convertAnthropicRequest(basic({ system: [{ type: 'text', text: 'First', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Second' }], cache_control: { type: 'ephemeral' } })).messages[0], { role: 'system', content: 'First\n\nSecond' })
})

test('client tools and all supported tool choice variants map to OpenAI fields', () => {
  const converted = convertAnthropicRequest(basic({ tools: [tool], tool_choice: { type: 'tool', name: 'read_file' } }))
  assert.deepEqual(converted.tools, [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: tool.input_schema } }])
  assert.notEqual(converted.tools![0].function.parameters, tool.input_schema)
  assert.deepEqual(converted.tool_choice, { type: 'function', function: { name: 'read_file' } })
  for (const [type, expected] of [['auto', 'auto'], ['none', 'none'], ['any', 'required']]) assert.equal(convertAnthropicRequest(basic({ tools: [tool], tool_choice: { type, disable_parallel_tool_use: false } })).tool_choice, expected)
})

test('assistant tool calls and user tool results preserve IDs, text and block ordering', () => {
  const converted = convertAnthropicRequest(basic({ tools: [tool], messages: [
    { role: 'user', content: 'Read these' },
    { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.ts' } }, { type: 'tool_use', id: 'toolu_b', name: 'read_file', input: { path: 'b.ts' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'file A' }, { type: 'text', text: 'Also consider ' }, { type: 'text', text: 'this.' }, { type: 'tool_result', tool_use_id: 'toolu_b', content: [{ type: 'text', text: 'file ' }, { type: 'text', text: 'B' }] }, { type: 'text', text: 'Continue' }] },
  ] }))
  assert.deepEqual(converted.messages[1], { role: 'assistant', content: 'Reading.', tool_calls: [
    { id: 'toolu_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
    { id: 'toolu_b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.ts"}' } },
  ] })
  assert.deepEqual(converted.messages.slice(2), [
    { role: 'tool', tool_call_id: 'toolu_a', content: 'file A' }, { role: 'user', content: 'Also consider this.' },
    { role: 'tool', tool_call_id: 'toolu_b', content: 'file B' }, { role: 'user', content: 'Continue' },
  ])
})

test('empty tool output and error markers stay in the untrusted tool role', () => {
  const actual = convertAnthropicRequest(basic({ messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'empty' }, { type: 'tool_result', tool_use_id: 'error', is_error: true, content: 'Permission denied' },
  ] }] })).messages
  assert.deepEqual(actual, [{ role: 'tool', tool_call_id: 'empty', content: '' }, { role: 'tool', tool_call_id: 'error', content: '[Tool execution error]\nPermission denied' }])
})

test('base64 and URL images survive conversion in user and tool-result blocks', () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
  const url = { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }
  const actual = convertAnthropicRequest(basic({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Look' }, image, url, { type: 'tool_result', tool_use_id: 'screenshot', is_error: true, content: [image] }] }] })).messages
  assert.deepEqual(actual[0].content, [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }, { type: 'image_url', image_url: { url: 'https://example.com/image.png' } }])
  assert.deepEqual(actual[1].content, [{ type: 'text', text: '[Tool execution error]\n' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }])
})

test('Claude Code metadata retains session identity and proxy continuity extensions', () => {
  const user_id = JSON.stringify({ device_id: 'device', account_uuid: '', session_id: 'claude-session' })
  const actual = convertAnthropicRequest(basic({ metadata: { user_id }, session_id: 'c2a-session' }))
  assert.equal(actual.user, user_id)
  assert.equal(actual.session_id, 'c2a-session')
  assert.equal(convertAnthropicRequest(basic({ new_conversation: true })).new_conversation, true)
})

test('thinking intent and effort map without claiming native Anthropic thinking support', () => {
  assert.equal(convertAnthropicRequest(basic({ thinking: { type: 'enabled', budget_tokens: 1024 } })).reasoning_effort, 'high')
  assert.equal(convertAnthropicRequest(basic({ thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort: 'medium' } })).reasoning_effort, 'medium')
  assert.equal(convertAnthropicRequest(basic({ thinking: { type: 'disabled' } })).reasoning_effort, undefined)
  assert.equal(convertAnthropicRequest(basic({ output_config: { effort: 'xhigh' } })).reasoning_effort, 'max')
})

test('malformed boundaries produce safe native protocol errors', () => {
  for (const value of [undefined, null, false, [], 'SECRET', basic({ model: '' }), basic({ max_tokens: 0 }), basic({ max_tokens: -1 }), basic({ max_tokens: 1.2 }), basic({ max_tokens: undefined }), basic({ messages: [] }), basic({ stream: 'true' }), basic({ temperature: 2 }), basic({ top_p: NaN }), basic({ stop_sequences: [null] }), basic({ metadata: { user_id: {} } }), basic({ system: {} }), basic({ messages: [{ role: 'system', content: 'wrong' }] }), basic({ messages: [{ role: 'user', content: null }] }), basic({ messages: [{ role: 'user', content: [null] }] })]) invalid(value)
  try { convertAnthropicRequest('SECRET') } catch (error) { assert.doesNotMatch((error as Error).message, /SECRET/) }
})

test('rejects unsupported functional features instead of silently losing them', () => {
  for (const extra of [
    { tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, { tools: [{ ...tool, strict: true }] }, { tools: [{ ...tool, defer_loading: true }] },
    { tools: [tool], tool_choice: { type: 'auto', disable_parallel_tool_use: true } }, { context_management: { edits: [{ type: 'clear_tool_uses_20250919' }] } },
    { output_config: { format: { type: 'json_schema', schema: { type: 'object' } } } }, { top_k: 2 }, { service_tier: 'standard_only' },
    { thinking: { type: 'enabled', budget_tokens: 1024, display: 'summarized' } },
    { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', data: 'secret' } }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 'signed' }] }] },
    { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'file:///etc/passwd' } }] }] },
  ]) invalid(basic(extra))
})

test('validates tool schemas, role placement, budgets, identifiers and images', () => {
  for (const extra of [
    { tools: {} }, { tools: [tool, tool] }, { tools: [{ ...tool, input_schema: { type: 'array' } }] },
    { tool_choice: { type: 'any' } }, { tools: [tool], tool_choice: { type: 'tool', name: 'missing' } },
    { tool_choice: { type: 'auto', name: 'irrelevant' } }, { thinking: { type: 'enabled', budget_tokens: 4096 } }, { thinking: { type: 'adaptive', budget_tokens: 1024 } },
    { messages: [{ role: 'user', content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: {} }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'a', content: '' }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: [] }] }] },
    { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'wrong%%' } }] }] },
  ]) invalid(basic(extra))
})

test('non-stream output uses native Anthropic fields and excludes unverifiable reasoning', () => {
  const input = response({ content: 'Hello', reasoning_content: 'Private unsigned provider reasoning' })
  const snapshot = structuredClone(input)
  const output = convertOpenAIResponse(input, 'chosen-model')
  assert.match(output.id as string, /^msg_\w+$/)
  assert.notEqual(output.id, input.id)
  assert.deepEqual(output, { id: output.id, type: 'message', role: 'assistant', model: 'chosen-model', content: [{ type: 'text', text: 'Hello' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 9, output_tokens: 7 } })
  assert.deepEqual(input, snapshot)
})

test('non-stream tool calls survive round-trip into assistant history', () => {
  const call = { id: 'toolu_a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }
  const output = convertOpenAIResponse(response({ content: 'Reading.', tool_calls: [call] }))
  assert.equal(output.stop_reason, 'tool_use')
  assert.deepEqual(output.content, [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id: 'toolu_a', name: 'read_file', input: { path: 'a.ts' } }])
  assert.deepEqual(convertAnthropicRequest(basic({ messages: [{ role: 'assistant', content: output.content }] })).messages, [{ role: 'assistant', content: 'Reading.', tool_calls: [call] }])
})

test('tool-only no-argument calls and stop reasons follow streaming codec semantics', () => {
  const output = convertOpenAIResponse(response({ content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'clock', arguments: '' } }] }))
  assert.deepEqual(output.content, [{ type: 'tool_use', id: 'call', name: 'clock', input: {} }])
  for (const [finish, expected] of [['length', 'max_tokens'], ['content_filter', 'refusal']]) {
    assert.equal(convertOpenAIResponse(response({}, { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: finish }] })).stop_reason, expected)
  }
})

test('requires an assistant role and explicit supported terminal reason before success', () => {
  for (const finish_reason of [undefined, null, '', 'function_call', 'unknown']) {
    assert.throws(() => convertOpenAIResponse(response({}, { choices: [{ message: { role: 'assistant', content: 'Partial' }, finish_reason }] })), (error: unknown) => error instanceof AnthropicProtocolError && error.status === 502)
  }
  for (const role of [undefined, null, 'user', 'tool', 'system']) {
    assert.throws(() => convertOpenAIResponse(response({ role, content: 'Wrong role' })), /role must be assistant/)
  }
  assert.throws(() => convertOpenAIResponse(response({ function_call: { name: 'Read', arguments: '{}' } })), /Legacy/)
  assert.throws(() => convertOpenAIResponse(response({}, { choices: [{ message: { role: 'assistant', content: 'A' }, finish_reason: 'stop' }, { message: { role: 'assistant', content: 'B' }, finish_reason: 'stop' }] })), /exactly one/)
})

test('requires actual unique valid tool calls when claiming tool completion', () => {
  for (const tool_calls of [undefined, []]) assert.throws(() => convertOpenAIResponse(response({}, { choices: [{ message: { role: 'assistant', content: '', tool_calls }, finish_reason: 'tool_calls' }] })), /supplied no tools/)
  const call = { id: 'toolu_once', type: 'function', function: { name: 'Read', arguments: '{}' } }
  assert.throws(() => convertOpenAIResponse(response({ tool_calls: [call, structuredClone(call)] })), /IDs must be unique/)
  for (const malformed of [{ ...call, id: ' ' }, { ...call, function: { ...call.function, name: '\n' } }, { ...call, function: [] }]) {
    assert.throws(() => convertOpenAIResponse(response({ tool_calls: [malformed] })), /malformed/)
  }
  assert.equal(convertOpenAIResponse(response({}, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }] })).stop_reason, 'tool_use')
  assert.equal(convertOpenAIResponse(response({}, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'content_filter' }] })).stop_reason, 'refusal')
})

test('invalid upstream messages/tool inputs become api_error rather than fake tool success', () => {
  for (const body of [null, {}, { choices: [] }, { choices: [null] }, response({ content: [{ type: 'image' }] }), response({ tool_calls: 'wrong' }), response({ tool_calls: [{}] }), ...['{broken', '[]', 'null', '"text"'].map(argumentsValue => response({ tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: argumentsValue } }] }))]) {
    assert.throws(() => convertOpenAIResponse(body), (error: unknown) => error instanceof AnthropicProtocolError && error.status === 502 && error.type === 'api_error')
  }
})

test('local token estimate accepts count_tokens shape without max_tokens and includes tools', () => {
  const payload = { model: 'DeepSeek-V4', messages: [{ role: 'user', content: '你好' }] }
  const plain = estimateAnthropicInputTokens(payload)
  assert.ok(Number.isSafeInteger(plain) && plain > 0)
  assert.ok(estimateAnthropicInputTokens({ ...payload, tools: [tool] }) > plain)
  assert.equal(estimateAnthropicInputTokens({ ...payload, thinking: { type: 'enabled', budget_tokens: 1024 } }), plain)
  assert.throws(() => estimateAnthropicInputTokens({ messages: [] }), AnthropicProtocolError)
})
