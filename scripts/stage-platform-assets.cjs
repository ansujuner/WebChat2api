/** Release only allowlisted, byte-verified installers and non-private build evidence. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const source = path.resolve(process.argv[2])
const read = file => JSON.parse(fs.readFileSync(path.join(source, 'artifacts', file), 'utf8'))
const integrity = read('package-integrity.json')
const smoke = read('runtime-app-smoke.json')
const packaged = read('packaged-app-smoke.json')
const containers = read('container-checks.json')
assert.equal(containers.passed, true)
assert.deepEqual([...containers.checks].sort(), integrity.assets.map(a => a.name).sort())
assert.equal(integrity.passed, true)
assert.equal(smoke.passed, true)
assert.equal(smoke.cleanQuit, true)
assert.equal(smoke.childExitCode, 0)
assert.equal(smoke.productionProfileUsed, false)
assert.ok(smoke.checks.length >= 62)
assert.equal(packaged.passed, true)
assert.equal(packaged.cleanQuit, true)
assert.equal(packaged.productionProfileUsed, false)
const tap = fs.readFileSync(path.join(source, 'artifacts/tests.tap'), 'utf8')
const count = name => {
  const found = [...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))].at(-1)
  assert.ok(found, `Missing test summary: ${name}`)
  return Number(found[1])
}
const tests = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(name => [name, count(name)]))
assert.equal(tests.fail, 0)
assert.equal(tests.cancelled, 0)
assert.ok(tests.pass > 1000)
const commit = fs.readFileSync(path.join(source, 'artifacts/source-commit.txt'), 'utf8').trim()
assert.match(commit, /^[a-f0-9]{40}$/)
const output = path.join(source, 'artifacts/release-assets')
fs.mkdirSync(output, { recursive: false })
const assets = integrity.assets.map(asset => {
  assert.equal(asset.name, path.basename(asset.name))
  const original = path.join(source, 'dist', asset.name)
  const bytes = fs.readFileSync(original)
  assert.equal(bytes.length, asset.size)
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), asset.sha256)
  fs.copyFileSync(original, path.join(output, asset.name))
  return { name: asset.name, size: asset.size, sha256: asset.sha256 }
})
const manifest = {
  version: integrity.version, sourceCommit: commit, platform: integrity.platform, arch: integrity.arch,
  nativeBuild: true, tests, isolatedApplicationChecks: smoke.checks.length,
  isolatedApplicationPassed: true, packagedApplicationPassed: true, cleanQuit: true,
  installerContainersPassed: true,
  productionProfileUsed: false, versions: smoke.versions,
  signature: integrity.platform === 'darwin' ? 'ad-hoc; no Developer ID; not notarized' : 'not signed',
  assets,
}
fs.writeFileSync(path.join(output, `BUILD-${integrity.platform}-${integrity.arch}.json`), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))
