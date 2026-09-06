const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const fixture = read('scripts/smoke-custom-tools.cjs')

test('native tools production smoke is called from the isolated real app harness', () => {
  const harness = read('scripts/smoke-app.cjs')
  assert.match(harness, /require\('\.\/smoke-custom-tools\.cjs'\)\(\{ invoke, check, port \}\)/)
  assert.match(harness, /productionProfileUsed: false/)
  assert.match(harness, /windowsHide: true/)
  assert.match(fixture, /window\.electronAPI/)
  assert.doesNotMatch(fixture, /readFile|process\.env|https:\/\//)
})

test('native tools smoke verifies both client adapters and both API protocols with streaming', () => {
  assert.match(fixture, /standard-openai-tools', 'cherry-studio-mcp/)
  assert.match(fixture, /for \(const anthropic of \[false, true\]\) for \(const stream of \[false, true\]\)/)
  for (const marker of ['/v1/messages', '/v1/chat/completions', 'tool_call_id', 'tool_use_id', 'input_json_delta', '[DONE]', 'message_stop']) assert.ok(fixture.includes(marker), marker)
  assert.match(fixture, /assert\.equal\(second\.text, marker\)/)
  assert.match(fixture, /assert\.equal\(records\.length, 12\)/)
})

test('custom fixture checks model-fetch failures and uses only cleaned-up loopback resources', () => {
  assert.match(fixture, /upstream\.listen\(0, '127\.0\.0\.1'/)
  assert.match(fixture, /hostname: '127\.0\.0\.1'/)
  assert.match(fixture, /previous\?\.tool_calls\?\.\[0\]\?\.id, toolResult\.tool_call_id/)
  assert.match(fixture, /retained\.supportedModels\.includes\(model\)/)
  assert.match(fixture, /!JSON\.stringify\(rejected\)\.includes\(token\)/)
  assert.match(fixture, /call\('providers', 'delete', providerId\)/)
  assert.match(fixture, /upstream\.closeAllConnections\(\)/)
})

test('custom-provider guide explains native API scope and separates keys and verification', () => {
  const guide = read('docs/providers/custom.md')
  for (const marker of ['OpenAI', 'API Key', 'tool_choice', 'parallel_tool_calls', 'tool_call_id', '无状态', '验证码', '不自动重试', 'English quick guide']) assert.ok(guide.includes(marker), marker)
  assert.match(guide, /不是输入任意网页地址/)
  assert.match(guide, /未验证工具能力/)
})
