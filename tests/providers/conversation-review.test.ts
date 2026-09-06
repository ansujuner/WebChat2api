import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationContinuity, getConversationOptions } from '../../src/main/proxy/conversationContinuity.ts'
import { ConversationStream } from '../../src/main/proxy/conversationStream.ts'
import type { ChatMessage } from '../../src/main/proxy/types.ts'

const user = (content: string): ChatMessage => ({ role: 'user', content })
const frame = (value: unknown): string => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const contentFrame = (content: string) => frame({ choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }] })
const binding = { providerId: 'qwen-ai', accountId: 'fixture-account', actualModel: 'fixture-model' }

function setup() {
  const manager = new ConversationContinuity()
  const turn = manager.begin({ model: 'fixture-model', messages: [user('hello')] }, 'fixture-scope')
  turn.bind(binding)
  getConversationOptions(turn.request).onConversation!({ sessionId: 'fixture-upstream', parentMessageId: 'fixture-assistant' })
  return { manager, turn, observer: new ConversationStream(turn) }
}

async function collect(stream: ConversationStream): Promise<string> {
  let result = ''
  for await (const bytes of stream) result += bytes.toString()
  return result
}

test('review: DONE does not release the continuation lock until clean EOF', async () => {
  const { manager, turn, observer } = setup()
  const output = collect(observer)
  observer.write(Buffer.from(contentFrame('reply') + frame('[DONE]')))
  assert.throws(() => manager.begin({
    model: 'fixture-model', session_id: turn.id, messages: [user('next')],
  }, 'fixture-scope'), /still running/)
  observer.end()
  assert.match(await output, /\[DONE\]/)
  const next = manager.begin({
    model: 'fixture-model', session_id: turn.id, messages: [user('next')],
  }, 'fixture-scope')
  assert.equal(next.isContinuation, true)
  next.cancel()
})

test('review: malformed data after DONE leaves the conversation uncertain, not committed', async () => {
  const { manager, turn, observer } = setup()
  const output = collect(observer)
  const failed = assert.rejects(output)
  observer.write(Buffer.from(contentFrame('reply') + frame('[DONE]')))
  observer.end(Buffer.from('data: {invalid-json}\n\n'))
  await failed
  assert.throws(() => manager.begin({
    model: 'fixture-model', session_id: turn.id, messages: [user('next')],
  }, 'fixture-scope'), /did not finish reliably/)
})

test('review: an ordinary explanation containing [Error: is not a transport error', async () => {
  const { manager, turn, observer } = setup()
  const text = 'The log message [Error: file missing] means the file was not found.'
  const output = collect(observer)
  observer.end(Buffer.from(contentFrame(text) + frame('[DONE]')))
  assert.match(await output, /file was not found/)
  const next = manager.begin({
    model: 'fixture-model', messages: [user('hello'), { role: 'assistant', content: text }, user('next')],
  }, 'fixture-scope')
  assert.equal(next.id, turn.id)
  assert.deepEqual(next.request.messages, [user('next')])
  next.cancel()
})

test('review: interleaved tool-call fragments preserve transcript identity for the next result', async () => {
  const { manager, turn, observer } = setup()
  const output = collect(observer)
  const toolFrame = (calls: unknown[], finish_reason: string | null = null) => frame({
    choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason }],
  })
  observer.end(Buffer.from(
    toolFrame([{ index: 1, id: 'call-b', function: { name: 'clock', arguments: '{' } }]) +
    toolFrame([{ index: 0, id: 'call-a', function: { name: 'weather', arguments: '{"city":' } }]) +
    toolFrame([{ index: 1, function: { arguments: '}' } }, { index: 0, function: { arguments: '"Shanghai"}' } }], 'tool_calls') +
    frame('[DONE]'),
  ))
  await output
  const assistant: ChatMessage = { role: 'assistant', content: null, tool_calls: [
    { id: 'call-a', type: 'function', function: { name: 'weather', arguments: '{"city":"Shanghai"}' } },
    { id: 'call-b', type: 'function', function: { name: 'clock', arguments: '{}' } },
  ] }
  const tools: ChatMessage[] = [
    { role: 'tool', tool_call_id: 'call-a', content: 'Sunny' },
    { role: 'tool', tool_call_id: 'call-b', content: 'Noon' },
  ]
  const next = manager.begin({ model: 'fixture-model', messages: [user('hello'), assistant, ...tools] }, 'fixture-scope')
  assert.equal(next.id, turn.id)
  assert.deepEqual(next.request.messages, tools)
  next.cancel()
})

