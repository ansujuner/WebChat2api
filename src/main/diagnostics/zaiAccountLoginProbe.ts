import { storeManager } from '../store/store'
import { reauthenticateAccount } from '../oauth/accountReauthentication'
import { zaiAccountBrowserManager } from '../oauth/zaiAccountBrowser'

/** Explicit existing-account browser restore. Never exports identity or credentials. */
export async function runZaiAccountLoginProbe(progress: (report: object) => Promise<void>): Promise<object> {
  const base = { live: false, stream: false, protocol: 'openai', chatTested: false }
  const accounts = storeManager.getAccounts().filter(account => account.providerId === 'zai')
  if (accounts.length !== 1) return { ...base, status: 'account_selection_required', accountCount: accounts.length }
  const account = accounts[0]
  const before = { id: account.id, revision: account.credentialRevision || 0, enabled: account.enabled, cooldownUntil: account.cooldownUntil }
  await progress({ ...base, status: 'awaiting_login', accountCount: 1 })
  try {
    let settled = false
    const login = reauthenticateAccount(account.id).finally(() => { settled = true })
    // Progress carries only fixed diagnostics. Read-only auth is not a generated chat.
    while (!settled) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([login, new Promise<void>(resolve => { timer = setTimeout(resolve, 1500) })]) }
      finally { if (timer) clearTimeout(timer) }
      if (!settled) {
        const browser = zaiAccountBrowserManager.getAccountState(account.id)
        await progress({ ...base, status: 'awaiting_login', windowOpen: browser.windowOpen, authenticated: browser.authenticated,
          exactOrigin: browser.exactOrigin, stage: browser.stage, nativeErrorCode: browser.nativeErrorCode, verificationFailure: browser.verificationFailure })
      }
    }
    const result = await login
    const current = storeManager.getAccountById(account.id)
    const afterCount = storeManager.getAccounts().filter(item => item.providerId === 'zai').length
    const browser = zaiAccountBrowserManager.getAccountState(account.id)
    return { ...base, status: result.success ? 'passed' : 'login_not_completed',
      accountVerified: result.success, state: result.state, ...(!result.success ? { errorCode: result.errorCode } : {}),
      sameAccountRetained: current?.id === before.id && afterCount === accounts.length,
      credentialVersionDelta: current ? (current.credentialRevision || 0) - before.revision : null,
      schedulingPreserved: current?.enabled === before.enabled && current?.cooldownUntil === before.cooldownUntil,
      windowOpen: browser.windowOpen, authenticated: browser.authenticated, exactOrigin: browser.exactOrigin,
      stage: browser.stage, nativeErrorCode: browser.nativeErrorCode, verificationFailure: browser.verificationFailure }
  } catch {
    return { ...base, status: 'login_not_completed', accountVerified: false, errorCode: 'operation_failed' }
  }
}
