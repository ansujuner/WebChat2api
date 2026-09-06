/**
 * Proxy Service Module - Chat Completions Route
 * Implements /v1/chat/completions route
 */

import Router from '@koa/router'
import type { Context } from 'koa'
import { Transform } from 'stream'
import { ChatCompletionRequest, ChatCompletionResponse, ProxyContext } from '../types'
import { loadBalancer } from '../loadbalancer'
import { requestForwarder } from '../forwarder'
import { streamHandler } from '../stream'
import { proxyStatusManager } from '../status'
import { modelMapper } from '../modelMapper'
import { storeManager } from '../../store/store'
import { accountAvailability } from '../../../shared/accountAvailability'
import { conversationContinuity, conversationScope, setConversationAbortSignal, ConversationError, type ConversationTurn } from '../conversationContinuity'
import { ConversationStream } from '../conversationStream'
import { normalizeClientIdentity } from '../clientIdentity'
import { validateChatRequestOptions } from '../requestValidation'
import { recordAccountSuccess } from '../requestAccounting'
import { 
  isAnthropicToolFormat,
  transformResponseToAnthropic,
  transformChunkToAnthropic
} from '../utils/toolFormatConverter'

const router = new Router({ prefix: '/v1/chat' })

/**
 * Generate Request ID
 */
