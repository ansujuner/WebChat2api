import type { BuiltinProviderConfig } from '../../store/types'

export const qwenConfig: BuiltinProviderConfig = {
  id: 'qwen',
  name: 'Qwen',
  type: 'builtin',
  authType: 'tongyi_sso_ticket',
  apiEndpoint: 'https://chat2.qianwen.com',
  chatPath: '/api/v2/chat',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream, text/plain, */*',
    'Origin': 'https://www.qianwen.com',
    'Referer': 'https://www.qianwen.com/',
  },
  enabled: true,
  description: 'Qwen AI assistant (www.qianwen.com); web model catalog verified 2026-09-06',
  supportedModels: [
    'Qwen3.7',
    'Qwen3.8-Max',
    'Qwen3.7-Max',
    'Qwen3.6-Flash',
  ],
  modelMappings: {
    'Qwen3.7': 'Qwen',
    'Qwen3.8-Max': 'Qwen3.8-Max',
    'Qwen3.7-Max': 'Qwen3.7-Max',
    'Qwen3.6-Flash': 'Qwen3.6-Flash',
  },
  credentialFields: [
    {
      name: 'ticket',
      label: 'SSO Ticket',
      type: 'password',
      required: true,
      placeholder: 'Enter tongyi_sso_ticket',
      helpText: 'SSO ticket obtained from www.qianwen.com, found in browser DevTools Application -> Cookies as tongyi_sso_ticket',
    },
  ],
}

export default qwenConfig
