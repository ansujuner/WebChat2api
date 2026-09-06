const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { isBuiltin } = require('node:module')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
const bundled = fs.readFileSync(path.join(root, 'electron.vite.config.ts'), 'utf8')

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : []
  })
}

test('source dependencies are declared directly rather than relying on another package to install them', () => {
  const missing = new Set()
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const imports = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true).importedFiles
    for (const { fileName: name } of imports) {
      if (isBuiltin(name) || name === 'electron' || name.startsWith('.') || name.startsWith('@/') || name.startsWith('@shared/')) continue
      const dependency = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
      if (!Object.hasOwn(pkg.dependencies, dependency)) missing.add(`${path.relative(root, file)}: ${dependency}`)
    }
  }
  assert.deepEqual([...missing].sort(), [])
})

test('multipart uploads remain bundled when form-data becomes an explicit runtime dependency', () => {
  assert.ok(pkg.dependencies['form-data'])
  assert.equal(lock.packages[''].dependencies['form-data'], pkg.dependencies['form-data'])
  assert.match(bundled, /exclude:\s*\[[\s\S]*?'form-data'/)
})

test('replaced modules do not retain their obsolete runtime and native build dependencies', () => {
  for (const name of ['ali-oss', 'js-sha3', 'koa-router', 'recharts', '@radix-ui/react-tooltip',
    'canvas', '@types/koa-router', '@types/react-window']) {
    assert.equal(pkg.dependencies[name], undefined, name)
    assert.equal(pkg.devDependencies[name], undefined, name)
    assert.equal(lock.packages[''].dependencies?.[name], undefined, name)
    assert.equal(lock.packages[''].devDependencies?.[name], undefined, name)
  }
})
