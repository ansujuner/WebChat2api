const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const root = path.resolve(__dirname, '../..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const renderer = 'src/renderer/src/'
function load(file, imports, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(read(file), { fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { module, exports: module.exports, Date, console: { error() {} },
    require(name) { assert.ok(Object.hasOwn(imports, name), `Unmocked shell boundary ${name}`); return imports[name] }, ...globals,
  }, { filename: file })
  return module.exports
}
const locale = language => JSON.parse(read(`${renderer}i18n/locales/${language}.json`))
const translate = language => key => key.split('.').reduce((value, part) => value?.[part], locale(language)) || key
const icon = () => null
const icons = new Proxy({}, { get: () => icon })
const Button = ({ children, variant, size, ...props }) => React.createElement('button', props, children)
const baseImports = language => ({
  react: React, 'react/jsx-runtime': require('react/jsx-runtime'), 'lucide-react': icons,
  'react-i18next': { useTranslation: () => ({ t: translate(language) }) },
  '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') }, '@/components/ui/button': { Button },
})
function settingsFixture({ resolvedLanguage, config = {}, persisted } = {}) {
  let state, options
  const changes = [], updates = []
  const i18n = { resolvedLanguage, async changeLanguage(language) { changes.push(language) } }
  const set = update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) } }
  load(`${renderer}stores/settingsStore.ts`, {
    zustand: { create: () => initialize => { state = initialize(set, () => state); return () => state } },
    'zustand/middleware': { persist: (initialize, value) => { options = value; return initialize } },
    '@/i18n': { default: i18n },
  }, { window: { electronAPI: { config: { async update(value) { updates.push(plain(value)); return true }, async get() { return config } } } } })
  if (persisted) { state = options.merge(persisted, state); options.onRehydrateStorage()(state) }
  return { get state() { return state }, options, changes, updates }
}

test('fresh interface is Chinese and only an explicit saved detector choice overrides it', () => {
  let init, onLanguageChanged
  const document = { documentElement: { lang: '' } }
  const i18n = { on(event, callback) { assert.equal(event, 'languageChanged'); onLanguageChanged = callback }, use() { return this }, init(options) { init = options } }
  load(`${renderer}i18n/index.ts`, {
    i18next: { default: i18n }, 'react-i18next': { initReactI18next: {} },
    'i18next-browser-languagedetector': { default: {} },
    './locales/zh-CN.json': { default: locale('zh-CN') }, './locales/en-US.json': { default: locale('en-US') },
  }, { document })
  assert.equal(init.fallbackLng, 'zh-CN')
  assert.deepEqual(plain(init.detection.order), ['localStorage'])
  assert.equal(init.detection.convertDetectedLanguage('en-US'), 'en-US')
  assert.equal(init.detection.convertDetectedLanguage('zh-TW'), 'zh-CN')
  assert.equal(init.detection.convertDetectedLanguage('fr'), 'zh-CN')
  onLanguageChanged('en-US'); assert.equal(document.documentElement.lang, 'en-US')
  onLanguageChanged('zh-CN'); assert.equal(document.documentElement.lang, 'zh-CN')
})

test('language persistence retains English and unrelated settings without reviving in-flight state', () => {
  assert.equal(settingsFixture().state.language, 'zh-CN')
  assert.equal(settingsFixture({ resolvedLanguage: 'en-US' }).state.language, 'en-US')
  const saved = settingsFixture({ persisted: { language: 'en-US', theme: 'dark', sidebarCollapsed: true, proxyModeSaving: true } })
  assert.equal(saved.state.language, 'en-US')
  assert.equal(saved.state.theme, 'dark')
  assert.equal(saved.state.sidebarCollapsed, true)
  assert.equal(saved.state.proxyModeSaving, false)
  assert.deepEqual(saved.changes, ['en-US'])
  assert.equal(settingsFixture({ persisted: { language: 'unsupported' } }).state.language, 'zh-CN')
})

