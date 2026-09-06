import type { Readable } from 'node:stream'
import type { Account, Provider } from '../../store/types'
import type { ChatCompletionRequest, ChatMessage } from '../types'
import type { ConversationRequestOptions, ProviderConversationState } from '../conversationTypes'
import { arenaBrowserManager } from '../../arena/browserManager'
import { ArenaError, isArenaUuid, type ArenaConversation } from '../../arena/protocol'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'

export type ArenaChatRequest = ChatCompletionRequest & ConversationRequestOptions & { signal?: AbortSignal }

/** Text messages only. Images must use the image endpoint, never a URL pasted into a prompt. */
export function arenaMessagesToPrompt(messages: ReadonlyArray<ChatMessage>): string {
  if (!Array.isArray(messages) || !messages.length) throw new ArenaError('invalid_request')
  const profile = getProviderToolProfile('arena')
  return messages.map((message: ChatMessage) => {
    if (!message || !['user', 'assistant', 'system', 'tool'].includes(message.role)) throw new ArenaError('invalid_request')
    let text: string
    if (Array.isArray(message.content)) {
      if (message.content.some(block => block?.type !== 'text' || typeof block.text !== 'string')) throw new ArenaError('invalid_request')
      text = message.content.map(block => block.text).join('\n')
    } else if (message.content === null) text = ''
    else if (typeof message.content === 'string') text = message.content
    else throw new ArenaError('invalid_request')
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw new ArenaError('invalid_request')
      return profile.formatToolResult({ toolCallId: message.tool_call_id, content: text })
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const calls = message.tool_calls.map(call => ({ id: call.id, name: call.function.name, arguments: call.function.arguments }))
      return [text, profile.formatAssistantToolCalls(calls)].filter(Boolean).join('\n')
    }
    return message.role === 'system' ? `System: ${text}` : text
  }).join('\n\n')
}

export function arenaConversationState(conversation: ArenaConversation): ProviderConversationState {
  return { sessionId: conversation.id, extras: { modelId: conversation.modelId, modality: conversation.modality } }
}

export class ArenaAdapter {
  constructor(_provider: Provider, private readonly account: Account) {}

  async chatCompletion(request: ArenaChatRequest): Promise<{
    response: { status: number; headers: Record<string, string>; data: Readable }
    sessionId: string
  }> {
    if (!isArenaUuid(request.model)) throw new ArenaError('invalid_request')
    const profileId = this.account.credentials.browserProfileId
    if (typeof profileId !== 'string' || !profileId) throw new ArenaError('browser_unavailable')
    const prompt = arenaMessagesToPrompt(request.messages)
    if (!prompt.trim() || prompt.length > 200000) throw new ArenaError('invalid_request')
    let conversation: ArenaConversation | undefined
    if (request.conversation) {
      const state = request.conversation
      if (!isArenaUuid(state.sessionId) || state.extras?.modelId !== request.model || state.extras?.modality !== 'text') throw new ArenaError('invalid_request')
      conversation = { id: state.sessionId, modelId: state.extras.modelId, modality: 'text' }
    }
    let result: Awaited<ReturnType<typeof arenaBrowserManager.chat>>
    try { result = await arenaBrowserManager.chat({ accountId: this.account.id, profileId, model: request.model, prompt, conversation, signal: request.signal }) }
    catch (error) { throw error instanceof ArenaError ? error : new ArenaError('upstream_error') }
    if (!isArenaUuid(result.conversation.id) || result.conversation.modelId !== request.model || result.conversation.modality !== 'text') {
      result.stream.destroy()
      throw new ArenaError('upstream_error')
    }
    try { request.onConversation?.(arenaConversationState(result.conversation)) }
    catch { result.stream.destroy(); throw new ArenaError('upstream_error') }
    return { response: { status: 200, headers: {}, data: result.stream }, sessionId: result.conversation.id }
  }

  static isArenaProvider(provider: Provider): boolean { return provider.id === 'arena' }
}
