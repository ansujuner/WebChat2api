/** Extract installers without installing; compare their app bytes to the verified unpacked app. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const source = fs.realpathSync(process.argv[2])
const report = JSON.parse(fs.readFileSync(path.join(source, 'artifacts/package-integrity.json'), 'utf8'))
assert.equal(report.passed, true)
assert.equal(report.platform, process.platform)
assert.equal(report.arch, process.arch)
const fixture = fs.mkdtempSync(path.join(source, 'artifacts/container-verification-'))
const run = (file, args, cwd = fixture) => execFileSync(file, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 })
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const appDir = process.platform === 'darwin'
  ? path.join(source, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Chat2API.app')
  : path.join(source, 'dist', process.arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked')
const resourcesRelative = process.platform === 'darwin' ? 'Contents/Resources' : 'resources'
function compare(directory) {
  for (const file of ['app.asar', ...report.resources.map(resource => resource.name)]) {
    assert.equal(hash(path.join(directory, resourcesRelative, file)), hash(path.join(appDir, resourcesRelative, file)), `Installer resource mismatch: ${file}`)
  }
  const executable = process.platform === 'darwin' ? 'Contents/MacOS/Chat2API' : 'chat2api'
  assert.equal(hash(path.join(directory, executable)), report.executable.sha256, 'Installer executable differs from the verified native binary')
}
const checks = []
for (const asset of report.assets) {
  const file = path.join(source, 'dist', asset.name)
  assert.equal(hash(file), asset.sha256)
  const output = path.join(fixture, asset.name.replace(/\./g, '-'))
  fs.mkdirSync(output)
  if (asset.name.endsWith('.dmg')) {
    run('hdiutil', ['verify', file])
    const mount = path.join(output, 'mount')
    fs.mkdirSync(mount)
    run('hdiutil', ['attach', file, '-readonly', '-nobrowse', '-mountpoint', mount])
    try {
      compare(path.join(mount, 'Chat2API.app'))
      run('codesign', ['--verify', '--deep', '--strict', path.join(mount, 'Chat2API.app')])
    } finally { run('hdiutil', ['detach', mount]) }
  } else if (asset.name.endsWith('.zip')) {
    run('ditto', ['-x', '-k', file, output])
    compare(path.join(output, 'Chat2API.app'))
    run('codesign', ['--verify', '--deep', '--strict', path.join(output, 'Chat2API.app')])
  } else if (asset.name.endsWith('.AppImage')) {
    fs.chmodSync(file, 0o755)
    run(file, ['--appimage-extract'], output)
    const extracted = path.join(output, 'squashfs-root')
    compare(extracted)
    const desktop = fs.readdirSync(extracted).find(name => name.endsWith('.desktop'))
    assert.ok(desktop)
    const text = fs.readFileSync(path.join(extracted, desktop), 'utf8')
    assert.match(text, /^Exec=AppRun --no-first-run %U$/m)
    assert.doesNotMatch(text, /--no-sandbox/)
  } else if (asset.name.endsWith('.deb')) {
    assert.equal(run('dpkg-deb', ['--field', file, 'Architecture']).trim(), process.arch === 'x64' ? 'amd64' : 'arm64')
    run('dpkg-deb', ['--extract', file, output])
    compare(path.join(output, 'opt/Chat2API'))
  } else if (asset.name.endsWith('.tar.gz')) {
    run('tar', ['-xzf', file, '-C', output])
    const roots = fs.readdirSync(output).filter(name => fs.existsSync(path.join(output, name, 'resources/app.asar')))
    if (fs.existsSync(path.join(output, 'resources/app.asar'))) compare(output)
    else { assert.equal(roots.length, 1); compare(path.join(output, roots[0])) }
  } else throw new Error(`Unexpected installer: ${asset.name}`)
  checks.push(asset.name)
}
fs.writeFileSync(path.join(source, 'artifacts/container-checks.json'), JSON.stringify({ passed: true, checks }, null, 2) + '\n')
console.log(JSON.stringify({ passed: true, checks }))
