const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const filename = path.join(root, 'src/main/diagnostics/accountLiveness.ts')
const ast = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runAccountLivenessProbe')
assert.ok(declaration)

async function fixture() {
  const { AccountLivenessService, summarizeAccountLivenessJob } = await import(pathToFileURL(filename))
  const accounts = [
    { id: 'zai-a', name: 'private@example.test', providerId: 'zai', status: 'active' },
    { id: 'other-b', name: 'other-private@example.test', providerId: 'deepseek', status: 'active' },
    { id: 'zai-off', name: 'disabled-private@example.test', providerId: 'zai', status: 'active', enabled: false },
  ]
  const sent = [], inputs = [], waited = []
  const service = new AccountLivenessService({
    getAccounts: () => accounts,
    getAccount: id => accounts.find(account => account.id === id),
    getProvider: id => ({ id, enabled: true }),
    getModels: id => [{ displayName: id === 'zai' ? 'GLM-5.3-Flash' : 'deepseek-v4-flash', actualModelId: 'fixture-text-model' }],
    forward: async id => {
      sent.push(id)
      return { success: true, status: 200, body: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'PRIVATE-REPLY-FIXTURE' } }] } }
    },
  })
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(declaration.getText(ast), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports,
    startAccountLiveness: async input => { inputs.push(input); return service.start(input) },
    waitForAccountLiveness: async id => { waited.push(id); return service.wait(id) },
    summarizeAccountLivenessJob,
  })
  return { ...module.exports, service, sent, inputs, waited }
}

test('scoped probe forwards the exact validated input and never generates for other providers or disabled accounts', async () => {
  const f = await fixture(), input = { providerId: 'zai' }
  const report = await f.runAccountLivenessProbe(input)
  assert.equal(f.inputs[0], input)
  assert.deepEqual(f.sent, ['zai-a'])
  assert.equal(f.waited.length, 1)
  assert.deepEqual(report.counts, { total: 2, passed: 1, failed: 0, skipped: 1, cancelled: 0 })
  assert.equal(report.checks.every(check => check.provider === 'zai'), true)
  assert.doesNotMatch(JSON.stringify(report), /@example|zai-a|zai-off|PRIVATE-REPLY|accountId|accountName/)
})

test('default liveness probe retains the explicit all-account diagnostic behavior', async () => {
  const f = await fixture()
  const report = await f.runAccountLivenessProbe()
  assert.deepEqual(JSON.parse(JSON.stringify(f.inputs)), [{}])
  assert.deepEqual(f.sent, ['zai-a', 'other-b'])
  assert.equal(report.counts.total, 3)
})

test('invalid unknown probe selections use existing validation and never broaden to all accounts', async () => {
  for (const input of [null, [], 'zai', { providerId: '../zai' }, { providerId: 'zai', accountIds: ['zai-a'] }, { unexpected: true }]) {
    const f = await fixture()
    await assert.rejects(f.runAccountLivenessProbe(input), error => error.code === 'invalid_input')
    assert.deepEqual(f.sent, []); assert.deepEqual(f.waited, [])
    assert.equal(f.service.get(), null)
  }
})

test('an unavailable provider selection produces no calls rather than a fallback to another account', async () => {
  const f = await fixture(), report = await f.runAccountLivenessProbe({ providerId: 'missing-provider' })
  assert.deepEqual(f.sent, [])
  assert.equal(report.counts.total, 0); assert.equal(report.status, 'needs_attention')
})
