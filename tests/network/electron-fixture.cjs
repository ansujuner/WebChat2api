// Standalone Electron runtime fixture. Never loads the application, a website,
// account storage, or a user browser profile; every request targets loopback.
const { app, net, session } = require('electron')
const http = require('node:http')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const axios = require('axios')
const FormData = require('form-data')
const zlib = require('node:zlib')
const root = join(__dirname, '../..')
const cache = join(root, '.audit-cache', `network-fixture-${process.pid}`)
mkdirSync(cache, { recursive: true })
app.setPath('userData', cache)
app.setPath('sessionData', cache)
app.setPath('crashDumps', join(cache, 'crashes'))
function load(file, dependencies) {
  const output = ts.transpileModule(readFileSync(join(root, file), 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText
  const module = { exports: {} }
  vm.runInNewContext(output, { module, exports: module.exports, Buffer, URL, ArrayBuffer, Error, setTimeout, clearTimeout,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name]
      : name === './providerContext.ts' ? require('../../src/main/network/providerContext.ts') : require(name) })
  return module.exports
}
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const bytes = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks) }
let origin, proxy, secondProxy
app.whenReady().then(async () => {
  let hits = 0
  let secondHits = 0, heldResponse
  const proxyPaths = []
  const captures = []
  origin = http.createServer(async (req, res) => {
    const body = await bytes(req)
    captures.push({ path: req.url, headers: req.headers, body })
    if (req.url === '/gzip') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); res.end(zlib.gzipSync('{"compressed":true}')); return }
    if (req.url === '/sse') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: 你好\n\n'); setTimeout(() => res.end('data: [DONE]\n\n'), 20); return }
    if (req.url === '/idle') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: waiting\n\n'); return }
    if (req.url === '/held-scoped') { heldResponse = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: retained\n\n'); return }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'jar=another-account-fixture; Path=/' })
    res.end('{"ok":true}')
  })
  const originPort = await listen(origin)
  proxy = http.createServer((req, res) => {
    hits++
    const target = new URL(req.url)
    proxyPaths.push(target.pathname)
    assert.equal(target.hostname, '127.0.0.1', 'fixture must not leave loopback')
    if (target.pathname === '/proxy-error') { res.destroy(); return }
    const upstream = http.request({ hostname: '127.0.0.1', port: originPort, method: req.method, path: target.pathname + target.search, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res) })
    upstream.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(upstream)
  })
  const proxyPort = await listen(proxy)
  secondProxy = http.createServer((req, res) => {
    secondHits++
    const target = new URL(req.url)
    assert.equal(target.hostname, '127.0.0.1')
    const upstream = http.request({ hostname: '127.0.0.1', port: originPort, method: req.method, path: target.pathname, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res) })
    upstream.on('error', () => { res.writeHead(502); res.end() }); req.pipe(upstream)
  })
  const secondProxyPort = await listen(secondProxy)
  const proxyModule = load('src/main/network/proxy.ts', { electron: { app, session } })
  const { createChromiumAxiosAdapter } = load('src/main/network/transport.ts', { electron: { net }, './proxy': proxyModule })
  const chromiumAxiosAdapter = createChromiumAxiosAdapter(proxyModule.getNetworkSession)
  const client = axios.create({ adapter: chromiumAxiosAdapter, timeout: 3000 })
  const url = `http://127.0.0.1:${originPort}`
  await proxyModule.configureNetworkProxy('none')
  await client.post(`${url}/direct`, { message: '你好' }, { headers: { Cookie: 'account=explicit-fixture', Authorization: 'Bearer explicit-fixture', token: 'custom-fixture' } })
  assert.equal(hits, 0)
  assert.equal(captures[0].headers.cookie, 'account=explicit-fixture', 'explicit per-account Cookie must survive')
  assert.equal(captures[0].headers.authorization, 'Bearer explicit-fixture')
  assert.equal(captures[0].headers.token, 'custom-fixture')
  assert.equal(captures[0].body.toString(), '{"message":"你好"}')
  await client.get(`${url}/no-cookie`)
  assert.equal(captures[1].headers.cookie, undefined, 'shared session cookies must never leak to another account')
  const multipart = new FormData(); multipart.append('file', Buffer.from('fixture\0multipart'), { filename: 'fixture.txt' })
  await client.post(`${url}/upload`, multipart)
  assert.match(captures[2].headers['content-type'], /^multipart\/form-data; boundary=/)
  assert.ok(captures[2].body.includes(Buffer.from('fixture\0multipart')))
  assert.deepEqual((await client.get(`${url}/gzip`)).data, { compressed: true })
  const answer = await client.get(`${url}/sse`, { responseType: 'stream' })
  assert.equal((await bytes(answer.data)).toString(), 'data: 你好\n\ndata: [DONE]\n\n')
  const waiting = await client.get(`${url}/idle`, { responseType: 'stream', timeout: 50 })
  await assert.rejects(bytes(waiting.data), /timed out/)
  await proxyModule.configureNetworkProxy('system')
  const selected = await proxyModule.getNetworkSession()
  // A controlled Chromium proxy avoids modifying or depending on the user's OS.
  await selected.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${proxyPort}`, proxyBypassRules: '<-loopback>' })
  await client.get(`${url}/proxied`)
  assert.equal(hits, 1, 'Chromium selected proxy must carry the API request')
  await proxyModule.configureNetworkProxy('none')
  await client.get(`${url}/direct-again`)
  assert.equal(hits, 1, 'direct mode must not reuse a proxied socket')
  // All providers below share one target host. Only their explicit provider IDs route them.
  const routes = { proxyA: { mode: 'custom', url: `http://127.0.0.1:${proxyPort}` }, directB: { mode: 'none' },
    proxyC: { mode: 'custom', url: `http://127.0.0.1:${secondProxyPort}` } }
  proxyModule.setProviderProxyResolver(id => routes[id], () => 'none')
  await Promise.all([
    proxyModule.withProviderNetwork('proxyA', async () => { await new Promise(resolve => setTimeout(resolve, 10)); await client.get(`${url}/provider-a`) }),
    proxyModule.withProviderNetwork('directB', async () => { await new Promise(resolve => setTimeout(resolve, 2)); await client.get(`${url}/provider-b`) }),
    proxyModule.withProviderNetwork('proxyC', async () => { await client.get(`${url}/provider-c`) }),
  ])
  assert.equal(hits, 2); assert.equal(secondHits, 1)
  assert.ok(proxyPaths.includes('/provider-a')); assert.ok(!proxyPaths.includes('/provider-b'))
  assert.equal((await proxyModule.getNetworkProxyStatus('proxyA', url)).route, 'proxy')
  assert.equal((await proxyModule.getNetworkProxyStatus('directB', url)).route, 'direct')
  const held = await proxyModule.withProviderNetwork('proxyA', () => client.get(`${url}/held-scoped`, { responseType: 'stream' }))
  const heldBody = bytes(held.data)
  routes.proxyA = { mode: 'none' }
  await proxyModule.withProviderNetwork('proxyA', () => client.get(`${url}/provider-a-now-direct`))
  assert.equal(hits, 3, 'changed mode applies to new requests without reusing the proxy')
  heldResponse.end('data: [DONE]\n\n')
  assert.equal((await heldBody).toString(), 'data: retained\n\ndata: [DONE]\n\n', 'route changes must not abort an old stream')
  routes.proxyA = { mode: 'custom', url: `http://127.0.0.1:${secondProxyPort}` }
  await proxyModule.withProviderNetwork('proxyA', () => client.get(`${url}/provider-a-new-proxy`))
  assert.equal(secondHits, 2, 'custom URL changes select a new route, not the old proxy pool')
  const beforeFailure = captures.length
  routes.proxyA = { mode: 'custom', url: `http://127.0.0.1:${proxyPort}` }
  await assert.rejects(proxyModule.withProviderNetwork('proxyA', () => client.get(`${url}/proxy-error`)))
  assert.equal(captures.length, beforeFailure, 'failed explicit proxy must never fall back to direct')
  assert.ok(captures.filter(capture => /provider-/.test(capture.path)).every(capture => !capture.headers.cookie), 'provider pools do not import another account cookie jar')
  // Exercise the same owned-session controller used by Z.ai, including real
  // Chromium webRequest events and keepalive sockets. No website is loaded.
  const { OwnedSessionProxy } = load('src/main/network/sessionProxy.ts', { './proxy': proxyModule })
  const browserSession = session.fromPartition(`network-owned-fixture-${process.pid}`)
  const browserProxy = new OwnedSessionProxy(browserSession)
  const browserClient = axios.create({ adapter: createChromiumAxiosAdapter(async () => browserSession), timeout: 3000 })
  await browserProxy.apply({ mode: 'none' })
  await browserClient.get(`${url}/owned-keepalive-direct`)
  await new Promise(resolve => setTimeout(resolve, 20))
  const beforeOwnedProxy = hits
  await browserProxy.apply({ mode: 'custom', url: `http://127.0.0.1:${proxyPort}` })
  await browserClient.get(`${url}/owned-keepalive-proxy`)
  assert.equal(hits, beforeOwnedProxy + 1, 'same owned session retires the direct keepalive pool before using its proxy')
  await new Promise(resolve => setTimeout(resolve, 20))
  const activeBrowserStream = await browserClient.get(`${url}/held-scoped`, { responseType: 'stream' })
  const activeBrowserBody = bytes(activeBrowserStream.data)
  await assert.rejects(browserProxy.apply({ mode: 'none' }), error => error.code === 'busy')
  assert.equal(activeBrowserStream.data.destroyed, false, 'a manual webpage stream is not interrupted to change settings')
  heldResponse.end('data: [DONE]\n\n')
  assert.equal((await activeBrowserBody).toString(), 'data: retained\n\ndata: [DONE]\n\n')
  await new Promise(resolve => setTimeout(resolve, 20))
  const beforeOwnedDirect = hits
  await browserProxy.apply({ mode: 'none' })
  await browserClient.get(`${url}/owned-keepalive-direct-again`)
  assert.equal(hits, beforeOwnedDirect, 'old proxy keepalive socket is not reused after switching back to direct')
  browserProxy.dispose()
  // Hold only the setter's completion to force a real Chromium request into the
  // switching gap. It must wait, then continue once under the requested proxy.
  let releaseProxy, enteredProxy
  const proxyEntered = new Promise(resolve => { enteredProxy = resolve })
  const proxyReleased = new Promise(resolve => { releaseProxy = resolve })
  const queuedModule = load('src/main/network/sessionProxy.ts', { './proxy': {
    async applyProxyToSession(...args) { await proxyModule.applyProxyToSession(...args); enteredProxy(); await proxyReleased },
  } })
  const queuedSession = session.fromPartition(`network-queued-fixture-${process.pid}`)
  const queuedController = new queuedModule.OwnedSessionProxy(queuedSession)
  const queuedClient = axios.create({ adapter: createChromiumAxiosAdapter(async () => queuedSession), timeout: 3000 })
  const switching = queuedController.apply({ mode: 'custom', url: `http://127.0.0.1:${proxyPort}` })
  await proxyEntered
  const beforeQueued = hits
  const queuedRequest = queuedClient.get(`${url}/owned-queued-request`)
  for (let attempts = 0; queuedController.queued.size === 0 && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(queuedController.queued.size, 1, 'real onBeforeRequest must pause a request during configuration')
  assert.equal(hits, beforeQueued)
  releaseProxy(); await switching; await queuedRequest
  assert.equal(hits, beforeQueued + 1, 'queued request uses new proxy exactly once')
  queuedController.dispose()
  const report = { success: true, electron: process.versions.electron, chrome: process.versions.chrome,
    checks: ['explicit cookies and auth', 'no cookie jar bleed', 'multipart upload', 'gzip decoding', 'SSE UTF-8', 'stream timeout', 'Chromium proxy route', 'direct mode route',
      'same-host concurrent provider routing', 'two independent spy proxies', 'provider proxy status', 'mode change preserves active stream', 'custom URL change', 'no direct fallback', 'no cross-provider cookie jar',
      'owned-session direct keepalive to proxy', 'manual webpage SSE blocks proxy edits without interruption', 'owned-session proxy keepalive to direct', 'request waits through proxy switch then sends once'] }
  writeFileSync(join(root, 'artifacts', 'network-electron-runtime.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  origin.closeAllConnections(); proxy.closeAllConnections(); secondProxy.closeAllConnections(); origin.close(); proxy.close(); secondProxy.close()
  app.exit(0)
}).catch(error => {
  console.error(error.message)
  origin?.closeAllConnections(); proxy?.closeAllConnections(); secondProxy?.closeAllConnections(); origin?.close(); proxy?.close(); secondProxy?.close()
  app.exit(1)
})
