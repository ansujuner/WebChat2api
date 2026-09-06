const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { randomUUID } = require('node:crypto')

const root = path.resolve(__dirname, '../..')
const origin = 'https://chat.z.ai'
const fixture = require('../../scripts/smoke-zai-account-browser.cjs')
const prompts = ['你好，请只回复 OK。', '记住标记 ZAI-FIXTURE-FIRST，只回复 OK。', '继续上一轮，只回复 OK。']

// Capture the fixture's actual protocol handler before the first account IPC.
// No Electron process, website, user profile, or generation is opened by this test.
async function website() {
  const stop = new Error('Fixture-only setup boundary')
  let handler, originalToken, unhandled = false, revoked = false
  const session = {
    webRequest: { onBeforeRequest() {} },
    protocol: {
      handle(scheme, value) { assert.equal(scheme, 'https'); handler = value },
      unhandle(scheme) { assert.equal(scheme, 'https'); assert.equal(revoked, true); unhandled = true },
    },
  }
  await assert.rejects(fixture({
    allowFixtureOrigin(target, allowed) {
      assert.equal(target, session); assert.equal(allowed, origin); assert.equal(typeof handler, 'function')
      return () => { revoked = true }
    },
    app: { on(event, listener) { assert.equal(event, 'session-created'); listener(session) }, off() {} },
    invoke: async expression => {
      assert.ok(expression.startsWith('window.electronAPI.accounts.add('))
      const input = JSON.parse(expression.slice('window.electronAPI.accounts.add('.length, -1))
      originalToken = input.credentials.token
      throw stop
    },
  }), error => error === stop)
  assert.equal(unhandled, true)
  const send = (pathname, options = {}) => handler(new Request(origin + pathname, options))
  const auth = await send('/api/v1/auths/', { headers: { Authorization: `Bearer ${originalToken}` } })
  assert.equal(auth.status, 200)
  const token = (await auth.json()).token
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  return { send, headers }
}

test('Z.ai production fixture wires the real IPC and loopback route, not mocked account handlers', () => {
  const harness = fs.readFileSync(path.join(root, 'scripts/smoke-app.cjs'), 'utf8')
  const source = fs.readFileSync(path.join(root, 'scripts/smoke-zai-account-browser.cjs'), 'utf8')
  assert.match(harness, /require\('\.\/smoke-zai-account-browser\.cjs'\)\(\{ invoke, check, app, BrowserWindow, port, request, allowFixtureOrigin \}\)/)
  assert.match(harness, /productionProfileUsed: false/)
  assert.match(source, /call\('livenessStart', \{ accountIds: \[accountId\] \}\)/)
  assert.equal((source.match(/await request\(port, '\/v1\/chat\/completions'/g) || []).length, 2)
  assert.match(source, /first\.body\.choices\[0\]\.message, \{ role: 'user', content: prompts\[2\] \}/)
  assert.match(source, /second\.headers\['x-chat2api-conversation'\], 'continued'/)
  assert.match(source, /turnTwo\.parentId, turnOne\.assistantId/)
  assert.match(source, /turnTwo\.parentId, 'conflicting-untrusted-terminal-id'/)
  assert.match(source, /config\.enableApiKey, false/)
  assert.match(source, /config\.proxyHost, '127\.0\.0\.1'/)
  assert.doesNotMatch(source, /ipcMain|readFile|process\.env|disable-web-security|remote-debugging/)
})

test('actual Z.ai fixture serves idless SSE and persisted scoped graph across both browser turns', async () => {
  const { send, headers } = await website()
  const page = await (await send('/')).text()
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)[1]
  assert.doesNotThrow(() => new vm.Script(script), 'The inline website fixture must be executable JavaScript')
  assert.match(script, /current_user_message_id:userMessageId/)
  assert.match(script, /parentId=graph\.chat\.history\.currentId/)
  assert.match(script, /history\.replaceState/)
  const livenessChat = randomUUID(), chatId = randomUUID()
  let parentId = null
  for (let index = 0; index < prompts.length; index++) {
    const id = randomUUID(), userId = randomUUID(), currentChat = index === 0 ? livenessChat : chatId
    const body = { model: 'x-preview-l', messages: [{ role: 'user', content: prompts[index] }],
      chat_id: currentChat, id, current_user_message_id: userId,
      current_user_message_parent_id: index === 2 ? parentId : null,
      features: { enable_thinking: true, auto_web_search: false } }
    const response = await send('/api/v2/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    const frames = (await response.text()).trim().split('\n\n').map(frame => JSON.parse(frame.slice('data: '.length)))
    assert.equal(frames.length, 2)
    assert.equal(frames[0].data.delta_content, 'OK')
    assert.equal(frames[0].data.id, undefined)
    assert.equal(frames[0].data.role, undefined)
    assert.equal(frames[1].data.done, true)
    if (index === 1) {
      assert.equal(frames[1].data.id, 'conflicting-untrusted-terminal-id')
      assert.notEqual(frames[1].data.id, id)
    } else {
      assert.equal(frames[1].data.id, undefined)
      assert.equal(frames[1].data.role, undefined)
    }
    const graphResponse = await send('/api/v1/chats/' + currentChat, { headers })
    assert.equal(graphResponse.status, 200)
    const graph = (await graphResponse.json()).chat.history
    assert.equal(graph.currentId, id)
    assert.deepEqual(graph.messages[userId], { id: userId, role: 'user', parentId: index === 2 ? parentId : null,
      childrenIds: [id], content: prompts[index] })
    assert.equal(graph.messages[id].role, 'assistant')
    assert.equal(graph.messages[id].parentId, userId)
    assert.equal(graph.messages[id].done, true)
    assert.equal(graph.messages[id].model, 'x-preview-l')
    if (index === 2) {
      assert.deepEqual(graph.messages[parentId].childrenIds, [userId])
      assert.equal(Object.keys(graph.messages).length, 4)
      assert.ok(Object.values(graph.messages).some(message => message.content === prompts[1]))
    }
    if (index === 1) {
      parentId = id
      assert.equal((await send('/c/' + chatId)).status, 200, 'Continuation navigation uses the existing browser graph')
    }
  }
})

test('background settings check is a negative read-only fixture, not browser identity proof', async () => {
  const { send, headers } = await website()
  assert.equal((await send('/api/v1/users/user/settings', { headers })).status, 401)
  assert.equal((await send('/api/v1/users/user/settings', { method: 'POST', headers })).status, 400)
})

test('Z.ai fixture rejects unknown graph scope and credentials without touching a website', async () => {
  const { send, headers } = await website()
  assert.equal((await send('/api/v1/chats/unknown-chat', { headers })).status, 400)
  assert.equal((await send('/api/v1/chats/unknown-chat', { headers: { Authorization: 'Bearer wrong-fixture-token' } })).status, 400)
  assert.equal((await send('/c/unknown-chat')).status, 400)
})
