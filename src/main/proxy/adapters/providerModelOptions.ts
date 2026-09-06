export interface DeepSeekChatOptionInput {
  model: string
  originalModel?: string
  web_search?: boolean
  reasoning_effort?: string
}

export interface DeepSeekChatOptions {
  modelType: 'default' | 'expert' | 'vision'
  searchEnabled: boolean
  thinkingEnabled: boolean
}

export function resolveDeepSeekChatOptions(
  request: DeepSeekChatOptionInput,
  _prompt: string = ''
): DeepSeekChatOptions {
  const modelLower = request.model.toLowerCase()
  // The mapped model selects the upstream; the client alias only adds features.
  // The current official web bundle exposes default/expert/vision model types.
  // Accept only the verified vision ID, not arbitrary API-only lookalikes.
  const isVisionModel = modelLower === 'deepseek-v4-flash-vision-exp'
  if (modelLower.includes('vision') && !isVisionModel) throw new Error('Unsupported DeepSeek vision model; use deepseek-v4-flash-vision-exp')
  const featureModelLower = `${modelLower} ${(request.originalModel || '').toLowerCase()}`
  const isProModel = modelLower.includes('deepseek-v4-pro') || modelLower.includes('expert')
  const isSearchAlias = featureModelLower.includes('search')
  const isThinkingAlias = featureModelLower.includes('think')
    || featureModelLower.includes('r1')
    || featureModelLower.includes('reasoner')

  return {
    modelType: isVisionModel ? 'vision' : isProModel ? 'expert' : 'default',
    searchEnabled: Boolean(request.web_search) || isSearchAlias,
    thinkingEnabled: Boolean(request.reasoning_effort)
      || isThinkingAlias,
  }
}

export type KimiScenario = 'SCENARIO_K2D5' | 'SCENARIO_OK_COMPUTER'
export type KimiReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max'

export function resolveKimiWebModel(model: string): 'k2d6-chat' | 'k3-agent' {
  const normalized = model.trim().toLowerCase()
  // Entry IDs come from the 2026-09-05 public web bundle, not Kimi's API catalog.
  if (normalized === 'k3-agent' || /^(?:kimi-)?k3(?:-(?:think|thinking|search))*$/.test(normalized)) return 'k3-agent'
  if (normalized === 'k2d6-chat' || /^(?:kimi-)?k2\.[56](?:-(?:think|thinking|search))*$/.test(normalized)) return 'k2d6-chat'
  throw new Error(`Unsupported Kimi web model "${model}". Use Kimi-K3 or Kimi-K2.6; Code API IDs and Swarm are not interchangeable with web chat.`)
}

export function resolveKimiScenario(model: string): KimiScenario {
  // Runtime GetAvailableModels confirms these enums. SCENARIO_K2D6 does not exist.
  return resolveKimiWebModel(model) === 'k3-agent' ? 'SCENARIO_OK_COMPUTER' : 'SCENARIO_K2D5'
}

export function createKimiChatPayload(options: {
  model: string
  content: string
  enableWebSearch: boolean
  enableThinking?: boolean
  reasoning_effort?: KimiReasoningEffort
  conversationId?: string
  parentMessageId?: string
}) {
  const model = resolveKimiWebModel(options.model)
  const scenario = resolveKimiScenario(options.model)
  const isK3 = model === 'k3-agent'
  const effort = options.reasoning_effort
  if (effort !== undefined && !['none', 'low', 'medium', 'high', 'max'].includes(effort)) {
    throw new Error(`Unsupported Kimi reasoning effort "${effort}"`)
  }
  if (isK3 && effort === 'none') {
    throw new Error('Kimi K3 requires thinking; use reasoning_effort="low" or choose Kimi-K2.6')
  }
  // The website uses NONE/LOW for K2.6 and LOW/HIGH/MAX for K3.
  // OpenAI medium maps to K3 HIGH; K2.6's strongest website setting is LOW.
  const reasoningEffort = isK3
    ? (effort === 'max' ? 'MAX' : effort === 'low' || (effort === undefined && options.enableThinking === false) ? 'LOW' : 'HIGH')
    : (effort === 'none' || (effort === undefined && options.enableThinking === false) ? 'NONE' : 'LOW')

  return {
    scenario,
    chat_id: options.conversationId || '',
    ...(isK3 ? { kimiplus_id: 'ok-computer' } : {}),
    tools: options.enableWebSearch ? [{ type: 'TOOL_TYPE_SEARCH', search: {} }] : [],
    message: {
      parent_id: options.parentMessageId || '',
      role: 'user',
      blocks: [{
        message_id: '',
        text: { content: options.content }
      }],
      scenario,
    },
    options: {
      // Current web requests keep this enabled and express the level separately.
      thinking: true,
      reasoning_effort: `REASONING_EFFORT_${reasoningEffort}`,
      model,
      ...(isK3 ? { context_length: 'CONTEXT_LENGTH_L' } : {}),
    }
  }
}

export function encodeKimiGrpcFrame(payload: unknown): Buffer {
  const jsonBuffer = Buffer.from(JSON.stringify(payload), 'utf8')
  const frameBuffer = Buffer.alloc(5 + jsonBuffer.length)
  frameBuffer.writeUInt8(0, 0)
  frameBuffer.writeUInt32BE(jsonBuffer.length, 1)
  jsonBuffer.copy(frameBuffer, 5)
  return frameBuffer
}

/** Matrix send_msg selects the model on the server, not via an API model ID. */
export function resolveMiniMaxWebModel(model: string = 'minimax-agent'): 'MiniMax-Agent' {
  const normalized = model.trim().toLowerCase()
  if (normalized === 'minimax-agent' || normalized === 'minimax-m2.7') return 'MiniMax-Agent'
  throw new Error(`Unsupported MiniMax web model "${model}". This adapter uses the server-selected Agent route; MiniMax M3 requires the new Code protocol or the official API.`)
}
