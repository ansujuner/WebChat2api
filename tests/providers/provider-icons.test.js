const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, readdirSync } = require('node:fs')
const { resolve, basename } = require('node:path')
const { createHash } = require('node:crypto')
const vm = require('node:vm')
const ts = require('typescript')

const root = resolve(__dirname, '../..')
const assetDir = resolve(root, 'src/renderer/src/assets/providers')
const read = (path) => readFileSync(resolve(root, path), 'utf8')
const manifest = JSON.parse(readFileSync(resolve(assetDir, 'sources.json'), 'utf8'))
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex')
const registrySource = read('src/renderer/src/lib/providerIcons.ts')
const registryModule = { exports: {} }
vm.runInNewContext(ts.transpileModule(registrySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  exports: registryModule.exports,
  require: (path) => {
    assert.match(path, /^@\/assets\/providers\/[a-z-]+\.(?:svg|png|ico)$/)
    assert.ok(readFileSync(resolve(assetDir, basename(path))).length)
    return { default: path }
  },
})
const { providerIcons } = registryModule.exports

test('one immutable local icon map covers every built-in provider, including Arena and aliases', async () => {
  const { builtinProviders } = await import('../../src/main/providers/builtin/index.ts')
  const ids = builtinProviders.map(({ id }) => id).sort()
  assert.deepEqual(Object.keys(providerIcons).sort(), ids)
  assert.deepEqual(manifest.assets.map(({ providerId }) => providerId).sort(), ids)
  assert.equal(providerIcons.qwen, providerIcons['qwen-ai'])
  assert.equal(Object.isFrozen(providerIcons), true)
  assert.equal(Object.getPrototypeOf(providerIcons), null)
  for (const id of ['custom-test', 'constructor', 'toString', '__proto__']) {
    assert.equal(providerIcons[id], undefined, 'custom providers must use the UI fallback')
  }
})

test('every local brand image has verified first-party provenance and matching content hash', () => {
  assert.equal(manifest.schemaVersion, 1)
  const officialHosts = new Set([
    'fe-static.deepseek.com', 'chatglm.cn', 'www.kimi.com', 'agent.minimax.io',
    'img.alicdn.com', 'assets.alicdn.com', 'z-cdn.chatglm.cn',
    'docs.perplexity.ai', 'cdn.cnbj1.fds.api.mi-img.com', 'arena.ai',
  ])
  const documentation = read('THIRD_PARTY_ASSETS.md')
  for (const asset of manifest.assets) {
    assert.equal(new URL(asset.sourceUrl).protocol, 'https:')
    assert.ok(officialHosts.has(new URL(asset.sourceUrl).hostname))
    assert.equal(new URL(asset.sourcePage).protocol, 'https:')
    assert.equal(asset.retrievedAt, '2026-09-06')
    assert.match(asset.sourceSha256, /^[a-f\d]{64}$/)
    assert.match(asset.localSha256, /^[a-f\d]{64}$/)
    assert.match(asset.file, /^[a-z-]+\.(?:svg|png|ico)$/)
    assert.equal(providerIcons[asset.providerId], `@/assets/providers/${asset.file}`)
    const bytes = readFileSync(resolve(assetDir, asset.file))
    assert.ok(bytes.length > 100 && bytes.length < 128 * 1024)
    assert.equal(hash(bytes), asset.localSha256)
    if (asset.format !== 'svg') assert.equal(asset.localSha256, asset.sourceSha256)
    assert.ok(documentation.includes(asset.sourceUrl))
    assert.ok(documentation.includes(asset.sourcePage))
    assert.ok(asset.changes)
  }
  assert.match(documentation, /not a grant of trademark rights/)
  assert.match(documentation, /GPL-3\.0/)
  const expectedFiles = new Set(['sources.json', 'model-mapping.svg', ...manifest.assets.map(a => a.file)])
  assert.deepEqual(readdirSync(assetDir).sort(), [...expectedFiles].sort(), 'remove superseded unreferenced brand marks')
})

