const test = require('node:test')
const assert = require('node:assert/strict')
const { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const {
  findSourceArtifacts,
  removeSourceArtifacts,
} = require('../../scripts/check-source-artifacts')

test('findSourceArtifacts reports generated JavaScript and declaration files next to TypeScript sources', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'source-artifacts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const srcDir = join(root, 'src/main/proxy')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'forwarder.ts'), 'export const source = true\n')
  writeFileSync(join(srcDir, 'forwarder.js'), 'exports.source = true\n')
  writeFileSync(join(srcDir, 'forwarder.d.ts'), 'export declare const source: boolean\n')
  writeFileSync(join(srcDir, 'standalone.js'), 'exports.ok = true\n')

  const artifacts = findSourceArtifacts(root)

  assert.deepEqual(artifacts, [
    'src/main/proxy/forwarder.d.ts',
    'src/main/proxy/forwarder.js',
  ])
})

test('removeSourceArtifacts deletes only detected sibling artifacts', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'source-artifacts-remove-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const srcDir = join(root, 'src/main/proxy')
  mkdirSync(srcDir, { recursive: true })
  const source = join(srcDir, 'forwarder.ts')
  const generated = join(srcDir, 'forwarder.js')
  const standalone = join(srcDir, 'standalone.js')
  writeFileSync(source, 'export const source = true\n')
  writeFileSync(generated, 'exports.source = true\n')
  writeFileSync(standalone, 'exports.ok = true\n')

  const removed = removeSourceArtifacts(root)

  assert.deepEqual(removed, ['src/main/proxy/forwarder.js'])
  assert.equal(existsSync(source), true)
  assert.equal(existsSync(generated), false)
  assert.equal(existsSync(standalone), true)
})

test('source scan ignores isolated audit and generated-report trees but still checks application source', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'source-artifacts-scopes-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const directory of ['.audit-cache', 'artifacts', 'coverage', 'src/main']) {
    const target = join(root, directory)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'fixture.ts'), 'export const value = 1\n')
    writeFileSync(join(target, 'fixture.js'), 'exports.value = 1\n')
  }
  assert.deepEqual(findSourceArtifacts(root), ['src/main/fixture.js'])
})
