import type { BuiltinProviderConfig } from '../../store/types'

export const perplexityConfig: BuiltinProviderConfig = {
  id: 'perplexity',
  name: 'Perplexity',
  type: 'builtin',
  authType: 'cookie',
  apiEndpoint: 'https://www.perplexity.ai',
  chatPath: '/rest/sse/perplexity_ask',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    'Accept': 'text/event-stream',
    'Content-Type': 'application/json',
    'Origin': 'https://www.perplexity.ai',
    'Referer': 'https://www.perplexity.ai/',
  },
  enabled: true,
  description: 'Perplexity Search: Best (Auto alias) for Free; named models require Pro/Max. Web catalog verified 2026-09-06.',
  supportedModels: [
    'Best',
    'Auto',
    'Sonar 2',
    'GPT-5.6 Terra',
    'GPT-5.6 Sol',
    'Gemini 3.8 Flash',
    'Claude Sonnet 5',
    'Claude Opus 5',
    'Kimi K3',
    'GLM 5.3',
    'Grok 4.6',
    'Nemotron 3 Ultra',
  ],
  modelMappings: {
    // Source: /rest/models/config/v2, filtering entries to mode === 'search'.
    // Auto is retained only as a backwards-compatible alias of Best.
    'Best': 'turbo',
    'Auto': 'turbo',
    'Sonar 2': 'experimental',
    'GPT-5.6 Terra': 'gpt56_terra',
    'GPT-5.6 Sol': 'gpt56_sol',
    'Gemini 3.8 Flash': 'gemini38flash',
    'Claude Sonnet 5': 'claude50sonnet',
    'Claude Opus 5': 'claude50opus',
    'Kimi K3': 'kimik3thinking',
    'GLM 5.3': 'glm_5_3_thinking',
    'Grok 4.6': 'grok46low',
    'Nemotron 3 Ultra': 'nv_nemotron_3_ultra',
  },
  credentialFields: [
    {
      name: 'sessionToken',
      label: 'Session Token',
      type: 'password',
      required: true,
      placeholder: 'Enter Perplexity session token',
      helpText: 'Session token obtained from Perplexity web version (__Secure-next-auth.session-token cookie)',
    },
  ],
}

export default perplexityConfig
