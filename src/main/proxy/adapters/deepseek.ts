/**
 * DeepSeek Adapter
 * Implements DeepSeek web API protocol
 * 
 * NOTE: Tool prompt injection is handled by Forwarder.transformRequestForPromptToolUse()
 * This adapter only handles message format conversion and API communication
 */

import axios, { AxiosResponse } from 'axios'
import { getDeepSeekHash } from '../../lib/challenge'
import type { Account, Provider } from '../../store/types'
import { resolveDeepSeekChatOptions } from './providerModelOptions'
import { getProviderToolProfile } from '../toolCalling/providerProfiles'
import type { ConversationRequestOptions } from '../conversationTypes'
import { collectDeepSeekImages, createDeepSeekImageMultipart, validateDeepSeekUploadedFile, type DeepSeekImage } from './deepseek-images'
import { throwIfDeepSeekRestricted, readDeepSeekErrorBody } from './deepseek-restrictions'

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api'

const FAKE_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6',
  Origin: 'https://chat.deepseek.com',
  Referer: 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'X-App-Version': '2.0.0',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'x-Client-Timezone-Offset': '28800',
  'X-Client-Version': '2.0.0',
}

interface TokenInfo {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

interface ChallengeResponse {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
}

interface DeepSeekMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> | null
  tool_call_id?: string
  tool_calls?: any[]
}

interface ChatCompletionRequest extends ConversationRequestOptions {
  model: string
  originalModel?: string
  messages: DeepSeekMessage[]
  stream?: boolean
  temperature?: number
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max'
  tools?: any[]
  tool_choice?: any
}

const tokenCache = new Map<string, TokenInfo>()

