/**
 * Proxy Service Module - Request Forwarder
 * Forwards requests to corresponding API based on provider configuration
 */

import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios'
import { PassThrough, Readable } from 'stream'
import { Account, Provider } from '../store/types'
import { ForwardResult, ChatCompletionRequest, ProxyContext, type ChatMessage as ContextChatMessage } from './types'
import { proxyStatusManager } from './status'
import { storeManager } from '../store/store'
import { AccountManager } from '../store/accounts'
import { accountAvailability } from '../../shared/accountAvailability'
import { DeepSeekAccountRestrictionError, type DeepSeekRestriction } from './adapters/deepseek-restrictions'
import { DeepSeekAdapter } from './adapters/deepseek'
import { DeepSeekStreamHandler } from './adapters/deepseek-stream'
import { GLMAdapter, GLMStreamHandler } from './adapters/glm'
import { KimiAdapter, KimiStreamHandler } from './adapters/kimi'
import { MimoAdapter, MimoStreamHandler } from './adapters/mimo'
import { QwenAdapter, QwenStreamHandler } from './adapters/qwen'
import { QwenAiAdapter, QwenAiStreamHandler } from './adapters/qwen-ai'
import { ZaiAdapter, ZaiStreamHandler, ZaiUpstreamError } from './adapters/zai'
import { MiniMaxAdapter, MiniMaxStreamHandler } from './adapters/minimax'
import { PerplexityAdapter } from './adapters/perplexity'
import { PerplexityStreamHandler } from './adapters/perplexity-stream'
import { ArenaAdapter } from './adapters/arena'
import { ArenaStreamHandler } from './adapters/arena-stream'
import { ArenaError } from '../arena/protocol'
import { ToolCallingEngine } from './toolCalling/ToolCallingEngine'
import { customApiUrl, customRequestHeaders } from '../providers/customApi'
import type { ToolCallingTransformResult } from './toolCalling/types'
import { sessionManager } from './sessionManager'
import { getConversationOptions, setConversationAbortSignal } from './conversationContinuity'
import type { ProviderConversationState } from './conversationTypes'
import {
  createContextManagementService,
  SummaryGenerator,
} from './services/contextManagementService'

// Capability is held only by this module; neither JSON nor an HTTP header can opt in.
const accountProbeRequests = new WeakSet<ChatCompletionRequest>()
const accountProbeResponseCleanup = new WeakMap<ChatCompletionRequest, Set<() => void>>()
const oversizedAccountProbes = new WeakSet<ChatCompletionRequest>()
const PROBE_RESPONSE_LIMIT = 1024 * 1024
const PROBE_RESPONSE_LIMIT_MESSAGE = 'Account test response exceeded the safe size limit.'
function getForwardConversationOptions(request: ChatCompletionRequest) {
  const options = getConversationOptions(request)
  // A probe always creates its own short chat. Never bind to or clean up another chat,
  // and do not inherit global single-chat deletion timers or generate a title.
  return accountProbeRequests.has(request) ? { ...options, retainConversation: true } : options
}

function shouldDeleteSession(request: ChatCompletionRequest): boolean {
  return !getForwardConversationOptions(request).retainConversation && sessionManager.shouldDeleteAfterChat()
}

function recordDeepSeekRestriction(accountId: string, restriction: DeepSeekRestriction): void {
  if (restriction.kind === 'temporary') {
    // The deadline may elapse between parsing and persistence. Do not turn it into an indefinite hold.
    if (restriction.until !== undefined && restriction.until <= Date.now()) return
    AccountManager.suspendUntil(accountId, restriction.until)
  }
  else AccountManager.updateStatus(accountId, 'error', 'DeepSeek account suspended; manual review required.')
}

function attachConversationListener(request: ChatCompletionRequest, handler: {
  setConversationListener(listener: (state: ProviderConversationState) => void): void
}): void {
  const listener = getForwardConversationOptions(request).onConversation
  if (listener) handler.setConversationListener(listener)
}

type ProviderForwarder = {
  name: string
  matches: (provider: Provider) => boolean
  forward: (
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ) => Promise<ForwardResult>
}

/**
 * Request Forwarder
 */
export class RequestForwarder {
  private axiosInstance = axios.create({
    timeout: 120000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  })

  private readonly providerForwarders: ProviderForwarder[] = [
    {
      name: 'arena', matches: ArenaAdapter.isArenaProvider,
      forward: (request, account, provider, actualModel, startTime) => this.forwardArena(request, account, provider, actualModel, startTime),
    },
    {
      name: 'deepseek',
      matches: DeepSeekAdapter.isDeepSeekProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardDeepSeek(request, account, provider, actualModel, startTime),
    },
    {
      name: 'glm',
      matches: GLMAdapter.isGLMProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardGLM(request, account, provider, actualModel, startTime),
    },
    {
      name: 'kimi',
      matches: KimiAdapter.isKimiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardKimi(request, account, provider, actualModel, startTime),
    },
    {
      name: 'qwen',
      matches: QwenAdapter.isQwenProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardQwen(request, account, provider, actualModel, startTime),
    },
    {
      name: 'qwen-ai',
      matches: QwenAiAdapter.isQwenAiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardQwenAi(request, account, provider, actualModel, startTime),
    },
    {
      name: 'zai',
      matches: ZaiAdapter.isZaiProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardZai(request, account, provider, actualModel, startTime),
    },
    {
      name: 'minimax',
      matches: MiniMaxAdapter.isMiniMaxProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMiniMax(request, account, provider, actualModel, startTime),
    },
    {
      name: 'mimo',
      matches: MimoAdapter.isMimoProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardMimo(request, account, provider, actualModel, startTime),
    },
    {
      name: 'perplexity',
      matches: PerplexityAdapter.isPerplexityProvider,
      forward: (request, account, provider, actualModel, startTime) =>
        this.forwardPerplexity(request, account, provider, actualModel, startTime),
    },
  ]

