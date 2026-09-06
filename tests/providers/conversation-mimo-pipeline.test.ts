import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { MimoStreamHandler } from '../../src/main/proxy/adapters/mimo.ts'
import { ConversationContinuity, getConversationOptions } from '../../src/main/proxy/conversationContinuity.ts'
import { ConversationStream } from '../../src/main/proxy/conversationStream.ts'

async function consume(stream: NodeJS.ReadableStream): Promise<string> {
  let output = ''
  for await (const chunk of stream) output += chunk.toString()
  return output
}

const wire = Buffer.from('event: dialogId\ndata: {"content":"actual-dialog"}\n\nevent: message\ndata: {"content":"你好😀"}\n\nevent: usage\ndata: {"usage":{"promptTokens":1,"completionTokens":2,"totalTokens":3,"reasoningTokens":0}}\n\nevent: finish\ndata: {}\n\n')

test('real MiMo SSE parser feeds central ConversationStream and commits a reusable turn across every UTF-8 boundary', async () => {
  const manager = new ConversationContinuity()
  const turn = manager.begin({ model: 'mimo-v2.5', messages: [{ role: 'user', content: '你好' }], stream: true }, 'fixture-scope')
  turn.bind({ providerId: 'mimo', accountId: 'fixture-account', actualModel: 'mimo-v2.5' })
  const options = getConversationOptions(turn.request)
  options.onConversation?.({ sessionId: 'real-upstream-thread' })
  const handler = new MimoStreamHandler('mimo-v2.5', 'real-upstream-thread')
  handler.setConversationListener(options.onConversation)
  const bytes = Array.from(wire, (_, index) => wire.subarray(index, index + 1))
  const decoded = handler.handleStream(Readable.from(bytes))
  const central = new ConversationStream(turn)
  const output = await consume(decoded.pipe(central))
  assert.match(output, /你好😀/)
  assert.equal((output.match(/data: \[DONE\]/g) || []).length, 1)
  const chunks = output.split('\n\n').filter(frame => frame.startsWith('data: {')).map(frame => JSON.parse(frame.slice(6)))
  assert.equal(chunks[0].choices[0].finish_reason, null)
  const next = manager.begin({ sessionId: turn.id, model: 'mimo-v2.5', messages: [{ role: 'user', content: '今天天气怎么样' }] }, 'fixture-scope')
  assert.equal(next.isContinuation, true)
  assert.equal(getConversationOptions(next.request).conversation?.sessionId, 'real-upstream-thread')
  assert.equal(getConversationOptions(next.request).conversation?.parentMessageId, 'actual-dialog')
  assert.deepEqual(next.request.messages, [{ role: 'user', content: '今天天气怎么样' }])
  next.cancel()
})

test('real MiMo streaming and non-streaming output preserve split UTF-8 text identically', async () => {
  const parts = Array.from(wire, (_, index) => wire.subarray(index, index + 1))
  const handler = new MimoStreamHandler('mimo-v2.5', 'fixture')
  const response = JSON.parse(await handler.handleNonStream(Readable.from(parts)))
  assert.equal(response.choices[0].message.content, '你好😀')
})

for (const broken of [
  'event: message\ndata: {not-json}\n\n',
  'event: error\ndata: {"message":"fixture error"}\n\n',
  'event: message\ndata: {"code":500,"content":"not success"}\n\n',
  'event: message\ndata: {"content":{"unexpected":"object"}}\n\n',
]) {
  test(`real MiMo parser cannot hide bad data behind a later finish: ${broken.split('\n')[1]}`, async () => {
    const events = [broken, 'event: finish\ndata: {}\n\n']
    await assert.rejects(consume(new MimoStreamHandler('mimo-v2.5', 'fixture').handleStream(Readable.from(events))), /MiMo returned/)
    await assert.rejects(new MimoStreamHandler('mimo-v2.5', 'fixture').handleNonStream(Readable.from(events)), /MiMo returned/)
  })
}
