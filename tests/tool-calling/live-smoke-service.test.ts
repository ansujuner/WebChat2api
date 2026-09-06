import test from 'node:test'
import assert from 'node:assert/strict'
import { probeToolCalling, type ToolCallingSmokeDependencies } from '../../src/main/diagnostics/toolCallingSmoke.ts'
import { DEFAULT_TOOL_CALLING_CONFIG } from '../../src/shared/toolCalling.ts'

const SECRET = 'fixture-gateway-key-never-export'
const SESSION = 'private-gateway-session'
const response = (data: unknown, status = 200) => ({ status, headers: { 'x-chat2api-session-id': SESSION }, text: JSON.stringify(data) })
function fixture(overrides: Partial<ToolCallingSmokeDependencies> = {}) {
  const requests: any[] = []
  const config = { enableApiKey: true, apiKeys: [{ enabled: true, key: SECRET }], toolCallingConfig: structuredClone(DEFAULT_TOOL_CALLING_CONFIG) }
  const deps: ToolCallingSmokeDependencies = {
    getConfig: () => config,
    getStatus: () => ({ isRunning: true, host: '0.0.0.0', port: 8081 }),
    getProviders: () => [{ id: 'deepseek', name: 'DeepSeek', enabled: true }, { id: 'zai', name: 'Z.ai', enabled: true }],
    getEffectiveModels: id => [{ displayName: id === 'deepseek' ? 'deepseek-v4-flash' : 'GLM-fixture' }],
    getActiveAccountCount: () => 1,
    request: async options => {
      requests.push(options)
      if (options.path === '/health') return response({ status: 'running' })
      if (options.path === '/v1/models') return response({ data: [{ id: 'deepseek-v4-flash', owned_by: 'DeepSeek' }, { id: 'GLM-fixture', owned_by: 'Z.ai' }] })
      const body = options.body as any
      if (body.messages[0].role === 'tool') return response({ choices: [{ message: { role: 'assistant', content: body.messages[0].content }, finish_reason: 'stop' }] })
      return response({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-fixture', type: 'function', function: {
        name: body.tools[0].function.name, arguments: JSON.stringify({ nonce: body.tools[0].function.parameters.properties.nonce.enum[0] }),
      } }] }, finish_reason: 'tool_calls' }] })
    }, ...overrides,
  }
  return { deps, requests, config }
}

test('tool smoke requires two successful model generations and a consumed local mock result', async () => {
  const f = fixture()
  const original = JSON.stringify(f.config)
  const result = await probeToolCalling(f.deps)
  assert.equal(result.success, true)
  assert.equal(result.category, 'pass')
  assert.equal(result.model, 'deepseek-v4-flash')
  assert.equal(result.providerId, 'deepseek')
  assert.deepEqual(result.checks, [{ stage: 'tool_call', success: true, httpStatus: 200 }, { stage: 'tool_result', success: true, httpStatus: 200 }])
  assert.equal(f.requests.length, 4)
  const [first, second] = f.requests.filter(request => request.body)
  assert.ok(f.requests.every(request => request.hostname === '127.0.0.1' && request.port === 8081))
  assert.equal(first.headers.Authorization, `Bearer ${SECRET}`)
  assert.equal(first.headers['X-Chat2API-New-Conversation'], 'true')
  assert.equal(second.headers['X-Chat2API-Session-ID'], SESSION)
  assert.equal(second.body.messages.length, 1)
  assert.equal(second.body.messages[0].role, 'tool')
  assert.equal(second.body.messages[0].tool_call_id, 'call-fixture')
  assert.ok(!JSON.stringify(first.body).includes(second.body.messages[0].content))
  assert.deepEqual(first.body.tools, second.body.tools)
  assert.equal(first.body.tool_choice, second.body.tool_choice)
  assert.equal(JSON.stringify(f.config), original)
  assert.doesNotMatch(JSON.stringify(result), /fixture-gateway|private-gateway|Authorization|apiKeys|credentials|nonce|CHAT2API_TOOL_OK/)
})

