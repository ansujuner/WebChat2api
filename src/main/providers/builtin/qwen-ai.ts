import type { BuiltinProviderConfig } from '../../store/types'

export const qwenAiConfig: BuiltinProviderConfig = {
  id: 'qwen-ai',
  name: 'Qwen AI (International)',
  type: 'builtin',
  authType: 'jwt',
  apiEndpoint: 'https://chat.qwen.ai',
  chatPath: '/api/v2/chat/completions',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    source: 'web',
  },
  enabled: true,
  description: 'Qwen Studio international web chat (chat.qwen.ai); model catalog verified 2026-09-06',
  modelsApiEndpoint: 'https://chat.qwen.ai/api/models',
  modelsApiHeaders: {
    Accept: 'application/json, text/plain, */*',
    Referer: 'https://chat.qwen.ai/',
    source: 'web',
  },
  supportedModels: [
    'Qwen3.7-Plus',
    'Qwen3.8-Max',
  ],
  modelMappings: {
    'Qwen3.7-Plus': 'qwen3.7-plus',
    'Qwen3.8-Max': 'qwen3.8-max',
  },
  credentialFields: [
    {
      name: 'token',
      label: 'Auth Token',
      type: 'password',
      required: true,
      placeholder: 'Enter JWT token from chat.qwen.ai',
      helpText: 'JWT token obtained from chat.qwen.ai Local Storage (key: "token")',
    },
    {
      name: 'cookies',
      label: 'Cookies (Optional)',
      type: 'textarea',
      required: false,
      placeholder: 'Optional cookies for enhanced compatibility',
      helpText: 'Full cookie string from browser DevTools (optional but recommended)',
    },
  ],
}

export default qwenAiConfig
