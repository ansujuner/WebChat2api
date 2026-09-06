/**
 * Capture the real production renderer using a fresh, account-free Electron profile.
 * Three existing built-in provider definitions are added locally for catalog presentation.
 * No accounts, credentials, generated replies, HTTP requests or production fixtures.
 * Build separately, then: node scripts/capture-showcase.cjs [--electron PATH] [--publish]
 * Without --publish, all images remain in the ignored, app-owned fixture directory.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')
const ROUTES = Object.freeze([
  { route: '/', file: 'dashboard.png', title: 'dashboard.heroTitle' },
  { route: '/providers', file: 'providers.png', title: 'providers.title' },
  { route: '/proxy', file: 'proxy.png', title: 'proxy.title' },
  { route: '/models', file: 'models.png', title: 'models.title' },
  { route: '/api-keys', file: 'api-keys.png', title: 'apiKeys.title' },
  { route: '/logs', file: 'logs.png', title: 'logs.title' },
  { route: '/session', file: 'Session.png', title: 'session.title' },
  { route: '/settings', file: 'settings.png', title: 'settings.title' },
  { route: '/about', file: 'about.png', title: 'settings.appName' },
])
const EXTRA_FILES = Object.freeze(['preview.png', 'preview-en.png', 'preview-en-dark.png', 'tray.png'])
const FILES = Object.freeze([...ROUTES.map(route => route.file), ...EXTRA_FILES])
const SIZES = Object.freeze([{ width: 1440, height: 1000 }, { width: 1100, height: 800 }])
const LANGUAGES = Object.freeze(['zh-CN', 'en-US'])
const THEMES = Object.freeze(['light', 'dark'])
const CATALOG_IDS = Object.freeze(['deepseek', 'glm', 'arena'])

function inside(target, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function isolatedEnvironment(parent, fixture) {
  const env = { ...parent, NODE_ENV: 'production', CHAT2API_SHOWCASE_ROOT: fixture,
    HOME: path.join(fixture, 'home'), USERPROFILE: path.join(fixture, 'home'),
    APPDATA: path.join(fixture, 'roaming'), LOCALAPPDATA: path.join(fixture, 'local'),
    TEMP: path.join(fixture, 'temp'), TMP: path.join(fixture, 'temp') }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS']) delete env[key]
  return env
}

function allowedInvocation(channel, args, approvedProviderAdds = []) {
  if (channel === 'providers:add') return args.length === 1 && !!args[0] && CATALOG_IDS.includes(args[0].id) &&
    approvedProviderAdds.some(provider => JSON.stringify(provider) === JSON.stringify(args[0]))
  if (channel === 'config:update') return args.length === 1 && args[0] && !Array.isArray(args[0]) &&
    Object.keys(args[0]).length > 0 && Object.entries(args[0]).every(([key, value]) =>
      key === 'language' ? LANGUAGES.includes(value) : key === 'theme' && [...THEMES, 'system'].includes(value))
  // Website status operations are replaced below with an explicit offline-fixture unknown result.
  return /^(?:[^:]+:get[^:]*|accounts:livenessGet|providers:checkStatus|providers:checkAllStatus|oauth:inAppLoginStatus)$/.test(channel)
}

function validateInspection(result, expected) {
  assert.equal(result.route, expected.route, 'The requested page was not rendered')
  assert.equal(result.width, expected.width, 'Unexpected renderer width')
  assert.equal(result.height, expected.height, 'Unexpected renderer height')
  assert.equal(result.theme, expected.theme, 'The requested theme was not applied')
  assert.equal(result.language, expected.language, 'The requested language was not applied')
  assert.ok(result.hasContent, 'The page is empty or still loading')
  assert.deepEqual(result.brokenImages, [], 'Some visible images failed to load')
  assert.deepEqual(result.translationKeys, [], 'Untranslated i18n keys are visible')
  assert.deepEqual(result.horizontalOverflow, [], 'The page has horizontal overflow')
  assert.equal(result.hasPrivatePath, false, 'A private filesystem path is visible')
  assert.equal(result.hasEmail, false, 'The empty showcase must not contain account email addresses')
}

/** Standard screenshot normalization: complete finite entry transitions, never hide infinite loading states. */
function finishFiniteAnimations() {
  let completed = 0
  for (const animation of document.getAnimations()) {
    if (animation.playState === 'running' && animation.effect &&
      Number.isFinite(animation.effect.getComputedTiming().endTime)) {
      animation.finish()
      completed++
    }
  }
  return completed
}

