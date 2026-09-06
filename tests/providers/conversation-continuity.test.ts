import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { ConversationContinuity, conversationScope, getConversationOptions } from '../../src/main/proxy/conversationContinuity.ts'
import { ConversationStream } from '../../src/main/proxy/conversationStream.ts'
import type { ChatCompletionRequest, ChatMessage } from '../../src/main/proxy/types.ts'

const user = (content: string): ChatMessage => ({ role: 'user', content })
const assistant = (content: string): ChatMessage => ({ role: 'assistant', content })
const binding = { providerId: 'deepseek', accountId: 'account-a', actualModel: 'deepseek-chat' }
const req = (messages: ChatMessage[], extra: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest => ({ model: 'DeepSeek', messages, ...extra })
function complete(turn: ReturnType<ConversationContinuity['begin']>, answer = '你好！', parent = String(Number(getConversationOptions(turn.request).conversation?.parentMessageId ?? '0') + 1)) {
  turn.bind(binding)
  getConversationOptions(turn.request).onConversation!({ sessionId: 'upstream-chat', parentMessageId: parent })
  turn.commit(assistant(answer))
}

test('three full-history turns reuse one upstream conversation and forward only the new input', () => {
  const manager = new ConversationContinuity()
  const first = manager.begin(req([user('你好')]), 'client')
  assert.deepEqual(first.request.messages, [user('你好')])
  complete(first)
  const second = manager.begin(req([user('你好'), assistant('你好！'), user('今天天气怎么样')]), 'client')
  assert.equal(second.id, first.id)
  assert.deepEqual(second.binding, binding)
  assert.deepEqual(second.request.messages, [user('今天天气怎么样')])
  assert.equal(getConversationOptions(second.request).conversation?.parentMessageId, '1')
  complete(second, '你在哪个城市？', '2')
  const third = manager.begin(req([user('你好'), assistant('你好！'), user('今天天气怎么样'), assistant('你在哪个城市？'), user('上海')]), 'client')
  assert.equal(third.id, first.id)
  assert.deepEqual(third.request.messages, [user('上海')])
  assert.equal(getConversationOptions(third.request).conversation?.parentMessageId, '2')
  complete(third, '好的', '3')
})

test('explicit ID supports current-input-only clients, full history and repeated words', () => {
  const manager = new ConversationContinuity()
  const first = manager.begin(req([user('你好')]), 'client'); complete(first)
  const next = manager.begin(req([user('你好')], { session_id: first.id }), 'client')
  assert.equal(next.id, first.id)
  assert.deepEqual(next.request.messages, [user('你好')]); complete(next)
  const third = manager.begin(req([user('你好'), assistant('你好！'), user('你好'), assistant('你好！'), user('继续')], { session_id: first.id }), 'client')
  assert.deepEqual(third.request.messages, [user('继续')]); complete(third)
})

test('independent single-message conversations never reuse an account-level latest chat', () => {
  const manager = new ConversationContinuity()
  const a = manager.begin(req([user('你好')]), 'client'); complete(a)
  const b = manager.begin(req([user('你好')]), 'client'); complete(b)
  assert.notEqual(a.id, b.id)
  assert.throws(() => manager.begin(req([user('你好'), assistant('你好！'), user('继续')]), 'client'), /ambiguous/)
})

test('full system/tool policy disambiguates otherwise identical independent transcripts', () => {
  for (const mode of ['system', 'tools']) {
    const manager = new ConversationContinuity()
    const system = (id: string): ChatMessage => ({ role: 'system', content: mode === 'system' ? `policy-${id}` : 'same-policy' })
    const tools = (id: string): Partial<ChatCompletionRequest> => mode === 'tools' ? { tools: [{ type: 'function', function: { name: `tool_${id}`, parameters: { type: 'object' } } }] } : {}
    const a = manager.begin(req([system('a'), user('hello')], tools('a')), 'client'); complete(a, 'same-answer')
    const b = manager.begin(req([system('b'), user('hello')], tools('b')), 'client'); complete(b, 'same-answer')
    const next = manager.begin(req([system('a'), user('hello'), assistant('same-answer'), user('next')], tools('a')), 'client')
    assert.equal(next.id, a.id)
    assert.deepEqual(next.request.messages, [user('next')])
    next.cancel()
  }
})

test('committing duplicate nonstream tool identities never creates a reusable conversation', () => {
  const manager = new ConversationContinuity(), turn = manager.begin(req([user('hello')]), 'client')
  turn.bind(binding)
  getConversationOptions(turn.request).onConversation!({ sessionId: 'upstream-chat', parentMessageId: '1' })
  const call = { id: 'duplicate', type: 'function' as const, function: { name: 'echo', arguments: '{}' } }
  assert.throws(() => turn.commit({ role: 'assistant', content: null, tool_calls: [call, { ...call }] }), /invalid tool-call arguments/)
  assert.throws(() => manager.begin(req([user('next')], { session_id: turn.id }), 'client'), /did not finish reliably/)
})

test('API key, client and model scopes are isolated', () => {
  const manager = new ConversationContinuity()
  const a = manager.begin(req([user('你好')]), conversationScope('key-a', '127.0.0.1', 'client-a')); complete(a)
  for (const scope of [conversationScope('key-b', '127.0.0.1', 'client-a'), conversationScope('key-a', '127.0.0.1', 'client-b')]) {
    assert.throws(() => manager.begin(req([user('继续')], { session_id: a.id }), scope), /unknown or expired/)
  }
  assert.throws(() => manager.begin(req([user('继续')], { model: 'Kimi', session_id: a.id }), conversationScope('key-a', '127.0.0.1', 'client-a')), /change the model/)
})

test('system and tool instructions are bootstrapped once, parser configuration remains on continuation', () => {
  const manager = new ConversationContinuity()
  const system: ChatMessage = { role: 'system', content: '回答中文' }
  const tools: ChatCompletionRequest['tools'] = [{ type: 'function', function: { name: 'weather', parameters: { type: 'object' } } }]
  const a = manager.begin(req([system, user('你好')], { tools }), 'client'); complete(a)
  const b = manager.begin(req([system, user('你好'), assistant('你好！'), user('天气')], { tools }), 'client')
  assert.deepEqual(b.request.messages, [user('天气')])
  assert.deepEqual(b.request.tools, tools); complete(b)
  const c = manager.begin(req([user('继续')], { session_id: a.id }), 'client')
  assert.deepEqual(c.request.tools, tools); complete(c)
  assert.throws(() => manager.begin(req([user('继续')], { session_id: a.id, tools: [] }), 'client'), /Tools or conversation modes changed/)
  assert.throws(() => manager.begin(req([{ role: 'system', content: 'changed' }, user('继续')], { session_id: a.id }), 'client'), /System instructions changed/)
})

test('tool-result continuation strips prior assistant calls without losing the new tool result', () => {
  const manager = new ConversationContinuity()
  const a = manager.begin(req([user('天气')]), 'client')
  const call: ChatMessage = { role: 'assistant', content: null, tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'weather', arguments: '{}' } }] }
  a.bind(binding); getConversationOptions(a.request).onConversation!({ sessionId: 'upstream-chat', parentMessageId: '1' }); a.commit(call)
  const tool: ChatMessage = { role: 'tool', tool_call_id: 'call-a', content: '晴' }
  const b = manager.begin(req([user('天气'), call, tool]), 'client')
  assert.deepEqual(b.request.messages, [tool]); complete(b)
})

