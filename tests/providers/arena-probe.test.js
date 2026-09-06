const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.join(__dirname, '../..')
const plain = value => JSON.parse(JSON.stringify(value))
const secret = 'fixture-secret-never-in-arena-report'
const profileId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const sessionId = 'c2a-12345678-abcd-4abc-8abc-123456789abc'
const models = ['arena/text/max', 'arena/image/max']
function fixture(options = {}) {
  const calls = [], saved = [], reports = []
  const accounts = options.accounts ?? (options.fresh ? [] : [{ status: 'active', providerId: 'arena', credentials: { browserProfileId: profileId }, name: 'saved@example.test', ...options.account }])
  let marker = '', finishLogin, loginStarts = 0, cancelled = 0, waited = 0
  const login = new Promise(resolve => { finishLogin = resolve })
  const success = { success: true, credentials: { browserProfileId: profileId }, accountInfo: { email: 'untrusted-oauth-label@example.test' } }
  const config = { proxyPort: 8080, enableApiKey: true, apiKeys: [{ enabled: true, key: secret }], modelMappings: options.mappings || {} }
  const dependencies = {
    '../../shared/accountAvailability': require('../../src/shared/accountAvailability.ts'),
    '../oauth/manager': { oauthManager: {
      isInAppLoginOpen: () => options.busy || false,
      startInAppLogin(...args) { loginStarts++; calls.push({ type: 'login', args }); if (!options.pending) finishLogin(options.result || success); return login },
      cancelInAppLogin() { cancelled++; finishLogin({ success: false }) },
    } },
    '../arena/browserManager': { arenaBrowserManager: {
      async status(id) { assert.equal(id, profileId); calls.push({ type: 'status' }); return { authenticated: options.authenticated !== false, accountInfo: { email: 'verified@example.test' }, ...(options.statusErrorCode ? { errorCode: options.statusErrorCode } : {}) } },
      async cancelAndWait() { waited++ },
    } },
    '../arena/protocol': {
      ArenaError: class extends Error { constructor(code) { super('static-safe-' + code); this.code = code } },
      arenaImageUrl(value) { if (typeof value !== 'string' || !value.startsWith('https://cdn.arena.ai/')) throw Error(secret); return value },
    },
    '../store/accounts': { AccountManager: {
      getByProviderId(provider, includeCredentials) { assert.equal(provider, 'arena'); assert.equal(includeCredentials, true); return accounts },
      create(data) { saved.push(plain(data)); return data },
    } },
    '../store/store': { storeManager: {
      getConfig: () => ({ ...config, ...(options.noKey ? { apiKeys: [] } : {}) }),
      getProviderById(id) { assert.equal(id, 'arena'); return { id, name: 'Arena', enabled: !options.disabled } },
    } },
    '../providers/arenaCatalog': { arenaProfileCredentials(value) { assert.deepEqual(plain(value), { browserProfileId: profileId }); return { browserProfileId: profileId } } },
    '../providers/arenaIntegration': { async syncArenaProviderModels(id) {
      assert.equal(id, profileId); calls.push({ type: 'catalog' }); if (options.catalogError) throw Error(secret)
      if (options.catalogQuotaError) throw new dependencies['../arena/protocol'].ArenaError('quota_unavailable')
      if (options.catalogRouteError) throw new dependencies['../arena/protocol'].ArenaError('route_changed')
      return { supportedModels: models, modelMappings: {} }
    } },
    '../proxy/server': { proxyServer: { isRunning: () => !options.stopped } },
    '../proxy/status': { proxyStatusManager: { getPort: () => 8081, getHost: () => options.host || '0.0.0.0' } },
    './localProbe': { async requestLoopback(request) {
      calls.push({ type: 'http', request: plain(request) })
      assert.ok(['127.0.0.1', '::1'].includes(request.hostname))
      assert.equal(request.port, 8081)
      const response = (value, status = 200, headers = {}) => ({ status, headers, text: JSON.stringify(value) })
      if (request.path === '/health') { assert.deepEqual(plain(request.headers), {}); return response({ status: 'running' }) }
      assert.equal(request.headers.Authorization, 'Bearer ' + secret)
      if (request.path === '/v1/models') return response({ data: models.map(id => ({ id, owned_by: options.wrongOwner ? 'Other' : 'Arena' })) })
      if (options.transportFailure) throw Error(secret)
      if (options.actionRequired) return response({ error: { code: 'action_required', message: secret } }, 409)
      if (options.generationError && (!options.errorPath || request.path === options.errorPath)) {
        return response({ error: { code: options.generationError.code, message: options.generationError.message ?? secret } }, options.generationError.status)
      }
      if (request.path === '/v1/chat/completions') {
        assert.equal(request.maxResponseBytes, undefined)
        const prompt = request.body.messages[0].content
        assert.equal(request.body.messages.length, 1)
        const first = request.headers['X-Chat2API-New-Conversation'] === 'true'
        if (first) marker = prompt.split('：').at(-1)
        else {
          assert.equal(request.headers['X-Chat2API-Session-ID'], sessionId)
          assert.doesNotMatch(prompt, /ARENA_SMOKE_/)
        }
        return response({ choices: [{ message: { role: 'assistant', content: options.wrongReply ? secret : marker }, finish_reason: 'stop' }] }, 200,
          options.noContinuation ? {} : { 'x-chat2api-session-id': sessionId, 'x-chat2api-conversation': first ? 'new' : 'continued' })
      }
      assert.equal(request.path, '/v1/images/generations')
      assert.equal(request.maxResponseBytes, 48 * 1024 * 1024)
      assert.equal(request.body.model, 'arena/image/max')
      return response({ data: [{ url: options.invalidImage ? secret : 'https://cdn.arena.ai/secret-signed-url.png' }] })
    } },
  }
  const module = { exports: {} }, fileName = path.join(root, 'src/main/diagnostics/arenaProbe.ts')
  vm.runInNewContext(ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module, exports: module.exports, console: new Proxy({}, { get: () => () => { throw Error('No probe logging') } }),
    require(name) { if (name === 'node:crypto') return require(name); assert.ok(Object.hasOwn(dependencies, name), `Unmocked dependency ${name}`); return dependencies[name] },
  }, { filename: fileName })
  const safe = report => {
    assert.doesNotMatch(JSON.stringify(report), /fixture-secret|secret-signed-url|browserProfileId|credentials|@example|aaaaaaa|ARENA_SMOKE_|c2a-123456/)
    return plain(report)
  }
  return { calls, saved, reports, safe, finishLogin, get cancelled() { return cancelled }, get waited() { return waited }, get loginStarts() { return loginStarts },
    login: async () => safe(await module.exports.runArenaLoginProbe(async report => { reports.push(safe(report)); if (options.progressError) throw Error(secret) })),
    live: async () => safe(await module.exports.runArenaProbe()),
  }
}

