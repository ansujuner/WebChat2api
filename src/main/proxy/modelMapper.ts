/**
 * Proxy Service Module - Model Mapper
 * Supports mapping request models to actual models
 */

import { storeManager } from '../store/store'
import { ModelMapping, Provider } from '../store/types'
import { resolveModelMapping } from './modelMappingResolver'

/**
 * Model mapper
 */
export class ModelMapper {
  /**
   * Map model name
   * @param requestedModel Requested model name
   * @param provider Provider (optional, for provider-specific mapping)
   */
  mapModel(requestedModel: string, provider?: Provider): string {
    return resolveModelMapping(requestedModel, storeManager.getConfig().modelMappings, provider?.id)?.actualModel ?? requestedModel
  }

  getActualModel(requestedModel: string, providerId?: string): string {
    return resolveModelMapping(requestedModel, storeManager.getConfig().modelMappings, providerId)?.actualModel ?? requestedModel
  }

  getPreferredProvider(requestedModel: string): string | undefined {
    return resolveModelMapping(requestedModel, storeManager.getConfig().modelMappings)?.preferredProviderId
  }

  getPreferredAccount(requestedModel: string): string | undefined {
    return resolveModelMapping(requestedModel, storeManager.getConfig().modelMappings)?.preferredAccountId
  }

  /**
   * Add model mapping
   */
  addMapping(requestModel: string, actualModel: string, preferredProviderId?: string, preferredAccountId?: string): void {
    const config = storeManager.getConfig()
    config.modelMappings[requestModel] = {
      requestModel,
      actualModel,
      preferredProviderId,
      preferredAccountId,
    }
    storeManager.getStore()?.set('config', config)
  }

  /**
   * Remove model mapping
   */
  removeMapping(requestModel: string): boolean {
    const config = storeManager.getConfig()
    if (config.modelMappings[requestModel]) {
      delete config.modelMappings[requestModel]
      storeManager.getStore()?.set('config', config)
      return true
    }
    return false
  }

  /**
   * Get all mappings
   */
  getAllMappings(): Record<string, ModelMapping> {
    const config = storeManager.getConfig()
    return { ...config.modelMappings }
  }

  /**
   * Get list of providers supporting specified model
   */
  getProvidersForModel(model: string): Provider[] {
    const providers = storeManager.getProviders().filter(p => p.enabled)
    const preferredProviderId = this.getPreferredProvider(model)

    if (preferredProviderId) {
      const preferred = providers.find(p => p.id === preferredProviderId)
      if (preferred) {
        return [preferred]
      }
    }

    return providers.filter(provider => {
      const effectiveModels = storeManager.getEffectiveModels(provider.id)
      if (effectiveModels.length === 0) {
        return true
      }

      const normalizedModel = model.toLowerCase()
      return effectiveModels.some(m => {
        const normalizedSupported = m.displayName.toLowerCase()
        if (normalizedSupported.endsWith('*')) {
          return normalizedModel.startsWith(normalizedSupported.slice(0, -1))
        }
        return normalizedSupported === normalizedModel
      })
    })
  }
}

export const modelMapper = new ModelMapper()
export default modelMapper
