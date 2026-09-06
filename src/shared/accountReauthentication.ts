/** Public account-bound login result. Never include credentials, cookies, or upstream response text. */
export const ACCOUNT_LOGIN_PROVIDERS = ['deepseek', 'glm', 'kimi', 'mimo', 'minimax', 'qwen', 'qwen-ai', 'zai', 'perplexity', 'arena'] as const
export function supportsAccountLogin(providerId: string): boolean {
  return (ACCOUNT_LOGIN_PROVIDERS as readonly string[]).includes(providerId)
}

export type AccountReauthenticationErrorCode =
  | 'invalid_account'
  | 'unsupported_provider'
  | 'busy'
  | 'cancelled'
  | 'timeout'
  | 'identity_mismatch'
  | 'identity_unverified'
  | 'login_required'
  | 'network_error'
  | 'route_changed'
  | 'browser_error'
  | 'profile_unavailable'
  | 'browser_not_found'
  | 'browser_start_failed'
  | 'browser_connection_failed'
  | 'page_not_ready'
  | 'account_changed'
  | 'save_failed'

export interface AccountReauthenticationResult {
  success: boolean
  accountId: string
  state: 'restored' | 'updated' | 'failed'
  errorCode?: AccountReauthenticationErrorCode
}
