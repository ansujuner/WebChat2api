export interface ArenaProviderCatalog { supportedModels: string[]; modelMappings: Record<string, string> }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const validAlias = (value: unknown): value is string => typeof value === 'string' && /^arena\/(text|image)\/[^\x00-\x1f\x7f*]{1,160}$/.test(value)

export function arenaProfileCredentials(value: unknown): { browserProfileId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !uuid((value as Record<string, unknown>).browserProfileId) ||
    Object.keys(value).some(key => key !== 'browserProfileId')) throw new Error('Arena accounts must come from isolated browser login and store only browserProfileId.')
  return { browserProfileId: (value as { browserProfileId: string }).browserProfileId }
}

export function runtimeArenaCatalog(value: unknown): ArenaProviderCatalog {
  if (!value || typeof value !== 'object' || (value as any).source !== 'runtime' || !Array.isArray((value as any).models)) throw new Error('Sign in to Arena to discover its live account model catalog. Public snapshots are not advertised as available models.')
  const supportedModels: string[] = [], modelMappings: Record<string, string> = {}, seen = new Set<string>()
  for (const model of (value as any).models.slice(0, 2000)) {
    if (!model || !uuid(model.id) || !['text', 'image'].includes(model.modality) || typeof model.name !== 'string') continue
    const alias = `arena/${model.modality}/${model.name.trim()}`
    if (!validAlias(alias) || seen.has(alias.toLowerCase())) continue
    seen.add(alias.toLowerCase()); supportedModels.push(alias); modelMappings[alias] = model.id
  }
  if (!supportedModels.length) throw new Error('Arena did not provide any valid runtime models. Finish login and refresh the model list.')
  return { supportedModels, modelMappings }
}

/** Preserve only previously discovered namespaced UUID mappings, never wildcard/API defaults. */
export function savedArenaCatalog(models: unknown, mappings: unknown): ArenaProviderCatalog {
  const supportedModels = Array.isArray(models) ? models.filter(model => validAlias(model) && mappings && typeof mappings === 'object' && uuid((mappings as any)[model])) : []
  return { supportedModels: [...new Set(supportedModels)], modelMappings: Object.fromEntries(supportedModels.map(model => [model, (mappings as any)[model]])) }
}
