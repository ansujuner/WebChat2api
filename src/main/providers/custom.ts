import { storeManager } from '../store/store'
import type { Provider, AuthType } from '../../shared/types'
import { BUILTIN_PROVIDERS, type CredentialField } from '../store/types'
import { accountAvailability } from '../../shared/accountAvailability'
import { fetchCustomModels, normalizeCustomApiEndpoint, validateCustomHeaders, type CustomModelCatalog } from './customApi'

export interface CustomProviderData {
  id?: string
  name: string
  type?: 'builtin' | 'custom'
  authType: AuthType
  apiEndpoint: string
  chatPath?: string
  headers?: Record<string, string>
  description?: string
  icon?: string
  supportedModels?: string[]
  modelMappings?: Record<string, string>
  credentialFields?: CredentialField[]
}
export interface CustomProviderValidation { valid: boolean; errors: string[] }

function text(value: unknown, label: string, max: number, empty = true, multiline = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) throw new Error(`Invalid ${label}`)
  return value.trim()
}
function normalizeModels(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 10000) throw new Error('Invalid supported models list')
  return [...new Set(value.map(model => text(model, 'model ID', 256, false)))]
}
function normalizeFields(value: unknown, authType: AuthType): CredentialField[] {
  if (value === undefined) return CustomProviderManager.getTemplate(authType).credentialFields || []
  if (!Array.isArray(value) || value.length > 16) throw new Error('Invalid credential fields')
  const names = new Set<string>()
  return value.map(field => {
    if (!field || typeof field !== 'object') throw new Error('Invalid credential field')
    const name = text(field.name, 'credential field name', 64, false)
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || names.has(name)) throw new Error('Invalid or duplicate credential field name')
    names.add(name)
    if (!['text', 'password', 'textarea'].includes(field.type) || typeof field.required !== 'boolean') throw new Error('Invalid credential field type or requirement')
    return { name, label: text(field.label, 'credential field label', 100, false), type: field.type, required: field.required,
      ...(field.placeholder !== undefined ? { placeholder: text(field.placeholder, 'credential placeholder', 300) } : {}),
      ...(field.helpText !== undefined ? { helpText: text(field.helpText, 'credential help', 1000) } : {}) }
  })
}

