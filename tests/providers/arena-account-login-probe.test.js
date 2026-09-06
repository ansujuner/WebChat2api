const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))

function fixture(options = {}) {
  let account = { id: 'private-account', providerId: 'arena', email: 'private@example.test',
    credentials: { browserProfileId: 'private-profile' }, credentialRevision: 3, enabled: false, cooldownUntil: 9999999999999 }
  let calls = 0
  const reports = []
  const module = { exports: {} }
  const dependencies = {
    '../store/store': { storeManager: {
      getAccounts() { return options.count === 0 ? [] : options.count === 2 ? [account, { ...account, id: 'second-private' }] : [account] },
      getAccountById(id, decrypt) { assert.equal(decrypt, undefined); return options.deleted ? undefined : account },
    } },
    '../oauth/accountReauthentication': { async reauthenticateAccount(id) {
      calls++
      assert.equal(id, account.id)
      if (options.error) throw new Error('private-details')
      account = { ...account, credentialRevision: options.failed ? 3 : 4 }
      return { success: !options.failed, state: options.failed ? 'failed' : 'updated', errorCode: 'browser_connection_failed', credentials: account.credentials }
    } },
  }
  const code = ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/diagnostics/arenaAccountLoginProbe.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, require(name) { assert.ok(dependencies[name], name); return dependencies[name] } })
  return { reports, get calls() { return calls }, run: () => module.exports.runArenaAccountLoginProbe(async report => reports.push(plain(report))) }
}

test('Arena restore diagnostic targets the original account and exports no identity or profile', async () => {
  const f = fixture()
  const result = plain(await f.run())
  assert.equal(result.status, 'passed')
  assert.equal(result.sameAccountRetained, true)
  assert.equal(result.credentialVersionDelta, 1)
  assert.equal(result.schedulingPreserved, true)
  assert.equal(result.chatTested, false)
  assert.equal(f.calls, 1)
  assert.doesNotMatch(JSON.stringify([result, f.reports]), /private|credentials|@/)
})

test('Arena restore diagnostic never creates a profile or guesses between accounts', async () => {
  for (const count of [0, 2]) {
    const f = fixture({ count })
    assert.equal((await f.run()).status, 'account_selection_required')
    assert.equal(f.calls, 0)
  }
})

test('Arena restore diagnostic cannot convert failure, deletion or an exception into success', async () => {
  for (const options of [{ failed: true }, { deleted: true }, { error: true }]) {
    const result = plain(await fixture(options).run())
    assert.equal(result.status, 'login_not_completed')
    assert.equal(result.accountVerified, false)
    if (options.failed) assert.equal(result.errorCode, 'browser_connection_failed')
    assert.doesNotMatch(JSON.stringify(result), /private|credentials|@/)
  }
})