test('simultaneous requests are rejected and account/model selection cannot silently switch', () => {
  const manager = new ConversationContinuity()
  const a = manager.begin(req([user('你好')]), 'client'); complete(a)
  const b = manager.begin(req([user('继续')], { session_id: a.id }), 'client')
  assert.throws(() => manager.begin(req([user('再继续')], { session_id: a.id }), 'client'), /still running/)
  assert.throws(() => b.bind({ ...binding, accountId: 'account-b' }), /original account/)
  b.cancel()
  const c = manager.begin(req([user('继续')], { session_id: a.id }), 'client'); complete(c)
})

test('failure and missing cursors block continuation instead of replaying history', () => {
  const manager = new ConversationContinuity()
  const a = manager.begin(req([user('你好')]), 'client'); complete(a)
  const b = manager.begin(req([user('继续')], { session_id: a.id }), 'client'); b.fail()
  assert.throws(() => manager.begin(req([user('再次')], { session_id: a.id }), 'client'), /did not finish reliably/)
  const c = manager.begin(req([user('你好')], { new_conversation: true }), 'client')
  assert.throws(() => c.commit(assistant('你好！')), /no reliable continuation ID/)
})

test('expiry and reset are explicit, bounded and do not send a stale upstream ID', () => {
  let now = 0
  const manager = new ConversationContinuity(() => now, 1)
  const a = manager.begin(req([user('你好')]), 'client', 100); complete(a)
  const overCapacity = manager.begin(req([user('别的')]), 'client')
  assert.throws(() => overCapacity.bind(binding), /capacity/)
  overCapacity.cancel()
  now = 101
  assert.throws(() => manager.begin(req([user('继续')], { session_id: a.id }), 'client'), /unknown or expired/)
  const b = manager.begin(req([user('你好')], { new_conversation: true }), 'client')
  assert.notEqual(a.id, b.id)
  assert.equal(getConversationOptions(b.request).conversation, undefined)
})

