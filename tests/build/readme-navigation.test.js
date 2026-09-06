const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../..')
const files = ['README.md', 'README_EN.md', 'README_CN.md', 'docs/README.md']
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const pages = Object.fromEntries(files.map((file) => [file, read(file)]))
const screenshots = ['dashboard', 'providers', 'models', 'proxy', 'api-keys', 'logs', 'settings', 'about', 'Session', 'preview', 'preview-en', 'preview-en-dark']

// These pages use inline Markdown links and HTML header links/images. Ignore
// code examples so endpoint placeholders are not mistaken for document links.
function links(source) {
  const prose = source.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '').replace(/`[^`\n]*`/g, '')
  return [
    ...Array.from(prose.matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g), (match) => match[1]),
    ...Array.from(prose.matchAll(/\b(?:href|src)=["']([^"']+)["']/g), (match) => match[1]),
  ]
}

function localLinks(source) {
  return links(source).filter((url) => !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url))
}

function assertLocalLink(file, url) {
  const pathname = decodeURIComponent(url.split(/[?#]/, 1)[0])
  const target = path.resolve(root, path.dirname(file), pathname)
  const relative = path.relative(root, target)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${file}: link remains in repository`)
  let parent = root
  for (const part of relative.split(path.sep)) {
    // Enforce filename case even on Windows; GitHub paths are case-sensitive.
    assert.ok(fs.readdirSync(parent).includes(part), `${file}: missing or case-mismatched link ${url}`)
    parent = path.join(parent, part)
  }
  assert.ok(fs.statSync(target).isFile(), `${file}: link must target a file ${url}`)
}

test('README link scanner includes Markdown and HTML but excludes code examples', () => {
  const example = '[Guide](docs/README.md) ![UI](docs/screenshots/Session.png) <a href="README_EN.md">English</a> <img src="build/icon.png">\n`[not a link](missing.md)`\n```md\n[not a link](also-missing.md)\n```'
  assert.deepEqual(links(example), ['docs/README.md', 'docs/screenshots/Session.png', 'README_EN.md', 'build/icon.png'])
  assert.throws(() => assertLocalLink('README.md', 'docs/screenshots/session.png'), /missing or case-mismatched/)
  assert.throws(() => assertLocalLink('README.md', '../outside.md'), /remains in repository/)
})

for (const file of files) {
  test(`${file}: every relative document, icon, and screenshot link exists with exact case`, () => {
    const urls = localLinks(pages[file])
    assert.ok(urls.length >= 10)
    for (const url of urls) assertLocalLink(file, url)
  })
}

test('full Chinese and English introductions switch languages; legacy Chinese is a short redirect', () => {
  assert.match(pages['README.md'], /<strong>中文<\/strong> \| <a href="README_EN\.md">English<\/a>/)
  assert.match(pages['README_EN.md'], /<a href="README\.md">中文<\/a> \| <strong>English<\/strong>/)
  assert.match(pages['README.md'], /管理网页 AI 账号/)
  assert.match(pages['README_EN.md'], /Manage your web AI accounts/)
  assert.match(pages['README_CN.md'], /\[README\.md\]\(README\.md\)/)
  assert.ok(pages['README_CN.md'].split('\n').length < 25)
  assert.doesNotMatch(pages['README_CN.md'], /screenshots\/|<img|!\[/)
})

test('both languages expose the same guides and all current provider guides without fixed model lists', () => {
  const guides = (file) => [...new Set(localLinks(pages[file]).filter((url) => url.startsWith('docs/') && url.endsWith('.md')))].sort()
  assert.deepEqual(guides('README.md'), guides('README_EN.md'))
  const providers = ['deepseek', 'glm', 'kimi', 'minimax', 'mimo', 'perplexity', 'qwen', 'qwen-ai', 'zai', 'arena']
  for (const file of ['README.md', 'README_EN.md']) {
    for (const provider of providers) assert.ok(guides(file).includes(`docs/providers/${provider}.md`), `${file}: ${provider}`)
    assert.match(pages[file], /GET \/v1\/models/)
    assert.doesNotMatch(pages[file], /deepseek-v\d|GLM-\d|Qwen\d|MiniMax-M\d/)
  }
  for (const guide of ['account-liveness.md', 'account-scheduling.md', 'claude-code.md', 'local-deployment.md', 'network-login-update.md', 'providers/conversation-continuity.md', 'release-validation.md']) {
    assert.ok(localLinks(pages['docs/README.md']).includes(guide), guide)
  }
})

test('quickstarts use reproducible dependencies, existing scripts, runtime ports, and distinct API bases', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.engines.node, '>=22.18.0')
  for (const file of ['README.md', 'README_EN.md']) {
    const page = pages[file]
    assert.match(page, /git clone https:\/\/github\.com\/ansujuner\/WebChat2api\.git/)
    assert.match(page, /npm ci\nnpm run build\nnpm start/)
    assert.match(page, /22\.18\+/)
    assert.match(page, /http:\/\/127\.0\.0\.1:<[^>]+>\/v1/)
    assert.match(page, /Claude Code \/ Anthropic[^\n]*`http:\/\/127\.0\.0\.1:<[^>]+>`/)
    assert.match(page, /网关 API Key|gateway API key/)
    assert.doesNotMatch(page, /\b8081\b|npm install|--no-sandbox|--disable-web-security/)
    for (const [, script] of page.matchAll(/npm run ([\w:-]+)/g)) assert.ok(pkg.scripts[script], script)
    assert.ok(fs.existsSync(path.join(root, 'scripts/start-local.ps1')))
  }
})

