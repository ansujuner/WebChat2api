const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const readConfig = (file) => {
  const result = ts.readConfigFile(path.join(root, file), ts.sys.readFile)
  assert.equal(result.error, undefined)
  return result.config
}

test('both typecheck projects are strict and never emit source-shadowing artifacts', () => {
  for (const file of ['tsconfig.json', 'tsconfig.node.json']) {
    const config = readConfig(file)
    assert.equal(config.compilerOptions.noEmit, true, file)
    assert.equal(config.compilerOptions.strict, true, file)
    assert.equal(config.compilerOptions.noUnusedLocals, true, file)
    assert.notEqual(config.compilerOptions.composite, true, file)
    assert.equal(config.references, undefined, 'independent no-emit checks need no built declarations')
  }
  assert.equal(readConfig('tsconfig.node.json').compilerOptions.target, 'ES2022')
})

test('production builds check both process boundaries before bundling', () => {
  assert.equal(pkg.scripts['typecheck:node'], 'tsc --project tsconfig.node.json')
  assert.equal(pkg.scripts['typecheck:web'], 'tsc --project tsconfig.json')
  assert.equal(pkg.scripts.typecheck, 'npm run typecheck:node && npm run typecheck:web')
  assert.match(pkg.scripts.build, /npm run typecheck && electron-vite build$/)
})
