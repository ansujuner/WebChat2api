import { withProviderNetwork, bindProviderNetwork, getProviderProxyConfig, type ProviderProxyConfig } from '../network/providerContext.ts'
/**
 * OAuth Flow Manager
 * Manages authentication flows for providers, including local callback server and browser login
 */

import { BrowserWindow, shell } from 'electron'
import { EventEmitter } from 'events'
import {
  ProviderType,
  OAuthResult,
  OAuthOptions,
  OAuthStatus,
  OAuthProgressEvent,
  TokenValidationResult,
  CredentialInfo,
} from './types'
import { createAdapter, BaseOAuthAdapter } from './adapters'
import { inAppLoginManager, type TokenFoundEvent } from './inAppLogin'
import { externalBrowserLoginManager } from './externalBrowserLogin'
import { arenaBrowserManager } from '../arena/browserManager'

const DEFAULT_CALLBACK_PORT = 8311
const DEFAULT_TIMEOUT = 300000 // 5 minutes

/**
 * OAuth Manager class
 */
export class OAuthManager extends EventEmitter {
  private adapters: Map<string, BaseOAuthAdapter> = new Map()
  private mainWindow: BrowserWindow | null = null
  private inAppLoginPending = false
  private currentLogin: {
    providerId: string
    adapter: BaseOAuthAdapter
    resolve: (result: OAuthResult) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  } | null = null

  constructor() {
    super()
  }

  /**
   * Set main window reference
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window
  }

  /**
   * Get or create adapter
   */
  private getAdapter(providerId: string, providerType: ProviderType): BaseOAuthAdapter {
    const key = `${providerId}_${providerType}`

    if (!this.adapters.has(key)) {
      const adapter = createAdapter(providerType, {
        providerId,
        providerType,
        authMethods: [],
        callbackPort: DEFAULT_CALLBACK_PORT,
      })

      if (this.mainWindow) {
        adapter.setMainWindow(this.mainWindow)
      }

      adapter.setProgressCallback((event) => {
        this.emit('progress', event)
        this.sendProgressToRenderer(event)
      })

      this.adapters.set(key, adapter)
    }

    return this.adapters.get(key)!
  }

