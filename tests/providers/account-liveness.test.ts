import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountLivenessService, AccountLivenessError, selectLivenessModel, validateAccountLivenessInput,
  summarizeAccountLivenessJob, type AccountLivenessDependencies, type LivenessAccount } from '../../src/main/diagnostics/accountLiveness.ts'

const validReply = () => ({ success: true, status: 200, body: { choices: [{ message: { role: 'assistant', content: 'OK。' }, finish_reason: 'stop' }] } })
const account = (id: string, extra: Partial<LivenessAccount> = {}): LivenessAccount => ({ id, name: `${id}@example.test`, providerId: 'deepseek', status: 'active', revision: 'private-credential-digest', ...extra })
function fixture(options: Partial<AccountLivenessDependencies> = {}, initial = [account('a'), account('b')]) {
  let accounts = initial
  const calls: Array<{ id: string; model: any; signal: AbortSignal }> = [], counted: string[] = []
  const deps: AccountLivenessDependencies = {
    getAccounts: () => accounts,
    getAccount: id => accounts.find(account => account.id === id),
    getProvider: id => ({ id, enabled: true, revision: 'private-endpoint-digest' }),
    getModels: () => [{ displayName: 'deepseek-v4-pro', actualModelId: 'expert' }, { displayName: 'deepseek-v4-flash', actualModelId: 'chat' }],
    forward: async (id, model, signal) => { calls.push({ id, model, signal }); return validReply() },
    recordSuccess: id => { counted.push(id) }, ...options,
  }
  const service = new AccountLivenessService(deps)
  const run = async (input: unknown = {}) => { const start = service.start(input); return (await service.wait(start.id))! }
  return { deps, service, run, calls, counted, setAccounts(next: LivenessAccount[]) { accounts = next } }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

test('liveness all is serial, binds exact IDs/models, counts each successful completed reply once and exports no upstream data', async () => {
  let active = 0, maxActive = 0
  const ids: string[] = []
  const f = fixture({ forward: async (id, model, signal) => {
    active++; maxActive = Math.max(maxActive, active); ids.push(id)
    assert.equal(model.actualModelId, 'chat'); assert.equal(signal.aborted, false)
    await turn(); active--; return { ...validReply(), headers: { Authorization: 'private-token' }, error: 'private-error', providerSessionId: 'private-session' }
  } })
  const report = await f.run()
  assert.equal(report.state, 'completed'); assert.deepEqual(report.results.map(item => item.status), ['passed', 'passed'])
  assert.deepEqual(ids, ['a', 'b']); assert.equal(maxActive, 1); assert.deepEqual(f.counted, ['a', 'b'])
  assert.doesNotMatch(JSON.stringify(report), /private-|Authorization|credentials|body|choices/)
})

test('liveness validates bounds, unknown keys and mutually exclusive selectors before any dependency call', () => {
  for (const input of [null, [], 'a', 1, { accountIds: [] }, { accountIds: 'a' }, { accountIds: [null] },
    { accountIds: ['../secret'] }, { accountIds: Array(1001).fill('a') }, { providerId: '' }, { providerId: 'a b' },
    { providerId: 'x', accountIds: ['a'] }, { rawPrompt: 'private-data' }, { stream: true }]) {
    assert.throws(() => validateAccountLivenessInput(input), AccountLivenessError)
  }
  assert.deepEqual(validateAccountLivenessInput({ accountIds: ['a', 'a', 'b'] }), { accountIds: ['a', 'b'] })
  let reads = 0
  const f = fixture({ getAccounts: () => { reads++; return [] } })
  assert.throws(() => f.service.start({ secret: 'not-an-option' }))
  assert.equal(reads, 0); assert.deepEqual(f.calls, [])
})

test('provider batch with one disabled account is still batch; explicit single can test it without changing enabled/auth state', async () => {
  const original = account('a', { enabled: false, status: 'expired' }), f = fixture({}, [original])
  const batch = await f.run({ providerId: 'deepseek' })
  assert.equal(batch.mode, 'batch'); assert.equal(batch.results[0].reason, 'disabled'); assert.equal(f.calls.length, 0)
  const single = await f.run({ accountIds: ['a'] })
  assert.equal(single.mode, 'single'); assert.equal(single.results[0].status, 'passed'); assert.equal(f.calls.length, 1)
  assert.equal(original.enabled, false); assert.equal(original.status, 'expired')
})

test('expired/error credential flags can be tested explicitly, but a known permanent ban is never probed', async () => {
  const f = fixture({}, [account('a', { status: 'expired' }), account('b', { status: 'error' }),
    account('c', { status: 'error', errorMessage: 'DeepSeek account suspended; manual review required.' })])
  const report = await f.run()
  assert.deepEqual(report.results.map(item => item.status), ['passed', 'passed', 'skipped'])
  assert.equal(report.results[2].reason, 'account_banned'); assert.deepEqual(f.calls.map(call => call.id), ['a', 'b'])
})

test('cooldown, invalid deadlines and daily quota block even an explicit manually-disabled single test', async () => {
  const until = Date.now() + 600000
  for (const [extra, reason] of [
    [{ cooldownUntil: until, cooldownReason: 'temporary_ban' }, 'cooldown'],
    [{ cooldownReason: 'temporary_ban' }, 'cooldown'], [{ cooldownUntil: NaN }, 'cooldown'],
    [{ dailyLimit: 1, todayUsed: 1 }, 'daily_limit'],
  ] as const) {
    const f = fixture({}, [account('a', { ...extra, enabled: false, status: 'error' })])
    const report = await f.run({ accountIds: ['a'] })
    assert.equal(report.results[0].reason, reason); assert.equal(report.results[0].status, 'skipped')
    assert.equal(f.calls.length, 0); assert.deepEqual(f.counted, [])
  }
  const ready = fixture({}, [account('a', { cooldownUntil: Date.now() - 1000, cooldownReason: 'temporary_ban' })])
  assert.equal((await ready.run()).results[0].status, 'passed')
})

test('provider-disabled is skipped only for batch and explicit probe does not enable provider', async () => {
  const provider = { id: 'deepseek', enabled: false }
  const f = fixture({ getProvider: () => provider }, [account('a')])
  assert.equal((await f.run()).results[0].reason, 'provider_disabled')
  assert.equal((await f.run({ accountIds: ['a'] })).results[0].status, 'passed')
  assert.equal(provider.enabled, false)
})

test('missing account/provider and missing text models yield truthful skips without alternate-account fallback', async () => {
  const f = fixture({ getProvider: () => undefined })
  assert.equal((await f.run({ accountIds: ['missing'] })).results[0].reason, 'account_missing')
  assert.equal((await f.run({ accountIds: ['a'] })).results[0].reason, 'provider_missing')
  assert.equal(f.calls.length, 0)
  const imageOnly = fixture({ getModels: () => [{ displayName: 'arena/image/seedream', actualModelId: 'image-id' }] })
  assert.equal((await imageOnly.run({ accountIds: ['a'] })).results[0].reason, 'no_text_model')
  assert.equal(imageOnly.calls.length, 0)
})

test('liveness checks require a complete nonempty assistant text reply, not just HTTP 200', async () => {
  const bodies = [{}, { choices: [] }, { error: 'private-error', ...validReply().body },
    ...[null, 'length', 'tool_calls', 'content_filter'].map(finish_reason => ({ choices: [{ ...validReply().body.choices[0], finish_reason }] })),
    ...['', '   ', null, 'x'.repeat(65537), '中'.repeat(30000)].map(content => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] })),
    { choices: [{ finish_reason: 'stop', message: { role: 'user', content: 'OK' } }] },
    ...[[{}], {}, 'invalid', 1].map(tool_calls => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK', tool_calls } }] })),
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OK', function_call: { name: 'unexpected' } } }] }]
  for (const body of bodies) {
    const f = fixture({ forward: async () => ({ success: true, status: 200, body }) })
    const report = await f.run({ accountIds: ['a'] })
    assert.equal(report.results[0].reason, 'incomplete_response'); assert.deepEqual(f.counted, [])
  }
})

