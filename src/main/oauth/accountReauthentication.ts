import { storeManager } from '../store/store'
import { accountEmail, accountUserId } from '../../shared/accountIdentity'
import { supportsAccountLogin, type AccountReauthenticationErrorCode, type AccountReauthenticationResult } from '../../shared/accountReauthentication'
import { zaiAccountBrowserManager } from './zaiAccountBrowser'
import { arenaBrowserManager } from '../arena/browserManager'
import { oauthManager } from './manager'
import type { ProviderType } from './types'
import { getProviderProxyConfig, withProviderNetwork } from '../network/proxy'

const inFlight = new Set<string>()
const arenaAccountProfiles = new Map<string, string>()
const browserErrorCodes = new Set<AccountReauthenticationErrorCode>([
  'busy', 'cancelled', 'timeout', 'identity_mismatch', 'identity_unverified', 'login_required',
  'network_error', 'route_changed', 'browser_error', 'account_changed', 'invalid_account',
  'profile_unavailable', 'browser_not_found', 'browser_start_failed', 'browser_connection_failed', 'page_not_ready',
])
const failure = (accountId: string, errorCode: AccountReauthenticationErrorCode): AccountReauthenticationResult =>
  ({ success: false, accountId, state: 'failed', errorCode })

/** Keep only this provider's canonical credential fields; never retain stale proofs or another site's tokens. */
export function normalizeBuiltinLoginCredentials(providerId: string, input: unknown): Record<string, string> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  const fields: Record<string, string[]> = {
    deepseek: ['token'], glm: ['refresh_token'], kimi: ['token'], minimax: ['token', 'realUserID'],
    mimo: ['service_token', 'user_id', 'ph_token'], qwen: ['ticket'], 'qwen-ai': ['token', 'cookies'], perplexity: ['sessionToken'],
  }
  const aliases: Record<string, Record<string, string[]>> = {
    deepseek: { token: ['userToken'] }, glm: { refresh_token: ['chatglm_refresh_token'] },
    qwen: { ticket: ['tongyi_sso_ticket'] }, perplexity: { sessionToken: ['__Secure-next-auth.session-token', 'next-auth.session-token'] },
    mimo: { service_token: ['serviceToken'], user_id: ['userId'], ph_token: ['xiaomichatbot_ph'] },
  }
  const selected = fields[providerId]
  if (!selected) return null
  const credentials: Record<string, string> = {}
  for (const field of selected) {
    let value = raw[field] ?? aliases[providerId]?.[field]?.map(alias => raw[alias]).find(value => value !== undefined)
    if (providerId === 'deepseek' && typeof value === 'string' && value.startsWith('{')) {
      try { value = JSON.parse(value).value } catch { return null }
    }
    if (value === undefined || value === '') continue
    if (typeof value !== 'string' || !value.trim() || value.length > 128 * 1024 || /[\r\n\x00]/.test(value)) return null
    credentials[field] = value
  }
  const required = providerId === 'mimo' ? selected : [selected[0]]
  return required.every(field => !!credentials[field]) ? credentials : null
}

function sameCredentials(left: Record<string, string>, right: Record<string, string>): boolean {
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right, key) && left[key] === right[key])
}

