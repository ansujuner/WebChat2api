/** Liveness reports are safe UI projections, never provider responses or credentials. */
export type AccountLivenessReason =
  | 'disabled' | 'provider_disabled' | 'cooldown' | 'daily_limit'
  | 'account_missing' | 'provider_missing' | 'no_text_model'
  | 'auth_required' | 'action_required' | 'rate_limited' | 'quota_unavailable'
  | 'browser_unavailable' | 'model_unavailable' | 'account_busy'
  | 'account_banned' | 'incomplete_response' | 'request_failed'
  | 'timeout' | 'cancelled' | 'account_changed' | 'internal_error'

export interface AccountLivenessInput {
  /** Omit both filters to check all stored accounts. Filters are mutually exclusive. */
  accountIds?: string[]
  providerId?: string
}

export interface AccountLivenessResult {
  accountId: string
  accountName: string
  providerId: string
  status: 'queued' | 'running' | 'passed' | 'failed' | 'skipped' | 'cancelled'
  model?: string
  reason?: AccountLivenessReason
  startedAt?: number
  finishedAt?: number
  latencyMs?: number
  httpStatus?: number
  retryAt?: number
}

export interface AccountLivenessJob {
  id: string
  mode: 'single' | 'batch'
  state: 'running' | 'cancelling' | 'completed' | 'cancelled'
  startedAt: number
  updatedAt: number
  finishedAt?: number
  results: AccountLivenessResult[]
}