test('safe typed failure categories preserve restriction/retry status without raw upstream messages', async () => {
  for (const [status, errorCode, expected] of [
    [429, 'account_temporarily_suspended', 'cooldown'], [429, 'account_banned', 'account_banned'],
    [429, 'rate_limited', 'rate_limited'], [401, '', 'auth_required'], [403, '', 'action_required'],
    [503, 'quota_unavailable', 'quota_unavailable'], [504, '', 'timeout'], [502, '', 'request_failed'],
    [502, 'browser_unavailable', 'browser_unavailable'], [404, 'model_unavailable', 'model_unavailable'],
    [502, 'incomplete_response', 'incomplete_response'], [403, 'action_required', 'action_required'],
  ] as const) {
    let calls = 0
    const f = fixture({ forward: async () => { calls++; return { success: false, status, errorCode, error: 'private-token-response', headers: { 'retry-after': '60' } } } })
    const report = await f.run({ accountIds: ['a'] })
    assert.equal(report.results[0].reason, expected); assert.equal(calls, 1)
    assert.ok(report.results[0].retryAt! > Date.now()); assert.doesNotMatch(JSON.stringify(report), /private-token/)
  }
})

test('transport rejection fails once then continues with the next selected account, not a retry substitute', async () => {
  const calls: string[] = []
  const f = fixture({ forward: async id => { calls.push(id); if (id === 'a') throw Error('private-profile-path'); return validReply() } })
  const report = await f.run()
  assert.deepEqual(calls, ['a', 'b']); assert.deepEqual(report.results.map(result => result.status), ['failed', 'passed'])
  assert.doesNotMatch(JSON.stringify(report), /private-profile/)
})

