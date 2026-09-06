const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const asar = require('@electron/asar')
const {
  LEGAL_FILES, WASM_FILE, packageLayout, parseArgs,
  verifyExecutableHeader, verifyPlatformPackage,
} = require('../../scripts/verify-platform-package.cjs')

function write(root, name, bytes) {
  const target = path.join(root, ...name.split('/'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, bytes)
}

function executableHeader(platform, arch) {
  const header = Buffer.alloc(64)
  if (platform === 'darwin') {
    header.writeUInt32LE(0xfeedfacf, 0)
    header.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4)
    header.writeUInt32LE(2, 12)
  } else {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(header)
    header.writeUInt16LE(3, 16)
    header.writeUInt16LE(arch === 'x64' ? 62 : 183, 18)
  }
  return header
}

async function fixture(t, platform = 'linux', arch = 'x64', editArchive) {
  const source = fs.mkdtempSync(path.join(tmpdir(), 'chat2api-platform-package-'))
  t.after(() => fs.rmSync(source, { recursive: true, force: true }))
  const metadata = {
    name: 'chat2api', version: '1.6.7', main: './out/main/index.js', license: 'GPL-3.0-or-later',
    build: { productName: 'Chat2API', directories: { output: 'dist' } },
  }
  write(source, 'package.json', JSON.stringify(metadata))
  for (const name of LEGAL_FILES) write(source, name, `${name} attribution fixture\n`)
  write(source, 'out/main/index.js', 'console.log("fixture")\n')
  write(source, 'out/preload/index.js', 'module.exports = {}\n')
  write(source, 'out/renderer/index.html', '<!DOCTYPE html><title>Fixture</title>')
  write(source, 'out/renderer/assets/entry.js', 'export const fixture = true\n')
  write(source, 'build/icon.png', 'PNG fixture')
  write(source, 'build/icon.ico', 'ICO fixture')
  write(source, 'build/icons/128x128.png', 'resized icon fixture')
  write(source, WASM_FILE, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))
  const layout = packageLayout(source, platform, arch, metadata)
  const staging = path.join(source, 'staging')
  fs.mkdirSync(staging)
  fs.cpSync(path.join(source, 'out'), path.join(staging, 'out'), { recursive: true })
  for (const name of ['package.json', ...LEGAL_FILES]) fs.copyFileSync(path.join(source, name), path.join(staging, name))
  if (editArchive) editArchive(staging)
  fs.mkdirSync(layout.resources, { recursive: true })
  await asar.createPackage(staging, layout.asar)
  fs.cpSync(path.join(source, 'build'), path.join(layout.resources, 'build'), { recursive: true })
  fs.copyFileSync(path.join(source, WASM_FILE), path.join(layout.resources, WASM_FILE))
  fs.mkdirSync(path.dirname(layout.executable), { recursive: true })
  fs.writeFileSync(layout.executable, executableHeader(platform, arch))
  for (const name of layout.assets) write(layout.dist, name, `non-empty archive fixture: ${name}`)
  return { source, platform, arch, layout, metadata, verify: () => verifyPlatformPackage({ source, platform, arch }, { asar }) }
}

for (const platform of ['darwin', 'linux']) {
  for (const arch of ['x64', 'arm64']) {
    test(`package verification checks all files and installer hashes for ${platform}/${arch}`, async (t) => {
      const f = await fixture(t, platform, arch)
      const report = await f.verify()
      assert.equal(report.passed, true)
      assert.equal(report.version, '1.6.7')
      assert.equal(report.platform, platform)
      assert.equal(report.arch, arch)
      assert.equal(report.asar.buildFiles, 4)
      assert.equal(report.asar.files, 9)
      assert.equal(report.resources.length, 4)
      assert.equal(report.executable.format, platform === 'darwin' ? 'Mach-O64' : 'ELF64')
      assert.equal(report.executable.arch, arch)
      assert.deepEqual(report.assets.map((asset) => asset.name), f.layout.assets)
      for (const asset of report.assets) {
        const data = fs.readFileSync(asset.path)
        assert.equal(asset.size, data.length)
        assert.equal(asset.sha256, createHash('sha256').update(data).digest('hex'))
      }
    })

    test(`package verification rejects an incorrect ${platform}/${arch} executable architecture`, async (t) => {
      const f = await fixture(t, platform, arch)
      fs.writeFileSync(f.layout.executable, executableHeader(platform, arch === 'x64' ? 'arm64' : 'x64'))
      await assert.rejects(f.verify(), /architecture mismatch/)
    })
  }
}

test('package verification rejects modified application build bytes', async (t) => {
  const f = await fixture(t, 'linux', 'x64', (staging) => write(staging, 'out/main/index.js', 'tampered'))
  await assert.rejects(f.verify(), /Packaged bytes differ: out\/main\/index.js/)
})

test('package verification rejects missing build files', async (t) => {
  const f = await fixture(t, 'linux', 'x64', (staging) => fs.unlinkSync(path.join(staging, 'out/renderer/assets/entry.js')))
  await assert.rejects(f.verify(), /ASAR file count mismatch/)
})

test('package verification rejects incorrect package version', async (t) => {
  const f = await fixture(t, 'linux', 'x64', (staging) => {
    const target = path.join(staging, 'package.json')
    fs.writeFileSync(target, JSON.stringify({ ...JSON.parse(fs.readFileSync(target)), version: '1.0.0' }))
  })
  await assert.rejects(f.verify(), /package.json version mismatch/)
})