test('tool smoke tests the selected actual provider/model rather than a fixture-only model name', async () => {
  const f = fixture()
  const result = await probeToolCalling(f.deps, { model: 'GLM-fixture', providerId: 'zai' })
  assert.equal(result.success, true)
  assert.equal(result.providerId, 'zai')
  assert.ok(f.requests.filter(request => request.body).every(request => request.body.model === 'GLM-fixture'))
})

test('Arena image-only aliases cannot appear as automatic or explicitly selected tool smoke candidates', async () => {
  const imageModel = 'arena/image/fixture-image-model'
  for (const input of [{}, { model: imageModel, providerId: 'arena' }]) {
    const f = fixture({
      getProviders: () => [{ id: 'arena', name: 'Arena', enabled: true }],
      getEffectiveModels: () => [{ displayName: imageModel }],
    })
    const result = await probeToolCalling(f.deps, input)
    assert.equal(result.success, false)
    assert.equal(result.failureCode, 'no_available_model')
    assert.equal(f.requests.length, 0)
  }
})

test('Arena image aliases are skipped while text aliases remain eligible for two-turn tool smoke', async () => {
  const model = 'arena/text/fixture-text-model'
  const f = fixture({
    getProviders: () => [{ id: 'arena', name: 'Arena', enabled: true }],
    getEffectiveModels: () => [{ displayName: 'arena/image/fixture-image-model' }, { displayName: model }],
  })
  const request = f.deps.request!
  f.deps.request = async options => options.path === '/v1/models'
    ? response({ data: [{ id: model, owned_by: 'Arena' }] }) : request(options)
  const result = await probeToolCalling(f.deps)
  assert.equal(result.success, true)
  assert.equal(result.model, model)
  assert.equal(result.providerId, 'arena')
  assert.ok(f.requests.filter(request => request.body).every(request => request.body.model === model))
  assert.equal(f.requests.filter(request => request.body).length, 2)
})

test('saved Cherry MCP adapter is exercised without changing configuration', async () => {
  const f = fixture()
  f.config.toolCallingConfig.clientAdapterId = 'cherry-studio-mcp'
  const result = await probeToolCalling(f.deps, { clientAdapterId: 'cherry-studio-mcp' })
  assert.equal(result.success, true)
  assert.equal(result.clientAdapterId, 'cherry-studio-mcp')
})

test('tool smoke rejects unknown/unavailable selections, stopped proxy and disabled configuration without any generation', async () => {
  for (const [options, override, code] of [
    [{ model: 'tool-smoke-test' }, {}, 'no_available_model'],
    [{ providerId: 'unknown' }, {}, 'no_available_model'],
    [{ clientAdapterId: 'cherry-studio-mcp' }, {}, 'unsaved_client_adapter'],
    [{}, { getActiveAccountCount: () => 0 }, 'no_available_model'],
    [{}, { getStatus: () => ({ isRunning: false, port: 8081 }) }, 'proxy_not_running'],
    [{}, { getStatus: () => ({ isRunning: true, port: 8081, host: '192.0.2.1' }) }, 'non_loopback_bind'],
    [{}, { getConfig: () => ({ toolCallingConfig: { ...DEFAULT_TOOL_CALLING_CONFIG, enabled: false } }) }, 'tool_calling_disabled'],
    [{}, { getConfig: () => ({ enableApiKey: true, apiKeys: [] }) }, 'no_gateway_key'],
  ] as const) {
    const f = fixture(override as Partial<ToolCallingSmokeDependencies>)
    const result = await probeToolCalling(f.deps, options)
    assert.equal(result.success, false)
    assert.equal(result.failureCode, code)
    assert.equal(f.requests.length, 0)
  }
})

test('invalid smoke options are rejected before reading app state', async () => {
  const f = fixture({ getConfig: () => { throw new Error('Must not read configuration') } })
  for (const input of [{ model: '' }, { clientAdapterId: 'unsupported' }, { command: 'not allowed' }, { model: 1 }]) {
    await assert.rejects(probeToolCalling(f.deps, input as any), /Invalid tool test/)
  }
})