test('cancel stops only future items and keeps the job busy until the current request really settles', async () => {
  let resolve!: (result: ReturnType<typeof validReply>) => void
  const calls: string[] = []
  const f = fixture({ forward: async id => { calls.push(id); return new Promise(done => { resolve = done }) } })
  const started = f.service.start({}); await turn()
  const cancelled = f.service.cancel(started.id)!
  assert.equal(cancelled.state, 'cancelling'); assert.equal(cancelled.results[1].status, 'cancelled')
  assert.throws(() => f.service.start({ accountIds: ['a'] }), /already running/)
  resolve(validReply())
  const final = (await f.service.wait(started.id))!
  assert.equal(final.state, 'cancelled'); assert.deepEqual(calls, ['a'])
  assert.equal(final.results[0].status, 'passed'); assert.deepEqual(f.counted, ['a'])
})

test('timeout signals abort but cannot unlock or claim a late response is a pass', async () => {
  let resolve!: (result: ReturnType<typeof validReply>) => void, signal!: AbortSignal
  const f = fixture({ deadlineMs: 5, forward: async (_id, _model, incoming) => {
    signal = incoming; return new Promise(done => { resolve = done })
  } }, [account('a')])
  const initial = f.service.start({})
  await new Promise(done => setTimeout(done, 15))
  assert.equal(signal.aborted, true)
  assert.equal(f.service.get()!.state, 'running'); assert.throws(() => f.service.start({}), /already running/)
  resolve(validReply())
  const result = (await f.service.wait(initial.id))!.results[0]
  assert.equal(result.reason, 'timeout'); assert.deepEqual(f.counted, [])
})

test('queued state is re-read: disabling or deleting a later account prevents its submission', async () => {
  let f: ReturnType<typeof fixture>
  const ids: string[] = []
  f = fixture({ forward: async id => { ids.push(id); f.setAccounts([account('a'), account('b', { enabled: false })]); return validReply() } })
  const report = await f.run()
  assert.equal(report.results[1].reason, 'disabled'); assert.deepEqual(ids, ['a'])
})

test('an account credential identity changing during a probe cannot inherit the old reply or success counter', async () => {
  let f: ReturnType<typeof fixture>
  f = fixture({ forward: async () => { f.setAccounts([account('a', { revision: 'replacement-credentials' })]); return validReply() } })
  const report = await f.run({ accountIds: ['a'] })
  assert.equal(report.results[0].reason, 'account_changed'); assert.deepEqual(f.counted, [])
})

test('progress snapshots are detached and unsubscribing prevents further events', async () => {
  const f = fixture(), events: string[] = []
  const stop = f.service.subscribe(job => { events.push(job.state); job.results[0].accountName = 'injected'; job.results.splice(0) })
  const result = await f.run()
  assert.ok(events.length > 1); assert.equal(result.results.length, 2); assert.equal(result.results[0].accountName, 'a@example.test')
  const count = events.length; stop(); await f.run({ accountIds: ['b'] }); assert.equal(events.length, count)
  const detached = f.service.get()!; detached.results[0].status = 'failed'
  assert.equal(f.service.get()!.results[0].status, 'passed')
})

test('empty target set completes without generating and stale cancellation cannot cancel a newer job', async () => {
  const f = fixture({}, [])
  const first = await f.run(); assert.equal(first.state, 'completed'); assert.deepEqual(first.results, [])
  const second = f.service.start({}); f.service.cancel(first.id)
  assert.equal((await f.service.wait(second.id))!.state, 'completed'); assert.equal(await f.service.wait(first.id), null)
})

test('same-millisecond jobs have ordered identities and progress timestamps never precede their initial snapshot', async () => {
  const f = fixture({ now: () => 1000 }, [account('a')])
  const snapshots: any[] = []
  f.service.subscribe(job => snapshots.push(job))
  const first = await f.run(), second = await f.run()
  assert.ok(second.startedAt > first.startedAt)
  assert.ok(snapshots.every(job => job.updatedAt >= job.startedAt && (!job.finishedAt || job.finishedAt >= job.startedAt)))
})

test('model selection prefers lightweight text and rejects wildcard/image/audio-only routes', () => {
  assert.equal(selectLivenessModel('arena', [{ displayName: 'arena/image/max', actualModelId: 'i' }, { displayName: 'arena/text/max', actualModelId: 't' }])?.actualModelId, 't')
  for (const displayName of ['*', 'arena/image/max', 'text-embedding-3', 'whisper-1', 'tts-1', 'rerank-v2', 'gpt-image-1', 'imagen-4']) {
    assert.equal(selectLivenessModel('custom', [{ displayName, actualModelId: displayName }]), undefined)
  }
  assert.equal(selectLivenessModel('custom', [{ displayName: 'friendly alias', actualModelId: 'gpt-image-1' }]), undefined)
})

test('CLI summary excludes email, account IDs, credential identity and job IDs while preserving skip/fail truth', async () => {
  const f = fixture({}, [account('private-account-id', { enabled: false }), account('b')])
  const job = await f.run(), report = summarizeAccountLivenessJob(job)
  assert.deepEqual(report.counts, { total: 2, passed: 1, failed: 0, skipped: 1, cancelled: 0 })
  assert.equal(report.status, 'needs_attention')
  assert.doesNotMatch(JSON.stringify(report), /@example|private-account|private-credential|accountName|accountId/)
  assert.equal(JSON.stringify(report).includes(job.id), false)
})
