const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { Writable, PassThrough, Readable } = require('node:stream')
const ts = require('typescript')
const axios = require('axios')

const root = join(__dirname, '../..')
function load(file, dependencies = {}) {
  const source = ts.transpileModule(readFileSync(join(root, file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(source, { module, exports: module.exports, Buffer, URL, ArrayBuffer, Error, setTimeout, clearTimeout,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name) })
  return module.exports
}
function harness(reply, options = {}) {
  const selectedSession = { fixture: true }
  const sent = []
  const { createChromiumAxiosAdapter } = load('src/main/network/transport.ts', {
    electron: { net: { request() { throw new Error('injected request required') } } },
    './proxy': { getNetworkSession: async () => selectedSession },
  })
  function makeRequest(config) {
    let chunks = []
    const request = new Writable({ autoDestroy: false, write(chunk, _enc, callback) { chunks.push(Buffer.from(chunk)); callback() } })
    request.options = config
    request.headers = {}
    request.setHeader = (name, value) => { request.headers[name.toLowerCase()] = value }
    request.abort = () => { request.aborted = true; request.emit('abort'); request.emit('close') }
    request.followRedirect = () => { request.followed = true }
    request.on('finish', () => {
      request.body = Buffer.concat(chunks)
      queueMicrotask(() => reply?.(request))
    })
    sent.push(request)
    return request
  }
  const adapter = createChromiumAxiosAdapter(async () => {
    if (options.setupFailure) throw new Error('configuration failed')
    return selectedSession
  }, makeRequest)
  return { client: axios.create({ adapter }), sent, adapter, selectedSession }
}
function respond(request, body, options = {}) {
  const incoming = new PassThrough()
  incoming.statusCode = options.status || 200
  incoming.statusMessage = options.status ? 'Fixture error' : 'OK'
  incoming.headers = options.headers || { 'content-type': 'application/json' }
  request.incoming = incoming
  request.emit('response', incoming)
  if (body !== undefined) incoming.end(body)
  return incoming
}
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks) }

test('Chromium adapter preserves Axios JSON, params, explicit per-account auth and cookie headers', async () => {
  const { client, sent, selectedSession } = harness(request => respond(request, '{"answer":"你好"}'))
  const original = { Authorization: 'Bearer fixture-only', Cookie: 'account=fixture', 'Content-Length': '999', 'Accept-Encoding': 'gzip' }
  const response = await client.post('https://fixture.invalid/ask', { input: '你好' }, { params: { q: 'two words' }, headers: original })
  assert.deepEqual(response.data, { answer: '你好' })
  assert.equal(sent[0].options.session, selectedSession)
  assert.equal(sent[0].options.useSessionCookies, false)
  assert.equal(sent[0].options.credentials, 'omit')
  assert.equal(sent[0].options.cache, 'no-store')
  assert.equal(sent[0].options.url, 'https://fixture.invalid/ask?q=two+words')
  assert.equal(sent[0].headers.cookie, 'account=fixture')
  assert.equal(sent[0].headers.authorization, 'Bearer fixture-only')
  assert.equal(sent[0].headers['content-length'], undefined)
  assert.equal(sent[0].headers['accept-encoding'], undefined)
  assert.equal(original['Content-Length'], '999')
  assert.equal(sent[0].body.toString(), '{"input":"你好"}')
})

test('returns stream at headers and retains cancellation after promise resolves', async () => {
  const { client, sent } = harness(request => { respond(request); request.incoming.write('data: one\n\n') })
  const response = await client.get('https://fixture.invalid/sse', { responseType: 'stream' })
  assert.equal(response.data.read().toString(), 'data: one\n\n')
  response.data.destroy()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sent[0].aborted, true)
})

test('stream roundtrip keeps UTF-8 bytes and never buffers complete generations', async () => {
  const { client } = harness(request => respond(request, Buffer.from('data: 中文🙂\n\n')))
  const response = await client.get('https://fixture.invalid/sse', { responseType: 'stream' })
  assert.equal((await collect(response.data)).toString(), 'data: 中文🙂\n\n')
})

test('Electron 44 upload close is not mistaken for response EOF', async () => {
  const { client } = harness(request => {
    request.emit('close')
    setImmediate(() => respond(request, '{"ok":true}'))
  })
  assert.deepEqual((await client.get('https://fixture.invalid/')).data, { ok: true })
})

