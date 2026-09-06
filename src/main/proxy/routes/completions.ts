/** Legacy text completions translate through the same authenticated chat lifecycle. */
import Router from '@koa/router'
import type { Context } from 'koa'
import type { Readable } from 'node:stream'
import { handleChatCompletion } from './chat'
import { convertChatToCompletion, LegacyCompletionStream } from '../legacyCompletions'

const router = new Router({ prefix: '/v1' })

router.post('/completions', async (ctx: Context) => {
  const body = ctx.request.body as any
  const invalid = (message: string, param: string | null = null): void => {
    ctx.status = 400
    ctx.body = { error: { message, type: 'invalid_request_error', param, code: null } }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { invalid('Invalid request body'); return }
  if (typeof body.prompt !== 'string') {
    invalid('prompt must be one string. Batch prompt arrays and token-ID prompts are not supported; send a separate request for each prompt.', 'prompt'); return
  }
  if (body.echo !== undefined && typeof body.echo !== 'boolean') { invalid('echo must be a boolean', 'echo'); return }
  for (const key of ['suffix', 'logprobs', 'tools', 'tool_choice']) {
    if (body[key] !== undefined && body[key] !== null) { invalid(`${key} is not supported by this text-completion compatibility route.`, key); return }
  }
  if (body.best_of !== undefined && body.best_of !== 1) { invalid('Only best_of=1 is supported.', 'best_of'); return }
  const { prompt, echo, suffix, logprobs, best_of, tools, tool_choice, ...rest } = body
  const options = { model: body.model, prompt, echo: echo === true }
  ctx.request.body = { ...rest, messages: [{ role: 'user', content: prompt }] }
  await handleChatCompletion(ctx, { formatResponse: response => convertChatToCompletion(response, options) })
  if (ctx.status >= 400) return
  if (rest.stream === true && (ctx.body as any)?.pipe) {
    const source = ctx.body as Readable
    const output = new LegacyCompletionStream(options)
    output.once('conversionError', error => { source.unpipe(output); source.destroy(error); output.fail(error) })
    source.once('error', error => output.fail(error))
    source.once('close', () => {
      if (!source.readableEnded && !output.writableEnded) output.fail(new Error('Upstream completion stream closed before completion.'))
    })
    output.once('close', () => { if (!output.readableEnded) source.destroy() })
    source.pipe(output)
    ctx.body = output
  }
})

export default router
