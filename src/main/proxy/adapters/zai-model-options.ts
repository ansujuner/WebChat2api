/** Web model identifiers from chat.z.ai /api/models, audited 2026-09-06. */
export const DEFAULT_ZAI_WEB_MODEL = 'x-preview-l'

const ZAI_WEB_MODEL_IDS: Readonly<Record<string, string>> = {
  'glm-5.3-flash': DEFAULT_ZAI_WEB_MODEL,
  'glm-5.3': 'glm-5.3',
  'glm-5.2': 'glm-5.2',
  'glm-5-turbo': 'GLM-5-Turbo',
  'glm-5v-turbo': 'GLM-5v-Turbo',
  'glm-4.7': 'glm-4.7',
  // Retain historical input normalization for explicit custom mappings.
  // They are not advertised as current defaults and are not silently upgraded.
  'glm-5.1': 'GLM-5.1',
  'glm-5': 'glm-5',
}

export function resolveZaiWebModel(model: string): string {
  const key = model.toLowerCase()
  return Object.hasOwn(ZAI_WEB_MODEL_IDS, key) ? ZAI_WEB_MODEL_IDS[key] : model
}

export function isZaiThinkingRequired(model: string): boolean {
  const resolvedModel = resolveZaiWebModel(model)
  // /api/models explicitly sets skip_think: false for the current 5.3 models.
  return resolvedModel === DEFAULT_ZAI_WEB_MODEL || resolvedModel === 'glm-5.3'
}
