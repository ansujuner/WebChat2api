import type { Account } from '../store/types'

interface AccountUsageStore {
  getAccountById(id: string): Pick<Account, 'requestCount' | 'todayUsed'> | undefined
  updateAccount(id: string, updates: Partial<Account>): unknown
}

const count = (value: number | undefined): number => Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 0

/** Read and update synchronously at completion, not from an in-flight request's stale snapshot. */
export function recordAccountSuccess(store: AccountUsageStore, accountId: string): void {
  const current = store.getAccountById(accountId)
  // An account can be removed while its request is running. Never recreate it.
  if (!current) return
  store.updateAccount(accountId, {
    lastUsed: Date.now(),
    requestCount: count(current.requestCount) + 1,
    todayUsed: count(current.todayUsed) + 1,
  })
}
