import { arenaBrowserManager, ArenaBrowserFailure, type ArenaBrowserFailureCode } from '../arena/browserManager'
import { storeManager } from '../store/store'
import { arenaProfileCredentials, runtimeArenaCatalog, type ArenaProviderCatalog } from './arenaCatalog'

export async function fetchArenaProviderModels(profileId?: string, signal?: AbortSignal): Promise<ArenaProviderCatalog> {
  const selectedId = profileId ?? storeManager.getAccountsByProviderId('arena', true)
    .find(account => account.status === 'active' && account.credentials?.browserProfileId)?.credentials.browserProfileId
  signal?.throwIfAborted()
  const credentials = arenaProfileCredentials({ browserProfileId: selectedId })
  const status = await arenaBrowserManager.status(credentials.browserProfileId)
  signal?.throwIfAborted()
  if (status.ready === false) {
    const codes: ArenaBrowserFailureCode[] = ['profile_unavailable', 'browser_not_found', 'browser_start_failed', 'browser_connection_failed', 'page_not_ready']
    const code = status.errorCode as ArenaBrowserFailureCode
    throw new ArenaBrowserFailure(codes.includes(code) ? code : 'page_not_ready')
  }
  if (!status.authenticated) throw new Error('Arena account is not signed in. Open its isolated browser login before refreshing models.')
  const catalog = await arenaBrowserManager.getModels(credentials.browserProfileId)
  signal?.throwIfAborted()
  return runtimeArenaCatalog(catalog)
}

export async function syncArenaProviderModels(profileId?: string, signal?: AbortSignal): Promise<ArenaProviderCatalog> {
  const catalog = await fetchArenaProviderModels(profileId, signal)
  storeManager.ensureProviderExists('arena')
  storeManager.updateProvider('arena', catalog)
  return catalog
}
