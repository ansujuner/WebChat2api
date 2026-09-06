const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))

function fixture(options = {}) {
  let account = { id: 'private-account-fixture', providerId: 'zai', name: 'private-name-fixture', email: 'private@example.invalid',
    credentials: { token: 'private-token-fixture' }, credentialRevision: 3, enabled: false, cooldownUntil: 9999999999999 }
  let calls = 0
  const reports = []
  const module = { exports: {} }
  const dependencies = {
    '../store/store': { storeManager: { getAccounts() { return options.count === 0 ? [] : options.count === 2 ? [account, { ...account, id: 'second-private' }] : [account] }, getAccountById() { return account } } },
    '../oauth/accountReauthentication': { async reauthenticateAccount(id) {
      calls++
      assert.equal(id, account.id)
      if (options.error) throw new Error(account.credentials.token)
      account = { ...account, credentialRevision: 4 }
      return { success: !options.failed, accountId: id, state: options.failed ? 'failed' : 'updated', ...(options.failed ? { errorCode: 'login_required' } : {}), credentials: account.credentials }
    } },
    '../oauth/zaiAccountBrowser': { zaiAccountBrowserManager: { getAccountState() { return { windowOpen: true, authenticated: !options.failed, private: account.email } } } },
  }
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/diagnostics/zaiAccountLoginProbe.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, setTimeout, clearTimeout, require(name) { assert.ok(dependencies[name], name); return dependencies[name] } })
  return { reports, get calls() { return calls }, run: () => module.exports.runZaiAccountLoginProbe(async report => { reports.push(plain(report)) }) }
}

test('account restore probe reports persisted same-account state without identity or credentials', async () => {
  const f = fixture()
  const result = plain(await f.run())
  assert.equal(result.status, 'passed')
  assert.equal(result.windowOpen, true)
  assert.equal(result.authenticated, true)
  assert.equal(result.sameAccountRetained, true)
  assert.equal(result.credentialVersionDelta, 1)
  assert.equal(result.schedulingPreserved, true)
  assert.equal(result.chatTested, false)
  assert.doesNotMatch(JSON.stringify([result, f.reports]), /private|credentials|@/)
})

test('probe never guesses between accounts or silently creates another login', async () => {
  for (const count of [0, 2]) {
    const f = fixture({ count })
    assert.equal((await f.run()).status, 'account_selection_required')
    assert.equal(f.calls, 0)
  }
})

test('failed browser restores stay failed and exception text cannot enter reports', async () => {
  for (const options of [{ failed: true }, { error: true }]) {
    const result = plain(await fixture(options).run())
    assert.equal(result.status, 'login_not_completed')
    assert.equal(result.accountVerified, false)
    assert.doesNotMatch(JSON.stringify(result), /private|credentials|@/)
  }
})

test('production smoke drives real account IPC and browser, mocking website responses only', () => {
  const fixture = fs.readFileSync(path.join(root, 'scripts/smoke-zai-account-browser.cjs'), 'utf8')
  assert.match(fixture, /No OAuth\/account IPC handler is mocked/)
  assert.doesNotMatch(fixture, /ipcMain|readFile|process\.env/)
  assert.match(fixture, /session\.protocol\.handle\('https'/)
  assert.match(fixture, /callback\(\{ cancel: url\.origin !== origin/)
  assert.match(fixture, /request\.method, 'GET'/)
  assert.match(fixture, /updated\.credentialRevision, baseline\.credentialRevision \+ 1/)
  assert.match(fixture, /resumed\.state, 'restored'/)
  assert.match(fixture, /protocol\.unhandle\('https'\)/)
})