export class CustomProviderManager {
  private static normalize(data: CustomProviderData, existingId?: string): Omit<Provider, 'id' | 'createdAt' | 'updatedAt' | 'enabled'> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid provider configuration')
    const name = text(data.name, 'provider name (1-50 characters)', 50, false)
    if (storeManager.getProviders().some(provider => provider.id !== existingId && provider.name.trim().toLowerCase() === name.toLowerCase())) throw new Error('Provider name already exists')
    if (!['oauth', 'token', 'cookie', 'userToken', 'refresh_token', 'jwt', 'realUserID_token', 'tongyi_sso_ticket'].includes(data.authType)) throw new Error('Invalid authentication type')
    if (data.type !== undefined && data.type !== 'custom') throw new Error('Custom providers cannot change provider type')
    if (data.chatPath !== undefined && data.chatPath !== '/chat/completions') throw new Error('Custom providers currently require the OpenAI-compatible /chat/completions endpoint')
    const supportedModels = normalizeModels(data.supportedModels)
    let modelMappings: Record<string, string> = Object.fromEntries(supportedModels.map(model => [model, model]))
    if (data.modelMappings !== undefined) {
      if (!data.modelMappings || typeof data.modelMappings !== 'object' || Array.isArray(data.modelMappings) || Object.keys(data.modelMappings).length > 10000) throw new Error('Invalid model mappings')
      const supplied = Object.fromEntries(Object.entries(data.modelMappings).map(([name, model]) => [text(name, 'model name', 256, false), text(model, 'model ID', 256, false)]))
      // The list is authoritative: preserve aliases still listed, drop removed keys, and map new IDs to themselves.
      modelMappings = Object.fromEntries(supportedModels.map(name => [name, Object.hasOwn(supplied, name) ? supplied[name] : name]))
    }
    return { name, type: 'custom', authType: data.authType, apiEndpoint: normalizeCustomApiEndpoint(data.apiEndpoint), chatPath: '/chat/completions',
      headers: validateCustomHeaders(data.headers), supportedModels, modelMappings, credentialFields: normalizeFields(data.credentialFields, data.authType),
      ...(data.description !== undefined ? { description: text(data.description, 'description', 1000, true, true) } : {}),
      ...(data.icon !== undefined ? { icon: text(data.icon, 'icon', 2048) } : {}) }
  }

  static validate(data: CustomProviderData): CustomProviderValidation {
    try { this.normalize(data, data?.id); return { valid: true, errors: [] } }
    catch (error) { return { valid: false, errors: [error instanceof Error ? error.message : 'Invalid provider configuration'] } }
  }

  static create(data: CustomProviderData): Provider {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid provider configuration')
    // Re-adding a known website provider always uses the trusted bundled configuration.
    if (data.type === 'builtin') {
      const builtin = BUILTIN_PROVIDERS.find(provider => provider.id === data.id)
      if (!builtin) throw new Error('Unknown built-in provider')
      const existing = storeManager.getProviderById(builtin.id)
      if (existing) return existing
      const now = Date.now()
      const provider: Provider = { ...builtin, createdAt: now, updatedAt: now }
      storeManager.addProvider(provider)
      return provider
    }
    if (data.id !== undefined && (typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(data.id))) throw new Error('Invalid provider ID')
    if (data.id && (storeManager.getProviderById(data.id) || BUILTIN_PROVIDERS.some(provider => provider.id === data.id))) throw new Error('Provider ID already exists or is reserved')
    const normalized = this.normalize(data)
    const now = Date.now()
    const provider: Provider = { ...normalized, id: data.id || storeManager.generateId(), enabled: true, createdAt: now, updatedAt: now }
    storeManager.addProvider(provider)
    storeManager.addLog('info', 'Created custom provider', { providerId: provider.id })
    return provider
  }

  static update(id: string, updates: Partial<Provider>): Provider {
    const existing = storeManager.getProviderById(id)
    if (!existing) throw new Error('Provider not found')
    if (existing.type !== 'custom') throw new Error('Cannot modify built-in provider')
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new Error('Invalid provider update')
    if (['id', 'type', 'createdAt'].some(key => key in updates)) throw new Error('Provider identity fields cannot be changed')
    if (updates.enabled !== undefined && typeof updates.enabled !== 'boolean') throw new Error('Invalid provider enabled value')
    if (updates.status !== undefined && !['online', 'offline', 'unknown'].includes(updates.status)) throw new Error('Invalid provider status')
    if (updates.lastStatusCheck !== undefined && (!Number.isSafeInteger(updates.lastStatusCheck) || updates.lastStatusCheck < 0)) throw new Error('Invalid provider status timestamp')
    const normalized = this.normalize({ ...existing, ...updates }, id)
    const updated = storeManager.updateProvider(id, { ...normalized,
      ...(updates.enabled !== undefined ? { enabled: updates.enabled } : {}),
      ...(updates.status !== undefined ? { status: updates.status } : {}),
      ...(updates.lastStatusCheck !== undefined ? { lastStatusCheck: updates.lastStatusCheck } : {}), updatedAt: Date.now() })
    if (!updated) throw new Error('Provider update could not be saved')
    storeManager.addLog('info', 'Updated custom provider', { providerId: id })
    return updated
  }

  static delete(id: string): boolean {
    const provider = storeManager.getProviderById(id)
    if (!provider) return false
    for (const account of storeManager.getAccountsByProviderId(id)) storeManager.deleteAccount(account.id)
    const result = storeManager.deleteProvider(id)
    if (result) storeManager.addLog('info', 'Deleted provider', { providerId: id })
    return result
  }

  static async fetchModels(id: string): Promise<CustomModelCatalog> {
    const provider = storeManager.getProviderById(id)
    if (!provider || provider.type !== 'custom') throw new Error('Custom provider not found')
    const account = storeManager.getAccountsByProviderId(id, true).find(account => accountAvailability(account).available)
    const result = await fetchCustomModels(provider, account?.credentials || {})
    const current = storeManager.getProviderById(id)
    if (!current || current.type !== 'custom' || current.apiEndpoint !== provider.apiEndpoint || JSON.stringify(current.headers) !== JSON.stringify(provider.headers) || JSON.stringify(current.credentialFields) !== JSON.stringify(provider.credentialFields)) {
      throw new Error('Provider configuration changed during model lookup; results were discarded. Retry using the saved configuration.')
    }
    if (account) {
      const currentAccount = storeManager.getAccountsByProviderId(id, true).find(item => item.id === account.id)
      if (!currentAccount || !accountAvailability(currentAccount).available || JSON.stringify(currentAccount.credentials) !== JSON.stringify(account.credentials)) {
        throw new Error('Account changed during model lookup; results were discarded. Retry with an available account.')
      }
    }
    if (!result.supportedModels.length) throw new Error('The endpoint returned an empty model list; existing models were preserved')
    // Discovery is additive. Merge the latest saved model edits rather than the pre-request snapshot;
    // explicit removals belong to the editor, while refresh must never erase manually entered IDs/aliases.
    const supportedModels = [...new Set([...(current.supportedModels || []), ...result.supportedModels])]
    const currentMappings = current.modelMappings || {}
    return {
      supportedModels,
      modelMappings: Object.fromEntries(supportedModels.map(name => [name,
        Object.hasOwn(currentMappings, name) ? currentMappings[name] : result.modelMappings[name] || name,
      ])),
    }
  }

  static duplicate(id: string, newName?: string): Provider {
    const existing = storeManager.getProviderById(id)
    if (!existing) throw new Error('Provider not found')
    return this.create({ name: newName || `${existing.name} (Copy)`, authType: existing.authType, apiEndpoint: existing.apiEndpoint,
      headers: existing.headers, description: existing.description, icon: existing.icon,
      supportedModels: existing.supportedModels, modelMappings: existing.modelMappings, credentialFields: existing.credentialFields })
  }

  static exportProvider(id: string): string {
    const provider = storeManager.getProviderById(id)
    if (!provider) throw new Error('Provider not found')
    // Old imports may contain plaintext authentication headers. Never export those secrets.
    const headers = Object.fromEntries(Object.entries(provider.headers).filter(([name]) => !/(?:authorization|cookie|api[-_]?key|token|secret|password)/i.test(name)))
    return JSON.stringify({ name: provider.name, authType: provider.authType, apiEndpoint: provider.apiEndpoint,
      headers, description: provider.description, supportedModels: provider.supportedModels,
      modelMappings: provider.modelMappings, credentialFields: provider.credentialFields }, null, 2)
  }

  static importProvider(jsonData: string): Provider {
    if (typeof jsonData !== 'string' || jsonData.length > 1024 * 1024) throw new Error('Provider import must be JSON smaller than 1 MB')
    let data: CustomProviderData
    try { data = JSON.parse(jsonData) } catch { throw new Error('Invalid JSON format') }
    if (data?.type === 'builtin') throw new Error('Imported providers must be custom providers')
    return this.create(data)
  }

  static getTemplate(authType: AuthType): CustomProviderData {
    const name = authType === 'token' ? 'apiKey' : authType === 'refresh_token' ? 'refresh_token' : authType === 'tongyi_sso_ticket' ? 'ticket' : authType === 'cookie' ? 'cookie' : 'token'
    return { name: '', authType, apiEndpoint: '', chatPath: '/chat/completions', headers: {}, description: '', supportedModels: [],
      credentialFields: [{ name, label: authType === 'token' ? 'API Key' : 'Token', type: 'password', required: true }] }
  }
}

export default CustomProviderManager
