/** Client session headers scope conversations; they never identify an upstream account. */
export function normalizeClientIdentity(user: unknown, headers: { session?: string; agent?: string; parent?: string }): unknown {
  const bounded = (value?: string) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value) ? value : undefined
  const session = bounded(headers.session)
  if (session) return { kind: 'claude-code', session, agent: bounded(headers.agent) ?? 'main', parent: bounded(headers.parent) ?? '' }
  if (typeof user !== 'string') return ''
  // Claude Code metadata.user_id can be a JSON string. Key ordering is not a
  // new session; retain all fields rather than guessing which ones are volatile.
  if (user.length <= 8192 && user.startsWith('{')) {
    try { const parsed = JSON.parse(user); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed } catch { /* Opaque user IDs remain opaque. */ }
  }
  return user
}