test('switching languages updates the same persisted configuration; invalid values do not write', async () => {
  const f = settingsFixture()
  await f.state.setLanguage('en-US')
  assert.equal(f.state.language, 'en-US')
  assert.deepEqual(f.changes, ['en-US'])
  assert.deepEqual(f.updates, [{ language: 'en-US' }])
  await f.state.setLanguage('invalid')
  assert.equal(f.state.language, 'en-US')
  assert.equal(f.updates.length, 1)
  await f.state.setLanguage('zh-CN')
  assert.deepEqual(f.updates.at(-1), { language: 'zh-CN' })
})

test('backend saved English is applied to i18n, while absent language preserves an existing choice', async () => {
  const english = settingsFixture({ config: { language: 'en-US', autoStart: false } })
  await english.state.fetchConfig()
  assert.equal(english.state.language, 'en-US')
  assert.deepEqual(english.changes, ['en-US'])
  const missing = settingsFixture({ persisted: { language: 'en-US' }, config: {} })
  await missing.state.fetchConfig()
  assert.equal(missing.state.language, 'en-US')
  assert.deepEqual(missing.changes, ['en-US', 'en-US'])
})

test('explicit theme switches persist through IPC and reload without replacing legacy local preferences', async () => {
  const f = settingsFixture({ config: { theme: 'system', language: 'zh-CN' }, persisted: { theme: 'dark' } })
  await f.state.fetchConfig()
  assert.equal(f.state.theme, 'dark', 'The old backend default must not erase an existing explicit theme')
  await f.state.setTheme('light')
  assert.equal(f.state.theme, 'light')
  assert.equal(f.state.config.theme, 'light')
  assert.deepEqual(f.updates, [{ theme: 'light' }])
  await f.state.setTheme('invalid')
  assert.equal(f.state.theme, 'light')
  assert.equal(f.updates.length, 1)
  const saved = f.options.partialize(f.state)
  const reloaded = settingsFixture({ persisted: plain(saved) })
  assert.equal(reloaded.state.theme, 'light')
  assert.equal(reloaded.state.config.theme, 'light')
  assert.equal(settingsFixture({ persisted: { theme: 'invalid' } }).state.theme, 'system')
})

function themeFixture() {
  let theme = 'system', index = 0, matches = false
  const values = [], effects = [], pending = [], listeners = new Set(), changed = [], applied = []
  const media = { get matches() { return matches }, addEventListener(event, fn) { assert.equal(event, 'change'); listeners.add(fn) }, removeEventListener(event, fn) { assert.equal(event, 'change'); listeners.delete(fn) } }
  const { useTheme } = load(`${renderer}hooks/useTheme.ts`, {
    react: {
      useState(initial) { const slot = index++; if (!Object.hasOwn(values, slot)) values[slot] = typeof initial === 'function' ? initial() : initial; return [values[slot], next => { values[slot] = next }] },
      useEffect(callback, deps) { const slot = index++; const last = effects[slot]; if (!last || deps.some((dep, i) => dep !== last.deps[i])) { pending.push(() => { last?.cleanup?.(); effects[slot] = { deps, cleanup: callback() } }) } },
    },
    '@/stores/settingsStore': { useSettingsStore: () => ({ theme, setTheme(value) { changed.push(value); theme = value } }) },
  }, { window: { matchMedia: () => media, document: { documentElement: { setAttribute(name, value) { assert.equal(name, 'data-theme'); applied.push(value) } } } } })
  return { changed, applied, listeners,
    render() { index = 0; const result = useTheme(); pending.splice(0).forEach(fn => fn()); return result },
    emit(value) { matches = value; for (const fn of listeners) fn({ matches: value }) },
    setTheme(value) { theme = value },
    unmount() { effects.forEach(effect => effect?.cleanup?.()) },
  }
}