test('Arena login reuses an existing verified active profile and synchronizes runtime models without another account', async () => {
  const f = fixture(), report = await f.login()
  assert.equal(report.status, 'passed')
  assert.equal(report.live, false)
  assert.equal(report.accountVerified, true)
  assert.deepEqual(report.models, models)
  assert.equal(f.loginStarts, 0)
  assert.equal(f.saved.length, 0)
  assert.deepEqual(f.calls.map(call => call.type), ['status', 'catalog'])
})

test('Arena new login reports awaiting_login, validates owned profile, and creates exactly one auto-email account', async () => {
  const f = fixture({ fresh: true }), report = await f.login()
  assert.equal(report.status, 'passed')
  assert.deepEqual(f.reports.map(report => report.status), ['awaiting_login'])
  assert.equal(f.loginStarts, 1)
  assert.deepEqual(f.calls[0].args, ['arena', 'arena', 600000])
  assert.deepEqual(f.saved, [{ providerId: 'arena', nameSource: 'auto', email: 'verified@example.test', credentials: { browserProfileId: profileId } }])
  assert.equal(f.cancelled, 0)
})

test('Arena login does not save failed/unverified/busy accounts or expose raw catalog errors', async () => {
  for (const [options, expected] of [[{ fresh: true, result: { success: false, error: secret } }, 'login_not_completed'],
    [{ fresh: true, authenticated: false }, 'action_required'], [{ busy: true }, 'login_busy'], [{ catalogError: true }, 'login_not_completed']]) {
    const f = fixture(options)
    assert.equal((await f.login()).status, expected)
    assert.equal(f.saved.length, 0)
    assert.equal(f.calls.filter(call => call.type === 'http').length, 0)
  }
})

