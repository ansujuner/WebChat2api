/** Public account-bound login result. Never include credentials, cookies, or upstream response text. */
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
  | 'browser_error'
  | 'account_changed'
  | 'save_failed'

export interface AccountReauthenticationResult {
  success: boolean
  accountId: string
  state: 'restored' | 'updated' | 'failed'
  errorCode?: AccountReauthenticationErrorCode
}
