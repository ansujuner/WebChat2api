/** Fixture-only webRequest composition. Never import this from production code.
 * Electron has one onBeforeRequest listener: preserve its normal replacement /
 * removal semantics while keeping an outer, non-removable network isolation gate.
 */
function createSmokeRequestIsolation({ onLoopbackRequest = () => {} } = {}) {
  const sessions = new WeakMap()
  const localSchemes = new Set(['file:', 'about:', 'data:', 'blob:', 'devtools:', 'chrome:', 'chrome-extension:'])
  const matches = (filter, details) => !filter || filter.urls.some(pattern => {
    if (pattern === '<all_urls>') return true
    const expression = '^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
    return new RegExp(expression).test(details.url)
  })

  const install = target => {
    if (sessions.has(target)) return
    const state = { listener: undefined, origins: new Map(), handled: new Set() }
    sessions.set(target, state)
    const original = target.webRequest.onBeforeRequest.bind(target.webRequest)
    // Track registrations made in this disposable Session, not Chromium's
    // built-in HTTPS handler. No local registration means no origin exemption.
    for (const method of ['handle', 'unhandle']) {
      const originalProtocol = target.protocol[method].bind(target.protocol)
      Object.defineProperty(target.protocol, method, { configurable: false, writable: false, value: (scheme, ...args) => {
        if (method === 'unhandle') state.handled.delete(scheme)
        const result = originalProtocol(scheme, ...args)
        if (method === 'handle') state.handled.add(scheme)
        return result
      } })
    }
    const allowed = async value => {
      let url
      try { url = new URL(value) } catch { return false }
      if (localSchemes.has(url.protocol)) return true
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return false
      if (url.hostname === '127.0.0.1') return true
      // A fixture origin is permitted only while a local protocol handler owns
      // that exact origin's scheme. Removing it must never fall through to DNS.
      if (url.protocol !== 'https:' || !state.origins.get(url.origin)?.size || !state.handled.has('https')) return false
      try { return await target.protocol.isProtocolHandled('https') === true } catch { return false }
    }
    const register = (filterOrListener, optionalListener) => {
      const filter = typeof filterOrListener === 'function' || filterOrListener === null ? undefined : filterOrListener
      const listener = filter === undefined ? filterOrListener : optionalListener
      if (listener === null) { state.listener = undefined; return }
      if (typeof listener !== 'function' || (filter && (!Array.isArray(filter.urls) || !filter.urls.length || filter.urls.some(value => typeof value !== 'string')))) {
        throw new Error('Invalid isolated request listener registration')
      }
      state.listener = { filter: filter ? { urls: [...filter.urls] } : undefined, callback: listener }
    }
    Object.defineProperty(target.webRequest, 'onBeforeRequest', { value: register, configurable: false, writable: false })
    original((details, callback) => {
      let completed = false
      const finish = response => { if (!completed) { completed = true; callback(response) } }
      void (async () => {
        if (!await allowed(details.url)) { finish({ cancel: true }); return }
        const url = new URL(details.url)
        if (url.hostname === '127.0.0.1') onLoopbackRequest({ host: url.hostname, port: Number(url.port), path: url.pathname })
        const listener = state.listener
        if (!listener || !matches(listener.filter, details)) { finish({}); return }
        let answered = false
        const next = response => {
          if (answered) return
          answered = true
          void (async () => {
            if (!response || typeof response !== 'object' || response.cancel === true) { finish({ cancel: true }); return }
            // The real listener may queue this callback while changing proxy
            // settings. Recheck a fixture lease and any redirect when released.
            if (!await allowed(details.url) || (response.redirectURL && !await allowed(response.redirectURL))) { finish({ cancel: true }); return }
            finish({ ...response })
          })().catch(() => finish({ cancel: true }))
        }
        try {
          const result = listener.callback(details, next)
          if (result && typeof result.catch === 'function') result.catch(() => finish({ cancel: true }))
        } catch { finish({ cancel: true }) }
      })().catch(() => finish({ cancel: true }))
    })
  }

  const allowFixtureOrigin = (target, origin) => {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('Fixture origin must be an exact HTTPS origin')
    install(target)
    const state = sessions.get(target)
    const lease = {}
    const owners = state.origins.get(origin) || new Set()
    owners.add(lease); state.origins.set(origin, owners)
    return () => { owners.delete(lease); if (!owners.size) state.origins.delete(origin) }
  }
  return { install, allowFixtureOrigin }
}

module.exports = { createSmokeRequestIsolation }