/** Executed in the actual renderer. Returns bounded diagnostics, never page HTML/storage contents. */
function inspectDocument(expected, translationRoots) {
  const visible = element => {
    const style = getComputedStyle(element)
    return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0'
  }
  const scope = expected.route === '/tray' ? document.getElementById('root')
    : document.querySelector('main') || document.getElementById('root')
  const texts = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const element = walker.currentNode.parentElement
    if (element && !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName) && visible(element)) texts.push(walker.currentNode.textContent || '')
  }
  const text = texts.join(' ')
  const roots = new Set(translationRoots)
  const translationKeys = [...new Set((text.match(/\b[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+\b/g) || [])
    .filter(key => roots.has(key.split('.')[0])))].slice(0, 20)
  const brokenImages = [...document.images].filter(image => visible(image) && (!image.complete || image.naturalWidth === 0))
    .map(image => ({ alt: image.alt.slice(0, 80), loaded: image.complete })).slice(0, 20)
  const horizontalOverflow = [...new Set([document.documentElement, document.body, document.getElementById('root'), scope])]
    .filter(element => element && element.scrollWidth > element.clientWidth + 2)
    .map(element => ({ element: element.tagName.toLowerCase(), clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
  const saved = JSON.parse(localStorage.getItem('chat2api-settings') || '{}').state
  return {
    route: location.hash.slice(1) || '/', width: innerWidth, height: innerHeight,
    theme: document.documentElement.getAttribute('data-theme'), language: saved?.language,
    hasContent: !!scope && scope.innerText.trim().length > 20 &&
      (expected.title ? scope.innerText.includes(expected.title) : !!scope.querySelector('h1,h2,h3')),
    imageCount: [...document.images].filter(visible).length, brokenImages, translationKeys, horizontalOverflow,
    hasPrivatePath: /[A-Z]:[\\/](?:Users|Documents and Settings)[\\/]/i.test(text),
    hasEmail: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text),
  }
}

function assertPublishable(manifest, imageDirectory) {
  assert.equal(manifest.passed, true, 'Only a fully validated capture can be published')
  assert.equal(manifest.fixture.accounts, 0)
  assert.equal(manifest.fixture.realProviderRequests, 0)
  assert.equal(manifest.fixture.syntheticSuccesses, 0)
  assert.deepEqual(manifest.images.map(image => image.file).sort(), [...FILES].sort())
  for (const image of manifest.images) {
    assert.ok(FILES.includes(image.file), 'Unknown publication filename')
    assert.equal(image.freshPresentation, true, 'A fresh compositor presentation is required')
    assert.equal(image.nativeWindowHidden, true, 'Only the isolated hidden window can be captured')
    const filename = path.resolve(imageDirectory, image.file)
    assert.ok(inside(filename, imageDirectory), 'Screenshot path escaped the fixture')
    assert.ok(inside(fs.realpathSync(filename), fs.realpathSync(imageDirectory)), 'Screenshot symlink escaped the fixture')
    const bytes = fs.readFileSync(filename)
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid PNG file')
    assert.equal(bytes.readUInt32BE(16), image.width, 'PNG width mismatch')
    assert.equal(bytes.readUInt32BE(20), image.height, 'PNG height mismatch')
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), image.sha256, 'PNG changed after validation')
  }
}

