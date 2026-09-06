const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const utils = path.join(root, 'src/main/proxy/utils')
const plain = value => JSON.parse(JSON.stringify(value))

/** Load the actual pure legacy helpers, never Electron, app storage or accounts. */
function fixture() {
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }
    cache.set(file, module)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    vm.runInNewContext(code, { module, exports: module.exports, console: { log() {}, warn() {}, error() {} },
      require(name) {
        if (name === 'node:crypto') return { randomUUID: require('node:crypto').randomUUID }
        assert.ok(name.startsWith('.'), 'legacy helper tests cannot import external app dependencies')
        const candidate = path.resolve(path.dirname(file), name)
        assert.ok(candidate.startsWith(path.join(root, 'src/main/proxy') + path.sep))
        const dependency = [candidate, candidate + '.ts', path.join(candidate, 'index.ts')].find(value => fs.existsSync(value) && fs.statSync(value).isFile())
        assert.ok(dependency, name)
        return load(dependency)
      },
    }, { filename: file })
    return module.exports
  }
  return { load }
}

test('legacy utils barrel resolves shared symbols to unified implementations and preserves unique legacy helpers', () => {
  const f = fixture(), barrel = f.load(path.join(utils, 'index.ts'))
  const unified = f.load(path.join(utils, 'toolParser/index.ts')), legacy = f.load(path.join(utils, 'streamToolHandler.ts'))
  assert.equal(barrel.flushToolCallBuffer, unified.flushToolCallBuffer)
  assert.equal(barrel.shouldBlockOutput, unified.shouldBlockOutput)
  assert.equal(barrel.createBaseChunk, legacy.createBaseChunk)
  assert.equal(barrel.createToolCallState, legacy.createToolCallState)
  assert.equal(barrel.processStreamContent, legacy.processStreamContent)
  assert.equal(typeof barrel.toolsToSystemPrompt, 'function')
  assert.equal(typeof barrel.parseToolCallsStream, 'function')
})

test('adapter-used legacy base chunks and per-call state remain executable without importing a nonexistent factory', () => {
  const f = fixture(), file = path.join(utils, 'streamToolHandler.ts'), legacy = f.load(file)
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const unified = f.load(path.join(utils, 'toolParser/index.ts'))
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || node.moduleSpecifier.text !== './toolParser/index' || node.importClause?.isTypeOnly) continue
    for (const item of node.importClause.namedBindings.elements) if (!item.isTypeOnly) assert.ok(Object.hasOwn(unified, item.propertyName?.text ?? item.name.text))
  }
  const base = legacy.createBaseChunk('fixture-id', 'fixture-model', 123)
  assert.deepEqual(plain(base), { id: 'fixture-id', model: 'fixture-model', object: 'chat.completion.chunk', created: 123 })
  const first = legacy.createToolCallState(), second = legacy.createToolCallState()
  assert.notEqual(first, second)
  assert.deepEqual(plain(first), { contentBuffer: '', isBufferingToolCall: false, toolCallIndex: 0, hasEmittedToolCall: false })
  const result = legacy.processStreamContent('ordinary text', first, base, true)
  assert.equal(result.chunks[0].choices[0].delta.content, 'ordinary text')
  assert.equal(result.chunks[0].id, 'fixture-id')
  assert.equal(second.contentBuffer, '')
})

test('legacy compatibility entrypoints have no ambiguous export or missing imported factory diagnostics', () => {
  const files = [path.join(utils, 'index.ts'), path.join(utils, 'streamToolHandler.ts')]
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true, skipLibCheck: true, strict: true, allowImportingTsExtensions: true })
  const issues = ts.getPreEmitDiagnostics(program).filter(item => item.file && files.includes(path.resolve(item.file.fileName)) && [2305, 2308].includes(item.code))
  assert.deepEqual(issues.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')), [])
})
