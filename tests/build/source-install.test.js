const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const pkg = readJson('package.json')
const lock = readJson('package-lock.json')

test('clean dependency installation downloads Electron before preparing native dependencies', () => {
  // Electron 44 distributes an explicit installer instead of running postinstall.
  // Use the locked local package, not npx fetching a different runtime version.
  // && ensures a failed download fails installation rather than hiding the error.
  assert.equal(pkg.scripts.postinstall,
    'node node_modules/electron/install.js && electron-builder install-app-deps')
  assert.equal(lock.packages[''].hasInstallScript, true)
})

test('source installation uses the exact lockfile runtime and its distributed installer', () => {
  assert.match(pkg.devDependencies.electron, /^\d+\.\d+\.\d+$/)
  assert.equal(lock.packages['node_modules/electron'].version, pkg.devDependencies.electron)
  const installed = readJson('node_modules/electron/package.json')
  assert.equal(installed.version, pkg.devDependencies.electron)
  assert.equal(installed.bin['install-electron'], 'install.js')
  assert.ok(fs.existsSync(path.join(root, 'node_modules/electron/install.js')))
})
