import { storeManager } from '../store/store'
import { getNetworkProxyStatus } from '../network/proxy'

/** Read-only routing inventory: never reads accounts, submits chat or changes OS settings. */
export async function runProviderNetworkProbe() {
  const providers = storeManager.getProviders()
  const checks = await Promise.all(providers.map(async provider => {
    const source = ['inherit', 'none', 'system', 'custom'].includes(provider.networkProxyMode || '')
      ? provider.networkProxyMode : 'inherit'
    const name = provider.type === 'builtin' && ['deepseek', 'glm', 'kimi', 'mimo', 'minimax', 'qwen', 'qwen-ai', 'zai', 'perplexity', 'arena'].includes(provider.id)
      ? provider.id : 'custom'
    try {
      const result = await getNetworkProxyStatus(provider.id, provider.apiEndpoint)
      return { provider: name, source, mode: result.mode, route: result.route }
    } catch {
      return { provider: name, source, route: 'unknown' as const }
    }
  }))
  return { status: checks.some(check => check.route === 'unknown') ? 'needs_attention' : 'completed',
    resolutionOnly: true, providerRequestsSent: 0, checks }
}
