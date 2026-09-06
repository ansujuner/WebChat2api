/** Verify every matrix output before attaching binaries to an existing source release. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const directory = path.resolve(process.argv[2])
const tag = process.env.SOURCE_TAG
const repo = process.env.GH_REPO
assert.match(tag, /^source-v\d+\.\d+\.\d+$/)
assert.match(repo, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)
const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
const api = endpoint => JSON.parse(gh(['api', `repos/${repo}/${endpoint}`]))
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const expected = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']
const files = []
const manifests = expected.map(target => {
  const name = `BUILD-${target}.json`
  const bytes = fs.readFileSync(path.join(directory, name))
  const m = JSON.parse(bytes)
  assert.equal(`${m.platform}-${m.arch}`, target)
  assert.equal(`source-v${m.version}`, tag)
  for (const key of ['nativeBuild', 'isolatedApplicationPassed', 'packagedApplicationPassed', 'installerContainersPassed', 'cleanQuit']) assert.equal(m[key], true)
  assert.equal(m.productionProfileUsed, false)
  assert.equal(m.tests.fail, 0)
  assert.equal(m.tests.cancelled, 0)
  assert.ok(m.isolatedApplicationChecks >= 62)
  const names = m.platform === 'darwin'
    ? ['dmg', 'zip'].map(ext => `Chat2API-${m.version}-mac-${m.arch}.${ext}`)
    : ['AppImage', 'deb', 'tar.gz'].map(ext => `Chat2API-${m.version}-${m.arch}.${ext}`)
  assert.deepEqual(m.assets.map(a => a.name).sort(), names.sort())
  for (const asset of m.assets) {
    assert.equal(asset.name, path.basename(asset.name))
    const data = fs.readFileSync(path.join(directory, asset.name))
    assert.equal(data.length, asset.size)
    assert.equal(hash(data), asset.sha256)
    files.push({ name: asset.name, size: data.length, sha256: asset.sha256 })
  }
  files.push({ name, size: bytes.length, sha256: hash(bytes) })
  return m
})
const commits = [...new Set(manifests.map(m => m.sourceCommit))]
assert.equal(commits.length, 1)
assert.equal(api(`commits/${tag}`).sha, commits[0], 'Source tag changed after build')
const release = api(`releases/tags/${tag}`)
assert.equal(release.draft, false)
assert.equal(release.prerelease, false)
assert.equal(new Set(files.map(f => f.name)).size, files.length)
const existingFiles = fs.readdirSync(directory).sort()
assert.deepEqual(existingFiles, files.map(f => f.name).sort(), 'Unexpected artifact file')
const summary = {
  version: manifests[0].version, sourceTag: tag, sourceCommit: commits[0],
  workflowRun: process.env.GITHUB_RUN_ID,
  workflowCommit: process.env.GITHUB_SHA,
  builds: manifests,
}
const summaryName = 'BINARY-MANIFEST.json'
const summaryBytes = Buffer.from(JSON.stringify(summary, null, 2) + '\n')
fs.writeFileSync(path.join(directory, summaryName), summaryBytes)
files.push({ name: summaryName, size: summaryBytes.length, sha256: hash(summaryBytes) })
const sumsName = 'BINARY-SHA256SUMS.txt'
const sums = Buffer.from([...files].sort((a, b) => a.name.localeCompare(b.name)).map(f => `${f.sha256}  ${f.name}`).join('\n') + '\n')
fs.writeFileSync(path.join(directory, sumsName), sums)
files.push({ name: sumsName, size: sums.length, sha256: hash(sums) })
// Rerunning an interrupted upload can keep identical assets, but can never replace them.
const missing = files.filter(file => {
  const existing = release.assets.find(a => a.name === file.name)
  if (!existing) return true
  assert.equal(existing.state, 'uploaded')
  assert.equal(existing.size, file.size)
  assert.equal(existing.digest, `sha256:${file.sha256}`, `Refusing to overwrite ${file.name}`)
  return false
})
if (missing.length) gh(['release', 'upload', tag, ...missing.map(f => path.join(directory, f.name)), '--repo', repo])
const published = api(`releases/tags/${tag}`)
for (const file of files) {
  const asset = published.assets.find(a => a.name === file.name)
  assert.ok(asset, `Missing published asset: ${file.name}`)
  assert.equal(asset.state, 'uploaded')
  assert.equal(asset.size, file.size)
  assert.equal(asset.digest, `sha256:${file.sha256}`)
}
console.log(JSON.stringify({ release: published.html_url, sourceCommit: commits[0], verifiedAssets: files.length }, null, 2))
