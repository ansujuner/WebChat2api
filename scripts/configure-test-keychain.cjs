/** Create a real, disposable Keychain inside one CI fixture HOME only. */
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { execFileSync } = require('node:child_process')
module.exports = (source, env) => {
  if (process.platform !== 'darwin') return () => {}
  assert.ok(/^(true|1)$/i.test(env.CI || ''), 'Test keychains require a disposable CI runner')
  assert.ok(path.isAbsolute(source) && fs.realpathSync(source) === source, 'Source must be a canonical absolute directory')
  assert.ok(typeof env.HOME === 'string' && path.isAbsolute(env.HOME), 'A disposable HOME is required')
  const home = fs.realpathSync(env.HOME)
  assert.equal(home, env.HOME, 'Fixture HOME must not contain symlinks')
  assert.equal(env.USERPROFILE, home, 'Both home variables must refer to the same fixture')
  assert.equal(path.basename(home), 'home')
  const fixture = path.dirname(home)
  assert.equal(path.dirname(fixture), path.join(source, '.audit-cache'), 'Keychain fixture must be inside source audit cache')
  assert.match(path.basename(fixture), /^(?:app-runtime-smoke|packaged-app-smoke)-[A-Za-z0-9]+$/)
  const library = path.join(home, 'Library')
  const keychains = path.join(library, 'Keychains')
  const preferences = path.join(library, 'Preferences')
  for (const directory of [library, keychains, preferences]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    assert.equal(fs.realpathSync(directory), directory, 'Keychain directories must not contain symlinks')
  }
  const expected = path.join(keychains, 'test.keychain-db')
  assert.equal(fs.existsSync(expected), false, 'Refusing to reuse any existing keychain')
  const password = randomBytes(32).toString('hex')
  const security = args => {
    try {
      return execFileSync('/usr/bin/security', args, {
        env, encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 16384,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      // Native command errors contain the command/password; never propagate them.
      throw new Error(`Disposable keychain operation failed: ${args[0]} (exit ${Number.isInteger(error.status) ? error.status : 'unavailable'})`)
    }
  }
  let creationAttempted = false, cleaned = false
  const cleanup = () => {
    if (cleaned || !creationAttempted) return
    if (fs.existsSync(expected)) {
      assert.equal(fs.realpathSync(expected), expected, 'Created keychain path changed before cleanup')
      assert.ok(fs.lstatSync(expected).isFile(), 'Created keychain must remain a regular file')
      security(['delete-keychain', expected])
      assert.equal(fs.existsSync(expected), false, 'Created test keychain was not deleted')
    }
    cleaned = true
  }
  try {
    creationAttempted = true
    security(['create-keychain', '-p', password, expected])
    assert.equal(fs.realpathSync(expected), expected, 'Keychain was not created in the fixture HOME')
    security(['set-keychain-settings', '-lut', '7200', expected])
    security(['unlock-keychain', '-p', password, expected])
    // Use the exact same HOME as Electron. Never inspect/unlock existing keychains.
    security(['list-keychains', '-d', 'user', '-s', expected])
    security(['default-keychain', '-d', 'user', '-s', expected])
    const actual = security(['default-keychain', '-d', 'user']).trim().replace(/^"|"$/g, '')
    assert.equal(actual, expected, 'Fixture must use only its newly-created native keychain')
    return cleanup
  } catch (error) {
    try { cleanup() }
    catch { throw new Error('Disposable keychain initialization failed, and its created keychain could not be cleaned up') }
    throw error
  }
}