test('package verification rejects missing legal attribution', async (t) => {
  const f = await fixture(t, 'linux', 'x64', (staging) => fs.unlinkSync(path.join(staging, 'NOTICE')))
  await assert.rejects(f.verify(), /ASAR file count mismatch/)
})

test('package verification rejects altered legal attribution', async (t) => {
  const f = await fixture(t, 'linux', 'x64', (staging) => write(staging, 'NOTICE', 'removed attribution'))
  await assert.rejects(f.verify(), /Packaged bytes differ: NOTICE/)
})

for (const name of ['node_modules/extra/index.js', 'src/main.ts', 'tests/example.js', '.audit-cache/profile.json', '.env', 'accounts.json', 'out/renderer/assets/session.log', 'unexpected.txt']) {
  test(`package verification rejects unapproved ASAR artifact ${name}`, async (t) => {
    const f = await fixture(t, 'linux', 'x64', (staging) => write(staging, name, 'unapproved'))
    await assert.rejects(f.verify(), /Forbidden package artifact|Unexpected ASAR file/)
  })
}

for (const name of [WASM_FILE, 'build/icon.png', 'build/icons/128x128.png']) {
  test(`package verification rejects external resource tampering: ${name}`, async (t) => {
    const f = await fixture(t)
    write(f.layout.resources, name, 'tampered')
    await assert.rejects(f.verify(), /External resource bytes differ/)
  })
}

test('package verification rejects private data beside the application archive', async (t) => {
  const f = await fixture(t)
  write(f.layout.resources, 'profiles/accounts.json', 'fixture secret')
  await assert.rejects(f.verify(), /Forbidden package artifact/)
})

for (const field of ['link', 'unpacked']) {
  test(`package verification rejects ASAR ${field} entries`, async (t) => {
    const f = await fixture(t)
    const alteredReader = {
      ...asar,
      getRawHeader(archive) {
        const original = asar.getRawHeader(archive)
        const header = structuredClone(original.header)
        header.files.out.files.main.files['index.js'][field] = field === 'link' ? '../../private' : true
        return { ...original, header }
      },
    }
    await assert.rejects(verifyPlatformPackage(f, { asar: alteredReader }), /ASAR links\/unpacked files are not allowed/)
  })
}

test('package verification never approves a private file merely because it is also in build output', async (t) => {
  const f = await fixture(t)
  write(f.source, 'out/accounts.json', 'fixture private data')
  await assert.rejects(f.verify(), /Forbidden package artifact/)
})

test('package verification rejects a missing binary asset', async (t) => {
  const f = await fixture(t)
  fs.unlinkSync(path.join(f.layout.dist, f.layout.assets[0]))
  await assert.rejects(f.verify(), /Unexpected or missing release assets/)
})

test('package verification rejects a zero-byte binary asset', async (t) => {
  const f = await fixture(t)
  write(f.layout.dist, f.layout.assets[0], '')
  await assert.rejects(f.verify(), /Empty package file/)
})

test('package verification rejects stale or wrong-architecture binary assets', async (t) => {
  const f = await fixture(t)
  write(f.layout.dist, 'Chat2API-1.6.6-arm64.deb', 'stale')
  await assert.rejects(f.verify(), /Unexpected or missing release assets/)
})

test('executable header validation rejects invalid formats and non-executable headers', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.throws(() => verifyExecutableHeader(Buffer.alloc(0), platform, 'x64'), /Expected a 64-bit/)
    assert.throws(() => verifyExecutableHeader(Buffer.alloc(64), platform, 'x64'), /Expected a 64-bit/)
    const header = executableHeader(platform, 'x64')
    if (platform === 'darwin') header.writeUInt32LE(6, 12)
    else header.writeUInt16LE(1, 16)
    assert.throws(() => verifyExecutableHeader(header, platform, 'x64'), /not an executable/)
  }
})

test('CLI requires explicit absolute input/output paths and supported targets', () => {
  const source = path.resolve('source-fixture')
  const output = path.resolve('report.json')
  const args = ['--source', source, '--platform', 'darwin', '--arch', 'arm64', '--output', output]
  assert.deepEqual(parseArgs(args), { source, platform: 'darwin', arch: 'arm64', output })
  assert.throws(() => parseArgs([]), /Missing --source/)
  assert.throws(() => parseArgs([...args, '--output', output]), /Invalid argument/)
  assert.throws(() => parseArgs([...args, '--unknown', 'value']), /Invalid argument/)
  assert.throws(() => parseArgs(args.map((value) => value === source ? 'relative' : value)), /absolute checkout/)
  assert.throws(() => parseArgs(args.map((value) => value === output ? 'relative.json' : value)), /absolute JSON/)
  assert.throws(() => parseArgs(args.map((value) => value === 'darwin' ? 'win32' : value)), /Unsupported platform/)
  assert.throws(() => parseArgs(args.map((value) => value === 'arm64' ? 'ia32' : value)), /Unsupported architecture/)
})

test('CLI prints and saves the same success report, and cannot overwrite an existing report', async (t) => {
  const f = await fixture(t)
  const reportPath = path.join(f.source, 'reports', 'package.json')
  const cli = path.resolve(__dirname, '../../scripts/verify-platform-package.cjs')
  const args = [cli, '--source', f.source, '--platform', f.platform, '--arch', f.arch, '--output', reportPath]
  const options = {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, NODE_PATH: path.resolve(__dirname, '../../node_modules') },
  }
  const result = spawnSync(process.execPath, args, options)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.passed, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), report)
  const repeated = spawnSync(process.execPath, args, options)
  assert.equal(repeated.status, 1)
  assert.match(repeated.stderr, /Package verification failed:.*EEXIST/)
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), report)
})
