import { configureNetworkProxy } from './proxy'

type Mode = 'system' | 'none'

function modeOf(value: unknown): Mode {
  if (value !== 'system' && value !== 'none') throw new Error('Invalid network proxy mode')
  return value
}

/** Serialize configuration writes and apply the network setting before reporting success. */
export function createNetworkConfigUpdater(apply: (mode: Mode) => Promise<void>) {
  let queue: Promise<unknown> = Promise.resolve()
  return function update<T>(
    updates: { oauthProxyMode?: unknown },
    readMode: () => unknown,
    persist: () => T,
  ): Promise<T> {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return Promise.reject(new Error('Configuration must be an object'))
    }
    const changesMode = Object.prototype.hasOwnProperty.call(updates, 'oauthProxyMode')
    let requested: Mode | undefined
    try {
      requested = changesMode ? modeOf(updates.oauthProxyMode) : undefined
    } catch (error) {
      return Promise.reject(error)
    }
    const result = queue.then(async () => {
      if (!requested) return persist()
      const previous = modeOf(readMode() ?? 'system')
      await apply(requested)
      try {
        return persist()
      } catch (error) {
        try {
          await apply(previous)
        } catch {
          throw new Error('Could not save or restore network proxy settings. Restart the application before sending more requests.')
        }
        throw error
      }
    })
    // The caller receives the rejection; later saves must still be able to recover.
    queue = result.catch(() => undefined)
    return result
  }
}

export const updateNetworkConfiguration = createNetworkConfigUpdater(configureNetworkProxy)
