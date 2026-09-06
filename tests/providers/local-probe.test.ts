import test from 'node:test'
import assert from 'node:assert/strict'
import { probeLocalApp, type LocalProbeDependencies } from '../../src/main/diagnostics/localProbe.ts'
import { summarizeAccountAvailability } from '../../src/shared/accountAvailability.ts'

const secret = 'fixture-gateway-key-never-export'
const marker = 'CHAT2API_SMOKE_OK'
const openai = (reply = marker) => JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] })
const anthropic = () => JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: marker }], stop_reason: 'end_turn' })
function fixture(overrides: Partial<LocalProbeDependencies> = {}) {
  const requests: any[] = []
  const data = [{ id: 'deepseek-v4-flash', owned_by: 'DeepSeek' }, { id: 'GLM-5.3-Flash', owned_by: 'GLM' }]
  const deps: LocalProbeDependencies = {
    getConfig: () => ({ proxyPort: 8080, enableApiKey: true, apiKeys: [{ enabled: true, key: secret }] }),
    getStatus: () => ({ isRunning: true, port: 8081, host: '0.0.0.0' }),
    getProviders: () => [{ id: 'deepseek', name: 'DeepSeek', enabled: true }, { id: 'glm', name: 'GLM', enabled: true }],
    getEffectiveModels: id => [{ displayName: id === 'deepseek' ? 'deepseek-v4-flash' : 'GLM-5.3-Flash' }],
    getActiveAccountCount: () => 1,
    request: async options => {
      requests.push(options)
      if (options.path === '/health') return { status: 200, headers: {}, text: '{"status":"running"}' }
      if (options.path === '/v1/models') return { status: 200, headers: {}, text: JSON.stringify({ data }) }
      return { status: 200, headers: { 'x-chat2api-session-id': 'private-proxy-session-fixture' }, text: options.path === '/v1/messages' ? anthropic() : openai() }
    }, ...overrides,
  }
  return { deps, requests, data }
}

test('local probe uses actual running port/auth key internally without modifying configuration', async () => {
  const f = fixture()
  const report = await probeLocalApp(f.deps)
  assert.equal(report.status, 'ready')
  assert.equal(report.port, 8081)
  assert.equal(report.configuredPort, 8080)
  assert.equal(report.portMismatch, true)
  assert.equal(report.live, false)
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests.every(request => request.hostname === '127.0.0.1' && request.port === 8081))
  assert.equal(f.requests[0].headers.Authorization, undefined)
  assert.equal(f.requests[1].headers.Authorization, `Bearer ${secret}`)
  assert.doesNotMatch(JSON.stringify(report), /fixture-gateway-key|Authorization|apiKeys|credentials/)
})

test('local probe never sends an inference without explicit live opt-in', async () => {
  const f = fixture()
  await probeLocalApp(f.deps, { live: false, turns: 2, stream: true })
  assert.deepEqual(f.requests.map(request => request.path), ['/health', '/v1/models'])
})

test('local probe sends exactly one minimal authorized prompt per provider, never returns arbitrary responses', async () => {
  const f = fixture()
  const report = await probeLocalApp(f.deps, { live: true })
  assert.equal(report.status, 'passed')
  const inference = f.requests.filter(request => request.body)
  assert.equal(inference.length, 2)
  assert.deepEqual(inference.map(request => request.body.model), ['deepseek-v4-flash', 'GLM-5.3-Flash'])
  assert.ok(inference.every(request => request.headers['X-Chat2API-New-Conversation'] === 'true' && request.body.messages[0].content === `请只回复：${marker}`))
  assert.deepEqual(report.providers.map(provider => provider.checks[0].reply), [marker, marker])
  assert.doesNotMatch(JSON.stringify(report), /private-proxy-session-fixture/)
})

test('local probe maps GLM family to the actually logged-in Z.ai provider', async () => {
  const f = fixture({
    getProviders: () => [{ id: 'deepseek', name: 'DeepSeek', enabled: true }, { id: 'glm', name: 'GLM', enabled: true }, { id: 'zai', name: 'Z.ai', enabled: true }],
    getActiveAccountCount: id => id === 'glm' ? 0 : 1,
  })
  f.data[1].owned_by = 'Z.ai'
  const report = await probeLocalApp(f.deps, { live: true })
  assert.equal(report.status, 'passed')
  assert.deepEqual(report.providers.map(provider => provider.provider), ['deepseek', 'zai'])
})