  supportsConversation(provider: Provider): boolean {
    return provider.type !== 'custom' && this.providerForwarders.some(entry => entry.matches(provider))
  }

  /** Local exact-account probe: no routing/retries or manual switch changes; official restriction handling remains active. */
  async forwardAccountProbe(accountId: string, actualModel: string, signal?: AbortSignal, displayModel?: string): Promise<ForwardResult> {
    const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
      && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f*]/.test(value)
    if (!validText(accountId) || !validText(actualModel) || (displayModel !== undefined && !validText(displayModel))) {
      return { success: false, status: 400, errorCode: 'invalid_account_probe', error: 'Invalid account test selection.', latency: 0 }
    }
    if (signal?.aborted) return this.cancelledAccountProbe()
    const account = storeManager.getAccountById(accountId)
    const provider = account ? storeManager.getProviderById(account.providerId) : undefined
    if (!account || !provider) return { success: false, status: 404, errorCode: 'account_probe_not_found', error: 'The account or its provider no longer exists.', latency: 0 }
    const request: ChatCompletionRequest = {
      model: displayModel ?? actualModel,
      messages: [{ role: 'user', content: '你好，请只回复 OK。' }],
      stream: false, max_tokens: 32,
    }
    accountProbeRequests.add(request)
    accountProbeResponseCleanup.set(request, new Set())
    if (signal) setConversationAbortSignal(request, signal)
    try {
      // Await real settlement even if a transport ignores AbortSignal. The caller must
      // not release its per-account job lock merely because its deadline has elapsed.
      const result = await this.doForward(request, account, provider, actualModel, {
        requestId: 'account-probe', model: request.model, actualModel, startTime: Date.now(), isStream: false,
      })
      if (oversizedAccountProbes.has(request)) return { success: false, status: 502,
        errorCode: 'account_probe_response_too_large', error: PROBE_RESPONSE_LIMIT_MESSAGE, latency: result.latency }
      return signal?.aborted ? this.cancelledAccountProbe(result.latency) : result
    } catch {
      return signal?.aborted ? this.cancelledAccountProbe() : {
        success: false, status: 502, errorCode: 'account_probe_failed', error: 'Account test failed. It was not retried.', latency: 0,
      }
    } finally {
      accountProbeResponseCleanup.get(request)?.forEach(cleanup => cleanup())
      accountProbeResponseCleanup.delete(request)
      oversizedAccountProbes.delete(request)
      accountProbeRequests.delete(request)
    }
  }

  private cancelledAccountProbe(latency = 0): ForwardResult {
    return { success: false, status: 499, errorCode: 'account_probe_cancelled', error: 'Account test was cancelled.', latency }
  }

  /** Stop only the raw response owned by this probe, never a shared browser/session. */
  private bindProbeCancellation(request: ChatCompletionRequest, source: any): any {
    if (!accountProbeRequests.has(request)) return source
    const signal = getForwardConversationOptions(request).signal
    if (signal?.aborted) {
      source?.destroy?.()
      throw new Error('Account test was cancelled.')
    }
    if (typeof source?.destroy !== 'function' || typeof source?.[Symbol.asyncIterator] !== 'function' || source.destroyed || source.readableEnded) return source
    // The generator is lazy: no data listener or pipe starts the upstream flowing
    // before the parser subscribes. Backpressure and UTF-8 bytes remain intact.
    const bounded = Readable.from((async function* () {
      let bytes = 0
      try {
        for await (const chunk of source) {
          bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
          if (!Number.isSafeInteger(bytes) || bytes > PROBE_RESPONSE_LIMIT) {
            oversizedAccountProbes.add(request)
            throw new Error(PROBE_RESPONSE_LIMIT_MESSAGE)
          }
          yield chunk
        }
      } finally { if (!source.destroyed && !source.readableEnded) source.destroy() }
    })())
    const abort = () => { source.destroy(); bounded.destroy(new Error('Account test was cancelled.')) }
    const sourceError = (error: Error) => bounded.destroy(error)
    const cleanup = () => {
      signal?.removeEventListener('abort', abort)
      bounded.removeListener('end', cleanup)
      bounded.removeListener('close', cleanup)
      bounded.removeListener('error', cleanup)
      source.removeListener('error', sourceError)
      accountProbeResponseCleanup.get(request)?.delete(release)
      if (!source.destroyed && !source.readableEnded) source.destroy()
    }
    // A non-2xx response may return before its body is consumed. Close only that
    // owned response on settlement, so its socket/listeners do not outlive the job.
    const release = () => { cleanup(); source.destroy(); bounded.destroy() }
    accountProbeResponseCleanup.get(request)?.add(release)
    bounded.once('end', cleanup)
    bounded.once('close', cleanup)
    bounded.once('error', cleanup)
    source.once('error', sourceError)
    signal?.addEventListener('abort', abort, { once: true })
    return bounded
  }

  private async forwardArena(request: ChatCompletionRequest, account: Account, provider: Provider, actualModel: string, startTime: number): Promise<ForwardResult> {
    try {
      if (request.model.startsWith('arena/image/')) throw new ArenaError('invalid_request')
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const { response, sessionId } = await new ArenaAdapter(provider, account).chatCompletion({
        ...request, ...getForwardConversationOptions(request), model: actualModel, messages: transformed.messages, tools: transformed.tools,
      })
      const responseData = this.bindProbeCancellation(request, response.data)
      const handler = new ArenaStreamHandler(request.model, sessionId, transformed.plan, { id: sessionId, modelId: actualModel, modality: 'text' })
      attachConversationListener(request, handler)
      if (request.stream) return { success: true, status: 200, headers: {}, stream: await handler.handleStream(responseData), skipTransform: true, latency: Date.now()-startTime }
      return { success: true, status: 200, headers: {}, body: await handler.handleNonStream(responseData), latency: Date.now()-startTime }
    } catch (error) {
      const known = error instanceof ArenaError
      if (known && error.diagnostic) console.error('[Arena] Request stage:', JSON.stringify(error.diagnostic))
      return { success: false, status: known ? error.status : 502, errorCode: known ? error.code : 'upstream_error',
        error: known ? error.message : 'Arena request failed. It was not retried.', latency: Date.now()-startTime,
        ...(known && error.retryAt ? { headers: { 'retry-after': String(Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1000))) } } : {}) }
    }
  }

  conversationKind(provider: Provider): string | undefined {
    return provider.type === 'custom' ? undefined : this.providerForwarders.find(entry => entry.matches(provider))?.name
  }

  /**
   * Transform request for prompt-based tool calling
   * For models that don't support native function calling
   * Delegates tool normalization, prompt injection, and parser planning to ToolCallingEngine.
   */
  private transformRequestForPromptToolUse(
    request: ChatCompletionRequest,
    provider?: Provider
  ): ToolCallingTransformResult {
    if (accountProbeRequests.has(request)) return {
      messages: request.messages,
      plan: {
        mode: 'disabled', protocol: 'openai_chat', clientAdapterId: 'standard-openai-tools',
        providerId: provider?.id ?? 'custom', tools: [], shouldInjectPrompt: false,
        shouldParseResponse: false, toolChoiceMode: 'none', allowedToolNames: new Set(),
        diagnostics: { clientAdapterId: 'standard-openai-tools', providerId: provider?.id ?? 'custom',
          toolSource: 'none', mode: 'disabled', protocol: 'openai_chat', toolCount: 0,
          injected: false, reason: 'account_probe' },
      },
    }
    const config = storeManager.getConfig().toolCallingConfig
    const engine = new ToolCallingEngine(config)

    const transformed = engine.transformRequest({
      request,
      provider: provider ?? {
        id: 'custom',
        name: 'Custom',
        type: 'custom',
        authType: 'token',
        apiEndpoint: '',
        headers: {},
        enabled: true,
        createdAt: 0,
        updatedAt: 0,
      },
      actualModel: request.model,
      contextAlreadyInitialized: !!getForwardConversationOptions(request).conversation,
    })
    // Preserve the parser plan, without rendering or sending a repeated schema.
    return getForwardConversationOptions(request).conversation
      ? { ...transformed, messages: request.messages, tools: undefined }
      : transformed
  }

  private applyToolCallsToResponse(result: any, transformed: ToolCallingTransformResult): void {
    if (!transformed.plan?.shouldParseResponse) return
    const engine = new ToolCallingEngine(storeManager.getConfig().toolCallingConfig)
    engine.applyNonStreamResponse(result, transformed.plan)
  }

  /**
   * Create summary generator function for context management
   * Uses the current provider and account to generate summaries
   */
  private createSummaryGenerator(
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): SummaryGenerator {
    return async (messages: ContextChatMessage[], prompt?: string): Promise<string> => {
      try {
        console.log('[SummaryGenerator] Generating summary for', messages.length, 'messages')

        const summaryPrompt = prompt || 'Please summarize the following conversation concisely, keeping key information and context:'

        const conversationText = messages
          .map(msg => {
            const role = msg.role.toUpperCase()
            const content = typeof msg.content === 'string'
              ? msg.content
              : Array.isArray(msg.content)
                ? msg.content
                    .filter(part => part.type === 'text' && part.text)
                    .map(part => part.text)
                    .join('\n')
                : ''
            return `${role}: ${content}`
          })
          .join('\n\n')

        const summaryRequest: ChatCompletionRequest = {
          model: actualModel,
          messages: [
            {
              role: 'system',
              content: summaryPrompt,
            },
            {
              role: 'user',
              content: conversationText,
            },
          ],
          stream: false,
          temperature: 0.3,
        }

        const result = await this.doForward(
          summaryRequest,
          account,
          provider,
          actualModel,
          context
        )

        if (result.success && result.body) {
          const summaryContent = result.body.choices?.[0]?.message?.content || ''
          console.log('[SummaryGenerator] Summary generated successfully, length:', summaryContent.length)
          return summaryContent
        }

        console.warn('[SummaryGenerator] Failed to generate summary:', result.error)
        return 'Failed to generate conversation summary.'
      } catch (error) {
        console.error('[SummaryGenerator] Error generating summary:', error)
        return 'Failed to generate conversation summary due to an error.'
      }
    }
  }

  /**
   * Forward Chat Completions Request
   */
  async forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()
    const config = storeManager.getConfig()
    const retained = getForwardConversationOptions(request).retainConversation
    // A retry could append the same input twice after an uncertain upstream response.
    const maxRetries = retained || this.supportsConversation(provider) || request.tools?.length || request.messages.some(message => message.role === 'tool') ? 0 : config.retryCount

    let lastError: string | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await this.delay(5000)
      }

      let modifiedRequest = request

      // Summarization drops assistant call IDs / tool results and can create an
      // extra unrequested generation. A native tool exchange must stay intact.
      const hasToolExchange = !!modifiedRequest.tools?.length || modifiedRequest.messages.some(message => message.role === 'tool' || message.tool_calls?.length)
      if (!retained && !hasToolExchange && config.contextManagement?.enabled && modifiedRequest.messages && modifiedRequest.messages.length > 0) {
        try {
          const summaryGenerator = this.createSummaryGenerator(
            account,
            provider,
            actualModel,
            context
          )

          const contextService = createContextManagementService(
            config.contextManagement || {},
            summaryGenerator
          )

          const originalCount = modifiedRequest.messages.length
          const contextMessages: ContextChatMessage[] = modifiedRequest.messages.map(msg => ({
            role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
            content: msg.content,
            timestamp: Date.now(),
          }))

          const processResult = await contextService.process(contextMessages)

          if (processResult.finalCount !== originalCount) {
            console.log(
              `[Forwarder] Context management applied: ${originalCount} -> ${processResult.finalCount} messages`
            )

            processResult.strategyResults.forEach(result => {
              if (result.trimmed) {
                console.log(
                  `[Forwarder] Strategy ${result.strategyName}: ${result.originalCount} -> ${result.processedCount} messages`
                )
              }
            })

            modifiedRequest = {
              ...modifiedRequest,
              messages: processResult.messages.map(msg => ({
                role: msg.role,
                content: msg.content,
              })),
            }
          }
        } catch (error) {
          console.error('[Forwarder] Context management failed:', error)
        }
      }

      try {
        const result = await this.doForward(modifiedRequest, account, provider, actualModel, context)

        if (result.success || retained || attempt === maxRetries) {
          return result
        }

        lastError = result.error

        if (result.status && result.status < 500 && result.status !== 429) {
          break
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Unknown error'
      }
    }

    return {
      success: false,
      error: lastError || 'Request failed after retries',
      latency: Date.now() - startTime,
    }
  }

  /**
   * Execute Forward
   */
  private async doForward(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    context: ProxyContext
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    // Selection can become stale while context preparation is awaiting work.
    const probe = accountProbeRequests.has(request)
    const current = storeManager.getAccountById(account.id, probe)
    // Only a local explicit check may disregard a manual switch or stale auth status.
    // The persisted permanent-ban marker, cooldown and daily budget still win.
    const permanentlyBanned = current?.errorMessage === 'DeepSeek account suspended; manual review required.'
      || current?.errorMessage === 'account_banned'
    const availability = current && (!probe || !permanentlyBanned)
      ? accountAvailability(probe ? { ...current, enabled: true, status: 'active' } : current)
      : { available: false, reason: 'missing' }
    if (!availability.available) {
      if (probe) {
        const errorCode = permanentlyBanned ? 'account_banned' : !current ? 'account_probe_not_found'
          : availability.reason === 'cooldown' ? 'account_temporarily_suspended' : 'account_daily_limit'
        return { success: false, status: permanentlyBanned ? 403 : !current ? 404 : 429, errorCode,
          error: 'The account test was blocked before submission by its current account restrictions.', latency: 0,
          ...('availableAt' in availability && availability.availableAt ? { headers: {
            'retry-after': String(Math.max(1, Math.ceil((availability.availableAt - Date.now()) / 1000))),
          } } : {}) }
      }
      return { success: false, status: 409, errorCode: 'account_unavailable',
        error: 'This account is disabled, cooling down or unavailable. It was not submitted to the provider.', latency: 0 }
    }

    if (probe && getForwardConversationOptions(request).signal?.aborted) return this.cancelledAccountProbe()
    if (probe && current) {
      // Fresh credentials and provider affiliation, not the caller's previous selection.
      account = current
      const freshProvider = storeManager.getProviderById(current.providerId)
      if (!freshProvider || freshProvider.id !== provider.id) return { success: false, status: 409,
        errorCode: 'account_probe_selection_changed', error: 'The account provider changed before submission.', latency: 0 }
      provider = freshProvider
    }

    // A user-defined OpenAI API must not be hijacked by website hostname detection.
    const dedicatedForwarder = provider.type === 'custom' ? undefined : this.providerForwarders.find(forwarder => forwarder.matches(provider))
    if (dedicatedForwarder) {
      return dedicatedForwarder.forward(request, account, provider, actualModel, startTime)
    }

    try {
      const chatPath = provider.chatPath || '/chat/completions'
      const url = this.buildUrl(provider, chatPath)
      const headers = this.buildHeaders(provider, account)
      const body = this.buildRequestBody(request, actualModel, account)

      const axiosConfig: AxiosRequestConfig = {
        method: 'POST',
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: request.stream ? 'stream' : 'json',
        validateStatus: () => true,
        ...(provider.type === 'custom' ? { maxRedirects: 0 } : {}),
        signal: getForwardConversationOptions(request).signal,
        ...(probe ? { maxContentLength: PROBE_RESPONSE_LIMIT, maxBodyLength: 16 * 1024 } : {}),
      }

      const response: AxiosResponse = await this.axiosInstance.request(axiosConfig)
      const latency = Date.now() - startTime

      if (response.status >= 400 || (provider.type === 'custom' && response.status >= 300)) {
        if (provider.type === 'custom') {
          // A remote API may echo request secrets in prose or HTML. Do not put
          // that body into client errors, request logs, or desktop diagnostics.
          if (typeof response.data?.destroy === 'function') response.data.destroy()
          return this.customApiFailure(response.status, latency, response.headers)
        }
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (request.stream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      if (provider.type === 'custom' && !(probe && error instanceof AxiosError && /^maxContentLength size of \d+ exceeded$/.test(error.message))) {
        if (error instanceof AxiosError) {
          if (typeof error.response?.data?.destroy === 'function') error.response.data.destroy()
          return this.customApiFailure(error.response?.status, latency, error.response?.headers)
        }
        return this.customApiFailure(undefined, latency)
      }

      if (error instanceof AxiosError) {
        if (probe && /^maxContentLength size of \d+ exceeded$/.test(error.message)) return {
          success: false, status: 502, errorCode: 'account_probe_response_too_large',
          error: PROBE_RESPONSE_LIMIT_MESSAGE, latency,
        }
        return {
          success: false,
          status: error.response?.status,
          error: error.message,
          latency,
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  private customApiFailure(status: unknown, latency: number, headers?: any): ForwardResult {
    const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502
    const code = ({ 401: 'authentication_required', 403: 'access_denied', 404: 'model_unavailable', 429: 'rate_limited' } as Record<number, string>)[httpStatus] ?? 'upstream_error'
    const retryAfter = headers?.['retry-after']
    return { success: false, status: httpStatus, errorCode: code, error: `Custom API request failed: ${code}.`, latency,
      ...(typeof retryAfter === 'string' && /^\d{1,10}$/.test(retryAfter) ? { headers: { 'retry-after': retryAfter } } : {}) }
  }

  /**
   * DeepSeek Dedicated Forward
   */
  private async forwardDeepSeek(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new DeepSeekAdapter(provider, account)
      
      const { response, sessionId } = await adapter.chatCompletion({
        ...getForwardConversationOptions(request),
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
      })
      const responseData = this.bindProbeCancellation(request, response.data)

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (responseData) {
          if (typeof responseData === 'string') {
            errorMessage = responseData
          } else if (responseData.msg) {
            errorMessage = responseData.msg
          } else if (responseData.error?.message) {
            errorMessage = responseData.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      // Prepare callback for deleting session
      const deleteSessionCallback = shouldDeleteSession(request)
        ? async () => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[DeepSeek] Failed to delete session:', error)
            }
          }
        : undefined

      // DeepSeek always returns streaming response
      const handler = new DeepSeekStreamHandler(
        actualModel,
        sessionId,
        deleteSessionCallback,
        transformedRequest.web_search,
        transformedRequest.reasoning_effort,
        transformed.plan,
        request.model
      )
      // Nonstream restrictions are handled once by the catch below. Streaming errors arrive later.
      if (request.stream) handler.setAccountRestrictionListener(restriction => recordDeepSeekRestriction(account.id, restriction))
      attachConversationListener(request, handler)
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(responseData)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      // Non-streaming requests need to collect stream data and convert
      const result = await handler.handleNonStream(responseData)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (deleteSessionCallback) {
        await deleteSessionCallback()
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      if (error instanceof DeepSeekAccountRestrictionError) {
        recordDeepSeekRestriction(account.id, error.restriction)
        return { success: false, status: error.status, errorCode: error.code, error: error.message, latency,
          ...(error.restriction.until ? { headers: { 'retry-after': String(Math.max(1, Math.ceil((error.restriction.until - Date.now()) / 1000))) } } : {}) }
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * GLM Dedicated Forward
   */
  private async forwardGLM(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new GLMAdapter(provider, account)
      const { response, conversationId } = await adapter.chatCompletion({
        ...getForwardConversationOptions(request),
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        web_search: transformedRequest.web_search,
        reasoning_effort: transformedRequest.reasoning_effort,
        deep_research: transformedRequest.deep_research,
      })
      const responseData = this.bindProbeCancellation(request, response.data)

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        if (responseData) {
          if (typeof responseData === 'string') {
            errorMessage = responseData
          } else if (responseData.msg) {
            errorMessage = responseData.msg
          } else if (responseData.message) {
            errorMessage = responseData.message
          } else if (responseData.error?.message) {
            errorMessage = responseData.error.message
          }
        }
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new GLMStreamHandler(actualModel, undefined, conversationId, transformed.plan)
      attachConversationListener(request, handler)
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(responseData)
        
        // If delete session after chat is enabled, we need to handle it after stream ends
        if (shouldDeleteSession(request)) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const convId = handler.getConversationId()
            if (convId) {
              adapter.deleteConversation(convId).catch(err => {
                console.error('[GLM] Failed to delete session:', err)
              })
            }
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: handler.getConversationId(),
        }
      }

      const result = await handler.handleNonStream(responseData)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (shouldDeleteSession(request)) {
        const convId = handler.getConversationId()
        if (convId) {
          await adapter.deleteConversation(convId)
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  private async forwardKimi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new KimiAdapter(provider, account)
      const { response, conversationId } = await adapter.chatCompletion({
        ...getForwardConversationOptions(request),
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: request.reasoning_effort ? true : undefined,
        reasoning_effort: request.reasoning_effort,
        enableWebSearch: !!request.web_search,
      })
      const responseData = this.bindProbeCancellation(request, response.data)

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new KimiStreamHandler(actualModel, conversationId, !!request.reasoning_effort, transformed.plan)
      attachConversationListener(request, handler)
      
      if (request.stream) {
        const transformedStream = await handler.handleStream(responseData)
        
        // Add delete conversation callback if needed
        if (shouldDeleteSession(request)) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            const realChatId = handler.getConversationId()
            if (realChatId) {
              adapter.deleteConversation(realChatId).catch(err => {
                console.error('[Kimi] Failed to delete conversation:', err)
              })
            }
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: undefined,
        }
      }

      const result = await handler.handleNonStream(responseData)

      this.applyToolCallsToResponse(result, transformed)

      if (shouldDeleteSession(request)) {
        const realChatId = handler.getConversationId()
        if (realChatId) {
          await adapter.deleteConversation(realChatId)
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: handler.getConversationId() ?? undefined,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Qwen Dedicated Forward
   */
  private async forwardQwen(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }

      const adapter = new QwenAdapter(provider, account)
      const { response, sessionId, reqId } = await adapter.chatCompletion({
        ...getForwardConversationOptions(request),
        model: actualModel,
        originalModel: request.model,
        messages: transformedRequest.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enableThinking: !!request.reasoning_effort,
        enableWebSearch: !!request.web_search,
      })
      const responseData = this.bindProbeCancellation(request, response.data)

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession(request)
        ? async (sid: string) => {
            try {
              await adapter.deleteSession(sid)
            } catch (err) {
              console.error('[Qwen] Failed to delete session:', err)
            }
          }
        : undefined

      const handler = new QwenStreamHandler(actualModel, deleteSessionCallback, transformed.plan)
      attachConversationListener(request, handler)

      if (request.stream) {
        const transformedStream = await handler.handleStream(responseData, response)

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const result = await handler.handleNonStream(responseData, response)

      this.applyToolCallsToResponse(result, transformed)

      const sid = handler.getSessionId()
      if (deleteSessionCallback && sid) {
        await deleteSessionCallback(sid)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Qwen AI (International) Dedicated Forward
   */
  private async forwardQwenAi(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new QwenAiAdapter(provider, account)
      const { response, chatId, parentId } = await adapter.chatCompletion({
        ...getForwardConversationOptions(request),
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        enable_thinking: !!request.reasoning_effort,
      })
      const responseData = this.bindProbeCancellation(request, response.data)

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const handler = new QwenAiStreamHandler(actualModel, undefined, transformed.plan)
      attachConversationListener(request, handler)
      handler.setChatId(chatId)

      if (request.stream) {
        const transformedStream = await handler.handleStream(responseData)

        if (shouldDeleteSession(request)) {
          const originalEnd = transformedStream.end.bind(transformedStream)
          transformedStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            adapter.deleteChat(chatId).catch(err => {
              console.error('[QwenAI] Failed to delete chat:', err)
            })
            return originalEnd(chunk, encoding, callback)
          }
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(responseData)

      this.applyToolCallsToResponse(result, transformed)

      if (shouldDeleteSession(request)) {
        await adapter.deleteChat(chatId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Z.ai Dedicated Forward
   */
  private async forwardZai(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardZai] actualModel:', actualModel)
    console.log('[forwardZai] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new ZaiAdapter(provider, account)
      const { response, chatId, requestId } = await adapter.chatCompletion({
        ...getForwardConversationOptions(request),
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        web_search: request.web_search,
        reasoning_effort: request.reasoning_effort,
      })
      const responseData = this.bindProbeCancellation(request, response.data)

      const latency = Date.now() - startTime

      if (response.status !== 200) {
        // Do not hand a consumed, stalled, or redirect/error body to the chat parser.
        responseData?.destroy?.()
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession(request)
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[Z.ai] Failed to delete chat:', error)
            }
          }
        : undefined

      const handler = new ZaiStreamHandler(actualModel, deleteChatCallback, transformed.plan)
      attachConversationListener(request, handler)
      handler.setChatId(chatId)
      
      if (request.stream === true) {
        const transformedStream = await handler.handleStream(responseData)
        
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      const result = await handler.handleNonStream(responseData)

      this.applyToolCallsToResponse(result, transformed)
      
      if (deleteChatCallback) {
        await deleteChatCallback(chatId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: result,
        latency,
        providerSessionId: chatId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      if (accountProbeRequests.has(request) || error instanceof ZaiUpstreamError) {
        // Only typed adapter failures may influence probe classification; never parse
        // arbitrary exception prose or export the raw provider message/upstreamCode.
        let status = 502, errorCode = 'upstream_error'
        if (error instanceof ZaiUpstreamError) {
          switch (error.category) {
            case 'captcha_required':
            case 'verification_required':
            case 'access_denied': status = 403; errorCode = 'action_required'; break
            case 'authentication_required': status = 401; errorCode = 'authentication_required'; break
            case 'rate_limited': status = 429; errorCode = 'rate_limited'; break
            case 'quota_exceeded': status = 429; errorCode = 'rate_limited'; break
            case 'model_unavailable': status = 404; errorCode = 'model_unavailable'; break
            case 'invalid_json':
            case 'unexpected_json':
            case 'incomplete_stream': errorCode = 'incomplete_response'; break
            case 'transport_error': errorCode = 'transport_error'; break
            case 'upstream_error': break
          }
        }
        if (error instanceof ZaiUpstreamError && !accountProbeRequests.has(request)) {
          // Keep the structured category for API callers and tool diagnostics too.
          // The website often reports a CAPTCHA in an otherwise HTTP-200 stream.
          const category = ['captcha_required', 'verification_required', 'access_denied', 'quota_exceeded'].includes(error.category)
            ? error.category : errorCode
          return { success: false, status, errorCode: category,
            error: `Z.ai upstream ${category}`, latency }
        }
        return { success: false, status, errorCode,
          error: 'Z.ai account test failed. Check the reported category; the request was not retried.', latency }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * MiniMax Dedicated Forward
   */
  private async forwardMiniMax(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardMiniMax] actualModel:', actualModel)
    console.log('[forwardMiniMax] provider.modelMappings:', provider.modelMappings)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new MiniMaxAdapter(provider, account)
      const { response, stream, chatId } = await adapter.chatCompletion({
        ...getForwardConversationOptions(request),
        toolCallingPlan: transformed.plan,
        model: actualModel,
        originalModel: request.model,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
      })
      const responseData = this.bindProbeCancellation(request, response?.data ?? stream?.stream)

      const latency = Date.now() - startTime

      if (response && response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteChatCallback = shouldDeleteSession(request)
        ? async (cid: string) => {
            try {
              await adapter.deleteChat(cid)
            } catch (error) {
              console.error('[MiniMax] Failed to delete chat:', error)
            }
          }
        : undefined

      if (request.stream === true && stream) {
        console.log('[forwardMiniMax] Using polling stream')
        
        if (deleteChatCallback) {
          const originalStream = stream.stream as unknown as PassThrough
          const originalEnd = originalStream.end.bind(originalStream)
          originalStream.end = function(chunk?: any, encoding?: any, callback?: any) {
            deleteChatCallback(chatId).catch(err => {
              console.error('[MiniMax] Failed to delete chat:', err)
            })
            return originalEnd(chunk, encoding, callback)
          }
        }
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: stream.stream as any,
          skipTransform: true,
          latency,
          providerSessionId: chatId,
        }
      }

      if (response) {
        this.applyToolCallsToResponse(responseData, transformed)
        
        if (deleteChatCallback) {
          await deleteChatCallback(chatId)
        }

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          body: responseData,
          latency,
          providerSessionId: chatId,
        }
      }

      return {
        success: false,
        error: 'No response or stream received',
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Mimo Dedicated Forward
   * Uses Mimo adapter for Xiaomi AI Studio
   */
  private async forwardMimo(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      const transformedRequest = {
        ...request,
        messages: transformed.messages,
        tools: transformed.tools,
      }
      const adapter = new MimoAdapter(provider, account)

      const { response, conversationId, query } = await adapter.chatCompletion({
        ...getForwardConversationOptions(request),
        model: actualModel,
        originalModel: request.originalModel,
        messages: transformedRequest.messages as any,
        stream: transformedRequest.stream,
        temperature: transformedRequest.temperature,
        reasoning_effort: transformedRequest.reasoning_effort,
        web_search: transformedRequest.web_search,
      })
      const responseData = this.bindProbeCancellation(request, response.data)

      const latency = Date.now() - startTime

      if (response.status >= 400) {
        let errorMessage = `HTTP ${response.status}`
        return {
          success: false,
          status: response.status,
          error: errorMessage,
          latency,
        }
      }

      const deleteSessionCallback = shouldDeleteSession(request)
        ? async (sessionId: string) => {
            try {
              await adapter.deleteSession(sessionId)
            } catch (error) {
              console.error('[Mimo] Failed to delete session:', error)
            }
          }
        : undefined

      const handler = new MimoStreamHandler(actualModel, conversationId, 'separate', transformed.plan)
      attachConversationListener(request, handler)

      if (request.stream) {
        const transformedStream = new PassThrough()
        const openAIStream = handler.handleStream(responseData)
        transformedStream.once('close', () => {
          if (!transformedStream.readableEnded) {
            responseData.destroy?.()
            openAIStream.destroy()
          }
        })

        ;(async () => {
          try {
            for await (const chunk of openAIStream) {
              transformedStream.write(chunk)
            }
            if (!accountProbeRequests.has(request) && !getForwardConversationOptions(request).conversation) {
              await adapter.generateConversationTitle(
                conversationId,
                query,
                handler.getAssistantContentForTitle()
              )
            }
            if (deleteSessionCallback) {
              await deleteSessionCallback(conversationId)
            }
            transformedStream.end()
          } catch (error) {
            console.error('[Mimo] Stream error:', error)
            transformedStream.destroy(error instanceof Error ? error : new Error(String(error)))
          }
        })()

        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: transformedStream,
          skipTransform: true,
          latency,
          providerSessionId: conversationId,
        }
      }

      const result = await handler.handleNonStream(responseData)
      const parsedResult = JSON.parse(result)
      this.applyToolCallsToResponse(parsedResult, transformed)
      if (!accountProbeRequests.has(request) && !getForwardConversationOptions(request).conversation) {
        await adapter.generateConversationTitle(
          conversationId,
          query,
          handler.getAssistantContentForTitle()
        )
      }
      if (deleteSessionCallback) {
        await deleteSessionCallback(conversationId)
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: parsedResult,
        skipTransform: true,
        latency,
        providerSessionId: conversationId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      console.error('[Mimo] Forward error:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Perplexity Dedicated Forward
   * Uses Electron's net API to bypass Cloudflare protection
   */
  private async forwardPerplexity(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    actualModel: string,
    startTime: number
  ): Promise<ForwardResult> {
    console.log('[forwardPerplexity] actualModel:', actualModel)
    try {
      const transformed = this.transformRequestForPromptToolUse(request, provider)
      
      const adapter = new PerplexityAdapter(provider, account)
      
      const { stream, sessionId } = await adapter.chatCompletion({
        ...getForwardConversationOptions(request),
        model: actualModel,
        messages: transformed.messages as any,
        stream: request.stream,
        temperature: request.temperature,
        reasoning_effort: request.reasoning_effort,
      })
      const responseData = this.bindProbeCancellation(request, stream)

      const latency = Date.now() - startTime

      if (request.stream === true) {
        const deleteSessionCallback = shouldDeleteSession(request)
          ? async () => {
              try {
                await adapter.deleteSession(sessionId)
              } catch (error) {
                console.error('[Perplexity] Failed to delete session:', error)
              }
            }
          : undefined

        const handler = new PerplexityStreamHandler(actualModel, sessionId, deleteSessionCallback, adapter, transformed.plan)
        attachConversationListener(request, handler)
        const transformedStream = await handler.handleStream(responseData)
        
        return {
          success: true,
          status: 200,
          headers: {},
          stream: transformedStream as any,
          skipTransform: true,
          latency,
          providerSessionId: sessionId,
        }
      }

      const handler = new PerplexityStreamHandler(actualModel, sessionId, undefined, adapter, transformed.plan)
      attachConversationListener(request, handler)
      const result = await handler.handleNonStream(responseData)
      
      this.applyToolCallsToResponse(result, transformed)
      
      if (shouldDeleteSession(request)) {
        await adapter.deleteSession(sessionId)
      }
      
      return {
        success: true,
        status: 200,
        headers: {},
        body: result,
        latency,
        providerSessionId: sessionId,
      }
    } catch (error) {
      const latency = Date.now() - startTime
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }

  /**
   * Build URL
   */
  private buildUrl(provider: Provider, path: string): string {
    if (provider.type === 'custom') return customApiUrl(provider, '/chat/completions')
    let baseUrl = provider.apiEndpoint

    if (baseUrl.endsWith('/')) {
      baseUrl = baseUrl.slice(0, -1)
    }

    if (!path.startsWith('/')) {
      path = '/' + path
    }

    if (baseUrl.includes('/v1') && path.startsWith('/v1')) {
      path = path.slice(3)
    }

    return `${baseUrl}${path}`
  }

  /**
   * Build Request Headers
   */
  private buildHeaders(provider: Provider, account: Account): Record<string, string> {
    if (provider.type === 'custom') return { 'Content-Type': 'application/json', ...customRequestHeaders(provider, account.credentials) }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...provider.headers,
    }

    const credentials = account.credentials

    if (credentials.token) {
      headers['Authorization'] = `Bearer ${credentials.token}`
    } else if (credentials.apiKey) {
      headers['Authorization'] = `Bearer ${credentials.apiKey}`
    } else if (credentials.accessToken) {
      headers['Authorization'] = `Bearer ${credentials.accessToken}`
    } else if (credentials.refreshToken) {
      headers['Authorization'] = `Bearer ${credentials.refreshToken}`
    }

    if (credentials.cookie) {
      headers['Cookie'] = credentials.cookie
    }

    if (credentials.sessionKey) {
      headers['X-Session-Key'] = credentials.sessionKey
    }

    return headers
  }

  /**
   * Build Request Body
   */
  private buildRequestBody(
    request: ChatCompletionRequest,
    actualModel: string,
    account: Account
  ): any {
    const body: any = {
      model: actualModel,
      messages: request.messages,
      stream: request.stream || false,
    }

    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }

    if (request.top_p !== undefined) {
      body.top_p = request.top_p
    }

    if (request.n !== undefined) {
      body.n = request.n
    }

    if (request.stop !== undefined) {
      body.stop = request.stop
    }

    if (request.max_tokens !== undefined) {
      body.max_tokens = request.max_tokens
    }

    if (request.presence_penalty !== undefined) {
      body.presence_penalty = request.presence_penalty
    }

    if (request.frequency_penalty !== undefined) {
      body.frequency_penalty = request.frequency_penalty
    }

    if (request.logit_bias !== undefined) {
      body.logit_bias = request.logit_bias
    }

    if (request.user !== undefined) {
      body.user = request.user
    }

    // Custom OpenAI-compatible APIs execute native tools. Dropping these fields
    // silently turns every tool request into an ordinary text-only generation.
    if (request.tools !== undefined) body.tools = request.tools
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice
    if (request.parallel_tool_calls !== undefined) body.parallel_tool_calls = request.parallel_tool_calls

    return body
  }

  /**
   * Extract Response Headers
   */
  private extractHeaders(headers: any): Record<string, string> {
    const result: Record<string, string> = {}

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key] = value
      } else if (Array.isArray(value)) {
        result[key] = value.join(', ')
      }
    }

    return result
  }

  /**
   * Extract Error Message
   */
  private extractErrorMessage(response: AxiosResponse): string {
    if (response.data) {
      if (typeof response.data === 'string') {
        return response.data
      }

      if (response.data.error?.message) {
        return response.data.error.message
      }

      if (response.data.message) {
        return response.data.message
      }

      if (response.data.msg) {
        return response.data.msg
      }

      try {
        return JSON.stringify(response.data)
      } catch {
        return 'Unknown error'
      }
    }

    return `HTTP ${response.status}`
  }

  /**
   * Delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Forward Request to Specified URL
   */
  async forwardToUrl(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: any,
    isStream: boolean = false
  ): Promise<ForwardResult> {
    const startTime = Date.now()

    try {
      const config: AxiosRequestConfig = {
        method,
        url,
        headers,
        data: body,
        timeout: proxyStatusManager.getConfig().timeout,
        responseType: isStream ? 'stream' : 'json',
        validateStatus: () => true,
      }

      const response: AxiosResponse = await this.axiosInstance.request(config)
      const latency = Date.now() - startTime

      if (response.status >= 400) {
        return {
          success: false,
          status: response.status,
          error: this.extractErrorMessage(response),
          latency,
        }
      }

      if (isStream) {
        return {
          success: true,
          status: response.status,
          headers: this.extractHeaders(response.headers),
          stream: response.data,
          latency,
        }
      }

      return {
        success: true,
        status: response.status,
        headers: this.extractHeaders(response.headers),
        body: response.data,
        latency,
      }
    } catch (error) {
      const latency = Date.now() - startTime

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        latency,
      }
    }
  }
}

export const requestForwarder = new RequestForwarder()
export default requestForwarder
