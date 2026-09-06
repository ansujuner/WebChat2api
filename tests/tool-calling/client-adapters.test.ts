import test from 'node:test'
import assert from 'node:assert/strict'

import { getToolClientAdapter } from '../../src/main/proxy/toolCalling/clientAdapters/index.ts'
import type { ChatCompletionRequest } from '../../src/main/proxy/types.ts'
import { ToolChoicePolicyError } from '../../src/main/proxy/toolCalling/toolChoicePolicy.ts'

function request(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: 'weather in Hangzhou?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'weather-test:get_weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    }],
    tool_choice: 'auto',
    ...overrides,
  }
}

test('standard OpenAI adapter normalizes OpenAI tools and tool_choice', () => {
  const adapter = getToolClientAdapter('standard-openai-tools')
  const result = adapter.normalizeRequest(request())

  assert.equal(result.clientAdapterId, 'standard-openai-tools')
  assert.equal(result.toolSource, 'openai')
  assert.deepEqual(result.tools.map((tool) => tool.name), ['weather-test:get_weather'])
  assert.equal(result.toolChoice.mode, 'auto')
})

test('Cherry Studio MCP adapter preserves exact MCP tool names', () => {
  const adapter = getToolClientAdapter('cherry-studio-mcp')
  const result = adapter.normalizeRequest(request())

  assert.equal(result.clientAdapterId, 'cherry-studio-mcp')
  assert.equal(result.toolSource, 'mcp')
  assert.deepEqual(result.tools.map((tool) => tool.name), ['weather-test:get_weather'])
  assert.equal(result.tools[0].name.includes('getWeather'), false)
})

test('forced tool choice validates against normalized tools', () => {
  const adapter = getToolClientAdapter('standard-openai-tools')
  const result = adapter.normalizeRequest(request({
    tool_choice: { type: 'function', function: { name: 'weather-test:get_weather' } },
  }))

  assert.equal(result.toolChoice.mode, 'forced')
  assert.equal(result.toolChoice.forcedName, 'weather-test:get_weather')
})

test('unknown adapter falls back to standard adapter metadata and records diagnostic hint', () => {
  const adapter = getToolClientAdapter('unknown-client')
  const result = adapter.normalizeRequest(request())

  assert.equal(adapter.id, 'standard-openai-tools')
  assert.equal(result.diagnostics.requestedClientAdapterId, 'unknown-client')
  assert.equal(result.diagnostics.fallbackClientAdapterId, 'standard-openai-tools')
})

for (const id of ['standard-openai-tools', 'cherry-studio-mcp']) {
  test(`${id} rejects required tools and undeclared forced choices instead of silently disabling tools`, () => {
    const adapter = getToolClientAdapter(id)
    for (const tools of [undefined, []]) {
      assert.throws(() => adapter.normalizeRequest(request({ tools, tool_choice: 'required' })),
        (error) => error instanceof ToolChoicePolicyError && error.code === 'tool_choice_required_without_tools')
    }
    assert.throws(() => adapter.normalizeRequest(request({
      tool_choice: { type: 'function', function: { name: 'not-declared' } },
    })), (error) => error instanceof ToolChoicePolicyError && error.code === 'tool_choice_forced_tool_not_found')
    assert.equal(adapter.normalizeRequest(request({ tool_choice: 'required' })).toolChoice.mode, 'required')
  })
}
