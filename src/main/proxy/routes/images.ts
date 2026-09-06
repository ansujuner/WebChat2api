import Router from '@koa/router'
import { randomUUID } from 'node:crypto'
import { loadBalancer } from '../loadbalancer'
import { modelMapper } from '../modelMapper'
import { proxyStatusManager } from '../status'
import { storeManager } from '../../store/store'
import { arenaBrowserManager } from '../../arena/browserManager'
import { ArenaError } from '../../arena/protocol'
import { recordAccountSuccess } from '../requestAccounting'

const router = new Router({ prefix: '/v1/images' })

/** Text-to-image only. Unsupported options fail before any provider submission. */
router.post('/generations', async ctx => {
  const body = ctx.request.body as any
  const invalid = (message: string): void => { ctx.status = 400; ctx.body = { error: { type: 'invalid_request_error', message } } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { invalid('A JSON image request is required'); return }
  if (Object.keys(body).some(key => !['model','prompt','n','response_format','user','size'].includes(key))) { invalid('This image endpoint supports model, prompt, n=1, response_format=url and size=auto only'); return }
  if (typeof body.model !== 'string' || !body.model.startsWith('arena/image/') || body.model.length > 256) { invalid('Select an advertised arena/image/ model'); return }
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 16000) { invalid('prompt must contain 1 to 16000 characters'); return }
  if (body.n !== undefined && body.n !== 1) { invalid('Arena image generation currently supports n=1'); return }
  if (body.response_format !== undefined && body.response_format !== 'url') { invalid('Arena image generation currently supports response_format=url'); return }
  if (body.size !== undefined && body.size !== 'auto') { invalid('Arena chooses image dimensions; use size=auto'); return }
  if (body.user !== undefined && (typeof body.user !== 'string' || body.user.length > 256)) { invalid('user must be a string up to 256 characters'); return }
  const config = storeManager.getConfig()
  const selection = loadBalancer.selectAccount(body.model, config.loadBalanceStrategy, modelMapper.getPreferredProvider(body.model), modelMapper.getPreferredAccount(body.model))
  if (!selection || selection.provider.id !== 'arena') {
    const limit = loadBalancer.getModelRateLimit(body.model, modelMapper.getPreferredProvider(body.model), modelMapper.getPreferredAccount(body.model))
    if (limit) {
      ctx.set('Retry-After', String(Math.max(1, Math.ceil((limit.availableAt - Date.now()) / 1000))))
      ctx.status = 429; ctx.body = { error: { type: 'api_error', code: 'model_rate_limited', message: 'This image model is cooling down. Wait for Retry-After; no generation was submitted.' } }; return
    }
    ctx.status = 503; ctx.body = { error: { type: 'api_error', code: 'no_available_account', message: 'No active Arena account supports this image model. Log in and refresh its models.' } }; return
  }
  const started = Date.now(), requestId = `img-${randomUUID()}`
  const controller = new AbortController()
  let settled = false
  const settle = (success: boolean) => {
    if (settled) return
    settled = true
    const latency = Date.now() - started
    if (success) {
      proxyStatusManager.recordRequestSuccess(latency)
      recordAccountSuccess(storeManager, selection.account.id)
      loadBalancer.clearAccountFailure(selection.account.id)
    } else proxyStatusManager.recordRequestFailure(latency)
    storeManager.recordRequestInStats(success, latency, body.model, selection.provider.id, selection.account.id)
  }
  proxyStatusManager.recordRequestStart(body.model,selection.provider.id,selection.account.id)
  ctx.res.once('close', () => { if (!ctx.res.writableFinished) { controller.abort(); settle(false) } })
  try {
    const generated = await arenaBrowserManager.generateImage({ accountId: selection.account.id, profileId: selection.account.credentials.browserProfileId, model: selection.actualModel, prompt: body.prompt, signal: controller.signal })
    if (controller.signal.aborted) return
    ctx.set('X-Request-ID',requestId)
    ctx.body = { created: Math.floor(Date.now()/1000), data: [{ url: generated.url }] }
    ctx.res.once('finish', () => settle(true))
  } catch (error) {
    settle(false)
    if (controller.signal.aborted) return
    const known = error instanceof ArenaError
    ctx.status = known ? error.status : 502
    if (known && error.retryAt) ctx.set('Retry-After', String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))))
    ctx.body = { error: { type: 'api_error', code: known ? error.code : 'upstream_error', message: known ? error.message : 'Arena image generation failed. It was not retried.' } }
  }
})

export default router
