/**
 * Qwen AI (International) Authentication Adapter
 * Implements chat.qwen.ai API authentication
 */

import axios from 'axios'
import { BaseOAuthAdapter } from './base'
import {
  OAuthResult,
  OAuthOptions,
  TokenValidationResult,
  CredentialInfo,
  AdapterConfig,
  OAuthCallbackData,
} from '../types'

const QWEN_AI_API_BASE = 'https://chat.qwen.ai'

const REQUEST_HEADERS = {
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
  Origin: QWEN_AI_API_BASE,
  Pragma: 'no-cache',
  source: 'web',
}

export class QwenAiAdapter extends BaseOAuthAdapter {
  constructor(config: AdapterConfig) {
    super({
      ...config,
      providerType: 'qwen-ai',
      authMethods: ['manual'],
      loginUrl: QWEN_AI_API_BASE,
      apiUrl: QWEN_AI_API_BASE,
    })
  }

  async loginWithToken(providerId: string, token: string): Promise<OAuthResult> {
    this.emitProgress('pending', 'Validating Token...')
    
    try {
      const validation = await this.validateToken({ token })
      
      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType: 'qwen-ai',
          error: validation.error || 'Token validation failed',
        }
      }
      
      this.emitProgress('success', 'Token validation successful')
      
      return {
        success: true,
        providerId,
        providerType: 'qwen-ai',
        credentials: { token },
        accountInfo: validation.accountInfo,
      }
    } catch (error) {
      const errorMessage = 'The provider account could not be checked. Please retry.'
      return {
        success: false,
        providerId,
        providerType: 'qwen-ai',
        error: errorMessage,
      }
    }
  }

  protected async processCallback(data: OAuthCallbackData): Promise<void> {
    // Qwen AI does not support OAuth callback
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    const token = credentials.token
    if (typeof token !== 'string' || !token || /\s/.test(token) || token.length > 128 * 1024) {
      return { valid: false, error: 'A valid account token is required.' }
    }
    // Parsing can reject obviously stale/guest credentials, but it can never
    // authenticate an unsigned payload or establish account identity.
    if (token.startsWith('eyJ')) {
      try {
        const parts = token.split('.')
        if (parts.length !== 3) return { valid: false, error: 'Invalid account token format.' }
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { valid: false, error: 'Invalid account token format.' }
        if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) return { valid: false, error: 'The account token has expired. Please sign in again.' }
        if (payload.is_guest === true || payload.is_anonymous === true || (typeof payload.email === 'string' && payload.email.toLowerCase().endsWith('@guest.com'))) {
          return { valid: false, error: 'Please sign in with a non-guest account.' }
        }
      } catch { return { valid: false, error: 'Invalid account token format.' } }
    }
    try {
      const profile = await this.getUserInfo(token)
      if (!profile || Array.isArray(profile) || typeof profile !== 'object') {
        return { valid: false, error: 'The provider could not verify this account. Check your network or sign in again.' }
      }
      const asText = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim()
        : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
      const userId = asText(profile.id ?? profile.user_id ?? profile.userId ?? profile.uid)
      const emailValue = asText(profile.email)
      const email = emailValue && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue) ? emailValue : undefined
      if (profile.is_guest === true || profile.isGuest === true || profile.role === 'guest' || email?.toLowerCase().endsWith('@guest.com')) {
        return { valid: false, error: 'Please sign in with a non-guest account.' }
      }
      if (!userId && !email) return { valid: false, error: 'The provider returned no verified account identity. Please sign in again.' }
      const name = asText(profile.name ?? profile.nickname)
      return { valid: true, tokenType: 'access', accountInfo: {
        ...(userId ? { userId } : {}), ...(email ? { email } : {}), ...(name ? { name } : {}),
      } }
    } catch {
      return { valid: false, error: 'The provider could not verify this account. Check your network or sign in again.' }
    }
  }

  async getUserInfo(token: string): Promise<Record<string, unknown> | null> {
    try {
      const response = await axios.get(`${QWEN_AI_API_BASE}/api/v2/user/info`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...REQUEST_HEADERS,
        },
        timeout: 15000,
        validateStatus: () => true,
      })
      
      if (response.status !== 200 || response.data?.success !== true) {
        return null
      }
      
      const profile = response.data.data
      return profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : null
    } catch {
      return null
    }
  }

  async refreshToken(credentials: Record<string, string>): Promise<CredentialInfo | null> {
    return null
  }
}

export default QwenAiAdapter

