export const DEFAULT_GLM_ASSISTANT_ID = '65940acff94777010aa6b796'

interface GlmModelRequest {
  model: string
  originalModel?: string
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max'
  deep_research?: boolean
  web_search?: boolean
}

/** Translate client options into the Qingyan website's actual metadata fields. */
export function resolveGlmModelOptions(request: GlmModelRequest) {
  const modelLower = request.model.toLowerCase()
  const isCurrentModel = ['glm-5.3-flash', 'glm-flash', 'glm-5.3'].includes(modelLower)
  const isAssistantId = /^[a-z0-9]{24,}$/.test(request.model)
  const featureName = (request.originalModel || request.model).toLowerCase()
  const selectedModel = isAssistantId
    ? undefined
    : modelLower === 'glm-flash'
      ? 'glm-5.3-flash'
      : isCurrentModel ? modelLower : request.model

  // Current web effort options: quick='', deep='thinking', extreme='deep_thinking'.
  // Assistant IDs and explicit legacy routes retain their historical zero mode.
  const requestedMode = request.reasoning_effort
    ? isCurrentModel
      ? request.reasoning_effort === 'low' ? '' : request.reasoning_effort === 'max' ? 'deep_thinking' : 'thinking'
      : 'zero'
    : /think|zero/.test(featureName) ? (isCurrentModel ? 'thinking' : 'zero') : ''
  const chatMode = request.deep_research || (!requestedMode && featureName.includes('deepresearch'))
    ? 'deep_research'
    : requestedMode

  return {
    assistantId: isAssistantId ? request.model : DEFAULT_GLM_ASSISTANT_ID,
    selectedModel,
    chatMode,
    isNetworking: Boolean(request.web_search),
  }
}