test('local probe supports Anthropic Messages using the same private auth and catalogue', async () => {
  const f = fixture()
  const report = await probeLocalApp(f.deps, { live: true, providers: ['deepseek'], protocol: 'anthropic' })
  assert.equal(report.status, 'passed')
  assert.equal(f.requests[2].path, '/v1/messages')
  assert.equal(f.requests[2].headers['anthropic-version'], '2023-06-01')
  assert.equal(f.requests[2].headers.Authorization, `Bearer ${secret}`)
})

test('local probe two-turn check reuses proxy ID and sends only new followup input', async () => {
  const f = fixture()
  const report = await probeLocalApp(f.deps, { live: true, providers: ['deepseek'], turns: 2 })
  assert.equal(report.status, 'passed')
  assert.equal(f.requests.length, 4)
  assert.equal(f.requests[3].headers['X-Chat2API-Session-ID'], 'private-proxy-session-fixture')
  assert.equal(f.requests[3].body.messages.length, 1)
  assert.equal(f.requests[3].body.new_conversation, undefined)
  assert.equal(f.requests[3].body.session_id, undefined)
  assert.ok(!f.requests[3].body.messages[0].content.includes(marker))
})

test('local probe never weakens auth when no enabled gateway key is configured', async () => {
  const f = fixture({ getConfig: () => ({ proxyPort: 8081, enableApiKey: true, apiKeys: [{ enabled: false, key: secret }] }) })
  assert.equal((await probeLocalApp(f.deps, { live: true })).status, 'no_enabled_gateway_api_key')
  assert.equal(f.requests.length, 0)
})

test('local probe rejects external bind targets before sending private gateway credentials', async () => {
  const f = fixture({ getStatus: () => ({ isRunning: true, port: 8081, host: '192.0.2.1' }) })
  assert.equal((await probeLocalApp(f.deps, { live: true })).status, 'non_loopback_bind_not_probed')
  assert.equal(f.requests.length, 0)
})

test('local probe does not start stopped proxy or choose another unused port', async () => {
  const f = fixture({ getStatus: () => ({ isRunning: false, port: 8081 }) })
  assert.equal((await probeLocalApp(f.deps, { live: true })).status, 'proxy_not_running')
  assert.equal(f.requests.length, 0)
})

test('local probe rejects model ambiguity and inactive accounts rather than test another provider', async () => {
  const f = fixture({
    getProviders: () => [{ id: 'deepseek', name: 'DeepSeek', enabled: true }, { id: 'glm', name: 'GLM', enabled: true }, { id: 'third', name: 'Other', enabled: true }],
    getEffectiveModels: () => [{ displayName: 'deepseek-v4-flash' }],
    getActiveAccountCount: id => id === 'glm' ? 0 : 1,
  })
  const report = await probeLocalApp(f.deps, { live: true })
  assert.deepEqual(report.providers.map(provider => provider.status), ['no_unambiguous_advertised_model', 'no_active_account'])
  assert.equal(f.requests.length, 2)
})

test('local probe blocks a model mapping pinned to a different provider', async () => {
  const f = fixture({ getConfig: () => ({ enableApiKey: false, modelMappings: { 'deepseek-v4-flash': { preferredProviderId: 'glm' } } }) })
  const report = await probeLocalApp(f.deps, { live: true, providers: ['deepseek'] })
  assert.equal(report.providers[0].status, 'no_unambiguous_advertised_model')
  assert.equal(f.requests.length, 2)
})

test('local probe errors never leak token-bearing response bodies and failed submissions are not retried', async () => {
  const f = fixture()
  const request = f.deps.request!
  f.deps.request = async options => options.body ? { status: 502, headers: {}, text: '{"error":{"message":"Bearer SECRET in upstream error"}}' } : request(options)
  const report = await probeLocalApp(f.deps, { live: true, providers: ['deepseek'], turns: 2 })
  assert.equal(report.providers[0].checks.length, 1)
  assert.equal(report.providers[0].checks[0].error, 'http_502')
  assert.doesNotMatch(JSON.stringify(report), /SECRET|Bearer/)
})

