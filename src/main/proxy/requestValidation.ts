export interface RequestValidationError { message: string; param: string }

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === 'string' && !!value.trim()

/** Validate supported optional fields before selection/session setup or a provider request. */
export function validateChatRequestOptions(body: Record<string, any>): RequestValidationError | null {
  const fail = (param: string, requirement: string): RequestValidationError => ({ param, message: `${param} ${requirement}` })
  for (const key of ['stream', 'web_search', 'deep_research', 'new_conversation', 'parallel_tool_calls']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') return fail(key, 'must be a boolean')
  }
  if (body.user !== undefined && typeof body.user !== 'string') return fail('user', 'must be a string')
  for (const [key, minimum, maximum, integer] of [
    ['temperature', 0, 2, false], ['top_p', 0, 1, false],
    ['presence_penalty', -2, 2, false], ['frequency_penalty', -2, 2, false],
    ['max_tokens', 1, Number.MAX_SAFE_INTEGER, true], ['max_completion_tokens', 1, Number.MAX_SAFE_INTEGER, true],
    ['n', 1, 128, true],
  ] as const) {
    const value = body[key]
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value)))) {
      return fail(key, `must be ${integer ? 'an integer' : 'a number'} between ${minimum} and ${maximum}`)
    }
  }
  if (body.stop !== undefined && body.stop !== null && !(typeof body.stop === 'string' ||
    (Array.isArray(body.stop) && body.stop.length <= 4 && body.stop.every((value: unknown) => typeof value === 'string')))) return fail('stop', 'must be a string or an array of up to four strings')
  if (body.tools !== undefined && body.tools !== null) {
    if (!Array.isArray(body.tools)) return fail('tools', 'must be an array of function definitions')
    for (const [index, tool] of body.tools.entries()) {
      if (!record(tool) || tool.type !== 'function' || !record(tool.function) || !nonempty(tool.function.name) ||
        (tool.function.description !== undefined && typeof tool.function.description !== 'string') ||
        (tool.function.parameters !== undefined && !record(tool.function.parameters))) return fail(`tools[${index}]`, 'must contain a function name and object parameters')
    }
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null && !['auto', 'none', 'required'].includes(body.tool_choice)) {
    if (!record(body.tool_choice) || body.tool_choice.type !== 'function' || !record(body.tool_choice.function) || !nonempty(body.tool_choice.function.name)) return fail('tool_choice', 'must select auto, none, required or a named function')
  }
  for (const [index, message] of body.messages.entries()) {
    if (message.role === 'tool' && !nonempty(message.tool_call_id)) return fail(`messages[${index}].tool_call_id`, 'is required for a tool result')
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) return fail(`messages[${index}].tool_calls`, 'must be a non-empty assistant function-call array')
      for (const call of message.tool_calls) {
        if (!record(call) || !nonempty(call.id) || call.type !== 'function' || !record(call.function) || !nonempty(call.function.name) || typeof call.function.arguments !== 'string') return fail(`messages[${index}].tool_calls`, 'must contain call IDs, function names and string arguments')
      }
    }
  }
  return null
}
