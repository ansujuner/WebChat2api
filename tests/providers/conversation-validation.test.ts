import test from 'node:test'
import assert from 'node:assert/strict'
import { ConversationContinuity, getConversationOptions } from '../../src/main/proxy/conversationContinuity.ts'
import { ConversationStream } from '../../src/main/proxy/conversationStream.ts'
import { AnthropicStream } from '../../src/main/proxy/anthropic/stream.ts'

const frame = (value: unknown) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
const delta = (value: unknown, finish_reason: unknown = null) => frame({ choices: [{ index: 0, delta: value, finish_reason }] })
const ending = delta({}, 'stop') + frame('[DONE]')
const tool = (extra = {}) => ({ index: 0, id: 'call_valid', type: 'function', function: { name: 'echo', arguments: '{}' }, ...extra })
function fixture() {
  const manager = new ConversationContinuity()
  const turn = manager.begin({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }] }, 'scope')
  turn.bind({ providerId: 'arena', accountId: 'fixture-account', actualModel: 'fixture' })
  getConversationOptions(turn.request).onConversation!({ sessionId: 'fixture-native-id' })
  return { manager, turn, next: () => manager.begin({ model: 'fixture', session_id: turn.id, messages: [{ role: 'user', content: 'next' }] }, 'scope') }
}
async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let text = ''
  for await (const chunk of stream as any) text += chunk.toString()
  return text
}

for (const [name, body] of [
  ['invalid original role', delta({ role: 'user', content: 'not an assistant' }) + ending],
  ['non-function tool type', delta({ tool_calls: [tool({ type: 'shell' })] }) + ending],
  ['missing tool index', delta({ tool_calls: [tool({ index: undefined })] }) + ending],
  ['negative tool index', delta({ tool_calls: [tool({ index: -1 })] }) + ending],
  ['duplicate tool identity', delta({ tool_calls: [tool(), tool({ index: 1 })] }) + ending],
  ['non-object tool input', delta({ tool_calls: [tool({ function: { name: 'echo', arguments: '[]' } })] }) + ending],
  ['empty tools terminal', delta({}, 'tool_calls') + frame('[DONE]')],
  ['multiple choices', frame({ choices: [{ index: 0, delta: { content: 'one' } }, { index: 1, delta: { content: 'two' } }] }) + ending],
  ['content after finish', delta({ content: 'first' }, 'stop') + delta({ content: 'unexpected' }) + frame('[DONE]')],
  ['conflicting finish', delta({}, 'length') + ending],
  ['event error without error field', 'event: error\n' + frame({ message: 'fixture-secret-must-not-leak' }) + ending],
  ['type error without error field', frame({ type: 'error', message: 'fixture-secret-must-not-leak' }) + ending],
  ['legacy function_call', delta({ function_call: { name: 'echo', arguments: '{}' } }) + ending],
  ['non-string content', delta({ content: { secret: 'fixture-secret-must-not-leak' } }) + ending],
] as const) test(`stream validation rejects ${name} before completing a resumable turn`, async () => {
  const f = fixture(), observer = new ConversationStream(f.turn)
  let received = ''
  observer.on('data', chunk => { received += chunk.toString() })
  const failed = assert.rejects(collect(observer), error => {
    assert.doesNotMatch(String(error), /fixture-secret-must-not-leak/)
    return true
  })
  observer.end(body)
  await failed
  assert.doesNotMatch(received, /\[DONE\]/)
  assert.throws(f.next, /did not finish reliably/)
})

test('invalid UTF-8 cannot commit replacement-character history before the Anthropic converter rejects it', async () => {
  const f = fixture(), observer = new ConversationStream(f.turn), output = new AnthropicStream()
  observer.on('error', error => output.fail(error))
  observer.pipe(output)
  const result = collect(output)
  observer.end(Buffer.concat([Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"'), Buffer.from([0xff]), Buffer.from('"}}]}\n\n' + ending)]))
  const text = await result
  assert.match(text, /event: error/)
  assert.doesNotMatch(text, /event: message_stop/)
  assert.throws(f.next, /did not finish reliably/)
})

test('stream validator supports stateless n=1 streams and preserves byte-split CR/CRLF frames and comments', async () => {
  for (const newline of ['\r', '\r\n']) {
    let validated = false
    const observer = new ConversationStream(undefined, (message, reason) => { validated = true; assert.equal(message.content, '你好🙂'); assert.equal(reason, 'stop') })
    const bytes = Buffer.from((': comment\n\n' + delta({ role: 'assistant', content: '你好🙂' }) + ending).replace(/\n/g, newline) + ': trailing comment')
    const result = collect(observer)
    for (const byte of bytes) observer.write(Buffer.from([byte]))
    observer.end()
    assert.equal(await result, bytes.toString())
    assert.equal(validated, true)
  }
})
