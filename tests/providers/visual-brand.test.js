const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const bytes = file => fs.readFileSync(path.join(root, file))

test('application artwork uses static locally authored vectors', () => {
  for (const file of ['src/renderer/src/assets/brand/webchat2api.svg', 'docs/assets/overview.svg', 'docs/assets/overview-en.svg']) {
    const svg = read(file)
    assert.match(svg, /<svg\b/)
    assert.doesNotMatch(svg, /<script|<foreignObject|\son\w+=|(?:href|src)=["']https?:/i)
  }
})

test('application PNG variants share one source and all sizes are valid', () => {
  const icon = bytes('build/icon.png')
  for (const file of ['build/icons.png', 'src/renderer/src/assets/icons/icons.png']) assert.deepEqual(bytes(file), icon)
  for (const [file, size] of [['build/icon.png', 512], ['src/renderer/favicon.png', 64]]) {
    const png = bytes(file)
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(png.readUInt32BE(16), size)
    assert.equal(png.readUInt32BE(20), size)
  }
})

test('Windows application icon contains correctly indexed PNG resolutions', () => {
  const ico = bytes('build/icon.ico')
  assert.equal(ico.readUInt16LE(2), 1)
  assert.equal(ico.readUInt16LE(4), 7)
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  for (let index = 0; index < sizes.length; index++) {
    const entry = 6 + index * 16
    assert.equal(ico[entry] || 256, sizes[index])
    const length = ico.readUInt32LE(entry + 8), start = ico.readUInt32LE(entry + 12)
    assert.ok(start + length <= ico.length)
    assert.equal(ico.subarray(start, start + 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(ico.readUInt32BE(start + 16), sizes[index])
  }
})

test('header About and tray share the new brand without remote image requests', () => {
  for (const file of ['components/layout/Header.tsx', 'pages/About.tsx', 'components/Tray/TrayView.tsx']) {
    const code = read(`src/renderer/src/${file}`)
    assert.match(code, /assets\/brand\/webchat2api\.svg/)
    assert.doesNotMatch(code, /assets\/icons\/icons\.png/)
  }
  assert.match(read('src/renderer/index.html'), /<html lang="zh-CN"/)
  assert.match(read('src/renderer/index.html'), /<title>WebChat2api<\/title>/)
})

function luminance(hex) {
  const channels = hex.match(/[a-f\d]{2}/gi).map(v => parseInt(v, 16) / 255)
    .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722
}

test('both palettes give body and secondary text WCAG AA contrast', () => {
  const css = read('src/renderer/src/index.css')
  for (const theme of ['light', 'dark']) {
    const block = css.match(new RegExp(`html\\[data-theme="${theme}"\\]\\s*\\{([^}]+)\\}`))[1]
    const values = Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/g)].map(m => [m[1], m[2]]))
    for (const background of ['bg-primary', 'bg-secondary']) {
      for (const text of ['text-primary', 'text-muted', 'text-dim']) {
        const colors = [luminance(values[background]), luminance(values[text])].sort((a, b) => b - a)
        assert.ok((colors[0] + .05) / (colors[1] + .05) >= 4.5, `${theme} ${text}/${background}`)
      }
    }
  }
})

test('visual refresh respects reduced motion and keyboard focus', () => {
  const css = read('src/renderer/src/index.css')
  assert.match(css, /prefers-reduced-motion:\s*reduce/)
  assert.match(css, /button:focus-visible/)
  assert.doesNotMatch(css, /animation:\s*float|backdrop-filter:\s*blur\((?:20|24|30)px\)/)
})

test('rebranding preserves compatibility identifiers and GPL notices', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.name, 'chat2api')
  assert.equal(pkg.build.appId, 'com.chat2api.manager')
  assert.equal(pkg.license, 'GPL-3.0-or-later')
  assert.ok(pkg.build.files.includes('NOTICE'))
  assert.match(read('THIRD_PARTY_ASSETS.md'), /not a grant of trademark rights/)
  assert.match(read('THIRD_PARTY_ASSETS.md'), /generate-brand-assets\.cjs/)
})
