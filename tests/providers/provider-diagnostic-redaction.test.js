const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const ts = require('typescript')
const vm = require('node:vm')

function sanitizedZaiSummary(node) {
  if (!ts.isObjectLiteralExpression(node)) return false
  // This exception applies ONLY inside the typed sanitized-error logger.
  let scope = node.parent
  while (scope && !ts.isFunctionDeclaration(scope)) scope = scope.parent
  if (!scope || scope.name?.text !== 'logZaiFailure' || scope.parameters.length !== 1
    || scope.parameters[0].name.getText() !== 'error' || scope.parameters[0].type?.getText() !== 'ZaiUpstreamError') return false
  return node.getText().replace(/\s+/g, '') === '{category:error.category,...(error.upstreamCode!==undefined?{code:error.upstreamCode}:{})}'
}

function allowlistedContentType(node) {
  if (!ts.isConditionalExpression(node) || !ts.isIdentifier(node.whenTrue) || node.whenTrue.text !== 'contentType'
    || !ts.isStringLiteral(node.whenFalse) || node.whenFalse.text !== 'other') return false
  const condition = node.condition
  if (!ts.isCallExpression(condition) || condition.arguments.length !== 1 || !ts.isIdentifier(condition.arguments[0])
    || condition.arguments[0].text !== 'contentType' || !ts.isPropertyAccessExpression(condition.expression)
    || condition.expression.name.text !== 'includes' || !ts.isArrayLiteralExpression(condition.expression.expression)) return false
  const allowed = condition.expression.expression.elements
  return allowed.length === 2 && allowed.every(ts.isStringLiteral)
    && allowed[0].text === 'application/json' && allowed[1].text === 'text/event-stream'
}

// An allowlist keeps diagnostic arguments numeric/static or deliberately public.
// Never load provider modules, account stores, authentication or the network here.
function safeDiagnosticArgument(node) {
  if (sanitizedZaiSummary(node) || allowlistedContentType(node)) return true
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true
  if (ts.isParenthesizedExpression(node)) return safeDiagnosticArgument(node.expression)
  if (ts.isTypeOfExpression(node)) return true
  if (ts.isIdentifier(node)) return ['model', 'mappedModel', 'page'].includes(node.text)
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === 'length') return true
    if (node.name.text === 'status' && ts.isIdentifier(node.expression)) return /^(?:response|result|listResponse|deleteResponse)$/.test(node.expression.text)
    return ts.isIdentifier(node.expression) && node.expression.text === 'request'
      && ['model', 'reasoning_effort'].includes(node.name.text)
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
    return safeDiagnosticArgument(node.left) && safeDiagnosticArgument(node.right)
  }
  if (ts.isObjectLiteralExpression(node)) return node.properties.every(property => ts.isShorthandPropertyAssignment(property) && property.name.text === 'difficulty')
  return false
}

test('Z.ai log exceptions remain bounded: raw errors, payloads, extra fields and unfiltered MIME values are rejected', () => {
  function argument(expression, typedScope = true) {
    const source = ts.createSourceFile('fixture.ts', `function ${typedScope ? 'logZaiFailure(error: ZaiUpstreamError)' : 'other(error: any)'} { console.warn('fixture', ${expression}) }`, ts.ScriptTarget.Latest, true)
    return source.statements[0].body.statements[0].expression.arguments[1]
  }
  const safeSummary = '{ category: error.category, ...(error.upstreamCode !== undefined ? { code: error.upstreamCode } : {}) }'
  assert.equal(safeDiagnosticArgument(argument(safeSummary)), true)
  assert.equal(safeDiagnosticArgument(argument(safeSummary, false)), false)
  for (const unsafe of ['error', 'raw.error', 'payload', 'response.data', 'error.category', 'contentType',
    '{ category: error.category, payload }', '{ category: error.category, raw: error }', '{ ...error }',
    "['application/json', 'text/event-stream', payload].includes(contentType) ? contentType : 'other'",
    "['application/json', 'text/event-stream'].includes(contentType) ? contentType : payload"]) {
    assert.equal(safeDiagnosticArgument(argument(unsafe)), false, unsafe)
  }
})

test('the real Z.ai classifier and typed logger expose only bounded categories and numeric codes', () => {
  const filename = join(__dirname, '../../src/main/proxy/adapters/zai.ts')
  const source = readFileSync(filename, 'utf8')
  // Load only the pure classifier + logger, excluding all adapters/imports/storage.
  const pure = source.slice(source.indexOf('type ZaiFailureCategory'), source.indexOf('/** Capture at most'))
  const logs = []
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(`${pure}\nexports.logForTest = logZaiFailure`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: module.exports, module, console: { warn: (...args) => logs.push(args) } })
  const { classifyZaiFailure, ZaiUpstreamError, logForTest } = module.exports
  for (const code of [403, -1, 1000000, 'SECRET-CODE', Infinity]) {
    const error = classifyZaiFailure({ code, message: 'captcha required SECRET-PAYLOAD', headers: { authorization: 'SECRET-TOKEN' } })
    assert.ok(error instanceof ZaiUpstreamError)
    assert.equal(error.category, 'captcha_required')
    assert.equal(error.upstreamCode, code === 403 ? 403 : undefined)
    logForTest(error)
    assert.doesNotMatch(error.message, /SECRET/)
  }
  assert.doesNotMatch(JSON.stringify(logs), /SECRET|authorization|headers|payload|stack/)
  assert.deepEqual(JSON.parse(JSON.stringify(logs[0][1])), { category: 'captcha_required', code: 403 })
})

for (const provider of ['deepseek', 'glm', 'zai']) {
  test(`${provider} diagnostics omit credentials, signatures, raw request/response bodies and error objects`, () => {
    const filename = join(__dirname, '../../src/main/proxy/adapters', `${provider}.ts`)
    const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
    let checked = 0
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console') {
        for (const argument of node.arguments) assert.ok(safeDiagnosticArgument(argument), `${provider}: unsafe diagnostic argument ${argument.getText(source)}`)
        checked++
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    assert.ok(checked > 0, 'Expected provider status diagnostics to remain available')
  })
}
