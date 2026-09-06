/** Internal upstream conversation state. Never accepted from client JSON or logged. */
export interface ProviderConversationState {
  sessionId: string
  parentMessageId?: string
  /** Provider-specific cursors only; scoped to the owning account/session. */
  extras?: Record<string, string>
}

export interface ConversationRequestOptions {
  /** Internal client-disconnect cancellation, never serialized into provider JSON. */
  signal?: AbortSignal
  /** Reuse this upstream conversation instead of creating a new one. */
  conversation?: ProviderConversationState
  /** Report IDs/cursors observed in actual upstream responses. */
  onConversation?: (state: ProviderConversationState) => void
  /** Do not delete a conversation while the proxy is retaining it for continuation. */
  retainConversation?: boolean
}