test('local probe does not expose unexpected model-generated text', async () => {
  const f = fixture()
  const request = f.deps.request!
  f.deps.request = async options => options.body ? { status: 200, headers: {}, text: openai('unexpected SECRET output') } : request(options)
  const report = await probeLocalApp(f.deps, { live: true, providers: ['deepseek'] })
  assert.equal(report.providers[0].checks[0].error, 'unexpected_reply')
  assert.doesNotMatch(JSON.stringify(report), /SECRET/)
})

test('local probe exposes only whitelisted static Z.ai failure categories', async () => {
  const f = fixture()
  const request = f.deps.request!
  f.deps.request = async options => options.body ? { status: 500, headers: {}, text: '{"error":{"message":"Z.ai upstream captcha_required (code 403)"}}' } : request(options)
  assert.equal((await probeLocalApp(f.deps, { live: true, providers: ['glm'] })).providers[0].checks[0].error, 'captcha_required')
  f.deps.request = async options => options.body ? { status: 500, headers: {}, text: '{"error":{"message":"Z.ai upstream SECRET-token"}}' } : request(options)
  const report = await probeLocalApp(f.deps, { live: true, providers: ['glm'] })
  assert.equal(report.providers[0].checks[0].error, 'http_500')
  assert.doesNotMatch(JSON.stringify(report), /SECRET/)
})

for (const protocol of ['openai', 'anthropic'] as const) {
  test(`local probe ${protocol} streaming requires protocol terminal success`, async () => {
    const f = fixture()
    const request = f.deps.request!
    const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
    const content = protocol === 'openai'
      ? chunk({ choices: [{ index: 0, delta: { content: marker }, finish_reason: 'stop' }] })
      : chunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: marker } }) + chunk({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
    const terminal = protocol === 'openai' ? 'data: [DONE]\n\n' : chunk({ type: 'message_stop' })
    f.deps.request = async options => options.body ? { status: 200, headers: {}, text: content + terminal } : request(options)
    assert.equal((await probeLocalApp(f.deps, { live: true, providers: ['deepseek'], protocol, stream: true })).status, 'passed')
    f.deps.request = async options => options.body ? { status: 200, headers: {}, text: content } : request(options)
    assert.equal((await probeLocalApp(f.deps, { live: true, providers: ['deepseek'], protocol, stream: true })).providers[0].checks[0].error, 'incomplete_response')
  })
}

test('local probe rejects extra providers or unbounded generation settings before reading app state', async () => {
  const f = fixture({ getConfig: () => { throw new Error('Should not read state') } })
  for (const options of [{ providers: ['unknown'] }, { providers: ['deepseek', 'deepseek'] }, { turns: 100 }, { live: 'true' }]) {
    await assert.rejects(probeLocalApp(f.deps, options as any), /invalid_probe_options/)
  }
})

test('catalogue diagnosis distinguishes stored credentials from schedulable accounts without exposing identities', async () => {
  const until = Date.now() + 3600000
  const accounts = [{ status: 'active', enabled: false, name: secret },
    { status: 'active', cooldownReason: 'temporary_ban' as const, cooldownUntil: until, credentials: {token: secret} }]
  const scheduling = summarizeAccountAvailability(accounts)
  assert.deepEqual(scheduling, {total:2, available:0, disabled:1, coolingDown:1, nextRecoveryAt:until})
  const f = fixture({getActiveAccountCount: () => scheduling.available, getAccountScheduling: () => scheduling})
  const report = await probeLocalApp(f.deps, { live:true, providers:['deepseek'] })
  assert.equal(report.providers[0].status, 'no_active_account')
  assert.equal(report.providers[0].scheduling?.nextRecoveryAt, until)
  assert.equal(f.requests.filter(request => request.body).length, 0)
  assert.doesNotMatch(JSON.stringify(report), /fixture-gateway|credentials|name|token/)
})
