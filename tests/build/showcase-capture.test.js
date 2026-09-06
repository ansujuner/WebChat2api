const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const vm = require('node:vm')
const { ROUTES, FILES, SIZES, LANGUAGES, THEMES, inside, isolatedEnvironment, allowedInvocation,
  validateInspection, inspectDocument, assertPublishable, captureFreshPage, finishFiniteAnimations } = require('../../scripts/capture-showcase.cjs')
const root = path.resolve(__dirname, '../..')

test('showcase includes every real renderer route and replaces all ten legacy screenshot filenames', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.tsx'), 'utf8')
  const routes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual([...ROUTES.map(route => route.route), '/tray'].sort(), routes.sort())
  const oldNames = ['Session.png', 'about.png', 'api-keys.png', 'dashboard.png', 'logs.png', 'models.png',
    'preview.png', 'providers.png', 'proxy.png', 'settings.png']
  for (const filename of oldNames) assert.ok(FILES.includes(filename))
  assert.equal(new Set(FILES).size, FILES.length)
  assert.equal(FILES.length, 13)
})

test('showcase page readiness labels exist in both languages and all desktop sizes are reasonable', () => {
  for (const language of LANGUAGES) {
    const translations = JSON.parse(fs.readFileSync(path.join(root, `src/renderer/src/i18n/locales/${language}.json`), 'utf8'))
    for (const route of ROUTES) assert.equal(typeof route.title.split('.').reduce((value, part) => value?.[part], translations), 'string', route.title)
  }
  assert.deepEqual(LANGUAGES, ['zh-CN', 'en-US'])
  assert.deepEqual(THEMES, ['light', 'dark'])
  assert.equal(SIZES.length, 2)
  for (const size of SIZES) assert.ok(size.width >= 1100 && size.height >= 800)
})