test('current screenshots use one shared gallery with an explicit demo-not-availability notice', () => {
  for (const file of ['README.md', 'README_EN.md', 'docs/README.md']) {
    const page = pages[file]
    const used = localLinks(page).filter((url) => url.includes('screenshots/')).map((url) => path.posix.basename(url))
    assert.deepEqual([...new Set(used)].sort(), screenshots.map((name) => `${name}.png`).sort())
    assert.match(page, /隔离演示数据|isolated demo data/)
    assert.match(page, /不代表真实可用性|do not establish real availability/)
  }
  assert.ok(localLinks(pages['README.md']).includes('docs/assets/overview.svg'))
  assert.ok(localLinks(pages['README_EN.md']).includes('docs/assets/overview-en.svg'))
})

test('availability, continuation, client tool, and Arena limits remain explicit in both languages', () => {
  const cn = pages['README.md']
  const en = pages['README_EN.md']
  for (const pattern of [/不自动重试/, /不会启用它/, /后续队列/, /客户端可以发送完整历史/, /无状态协议/, /X-Chat2API-Session-ID/, /两轮无副作用/, /本地估算/, /不支持图片编辑、批量或指定分辨率/, /安装包、签名状态与验证范围以发布页说明为准/]) assert.match(cn, pattern)
  for (const pattern of [/automatic retries/, /without enabling it/, /remaining queue/, /Clients may send full history/, /remain stateless/, /X-Chat2API-Session-ID/, /two real, harmless turns/, /local estimate/, /not editing, batches, or specified resolutions/, /See the release notes for available installers, signing status, and verification scope/]) assert.match(en, pattern)
})

test('native package downloads agree in both languages and disclose signing and runtime limits', () => {
  const downloads = (file) => links(pages[file]).filter((url) => /\/releases\/download\/source-v1\.6\.7\/Chat2API-/.test(url)).sort()
  const names = ['mac-arm64.dmg', 'mac-x64.dmg', 'x64.AppImage', 'x64.deb', 'arm64.AppImage', 'arm64.deb']
  const expected = names.map((name) => `https://github.com/ansujuner/WebChat2api/releases/download/source-v1.6.7/Chat2API-1.6.7-${name}`).sort()
  for (const file of ['README.md', 'README_EN.md']) {
    const page = pages[file]
    assert.deepEqual(downloads(file), expected)
    assert.ok(localLinks(page).includes('docs/platform-packages.md'))
    assert.match(page, /没有 Apple Developer ID 签名或公证|no Apple Developer ID signing or notarization/)
    assert.match(page, /可能阻止首次打开|may block their first launch/)
    assert.match(page, /不建议关闭沙箱|rather than disabling the sandbox/)
    assert.match(page, /登录目前仍仅支持 Windows|login still supports Windows only/)
    assert.match(page, /不代表真实账号或所有系统版本都经过验证|not real-account or all-OS-version certification/)
  }
})

test('attribution and asset rights are retained without stale upstream websites or private paths', () => {
  for (const [file, page] of Object.entries(pages)) {
    const targets = localLinks(page).map((url) => path.posix.basename(url))
    for (const notice of ['LICENSE', 'NOTICE', 'MODIFICATIONS.md', 'THIRD_PARTY_ASSETS.md']) assert.ok(targets.includes(notice), `${file}: ${notice}`)
    assert.match(page, /GPL-3\.0-or-later/)
    assert.doesNotMatch(page, /chat2api-doc\.vercel\.app|build\/icons\.png|[A-Z]:[\\/]Users[\\/]|\.audit-cache|artifacts\//i)
  }
  for (const file of ['README.md', 'README_EN.md', 'README_CN.md']) assert.match(pages[file], /Chat2API Team/)
  assert.match(pages['README.md'], /不因本项目而改为 GPL 授权/)
  assert.match(pages['README_EN.md'], /not relicensed under GPL/)
})
