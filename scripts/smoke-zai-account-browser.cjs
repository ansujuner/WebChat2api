/** Actual production renderer -> preload -> account service -> browser -> store.
 * Only the website responses are fixtures. No OAuth/account IPC handler is mocked.
 * The parent enforces a disposable profile; no real credentials or website calls.
 */
const assert = require('node:assert/strict')

module.exports = async function verifyZaiAccountBrowser({ invoke, check, app, BrowserWindow }) {
  const origin = 'https://chat.z.ai'
  const identity = { id: 'isolated-zai-browser-user', email: 'zai-browser@example.invalid', name: 'Fixture user' }
  const jwt = version => [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify({ ...identity, exp: Math.floor(Date.now() / 1000) + 3600, version })).toString('base64url'),
    Buffer.from('fixture-not-a-real-signature').toString('base64url')].join('.')
  const originalToken = jwt(1), freshToken = jwt(2)
  const name = 'Isolated Z.ai browser restore'
  const cooldownUntil = Date.now() + 600000
  const requests = [], sessions = []
  let accountId, fixtureFailure
  const call = (method, ...args) => invoke(`window.electronAPI.accounts.${method}(${args.map(value => JSON.stringify(value)).join(',')})`)
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Isolated Z.ai website fixture</title></head><body data-auth="loading"><main>Checking account</main><script>
    async function renderAccount(){
      const token=localStorage.getItem('token');
      const response=await fetch('/api/v1/auths/',{headers:token?{Authorization:'Bearer '+token}:{},credentials:'include'});
      const user=await response.json(); const signedIn=response.ok&&user.id&&user.email&&!user.email.endsWith('@guest.com');
      if(signedIn&&user.token)localStorage.setItem('token',user.token);
      document.body.dataset.auth=signedIn?'signed-in':'guest';
      document.querySelector('main').innerHTML=signedIn?'<p>Signed in to fixture account</p><textarea placeholder="Message"></textarea>':'<button>登录</button>';
    }
    void renderAccount();
  </script></body></html>`
  const installWebsite = session => {
    sessions.push(session)
    session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      const url = new URL(details.url)
      callback({ cancel: url.origin !== origin && url.hostname !== '127.0.0.1' })
    })
    session.protocol.handle('https', async request => {
      const url = new URL(request.url)
      try {
        assert.equal(url.origin, origin, 'A restore must never send credentials to another origin')
        if (url.pathname === '/' || url.pathname === '/auth') {
          requests.push('page')
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
        if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })
        throw new Error('Unexpected website request in the account restore fixture')
      } catch (error) {
        fixtureFailure = error
        return new Response('Fixture request rejected', { status: 400 })
      }
    })
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
    await call('delete', accountId)
    accountId = null
    await until(async () => windows[0].isDestroyed(), 'account-owned browser closed on deletion')
    check('zai-account-delete-clears-only-that-account-browser-session')
  } finally {
    if (accountId) await call('delete', accountId)
    app.off('session-created', installWebsite)
    for (const session of sessions) session.protocol.unhandle('https')
  }
  await invoke("window.location.hash = '#/'; void 0")
}
