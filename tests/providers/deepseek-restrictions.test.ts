import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable, PassThrough } from 'node:stream'
import { parseDeepSeekRestriction, readDeepSeekErrorBody, DeepSeekAccountRestrictionError } from '../../src/main/proxy/adapters/deepseek-restrictions.ts'
import { DeepSeekStreamHandler } from '../../src/main/proxy/adapters/deepseek-stream.ts'

const now = Date.UTC(2026, 8, 6)
const until = now + 3600000

test('official DeepSeek HTTP mute code uses data.end_at epoch seconds', () => {
  assert.deepEqual(parseDeepSeekRestriction({ code: 50006, data: { end_at: until / 1000 } }, 'api', now), { kind: 'temporary', until })
  assert.deepEqual(parseDeepSeekRestriction({ code: '50006', data: { end_at: String(until / 1000) } }, 'api', now), { kind: 'temporary', until })
})
test('DeepSeek completion code 5 is scoped to completion and extracts mute_until', () => {
  const payload = { code: 0, data: { biz_code: 5, biz_data: { mute_until: until / 1000 } } }
  assert.equal(parseDeepSeekRestriction(payload, 'api', now), undefined)
  assert.deepEqual(parseDeepSeekRestriction(payload, 'completion', now), { kind: 'temporary', until })
  assert.deepEqual(parseDeepSeekRestriction({ error: { code: 5, data: { mute_until: until / 1000 } } }, 'completion', now), { kind: 'temporary', until })
})
test('DeepSeek user metadata can indicate a muted account with a valid token', () => {
  assert.deepEqual(parseDeepSeekRestriction({ data: { biz_data: { token: 'never-export', user: { chat: { is_muted: true, mute_until: until / 1000 } } } } }, 'api', now), { kind: 'temporary', until })
})
test('permanent suspension never invents a recovery date', () => {
  assert.deepEqual(parseDeepSeekRestriction({ code: 40012, data: { end_at: until / 1000 } }, 'api', now), { kind: 'permanent' })
  const error = new DeepSeekAccountRestrictionError({ kind: 'permanent' })
  assert.equal(error.code, 'account_banned')
  assert.equal(error.restriction.until, undefined)
})
test('missing, past, malformed or millisecond expiry pauses pending review rather than guessing', () => {
  for (const end_at of [undefined, null, -1, 0, now / 1000 - 1, NaN, Infinity, until, 'tomorrow', '2026-09-07 00:00:00']) {
    assert.deepEqual(parseDeepSeekRestriction({ code: 50006, data: { end_at } }, 'api', now), { kind: 'temporary' })
  }
})
test('model text, tool arguments, generic forbidden and unrelated numeric business errors never suspend accounts', () => {
  for (const value of [null, [], 'account banned until tomorrow', { error: 'account banned' }, { code: 403 },
    { code: 429, message: 'rate limited' }, { v: '{"code":50006}' },
    { v: { response: { fragments: [{ content: '{"code":50006}', type: 'ANSWER' }] } } },
    { code: 0, data: { biz_code: 10 } }, { data: { biz_data: { user: { chat: { is_muted: false, mute_until: until / 1000 } } } } }]) {
    assert.equal(parseDeepSeekRestriction(value, 'completion', now), undefined)
  }
})
test('bounded error response reader accepts split JSON but rejects oversized or truncated transport', async () => {
  const expected = { code: 50006, data: { end_at: until / 1000 } }
  const wire = JSON.stringify(expected)
  assert.deepEqual(await readDeepSeekErrorBody(Readable.from([wire.slice(0, 7), wire.slice(7)])), expected)
  assert.equal(await readDeepSeekErrorBody(Readable.from(['x'.repeat(65537)])), undefined)
  assert.equal(await readDeepSeekErrorBody('x'.repeat(65537)), undefined)
  const source = new PassThrough()
  const pending = readDeepSeekErrorBody(source)
  source.write('{"code":50006'); source.destroy()
  assert.equal(await pending, undefined)
})
for (const streaming of [true, false]) {
  test(`DeepSeek ${streaming ? 'streaming' : 'nonstream'} error metadata notifies suspension and never yields a completed reply`, async () => {
    const future = Date.now() + 3600000
    const source = Readable.from([`data: ${JSON.stringify({ code: 5, data: { mute_until: Math.ceil(future / 1000) } })}\n\n`, 'data: [DONE]\n\n'])
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash', 'fixture-session')
    const notices: unknown[] = []
    handler.setAccountRestrictionListener(value => notices.push(value))
    const run = async () => {
      if (!streaming) return handler.handleNonStream(source)
      const output = await handler.handleStream(source)
      for await (const _ of output) { /* Do not accept a successful terminal. */ }
    }
    await assert.rejects(run, /temporarily suspended/)
    assert.deepEqual(notices, [{ kind: 'temporary', until: Math.ceil(future / 1000) * 1000 }])
  })
}
test('stream listener persistence failures become a stream error, not an uncaught event callback', async () => {
  const handler = new DeepSeekStreamHandler('deepseek-v4-flash', 'fixture-session')
  handler.setAccountRestrictionListener(() => { throw Error('fixture-secret-must-not-escape') })
  const source = Readable.from(['data: {"code":50006}\n\n'])
  await assert.rejects(async () => { for await (const _ of await handler.handleStream(source)) {} }, /suspension could not be saved/)
})