/** The renderer selects only an account ID; credentials, provider routing, verification and saving stay in main. */
export async function reauthenticateAccount(input: unknown): Promise<AccountReauthenticationResult> {
  if (typeof input !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input)) return failure('', 'invalid_account')
  const accountId = input
  if (inFlight.has(accountId)) return failure(accountId, 'busy')
  inFlight.add(accountId)
  let stage: 'prepare' | 'authenticate' | 'save' = 'prepare'
  try {
    const account = storeManager.getAccountById(accountId, true)
    if (!account) return failure(accountId, 'invalid_account')
    const provider = storeManager.getProviderById(account.providerId)
    if (!provider || provider.id !== account.providerId || provider.type !== 'builtin' || !supportsAccountLogin(provider.id)) return failure(accountId, 'unsupported_provider')
    const expected = { providerId: account.providerId, credentialRevision: account.credentialRevision ?? 0,
      credentials: { ...account.credentials }, email: accountEmail(account.email), providerUserId: accountUserId(account.providerUserId) }
    let expectedIdentity = { userId: expected.providerUserId, email: expected.email }
    const isAccountCurrent = () => {
      const current = storeManager.getAccountById(accountId, true)
      return !!current && current.providerId === expected.providerId && (current.credentialRevision ?? 0) === expected.credentialRevision
        && accountEmail(current.email) === expected.email && accountUserId(current.providerUserId) === expected.providerUserId
        && sameCredentials(current.credentials, expected.credentials) && storeManager.getProviderById(expected.providerId)?.type === 'builtin'
    }
    stage = 'authenticate'
    const result = await withProviderNetwork(provider.id, async (): Promise<{ success: boolean; credentials?: Record<string, string>; accountInfo?: { userId?: string; email?: string }; errorCode?: string }> => {
      if (provider.id === 'zai') {
        // Preserve the verified saved-token restoration flow; never use OAuth/JWT claims here.
        return zaiAccountBrowserManager.authenticate({ accountId, credentials: { ...expected.credentials }, expectedIdentity,
          proxyConfig: getProviderProxyConfig(provider.id) })
      }
      if (provider.id === 'arena') {
        const profileId = expected.credentials.browserProfileId
        if (typeof profileId !== 'string') return { success: false, errorCode: 'invalid_account' }
        arenaAccountProfiles.set(accountId, profileId)
        const login = await arenaBrowserManager.reauthenticate({ profileId, expectedEmail: expected.email, isAccountCurrent })
        return { ...login, credentials: login.success && login.profileId === profileId ? { browserProfileId: profileId } : undefined }
      }
      const providerType = provider.id as ProviderType
      if (!expectedIdentity.email && !expectedIdentity.userId) {
        const baseline = await oauthManager.validateToken(provider.id, providerType, { ...expected.credentials })
        if (!isAccountCurrent()) return { success: false, errorCode: 'account_changed' }
        if (!baseline.valid) return { success: false, errorCode: 'identity_unverified' }
        expectedIdentity = { email: accountEmail(baseline.accountInfo?.email), userId: accountUserId(baseline.accountInfo?.userId) }
        if (!expectedIdentity.email && !expectedIdentity.userId) return { success: false, errorCode: 'identity_unverified' }
      }
      const login = await oauthManager.startInAppLogin(provider.id, providerType, undefined, getProviderProxyConfig(provider.id))
      if (!login.success) {
        if (login.errorCode && browserErrorCodes.has(login.errorCode)) return { success: false, errorCode: login.errorCode }
        const error = typeof login.error === 'string' ? login.error.toLowerCase() : ''
        return { success: false, errorCode: error.includes('already') || error.includes('in progress') ? 'busy'
          : error.includes('cancel') || error.includes('closed') ? 'cancelled' : error.includes('timeout') ? 'timeout' : 'browser_error' }
      }
      const credentials = normalizeBuiltinLoginCredentials(provider.id, login.credentials)
      if (!credentials) return { success: false, errorCode: 'identity_unverified' }
      return { success: true, credentials, accountInfo: login.accountInfo }
    })
    if (!isAccountCurrent()) return failure(accountId, 'account_changed')
    if (!result.success) {
      const code = result.errorCode as AccountReauthenticationErrorCode
      return failure(accountId, browserErrorCodes.has(code) ? code : 'browser_error')
    }
    let credentials = result.credentials
    if (provider.id === 'zai') {
      const token = credentials?.token
      if (typeof token !== 'string' || !token.trim() || token.length > 128 * 1024 || /\s/.test(token)) return failure(accountId, 'identity_unverified')
      credentials = { token }
    }
    if (!credentials || !Object.keys(credentials).length) return failure(accountId, 'identity_unverified')
    const userId = accountUserId(result.accountInfo?.userId)
    const email = accountEmail(result.accountInfo?.email)
    if ((!userId && !email) || email?.toLowerCase().endsWith('@guest.com')) return failure(accountId, 'identity_unverified')
    if ((expectedIdentity.userId && userId !== expectedIdentity.userId)
      || (expectedIdentity.email && email?.toLowerCase() !== expectedIdentity.email.toLowerCase())) return failure(accountId, 'identity_mismatch')
    stage = 'save'
    const state = storeManager.commitAccountReauthentication(accountId, expected, {
      credentials, accountInfo: { userId, email },
    })
    if (!state) return failure(accountId, 'account_changed')
    return { success: true, accountId, state }
  } catch {
    // Browser/native/store errors may contain URLs or credentials. Return only fixed public codes.
    return failure(accountId, stage === 'save' ? 'save_failed' : stage === 'authenticate' ? 'browser_error' : 'invalid_account')
  } finally {
    inFlight.delete(accountId)
  }
}

/** Capture in main before deletion, including accounts that never used reauthentication.
 * Only the selected Arena record needs decryption; the closure exports no credentials.
 */
export function captureAccountBrowserCleanup(accountId: string): () => Promise<void> {
  const metadata = storeManager.getAccountById(accountId)
  const account = metadata?.providerId === 'arena' ? storeManager.getAccountById(accountId, true) : undefined
  const profileId = account?.providerId === 'arena' && typeof account.credentials.browserProfileId === 'string'
    ? account.credentials.browserProfileId : undefined
  return () => clearAccountReauthentication(accountId, profileId)
}

/** Account deletion also disposes its owned browser. A deleted account can never be recreated by an in-flight login.
 * capturedProfileId is a main-process snapshot only; no renderer/API channel accepts it.
 */
export async function clearAccountReauthentication(accountId: string, capturedProfileId?: string): Promise<void> {
  try { await zaiAccountBrowserManager.clearAccount(accountId) }
  catch { console.error('[Account login] The deleted account browser could not be cleared yet.') }
  const profileIds = new Set([capturedProfileId, arenaAccountProfiles.get(accountId)].filter((id): id is string => !!id))
  arenaAccountProfiles.delete(accountId)
  for (const profileId of profileIds) {
    try { await arenaBrowserManager.clearProfile(profileId) }
    catch { console.error('[Account login] The deleted Arena account browser could not be cleared yet.') }
  }
}
