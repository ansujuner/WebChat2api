import type { BuiltinProviderConfig } from '../../store/types'

export const arenaConfig: BuiltinProviderConfig = {
  id: 'arena', name: 'Arena', type: 'builtin', authType: 'oauth',
  apiEndpoint: 'https://arena.ai', headers: {}, enabled: true,
  description: 'Arena text and image models through an isolated signed browser. Sign in to discover the current account model catalog.',
  // A public model snapshot is not proof of account availability; populate only after runtime discovery.
  supportedModels: [], modelMappings: {},
  credentialFields: [{ name: 'browserProfileId', label: 'Isolated browser account', type: 'text', required: true,
    helpText: 'Created by browser login. Only this app-owned profile identifier is stored; no browser token is exported.' }],
}
export default arenaConfig
