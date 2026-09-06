/** Use only the newly-created CI keychain, including with a fixture HOME. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
module.exports = (source, env) => {
  if (process.platform !== 'darwin') return
  assert.ok(/^(true|1)$/i.test(env.CI || ''))
  const expected = path.join(source, '.audit-cache/native-test.keychain-db')
  assert.equal(fs.realpathSync(expected), expected)
  const security = args => execFileSync('/usr/bin/security', args, { env, encoding: 'utf8', timeout: 10000 })
  security(['list-keychains', '-d', 'user', '-s', expected])
  security(['default-keychain', '-d', 'user', '-s', expected])
  const actual = security(['default-keychain', '-d', 'user']).trim().replace(/^"|"$/g, '')
  assert.equal(actual, expected, 'Fixture must use only the disposable CI keychain')
}
