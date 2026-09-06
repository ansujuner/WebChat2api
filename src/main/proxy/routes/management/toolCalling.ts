import Router from '@koa/router'
import type { Context } from 'koa'
import { managementAuthMiddleware } from '../../middleware/managementAuth'
import { getToolCallingSmokeStatus, runToolCallingSmoke } from '../../../diagnostics/toolCallingSmoke'
import type { ManagementApiResponse } from '../../../../shared/types'

const router = new Router({ prefix: '/v0/management/tool-calling' })

router.use(managementAuthMiddleware)

router.get('/status', async (ctx: Context) => {
  ctx.body = {
    success: true,
    data: await getToolCallingSmokeStatus(),
  } as ManagementApiResponse
})

router.post('/smoke', async (ctx: Context) => {
  const result = await runToolCallingSmoke(ctx.request.body as Parameters<typeof runToolCallingSmoke>[0])

  ctx.body = {
    success: result.success,
    data: { result },
  } as ManagementApiResponse
})

export default router
