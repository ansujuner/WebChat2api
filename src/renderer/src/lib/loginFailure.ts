/** UI-visible failures are fixed translation keys, never upstream prose. */
const loginCodes = new Set(['busy', 'cancelled', 'timeout', 'identity_unverified', 'login_required',
  'network_error', 'route_changed', 'browser_error', 'profile_unavailable', 'browser_not_found',
  'browser_start_failed', 'browser_connection_failed', 'page_not_ready'])

const legacyFailures: Record<string, string> = {
  'Login window was closed': 'providers.loginWindowClosed',
  'Login window was closed.': 'providers.loginWindowClosed',
  'Arena login browser was closed.': 'providers.loginWindowClosed',
  'A login window is already open': 'providers.loginWindowAlreadyOpen',
  'A login window is already open.': 'providers.loginWindowAlreadyOpen',
  'A login process is already in progress': 'providers.loginWindowAlreadyOpen',
  'Guest account not allowed, please login with a real account': 'providers.guestAccountNotAllowed',
  'Login timeout': 'providers.loginErrors.timeout',
  'Login timeout. Please retry when ready to sign in.': 'providers.loginErrors.timeout',
  'Arena login was cancelled.': 'providers.loginErrors.cancelled',
  'Arena login cancelled.': 'providers.loginErrors.cancelled',
}

export function newLoginFailureKey(result?: { errorCode?: unknown; error?: unknown } | null): string {
  if (typeof result?.errorCode === 'string' && loginCodes.has(result.errorCode)) return `providers.loginErrors.${result.errorCode}`
  // Compatibility for old internal adapters that have not adopted errorCode.
  // Exact constants only: do not guess categories from arbitrary remote text.
  if (typeof result?.error === 'string' && Object.prototype.hasOwnProperty.call(legacyFailures, result.error)) return legacyFailures[result.error]
  return 'providers.loginFailed'
}