/** DOM readiness is not compositor readiness: require a new presentation after invalidation. */
async function captureFreshPage(window, bounded) {
  assert.equal(window.isVisible(), false, 'The isolated native window must remain hidden')
  let presented
  const presentation = new Promise(resolve => { presented = resolve })
  window.webContents.beginFrameSubscription(false, () => presented())
  try {
    window.webContents.invalidate()
    // stayHidden:false lets the page render while its native window remains hidden.
    // Discard this first capture because Chromium may still return its preceding compositor frame.
    await bounded(window.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true }), 'The first compositor capture timed out')
    await bounded(presentation, 'The renderer did not present a fresh frame after invalidation')
    const image = await bounded(window.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true }), 'The fresh compositor capture timed out')
    assert.equal(window.isVisible(), false, 'Capturing must not expose the isolated native window')
    return image
  } finally { window.webContents.endFrameSubscription() }
}

function runParent(argv) {
  const { spawnSync } = require('node:child_process')
  const option = argv.indexOf('--electron')
  if (option >= 0) assert.ok(argv[option + 1] && !argv[option + 1].startsWith('--'), '--electron requires an executable path')
  const executable = option >= 0 ? path.resolve(argv[option + 1]) : require('electron')
  assert.ok(fs.existsSync(executable), 'The project Electron runtime is missing')
  for (const filename of ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
    assert.ok(fs.existsSync(path.join(root, filename)), 'Build the production app separately before capturing')
  }
  const cache = path.join(root, '.audit-cache')
  fs.mkdirSync(cache, { recursive: true })
  assert.ok(inside(fs.realpathSync(cache), fs.realpathSync(root)), 'The fixture directory must not be a symlink outside the workspace')
  const fixture = fs.mkdtempSync(path.join(cache, 'showcase-'))
  for (const name of ['home', 'roaming', 'local', 'userData', 'sessionData', 'temp', 'logs', 'screenshots']) fs.mkdirSync(path.join(fixture, name))
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'chat2api-isolated-showcase', version, main: __filename }))
  const child = spawnSync(executable, [fixture], { cwd: root, env: isolatedEnvironment(process.env, fixture),
    windowsHide: true, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 })
  fs.writeFileSync(path.join(fixture, 'stdout.log'), child.stdout || '')
  fs.writeFileSync(path.join(fixture, 'stderr.log'), child.stderr || '')
  const reportFile = path.join(fixture, 'report.json')
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8'))
    : { passed: false, error: 'The isolated capture exited without a report.' }
  report.passed = report.passed === true && child.status === 0 && report.cleanQuit === true
  report.childExitCode = child.status
  report.stagingDirectory = path.relative(root, path.join(fixture, 'screenshots')).split(path.sep).join('/')
  const imageDirectory = path.join(fixture, 'screenshots')
  if (report.passed) {
    assertPublishable(report, imageDirectory)
    if (argv.includes('--publish')) {
      const destination = path.join(root, 'docs/screenshots')
      assert.ok(inside(fs.realpathSync(destination), fs.realpathSync(root)), 'The screenshot directory must stay inside the workspace')
      for (const file of [...FILES, 'manifest.json']) {
        const target = path.join(destination, file)
        assert.ok(!fs.existsSync(target) || !fs.lstatSync(target).isSymbolicLink(), 'Refusing a redirected publication file')
      }
      for (const file of FILES) fs.copyFileSync(path.join(imageDirectory, file), path.join(destination, file))
      const { stagingDirectory: _local, childExitCode: _exit, ...manifest } = report
      fs.writeFileSync(path.join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      report.published = true
    }
  }
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true })
  fs.writeFileSync(path.join(root, 'artifacts/showcase-capture.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.passed ? 0 : 1
}

async function runChild() {
  const fixture = process.env.CHAT2API_SHOWCASE_ROOT
  assert.ok(fixture && /^showcase-[a-zA-Z0-9]+$/.test(path.basename(fixture)) && inside(fixture, path.join(root, '.audit-cache')), 'Refusing a non-workspace showcase profile')
  const mark = phase => fs.appendFileSync(path.join(fixture, 'phases.log'), `${phase}\n`)
  mark('fixture-entry')
  const { app, session, ipcMain, shell } = require('electron')
  assert.ok(inside(fs.realpathSync(fixture), fs.realpathSync(path.join(root, '.audit-cache'))), 'Refusing a redirected showcase profile')
  assert.equal(path.resolve(require('node:os').homedir()), path.join(fixture, 'home'), 'The operating-system home is not isolated')
  for (const [name, directory] of Object.entries({ home: 'home', appData: 'roaming', userData: 'userData', sessionData: 'sessionData', temp: 'temp' })) {
    app.setPath(name, path.join(fixture, directory))
    assert.ok(inside(app.getPath(name), fixture), 'Electron storage escaped the fixture')
  }
  app.setAppLogsPath(path.join(fixture, 'logs'))
  app.commandLine.appendSwitch('force-device-scale-factor', '1')
  mark('paths-isolated')
  const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const dictionaries = Object.fromEntries(LANGUAGES.map(language => [language,
    JSON.parse(fs.readFileSync(path.join(root, `src/renderer/src/i18n/locales/${language}.json`), 'utf8'))]))
  const translate = (language, key) => key?.split('.').reduce((value, part) => value?.[part], dictionaries[language])
  const report = { passed: false, capturedAt: new Date().toISOString(), version: packageInfo.version,
    runtime: { electron: process.versions.electron, chromium: process.versions.chrome },
    rendererSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'out/renderer/index.html'))).digest('hex'),
    fixture: { kind: 'preconfigured-builtins-without-accounts', productionProfileUsed: false, accounts: 0, realProviderRequests: 0,
      syntheticSuccesses: 0, networkPolicy: 'deny-all-http-https-ws-wss', builtInCatalogOnly: true,
      providerIds: [...CATALOG_IDS], websiteStatus: 'unknown-not-checked-in-offline-showcase' },
    captureAnimationPolicy: 'complete-finite-entry-animations-preserve-infinite-loading',
    checks: [], validations: [], images: [], blockedNetworkRequests: 0, blockedIpc: [] }
  let win, finishing = false, started = false, pendingIpc = 0, approvedProviderAdds = []
  const write = () => fs.writeFileSync(path.join(fixture, 'report.json'), JSON.stringify(report, null, 2))
  const finish = async error => {
    if (finishing) return
    finishing = true
    if (error) {
      report.error = error instanceof Error ? error.message : 'Isolated capture failed'
      mark('validation-failed')
      write()
      if (win && !win.isDestroyed()) {
        try {
          const image = await Promise.race([win.webContents.capturePage(undefined, { stayHidden: true }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Failure capture timed out')), 1500))])
          fs.writeFileSync(path.join(fixture, 'failure.png'), image.toPNG())
        } catch {}
      }
    }
    clearTimeout(watchdog)
    report.passed = !error
    write()
    app.isQuitting = true
    app.quit()
  }
  const watchdog = setTimeout(() => { report.error = 'The isolated capture exceeded 210 seconds'; write(); app.exit(1) }, 210000)
  app.once('quit', () => { report.cleanQuit = true; write() })
  const denyNetwork = () => { report.blockedNetworkRequests++; throw new Error('Network access is disabled in the empty showcase') }
  for (const module of ['node:http', 'node:https']) for (const method of ['request', 'get']) require(module)[method] = denyNetwork
  globalThis.fetch = async () => denyNetwork()
  shell.openExternal = async () => { throw new Error('External navigation is disabled in the empty showcase') }
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    require('node:child_process')[method] = () => { throw new Error('External processes are disabled in the empty showcase') }
  }
  mark('network-isolated')
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
    const allowed = allowedInvocation(channel, args, approvedProviderAdds)
    if (!allowed) report.blockedIpc.push(channel)
    assert.ok(allowed, `Showcase forbids side-effect IPC: ${channel}`)
    if (channel === 'providers:add') approvedProviderAdds = approvedProviderAdds.filter(provider => provider.id !== args[0].id)
    // Normal health status reads contact the website. In this offline fixture they must instead
    // say unknown, never fake "online" or imply the account/model is verified usable.
    const unverified = id => ({ providerId: id, status: 'unknown', error: 'Not checked in the offline screenshot fixture.' })
    if (channel === 'providers:checkAllStatus') return Object.fromEntries(CATALOG_IDS.map(id => [id, unverified(id)]))
    if (channel === 'providers:checkStatus') return unverified(args[0])
    pendingIpc++
    try { return await listener(event, ...args) }
    finally { pendingIpc-- }
  })
  const isolateRequests = target => target.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => { report.blockedNetworkRequests++; callback({ cancel: true }) })
  app.on('session-created', isolateRequests)
  app.whenReady().then(() => isolateRequests(session.defaultSession))
  app.on('browser-window-created', (_, window) => {
    window.show = () => {}; window.showInactive = () => {}; window.focus = () => {}
    window.webContents.setBackgroundThrottling(false)
    if (win) return
    win = window
    window.webContents.once('did-fail-load', () => void finish(new Error('The production renderer failed to load')))
    window.webContents.on('render-process-gone', () => void finish(new Error('The production renderer terminated unexpectedly')))
    window.webContents.once('did-finish-load', () => {
      if (!started) { started = true; void verify().then(() => finish(), finish) }
    })
  })
  mark('loading-production-main')
  try { require(path.join(root, 'out/main/index.js')) } catch (error) { await finish(error) }
  mark('production-main-loaded')

  async function bounded(operation, message, duration = 10000) {
    let timer
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), duration) })]) }
    finally { clearTimeout(timer) }
  }
  const invoke = expression => bounded(win.webContents.executeJavaScript(expression), 'A renderer inspection timed out')
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  async function until(predicate, message) {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) { if (await predicate()) return; await sleep(40) }
    throw new Error(message)
  }
  async function settle() {
    await until(() => pendingIpc === 0, 'The renderer still has pending application reads')
    await invoke('document.fonts.ready.then(() => true)')
    await until(() => invoke('[...document.images].every(image => image.complete)'), 'Images did not finish loading')
    await invoke(`(${finishFiniteAnimations.toString()})()`)
    // Hidden native windows may suspend requestAnimationFrame even without background throttling.
    // Poll actual layout from the main process instead, with a bounded deadline.
    let previous, stable = 0
    await until(async () => {
      const signature = await invoke(`(() => { const main = document.querySelector('main') || document.body;
        return [innerWidth, innerHeight, main.scrollWidth, main.scrollHeight, main.innerText.length, document.images.length].join(':') })()`)
      stable = signature === previous && pendingIpc === 0 ? stable + 1 : 0
      previous = signature
      return stable >= 3
    }, 'Renderer layout did not stabilize')
  }
  async function clickHeader(label) {
    const clicked = await invoke(`(() => { const button = [...document.querySelectorAll('header button')].find(button => button.title === ${JSON.stringify(label)} || button.getAttribute('aria-label') === ${JSON.stringify(label)}); button?.click(); return !!button })()`)
    assert.ok(clicked, `The header control was not found: ${label}`)
  }
  async function settings(language, theme) {
    mark(`settings:${language}:${theme}`)
    if (win.webContents.getURL().endsWith('#/tray')) await navigate(ROUTES[0], language)
    const current = await invoke('JSON.parse(localStorage.getItem("chat2api-settings") || "{}").state || {}')
    if (current.language !== language) {
      const clicked = await invoke(`(() => { const button = document.querySelector('[data-testid="language-switcher"] button[data-language="${language}"]'); button?.click(); return !!button })()`)
      assert.ok(clicked, 'The real language selector was not found')
    }
    await until(async () => (await invoke('window.electronAPI.config.get()')).language === language, 'Language was not persisted through the real IPC bridge')
    const applied = await invoke('document.documentElement.getAttribute("data-theme")')
    // An OS-default theme which happens to match is not an explicit saved preference.
    if (applied === theme && current.theme !== theme) {
      await clickHeader(translate(language, theme === 'light' ? 'settings.themeDark' : 'settings.themeLight'))
      await until(() => invoke(`document.documentElement.getAttribute('data-theme') !== ${JSON.stringify(theme)}`), 'The theme toggle did not change its system default')
    }
    if (applied !== theme || current.theme !== theme) await clickHeader(translate(language, theme === 'light' ? 'settings.themeLight' : 'settings.themeDark'))
    await until(() => invoke(`document.documentElement.getAttribute('data-theme') === ${JSON.stringify(theme)}`), 'The theme control did not apply its selection')
    await until(async () => (await invoke('window.electronAPI.config.get()')).theme === theme, 'Theme was not persisted through the real IPC bridge')
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Renderer reload timed out')), 10000)
      win.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve() })
      win.webContents.reload()
    })
    await settle()
    const saved = await invoke('(async () => { const config = await window.electronAPI.config.get(); return { language: JSON.parse(localStorage.getItem("chat2api-settings") || "{}").state?.language, savedTheme: JSON.parse(localStorage.getItem("chat2api-settings") || "{}").state?.theme, theme: document.documentElement.getAttribute("data-theme"), configLanguage: config.language, configTheme: config.theme } })()')
    assert.deepEqual(saved, { language, savedTheme: theme, theme, configLanguage: language, configTheme: theme }, 'Language/theme selection did not survive a renderer reload')
    report.checks.push(`real-header-selection-and-reload-persistence:${language}:${theme}`)
  }
  async function navigate(route, language) {
    mark(`navigate:${language}:${route.route}`)
    await invoke(`location.hash = ${JSON.stringify(`#${route.route}`)}`)
    const title = translate(language, route.title)
    await until(() => invoke(`(() => { const main = document.querySelector('main'); return location.hash === ${JSON.stringify(`#${route.route}`)} && !!main && ${JSON.stringify(title || '')} && main.innerText.includes(${JSON.stringify(title || '')}) })()`), `Page did not become ready: ${route.route}`)
    await invoke('document.querySelector("main")?.scrollTo(0, 0)')
    await settle()
  }
  async function inspect(route, language, theme, size) {
    const expected = { route: route.route, language, theme, ...size, title: translate(language, route.title) }
    const result = await invoke(`(${inspectDocument.toString()})(${JSON.stringify(expected)}, ${JSON.stringify(Object.keys(dictionaries[language]))})`)
    validateInspection(result, expected)
    report.validations.push({ route: route.route, language, theme, ...size, imageCount: result.imageCount,
      noHorizontalOverflow: true, allImagesLoaded: true, noTranslationKeys: true })
  }
  async function capture(file, route, language, theme, size) {
    assert.ok(FILES.includes(file), 'Unknown screenshot filename')
    const image = await captureFreshPage(win, bounded)
    assert.equal(image.isEmpty(), false, 'Electron produced an empty screenshot')
    const dimensions = image.getSize()
    assert.deepEqual(dimensions, size, 'Screenshot dimensions differ from the validated viewport')
    const bytes = image.toPNG()
    fs.writeFileSync(path.join(fixture, 'screenshots', file), bytes)
    report.images.push({ file, route: route.route, language, theme, ...dimensions,
      freshPresentation: true, nativeWindowHidden: true,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') })
  }
  async function verify() {
    mark('renderer-ready')
    win.setContentSize(SIZES[0].width, SIZES[0].height)
    await until(() => invoke('!!window.electronAPI?.accounts?.livenessGet && !!document.querySelector("main")'), 'The production app bridge is not ready')
    assert.deepEqual(await invoke('window.electronAPI.accounts.getAll()'), [], 'The showcase profile must contain no accounts')
    assert.equal(await invoke('window.electronAPI.accounts.livenessGet()'), null, 'No liveness results may be fabricated')
    assert.equal((await invoke('window.electronAPI.proxy.getStatus()')).isRunning, false, 'The showcase must not start the API proxy')
    assert.equal(await invoke('window.electronAPI.app.getVersion()'), packageInfo.version, 'The fixture must display the real project version')
    assert.equal((await invoke('window.electronAPI.statistics.get()')).totalRequests, 0, 'The showcase must not fabricate requests')
    report.checks.push('fresh-profile-zero-accounts-zero-generations-proxy-stopped-real-version')
    assert.deepEqual(await invoke('window.electronAPI.providers.getAll()'), [], 'The screenshot fixture must start with no user provider configuration')
    const builtin = await invoke('window.electronAPI.providers.getBuiltin()')
    approvedProviderAdds = CATALOG_IDS.map(id => builtin.find(provider => provider.id === id))
    assert.ok(approvedProviderAdds.every(provider => provider?.type === 'builtin'), 'The selected built-in catalog is unavailable')
    try {
      for (const id of CATALOG_IDS) {
        const provider = approvedProviderAdds.find(candidate => candidate.id === id)
        const saved = await invoke(`window.electronAPI.providers.add(${JSON.stringify(provider)})`)
        assert.equal(saved.id, id)
      }
    } finally { approvedProviderAdds = [] }
    assert.deepEqual((await invoke('window.electronAPI.providers.getAll()')).map(provider => provider.id).sort(), [...CATALOG_IDS].sort())
    report.checks.push('three-exact-existing-builtins-preconfigured-without-accounts-or-website-status-claims')
    for (const language of LANGUAGES) for (const theme of THEMES) {
      win.setContentSize(SIZES[0].width, SIZES[0].height)
      await settings(language, theme)
      for (const size of SIZES) {
        mark(`viewport:${size.width}:${size.height}`)
        win.setContentSize(size.width, size.height)
        for (const route of ROUTES) {
          await navigate(route, language)
          await inspect(route, language, theme, size)
          if (size === SIZES[0]) {
            if (language === 'zh-CN' && theme === 'light') await capture(route.file, route, language, theme, size)
            else if (route.route === '/') await capture(language === 'zh-CN' ? 'preview.png' : theme === 'light' ? 'preview-en.png' : 'preview-en-dark.png', route, language, theme, size)
          }
        }
      }
    }
    win.setContentSize(SIZES[0].width, SIZES[0].height)
    await settings('zh-CN', 'light')
    // The dedicated tray route is also the actual renderer, not a mocked picture.
    win.setMinimumSize(1, 1)
    const size = { width: 400, height: 460 }
    win.setContentSize(size.width, size.height)
    await invoke('location.hash = "#/tray"')
    await until(() => invoke('location.hash === "#/tray" && !document.querySelector("aside") && document.querySelector("h1")?.innerText === "WebChat2api"'), 'The tray route did not become ready')
    await settle()
    await inspect({ route: '/tray' }, 'zh-CN', 'light', size)
    await capture('tray.png', { route: '/tray' }, 'zh-CN', 'light', size)
    assert.deepEqual(await invoke('window.electronAPI.accounts.getAll()'), [])
    assert.equal((await invoke('window.electronAPI.statistics.get()')).totalRequests, 0)
    assert.equal((await invoke('window.electronAPI.proxy.getStatus()')).isRunning, false)
    assert.deepEqual(report.blockedIpc, [], 'Opening pages must not attempt forbidden side-effect IPC')
    report.checks.push('all-routes-two-languages-two-themes-two-desktop-sizes-and-tray', 'no-account-or-request-state-created')
    assert.deepEqual(report.images.map(image => image.file).sort(), [...FILES].sort())
  }
}

module.exports = { ROUTES, FILES, SIZES, LANGUAGES, THEMES, CATALOG_IDS, inside, isolatedEnvironment, allowedInvocation, validateInspection, inspectDocument, assertPublishable, captureFreshPage, finishFiniteAnimations }
if (require.main === module || (process.versions.electron && process.env.CHAT2API_SHOWCASE_ROOT)) {
  if (process.versions.electron) runChild().catch(error => {
    const fixture = process.env.CHAT2API_SHOWCASE_ROOT
    if (fixture && inside(fixture, path.join(root, '.audit-cache'))) {
      fs.writeFileSync(path.join(fixture, 'report.json'), JSON.stringify({ passed: false,
        error: error instanceof Error ? error.message : 'The isolated capture could not initialize.' }, null, 2))
    }
    require('electron').app.exit(1)
  })
  else runParent(process.argv.slice(2))
}
