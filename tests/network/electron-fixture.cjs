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
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name) })
  return module.exports
}
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port }
const bytes = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks) }
let origin, proxy
app.whenReady().then(async () => {
  let hits = 0
  const captures = []
  origin = http.createServer(async (req, res) => {
    const body = await bytes(req)
    captures.push({ path: req.url, headers: req.headers, body })
    if (req.url === '/gzip') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }); res.end(zlib.gzipSync('{"compressed":true}')); return }
    if (req.url === '/sse') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: 你好\n\n'); setTimeout(() => res.end('data: [DONE]\n\n'), 20); return }
    if (req.url === '/idle') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: waiting\n\n'); return }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'jar=another-account-fixture; Path=/' })
    res.end('{"ok":true}')
  })
  const originPort = await listen(origin)
  proxy = http.createServer((req, res) => {
    hits++
    const target = new URL(req.url)
    assert.equal(target.hostname, '127.0.0.1', 'fixture must not leave loopback')
    const upstream = http.request({ hostname: '127.0.0.1', port: originPort, method: req.method, path: target.pathname + target.search, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res) })
    upstream.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(upstream)
  })
  const proxyPort = await listen(proxy)
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
  const report = { success: true, electron: process.versions.electron, chrome: process.versions.chrome,
    checks: ['explicit cookies and auth', 'no cookie jar bleed', 'multipart upload', 'gzip decoding', 'SSE UTF-8', 'stream timeout', 'Chromium proxy route', 'direct mode route'] }
  writeFileSync(join(root, 'artifacts', 'network-electron-runtime.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  origin.closeAllConnections(); proxy.closeAllConnections(); origin.close(); proxy.close()
  app.exit(0)
}).catch(error => {
  console.error(error.message)
  origin?.closeAllConnections(); proxy?.closeAllConnections(); origin?.close(); proxy?.close()
  app.exit(1)
})
