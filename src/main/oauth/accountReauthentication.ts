import { storeManager } from '../store/store'
import { accountEmail, accountUserId } from '../../shared/accountIdentity'
import type { AccountReauthenticationErrorCode, AccountReauthenticationResult } from '../../shared/accountReauthentication'
import { zaiAccountBrowserManager } from './zaiAccountBrowser'

const inFlight = new Set<string>()
const browserErrorCodes = new Set<AccountReauthenticationErrorCode>([
  'busy', 'cancelled', 'timeout', 'identity_mismatch', 'identity_unverified', 'login_required',
  'network_error', 'browser_error', 'account_changed',
])
const failure = (accountId: string, errorCode: AccountReauthenticationErrorCode): AccountReauthenticationResult =>
  ({ success: false, accountId, state: 'failed', errorCode })

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
    if (account.providerId !== 'zai' || provider?.id !== 'zai' || provider.type !== 'builtin') return failure(accountId, 'unsupported_provider')
    const expected = { providerId: account.providerId, credentialRevision: account.credentialRevision ?? 0,
      credentials: { ...account.credentials }, email: accountEmail(account.email), providerUserId: accountUserId(account.providerUserId) }
    const expectedIdentity = { userId: expected.providerUserId, email: expected.email }
    const config = storeManager.getConfig()
    stage = 'authenticate'
    // This manager uses the real website's authenticated profile response, not OAuth/JWT claims.
    const result = await zaiAccountBrowserManager.authenticate({ accountId, credentials: { ...expected.credentials }, expectedIdentity,
      proxyMode: config.oauthProxyMode === 'none' ? 'none' : 'system' })
    if (!result.success) {
      const code = result.errorCode as AccountReauthenticationErrorCode
      return failure(accountId, browserErrorCodes.has(code) ? code : 'browser_error')
    }
    const token = result.credentials?.token
    if (typeof token !== 'string' || !token.trim() || token.length > 128 * 1024 || /\s/.test(token)) return failure(accountId, 'identity_unverified')
    const userId = accountUserId(result.accountInfo?.userId)
    const email = accountEmail(result.accountInfo?.email)
    if ((!userId && !email) || email?.toLowerCase().endsWith('@guest.com')) return failure(accountId, 'identity_unverified')
    if ((expected.providerUserId && userId !== expected.providerUserId)
      || (expected.email && email?.toLowerCase() !== expected.email.toLowerCase())) return failure(accountId, 'identity_mismatch')
    stage = 'save'
    const state = storeManager.commitAccountReauthentication(accountId, expected, {
      credentials: { token }, accountInfo: { userId, email },
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

/** Account deletion also disposes its owned browser. A deleted account can never be recreated by an in-flight login. */
export async function clearAccountReauthentication(accountId: string): Promise<void> {
  try { await zaiAccountBrowserManager.clearAccount(accountId) }
  catch { console.error('[Account login] The deleted account browser could not be cleared yet.') }
}
