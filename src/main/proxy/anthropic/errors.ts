import { randomUUID } from 'node:crypto'
import type { Context, Next } from 'koa'

export const isAnthropicPath = (path: string): boolean => path === '/v1/messages' || path.startsWith('/v1/messages/')

export function anthropicErrorBody(status: number, message: string, requestId?: string, type?: string): Record<string, unknown> {
  const errorType = type ?? (status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' :
    status === 404 ? 'not_found_error' : status === 413 ? 'request_too_large' : status === 429 ? 'rate_limit_error' :
    status === 503 || status === 529 ? 'overloaded_error' : status >= 500 ? 'api_error' : 'invalid_request_error')
  return { type: 'error', error: { type: errorType, message }, ...(requestId ? { request_id: requestId } : {}) }
}

/** Wrap parser/auth/router failures as well as inference failures in the Messages API envelope. */
export async function anthropicErrorMiddleware(ctx: Context, next: Next): Promise<void> {
  if (!isAnthropicPath(ctx.path)) { await next(); return }
  const requestId = `req_${randomUUID().replace(/-/g, '')}`
  ctx.state.anthropicRequestId = requestId
  ctx.set('request-id', requestId)
  try {
    await next()
    if (ctx.status >= 400 && !(ctx.body as any)?.pipe) {
      const body = ctx.body as any
      ctx.body = anthropicErrorBody(ctx.status, body?.error?.message ?? body?.message ?? `HTTP ${ctx.status}`,
        requestId, body?.type === 'error' ? body.error?.type : undefined)
      ctx.type = 'application/json'
    }
  } catch (error) {
    const candidate = error as { status?: number; type?: string; message?: string }
    const status = typeof candidate.status === 'number' && candidate.status >= 400 && candidate.status <= 599 ? candidate.status : 500
    ctx.status = status
    ctx.type = 'application/json'
    ctx.body = anthropicErrorBody(status, status >= 500 ? 'The gateway could not process this request.' : candidate.message ?? 'Invalid request', requestId)
  }
}