  /**
   * Send progress to renderer process
   */
  private sendProgressToRenderer(event: OAuthProgressEvent): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('oauth:progress', event)
    }
  }

  /**
   * Start OAuth login flow
   */
  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    return withProviderNetwork(options.providerId, async () => {
    if (this.currentLogin || this.inAppLoginPending || this.isInAppLoginOpen()) {
      return {
        success: false,
        providerId: options.providerId,
        providerType: options.providerType,
        error: 'A login process is already in progress',
      }
    }

    return new Promise((resolve, reject) => {
      const adapter = this.getAdapter(options.providerId, options.providerType)

      const timeout = setTimeout(() => {
        this.cancelLogin()
        const result: OAuthResult = {
          success: false,
          providerId: options.providerId,
          providerType: options.providerType,
          error: 'Login timeout',
        }
        resolve(result)
      }, options.timeout || DEFAULT_TIMEOUT)

      const attempt = this.currentLogin = {
        providerId: options.providerId,
        adapter,
        resolve,
        reject,
        timeout,
      }

      this.emit('statusChange', 'pending')

      adapter.startLogin(options)
        .then((result) => {
          if (this.currentLogin !== attempt) return
          this.cleanup()
          resolve(result)
        })
        .catch((error) => {
          if (this.currentLogin !== attempt) return
          this.cleanup()
          reject(error)
        })
    })

    })
  }

  /**
   * Complete authentication with manually entered token
   */
  async loginWithToken(
    providerId: string,
    providerType: ProviderType,
    token: string,
    realUserID?: string,
    mimoUserId?: string,
    mimoPhToken?: string
  ): Promise<OAuthResult> {
    return withProviderNetwork(providerId, async () => {
    const adapter = this.getAdapter(providerId, providerType)

    if ('loginWithToken' in adapter && typeof (adapter as any).loginWithToken === 'function') {
      return await (adapter as any).loginWithToken(providerId, token, realUserID, mimoUserId, mimoPhToken)
    }

    // For Mimo, validate with all three tokens
    if (providerType === 'mimo') {
      if (!mimoUserId || !mimoPhToken) {
        return {
          success: false,
          providerId,
          providerType,
          error: 'Mimo requires userId and phToken in addition to serviceToken',
        }
      }
      const validation = await adapter.validateToken({
        service_token: token,
        user_id: mimoUserId,
        ph_token: mimoPhToken,
      })

      if (!validation.valid) {
        return {
          success: false,
          providerId,
          providerType,
          error: validation.error || 'Token validation failed',
        }
      }

      return {
        success: true,
        providerId,
        providerType,
        credentials: {
          service_token: token,
          user_id: mimoUserId,
          ph_token: mimoPhToken,
        },
        accountInfo: validation.accountInfo,
      }
    }

    const validation = await adapter.validateToken({ token })

    if (!validation.valid) {
      return {
        success: false,
        providerId,
        providerType,
        error: validation.error || 'Token validation failed',
      }
    }

    return {
      success: true,
      providerId,
      providerType,
      credentials: { token },
      accountInfo: validation.accountInfo,
    }

    })
  }

  /**
   * Cancel current login flow
   */
  async cancelLogin(): Promise<void> {
    const attempt = this.currentLogin
    if (attempt) {
      try { await attempt.adapter.cancelLogin() } finally {
        if (this.currentLogin === attempt) {
          this.cleanup()
          attempt.resolve({ success: false, providerId: attempt.providerId, providerType: attempt.adapter.getProviderType(), error: 'Login cancelled' })
          this.emit('statusChange', 'cancelled')
        }
      }
    }
  }

  /**
   * Clean up current login state
   */
  private cleanup(): void {
    if (this.currentLogin) {
      clearTimeout(this.currentLogin.timeout)
      this.currentLogin = null
    }
  }

  /**
   * Validate Token
   */
  async validateToken(
    providerId: string,
    providerType: ProviderType,
    credentials: Record<string, string>
  ): Promise<TokenValidationResult> {
    return withProviderNetwork(providerId, async () => {
    const adapter = this.getAdapter(providerId, providerType)
    return adapter.validateToken(credentials)

    })
  }

  /**
   * Refresh Token
   */
  async refreshToken(
    providerId: string,
    providerType: ProviderType,
    credentials: Record<string, string>
  ): Promise<CredentialInfo | null> {
    return withProviderNetwork(providerId, async () => {
    const adapter = this.getAdapter(providerId, providerType)
    return adapter.refreshToken(credentials)

    })
  }

  /**
   * Open browser
   */
  async openBrowser(url: string): Promise<void> {
    await shell.openExternal(url)
  }

  /**
   * Get current login status
   */
  getStatus(): OAuthStatus {
    return this.currentLogin || this.inAppLoginPending ? 'pending' : 'idle'
  }

  /**
   * Start in-app login flow
   * Opens a new browser window within the app for login
   * Automatically extracts token after successful login
   */
  async startInAppLogin(
    providerId: string,
    providerType: ProviderType,
    timeout?: number,
    proxyMode?: ProviderProxyConfig | 'system' | 'none'
  ): Promise<OAuthResult> {
    return withProviderNetwork(providerId, async () => {
    const loginManager = providerType === 'deepseek' ? externalBrowserLoginManager : inAppLoginManager
    if (this.inAppLoginPending || this.currentLogin || this.isInAppLoginOpen()) {
      return { success: false, providerId, providerType, error: 'A login process is already in progress' }
    }
    if (providerType === 'arena') return this.startLogin({ providerId, providerType, timeout })
    this.inAppLoginPending = true
    let active = true
    let isValidating = false
    let collectedTokens: Record<string, string> = {}
    let validatedAccountInfo: TokenValidationResult['accountInfo']
    let validationTimeout: NodeJS.Timeout | null = null
    let revision = 0
    let attemptedRevision = -1
    let lastAttemptTime = 0
    let adapter: BaseOAuthAdapter
    const statusHandler = (event: { status: string; message: string }) => {
      if (active) this.sendProgressToRenderer({ status: 'pending', message: event.message })
    }
    const validateAndComplete = bindProviderNetwork(providerId, async (): Promise<void> => {
      if (!active || isValidating) return
      if (attemptedRevision === revision && Date.now() - lastAttemptTime < 5000) return
      const snapshot = { ...collectedTokens }
      let validationCredentials: Record<string, string>
      let finalCredentials: Record<string, string>
      if (providerType === 'minimax') {
        if (!snapshot.token) return
        const { token, realUserID } = snapshot
        validationCredentials = { token: realUserID ? `${realUserID}+${token}` : token }
        finalCredentials = { token, ...(realUserID ? { realUserID } : {}) }
      } else if (providerType === 'mimo') {
        const serviceToken = snapshot.serviceToken || snapshot.service_token
        const userId = snapshot.userId || snapshot.user_id
        const phToken = snapshot.xiaomichatbot_ph || snapshot.ph_token
        if (!serviceToken || !userId || !phToken) return
        validationCredentials = { service_token: serviceToken, user_id: userId, ph_token: phToken }
        finalCredentials = { ...validationCredentials }
      } else {
        if (!Object.keys(snapshot).some(key => key !== 'cookies')) return
        validationCredentials = { ...snapshot }
        finalCredentials = { ...snapshot }
      }
      isValidating = true
      attemptedRevision = revision
      lastAttemptTime = Date.now()
      this.sendProgressToRenderer({ status: 'pending', message: 'Checking the provider account...' })
      try {
        const validation = await withProviderNetwork(providerId, () => adapter.validateToken(validationCredentials))
        if (!active) return
        // A newer token may belong to the account the user just switched to. Do
        // not complete using a stale validation result from the previous token.
        if (attemptedRevision !== revision) return
        if (validation.valid) {
          validatedAccountInfo = validation.accountInfo ? { ...validation.accountInfo } : undefined
          loginManager.completeWithSuccess(finalCredentials)
        } else {
          this.sendProgressToRenderer({ status: 'pending', message: 'The account is not ready yet. Complete sign-in in the login window; account checks will retry.' })
        }
      } catch {
        if (active) this.sendProgressToRenderer({ status: 'pending', message: 'The provider account could not be checked. Check your network and finish signing in; the check will retry.' })
      } finally {
        isValidating = false
        if (active && attemptedRevision !== revision) {
          if (validationTimeout) clearTimeout(validationTimeout)
          validationTimeout = setTimeout(() => { void validateAndComplete() }, 250)
        }
      }
    })
    const tokenFoundHandler = (event: TokenFoundEvent): void => {
      if (!active || typeof event.key !== 'string' || typeof event.value !== 'string' || !event.value) return
      const cookies = event.allCookies ? JSON.stringify(event.allCookies) : undefined
      if (collectedTokens[event.key] !== event.value || (cookies !== undefined && cookies !== collectedTokens.cookies)) revision += 1
      collectedTokens = { ...collectedTokens, [event.key]: event.value, ...(cookies !== undefined ? { cookies } : {}) }
      if (providerType === 'minimax' && event.key === 'token' && !collectedTokens.realUserID) {
        if (validationTimeout) clearTimeout(validationTimeout)
        validationTimeout = setTimeout(() => { void validateAndComplete() }, 500)
      } else void validateAndComplete()
    }
    try {
      adapter = this.getAdapter(providerId, providerType)
      this.emit('statusChange', 'pending')
      this.sendProgressToRenderer({ status: 'pending', message: 'Opening login window...' })
      loginManager.on('status', statusHandler)
      loginManager.on('tokenFound', tokenFoundHandler)
      const result = await loginManager.startLogin({ providerId, providerType, timeout: timeout ?? DEFAULT_TIMEOUT, proxyConfig: getProviderProxyConfig(providerId) })
      active = false
      this.emit('statusChange', result.success ? 'success' : 'error')
      if (result.success && result.credentials) {
        this.sendProgressToRenderer({ status: 'success', message: 'Login successful' })
        return { success: true, providerId, providerType, credentials: { ...result.credentials },
          ...(validatedAccountInfo ? { accountInfo: validatedAccountInfo } : {}) }
      }
      return { success: false, providerId, providerType, error: result.error || 'Login failed' }
    } catch {
      return { success: false, providerId, providerType, error: 'The login flow could not be started. Please retry.' }
    } finally {
      active = false
      this.inAppLoginPending = false
      if (validationTimeout) clearTimeout(validationTimeout)
      loginManager.off('status', statusHandler)
      loginManager.off('tokenFound', tokenFoundHandler)
      collectedTokens = {}
    }

    })
  }

  /**
   * Cancel in-app login
   */
  cancelInAppLogin(): void {
    if (this.currentLogin?.adapter.getProviderType() === 'arena') { void this.cancelLogin(); return }
    inAppLoginManager.cancel()
    externalBrowserLoginManager.cancel()
    arenaBrowserManager.cancel()
  }

  /**
   * Check if in-app login window is open
   */
  isInAppLoginOpen(): boolean {
    return inAppLoginManager.isWindowOpen() || externalBrowserLoginManager.isWindowOpen() || arenaBrowserManager.isWindowOpen()
  }

  /**
   * Destroy manager
   */
  destroy(): void {
    this.cancelLogin()
    inAppLoginManager.destroy()
    externalBrowserLoginManager.destroy()
    arenaBrowserManager.cancel()
    this.adapters.forEach((adapter) => adapter.destroy())
    this.adapters.clear()
    this.removeAllListeners()
  }
}

/**
 * Singleton instance
 */
export const oauthManager = new OAuthManager()

export default OAuthManager