test('raster assets are genuine bounded PNG or ICO images, never a successful HTML fallback', () => {
  for (const asset of manifest.assets.filter(a => a.format !== 'svg')) {
    const bytes = readFileSync(resolve(assetDir, asset.file))
    if (asset.format === 'png') {
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.equal(bytes.toString('ascii', 12, 16), 'IHDR')
      for (const dimension of [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]) {
        assert.ok(dimension >= 32 && dimension <= 512)
      }
      assert.equal(bytes.subarray(-8).toString('hex'), '49454e44ae426082')
    } else {
      assert.equal(bytes.readUInt32LE(0), 65536)
      const count = bytes.readUInt16LE(4)
      assert.ok(count > 0 && count <= 16)
      for (let i = 0; i < count; i++) {
        const entry = 6 + i * 16
        const length = bytes.readUInt32LE(entry + 8)
        const start = bytes.readUInt32LE(entry + 12)
        assert.ok(start >= 6 + 16 * count && length > 0 && start + length <= bytes.length)
        assert.ok((bytes[entry] || 256) >= 32 && (bytes[entry + 1] || 256) >= 32)
      }
    }
  }
})

test('official SVGs contain only inert vector geometry and no external content', () => {
  const tags = new Set(['svg', 'g', 'path', 'polygon'])
  const attributes = new Set([
    'xmlns', 'width', 'height', 'viewBox', 'fill', 'fill-opacity', 'fill-rule',
    'id', 'd', 'points', 'stroke', 'stroke-width', 'stroke-miterlimit',
  ])
  for (const asset of manifest.assets.filter(a => a.format === 'svg')) {
    const source = readFileSync(resolve(assetDir, asset.file), 'utf8')
    assert.match(source, /^<svg\s/)
    assert.match(source, /<\/svg>\s*$/)
    assert.doesNotMatch(source, /<!|<\?|\b(?:href|style|class|on\w+)\s*=|url\s*\(|javascript:|data:|foreignObject|script|animation/i)
    const stack = []
    let end = 0
    for (const match of source.matchAll(/<(\/?)([A-Za-z]+)([^<>]*?)(\/?)>/g)) {
      assert.equal(source.slice(end, match.index).trim(), '', 'no text, entities, or unparsed markup')
      end = match.index + match[0].length
      const [, close, tag, attrs, selfClose] = match
      assert.ok(tags.has(tag), tag)
      if (close) {
        assert.equal(stack.pop(), tag)
        assert.equal(attrs.trim(), '')
        continue
      }
      if (!selfClose) stack.push(tag)
      let attrEnd = 0
      for (const attr of attrs.matchAll(/\s+([\w:-]+)="([^"]*)"/g)) {
        assert.equal(attrs.slice(attrEnd, attr.index).trim(), '')
        attrEnd = attr.index + attr[0].length
        assert.ok(attributes.has(attr[1]), attr[1])
        if (attr[1] === 'xmlns') assert.equal(attr[2], 'http://www.w3.org/2000/svg')
        else assert.doesNotMatch(attr[2], /[&<>]|https?:|\/\/|\\/)
      }
      assert.equal(attrs.slice(attrEnd).trim(), '')
    }
    assert.equal(source.slice(end).trim(), '')
    assert.deepEqual(stack, [])
  }
})

test('all brand-bearing UI locations share the map, while app artwork and navigation remain separate', () => {
  for (const component of [
    'providers/ProviderCard.tsx', 'providers/AddProviderDialog.tsx',
    'providers/LoginGuideDialog.tsx', 'models/ModelList.tsx',
  ]) {
    const source = read(`src/renderer/src/components/${component}`)
    assert.match(source, /import \{ providerIcons \} from '@\/lib\/providerIcons'/)
    assert.doesNotMatch(source, /const providerIcons\s*[:=]/)
    assert.doesNotMatch(source, /from '@\/assets\/providers\/(?!model-mapping\.)/)
    assert.equal(ts.transpileModule(source, {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
      fileName: component,
      reportDiagnostics: true,
    }).diagnostics?.length || 0, 0)
  }
  for (const file of ['pages/About.tsx', 'components/layout/Header.tsx']) {
    assert.match(read(`src/renderer/src/${file}`), /import logoIcon from '@\/assets\/icons\/icons\.png'/)
  }
  const sidebar = read('src/renderer/src/components/layout/Sidebar.tsx')
  assert.match(sidebar, /lucide-react/)
  assert.doesNotMatch(sidebar, /providerIcons|assets\/providers/)
})