test('native response close without end rejects truncated JSON and streams', async () => {
  for (const responseType of ['json', 'stream']) {
    const { client } = harness(request => {
      const incoming = respond(request)
      incoming.write('partial')
      setImmediate(() => incoming.destroy())
    })
    const task = client.get('https://fixture.invalid/', { responseType })
    if (responseType === 'stream') await assert.rejects(collect((await task).data), /ended prematurely/)
    else await assert.rejects(task, /ended prematurely/)
  }
})

test('legacy Axios cancel token cancels without retry', async () => {
  const token = axios.CancelToken.source()
  const { client, sent } = harness(() => token.cancel('fixture cancellation'))
  await assert.rejects(client.get('https://fixture.invalid/', { cancelToken: token.token }), error => axios.isCancel(error))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].aborted, true)
})

test('nonstream errors retain Axios status and transformed response body', async () => {
  const { client } = harness(request => respond(request, '{"error":"fixture"}', { status: 429 }))
  await assert.rejects(client.get('https://fixture.invalid/'), error => error.response.status === 429 && error.response.data.error === 'fixture')
})

test('arraybuffer response preserves exact binary bytes', async () => {
  const bytes = Buffer.from([0, 255, 1, 2])
  const { client } = harness(request => respond(request, bytes))
  const result = await client.get('https://fixture.invalid/file', { responseType: 'arraybuffer' })
  assert.deepEqual(result.data, bytes)
})

test('FormData upload keeps multipart boundary and bytes through Chromium stream', async () => {
  const FormData = require('form-data')
  const data = new FormData(); data.append('file', Buffer.from('fixture\0data'), { filename: 'fixture.txt' })
  const { client, sent } = harness(request => respond(request, '{}'))
  await client.post('https://fixture.invalid/upload', data)
  assert.match(sent[0].headers['content-type'], /^multipart\/form-data; boundary=/)
  assert.equal(sent[0].chunkedEncoding, true)
  assert.match(sent[0].body.toString(), /filename="fixture.txt"/)
  assert.ok(sent[0].body.includes(Buffer.from('fixture\0data')))
})

for (const stream of [false, true]) {
  test(`timeout cancels native ${stream ? 'stream' : 'pending'} request without retry`, async () => {
    const { client, sent } = harness(request => { if (stream) respond(request) })
    const task = client.get('https://fixture.invalid/', { timeout: 20, ...(stream ? { responseType: 'stream' } : {}) })
    if (stream) await assert.rejects(collect((await task).data), /timed out/)
    else await assert.rejects(task, /timed out/)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].aborted, true)
  })
}

test('active streaming responses reset the idle timeout instead of timing out long answers', async () => {
  const { client } = harness(request => {
    const response = respond(request)
    let count = 0
    const interval = setInterval(() => {
      response.write('active')
      if (++count === 5) { clearInterval(interval); response.end() }
    }, 12)
  })
  const response = await client.get('https://fixture.invalid/', { responseType: 'stream', timeout: 35 })
  assert.equal((await collect(response.data)).toString(), 'active'.repeat(5))
})

test('AbortSignal cancels an active native request', async () => {
  const controller = new AbortController()
  const { client, sent } = harness(() => controller.abort())
  await assert.rejects(client.get('https://fixture.invalid/', { signal: controller.signal }), error => axios.isCancel(error))
  assert.equal(sent[0].aborted, true)
})

test('already-canceled request never reaches the network', async () => {
  const controller = new AbortController(); controller.abort()
  const { client, sent } = harness()
  await assert.rejects(client.get('https://fixture.invalid/', { signal: controller.signal }), error => axios.isCancel(error))
  assert.equal(sent.length, 0)
})

test('response and upload byte limits fail instead of truncating', async () => {
  const { client, sent } = harness(request => respond(request, '0123456789'))
  await assert.rejects(client.get('https://fixture.invalid/', { maxContentLength: 5 }), /maxContentLength/)
  await assert.rejects(client.post('https://fixture.invalid/', 'abcdef', { maxBodyLength: 5 }), /maxBodyLength/)
  await assert.rejects(client.post('https://fixture.invalid/', Readable.from(['abcdef']), { maxBodyLength: 5 }), /maxBodyLength/)
  assert.equal(sent.length, 2)
})

