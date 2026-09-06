/** Scheduling state is independent of credential validity. Missing enabled means legacy enabled. */
export interface AccountAvailabilityInput {
  enabled?: boolean
  status: string
  cooldownUntil?: number
  cooldownReason?: 'temporary_ban'
  dailyLimit?: number
  todayUsed?: number
}
export type AccountAvailabilityReason = 'ready' | 'disabled' | 'cooldown' | 'inactive' | 'expired' | 'error' | 'daily_limit'

/** Safe diagnostic projection: never exposes IDs, account labels, credentials or raw errors. */
export function summarizeAccountAvailability(accounts: AccountAvailabilityInput[], now = Date.now()) {
  const states = accounts.map(account => accountAvailability(account, now))
  const deadlines = accounts.map(account => account.cooldownUntil).filter((until): until is number => Number.isSafeInteger(until) && until! > now)
  return { total: accounts.length, available: states.filter(state => state.available).length,
    disabled: accounts.filter(account => account.enabled === false).length,
    coolingDown: accounts.filter(account => account.cooldownReason === 'temporary_ban' && (account.cooldownUntil === undefined || account.cooldownUntil > now)).length,
    ...(deadlines.length ? { nextRecoveryAt: Math.min(...deadlines) } : {}) }
}
export function accountAvailability(account: AccountAvailabilityInput, now = Date.now()): {
  available: boolean; reason: AccountAvailabilityReason; availableAt?: number
} {
  if (account.enabled !== undefined && account.enabled !== true) return { available: false, reason: 'disabled' }
  if (account.status !== 'active') return { available: false, reason: account.status === 'expired' ? 'expired' : account.status === 'error' ? 'error' : 'inactive' }
  if (account.cooldownReason === 'temporary_ban' && account.cooldownUntil === undefined) return { available: false, reason: 'cooldown' }
  if (account.cooldownUntil !== undefined && (!Number.isSafeInteger(account.cooldownUntil) || account.cooldownUntil > now)) {
    return { available: false, reason: 'cooldown', ...(Number.isSafeInteger(account.cooldownUntil) ? { availableAt: account.cooldownUntil } : {}) }
  }
  if (account.dailyLimit && (account.todayUsed || 0) >= account.dailyLimit) return { available: false, reason: 'daily_limit' }
  return { available: true, reason: 'ready' }
}

export function validateAccountAvailabilityUpdate(updates: Partial<AccountAvailabilityInput>): void {
  if ('enabled' in updates && typeof updates.enabled !== 'boolean') throw new Error('Account enabled must be a boolean')
  if (updates.cooldownUntil !== undefined && (!Number.isSafeInteger(updates.cooldownUntil) || updates.cooldownUntil < 0 || updates.cooldownUntil > 8640000000000000)) throw new Error('Invalid account cooldown time')
  if (updates.cooldownReason !== undefined && updates.cooldownReason !== 'temporary_ban') throw new Error('Invalid account cooldown reason')
}
