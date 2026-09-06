/** Existing-account UI/IPC regression. The parent supplies an isolated profile.
 * Only the OAuth IPC response is synthetic: no website or login window is opened.
 */
const assert = require('node:assert/strict')

module.exports = async function verifyAccountRelogin({ invoke, check, ipcMain }) {
  const channel = 'oauth:startInAppLogin'
  const name = 'Isolated existing Z.ai account'
  const oldToken = 'isolated-relogin-old-token'
  const newToken = 'isolated-relogin-new-token'
  const identity = { userId: 'isolated-zai-user', email: 'isolated-zai@example.invalid' }
  const cooldownUntil = Date.now() + 600000
  let accountId, finishLogin, loginCount = 0
  const call = (method, ...args) => invoke(`window.electronAPI.accounts.${method}(${args.map(value => JSON.stringify(value)).join(',')})`)
  const until = async (expression, label) => {
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (typeof expression === 'function' ? expression() : await invoke(expression)) return
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    const state = await invoke(`(() => { const dialog=document.querySelector('[role="dialog"]'); return {buttons:Array.from(dialog?.querySelectorAll('button')||[]).map(node=>({label:node.textContent.trim(),disabled:node.disabled})),status:dialog?.querySelector('[role="status"]')?.textContent||'',feedback:Array.from(dialog?.querySelectorAll('.text-red-500')||[]).map(node=>node.textContent).join(';')} })()`)
    throw new Error(`Account re-login UI did not settle: ${label}; isolated UI state: ${JSON.stringify(state)}`)
  }
  const clickText = async (labels, selector = 'button') => {
    const clicked = await invoke(`(() => { const scope=document.querySelector('[role="dialog"]') || document; const node=Array.from(scope.querySelectorAll(${JSON.stringify(selector)})).find(node=>${JSON.stringify(labels)}.includes(node.textContent.trim())&&!node.disabled); if(!node)return false; if(node.getAttribute('role')==='tab')node.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,ctrlKey:false})); node.click(); return true })()`)
    assert.equal(clicked, true, `Expected enabled UI control: ${labels[0]}`)
  }
  const edit = async () => {
    await until(`!!document.querySelector('span[title=${JSON.stringify(name)}]')`, 'existing account card')
    assert.equal(await invoke(`(() => { const card=document.querySelector('span[title=${JSON.stringify(name)}]').closest('.glass-card'); const trigger=card?.querySelector('button[aria-haspopup="menu"]'); if(!trigger)return false; trigger.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,ctrlKey:false,pointerType:'mouse'})); return true })()`), true)
    await until(`!!document.querySelector('[role="menuitem"]')`, 'account menu')
    await clickText(['编辑账户', 'Edit Account'], '[role="menuitem"]')
    await until(`!!document.querySelector('[role="dialog"] #name')`, 'edit dialog')
    assert.equal(await invoke(`document.getElementById('name').value`), name)
    await clickText(['OAuth 登录', 'OAuth Login'], '[role="tab"]')
    await until(`Array.from(document.querySelectorAll('[role="dialog"] button')).some(node=>['重新登录','Sign in again'].includes(node.textContent.trim())&&!node.disabled)`, 'existing-account OAuth entry')
  }
  const cancel = async () => {
    await clickText(['取消', 'Cancel'])
    await until(`!document.querySelector('[role="dialog"]')`, 'closed edit dialog')
  }
  // Replace only the login boundary in this short-lived test process. Real
  // production renderer, preload, account update and encrypted store are retained.
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (_event, input) => {
    assert.equal(input.providerId, 'zai')
    assert.equal(input.providerType, 'zai')
    loginCount += 1
    return new Promise(resolve => { finishLogin = resolve })
  })
  try {
    const account = await call('add', { providerId: 'zai', name, nameSource: 'custom', email: identity.email,
      providerUserId: identity.userId, credentials: { token: oldToken, captcha_verify_param: 'isolated-obsolete-captcha' }, dailyLimit: 17 })
    accountId = account.id
    await call('update', accountId, { enabled: false, cooldownUntil, cooldownReason: 'temporary_ban', status: 'expired' })
    await invoke("window.location.hash = '#/providers'; void 0")
    await until(`!!document.querySelector('img[alt="Z.ai"]')`, 'Z.ai provider card')
    assert.equal(await invoke(`(() => { const card=document.querySelector('img[alt="Z.ai"]').closest('.glass-card'); const node=Array.from(card.querySelectorAll('button')).find(node=>['账户管理','Accounts'].includes(node.textContent.trim())); if(!node)return false; node.click(); return true })()`), true)
    await edit()
    check('existing-zai-account-menu-edit-exposes-oauth-relogin-in-real-renderer')
    await clickText(['重新登录', 'Sign in again'])
    await until(`Array.from(document.querySelectorAll('[role="dialog"] button')).some(node=>['保存更改','Save Changes'].includes(node.textContent.trim())&&node.disabled)`, 'save disabled while signing in')
    await until(() => loginCount === 1, 'login request reached IPC')
    assert.equal(typeof finishLogin, 'function')
    finishLogin({ success: true, providerId: 'zai', credentials: { token: newToken }, accountInfo: identity })
    await until(`Array.from(document.querySelectorAll('[role="dialog"] button')).some(node=>['保存更改','Save Changes'].includes(node.textContent.trim())&&!node.disabled)`, 'ready to explicitly save')
    assert.equal((await call('getById', accountId, true)).credentials.token, oldToken, 'Login must not write the account before Save Changes')
    check('relogin-real-preload-reaches-isolated-oauth-boundary-and-requires-explicit-save')
    await clickText(['保存更改', 'Save Changes'])
    await until(`!document.querySelector('[role="dialog"]')`, 'saved existing account')
    const updated = await call('getById', accountId, true)
    assert.equal(updated.credentials.token, newToken)
    assert.equal(updated.credentials.captcha_verify_param, undefined, 'Fresh login must not reuse a previous short-lived captcha')
    assert.equal(updated.name, name)
    assert.equal(updated.nameSource, 'custom')
    assert.equal(updated.enabled, false)
    assert.equal(updated.status, 'expired', 'Synthetic login is not proof that authentication errors or website restrictions were cleared')
    assert.equal(updated.cooldownUntil, cooldownUntil)
    assert.equal(updated.cooldownReason, 'temporary_ban')
    assert.equal(updated.dailyLimit, 17)
    assert.equal((await call('getAll')).length, 1, 'Re-login must not create another account')
    check('relogin-save-updates-original-id-and-retains-custom-name-disable-cooldown-and-limit')

    await edit()
    await clickText(['重新登录', 'Sign in again'])
    await until(`Array.from(document.querySelectorAll('[role="dialog"] button')).some(node=>['保存更改','Save Changes'].includes(node.textContent.trim())&&node.disabled)`, 'second login pending')
    await until(() => loginCount === 2, 'second login reached IPC')
    await cancel()
    finishLogin({ success: true, providerId: 'zai', credentials: { token: 'isolated-stale-login-token' }, accountInfo: identity })
    await edit()
    await clickText(['手动输入', 'Manual Input'], '[role="tab"]')
    await until(`!!document.getElementById('token')`, 'original credentials after reopen')
    assert.equal(await invoke(`document.getElementById('token').value`), newToken)
    await cancel()
    assert.equal((await call('getById', accountId, true)).credentials.token, newToken)
    check('cancelled-relogin-cannot-overwrite-reopened-account-or-persist-late-credentials')
  } finally {
    finishLogin?.({ success: false, providerId: 'zai', error: 'Login window was closed' })
    ipcMain.removeHandler(channel)
    if (accountId) await call('delete', accountId)
  }
  await invoke("window.location.hash = '#/'; void 0")
}