function generateRequestId(): string {
  return `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Get Client IP
 */
function getClientIP(ctx: Context): string {
  return ctx.headers['x-real-ip'] as string ||
    ctx.headers['x-forwarded-for'] as string ||
    ctx.ip ||
    'unknown'
}

/**
 * Extract user input from messages (last user message, full content)
 */
function extractUserInput(messages: Array<{ role: string; content?: string | any[] | null }>): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && msg.content) {
      let content = ''
      if (typeof msg.content === 'string') {
        content = msg.content
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((p: any) => p.type === 'text')
        if (textParts.length > 0) {
          content = textParts.map((p: any) => p.text || '').join(' ')
        }
      }
      if (content) {
        return content
      }
    }
  }
  return undefined
}

/**
 * Handle Chat Completions Request
 */
export async function handleChatCompletion(ctx: Context, responseAdapter?: { formatResponse: (body: any) => unknown }): Promise<void> {
  const startTime = Date.now()
  const requestId = generateRequestId()
  const clientIP = getClientIP(ctx)

  const body = ctx.request.body as any
  const invalid = (message: string, param: string | null = null): void => {
    ctx.status = 400
    ctx.body = { error: { message, type: 'invalid_request_error', param, code: null } }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    invalid('Invalid request body'); return
  }
  if (typeof body.model !== 'string' || !body.model.trim()) {
    invalid('Missing required field: model', 'model'); return
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.some((m: any) =>
    !m || !['system', 'user', 'assistant', 'tool'].includes(m.role) ||
    !(typeof m.content === 'string' || m.content === null || (m.content === undefined && m.role === 'assistant' && Array.isArray(m.tool_calls)) ||
      (Array.isArray(m.content) && m.content.every((part: any) => part &&
        ((part.type === 'text' && typeof part.text === 'string') ||
         (part.type === 'image_url' && typeof part.image_url?.url === 'string'))))))) {
    invalid('messages must be a non-empty array of valid chat messages', 'messages'); return
  }
  const optionError = validateChatRequestOptions(body)
  if (optionError) { invalid(optionError.message, optionError.param); return }
  if (body.stream === true && typeof body.n === 'number' && body.n > 1) {
    invalid('Streaming responses support n=1 only.', 'n'); return
  }
  const headerId = ctx.get('X-Chat2API-Session-ID') || undefined
  const ids = [body.session_id, body.sessionId, headerId].filter(v => v !== undefined)
  if (ids.some(id => typeof id !== 'string' || !/^c2a-[a-f0-9-]{36}$/.test(id)) || new Set(ids).size > 1) {
    invalid('Use the same opaque Chat2API session ID in the body/header, not a website conversation ID.', 'session_id'); return
  }
  if (body.new_conversation !== undefined && typeof body.new_conversation !== 'boolean') {
    invalid('new_conversation must be a boolean', 'new_conversation'); return
  }
  let request: ChatCompletionRequest = {
    ...body,
    session_id: ids[0],
    new_conversation: body.new_conversation ?? (ctx.get('X-Chat2API-New-Conversation') === 'true'),
    reasoning_effort: body.reasoning_effort ?? body.reasoningEffort ?? (ctx.get('X-Reasoning-Effort') || undefined),
    web_search: body.web_search ?? (ctx.get('X-Web-Search') === 'true' ? true : undefined),
    deep_research: body.deep_research ?? (ctx.get('X-Deep-Research') === 'true' ? true : undefined),
  }
  const config = storeManager.getConfig()
  let turn: ConversationTurn | undefined
  let selection: ReturnType<typeof loadBalancer.selectAccount>
  try {
    // Never use forwarded IP headers or an account's most recent conversation to identify a client.
    const scope = conversationScope(ctx.state.apiKeyId ?? ctx.get('Authorization'),
      ctx.req.socket.remoteAddress, normalizeClientIdentity(request.user, {
        session: ctx.get('x-claude-code-session-id'), agent: ctx.get('x-claude-code-agent-id'), parent: ctx.get('x-claude-code-parent-agent-id'),
      }), ctx.get('X-Chat2API-Client-ID'))
    turn = conversationContinuity.begin(request, scope, (config.sessionConfig?.sessionTimeout ?? 30) * 60 * 1000)
    if (turn.binding) {
      const bound = storeManager.getAccountById(turn.binding.accountId)
      const state = bound ? accountAvailability(bound) : { available: false, reason: 'missing', availableAt: undefined }
      if (!state.available) {
        if (state.availableAt) ctx.set('Retry-After', String(Math.max(1, Math.ceil((state.availableAt - Date.now()) / 1000))))
        throw new ConversationError('The account for this conversation is disabled, cooling down or unavailable. It will not be moved to another account.',
          state.reason === 'cooldown' ? 'account_cooling_down' : 'account_unavailable', 409)
      }
    }
    selection = loadBalancer.selectAccount(request.model, config.loadBalanceStrategy,
      turn.binding?.providerId ?? modelMapper.getPreferredProvider(request.model),
      turn.binding?.accountId ?? modelMapper.getPreferredAccount(request.model))
    if (!selection || (turn.binding && selection.account.id !== turn.binding.accountId)) {
      const limit = loadBalancer.getModelRateLimit(request.model, turn.binding?.providerId ?? modelMapper.getPreferredProvider(request.model),
        turn.binding?.accountId ?? modelMapper.getPreferredAccount(request.model))
      if (limit) {
        ctx.set('Retry-After', String(Math.max(1, Math.ceil((limit.availableAt - Date.now()) / 1000))))
        throw new ConversationError('This model is cooling down for the matching account. Wait for Retry-After; no generation was submitted.', 'model_rate_limited', 429)
      }
      if (turn.binding) throw new ConversationError('The original conversation account is unavailable. It will not be moved to another account.', 'account_unavailable', 409)
      throw new ConversationError(`No available account for model: ${request.model}`, 'no_available_account', 503)
    }
    if (requestForwarder.supportsConversation(selection.provider)) {
      if (request.n !== undefined && request.n !== 1) throw new ConversationError('Website conversations support n=1 only.', 'invalid_n', 400)
      turn.bind({ providerId: selection.provider.id, accountId: selection.account.id, actualModel: selection.actualModel,
        kind: requestForwarder.conversationKind?.(selection.provider) ?? selection.provider.id })
      request = turn.request
      ctx.set('X-Chat2API-Session-ID', turn.id)
      ctx.set('X-Chat2API-Conversation', turn.isContinuation ? 'continued' : 'new')
    } else {
      if (request.session_id) throw new ConversationError('This provider uses a stateless API, not website conversations.', 'unsupported_conversation', 400)
      turn.cancel()
      turn = undefined
    }
  } catch (error) {
    turn?.cancel()
    ctx.status = error instanceof ConversationError ? error.status : 500
    ctx.body = { error: { message: error instanceof Error ? error.message : 'Conversation setup failed',
      type: 'invalid_request_error', code: error instanceof ConversationError ? error.code : 'conversation_error' } }
    return
  }
  const { account, provider, actualModel } = selection
  const abortController = new AbortController()
  setConversationAbortSignal(request, abortController.signal)
  let disconnected = false
  let requestSettled = false
  let logEntryId: string | undefined
  const settleRequest = (success: boolean, errorMessage?: string): void => {
    if (requestSettled) return
    requestSettled = true
    const latency = Date.now() - startTime
    if (success) {
      proxyStatusManager.recordRequestSuccess(latency)
      loadBalancer.clearAccountFailure(account.id)
      recordAccountSuccess(storeManager, account.id)
    } else proxyStatusManager.recordRequestFailure(latency)
    storeManager.recordRequestInStats(success, latency, request.model, provider.id, account.id)
    if (logEntryId) storeManager.updateRequestLog(logEntryId, {
      status: success ? 'success' : 'error', latency, ...(errorMessage ? { errorMessage } : {}),
    })
  }
  ctx.res.once('close', () => {
    if (!ctx.res.writableFinished) {
      disconnected = true
      abortController.abort()
      turn?.fail()
      settleRequest(false, 'Client disconnected before completion')
    }
  })

  const context: ProxyContext = {
    requestId,
    providerId: provider.id,
    accountId: account.id,
    model: request.model,
    actualModel,
    startTime,
    isStream: request.stream || false,
    clientIP,
  }

  proxyStatusManager.recordRequestStart(request.model, provider.id, account.id)

  try {
    const result = await requestForwarder.forwardChatCompletion(
      request,
      account,
      provider,
      actualModel,
      context
    )

    const latency = Date.now() - startTime

    if (disconnected) {
      (result.stream as any)?.destroy?.()
      turn?.fail()
      return
    }

    if (!result.success) {
      turn?.fail()
      settleRequest(false, result.error || 'Request failed')

      if (result.status && (result.status === 401 || result.status === 403 || result.status >= 500)) {
        loadBalancer.markAccountFailed(account.id)
      }

      ctx.status = result.status || 500
      const retryAfter = result.headers?.['retry-after']
      if (typeof retryAfter === 'string' && /^\d{1,10}$/.test(retryAfter)) ctx.set('Retry-After', retryAfter)
      ctx.body = {
        error: {
          message: result.error || 'Request failed',
          type: 'api_error',
          param: null,
          code: result.errorCode ?? null,
        },
      }

      storeManager.addLog('error', `Request failed: ${result.error}`, {
        requestId,
        providerId: provider.id,
        accountId: account.id,
        model: request.model,
        latency,
      })

      const userInput = extractUserInput(request.messages)
      const errorResponseBody = JSON.stringify({
        error: {
          message: result.error || 'Request failed',
          type: 'api_error',
          param: null,
          code: null,
        },
      })
      storeManager.addRequestLog({
        timestamp: startTime,
        status: 'error',
        statusCode: result.status || 500,
        method: 'POST',
        url: ctx.path,
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: result.status || 500,
        responseBody: errorResponseBody,
        latency,
        isStream: request.stream || false,
        errorMessage: result.error,
      })

      return
    }
    if (request.stream === true && !result.stream) throw new ConversationError('Upstream did not return the requested stream.', 'incomplete_response', 502)

    const userInput = extractUserInput(request.messages)
    // Prepare response body for logging (only for non-stream requests)
    const responseBodyForLog = !request.stream && result.body
      ? JSON.stringify(result.body)
      : undefined

    // For streaming requests, we'll collect content and update the log later
    if (!request.stream) {
      // Non-streaming: record log with response body now
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: ctx.path,
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 200,
        responseBody: responseBodyForLog,
        latency,
        isStream: false,
      })
      logEntryId = logEntry.id
    } else {
      // Streaming: record log now, will update response body later
      const logEntry = storeManager.addRequestLog({
        timestamp: startTime,
        status: 'success',
        statusCode: 200,
        method: 'POST',
        url: ctx.path,
        model: request.model,
        actualModel,
        providerId: provider.id,
        providerName: provider.name,
        accountId: account.id,
        accountName: account.name,
        requestBody: JSON.stringify(request),
        userInput,
        webSearch: request.web_search,
        reasoningEffort: request.reasoning_effort,
        responseStatus: 200,
        latency,
        isStream: true,
      })
      logEntryId = logEntry.id
    }

    if (request.stream === true && result.stream) {
      ctx.set('Content-Type', 'text/event-stream')
      ctx.set('Cache-Control', 'no-cache')
      ctx.set('Connection', 'keep-alive')
      ctx.set('X-Accel-Buffering', 'no')

      let collectedContent = ''
      const wrapperStream = new Transform({
        transform(chunk, _encoding, callback) {
          collectedContent += chunk.toString()
          callback(null, chunk)
        },
      })
      const source = result.skipTransform ? result.stream : result.stream.pipe(
        streamHandler.createTransformStream(actualModel, requestId))
      const observer = turn ? new ConversationStream(turn, responseAdapter ? (message, finish_reason) => {
        responseAdapter.formatResponse({ id: requestId, model: request.model, choices: [{ index: 0, message, finish_reason }] })
      } : undefined) : undefined
      let errored = false
      const onError = (err: Error): void => {
        if (errored) return
        errored = true
        turn?.fail()
        settleRequest(false, err.message)
        if (observer) { source.unpipe(observer); observer.unpipe(wrapperStream) }
        else source.unpipe(wrapperStream)
        ;(result.stream as any)?.destroy?.()
        ;(source as any)?.destroy?.()
        observer?.destroy()
        // Error is not a successful assistant answer and must not be committed as history.
        if (!wrapperStream.destroyed) {
          wrapperStream.end(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_stream_error' } })}\n\n`)
        }
        storeManager.addLog('error', `Stream error: ${err.message}`, { requestId, providerId: provider.id, accountId: account.id, model: request.model })
        if (logEntryId) storeManager.updateRequestLog(logEntryId, { status: 'error', errorMessage: err.message })
      }
      result.stream.once('error', onError)
      result.stream.once('close', () => {
        if (!(result.stream as any).readableEnded && !errored && !disconnected) onError(new Error('Upstream stream closed before completion'))
      })
      if (source !== result.stream) source.once('error', onError)
      observer?.once('error', onError)
      wrapperStream.once('error', onError)
      wrapperStream.once('finish', () => {
        if (logEntryId) storeManager.updateRequestLog(logEntryId, { responseBody: collectedContent || undefined })
      })
      // Success belongs to a completed response, not to receipt of upstream headers.
      ctx.res.once('finish', () => { if (!errored && !disconnected) settleRequest(true) })
      ctx.res.once('close', () => {
        if (!ctx.res.writableFinished) {
          turn?.fail()
          ;(result.stream as any)?.destroy?.()
          ;(source as any)?.destroy?.()
          observer?.destroy()
          wrapperStream.destroy()
        }
      })
      if (observer) source.pipe(observer).pipe(wrapperStream)
      else source.pipe(wrapperStream)

      ctx.body = wrapperStream
    } else {
      ctx.set('Content-Type', 'application/json')
      // Stateless/custom APIs must also return a completed assistant answer, not a
      // successful HTTP status containing an error, missing body or partial answer.
      if (result.body?.error || !Array.isArray(result.body?.choices) || !result.body.choices.length ||
        result.body.choices.some((choice: any) => choice?.message?.role !== 'assistant' ||
          !['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(choice.finish_reason))) {
        throw new ConversationError('Upstream returned an incomplete response.', 'incomplete_response', 502)
      }
      // Validate/convert the client representation before committing a resumable turn.
      const adaptedBody = responseAdapter?.formatResponse(result.body)
      if (turn) {
        const choice = result.body?.choices?.[0]
        if (choice?.message?.role !== 'assistant' || !['stop', 'length', 'tool_calls', 'content_filter'].includes(choice.finish_reason) || result.body?.error) {
          throw new ConversationError('Upstream returned an incomplete response.', 'incomplete_response', 502)
        }
        turn.commit(choice.message)
      }

      if (result.body) {
        // Check if we need to transform to Anthropic format
        if (responseAdapter) {
          ctx.body = adaptedBody
        } else if (isAnthropicToolFormat(request.tool_format)) {
          ctx.body = { ...transformResponseToAnthropic(result.body), ...(turn ? { session_id: turn.id } : {}) }
          console.log('[Chat] Transformed response to Anthropic tool format')
        } else {
          ctx.body = { ...result.body, ...(turn ? { session_id: turn.id } : {}) }
        }
      } else {
        ctx.body = {
          id: requestId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: actualModel,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: '',
            },
            finish_reason: 'stop',
          }],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        }
      }
      settleRequest(true)
    }
  } catch (error) {
    turn?.fail()
    const latency = Date.now() - startTime

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const errorStack = error instanceof Error ? error.stack : undefined
    const publicErrorCode = error instanceof ConversationError ? error.code : null
    settleRequest(false, errorMessage)

    ctx.status = error instanceof ConversationError ? error.status : 500
    ctx.body = {
      error: {
        message: errorMessage,
        type: 'internal_error',
        param: null,
        code: publicErrorCode,
      },
    }

    storeManager.addLog('error', `Request exception: ${errorMessage}`, {
      requestId,
      providerId: provider.id,
      accountId: account.id,
      model: request.model,
      latency,
      error: errorMessage,
    })

    const userInput = extractUserInput(request.messages)
    const exceptionResponseBody = JSON.stringify({
      error: {
        message: errorMessage,
        type: 'internal_error',
        param: null,
        code: publicErrorCode,
      },
    })
    if (logEntryId) storeManager.updateRequestLog(logEntryId, {
      statusCode: ctx.status,
      responseStatus: ctx.status,
      responseBody: exceptionResponseBody,
    })
    else storeManager.addRequestLog({
      timestamp: startTime,
      status: 'error',
      statusCode: ctx.status,
      method: 'POST',
      url: ctx.path,
      model: request.model,
      actualModel,
      providerId: provider.id,
      providerName: provider.name,
      accountId: account.id,
      accountName: account.name,
      requestBody: JSON.stringify(request),
      userInput,
      webSearch: request.web_search,
      reasoningEffort: request.reasoning_effort,
      responseStatus: ctx.status,
      responseBody: exceptionResponseBody,
      latency,
      isStream: request.stream || false,
      errorMessage,
      errorStack,
    })

  }
}

router.post('/completions', (ctx: Context) => handleChatCompletion(ctx))

export default router
