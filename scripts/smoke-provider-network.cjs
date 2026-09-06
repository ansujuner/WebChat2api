/** Actual production renderer/preload/store fixture. No account or upstream requests.
 * Only OS route metadata and one failed save are synthetic; they do not prove
 * internet connectivity or that this computer has a running proxy service.
 */
const assert = require('node:assert/strict')
const path = require('node:path')

module.exports = async function verifyProviderNetwork({ invoke, check, ipcMain }) {
  const root = path.resolve(__dirname, '..')
  const fixture = process.env.CHAT2API_SMOKE_ROOT
  assert.ok(fixture && path.dirname(path.resolve(fixture)) === path.join(root, '.audit-cache')
    && path.basename(fixture).startsWith('app-runtime-smoke-'), 'Provider proxy UI requires the isolated production fixture')
  assert.equal(path.resolve(process.env.USERPROFILE), path.join(fixture, 'home'))
  assert.equal(await invoke('window.electronAPI.accounts.getAll().then(value=>value.length)'), 0, 'No real or synthetic account is needed')
  const updateChannel = 'providers:update', statusChannel = 'providers:getNetworkStatus'
  const originalUpdate = ipcMain._invokeHandlers.get(updateChannel)
  const originalStatus = ipcMain._invokeHandlers.get(statusChannel)
  assert.equal(typeof originalUpdate, 'function')
  assert.equal(typeof originalStatus, 'function')
  const ids = [], updates = []
  let failSave = false, routeFixture, resolveRoute
  const call = (domain, method, ...args) => invoke(`window.electronAPI.${domain}.${method}(${args.map(value => JSON.stringify(value)).join(',')})`)
  const until = async (condition, label) => {
    const end = Date.now() + 6000
    while (Date.now() < end) {
      if (typeof condition === 'function' ? await condition() : await invoke(condition)) return
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    throw new Error(`Provider proxy fixture UI did not settle: ${label}`)
  }
  const selector = (id, name) => `[data-testid="provider-network-${name}-${id}"]`
  const click = async (id, name) => {
    assert.equal(await invoke(`(() => { const node=document.querySelector(${JSON.stringify(selector(id, name))}); if(!node||node.disabled)return false; node.click(); return true })()`), true, `Enabled proxy ${name} control required`)
  }
  const labels = {
    inherit: ['跟随全局默认', 'Follow global default'], system: ['使用系统代理', 'Use system proxy'],
    none: ['不使用代理（直连）', 'No proxy (direct)'], custom: ['指定代理', 'Specified proxy'],
  }
  const choose = async (id, mode) => {
    assert.equal(await invoke(`(() => { const node=document.querySelector(${JSON.stringify(selector(id, 'mode'))}); if(!node||node.disabled)return false; node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,ctrlKey:false,pointerType:'mouse'})); return true })()`), true)
    await until(`!!document.querySelector('[role="option"]')`, 'proxy choices opened')
    assert.equal(await invoke(`(() => { const node=Array.from(document.querySelectorAll('[role="option"]')).find(item=>${JSON.stringify(labels[mode])}.includes(item.textContent.trim())); if(!node)return false; node.click(); return true })()`), true)
    await until(`!document.querySelector('[role="option"]')`, 'proxy selection closed')
  }
  const getProvider = async id => (await call('providers', 'getAll')).find(item => item.id === id)
  const saved = async (id, mode) => {
    const end = Date.now() + 6000
    while (Date.now() < end) {
      if ((await getProvider(id))?.networkProxyMode === mode) {
        await until(`!document.querySelector(${JSON.stringify(selector(id, 'mode'))})?.disabled`, 'save control re-enabled')
        return
      }
      await new Promise(resolve => setTimeout(resolve, 40))
    }
    throw new Error(`Provider proxy fixture save did not settle: ${mode}`)
  }
  const statusText = id => invoke(`document.querySelector(${JSON.stringify(selector(id, 'status'))})?.textContent||''`)
  const input = async (id, value) => assert.equal(await invoke(`(() => { const node=document.querySelector(${JSON.stringify(selector(id, 'url'))}); if(!node)return false; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,${JSON.stringify(value)}); node.dispatchEvent(new Event('input',{bubbles:true})); return true })()`), true)
  ipcMain.removeHandler(updateChannel)
  ipcMain.handle(updateChannel, async (event, id, changes) => {
    if (ids.includes(id) && changes.networkProxyMode) {
      updates.push({ id, mode: changes.networkProxyMode })
      if (failSave) return null
    }
    return originalUpdate(event, id, changes)
  })
  ipcMain.removeHandler(statusChannel)
  ipcMain.handle(statusChannel, (event, id) => {
    if (!ids.includes(id)) return originalStatus(event, id)
    if (routeFixture === 'pending') return new Promise(resolve => { resolveRoute = resolve })
    if (routeFixture) return routeFixture
    return originalStatus(event, id)
  })
  try {
    const globalBefore = (await call('config', 'get')).oauthProxyMode
    for (const name of ['Isolated Provider Proxy A', 'Isolated Provider Proxy B']) {
      const provider = await call('providers', 'add', { name, type: 'custom', authType: 'token', apiEndpoint: 'http://127.0.0.1:17892/v1', supportedModels: ['isolated-proxy-model'], credentialFields: [{ name: 'apiKey', type: 'password', label: 'API Key', required: false }] })
      ids.push(provider.id)
    }
    await invoke("window.location.hash='#/settings'; void 0")
    await until(`!document.querySelector(${JSON.stringify(selector(ids[0], 'mode'))})`, 'provider page unmounted')
    await invoke("window.location.hash='#/providers'; void 0")
    await until(`!!document.querySelector(${JSON.stringify(selector(ids[0], 'mode'))})`, 'independent provider proxy control')
    const [a, b] = ids
    await choose(a, 'system'); await saved(a, 'system')
    assert.equal((await getProvider(b)).networkProxyMode || 'inherit', 'inherit')
    assert.equal((await call('config', 'get')).oauthProxyMode, globalBefore)
    check('provider-proxy-real-ui-saves-only-selected-provider-and-retains-global-default')

    routeFixture = { mode: 'system', route: 'direct' }
    await click(a, 'check')
    await until(`document.querySelector(${JSON.stringify(selector(a, 'status'))})?.textContent.includes('DIRECT')`, 'synthetic system DIRECT status')
    assert.match(await statusText(a), /当前没有走代理|not using a proxy/)
    check('provider-proxy-real-ui-distinguishes-synthetic-system-direct-from-proxied-connectivity')

    routeFixture = 'pending'
    await click(a, 'check')
    await until(() => typeof resolveRoute === 'function', 'pending route lookup')
    await choose(a, 'none'); await saved(a, 'none')
    resolveRoute({ mode: 'system', route: 'proxy' }); resolveRoute = undefined
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.doesNotMatch(await statusText(a), /系统规则为本供应商选择了代理|System rules selected a proxy/)
    check('provider-proxy-real-ui-discards-late-route-result-after-independent-mode-save')

    failSave = true
    await choose(a, 'system')
    await until(`/(未能保存|Could not save)/.test(document.querySelector(${JSON.stringify(selector(a, 'status'))})?.textContent||'')`, 'failed save feedback')
    assert.equal((await getProvider(a)).networkProxyMode, 'none')
    assert.equal(await invoke(`${JSON.stringify(labels.none)}.includes(document.querySelector(${JSON.stringify(selector(a, 'mode'))})?.textContent.trim())`), true)
    failSave = false
    check('provider-proxy-real-ui-save-failure-retains-previous-saved-route')

    await choose(a, 'custom')
    await until(`!!document.querySelector(${JSON.stringify(selector(a, 'url'))})`, 'custom address editor')
    const countBefore = updates.length
    await input(a, 'http://user:fixture-password@127.0.0.1:17891'); await click(a, 'save')
    await until(`/(请输入带端口|Enter a valid)/.test(document.querySelector(${JSON.stringify(selector(a, 'status'))})?.textContent||'')`, 'invalid custom address feedback')
    assert.equal(updates.length, countBefore, 'Invalid address must not reach IPC')
    assert.equal((await getProvider(a)).networkProxyMode, 'none')
    await input(a, ' http://127.0.0.1:17891/ '); await click(a, 'save'); await saved(a, 'custom')
    assert.equal((await getProvider(a)).networkProxyUrl, 'http://127.0.0.1:17891')
    routeFixture = undefined
    await click(a, 'check')
    await until(`/(已选择指定代理|specified proxy is selected)/.test(document.querySelector(${JSON.stringify(selector(a, 'status'))})?.textContent||'')`, 'actual custom route resolution without connecting')
    assert.match(await statusText(a), /尚未测试|not been tested/)
    check('provider-proxy-real-ui-validates-and-persists-custom-address-with-route-only-status')

    await choose(a, 'inherit'); await saved(a, 'inherit')
    assert.equal((await getProvider(a)).networkProxyUrl, 'http://127.0.0.1:17891', 'Mode switching must not erase the saved custom address')
    assert.equal((await getProvider(b)).networkProxyMode || 'inherit', 'inherit')
    assert.equal((await call('config', 'get')).oauthProxyMode, globalBefore)
    check('provider-proxy-real-ui-inherit-preserves-custom-address-and-other-provider-settings')
  } finally {
    if (resolveRoute) resolveRoute({ mode: 'system', route: 'unknown' })
    ipcMain.removeHandler(updateChannel); ipcMain.handle(updateChannel, originalUpdate)
    ipcMain.removeHandler(statusChannel); ipcMain.handle(statusChannel, originalStatus)
    for (const id of ids) await call('providers', 'delete', id)
  }
}