function generateRandomString(length: number, charset: string = 'alphanumeric'): string {
  const sets = {
    numeric: '0123456789',
    alphabetic: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    alphanumeric: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    hex: '0123456789abcdef',
  }
  const chars = sets[charset as keyof typeof sets] || sets.alphanumeric
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

function generateCookie(): string {
  const timestamp = Date.now()
  return `intercom-HWWAFSESTIME=${timestamp}; HWWAFSESID=${generateRandomString(18, 'hex')}; Hm_lvt_${uuid()}=${Math.floor(timestamp / 1000)},${Math.floor(timestamp / 1000)},${Math.floor(timestamp / 1000)}; Hm_lpvt_${uuid()}=${Math.floor(timestamp / 1000)}; _frid=${uuid()}; _fr_ssid=${uuid()}; _fr_pvid=${uuid()}`
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

export class DeepSeekAdapter {
  private provider: Provider
  private account: Account
  private token: string

  constructor(provider: Provider, account: Account) {
    this.provider = provider
    this.account = account
    this.token = account.credentials.token || account.credentials.apiKey || account.credentials.refreshToken || ''
  }

  private async acquireToken(): Promise<string> {
    if (!this.token) {
      throw new Error('DeepSeek Token not configured, please add Token in account settings')
    }

    const cached = tokenCache.get(this.token)
    if (cached && cached.expiresAt > unixTimestamp()) {
      return cached.accessToken
    }

    console.log('[DeepSeek] Acquiring token...')
    
    const result = await axios.get(`${DEEPSEEK_API_BASE}/v0/users/current`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...FAKE_HEADERS,
      },
      timeout: 15000,
      validateStatus: () => true,
    })

    console.log('[DeepSeek] Token response status:', result.status)
    throwIfDeepSeekRestricted(result.data)
    
    if (result.status === 401 || result.status === 403) {
      throw new Error(`Token invalid or expired, please get a new Token`)
    }

    if (result.status !== 200) {
      throw new Error(`Failed to acquire token: HTTP ${result.status}`)
    }

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { token: "..." } } }
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (!bizData?.token) {
      const errorMsg = result.data?.msg || result.data?.data?.biz_msg || 'Unknown error'
      console.log('[DeepSeek] Token response omitted: expected access token was not returned')
      throw new Error(`Failed to acquire token: ${errorMsg}`)
    }

    const accessToken = bizData.token
    tokenCache.set(this.token, {
      accessToken,
      refreshToken: this.token,
      expiresAt: unixTimestamp() + 3600,
    })

    console.log('[DeepSeek] Token acquired successfully')
    return accessToken
  }

  private async createSession(): Promise<string> {
    const token = await this.acquireToken()
    const result = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat_session/create`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Cookie: generateCookie(),
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    console.log('[DeepSeek] Create session response status:', result.status)
    throwIfDeepSeekRestricted(result.data)

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { id: "..." } } }
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (result.status !== 200 || !bizData?.chat_session?.id) {
      throw new Error(`Failed to create session: ${result.data?.msg || result.data?.data?.biz_msg || result.status}`)
    }

    const sessionId = bizData?.chat_session?.id

    return sessionId
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const result = await axios.post(
        `${DEEPSEEK_API_BASE}/v0/chat_session/delete`,
        { chat_session_id: sessionId },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
          },
          timeout: 15000,
          validateStatus: () => true,
        }
      )

      console.log('[DeepSeek] Delete session response status:', result.status)

      const success = result.status === 200 && result.data?.code === 0
      if (success) {
        console.log('[DeepSeek] Session deleted')
      }
      return success
    } catch (error) {
      console.error('[DeepSeek] Failed to delete session; remote error details omitted')
      return false
    }
  }

  private async getChallenge(targetPath: string): Promise<ChallengeResponse> {
    const token = await this.acquireToken()
    const result = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat/create_pow_challenge`,
      { target_path: targetPath },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      }
    )

    // Response structure: { code: 0, data: { biz_code: 0, biz_data: { challenge: {...} } } }
    throwIfDeepSeekRestricted(result.data)
    const bizData = result.data?.data?.biz_data || result.data?.biz_data
    if (result.status !== 200 || !bizData?.challenge) {
      throw new Error(`Failed to get challenge: ${result.data?.msg || result.data?.data?.biz_msg || result.status}`)
    }

    return bizData.challenge
  }

  private async calculateChallengeAnswer(challenge: ChallengeResponse, targetPath = '/api/v0/chat/completion'): Promise<string> {
    const { algorithm, challenge: challengeStr, salt, difficulty, expire_at, signature } = challenge
    
    if (algorithm !== 'DeepSeekHashV1') {
      throw new Error(`Unsupported algorithm: ${algorithm}`)
    }
    
    console.log('[DeepSeek] Challenge parameters:', { difficulty })
    
    const deepSeekHash = await getDeepSeekHash()
    const answer = deepSeekHash.calculateHash(algorithm, challengeStr, salt, difficulty, expire_at)
    
    if (answer === undefined) {
      throw new Error('Challenge calculation failed')
    }
    
    console.log('[DeepSeek] Challenge answer found')

    return Buffer.from(JSON.stringify({
      algorithm,
      challenge: challengeStr,
      salt,
      answer,
      signature,
      target_path: targetPath,
    })).toString('base64')
  }

  /** Protocol verified in the official main.2029023598.js upload controller. */
  private async uploadImage(image: DeepSeekImage, modelType: string, thinkingEnabled: boolean, token: string): Promise<string> {
    const targetPath = '/api/v0/file/upload_file'
    const proof = await this.calculateChallengeAnswer(await this.getChallenge(targetPath), targetPath)
    const multipart = createDeepSeekImageMultipart(image)
    // Bounded buffers work identically with Node Axios and the app's Chromium
    // transport. No provider credentials ever reach a client-supplied URL.
    const uploaded = await axios.post(`${DEEPSEEK_API_BASE}/v0/file/upload_file`, multipart.body, {
      headers: {
        ...FAKE_HEADERS,
        Authorization: `Bearer ${token}`,
        'Content-Type': multipart.contentType,
        'X-Ds-Pow-Response': proof,
        'x-model-type': modelType,
        'x-thinking-enabled': thinkingEnabled ? '1' : '0',
        'x-file-size': String(image.bytes.length),
      },
      timeout: 60000,
      maxBodyLength: multipart.body.length,
      maxContentLength: 64 * 1024,
      maxRedirects: 0,
      validateStatus: () => true,
    })
    throwIfDeepSeekRestricted(uploaded.data)
    if (uploaded.status !== 200 || uploaded.data?.code !== 0 || uploaded.data?.data?.biz_code !== 0) {
      throw new Error(`DeepSeek image upload failed (HTTP ${uploaded.status}); no completion was submitted`)
    }
    let file = validateDeepSeekUploadedFile(uploaded.data.data.biz_data)
    const fileId = file.id
    // Website polling interval is 3 seconds. Read-only polls may repeat, but
    // neither uploads nor generations are retried after an uncertain result.
    const deadline = Date.now() + 60000
    while (file.status !== 'SUCCESS') {
      if (Date.now() + 3000 >= deadline) throw new Error('DeepSeek image processing timed out; no completion was submitted')
      await new Promise(resolve => setTimeout(resolve, 3000))
      const polled = await axios.get(`${DEEPSEEK_API_BASE}/v0/file/fetch_files`, {
        params: { file_ids: fileId },
        headers: { ...FAKE_HEADERS, Authorization: `Bearer ${token}` },
        timeout: Math.max(1, Math.min(15000, deadline - Date.now())),
        maxContentLength: 64 * 1024,
        maxRedirects: 0,
        validateStatus: () => true,
      })
      const files = polled.data?.data?.biz_data?.files
      throwIfDeepSeekRestricted(polled.data)
      if (polled.status !== 200 || polled.data?.code !== 0 || polled.data?.data?.biz_code !== 0 || !Array.isArray(files)) {
        throw new Error('DeepSeek image status check failed; no completion was submitted')
      }
      file = validateDeepSeekUploadedFile(files.find(item => item?.id === fileId))
    }
    return fileId
  }

  private messagesToPrompt(messages: DeepSeekMessage[]): string {
    const toolProfile = getProviderToolProfile('deepseek')
    const processedMessages = messages.map(message => {
      let text: string

      // Handle tool calls in assistant message
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
        text = toolProfile.formatAssistantToolCalls(message.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })))
      }
      // Handle tool response message
      else if (message.role === 'tool' && message.tool_call_id) {
        text = toolProfile.formatToolResult({
          toolCallId: message.tool_call_id,
          content: String(message.content || ''),
        })
      }
      else if (Array.isArray(message.content)) {
        const texts = message.content
          .filter((item: any) => item.type === 'text')
          .map((item: any) => item.text)
        text = texts.join('\n')
      } else {
        text = String(message.content || '')
      }
      return { role: message.role, text }
    })

    if (processedMessages.length === 0) return ''

    // The proxy already selected this turn's new messages. A plain user input
    // must remain byte-for-byte unchanged; never rebuild a chat transcript here.
    return processedMessages.map(({ role, text }) =>
      role === 'system' ? `System: ${text}` : text
    ).join('\n\n')
  }

  async chatCompletion(request: ChatCompletionRequest): Promise<{ response: AxiosResponse; sessionId: string }> {
    // Resolve/validate before authentication or creating a remote conversation.
    const { modelType, searchEnabled, thinkingEnabled } = resolveDeepSeekChatOptions(request)
    const images = collectDeepSeekImages(request.messages)
    if (images.length && modelType !== 'vision') {
      throw new Error('DeepSeek image understanding requires deepseek-v4-flash-vision-exp; text modes only extract text')
    }
    if (images.length && searchEnabled) throw new Error('DeepSeek images cannot be combined with web search; disable web_search')
    if (request.conversation && !request.conversation.parentMessageId) {
      throw new Error('DeepSeek conversation cannot continue without the previous assistant message ID; start a new client conversation')
    }
    const token = await this.acquireToken()
    const refFileIds: string[] = []
    for (const image of images) refFileIds.push(await this.uploadImage(image, modelType, thinkingEnabled, token))
    
    const sessionId = request.conversation?.sessionId || await this.createSession()
    request.onConversation?.({ ...request.conversation, sessionId })
    
    const challenge = await this.getChallenge('/api/v0/chat/completion')
    const challengeAnswer = await this.calculateChallengeAnswer(challenge)

    // Clone messages to avoid modifying original request
    // Note: Tool prompt injection is already handled by Forwarder.transformRequestForPromptToolUse()
    const messages = [...request.messages]

    const prompt = this.messagesToPrompt(messages)
    const parent = request.conversation?.parentMessageId
    // DeepSeek sends numeric message IDs. Preserve other ID representations
    // rather than guessing or performing unsafe integer coercion.
    const parentMessageId = parent && /^\d+$/.test(parent) && Number.isSafeInteger(Number(parent))
      ? Number(parent) : parent ?? null

    if (searchEnabled) {
      console.log('[DeepSeek] Web search enabled')
    }

    if (thinkingEnabled) {
      console.log('[DeepSeek] Reasoning mode enabled, effort:', request.reasoning_effort)
    }

    const response = await axios.post(
      `${DEEPSEEK_API_BASE}/v0/chat/completion`,
      {
        chat_session_id: sessionId,
        parent_message_id: parentMessageId,
        prompt,
        model_type: modelType,
        ref_file_ids: refFileIds,
        search_enabled: searchEnabled,
        thinking_enabled: thinkingEnabled,
        preempt: false,
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...FAKE_HEADERS,
          Referer: `https://chat.deepseek.com/a/chat/s/${sessionId}`,
          Cookie: generateCookie(),
          'X-Ds-Pow-Response': challengeAnswer,
        },
        timeout: 120000,
        validateStatus: () => true,
        responseType: 'stream',
      }
    )

    if (response.status !== 200 || /(?:application\/json|\+json)(?:;|$)/i.test(String(response.headers?.['content-type'] || ''))) {
      const problem = await readDeepSeekErrorBody(response.data)
      throwIfDeepSeekRestricted(problem, 'completion')
      throw new Error(`DeepSeek completion request failed: HTTP ${response.status}`)
    }
    return { response, sessionId }
  }

  async deleteAllChats(): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const result = await axios.post(
        `${DEEPSEEK_API_BASE}/v0/chat_session/delete_all`,
        {},
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...FAKE_HEADERS,
          },
          timeout: 30000,
          validateStatus: () => true,
        }
      )

      console.log('[DeepSeek] Delete all chats response status:', result.status)

      const success = result.status === 200 && result.data?.code === 0
      if (success) {
        console.log('[DeepSeek] All chats deleted')
      }
      return success
    } catch (error) {
      console.error('[DeepSeek] Failed to delete all chats; remote error details omitted')
      return false
    }
  }

  static isDeepSeekProvider(provider: Provider): boolean {
    return provider.id === 'deepseek' || provider.apiEndpoint.includes('deepseek.com')
  }

  /**
   * Clear session cache for a specific account
   * This should be called when a session is deleted externally (e.g., from web)
   */
  static clearSessionCache(accountId: string): void {
    // Compatibility hook: sessions now belong to individual proxy conversations,
    // never to an account-wide cache that could mix unrelated chats.
    console.log('[DeepSeek] No account-wide session cache to clear')
  }
}

export const deepSeekAdapter = {
  DeepSeekAdapter,
}