test('proxy failure is surfaced once without direct fallback or exposing native query secrets', async () => {
  const { client, sent } = harness(request => request.emit('error', new Error('net::ERR_PROXY_CONNECTION_FAILED https://fixture.invalid/?token=private')))
  await assert.rejects(client.get('https://fixture.invalid/'), error => error.code === 'ERR_PROXY_CONNECTION_FAILED' && !error.message.includes('private'))
  assert.equal(sent.length, 1)
})

test('cross-origin redirects cannot forward account-specific credentials', async () => {
  const { client, sent } = harness(request => request.emit('redirect', 302, 'GET', 'https://elsewhere.invalid/', {}))
  await assert.rejects(client.get('https://fixture.invalid/', { headers: { token: 'fixture' } }), /Redirect blocked/)
  assert.equal(sent[0].followed, undefined)
  assert.equal(sent[0].aborted, true)
})

test('same-origin redirect follows once and respects configured limit', async () => {
  const { client, sent } = harness(request => { request.emit('redirect', 302, 'GET', 'https://fixture.invalid/next', {}); respond(request, '{}') })
  await client.get('https://fixture.invalid/')
  assert.equal(sent[0].followed, true)
  const zero = harness(request => request.emit('redirect', 302, 'GET', 'https://fixture.invalid/next', {}))
  await assert.rejects(zero.client.get('https://fixture.invalid/', { maxRedirects: 0 }), /Redirect blocked/)
})

test('uninitialized/failed configuration cannot issue a request', async () => {
  const { client, sent } = harness(undefined, { setupFailure: true })
  await assert.rejects(client.get('https://fixture.invalid/'), /configuration failed/)
  assert.equal(sent.length, 0)
})

test('disallows Node transport overrides, local files and URL credentials', async () => {
  const { client, sent } = harness()
  for (const url of ['file:///fixture', 'https://name:password@fixture.invalid/']) await assert.rejects(client.get(url), /Only HTTP/)
  await assert.rejects(client.get('https://fixture.invalid/', { proxy: { host: 'localhost', port: 999 } }), /overrides/)
  assert.equal(sent.length, 0)
})

test('bootstrap is the first main import and existing axios.create instances inherit Chromium adapter', () => {
  const main = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  assert.match(main.match(/^import\s+.*$/m)?.[0] || '', /['"]\.\/network\/bootstrap['"]/) 
  const stub = { defaults: {} }
  const adapter = () => {}
  load('src/main/network/bootstrap.ts', { axios: { default: stub }, './transport': { chromiumAxiosAdapter: adapter } })
  const inherited = axios.create({ adapter: stub.defaults.adapter })
  assert.equal(inherited.defaults.adapter, adapter)
})

test('proxy configuration applies system and direct explicitly; failures retain prior session and active streams', async () => {
  const sessions = []
  let rejectNext = false
  const { configureNetworkProxy, getNetworkSession, getNetworkProxyStatus, applyProxyToSession } = load('src/main/network/proxy.ts', {
    electron: { app: { whenReady: async () => {} }, session: { fromPartition: (name, options) => {
      const entry = { name, options, events: [], async setProxy(config) { this.events.push(['proxy', config]); if (rejectNext) { rejectNext = false; throw new Error('fixture proxy failure') } }, async closeAllConnections() { this.events.push(['closed']) }, resolveProxy: async () => 'PROXY private-host:123; DIRECT' }
      sessions.push(entry); return entry
    } } },
  })
  await assert.rejects(getNetworkSession(), /not initialized/)
  await configureNetworkProxy('system')
  const first = await getNetworkSession()
  assert.deepEqual(JSON.parse(JSON.stringify(first.events)), [['proxy', { mode: 'system' }], ['closed']])
  assert.ok(!first.name.startsWith('persist:'))
  const status = await getNetworkProxyStatus()
  assert.deepEqual(JSON.parse(JSON.stringify(status)), { mode: 'system', route: 'proxy' })
  assert.ok(!JSON.stringify(status).includes('private-host'))
  await configureNetworkProxy('none')
  assert.notEqual(await getNetworkSession(), first)
  assert.deepEqual(JSON.parse(JSON.stringify(sessions[1].events)), [['proxy', { mode: 'direct' }], ['closed']])
  assert.equal(first.events.length, 2, 'mode change must not close active old streams')
  rejectNext = true
  await assert.rejects(configureNetworkProxy('system'), /fixture proxy failure/)
  assert.equal(await getNetworkSession(), sessions[1])
  await assert.rejects(applyProxyToSession(first, 'anything'), /system or none/)
})