test('review: a first response without an assistant cursor cannot become resumable', () => {
  const manager = new ConversationContinuity()
  const turn = manager.begin({ model: 'fixture-model', messages: [user('hello')] }, 'fixture-scope')
  turn.bind(binding)
  getConversationOptions(turn.request).onConversation!({ sessionId: 'fixture-upstream' })
  assert.throws(() => turn.commit({ role: 'assistant', content: 'reply' }), /no reliable continuation ID/)
  assert.throws(() => manager.begin({
    model: 'fixture-model', session_id: turn.id, messages: [user('next')],
  }, 'fixture-scope'), /did not finish reliably/)
})

test('review: the previous assistant cursor is not reused when the current response omits a new one', () => {
  for (const reportOldCursor of [false, true]) {
    const { manager, turn } = setup()
    turn.commit({ role: 'assistant', content: 'reply' })
    const next = manager.begin({
      model: 'fixture-model', session_id: turn.id, messages: [user('next')],
    }, 'fixture-scope')
    next.bind(binding)
    getConversationOptions(next.request).onConversation!({
      sessionId: 'fixture-upstream', ...(reportOldCursor ? { parentMessageId: 'fixture-assistant' } : {}),
    })
    assert.throws(() => next.commit({ role: 'assistant', content: 'second reply' }), /no reliable continuation ID/)
  }
})

test('review: copied provider IDs still enforce the selected website protocol cursor requirement', () => {
  for (const kind of ['qwen', 'qwen-ai', 'zai']) {
    const manager = new ConversationContinuity()
    const turn = manager.begin({ model: 'fixture-model', messages: [user('hello')] }, 'fixture-scope')
    turn.bind({ ...binding, providerId: 'custom-provider-copy', kind })
    getConversationOptions(turn.request).onConversation!({ sessionId: 'fixture-upstream' })
    assert.throws(() => turn.commit({ role: 'assistant', content: 'reply' }), /no reliable continuation ID/)
  }
  const manager = new ConversationContinuity()
  const turn = manager.begin({ model: 'fixture-model', messages: [user('hello')] }, 'fixture-scope')
  turn.bind({ ...binding, providerId: 'custom-provider-copy', kind: 'glm' })
  getConversationOptions(turn.request).onConversation!({ sessionId: 'fixture-upstream' })
  assert.doesNotThrow(() => turn.commit({ role: 'assistant', content: 'reply' }))
})

test('review: stateless provisional requests can cancel even while website capacity is full', () => {
  const manager = new ConversationContinuity(Date.now, 1)
  const turn = manager.begin({ model: 'fixture-model', messages: [user('hello')] }, 'fixture-scope')
  turn.bind(binding)
  getConversationOptions(turn.request).onConversation!({ sessionId: 'fixture-upstream', parentMessageId: 'fixture-assistant' })
  turn.commit({ role: 'assistant', content: 'reply' })
  for (let index = 0; index < 3; index++) {
    const custom = manager.begin({ model: 'custom-stateless', messages: [user('hello')] }, 'fixture-scope')
    assert.doesNotThrow(() => custom.cancel())
  }
  const next = manager.begin({
    model: 'fixture-model', session_id: turn.id, messages: [user('next')],
  }, 'fixture-scope')
  assert.doesNotThrow(() => next.bind(binding))
  getConversationOptions(next.request).onConversation!({ sessionId: 'fixture-upstream', parentMessageId: 'fixture-assistant-2' })
  assert.doesNotThrow(() => next.commit({ role: 'assistant', content: 'next reply' }))
  const extra = manager.begin({ model: 'fixture-model', messages: [user('independent')] }, 'fixture-scope')
  assert.throws(() => extra.bind(binding), /capacity/)
  extra.cancel()
})
