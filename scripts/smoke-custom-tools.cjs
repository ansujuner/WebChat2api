/** Production IPC + HTTP checks against a loopback fixture, never a real AI account. */
const assert = require('node:assert/strict')
const http = require('node:http')

module.exports = async function verifyCustomTools({ invoke, check, port }) {
  const model = 'isolated-native-tools'
  const token = 'isolated-custom-api-key-not-a-real-secret'
  const toolName = 'chat2api_smoke_echo'
  const records = []
  let providerId, accountId, fixtureFailure, catalogFailure = false, chatBlocked = false, blockedRequests = 0
  const call = (domain, method, ...args) => invoke(`window.electronAPI.${domain}.${method}(${args.map(value => JSON.stringify(value)).join(',')})`)
  const upstream = http.createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`, 'Account credential must reach only the local fixture')
      if (req.method === 'GET') {
        assert.equal(req.url, '/v1/models')
        res.writeHead(catalogFailure ? 401 : 200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(catalogFailure ? { error: { message: token } } : { object: 'list', data: [{ id: model, object: 'model' }] }))
        return
      }
      assert.equal(req.method, 'POST')
      assert.equal(req.url, '/v1/chat/completions')
      if (chatBlocked) {
        blockedRequests += 1
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: token } }))
        return
      }
      req.setEncoding('utf8')
      let text = ''
      for await (const chunk of req) {
        text += chunk
        assert.ok(Buffer.byteLength(text) < 64 * 1024, 'Fixture accepts only a bounded diagnostic request')
      }
      const body = JSON.parse(text)
      assert.equal(body.model, model)
      assert.equal(body.tools.length, 1, 'Native tools must remain structured rather than be replaced by a prompt')
      assert.equal(body.tools[0].function.name, toolName)
      assert.ok(!JSON.stringify(body.messages).includes('<|CHAT2API|'), 'Native API must not receive managed XML scaffolding')
      assert.ok(body.messages.every(message => message.role !== 'system'), 'No diagnostic preamble should be injected into a native API')
      const toolResult = body.messages.find(message => message.role === 'tool')
      const nonce = body.tools[0].function.parameters.properties.nonce.enum[0]
      const toolCall = { id: 'call_isolated_echo', type: 'function', function: { name: toolName, arguments: JSON.stringify({ nonce }) } }
      if (toolResult) {
        const previous = body.messages.find(message => message.role === 'assistant')
        assert.ok(body.messages.some(message => message.role === 'user'), 'Stateless API requires the original user message')
        assert.equal(previous?.tool_calls?.[0]?.id, toolResult.tool_call_id, 'Tool result must follow its matching assistant invocation')
        assert.ok(typeof toolResult.content === 'string' && toolResult.content.length > 0)
      }
      records.push({ stream: !!body.stream, turn: toolResult ? 'result' : 'call', native: true })
      const finish = toolResult ? 'stop' : 'tool_calls'
      const message = toolResult ? { role: 'assistant', content: toolResult.content } : { role: 'assistant', content: null, tool_calls: [toolCall] }
      const envelope = { id: 'chatcmpl-isolated', object: 'chat.completion', model, created: 1 }
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ...envelope, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const emit = (delta, finishReason = null) => res.write(`data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
      emit({ role: 'assistant' })
      if (toolResult) emit({ content: toolResult.content })
      else {
        const args = toolCall.function.arguments
        const split = Math.floor(args.length / 2)
        emit({ tool_calls: [{ index: 0, ...toolCall, function: { name: toolName, arguments: args.slice(0, split) } }] })
        emit({ tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] })
      }
      emit({}, finish)
      res.end('data: [DONE]\n\n')
    } catch (error) {
      fixtureFailure = error
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'Isolated native tools fixture rejected the request' } }))
    }
  })
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve) })
  async function request(path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'anthropic-version': '2023-06-01', ...headers,
      } }, res => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) res.destroy(new Error('Oversized fixture response')) })
        res.once('error', reject)
        res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
      })
      req.once('error', reject)
      req.setTimeout(10000, () => req.destroy(new Error('Custom tools fixture timed out')))
      req.end(data)
    })
  }
  function parseReply(reply, anthropic, stream) {
    if (fixtureFailure) throw fixtureFailure
    assert.equal(reply.status, 200, reply.text.slice(0, 200))
    if (!stream) {
      const result = JSON.parse(reply.text)
      if (anthropic) return { call: result.content?.find(block => block.type === 'tool_use'), text: result.content?.filter(block => block.type === 'text').map(block => block.text).join(''), finish: result.stop_reason }
      const choice = result.choices[0]
      return { call: choice.message.tool_calls?.[0], text: choice.message.content, finish: choice.finish_reason }
    }
    assert.ok(reply.text.endsWith('\n\n'), 'SSE response must end with a complete frame')
    const frames = reply.text.replace(/\r\n/g, '\n').split('\n\n').filter(Boolean).map(frame => frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')).filter(Boolean)
    const events = frames.filter(value => value !== '[DONE]').map(value => JSON.parse(value))
    assert.ok(events.every(event => !event.error && event.type !== 'error'), 'No error may be disguised as successful completion')
    if (anthropic) {
      assert.equal(events.at(-1).type, 'message_stop')
      const start = events.find(event => event.type === 'content_block_start' && event.content_block.type === 'tool_use')
      const args = events.filter(event => event.type === 'content_block_delta' && event.delta.type === 'input_json_delta').map(event => event.delta.partial_json).join('')
      return { call: start ? { ...start.content_block, input: JSON.parse(args) } : undefined,
        text: events.filter(event => event.type === 'content_block_delta' && event.delta.type === 'text_delta').map(event => event.delta.text).join(''),
        finish: events.find(event => event.type === 'message_delta')?.delta.stop_reason }
    }
    assert.equal(frames.at(-1), '[DONE]')
    const choices = events.map(event => event.choices?.[0]).filter(Boolean)
    const parts = choices.flatMap(choice => choice.delta?.tool_calls || [])
    return { call: parts.length ? { id: parts[0].id, type: parts[0].type, function: { name: parts[0].function.name, arguments: parts.map(part => part.function?.arguments || '').join('') } } : undefined,
      text: choices.map(choice => choice.delta?.content || '').join(''), finish: choices.find(choice => choice.finish_reason)?.finish_reason }
  }
  const config = await call('config', 'get')
  const until = async (expression, label) => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const result = await invoke(expression)
      if (result) return result
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    throw new Error(`Custom provider UI did not settle: ${label}`)
  }
  const clickText = async labels => {
    const clicked = await invoke(`(() => { const scope=document.querySelector('[role="dialog"]') || document.querySelector('main'); const element=Array.from(scope?.querySelectorAll('button') || []).find(node=>${JSON.stringify(labels)}.includes(node.textContent.trim()) && !node.disabled); if(!element) return false; element.click(); return true })()`)
    assert.equal(clicked, true, `Expected enabled UI button: ${labels[0]}`)
  }
  const field = async (id, value) => {
    const filled = await invoke(`(() => { const node=document.getElementById(${JSON.stringify(id)}); if(!node) return false; const prototype=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(node,${JSON.stringify(value)}); node.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
    assert.equal(filled, true, `Expected UI field: ${id}`)
  }
  try {
    await invoke("window.location.hash = '#/providers'; void 0")
    const labels = ['创建自定义供应商', 'Create Custom Provider']
    await until(`Array.from(document.querySelectorAll('button')).some(node=>${JSON.stringify(labels)}.includes(node.textContent.trim())&&!node.disabled)`, 'enabled custom entry')
    await clickText(labels)
    await until(`!!document.getElementById('custom-provider-name')`, 'custom form')
    await field('custom-provider-name', 'Isolated Custom Tools')
    await field('custom-provider-url', 'file:///invalid-local-api')
    await field('custom-provider-models', model)
    const saveLabels = ['保存并添加账号', 'Save and add account']
    await clickText(saveLabels)
    await until(`!!document.querySelector('[role="dialog"] [role="alert"]')`, 'invalid URL feedback')
    assert.ok(!(await call('providers', 'getAll')).some(item => item.name === 'Isolated Custom Tools'))
    check('custom-provider-real-ui-entry-and-invalid-url-do-not-create-provider')
    await field('custom-provider-url', `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`)
    await clickText(saveLabels)
    await until(`!!document.getElementById('apiKey')`, 'key account after provider save')
    const provider = (await call('providers', 'getAll')).find(item => item.name === 'Isolated Custom Tools')
    assert.ok(provider)
    providerId = provider.id
    assert.equal(provider.apiEndpoint, `http://127.0.0.1:${upstream.address().port}/v1`)
    assert.ok(!JSON.stringify(provider).includes(token))
    await field('name', 'Isolated API account')
    await field('apiKey', token)
    await clickText(['添加账户', 'Add Account'])
    await until(`!document.getElementById('apiKey')`, 'saved key account')
    accountId = (await call('accounts', 'getAll')).find(item => item.providerId === providerId)?.id
    assert.ok(accountId)
    check('custom-provider-real-ui-save-opens-key-account-and-persists-account')
    check('custom-provider-create-normalizes-completion-url-and-keeps-key-in-account')
    const synced = await call('providers', 'updateModels', providerId)
    if (fixtureFailure) throw fixtureFailure
    assert.equal(synced.success, true, synced.error)
    assert.equal(synced.modelsCount, 1)
    check('custom-model-discovery-uses-authenticated-local-models-endpoint')
    catalogFailure = true
    const rejected = await call('providers', 'updateModels', providerId)
    catalogFailure = false
    assert.equal(rejected.success, false)
    assert.ok(!JSON.stringify(rejected).includes(token), 'Raw upstream error must not echo the account key')
    const retained = (await call('providers', 'getAll')).find(item => item.id === providerId)
    assert.ok(retained.supportedModels.includes(model), 'Failed model fetch must retain the saved model list')
    check('custom-model-discovery-error-is-redacted-and-retains-previous-list')
    await call('providers', 'update', providerId, { name: 'Isolated Custom Tools Edited', description: 'Edited in isolated smoke' })
    assert.equal((await call('providers', 'getAll')).find(item => item.id === providerId).name, 'Isolated Custom Tools Edited')
    check('custom-provider-edit-roundtrips-through-production-ipc')
    for (const clientAdapterId of ['standard-openai-tools', 'cherry-studio-mcp']) {
      await call('config', 'update', { toolCallingConfig: { enabled: true, mode: 'auto', clientAdapterId, diagnosticsEnabled: false, advanced: { promptPreviewEnabled: false } } })
      const smoke = await call('toolCalling', 'runSmoke', { model, providerId, clientAdapterId })
      if (fixtureFailure) throw fixtureFailure
      assert.equal(smoke.success, true, JSON.stringify(smoke))
      assert.deepEqual(smoke.checks.map(item => item.success), [true, true])
      check(`custom-native-tool-smoke-two-turns-via-real-ipc-${clientAdapterId}`)
    }
    for (const anthropic of [false, true]) for (const stream of [false, true]) {
      const nonce = `fixture-${anthropic ? 'anthropic' : 'openai'}-${stream ? 'stream' : 'json'}`
      const parameters = { type: 'object', properties: { nonce: { type: 'string', enum: [nonce] } }, required: ['nonce'] }
      const tools = anthropic ? [{ name: toolName, description: 'Local echo fixture', input_schema: parameters }]
        : [{ type: 'function', function: { name: toolName, description: 'Local echo fixture', parameters } }]
      const input = { role: 'user', content: `Call the echo tool using ${nonce}.` }
      const common = { model, max_tokens: 256, stream, tools }
      const route = anthropic ? '/v1/messages' : '/v1/chat/completions'
      const first = parseReply(await request(route, { ...common, messages: [input] }, { 'X-Chat2API-Client-ID': nonce, 'X-Chat2API-New-Conversation': 'true' }), anthropic, stream)
      assert.equal(first.finish, anthropic ? 'tool_use' : 'tool_calls')
      assert.ok(first.call)
      assert.equal(anthropic ? first.call.name : first.call.function.name, toolName)
      assert.deepEqual(anthropic ? first.call.input : JSON.parse(first.call.function.arguments), { nonce })
      const marker = `TOOL_RESULT_${nonce}`
      const messages = anthropic ? [input, { role: 'assistant', content: [first.call] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: first.call.id, content: marker }] }]
        : [input, { role: 'assistant', content: null, tool_calls: [first.call] }, { role: 'tool', tool_call_id: first.call.id, content: marker }]
      const second = parseReply(await request(route, { ...common, messages }, { 'X-Chat2API-Client-ID': nonce }), anthropic, stream)
      assert.equal(second.finish, anthropic ? 'end_turn' : 'stop')
      assert.equal(second.text, marker)
      assert.equal(second.call, undefined)
      check(`custom-native-tool-call-and-result-roundtrip-${anthropic ? 'anthropic' : 'openai'}-${stream ? 'streaming' : 'nonstream'}`)
    }
    assert.equal(records.length, 12)
    assert.ok(records.every(record => record.native))
    check('custom-native-all-twelve-fixture-generations-preserve-structured-tools-without-prompts')
    await invoke("window.location.hash = '#/models?tab=prompts'; void 0")
    await until(`Array.from(document.querySelectorAll('button')).some(node=>['运行测试','Run test'].includes(node.textContent.trim())&&!node.disabled)`, 'tool-test button')
    await clickText(['运行测试', 'Run test'])
    await until(`Array.from(document.querySelectorAll('[role="status"]')).some(node=>/两轮真实请求通过|Two real requests passed/.test(node.textContent))`, 'real successful tool test in UI')
    assert.equal(records.length, 14)
    check('tool-test-real-ui-button-completes-two-turn-fixture-and-displays-pass')
    chatBlocked = true
    await clickText(['运行测试', 'Run test'])
    await until(`Array.from(document.querySelectorAll('button')).some(node=>['检查账号与登录','Check accounts and login'].includes(node.textContent.trim()))`, 'account-blocked tool test in UI')
    assert.equal(blockedRequests, 1, 'Blocked UI tool test must not retry or submit a second turn')
    assert.ok(await invoke(`!document.querySelector('main').textContent.includes(${JSON.stringify(token)})`), 'UI must not expose upstream prose that echoes a credential')
    const blocked = await call('toolCalling', 'getStatus')
    assert.equal(blocked.latestSmokeResult.success, false)
    assert.equal(blocked.latestSmokeResult.category, 'provider_or_account_error')
    assert.equal(blocked.latestSmokeResult.upstreamCategory, 'access_denied')
    assert.ok(!JSON.stringify(blocked).includes(token))
    check('tool-test-real-ui-distinguishes-account-block-with-safe-guidance-and-no-retry')
  } finally {
    await call('config', 'update', { toolCallingConfig: config.toolCallingConfig })
    if (providerId) await call('providers', 'delete', providerId)
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections() })
  }
  assert.ok(!(await call('providers', 'getAll')).some(item => item.id === providerId))
  assert.ok(!(await call('accounts', 'getAll')).some(item => item.id === accountId))
  await invoke("window.location.hash = '#/'; void 0")
  check('custom-provider-delete-cascades-only-isolated-account-and-cleans-fixture')
}