test('Arena login progress-write failure cancels and awaits pending login without saving anything', async () => {
  const f = fixture({ fresh: true, pending: true, progressError: true })
  assert.equal((await f.login()).status, 'login_not_completed')
  assert.equal(f.cancelled, 1)
  assert.equal(f.waited, 1)
  assert.equal(f.saved.length, 0)
})

test('Arena live probe uses actual port/key and sends only two current-delta text turns plus one image', async () => {
  const f = fixture(), report = await f.live()
  assert.equal(report.status, 'passed')
  assert.equal(report.port, 8081)
  assert.equal(report.accountVerified, true)
  assert.deepEqual(report.checks.map(check => check.stage), ['text_first', 'text_continuation', 'image'])
  assert.equal(report.checks[1].continued, true)
  assert.equal(report.checks[2].imageReturned, true)
  assert.equal(f.calls.filter(call => call.type === 'http').length, 5)
  assert.equal(f.saved.length, 0)
  assert.equal(f.loginStarts, 0)
})

test('Arena live protection failure stops after its single submitted request, without retry or image follow-on', async () => {
  const f = fixture({ actionRequired: true }), report = await f.live()
  assert.equal(report.status, 'action_required')
  assert.equal(report.checks.length, 1)
  assert.equal(report.checks[0].error, 'action_required')
  assert.equal(f.calls.filter(call => call.type === 'http' && call.request.body).length, 1)
})

test('Arena live preflight requires current authentication, gateway key, enabled provider and advertised owner', async () => {
  for (const [options, expected] of [[{ stopped: true }, 'proxy_not_running'], [{ host: '192.168.1.2' }, 'non_loopback_bind_not_probed'],
    [{ noKey: true }, 'no_enabled_gateway_api_key'], [{ disabled: true }, 'provider_not_enabled'], [{ fresh: true }, 'login_required'],
    [{ authenticated: false }, 'action_required'], [{ wrongOwner: true }, 'no_advertised_text_and_image_models'],
    [{ mappings: { 'arena/text/max': { preferredProviderId: 'other' } } }, 'no_advertised_text_and_image_models']]) {
    const f = fixture(options)
    assert.equal((await f.live()).status, expected)
    assert.equal(f.calls.filter(call => call.type === 'http' && call.request.body).length, 0)
  }
})

test('Arena live incomplete continuity, unexpected reply and connection loss never trigger additional generations', async () => {
  for (const options of [{ wrongReply: true }, { noContinuation: true }, { transportFailure: true }]) {
    const f = fixture(options), report = await f.live()
    assert.notEqual(report.status, 'passed')
    assert.equal(f.calls.filter(call => call.type === 'http' && call.request.body).length, 1)
  }
  const f = fixture({ invalidImage: true }), report = await f.live()
  assert.equal(report.status, 'image_check_failed')
  assert.equal(report.checks.at(-1).imageReturned, false)
})

test('Arena live probe does not inspect or submit from disabled, cooling, expired or daily-limited accounts', async () => {
  for (const account of [{ enabled: false }, { cooldownUntil: Date.now() + 600000 },
    { cooldownReason: 'temporary_ban' }, { status: 'expired' }, { status: 'inactive' }, { status: 'error' },
    { dailyLimit: 5, todayUsed: 5 }]) {
    const f = fixture({ account }), report = await f.live()
    assert.equal(report.status, 'no_available_account')
    assert.equal(report.accountVerified, false)
    assert.deepEqual(report.checks, [])
    assert.deepEqual(f.calls, [])
    assert.equal(f.loginStarts, 0)
  }
})

test('Arena live probe skips a paused first account and accepts expired cooldown without changing state', async () => {
  const accounts = [{ status: 'active', enabled: false, credentials: { browserProfileId: 'must-not-be-inspected' } },
    { status: 'active', cooldownReason: 'temporary_ban', cooldownUntil: Date.now() - 1000, credentials: { browserProfileId: profileId } }]
  const before = JSON.stringify(accounts), f = fixture({ accounts })
  assert.equal((await f.live()).status, 'passed')
  assert.equal(JSON.stringify(accounts), before)
  assert.equal(f.saved.length, 0)
})

