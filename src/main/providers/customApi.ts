import axios from 'axios'
import type { Provider } from '../../shared/types'
import { withProviderNetwork } from '../network/providerContext.ts'

/** Custom providers are OpenAI-compatible HTTP APIs, not website login adapters. */
export function normalizeCustomApiEndpoint(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('API Base URL is required (maximum 2048 characters)')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Invalid API Base URL') }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API Base URL must use HTTP or HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new Error('API Base URL must not contain credentials, query parameters, or a fragment')
  const path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models)$/, '')
  url.pathname = path || '/v1'
  return url.toString().replace(/\/+$/, '')
}

export function customApiUrl(provider: Pick<Provider, 'apiEndpoint'>, path: '/models' | '/chat/completions'): string {
  return `${normalizeCustomApiEndpoint(provider.apiEndpoint)}${path}`
}

/** Credentials belong only in the encrypted account store, never provider configuration/export. */
export function validateCustomHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Headers must be an object')
  if (Object.keys(value).length > 32) throw new Error('Too many custom headers')
  return Object.fromEntries(Object.entries(value).map(([key, content]) => {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || typeof content !== 'string' || /[\r\n\x00]/.test(content) || content.length > 4096) {
      throw new Error('Invalid custom header name or value')
    }
    if (/(?:authorization|cookie|api[-_]?key|token|secret|password)/i.test(key)) throw new Error('Authentication headers are not allowed here; add the API key in an account instead')
    if (/^(?:host|connection|content-length|transfer-encoding|proxy-.*)$/i.test(key)) throw new Error('Transport headers cannot be overridden')
    return [key, content]
  }))
}

export function customRequestHeaders(provider: Pick<Provider, 'headers' | 'credentialFields'>, credentials: Record<string, string>): Record<string, string> {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('Invalid account credentials')
  const value = credentials.apiKey || credentials.token || ''
  if (typeof value !== 'string' || /[\r\n\x00]/.test(value) || value.length > 8192) throw new Error('Invalid API key format')
  const apiKey = value.trim()
  const requiresKey = !provider.credentialFields?.some(field => field.name === 'apiKey' && field.required === false)
  if (!apiKey && requiresKey) throw new Error('Add an API key account first, or enable the no-key local service option')
  return { Accept: 'application/json', ...validateCustomHeaders(provider.headers), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }
}

export interface CustomModelCatalog { supportedModels: string[]; modelMappings: Record<string, string> }

export function parseCustomModels(data: unknown): CustomModelCatalog {
  const rows = data && typeof data === 'object' && !Array.isArray(data) && Object.hasOwn(data, 'data')
    ? (data as { data: unknown }).data : data
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('The /models endpoint did not return an OpenAI-compatible model list')
  const ids = rows.flatMap(row => {
    const id = typeof row === 'string' ? row : row && typeof row === 'object' ? row.id : undefined
    return typeof id === 'string' && id.trim() && id.length <= 256 && !/[\x00-\x1f\x7f]/.test(id) ? [id.trim()] : []
  })
  if (rows.length && !ids.length) throw new Error('The /models endpoint returned no valid model IDs')
  const supportedModels = [...new Set(ids)]
  return { supportedModels, modelMappings: Object.fromEntries(supportedModels.map(id => [id, id])) }
}

export class CustomApiError extends Error {}

/** Deliberately omit response bodies / Axios config: upstream errors may echo an API key. */
export async function fetchCustomModels(provider: Pick<Provider, 'id' | 'apiEndpoint' | 'headers' | 'credentialFields'>, credentials: Record<string, string> = {}): Promise<CustomModelCatalog> {
  return withProviderNetwork(provider.id, async () => {
  let url: string
  let headers: Record<string, string>
  try { url = customApiUrl(provider, '/models'); headers = customRequestHeaders(provider, credentials) }
  catch (error) { throw new CustomApiError(error instanceof Error ? error.message : 'Invalid custom provider configuration') }
  try {
    const response = await axios.get(url, { headers, timeout: 15000, maxRedirects: 0, maxContentLength: 2 * 1024 * 1024, validateStatus: () => true })
    if (response.status === 401 || response.status === 403) throw new CustomApiError(`Authentication failed (HTTP ${response.status}); check this account's API key`)
    if (response.status === 404 || response.status === 405) throw new CustomApiError('This Base URL has no /models endpoint. Check the URL or enter model IDs manually; this does not prove the key is invalid.')
    if (response.status === 429) throw new CustomApiError('Model lookup is rate limited (HTTP 429); wait before retrying')
    if (response.status !== 200) throw new CustomApiError(`Model lookup failed (HTTP ${response.status}); redirects are not followed`)
    try { return parseCustomModels(response.data) }
    catch (error) { throw new CustomApiError(error instanceof Error ? error.message : 'Invalid model list') }
  } catch (error) {
    if (error instanceof CustomApiError) throw error
    if (axios.isAxiosError(error) && ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code || '')) throw new CustomApiError('Model lookup timed out; check the Base URL and network proxy')
    throw new CustomApiError('Unable to connect to the model endpoint; check the Base URL, certificate, and network proxy')
  }
  })
}
