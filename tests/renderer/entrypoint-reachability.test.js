const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '../..')
const rendererRoot = path.join(root, 'src/renderer/src')

test('renderer implementation files are reachable from the actual entrypoint, including lazy routes', () => {
  const configPath = path.join(root, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  assert.equal(config.error, undefined)
  const { options, errors } = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
  assert.deepEqual(errors, [])
  const files = fs.readdirSync(rendererRoot, { recursive: true })
    .filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .map(file => path.join(rendererRoot, file))
  const graph = new Map()

  for (const file of files) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const dependencies = new Set()
    const visit = node => {
      let specifier
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        specifier = node.moduleSpecifier
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        specifier = node.arguments[0]
        assert.ok(specifier && ts.isStringLiteral(specifier), `Audit nonliteral import in ${path.relative(root, file)}`)
      }
      if (specifier && ts.isStringLiteral(specifier)) {
        const resolved = ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule
        if (resolved) dependencies.add(path.resolve(resolved.resolvedFileName))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    graph.set(file, dependencies)
  }

  const reachable = new Set()
  const visit = file => {
    if (reachable.has(file)) return
    reachable.add(file)
    for (const dependency of graph.get(file) || []) visit(dependency)
  }
  visit(path.join(rendererRoot, 'main.tsx'))

  assert.deepEqual(files.filter(file => !reachable.has(file)).map(file => path.relative(root, file)), [],
    'Remove retired renderer modules, or register their real production entrypoint instead of retaining dead code')
  for (const file of files.filter(file => path.dirname(file) === path.join(rendererRoot, 'pages'))) {
    assert.ok(reachable.has(file), `Lazy page must stay reachable: ${path.basename(file)}`)
  }
})
