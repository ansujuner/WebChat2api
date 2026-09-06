/**
 * Proxy Service Module - Models Route
 * Implements /v1/models route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import type { ModelsResponse, ModelInfo } from '../types'
import { storeManager } from '../../store/store'
import { matchesModelPattern } from '../modelMappingResolver'
import { accountAvailability } from '../../../shared/accountAvailability'

const router = new Router({ prefix: '/v1' })

/**
 * Get all available models
 */
function availableModelCatalog(): ModelInfo[] {
  const providers = storeManager.getProviders().filter(provider => provider.enabled
    && storeManager.getAccountsByProviderId(provider.id).some(account => accountAvailability(account).available))
  const models: ModelInfo[] = []
  const addedModels = new Set<string>()

  for (const provider of providers) {
    const effectiveModels = storeManager.getEffectiveModels(provider.id)
    for (const model of effectiveModels) {
      if (/^arena\//i.test(model.displayName) && provider.id !== 'arena') continue
      if (!addedModels.has(model.displayName)) {
        addedModels.add(model.displayName)
        models.push({
          id: model.displayName,
          object: 'model',
          created: Math.floor(provider.createdAt / 1000),
          owned_by: provider.name,
        })
      }
    }
  }

  const config = storeManager.getConfig()
  const mappings = config.modelMappings || {}
  for (const [requestModel, mapping] of Object.entries(mappings)) {
    if (/^arena\//i.test(requestModel)) continue
    if (!mapping || typeof mapping.actualModel !== 'string' || !mapping.actualModel.trim()) continue
    // A saved alias is configuration, not evidence that its target is available.
    // Match the existing forwarding rule without selecting/decrypting an account.
    const availableProvider = providers.find(provider => {
      if (provider.id === 'arena') return false // Arena exposes only its verified modality namespace, not global aliases.
      if (mapping.preferredProviderId) return mapping.preferredProviderId === provider.id
      const effectiveModels = storeManager.getEffectiveModels(provider.id)
      return effectiveModels.length === 0 || effectiveModels.some(model => modelMatches(mapping.actualModel, model.displayName))
    })
    if (!availableProvider) continue
    if (!addedModels.has(requestModel)) {
      addedModels.add(requestModel)
      models.push({
        id: requestModel,
        object: 'model',
        created: Math.floor(availableProvider.createdAt / 1000),
        owned_by: 'model-mapping',
      })
    }
  }

  return models
}

function modelMatches(requested: string, supported: string): boolean {
  const name = supported.toLowerCase()
  return name.endsWith('*') ? requested.toLowerCase().startsWith(name.slice(0, -1)) : name === requested.toLowerCase()
}

router.get('/models', async (ctx: Context) => {
  const models = availableModelCatalog()

  const response: ModelsResponse = {
    object: 'list',
    data: models,
  }

  ctx.set('Content-Type', 'application/json')
  ctx.body = ctx.get('anthropic-version') ? {
    ...response,
    data: models.map(model => ({ ...model, type: 'model', display_name: model.id,
      created_at: new Date(model.created * 1000).toISOString() })),
    has_more: false,
    first_id: models[0]?.id ?? null,
    last_id: models[models.length - 1]?.id ?? null,
  } : response
})

/**
 * Get specified model info
 */
router.get('/models/:model', async (ctx: Context) => {
  const modelId = ctx.params.model
  const catalog = availableModelCatalog()
  const found = catalog.find(model => model.id === modelId)
    || catalog.find(model => !/^arena\//i.test(model.id) && matchesModelPattern(modelId, model.id))
  if (found) {
    ctx.set('Content-Type', 'application/json')
    ctx.body = ctx.get('anthropic-version') ? {
      ...found, id: modelId, type: 'model', display_name: found.id,
      created_at: new Date(found.created * 1000).toISOString(),
    } : { ...found, id: modelId }
    return
  }

  ctx.status = 404
  ctx.body = {
    error: {
      message: `Model '${modelId}' not found`,
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    },
  }
})

export default router
