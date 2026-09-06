const upstreamCategories = new Set(['captcha_required', 'verification_required', 'authentication_required', 'action_required', 'access_denied', 'account_cooling_down', 'account_unavailable', 'account_busy', 'route_changed', 'conversation_cursor_missing', 'rate_limited', 'quota_exceeded', 'account_banned', 'model_unavailable', 'browser_unavailable', 'upstream_error', 'incomplete_response', 'transport_error'])
const failureCodes = new Set(['tool_calling_disabled', 'unsaved_client_adapter', 'settings_changed', 'already_running', 'proxy_not_running', 'no_gateway_key', 'non_loopback_bind', 'health_failed', 'catalogue_failed', 'model_not_advertised', 'connection_failed_not_retried'])
const toolFailures = new Set(['model_did_not_call_tool', 'parser_failed', 'invalid_tool_name', 'client_did_not_return_tool_result'])

/** Render only known diagnostic codes, never raw provider responses or exception prose. */
export function toolSmokePresentation(input: unknown): {
  status: 'pass' | 'failed' | 'blocked'
  messageKey: string
  retryAt?: number
  checks: Array<{ stage: 'tool_call' | 'tool_result'; success: boolean }>
} {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const category = typeof value.category === 'string' ? value.category : ''
  const status = value.success === true && category === 'pass' ? 'pass' : toolFailures.has(category) ? 'failed' : 'blocked'
  const code = typeof value.failureCode === 'string' && failureCodes.has(value.failureCode) ? value.failureCode
    : typeof value.upstreamCategory === 'string' && upstreamCategories.has(value.upstreamCategory) ? value.upstreamCategory
    : status === 'pass' ? 'passed' : toolFailures.has(category) ? category : 'unavailable'
  const checks = Array.isArray(value.checks) ? value.checks.filter((item): item is { stage: 'tool_call' | 'tool_result'; success: boolean } =>
    !!item && typeof item === 'object' && ['tool_call', 'tool_result'].includes(item.stage) && typeof item.success === 'boolean'
  ).slice(0, 2).map(item => ({ stage: item.stage, success: item.success })) : []
  return { status, messageKey: `toolCalling.smoke.reasons.${code}`, checks,
    ...(typeof value.retryAt === 'number' && Number.isSafeInteger(value.retryAt) && value.retryAt > 0 && value.retryAt <= 8640000000000000 ? { retryAt: value.retryAt } : {}) }
}
