/** Run the released tests with a narrow case-sensitive filesystem fixture correction. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const source = fs.realpathSync(process.argv[2])
const file = path.join(source, 'tests/providers/model-catalog-routing.test.js')
const original = fs.readFileSync(file, 'utf8')
const wrong = "join(root, 'src/main/proxy/loadBalancer.ts')"
const correct = "join(root, 'src/main/proxy/loadbalancer.ts')"
const needsPatch = original.includes(wrong)
assert.equal(original.split(needsPatch ? wrong : correct).length, 2, 'Unexpected routing test fixture')
const patched = needsPatch ? original.replace(wrong, correct) : original
const output = path.join(source, 'artifacts/tests.tap')
const fd = fs.openSync(output, 'w')
let result
try {
  if (needsPatch) fs.writeFileSync(file, patched)
  result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=4', 'tests/**/*.test.*'], {
    cwd: source, stdio: ['ignore', fd, fd], timeout: 600000,
  })
} finally {
  if (needsPatch) fs.writeFileSync(file, original)
  fs.closeSync(fd)
}
assert.equal(fs.readFileSync(file, 'utf8'), original, 'Released test file was not restored')
fs.writeFileSync(path.join(source, 'artifacts/test-compatibility.json'), JSON.stringify({
  fixturePathCaseCorrected: needsPatch,
  correction: needsPatch ? 'tests/providers/model-catalog-routing.test.js: loadBalancer.ts -> loadbalancer.ts' : null,
  applicationSourceModified: false, releasedTestRestored: true,
}, null, 2) + '\n')
console.log(fs.readFileSync(output, 'utf8').split('\n').slice(-20).join('\n'))
if (result.error) console.error(result.error.message)
process.exitCode = result.status === 0 ? 0 : 1