test('Explicit Arena login may check a paused account without enabling it or submitting generation', async () => {
  const account = { status: 'active', enabled: false, cooldownUntil: Date.now() + 600000, credentials: { browserProfileId: profileId } }
  const before = JSON.stringify(account), f = fixture({ accounts: [account] })
  assert.equal((await f.login()).status, 'passed')
  assert.equal(JSON.stringify(account), before)
  assert.deepEqual(f.calls.map(call => call.type), ['status', 'catalog'])
  assert.equal(f.saved.length, 0); assert.equal(f.loginStarts, 0)
})

test('Arena text probe reports every429 as rate_limited and quota503 as quota_unavailable without retries', async () => {
  for (const [generationError, expected] of [
    [{ status: 429, code: 'rate_limited' }, 'rate_limited'],
    [{ status: 429, code: 'model_rate_limited' }, 'rate_limited'],
    [{ status: 429, code: 'action_required' }, 'rate_limited'],
    [{ status: 429 }, 'rate_limited'],
    [{ status: 503, code: 'quota_unavailable' }, 'quota_unavailable'],
    [{ status: 503, message: 'static-safe-quota_unavailable' }, 'quota_unavailable'],
    [{ status: 503, code: 'no_available_account' }, 'text_check_failed'],
  ]) {
    const f = fixture({ generationError }), report = await f.live()
    assert.equal(report.status, expected)
    assert.equal(report.checks.length, 1)
    if (expected !== 'text_check_failed') assert.equal(report.checks[0].error, expected)
    assert.equal(f.calls.filter(call => call.type === 'http' && call.request.body).length, 1)
  }
})

test('Arena image probe preserves rate-limit and quota-storage failure categories after two text turns', async () => {
  for (const [generationError, expected] of [
    [{ status: 429, code: 'model_rate_limited' }, 'rate_limited'],
    [{ status: 503, code: 'quota_unavailable' }, 'quota_unavailable'],
  ]) {
    const f = fixture({ generationError, errorPath: '/v1/images/generations' }), report = await f.live()
    assert.equal(report.status, expected)
    assert.equal(report.checks.length, 3)
    assert.equal(report.checks[2].stage, 'image')
    assert.equal(report.checks[2].error, expected)
    assert.equal(f.calls.filter(call => call.type === 'http' && call.request.body).length, 3)
  }
})

test('Arena live probe preserves typed quota initialization failure without exposing local storage details', async () => {
  const f = fixture({ catalogQuotaError: true }), report = await f.live()
  assert.equal(report.status, 'quota_unavailable')
  assert.deepEqual(report.checks, [])
  assert.equal(f.calls.filter(call => call.type === 'http').length, 0)
})

test('Arena login and live preflight preserve route_changed without new requests or saved accounts', async () => {
  for (const method of ['login', 'live']) {
    for (const options of [{ authenticated: false, statusErrorCode: 'route_changed' }, { catalogRouteError: true }]) {
      const f = fixture(options), report = await f[method]()
      assert.equal(report.status, 'route_changed')
      assert.equal(report.accountVerified, false)
      assert.equal(f.calls.filter(call => call.type === 'http').length, 0)
      assert.equal(f.loginStarts, 0)
      assert.equal(f.saved.length, 0)
    }
  }
})

test('Arena HTTP text and image route_changed failures stay actionable without retries', async () => {
  for (const [errorPath, expectedRequests] of [['/v1/chat/completions', 1], ['/v1/images/generations', 3]]) {
    const f = fixture({ generationError: { status: 409, code: 'route_changed' }, errorPath })
    const report = await f.live()
    assert.equal(report.status, 'route_changed')
    assert.equal(report.checks.at(-1).error, 'route_changed')
    assert.equal(report.checks.at(-1).completed, false)
    assert.equal(f.calls.filter(call => call.type === 'http' && call.request.body).length, expectedRequests)
    assert.equal(f.saved.length, 0)
  }
})
