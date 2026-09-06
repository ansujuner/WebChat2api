/** Actual production renderer -> preload -> account service -> browser -> store.
 * Only the website responses are fixtures. No OAuth/account IPC handler is mocked.
 * The parent enforces a disposable profile; no real credentials or website calls.
 */
const assert = require('node:assert/strict')

module.exports = async function verifyZaiAccountBrowser({ invoke, check, app, BrowserWindow, port, request, allowFixtureOrigin }) {
  const origin = 'https://chat.z.ai'
  const identity = { id: 'isolated-zai-browser-user', email: 'zai-browser@example.invalid', name: 'Fixture user' }
  const jwt = version => [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify({ ...identity, exp: Math.floor(Date.now() / 1000) + 3600, version })).toString('base64url'),
    Buffer.from('fixture-not-a-real-signature').toString('base64url')].join('.')
  const originalToken = jwt(1), freshToken = jwt(2)
  const name = 'Isolated Z.ai browser restore'
  const cooldownUntil = Date.now() + 600000
  const requests = [], sessions = [], generations = [], graphReads = [], conversationPages = []
  const revokeOrigins = []
  const chats = new Map()
  const prompts = ['你好，请只回复 OK。', '记住标记 ZAI-FIXTURE-FIRST，只回复 OK。', '继续上一轮，只回复 OK。']
  let accountId, fixtureFailure, proxyStarted = false
  const call = (method, ...args) => invoke(`window.electronAPI.accounts.${method}(${args.map(value => JSON.stringify(value)).join(',')})`)
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Isolated Z.ai website fixture</title></head><body data-auth="loading"><main>Checking account</main><script>
    async function renderAccount(){
      const token=localStorage.getItem('token');
      const response=await fetch('/api/v1/auths/',{headers:token?{Authorization:'Bearer '+token}:{},credentials:'include'});
      const user=await response.json(); const signedIn=response.ok&&user.id&&user.email&&!user.email.endsWith('@guest.com');
      if(signedIn&&user.token)localStorage.setItem('token',user.token);
      document.body.dataset.auth=signedIn?'signed-in':'guest';
      document.querySelector('main').innerHTML=signedIn?'<p>Signed in to fixture account</p><form><button type="button" id="model-selector-x-preview-l-button">GLM-5.3-Flash</button><button type="button" data-active="false">Search</button><textarea id="chat-input" placeholder="Message"></textarea><button type="button" id="send-message-button">Send</button></form>':'<button>登录</button>';
      if(signedIn) {
        document.getElementById('send-message-button').disabled=true;
        let chatId=location.pathname.startsWith('/c/')?location.pathname.slice(3):null, parentId=null;
        if(chatId) {
          const existing=await fetch('/api/v1/chats/'+encodeURIComponent(chatId),{headers:{Authorization:'Bearer '+localStorage.getItem('token')}});
          if(!existing.ok)throw new Error('Fixture conversation missing');
          const graph=await existing.json(); parentId=graph.chat.history.currentId;
          document.body.dataset.restoredChat=chatId; document.body.dataset.restoredParent=parentId;
          const history=document.createElement('section'); history.id='conversation-history';
          history.textContent=Object.values(graph.chat.history.messages).map(message=>message.content).join(' | ');
          document.querySelector('main').prepend(history);
        }
        document.querySelector('button[data-active]').onclick=e=>{e.currentTarget.dataset.active=e.currentTarget.dataset.active==='true'?'false':'true'};
        document.getElementById('send-message-button').onclick=async()=>{
          const prompt=document.getElementById('chat-input').value;
          // Normal website preparation is represented by a fixture flag, never a real CAPTCHA proof.
          document.body.dataset.prepared='true';
          chatId=chatId||crypto.randomUUID();
          const requestId=crypto.randomUUID(), userMessageId=crypto.randomUUID();
          const body={model:'x-preview-l',messages:[{role:'user',content:prompt}],chat_id:chatId,id:requestId,current_user_message_id:userMessageId,current_user_message_parent_id:parentId,
            features:{enable_thinking:true,auto_web_search:document.querySelector('button[data-active]').dataset.active==='true'}};
          const reply=await fetch('/api/v2/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+localStorage.getItem('token')},body:JSON.stringify(body)});
          await reply.text(); parentId=requestId; history.replaceState(null,'','/c/'+chatId); document.getElementById('chat-input').value='';
        };
        document.getElementById('send-message-button').disabled=false;
      }
    }
    void renderAccount();
  </script></body></html>`
  const installWebsite = session => {
    sessions.push(session)
    session.protocol.handle('https', async request => {
      const url = new URL(request.url)
      try {
        assert.equal(url.origin, origin, 'A restore must never send credentials to another origin')
        if (url.pathname === '/' || url.pathname === '/auth' || /^\/c\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) {
          requests.push('page')
          if (url.pathname.startsWith('/c/')) {
            const chatId = url.pathname.slice(3)
            assert.ok(chats.has(chatId), 'A continued page must load a stored fixture conversation')
            conversationPages.push(chatId)
          }
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        }
        if (url.pathname === '/api/v1/auths/') {
          assert.equal(request.method, 'GET', 'Login verification must not generate a chat')
          const authorization = request.headers.get('authorization')
          const recognized = [`Bearer ${originalToken}`, `Bearer ${freshToken}`].includes(authorization)
          requests.push(recognized ? 'authenticated' : 'guest')
          return new Response(JSON.stringify(recognized ? { ...identity, token: freshToken, role: 'user' }
            : { id: 'guest', email: 'fixture@guest.com', name: 'Guest', token: 'fixture-guest-token', role: 'user' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        if (url.pathname === '/api/v1/users/user/settings') {
          // The provider-card background credential check has its own scoped
          // transport now. It must not stand in for verified browser restoration.
          assert.equal(request.method, 'GET')
          return new Response('{}', { status: 401, headers: { 'Content-Type': 'application/json' } })
        }
        if (/^\/api\/v1\/chats\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)) {
          assert.equal(request.method, 'GET', 'Cursor recovery must be read-only')
          assert.equal(request.headers.get('authorization'), `Bearer ${freshToken}`)
          const chatId = url.pathname.slice('/api/v1/chats/'.length)
          const graph = chats.get(chatId)
          assert.ok(graph, 'Cursor lookup must stay scoped to a submitted fixture chat')
          graphReads.push({ chatId, assistantId: graph.chat.history.currentId })
          return new Response(JSON.stringify(graph), { headers: { 'Content-Type': 'application/json' } })
        }
        if (url.pathname === '/api/v2/chat/completions') {
          assert.equal(request.method, 'POST')
          assert.equal(request.headers.get('authorization'), `Bearer ${freshToken}`)
          const body = await request.json()
          assert.equal(body.model, 'x-preview-l')
          assert.ok(generations.length < prompts.length, 'The fixture permits exactly three submissions and no retries')
          assert.deepEqual(body.messages, [{ role: 'user', content: prompts[generations.length] }], 'Only the current prompt is submitted, never replayed context')
          for (const field of ['chat_id', 'id', 'current_user_message_id']) assert.match(body[field], /^[A-Za-z0-9_-]{1,128}$/)
          assert.notEqual(body.id, body.current_user_message_id, 'Assistant and user graph IDs must be distinct')
          const previous = chats.get(body.chat_id)
          assert.equal(body.current_user_message_parent_id, previous?.chat.history.currentId ?? null)
          assert.equal(Boolean(previous), generations.length === 2, 'Only the second OpenAI turn may continue an existing chat')
          assert.equal(body.features.enable_thinking, true)
          assert.equal(body.features.auto_web_search, false)
          const assistantId = body.id, userMessageId = body.current_user_message_id
          assert.ok(!generations.some(item => item.assistantId === assistantId || item.userMessageId === userMessageId), 'Every submission must have fresh graph nodes')
          const previousMessages = previous?.chat.history.messages || {}
          const parentId = body.current_user_message_parent_id
          const messages = { ...previousMessages,
            ...(parentId ? { [parentId]: { ...previousMessages[parentId], childrenIds: [userMessageId] } } : {}),
            [userMessageId]: { id: userMessageId, role: 'user', parentId, childrenIds: [assistantId], content: body.messages[0].content },
            [assistantId]: { id: assistantId, role: 'assistant', parentId: userMessageId, childrenIds: [], content: 'OK', model: body.model, done: true },
          }
          chats.set(body.chat_id, { id: body.chat_id, chat: { history: { currentId: assistantId, messages } } })
          generations.push({ model: body.model, prompt: body.messages[0].content, chatId: body.chat_id, assistantId, userMessageId, parentId })
          // No role/id in ordinary SSE. One adversarial terminal claims a different assistant:
          // the subsequent turn must still use the verified graph, never this untrusted hint.
          const frame = data => 'data: ' + JSON.stringify({ type: 'chat:completion', data }) + '\n\n'
          const terminalHint = generations.length === 2 ? { role: 'assistant', id: 'conflicting-untrusted-terminal-id' } : {}
          return new Response(frame({ phase: 'answer', delta_content: 'OK' }) + frame({ phase: 'done', done: true, ...terminalHint }),
            { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
        }
        if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
        throw new Error(`Unexpected website request in the account restore fixture: ${request.method} ${url.pathname}`)
      } catch (error) {
        fixtureFailure = error
        return new Response('Fixture request rejected', { status: 400 })
      }
    })
    // The outer fixture firewall remains installed when the real browser proxy
    // manager replaces its own webRequest listener. Only our intercepted origin
    // is permitted, and only while this protocol fixture remains installed.
    revokeOrigins.push(allowFixtureOrigin(session, origin))
  }
  const until = async (predicate, label) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (fixtureFailure) throw fixtureFailure
      if (await predicate()) return
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    throw new Error(`Z.ai browser restore fixture timed out: ${label}`)
  }
  const click = async (labels, selector = 'button') => {
    assert.equal(await invoke(`(() => { const scope=document.querySelector('[role="dialog"]')||document; const node=Array.from(scope.querySelectorAll(${JSON.stringify(selector)})).find(node=>${JSON.stringify(labels)}.includes(node.textContent.trim())&&!node.disabled); if(!node)return false; if(node.getAttribute('role')==='tab')node.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,ctrlKey:false})); node.click(); return true })()`), true, `Missing control: ${labels[0]}`)
  }
  app.on('session-created', installWebsite)
  try {
    const account = await call('add', { providerId: 'zai', name, nameSource: 'custom', email: identity.email,
      providerUserId: identity.id, credentials: { token: originalToken, captcha_verify_param: 'old-fixture-captcha' }, dailyLimit: 23 })
    accountId = account.id
    await call('update', accountId, { enabled: false, cooldownUntil, cooldownReason: 'temporary_ban', status: 'expired', errorMessage: 'Fixture expired authentication' })
    const baseline = await call('getById', accountId, true)
    // Leave a previous provider's mounted account view before selecting this fixture provider.
    await invoke("new Promise(resolve => { window.location.hash = '#/'; requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))) })")
    await invoke("window.location.hash = '#/providers'; void 0")
    await until(() => invoke(`!!document.querySelector('img[alt="Z.ai"]')`), 'provider page')
    assert.equal(await invoke(`(() => { const card=document.querySelector('img[alt="Z.ai"]').closest('.glass-card'); const node=Array.from(card.querySelectorAll('button')).find(node=>['账户管理','Accounts'].includes(node.textContent.trim())); if(!node)return false; node.click(); return true })()`), true)
    await until(() => invoke(`!!document.querySelector('span[title=${JSON.stringify(name)}]')`), 'account card')
    await invoke(`(() => { const node=document.querySelector('span[title=${JSON.stringify(name)}]').closest('.glass-card').querySelector('button[aria-haspopup="menu"]'); node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,ctrlKey:false,pointerType:'mouse'})); })()`)
    await until(() => invoke(`!!document.querySelector('[role="menuitem"]')`), 'account menu')
    await click(['编辑账户', 'Edit Account'], '[role="menuitem"]')
    await until(() => invoke(`!!document.querySelector('[role="dialog"] #name')`), 'edit dialog')
    await click(['OAuth 登录', 'OAuth Login'], '[role="tab"]')
    await until(() => invoke(`!!document.querySelector('[data-testid="account-oauth-login"]')`), 'account-bound login button')
    assert.equal(await invoke(`(() => { const node=document.querySelector('[data-testid="account-oauth-login"]'); if(!node||node.disabled)return false; node.click(); return true })()`), true)
    await until(async () => (await call('getById', accountId, true))?.credentials.token === freshToken, 'real browser authentication and automatic save')
    const updated = await call('getById', accountId, true)
    assert.equal(updated.credentialRevision, baseline.credentialRevision + 1)
    assert.equal(updated.status, 'active')
    assert.ok(!updated.errorMessage)
    assert.equal(updated.credentials.captcha_verify_param, undefined)
    assert.equal(updated.enabled, false)
    assert.equal(updated.cooldownUntil, cooldownUntil)
    assert.equal(updated.dailyLimit, 23)
    assert.equal(updated.name, name)
    assert.equal((await call('getAll')).length, 1)
    check('zai-existing-account-real-ui-restores-owned-token-and-auto-saves-only-after-website-auth')
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.webContents.getURL().startsWith(origin))
    assert.equal(windows.length, 1)
    await until(() => windows[0].webContents.executeJavaScript(`document.body.dataset.auth==='signed-in'&&!Array.from(document.querySelectorAll('button')).some(node=>node.textContent==='登录')`), 'website itself signed in')
    assert.equal(await windows[0].webContents.executeJavaScript(`localStorage.getItem('token')===${JSON.stringify(freshToken)}`), true)
    assert.ok(requests.includes('authenticated'))
    check('zai-account-website-shows-signed-in-state-and-stays-open-after-verified-save')
    await until(() => invoke(`!document.querySelector('[data-testid="account-oauth-login"]')?.disabled`), 'UI received persisted result')
    const resumed = await call('reauthenticate', accountId)
    assert.equal(resumed.success, true)
    assert.equal(resumed.state, 'restored')
    assert.equal((await call('getById', accountId, true)).credentialRevision, updated.credentialRevision)
    assert.equal(BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.webContents.getURL().startsWith(origin)).length, 1)
    check('zai-reopen-reuses-only-owned-window-and-does-not-pretend-unchanged-credentials-were-written')
    await click(['取消', 'Cancel'])
    await call('clearSuspension', accountId) // Synthetic fixture only; do not alter a real upstream restriction.
    const beforeLive = await call('getById', accountId, true)
    const job = await call('livenessStart', { accountIds: [accountId] })
    await until(async () => (await call('livenessGet'))?.state === 'completed', 'website-backed account liveness')
    const result = await call('livenessGet')
    assert.equal(result.id, job.id)
    assert.equal(result.results.length, 1)
    assert.equal(result.results[0].status, 'passed', `Website-backed liveness failed: ${result.results[0].reason}`)
    assert.equal(generations.length, 1, 'Exactly one normal website submission; no API fallback or retry')
    const afterLive = await call('getById', accountId, true)
    assert.equal(afterLive.credentialRevision, beforeLive.credentialRevision, 'A website token refresh is not a manual credential edit')
    assert.equal(afterLive.enabled, false)
    check('zai-liveness-real-ipc-uses-normal-website-input-and-one-captured-sse-response')
    const apiPages = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed() && window.webContents.getURL().startsWith(origin) && window !== windows[0])
    assert.equal(apiPages.length, 1)
    assert.equal(apiPages[0].webContents.session, windows[0].webContents.session)
    assert.equal(await apiPages[0].webContents.executeJavaScript("document.body.dataset.prepared==='true'"), true)
    assert.equal(await windows[0].webContents.executeJavaScript("document.body.dataset.prepared==='true'"), false)
    check('zai-api-chat-page-shares-only-the-owned-session-and-leaves-user-login-page-untouched')

    const config = await invoke('window.electronAPI.config.get()')
    assert.equal(config.enableApiKey, false, 'Only this disposable no-key fixture is allowed')
    assert.equal(config.proxyHost, '127.0.0.1')
    assert.equal((await invoke('window.electronAPI.proxy.getStatus()')).isRunning, false)
    await call('setEnabled', accountId, true) // Only the synthetic account; ordinary liveness above preserved manual disable.
    assert.equal(await invoke(`window.electronAPI.proxy.start(${JSON.stringify(port)})`), true)
    proxyStarted = true
    assert.equal((await invoke('window.electronAPI.proxy.getStatus()')).port, port)
    const first = await request(port, '/v1/chat/completions', {
      model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: prompts[1] }], stream: false,
    })
    if (fixtureFailure) throw fixtureFailure
    assert.equal(first.status, 200, `First OpenAI website turn failed: ${first.body?.error?.code}`)
    const sessionId = first.headers['x-chat2api-session-id']
    assert.match(sessionId, /^c2a-[a-f0-9-]{36}$/)
    assert.equal(first.headers['x-chat2api-conversation'], 'new')
    assert.equal(first.body.session_id, sessionId)
    assert.equal(first.body.choices[0].message.content, 'OK')
    assert.equal(first.body.choices[0].finish_reason, 'stop')
    assert.ok(graphReads.some(read => read.assistantId === generations[1].assistantId), 'The first committed turn must resolve its persisted assistant graph node')
    check('zai-openai-first-turn-commits-scoped-graph-cursor-not-conflicting-terminal-id')
    const second = await request(port, '/v1/chat/completions', {
      model: 'GLM-5.3-Flash', session_id: sessionId, stream: false,
      messages: [{ role: 'user', content: prompts[1] }, first.body.choices[0].message, { role: 'user', content: prompts[2] }],
    })
    if (fixtureFailure) throw fixtureFailure
    assert.equal(second.status, 200, `Continued OpenAI website turn failed: ${second.body?.error?.code}`)
    assert.equal(second.headers['x-chat2api-session-id'], sessionId)
    assert.equal(second.headers['x-chat2api-conversation'], 'continued')
    assert.equal(second.body.session_id, sessionId)
    assert.equal(second.body.choices[0].message.content, 'OK')
    assert.equal(second.body.choices[0].finish_reason, 'stop')
    assert.equal(generations.length, 3, 'One IPC liveness and two HTTP turns; no hidden generation or retry')
    const [, turnOne, turnTwo] = generations
    assert.equal(turnTwo.chatId, turnOne.chatId)
    assert.notEqual(turnTwo.assistantId, turnOne.assistantId)
    assert.equal(turnTwo.parentId, turnOne.assistantId)
    assert.notEqual(turnTwo.parentId, 'conflicting-untrusted-terminal-id')
    assert.equal(turnTwo.prompt, prompts[2])
    assert.ok(conversationPages.includes(turnOne.chatId))
    assert.ok(graphReads.some(read => read.assistantId === turnTwo.assistantId), 'The continuation must commit the new persisted assistant, not the previous cursor')
    assert.equal(await apiPages[0].webContents.executeJavaScript(`document.body.dataset.restoredParent===${JSON.stringify(turnOne.assistantId)}&&document.getElementById('conversation-history').textContent.includes(${JSON.stringify(prompts[1])})`), true)
    assert.equal(await windows[0].webContents.executeJavaScript("document.body.dataset.prepared==='true'"), false)
    check('zai-openai-continuation-reuses-chat-new-assistant-and-only-current-prompt')
    assert.equal(await invoke('window.electronAPI.proxy.stop()'), true)
    proxyStarted = false
    await call('delete', accountId)
    accountId = null
    await until(async () => windows[0].isDestroyed(), 'account-owned browser closed on deletion')
    assert.equal(apiPages[0].isDestroyed(), true)
    check('zai-account-delete-clears-only-that-account-browser-session')
  } finally {
    if (proxyStarted) await invoke('window.electronAPI.proxy.stop()')
    if (accountId) await call('delete', accountId)
    app.off('session-created', installWebsite)
    for (const revoke of revokeOrigins) revoke()
    for (const session of sessions) session.protocol.unhandle('https')
  }
  await invoke("window.location.hash = '#/'; void 0")
}