test('showcase environment isolates every account/profile home and does not mutate the caller environment', () => {
  const original = Object.freeze({ HOME: 'untouched-home', USERPROFILE: 'untouched-home', APPDATA: 'untouched-appdata',
    LOCALAPPDATA: 'untouched-local', TEMP: 'untouched-temp', TMP: 'untouched-temp', ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: 'unexpected-runtime-option', ELECTRON_RENDERER_URL: 'https://example.test', PATH: 'retain-runtime-path' })
  const directory = path.join(root, '.audit-cache', 'showcase-fixture')
  const result = isolatedEnvironment(original, directory)
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP']) assert.ok(inside(result[key], directory), key)
  for (const key of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ELECTRON_RENDERER_URL']) assert.equal(Object.hasOwn(result, key), false)
  assert.equal(result.NODE_ENV, 'production')
  assert.equal(result.PATH, original.PATH)
  assert.equal(original.HOME, 'untouched-home')
})

test('showcase IPC guard permits local reads and only genuine language/theme writes', () => {
  for (const channel of ['config:get', 'accounts:getAll', 'accounts:livenessGet', 'providers:getAll',
    'providers:getEffectiveModels', 'providers:checkAllStatus', 'proxy:getStatus', 'statistics:get', 'toolCalling:getStatus']) {
    assert.equal(allowedInvocation(channel, []), true, channel)
  }
  for (const update of [{ language: 'zh-CN' }, { language: 'en-US' }, { theme: 'light' }, { theme: 'dark' }, { theme: 'system' }]) {
    assert.equal(allowedInvocation('config:update', [update]), true)
  }
  for (const update of [null, [], {}, { language: 'unknown' }, { theme: 'unknown' }, { apiKeys: [] }, { autoStart: true }, { proxyPort: 8081 }, { language: 'zh-CN', autoStartProxy: true }]) {
    assert.ok(!allowedInvocation('config:update', [update]))
  }
})

test('showcase cannot log in, add accounts, generate, synchronize models, start proxy or open external applications', () => {
  for (const channel of ['accounts:add', 'accounts:update', 'accounts:setEnabled', 'accounts:validate',
    'accounts:validateToken', 'accounts:livenessStart', 'accounts:clearChats', 'oauth:startLogin',
    'oauth:startInAppLogin', 'oauth:loginWithToken', 'oauth:refreshToken', 'providers:syncModels',
    'providers:update', 'proxy:start', 'toolCalling:runSmoke', 'app:openExternal', 'app:checkUpdate',
    'app:downloadUpdate', 'app:installUpdate', 'store:set', 'store:clearAll']) assert.equal(allowedInvocation(channel, []), false, channel)
  const source = fs.readFileSync(path.join(root, 'scripts/capture-showcase.cjs'), 'utf8')
  assert.match(source, /callback\(\{ cancel: true \}\)/)
  assert.match(source, /globalThis\.fetch = async \(\) => denyNetwork\(\)/)
  assert.match(source, /shell\.openExternal = async/)
  assert.match(source, /require\('node:child_process'\)\[method\]/)
  assert.doesNotMatch(source, /electronAPI\.accounts\.add|electronAPI\.accounts\.livenessStart|electronAPI\.oauth\./)
})

test('showcase permits only an exact approved built-in provider definition during its explicit fixture seeding window', () => {
  const provider = { id: 'deepseek', name: 'DeepSeek', type: 'builtin', apiEndpoint: 'https://example.test', supportedModels: ['fixture-model'] }
  assert.equal(allowedInvocation('providers:add', [provider]), false)
  assert.equal(allowedInvocation('providers:add', [provider], [provider]), true)
  assert.equal(allowedInvocation('providers:add', [{ ...provider, apiEndpoint: 'https://unapproved.example.test' }], [provider]), false)
  assert.equal(allowedInvocation('providers:add', [{ ...provider, credentials: { token: 'not-allowed' } }], [provider]), false)
  const unrelated = { ...provider, id: 'custom-provider' }
  assert.equal(allowedInvocation('providers:add', [unrelated], [unrelated]), false)
})

test('showcase containment rejects siblings and traversal instead of matching only path prefixes', () => {
  const directory = path.join(root, '.audit-cache', 'showcase-example')
  assert.equal(inside(path.join(directory, 'screenshots', 'dashboard.png'), directory), true)
  assert.equal(inside(path.join(directory, '..', 'production-profile'), directory), false)
  assert.equal(inside(`${directory}-other`, directory), false)
})

test('showcase inspection fails on wrong language/theme, empty content, broken images, raw keys, overflow or identity text', () => {
  const expected = { route: '/providers', language: 'zh-CN', theme: 'light', width: 1440, height: 1000 }
  const valid = { ...expected, hasContent: true, brokenImages: [], translationKeys: [], horizontalOverflow: [], hasPrivatePath: false, hasEmail: false }
  validateInspection(valid, expected)
  for (const change of [{ route: '/wrong' }, { width: 1600 }, { height: 800 }, { language: 'en-US' }, { theme: 'dark' },
    { hasContent: false }, { brokenImages: [{ alt: 'fixture' }] }, { translationKeys: ['common.fixture'] },
    { horizontalOverflow: [{ element: 'main' }] }, { hasPrivatePath: true }, { hasEmail: true }]) {
    assert.throws(() => validateInspection({ ...valid, ...change }, expected))
  }
})

test('showcase inspects the complete tray including its header even when an empty-account main region exists', () => {
  const element = { tagName: 'DIV', clientWidth: 400, scrollWidth: 400 }
  const tray = { ...element, innerText: 'WebChat2api — Service Stopped — No accounts', querySelector: () => ({}) }
  const accountArea = { ...element, tagName: 'MAIN', innerText: 'No accounts', querySelector: () => null }
  const expected = { route: '/tray', language: 'zh-CN', theme: 'light', width: 400, height: 460 }
  const result = vm.runInNewContext(`(${inspectDocument.toString()})(expected, [])`, {
    expected, innerWidth: 400, innerHeight: 460, location: { hash: '#/tray' }, NodeFilter: { SHOW_TEXT: 4 },
    localStorage: { getItem: () => JSON.stringify({ state: { language: 'zh-CN' } }) },
    document: { body: element, documentElement: { ...element, tagName: 'HTML', getAttribute: () => 'light' },
      images: [], querySelector: () => accountArea, getElementById: () => tray,
      createTreeWalker: () => ({ nextNode: () => false }) },
  })
  validateInspection(JSON.parse(JSON.stringify(result)), expected)
})

function publicationFixture(t) {
  const parent = path.join(root, '.audit-cache')
  fs.mkdirSync(parent, { recursive: true })
  const directory = fs.mkdtempSync(path.join(parent, 'showcase-unit-'))
  t.after(() => { assert.ok(inside(fs.realpathSync(directory), fs.realpathSync(parent))); fs.rmSync(directory, { recursive: true, force: true }) })
  // Tiny structural PNG fixture; these files are never sent to the publisher or renderer.
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(1, 16); bytes.writeUInt32BE(1, 20)
  const images = FILES.map(file => {
    fs.writeFileSync(path.join(directory, file), bytes)
    return { file, width: 1, height: 1, freshPresentation: true, nativeWindowHidden: true, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
  })
  return { directory, manifest: { passed: true, fixture: { accounts: 0, realProviderRequests: 0, syntheticSuccesses: 0 }, images } }
}

test('showcase publishing requires all images from a successful zero-account/zero-generation fixture', t => {
  const { directory, manifest } = publicationFixture(t)
  assertPublishable(manifest, directory)
  assert.throws(() => assertPublishable({ ...manifest, passed: false }, directory))
  for (const field of ['accounts', 'realProviderRequests', 'syntheticSuccesses']) {
    assert.throws(() => assertPublishable({ ...manifest, fixture: { ...manifest.fixture, [field]: 1 } }, directory))
  }
  assert.throws(() => assertPublishable({ ...manifest, images: manifest.images.slice(1) }, directory))
  assert.throws(() => assertPublishable({ ...manifest, images: [...manifest.images.slice(1), { ...manifest.images[0], file: '../elsewhere.png' }] }, directory))
})

test('showcase publishing rechecks PNG bytes, dimensions and checksum before copying', t => {
  const { directory, manifest } = publicationFixture(t)
  const [first, ...rest] = manifest.images
  assert.throws(() => assertPublishable({ ...manifest, images: [{ ...first, freshPresentation: false }, ...rest] }, directory))
  assert.throws(() => assertPublishable({ ...manifest, images: [{ ...first, nativeWindowHidden: false }, ...rest] }, directory))
  assert.throws(() => assertPublishable({ ...manifest, images: [{ ...first, width: 2 }, ...rest] }, directory))
  assert.throws(() => assertPublishable({ ...manifest, images: [{ ...first, sha256: 'changed' }, ...rest] }, directory))
  fs.writeFileSync(path.join(directory, first.file), 'not-an-image')
  assert.throws(() => assertPublishable(manifest, directory))
})

test('showcase capture discards the potentially stale image and waits for a fresh presentation without showing the native window', async () => {
  const calls = []
  let presentation, captures = 0
  const window = { isVisible: () => false, webContents: {
    beginFrameSubscription(dirtyOnly, callback) { assert.equal(dirtyOnly, false); calls.push('subscribe'); presentation = callback },
    invalidate() { calls.push('invalidate') },
    capturePage(rect, options) { assert.equal(rect, undefined); assert.equal(options.stayHidden, false); calls.push('capture');
      if (++captures === 1) { queueMicrotask(presentation); return Promise.resolve('stale-frame') }
      return Promise.resolve('fresh-frame') },
    endFrameSubscription() { calls.push('unsubscribe') },
  } }
  assert.equal(await captureFreshPage(window, async promise => promise), 'fresh-frame')
  assert.deepEqual(calls, ['subscribe', 'invalidate', 'capture', 'capture', 'unsubscribe'])
})

test('showcase capture rejects a visible native window and always ends subscriptions on compositor failure', async () => {
  await assert.rejects(captureFreshPage({ isVisible: () => true }, async promise => promise))
  let ended = false
  const window = { isVisible: () => false, webContents: {
    beginFrameSubscription() {}, invalidate() {}, capturePage: async () => { throw new Error('fixture compositor failure') },
    endFrameSubscription() { ended = true },
  } }
  await assert.rejects(captureFreshPage(window, async promise => promise), /fixture compositor/)
  assert.equal(ended, true)
})

test('showcase finishes finite entry animations without suppressing loading spinners or paused user state', () => {
  const finished = []
  const animations = [
    ['entry', 'running', 500], ['transition', 'running', 200], ['loading', 'running', Infinity],
    ['paused', 'paused', 1000], ['already-complete', 'finished', 400],
  ].map(([name, playState, endTime]) => ({ playState, effect: { getComputedTiming: () => ({ endTime }) }, finish: () => finished.push(name) }))
  const count = vm.runInNewContext(`(${finishFiniteAnimations.toString()})()`, { document: { getAnimations: () => animations } })
  assert.equal(count, 2)
  assert.deepEqual(finished, ['entry', 'transition'])
})