test('system appearance changes update isDark and the next toggle direction, with clean listeners', () => {
  const f = themeFixture()
  assert.equal(f.render().isDark, false)
  assert.equal(f.listeners.size, 1)
  f.emit(true)
  const dark = f.render()
  assert.equal(dark.isDark, true)
  assert.equal(f.applied.at(-1), 'dark')
  assert.deepEqual(f.changed, [], 'System appearance updates do not create a user preference')
  dark.toggleTheme()
  assert.deepEqual(f.changed, ['light'])
  assert.equal(f.render().isDark, false)
  assert.equal(f.applied.at(-1), 'light')
  assert.equal(f.listeners.size, 0)
  f.emit(false); f.emit(true)
  assert.equal(f.render().isDark, false, 'An explicit light theme ignores OS changes')
  f.setTheme('system'); f.render()
  assert.equal(f.render().isDark, true)
  assert.equal(f.listeners.size, 1)
  f.unmount(); assert.equal(f.listeners.size, 0)
})

test('visible language buttons are accessible, indicate their state and preserve explicit choices', () => {
  const calls = []
  const { LanguageSwitcher } = load(`${renderer}components/layout/LanguageSwitcher.tsx`, {
    ...baseImports('zh-CN'), '@/stores/settingsStore': { useSettingsStore: () => ({ language: 'zh-CN', setLanguage: value => calls.push(value) }) },
  })
  const tree = LanguageSwitcher()
  const markup = renderToStaticMarkup(tree)
  assert.match(markup, /data-testid="language-switcher"/)
  assert.match(markup, /lang="zh-CN"[^>]+aria-pressed="true"/)
  assert.match(markup, /lang="en-US"[^>]+aria-pressed="false"/)
  const buttons = tree.props.children
  buttons[0].props.onClick(); assert.deepEqual(calls, [])
  buttons[1].props.onClick(); assert.deepEqual(calls, ['en-US'])
})

function sidebarFixture(blocked = false, collapsed = false) {
  const navigated = [], links = []
  let pending, open = false
  const navState = { blockers: blocked ? [{ message: 'Unsaved fixture' }] : [], isDialogOpen: false,
    setPendingNavigation(callback) { pending = callback; open = true },
    confirmNavigation() { pending?.(); pending = null; open = false }, cancelNavigation() { pending = null; open = false },
  }
  const wrap = ({ children }) => React.createElement('div', null, children)
  const { Sidebar } = load(`${renderer}components/layout/Sidebar.tsx`, {
    ...baseImports('zh-CN'), 'react-router-dom': {
      NavLink: props => { links.push(props); return React.createElement('a', { href: props.to, 'aria-label': props['aria-label'] }, props.children) },
      useNavigate: () => href => navigated.push(href), useLocation: () => ({ pathname: '/proxy' }),
    }, '@/stores/settingsStore': { useSettingsStore: () => ({ sidebarCollapsed: collapsed, toggleSidebar() {} }) },
    '@/stores/navigationStore': { useNavigationStore: () => navState },
    '@/components/ui/dialog': Object.fromEntries(['Dialog', 'DialogContent', 'DialogDescription', 'DialogFooter', 'DialogHeader', 'DialogTitle'].map(name => [name, wrap])),
  })
  const markup = renderToStaticMarkup(React.createElement(Sidebar))
  return { markup, links, navState, navigated, get open() { return open } }
}

test('all nine existing pages remain accessible in expanded and collapsed navigation', () => {
  for (const collapsed of [false, true]) {
    const f = sidebarFixture(false, collapsed)
    assert.deepEqual(f.links.map(link => link.to), ['/', '/providers', '/proxy', '/models', '/session', '/api-keys', '/logs', '/settings', '/about'])
    assert.equal(f.links[0].end, true)
    assert.ok(f.links.every(link => typeof link['aria-label'] === 'string' && link['aria-label'].length > 0))
    assert.match(f.markup, /aria-controls="primary-navigation"/)
    assert.match(f.markup, new RegExp(`aria-expanded="${!collapsed}"`))
  }
})

