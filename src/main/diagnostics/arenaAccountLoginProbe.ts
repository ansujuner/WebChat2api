import { storeManager } from '../store/store'
import { reauthenticateAccount } from '../oauth/accountReauthentication'

/** Explicit existing-account restore. Never chooses another account or creates a profile. */
export async function runArenaAccountLoginProbe(progress: (report: object) => Promise<void>): Promise<object> {
  const base = { live: false, stream: false, protocol: 'openai', chatTested: false }
  const accounts = storeManager.getAccounts().filter(account => account.providerId === 'arena')
  if (accounts.length !== 1) return { ...base, status: 'account_selection_required', accountCount: accounts.length }
  const account = accounts[0]
  const before = { revision: account.credentialRevision || 0, enabled: account.enabled, cooldownUntil: account.cooldownUntil }
  await progress({ ...base, status: 'awaiting_login', accountCount: 1 })
  try {
    const result = await reauthenticateAccount(account.id)
    const current = storeManager.getAccountById(account.id)
    const sameAccountRetained = current?.id === account.id && current.providerId === 'arena'
      && storeManager.getAccounts().filter(item => item.providerId === 'arena').length === 1
    const success = result.success && sameAccountRetained
    return { ...base, status: success ? 'passed' : 'login_not_completed', accountVerified: success,
      state: result.state, ...(!result.success ? { errorCode: result.errorCode } : {}), sameAccountRetained,
      credentialVersionDelta: current ? (current.credentialRevision || 0) - before.revision : null,
      schedulingPreserved: current?.enabled === before.enabled && current?.cooldownUntil === before.cooldownUntil }
  } catch {
    return { ...base, status: 'login_not_completed', accountVerified: false, errorCode: 'operation_failed' }
  }
}
