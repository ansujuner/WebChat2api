import Router from '@koa/router'
import type { Context } from 'koa'
import type { Readable } from 'node:stream'
import { handleChatCompletion } from './chat'
import { AnthropicProtocolError, convertAnthropicRequest, convertOpenAIResponse, estimateAnthropicInputTokens } from '../anthropic/messages'
import { AnthropicStream } from '../anthropic/stream'
import { anthropicErrorBody } from '../anthropic/errors'

const router = new Router({ prefix: '/v1' })

function checkVersion(ctx: Context): void {
  const version = ctx.get('anthropic-version')
  if (version && version !== '2023-06-01') throw new AnthropicProtocolError('Unsupported anthropic-version. Use 2023-06-01.')
  // This is a protocol translator, not a passthrough to Anthropic. Functional beta fields
  // are validated by the codec; foreign auth/version/beta headers never reach website APIs.
  ctx.set('X-Chat2API-Compatibility', 'anthropic-messages, client-tools, estimated-token-count')
}

function fail(ctx: Context, error: unknown): void {
  const known = error instanceof AnthropicProtocolError
  ctx.status = known ? error.status : 500
  ctx.body = anthropicErrorBody(ctx.status, known ? error.message : 'Messages conversion failed.',
    ctx.state.anthropicRequestId, known ? error.type : undefined)
}

router.post('/messages/count_tokens', async (ctx: Context) => {
  try {
    checkVersion(ctx)
    const inputTokens = estimateAnthropicInputTokens(ctx.request.body)
    ctx.set('X-Chat2API-Token-Count', 'estimated')
    ctx.body = { input_tokens: inputTokens }
  } catch (error) { fail(ctx, error) }
})

router.post('/messages', async (ctx: Context) => {
  try {
    checkVersion(ctx)
    const original = ctx.request.body
    const request = convertAnthropicRequest(original)
    // Reuse the same account routing, authentication context and native website conversation index.
    // Do not make a second HTTP request to localhost or allow the caller to supply upstream cursors.
    ctx.request.body = request
    await handleChatCompletion(ctx, { formatResponse: response => convertOpenAIResponse(response, request.model) })
    if (ctx.status >= 400) return
    if (request.stream && (ctx.body as any)?.pipe) {
      const source = ctx.body as Readable
      const output = new AnthropicStream({ model: request.model,
        inputTokens: estimateAnthropicInputTokens(original), requestId: ctx.state.anthropicRequestId })
      output.once('conversionError', error => { source.unpipe(output); source.destroy(); output.fail(error) })
      source.once('error', error => output.fail(error))
      source.once('close', () => {
        if (!source.readableEnded && !output.writableEnded) output.fail(new Error('Upstream stream closed before completion'))
      })
      output.once('close', () => { if (!output.readableEnded) source.destroy() })
      source.pipe(output)
      ctx.body = output
    }
  } catch (error) { fail(ctx, error) }
})

export default router