test('HTTP 200 with no tool call or unparsed wrapper is a genuine failure, never a generated-fixture pass', async () => {
  for (const content of ['Just a text response', '<|CHAT2API|tool_calls>not parsed']) {
    const f = fixture()
    const request = f.deps.request!
    f.deps.request = async options => options.body ? response({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }) : request(options)
    const result = await probeToolCalling(f.deps)
    assert.equal(result.success, false)
    assert.equal(result.checks.length, 1)
    assert.ok(['model_did_not_call_tool', 'parser_failed'].includes(result.category))
  }
})

for (const [name, mutate, code] of [
  ['unknown tool', (call: any) => { call.function.name = 'exec_shell' }, 'unexpected_tool_name'],
  ['malformed JSON', (call: any) => { call.function.arguments = '{' }, 'invalid_tool_arguments'],
  ['JSON array', (call: any) => { call.function.arguments = '[]' }, 'invalid_tool_arguments'],
  ['wrong nonce', (call: any) => { call.function.arguments = '{"nonce":"wrong"}' }, 'invalid_tool_arguments'],
  ['extra capabilities', (call: any) => { call.function.arguments = '{"nonce":"wrong","command":"SECRET"}' }, 'invalid_tool_arguments'],
  ['missing ID', (call: any) => { delete call.id }, 'invalid_tool_identity'],
] as const) {
  test(`tool smoke blocks ${name} and executes no arbitrary capability`, async () => {
    const f = fixture()
    const request = f.deps.request!
    f.deps.request = async options => {
      const result = await request(options)
      if (!options.body) return result
      const value = JSON.parse(result.text)
      mutate(value.choices[0].message.tool_calls[0])
      return response(value)
    }
    const result = await probeToolCalling(f.deps)
    assert.equal(result.failureCode, code)
    assert.equal(f.requests.filter(request => request.body).length, 1)
    assert.doesNotMatch(JSON.stringify(result), /SECRET|exec_shell|wrong|fixture-gateway/)
  })
}

test('tool smoke stops if conversation ID is missing instead of starting a new second conversation', async () => {
  const f = fixture()
  const request = f.deps.request!
  f.deps.request = async options => ({ ...await request(options), headers: {} })
  const result = await probeToolCalling(f.deps)
  assert.equal(result.failureCode, 'missing_conversation_id')
  assert.equal(f.requests.filter(request => request.body).length, 1)
})

test('tool smoke stops on configuration changes between the two turns', async () => {
  const f = fixture()
  const request = f.deps.request!
  f.deps.request = async options => {
    const result = await request(options)
    if (options.body) f.config.toolCallingConfig.clientAdapterId = 'cherry-studio-mcp'
    return result
  }
  assert.equal((await probeToolCalling(f.deps)).failureCode, 'settings_changed')
  assert.equal(f.requests.filter(request => request.body).length, 1)
})

test('a wrong second reply is redacted and fails the roundtrip test even with HTTP 200', async () => {
  const f = fixture()
  const request = f.deps.request!
  f.deps.request = async options => {
    const result = await request(options)
    return (options.body as any)?.messages[0].role === 'tool' ? response({ choices: [{ message: { role: 'assistant', content: 'SECRET ignored tool result' }, finish_reason: 'stop' }] }) : result
  }
  const result = await probeToolCalling(f.deps)
  assert.equal(result.failureCode, 'tool_result_not_consumed')
  assert.deepEqual(result.checks.map(check => check.success), [true, false])
  assert.equal(f.requests.filter(request => request.body).length, 2)
  assert.doesNotMatch(JSON.stringify(result), /SECRET/)
})

test('transport errors never export arbitrary errors or automatically retry a submitted generation', async () => {
  const f = fixture()
  const request = f.deps.request!
  let generated = 0
  f.deps.request = async options => {
    if (options.body) { generated++; throw new Error(`SECRET ${SECRET}`) }
    return request(options)
  }
  const result = await probeToolCalling(f.deps)
  assert.equal(result.failureCode, 'connection_failed_not_retried')
  assert.equal(generated, 1)
  assert.doesNotMatch(JSON.stringify(result), /SECRET|fixture-gateway/)
})
