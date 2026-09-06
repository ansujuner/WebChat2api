import { BaseOAuthAdapter } from './base'
import type { AdapterConfig, OAuthOptions, OAuthResult, TokenValidationResult } from '../types'
import { arenaBrowserManager, ArenaBrowserFailure } from '../../arena/browserManager'
import { arenaProfileCredentials } from '../../providers/arenaCatalog'
import { syncArenaProviderModels } from '../../providers/arenaIntegration'

export class ArenaAdapter extends BaseOAuthAdapter {
  private loginAbort: AbortController | null = null
  constructor(config: AdapterConfig) { super({ ...config, providerType: 'arena', authMethods: ['oauth'], loginUrl: 'https://arena.ai' }) }

  async startLogin(options: OAuthOptions): Promise<OAuthResult> {
    const abort = new AbortController()
    this.loginAbort = abort
    const status = (event: { message: string }) => { if (!abort.signal.aborted) this.emitProgress('pending', event.message) }
    arenaBrowserManager.on('status', status)
    try {
      const result = await arenaBrowserManager.startLogin()
      abort.signal.throwIfAborted()
      if (!result.success || !result.profileId) return { success: false, providerId: options.providerId, providerType: 'arena', errorCode: result.errorCode || 'identity_unverified', error: result.error || 'Arena login was not completed.' }
      const credentials = arenaProfileCredentials({ browserProfileId: result.profileId })
      await syncArenaProviderModels(credentials.browserProfileId, abort.signal)
      abort.signal.throwIfAborted()
      this.emitProgress('success', 'Arena account verified and live text/image model catalog synchronized.')
      return { success: true, providerId: options.providerId, providerType: 'arena', credentials,
        ...(result.accountInfo ? { accountInfo: { ...result.accountInfo } } : {}) }
    } catch (error) {
      return { success: false, providerId: options.providerId, providerType: 'arena', errorCode: abort.signal.aborted ? 'cancelled' : error instanceof ArenaBrowserFailure ? error.errorCode : 'browser_error', error: abort.signal.aborted ? 'Arena login cancelled.' : 'Arena login or live model discovery could not be completed. Finish sign-in and any verification prompts in its browser, then try again.' }
    } finally { arenaBrowserManager.off('status', status); if (this.loginAbort === abort) this.loginAbort = null }
  }

  async validateToken(credentials: Record<string, string>): Promise<TokenValidationResult> {
    try {
      const profile = arenaProfileCredentials(credentials)
      const status = await arenaBrowserManager.status(profile.browserProfileId)
      return status.authenticated ? { valid: true, accountInfo: status.accountInfo } : {
        valid: false, errorCode: status.errorCode || 'login_required',
        error: status.ready === false ? 'Arena browser readiness could not be verified; this does not mean the saved account is signed out.' : 'Arena sign-in requires attention in its isolated browser.',
      }
    } catch (error) { return { valid: false, errorCode: error instanceof ArenaBrowserFailure ? error.errorCode : 'invalid_account', error: 'Use Arena browser login; check its original profile and browser window before trying again.' } }
  }
  async refreshToken(): Promise<null> { return null }
  override async cancelLogin(): Promise<void> { this.loginAbort?.abort(); arenaBrowserManager.cancel(); await arenaBrowserManager.cancelAndWait() }
}
export default ArenaAdapter