test('cancelling an old pending turn cannot resurrect a conversation after the index was cleared', () => {
  const manager = new ConversationContinuity()
  const first = manager.begin(req([user('hello')]), 'client'); complete(first)
  const pending = manager.begin(req([user('next')], { session_id: first.id }), 'client')
  manager.clear()
  pending.cancel()
  assert.throws(() => manager.begin(req([user('again')], { session_id: first.id }), 'client'), /unknown or expired/)
})

test('internal cursors and callbacks are not accepted from JSON or serialized in logs', () => {
  const manager = new ConversationContinuity()
  const a = manager.begin(req([user('你好')]), 'client')
  getConversationOptions(a.request).onConversation!({ sessionId: 'upstream-chat', extras: { token: 'fixture-private-cursor' } })
  assert.equal(JSON.stringify(a.request).includes('fixture-private-cursor'), false)
  assert.deepEqual(getConversationOptions({ ...a.request }), {})
  assert.deepEqual(getConversationOptions({ ...a.request, conversation: { sessionId: 'injected' } } as any), {})
})

test('input is immutable and text-array history matches normalized assistant strings', () => {
  const manager = new ConversationContinuity()
  const input = Object.freeze({ model: 'DeepSeek', messages: Object.freeze([Object.freeze(user('你好'))]) })
  const a = manager.begin(input as any, 'client'); complete(a)
  const b = manager.begin(req([user('你好'), { role: 'assistant', content: [{ type: 'text', text: '你好！' }] }, user('继续')]), 'client')
  assert.equal(a.id, b.id)
})

const sse = (data: unknown): string => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
const delta = (content: string, finish_reason: string | null = null) => ({ choices: [{ index: 0, delta: { content }, finish_reason }] })
async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = ''
  for await (const chunk of stream as any) output += chunk.toString()
  return output
}

test('stream continuity commits UTF-8 across arbitrary byte/frame boundaries', async () => {
  const manager = new ConversationContinuity()
  const a = manager.begin(req([user('你好')]), 'client')
  a.bind(binding); getConversationOptions(a.request).onConversation!({ sessionId: 'upstream-chat', parentMessageId: '1' })
  const bytes = Buffer.from(sse(delta('你好！')) + sse(delta('', 'stop')) + sse('[DONE]'))
  const observer = new ConversationStream(a)
  const output = collect(Readable.from([...bytes].map(b => Buffer.from([b]))).pipe(observer))
  assert.equal(await output, bytes.toString())
  const b = manager.begin(req([user('你好'), assistant('你好！'), user('天气')]), 'client')
  assert.equal(a.id, b.id)
})

test('truncated, errored, malformed and missing-terminal streams never commit', async () => {
  for (const payload of [sse(delta('partial')), sse(delta('partial', 'stop')), sse('[DONE]'), 'data: broken\n\n', sse({ error: { message: 'failed' } })]) {
    const manager = new ConversationContinuity()
    const a = manager.begin(req([user('你好')]), 'client')
    getConversationOptions(a.request).onConversation!({ sessionId: 'upstream-chat' })
    await assert.rejects(collect(Readable.from([Buffer.from(payload)]).pipe(new ConversationStream(a))))
    assert.throws(() => manager.begin(req([user('继续')], { session_id: a.id }), 'client'), /did not finish reliably/)
  }
})