test('sidebar unsaved-change guard opens the shared dialog and waits for confirmation', () => {
  const f = sidebarFixture(true)
  let prevented = false
  f.links.find(link => link.to === '/models').onClick({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(f.open, true)
  assert.deepEqual(f.navigated, [])
  f.navState.cancelNavigation(); assert.equal(f.open, false); assert.deepEqual(f.navigated, [])
  f.links.find(link => link.to === '/models').onClick({ preventDefault() {} })
  f.navState.confirmNavigation(); assert.deepEqual(f.navigated, ['/models'])
})

function dashboardFixture(proxyStatus, language = 'zh-CN') {
  const stats = [], sections = [], toasts = [], copied = []
  const snapshot = { proxyStatus, stats: { totalRequests: 123, successRate: 91, avgLatency: 432, activeAccounts: 4, requestsTrend: 3, successRateTrend: 2, latencyTrend: -1, accountsTrend: 0 },
    providers: [{ id: 'fixture' }], activities: [{ id: 'log' }], chartData: [{ time: '10:00', requests: 3 }], isLoading: false, error: null, lastUpdated: 1000, refreshData() {},
  }
  const localProxyOrigin = load(`${renderer}lib/proxyStatusObserver.ts`, {}).localProxyOrigin
  const { Dashboard } = load(`${renderer}pages/Dashboard.tsx`, {
    ...baseImports(language), react: { ...React, useRef: value => ({ current: value }), useEffect() {}, useCallback: callback => callback },
    'react-router-dom': { useNavigate: () => () => {} },
    '@/hooks/use-toast': { useToast: () => ({ toast: value => toasts.push(value) }) },
    '@/lib/proxyStatusObserver': { localProxyOrigin },
    '@/stores/settingsStore': { useSettingsStore: () => ({ proxyEnabled: true, setProxyEnabled() {} }) },
    '@/stores/dashboardStore': { useDashboardStore: () => snapshot },
    '@/components/dashboard': {
      StatsCard: props => { stats.push(props); return React.createElement('div', null, props.value) },
      ...Object.fromEntries(['ProviderStatusCard', 'RequestChart', 'QuickActions', 'RecentActivity'].map(name => [name, props => { sections.push([name, props]); return null }])),
    },
  }, { window: { electronAPI: {} }, navigator: { clipboard: { async writeText(value) { copied.push(value) } } } })
  const tree = Dashboard(), markup = renderToStaticMarkup(tree)
  const allElements = []
  const visit = node => { if (!React.isValidElement(node)) return; allElements.push(node); React.Children.forEach(node.props.children, visit) }
  visit(tree)
  return { markup, stats, sections, allElements, copied, toasts }
}

test('homepage uses actual runtime addresses and real statistics, retaining existing feature panels', async () => {
  const f = dashboardFixture({ host: '0.0.0.0', port: 8912, isRunning: true })
  assert.match(f.markup, /http:\/\/127\.0\.0\.1:8912\/v1/)
  assert.match(f.markup, /http:\/\/127\.0\.0\.1:8912\/v1\/messages/)
  assert.doesNotMatch(f.markup, /8080|8081/)
  assert.deepEqual(f.stats.map(item => item.value), ['123', '91%', '432ms', 4])
  assert.deepEqual(f.sections.map(item => item[0]), ['RequestChart', 'QuickActions', 'ProviderStatusCard', 'RecentActivity'])
  assert.deepEqual(f.sections[0][1].data, [{ time: '10:00', requests: 3 }])
  assert.equal((f.markup.match(/<h1\b/g) || []).length, 1)
  assert.match(f.markup, /把网页里的 AI，接入你的工作流/)
  const copyButton = f.allElements.find(item => item.props['aria-label'] === '复制 Base URL')
  await copyButton.props.onClick()
  assert.deepEqual(f.copied, ['http://127.0.0.1:8912/v1'])
  assert.equal(f.toasts.length, 1)
})

test('unknown/stopped runtime state is never presented as a running gateway', () => {
  const unknown = dashboardFixture(null)
  assert.match(unknown.markup, /等待服务状态/)
  assert.doesNotMatch(unknown.markup, /http:\/\/|代理服务运行中/)
  assert.equal(unknown.allElements.find(item => item.props['aria-label'] === '复制 Base URL').props.disabled, true)
  const stopped = dashboardFixture({ host: '::', port: 8123, isRunning: false }, 'en-US')
  assert.ok(stopped.markup.includes(locale('en-US').dashboard.proxyStopped))
  assert.match(stopped.markup, /Bring web AI into your workflow/)
})

test('activating the rendered skip link focuses main content without changing a HashRouter route', () => {
  for (const currentHash of ['#/', '#/providers', '#/logs?tab=request&highlight=fixture']) {
    const actions = []
    const location = { hash: currentHash }
    const target = { focus(options) { actions.push(['focus', plain(options)]) }, scrollIntoView(options) { actions.push(['scroll', plain(options)]) } }
    const { MainLayout } = load(`${renderer}components/layout/MainLayout.tsx`, {
      ...baseImports('zh-CN'), 'react-router-dom': { Outlet: () => null }, './Sidebar': { Sidebar: () => null }, './Header': { Header: () => null },
    }, { window: { location }, document: { getElementById(id) { assert.equal(id, 'main-content'); return target } } })
    const rendered = MainLayout()
    const link = React.Children.toArray(rendered.props.children).find(child => child.type === 'a')
    assert.equal(link.props.href, '#main-content')
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    link.props.onClick(event)
    // Emulate anchor activation's default navigation only when it was not cancelled.
    if (!event.defaultPrevented) location.hash = link.props.href
    assert.equal(event.defaultPrevented, true)
    assert.equal(location.hash, currentHash)
    assert.deepEqual(actions, [['focus', { preventScroll: true }], ['scroll', { block: 'start', behavior: 'auto' }]])
  }
})

test('shell offers a keyboard skip target, restrained branded chrome and accessible theme control', () => {
  const layout = read(`${renderer}components/layout/MainLayout.tsx`)
  assert.match(layout, /href="#main-content"/)
  assert.match(layout, /id="main-content" tabIndex=\{-1\}/)
  assert.doesNotMatch(layout, /bokeh|gradient/)
  const header = read(`${renderer}components/layout/Header.tsx`)
  assert.match(header, /assets\/brand\/webchat2api\.svg/)
  assert.match(header, /WebChat2api/)
  assert.match(header, /data-testid="theme-toggle"\s+aria-label=/)
  assert.match(header, /observeProxyStatus/)
  assert.match(header, /observer\.dispose\(\)/)
  assert.match(header, /window\.electronAPI\.proxy\.start\(\)/)
  assert.doesNotMatch(header, /8080|8081/)
})

test('new shell and homepage copy resolves fully in both languages without altering protocol labels', () => {
  const files = ['components/layout/Header.tsx', 'components/layout/Sidebar.tsx', 'components/layout/MainLayout.tsx', 'components/layout/LanguageSwitcher.tsx', 'pages/Dashboard.tsx']
  for (const language of ['zh-CN', 'en-US']) {
    const dictionary = locale(language)
    assert.equal(dictionary.app.name, 'WebChat2api')
    assert.equal(dictionary.settings.appName, 'WebChat2api')
    assert.equal(dictionary.prompts.xmlFormat, 'Chat2API XML')
    assert.equal(typeof dictionary.about.licenseLink, 'string')
    for (const file of files) for (const match of read(renderer + file).matchAll(/\bt\('([^']+)'\)/g)) {
      assert.equal(typeof match[1].split('.').reduce((value, part) => value?.[part], dictionary), 'string', `${language}: ${match[1]}`)
    }
  }
})
