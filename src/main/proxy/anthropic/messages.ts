import { randomUUID } from 'node:crypto'
import type { ChatCompletionRequest, ChatMessage, ChatMessageContent, ChatCompletionMessageToolCall } from '../types.ts'

/** Errors are intentionally safe to serialize; never include the original request. */
export class AnthropicProtocolError extends Error {
  readonly status: number
  readonly type: string
  constructor(message: string, status = 400, type = 'invalid_request_error') {
    super(message)
    this.name = 'AnthropicProtocolError'
    this.status = status
    this.type = type
  }
}

type Dict = Record<string, unknown>
function object(value: unknown, path: string): Dict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AnthropicProtocolError(`${path} must be an object`)
  return value as Dict
}
function text(value: unknown, path: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw new AnthropicProtocolError(`${path} must be a ${empty ? '' : 'non-empty '}string`)
  return value
}
function unsupported(path: string): never {
  throw new AnthropicProtocolError(`${path} is not supported by the Chat2API Messages compatibility endpoint`)
}
function onlyKeys(value: Dict, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key) && value[key] !== undefined) unsupported(`${path}.${key}`)
}
function numberInRange(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new AnthropicProtocolError(`${path} must be a number between ${min} and ${max}`)
  }
  return value
}

function plainBlock(value: unknown, path: string, allowImages: boolean): ChatMessageContent {
  const block = object(value, path)
  if (block.type === 'text') {
    onlyKeys(block, ['type', 'text', 'cache_control', 'citations'], path)
    if (block.citations !== undefined && block.citations !== null && (!Array.isArray(block.citations) || block.citations.length)) unsupported(`${path}.citations`)
    return { type: 'text', text: text(block.text, `${path}.text`, true) }
  }
  if (block.type === 'image' && allowImages) {
    onlyKeys(block, ['type', 'source', 'cache_control'], path)
    const source = object(block.source, `${path}.source`)
    if (source.type === 'url') {
      onlyKeys(source, ['type', 'url'], `${path}.source`)
      const url = text(source.url, `${path}.source.url`)
      try { if (!['https:', 'http:'].includes(new URL(url).protocol)) unsupported(`${path}.source.url protocol`) }
      catch (error) { if (error instanceof AnthropicProtocolError) throw error; throw new AnthropicProtocolError(`${path}.source.url is invalid`) }
      return { type: 'image_url', image_url: { url } }
    }
    if (source.type === 'base64') {
      onlyKeys(source, ['type', 'media_type', 'data'], `${path}.source`)
      if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(String(source.media_type))) unsupported(`${path}.source.media_type`)
      const data = text(source.data, `${path}.source.data`)
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 === 1) throw new AnthropicProtocolError(`${path}.source.data must be base64`)
      return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${data}` } }
    }
    unsupported(`${path}.source.type`)
  }
  unsupported(`${path}.type (${String(block.type)})`)
}
function collapse(parts: ChatMessageContent[]): ChatMessage['content'] {
  return parts.every(part => part.type === 'text') ? parts.map(part => part.text ?? '').join('') : parts
}

function convertMessage(value: unknown, index: number): ChatMessage[] {
  const path = `messages[${index}]`
  const message = object(value, path)
  onlyKeys(message, ['role', 'content'], path)
  if (message.role !== 'user' && message.role !== 'assistant') throw new AnthropicProtocolError(`${path}.role must be user or assistant; use the top-level system field for instructions`)
  const role = message.role
  if (typeof message.content === 'string') return [{ role, content: message.content }]
  if (!Array.isArray(message.content) || !message.content.length) throw new AnthropicProtocolError(`${path}.content must be a string or non-empty content-block array`)
  const converted: ChatMessage[] = []
  let parts: ChatMessageContent[] = []
  let calls: ChatCompletionMessageToolCall[] = []
  const flush = (): void => {
    if (!parts.length && !calls.length) return
    converted.push({ role, content: parts.length ? collapse(parts) : null, ...(calls.length ? { tool_calls: calls } : {}) })
    parts = []
    calls = []
  }
  for (const [blockIndex, value] of message.content.entries()) {
    const blockPath = `${path}.content[${blockIndex}]`
    const block = object(value, blockPath)
    if (block.type === 'tool_result') {
      if (role !== 'user') throw new AnthropicProtocolError(`${blockPath}: tool_result must be in a user message`)
      onlyKeys(block, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'], blockPath)
      const id = text(block.tool_use_id, `${blockPath}.tool_use_id`)
      if (block.is_error !== undefined && typeof block.is_error !== 'boolean') throw new AnthropicProtocolError(`${blockPath}.is_error must be a boolean`)
      let content: ChatMessage['content']
      if (block.content === undefined) content = ''
      else if (typeof block.content === 'string') content = block.content
      else if (Array.isArray(block.content)) content = collapse(block.content.map((part, i) => plainBlock(part, `${blockPath}.content[${i}]`, true)))
      else throw new AnthropicProtocolError(`${blockPath}.content must be a string or content-block array`)
      if (block.is_error) content = typeof content === 'string' ? `[Tool execution error]\n${content}` : [{ type: 'text', text: '[Tool execution error]\n' }, ...(content ?? [])]
      flush()
      converted.push({ role: 'tool', tool_call_id: id, content })
    } else if (block.type === 'tool_use') {
      if (role !== 'assistant') throw new AnthropicProtocolError(`${blockPath}: tool_use must be in an assistant message`)
      onlyKeys(block, ['type', 'id', 'name', 'input', 'cache_control', 'caller'], blockPath)
      if (block.caller !== undefined && object(block.caller, `${blockPath}.caller`).type !== 'direct') unsupported(`${blockPath}.caller`)
      calls = [...calls, { id: text(block.id, `${blockPath}.id`), type: 'function', function: {
        name: text(block.name, `${blockPath}.name`), arguments: JSON.stringify(object(block.input, `${blockPath}.input`)),
      } }]
    } else {
      parts = [...parts, plainBlock(block, blockPath, role === 'user')]
    }
  }
  flush()
  return converted
}

/** Convert the supported client-tool subset, without mutating or forwarding Anthropic-only metadata. */
export function convertAnthropicRequest(body: unknown): ChatCompletionRequest {
  const value = object(body, 'request')
  onlyKeys(value, ['model', 'max_tokens', 'messages', 'system', 'tools', 'tool_choice', 'stream', 'temperature', 'top_p',
    'stop_sequences', 'metadata', 'thinking', 'output_config', 'cache_control', 'service_tier', 'session_id', 'sessionId', 'new_conversation'], 'request')
  const model = text(value.model, 'model')
  if (!Number.isSafeInteger(value.max_tokens) || (value.max_tokens as number) <= 0) throw new AnthropicProtocolError('max_tokens must be a positive integer (cache-only requests are not supported)')
  if (!Array.isArray(value.messages) || !value.messages.length) throw new AnthropicProtocolError('messages must be a non-empty array')
  const system: ChatMessage[] = []
  if (value.system !== undefined) {
    if (typeof value.system === 'string') system.push({ role: 'system', content: value.system })
    else if (Array.isArray(value.system)) system.push({ role: 'system', content: value.system.map((block, i) => plainBlock(block, `system[${i}]`, false).text ?? '').join('\n\n') })
    else throw new AnthropicProtocolError('system must be a string or text-block array')
  }
  const request: ChatCompletionRequest = { model, max_tokens: value.max_tokens as number, messages: [...system, ...value.messages.flatMap(convertMessage)] }
  if (value.stream !== undefined) {
    if (typeof value.stream !== 'boolean') throw new AnthropicProtocolError('stream must be a boolean')
    request.stream = value.stream
  }
  if (value.temperature !== undefined) request.temperature = numberInRange(value.temperature, 'temperature', 0, 1)
  if (value.top_p !== undefined) request.top_p = numberInRange(value.top_p, 'top_p', 0, 1)
  if (value.stop_sequences !== undefined) {
    if (!Array.isArray(value.stop_sequences) || value.stop_sequences.some(s => typeof s !== 'string' || !s.length)) throw new AnthropicProtocolError('stop_sequences must be an array of non-empty strings')
    request.stop = [...value.stop_sequences] as string[]
  }
  if (value.metadata !== undefined) {
    const metadata = object(value.metadata, 'metadata')
    onlyKeys(metadata, ['user_id'], 'metadata')
    // Claude Code includes session_id in this JSON string. Preserve the complete stable identity.
    if (metadata.user_id !== undefined && metadata.user_id !== null) request.user = text(metadata.user_id, 'metadata.user_id')
  }
  if (value.service_tier !== undefined && value.service_tier !== 'auto') unsupported('service_tier')
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) throw new AnthropicProtocolError('tools must be an array')
    request.tools = value.tools.map((item, index) => {
      const path = `tools[${index}]`
      const tool = object(item, path)
      onlyKeys(tool, ['type', 'name', 'description', 'input_schema', 'cache_control', 'strict', 'defer_loading'], path)
      if (tool.type !== undefined && tool.type !== 'custom') unsupported(`${path}.type (server and built-in tools require native Anthropic execution)`)
      if (tool.strict !== undefined && tool.strict !== false) unsupported(`${path}.strict`)
      if (tool.defer_loading !== undefined && tool.defer_loading !== false) unsupported(`${path}.defer_loading`)
      const schema = object(tool.input_schema, `${path}.input_schema`)
      if (schema.type !== 'object') throw new AnthropicProtocolError(`${path}.input_schema.type must be object`)
      return { type: 'function' as const, function: { name: text(tool.name, `${path}.name`),
        ...(tool.description !== undefined ? { description: text(tool.description, `${path}.description`, true) } : {}),
        parameters: structuredClone(schema),
      } }
    })
    const names = request.tools.map(tool => tool.function.name)
    if (new Set(names).size !== names.length) throw new AnthropicProtocolError('tools names must be unique')
  }
  if (value.tool_choice !== undefined) {
    const choice = object(value.tool_choice, 'tool_choice')
    onlyKeys(choice, ['type', 'name', 'disable_parallel_tool_use'], 'tool_choice')
    if (choice.disable_parallel_tool_use !== undefined && choice.disable_parallel_tool_use !== false) unsupported('tool_choice.disable_parallel_tool_use')
    if (choice.type === 'auto' || choice.type === 'none') request.tool_choice = choice.type
    else if (choice.type === 'any') request.tool_choice = 'required'
    else if (choice.type === 'tool') {
      const name = text(choice.name, 'tool_choice.name')
      if (!request.tools?.some(tool => tool.function.name === name)) throw new AnthropicProtocolError('tool_choice.name must name a supplied tool')
      request.tool_choice = { type: 'function', function: { name } }
    } else unsupported('tool_choice.type')
    if (choice.type !== 'tool' && choice.name !== undefined) throw new AnthropicProtocolError('tool_choice.name is only valid with type tool')
    if ((choice.type === 'any' || choice.type === 'tool') && !request.tools?.length) throw new AnthropicProtocolError('tool_choice requires tools')
  }
  if (value.thinking !== undefined) {
    const thinking = object(value.thinking, 'thinking')
    onlyKeys(thinking, ['type', 'budget_tokens', 'display'], 'thinking')
    if (thinking.display !== undefined && thinking.display !== 'omitted') unsupported('thinking.display (signed thinking blocks cannot be produced by website providers)')
    if (thinking.type === 'enabled') {
      if (!Number.isSafeInteger(thinking.budget_tokens) || (thinking.budget_tokens as number) < 1024 || (thinking.budget_tokens as number) >= (value.max_tokens as number)) throw new AnthropicProtocolError('thinking.budget_tokens must be an integer >= 1024 and less than max_tokens')
      request.reasoning_effort = 'high'
    } else if (thinking.type === 'adaptive') {
      if (thinking.budget_tokens !== undefined) unsupported('thinking.budget_tokens with adaptive thinking')
      request.reasoning_effort = 'high'
    } else if (thinking.type === 'disabled') {
      if (thinking.budget_tokens !== undefined) unsupported('thinking.budget_tokens with disabled thinking')
    } else unsupported('thinking.type')
  }
  if (value.output_config !== undefined) {
    const config = object(value.output_config, 'output_config')
    onlyKeys(config, ['effort'], 'output_config')
    if (config.effort !== undefined) {
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(String(config.effort))) unsupported('output_config.effort')
      // Website providers expose no separate xhigh level: approximate it with their highest effort.
      request.reasoning_effort = config.effort === 'xhigh' ? 'max' : config.effort as ChatCompletionRequest['reasoning_effort']
    }
  }
  for (const key of ['session_id', 'sessionId'] as const) if (value[key] !== undefined) request[key] = text(value[key], key)
  if (value.new_conversation !== undefined) {
    if (typeof value.new_conversation !== 'boolean') throw new AnthropicProtocolError('new_conversation must be a boolean')
    request.new_conversation = value.new_conversation
  }
  return request
}

/** No tokenizer or native Anthropic billing is available: this is a conservative local estimate. */
export function estimateAnthropicInputTokens(body: unknown): number {
  const value = object(body, 'request')
  const request = convertAnthropicRequest({ ...value, max_tokens: value.max_tokens ?? Number.MAX_SAFE_INTEGER })
  const serialized = JSON.stringify({ messages: request.messages, tools: request.tools, tool_choice: request.tool_choice })
  // Count UTF-8 bytes rather than JS code units so CJK/emoji are not severely underestimated.
  return Math.max(1, Math.ceil(Buffer.byteLength(serialized, 'utf8') / 3))
}

function upstreamError(message: string): never { throw new AnthropicProtocolError(message, 502, 'api_error') }

/** Return native Messages output. Unverifiable provider reasoning is never fabricated as signed thinking. */
export function convertOpenAIResponse(body: unknown, model?: string): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) upstreamError('Upstream returned an invalid chat response')
  const response = body as Dict
  if (!Array.isArray(response.choices) || !response.choices.length) upstreamError('Upstream chat response has no choices')
  if (response.choices.length !== 1) upstreamError('Messages compatibility requires exactly one upstream choice')
  const choice = response.choices[0] as Dict
  if (!choice || typeof choice !== 'object' || Array.isArray(choice) || !choice.message || typeof choice.message !== 'object' || Array.isArray(choice.message)) upstreamError('Upstream chat response has no assistant message')
  if (typeof choice.finish_reason !== 'string' || !['stop', 'length', 'content_filter', 'tool_calls'].includes(choice.finish_reason)) upstreamError('Upstream chat response has no supported terminal finish_reason')
  const message = choice.message as Dict
  if (message.role !== 'assistant') upstreamError('Upstream chat response role must be assistant')
  if (message.function_call !== undefined) upstreamError('Legacy upstream function_call is not supported; use tool_calls')
  const content: Dict[] = []
  const callIds = new Set<string>()
  if (typeof message.content === 'string' && message.content.length) content.push({ type: 'text', text: message.content })
  else if (message.content !== undefined && message.content !== null && message.content !== '') upstreamError('Upstream assistant content must be text')
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) upstreamError('Upstream tool_calls must be an array')
    for (const item of message.tool_calls) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) upstreamError('Upstream tool call is malformed')
      const call = item as Dict
      const fn = call.function as Dict | undefined
      if (call.type !== 'function' || typeof call.id !== 'string' || !call.id.trim() || !fn || typeof fn !== 'object' || Array.isArray(fn) || typeof fn.name !== 'string' || !fn.name.trim() || typeof fn.arguments !== 'string') upstreamError('Upstream tool call is malformed')
      if (callIds.has(call.id)) upstreamError('Upstream tool call IDs must be unique')
      callIds.add(call.id)
      let input: unknown
      try { input = JSON.parse((fn.arguments as string).trim() || '{}') } catch { upstreamError('Upstream tool arguments are not valid JSON') }
      if (!input || typeof input !== 'object' || Array.isArray(input)) upstreamError('Upstream tool arguments must be a JSON object')
      content.push({ type: 'tool_use', id: call.id, name: fn.name, input })
    }
  }
  if (choice.finish_reason === 'tool_calls' && !callIds.size) upstreamError('Upstream finished with tool_calls but supplied no tools')
  if (!content.length) content.push({ type: 'text', text: '' })
  const usage = response.usage && typeof response.usage === 'object' ? response.usage as Dict : {}
  const tokens = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
  const stopReason = choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason === 'content_filter' ? 'refusal'
    : callIds.size ? 'tool_use' : 'end_turn'
  // Website adapters sometimes encode upstream session IDs in response.id. Keep them internal.
  return { id: typeof response.id === 'string' && response.id.startsWith('msg_') ? response.id : `msg_${randomUUID().replaceAll('-', '')}`,
    type: 'message', role: 'assistant', model: model ?? (typeof response.model === 'string' ? response.model : 'unknown'), content,
    stop_reason: stopReason, stop_sequence: null,
    usage: { input_tokens: tokens(usage.prompt_tokens), output_tokens: tokens(usage.completion_tokens) },
    ...(typeof response.session_id === 'string' ? { session_id: response.session_id } : {}),
  }
}
