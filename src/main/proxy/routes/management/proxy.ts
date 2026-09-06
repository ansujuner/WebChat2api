/** Management control runs on the listener being controlled: acknowledge before closing it. */
import Router from '@koa/router'
import type { Context } from 'koa'
import { isIP } from 'node:net'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { proxyServer } from '../../server'
import { proxyStatusManager } from '../../status'
import { storeManager } from '../../../store/store'
import type { ManagementApiResponse, ProxyStatusResponse } from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management/proxy' })
router.use(managementAuthMiddleware)

type Operation = 'stop' | 'restart'
let pendingOperation: Operation | null = null
let lastOperation: { operation: Operation; success: boolean; completedAt: number } | null = null
const error = (ctx: Context, status: number, code: string, message: string): void => {
  ctx.status = status
  ctx.body = { success: false, error: { code, message } } satisfies ManagementApiResponse
}
const success = <T>(data: T): ManagementApiResponse<T> => ({ success: true, data })
const busy = (ctx: Context): boolean => {
  if (!pendingOperation) return false
  error(ctx, 409, 'operation_in_progress', 'A proxy stop or restart is already in progress')
  return true
}

function address(ctx: Context): { port: number; host: string } | null {
  const request = ctx.request.body === undefined ? {} : ctx.request.body
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => !['port', 'host'].includes(key))) {
    error(ctx, 400, 'invalid_request', 'Expected a JSON object with optional port and host'); return null
  }
  const config = storeManager.getConfig()
  const { port = config.proxyPort, host = config.proxyHost ?? '127.0.0.1' } = request as { port?: number; host?: string }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof host !== 'string' ||
    !(isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) {
    error(ctx, 400, 'invalid_address', 'Choose a valid host and an integer port between 1 and 65535'); return null
  }
  return { port, host }
}
function statusData(): ProxyStatusResponse {
  const status = proxyStatusManager.getRunningStatus()
  return { isRunning: status.isRunning, port: proxyStatusManager.getPort(), host: proxyStatusManager.getHost(),
    uptime: status.uptime, connections: proxyStatusManager.getStatistics().activeConnections }
}

function schedule(ctx: Context, operation: Operation, run: () => Promise<boolean>): void {
  pendingOperation = operation
  let acknowledged = false
  let cancelled = false
  ctx.res.once('finish', () => {
    if (cancelled) return
    acknowledged = true
    void (async () => {
      let completed = false
      try { completed = await run() } catch { /* Persist a safe operational error below. */ }
      finally {
        lastOperation = { operation, success: completed, completedAt: Date.now() }
        pendingOperation = null
        if (!completed) {
          try { storeManager.addLog('error', `Scheduled proxy ${operation} failed; check the current listener and configured address.`) }
          catch { console.error('Scheduled proxy operation failed and its diagnostic could not be saved.') }
        }
      }
    })()
  })
  ctx.res.once('close', () => { if (!acknowledged) { cancelled = true; pendingOperation = null } })
  ctx.status = 202
  ctx.set('Content-Type', 'application/json')
  ctx.set('Connection', 'close')
  ctx.body = success({ operation, status: 'scheduled' })
}

router.post('/start', async ctx => {
  if (busy(ctx)) return
  const target = address(ctx)
  if (!target) return
  if (proxyServer.isRunning()) { error(ctx, 400, 'already_running', 'Proxy service is already running'); return }
  try {
    if (!await proxyServer.start(target.port, target.host)) { error(ctx, 500, 'start_failed', 'Failed to start proxy service'); return }
    ctx.body = success(statusData())
  } catch { error(ctx, 500, 'start_failed', 'Failed to start proxy service') }
})
router.post('/stop', ctx => {
  if (busy(ctx)) return
  if (!proxyServer.isRunning()) { error(ctx, 400, 'not_running', 'Proxy service is not running'); return }
  schedule(ctx, 'stop', () => proxyServer.stop())
})
router.post('/restart', ctx => {
  if (busy(ctx)) return
  const target = address(ctx)
  if (!target) return
  schedule(ctx, 'restart', () => proxyServer.restart(target.port, target.host))
})
router.get('/status', ctx => { ctx.body = success({ ...statusData(), pendingOperation, lastOperation }) })
export default router
