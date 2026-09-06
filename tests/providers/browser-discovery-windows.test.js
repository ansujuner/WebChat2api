const test = require('node:test')
const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { realpath } = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.join(__dirname, '../..')
const enabled = process.platform === 'win32' && process.env.CHAT2API_TEST_NATIVE_BROWSER_DISCOVERY === '1'

// Opt-in: reads installed browser executables/signatures through the real Windows PowerShell.
// Does not launch a browser, create a profile, or read any account/user-browser storage.
test('native Windows discovery verifies installed browser despite inherited PowerShell 7 module paths', {
  skip: !enabled && 'Set CHAT2API_TEST_NATIVE_BROWSER_DISCOVERY=1 on Windows with official Chrome/Edge installed.',
  timeout: 70000,
}, async () => {
  const source = pathToFileURL(path.join(root, 'src/main/oauth/browserDiscovery.ts')).href
  const script = `import { findInstalledLoginBrowser } from ${JSON.stringify(source)}; console.log(JSON.stringify(await findInstalledLoginBrowser()));`
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^psmodulepath$/i.test(key)))
  const stdout = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: root, windowsHide: true, timeout: 65000, maxBuffer: 16384,
      env: { ...env, PSModulePath: path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'Modules') },
    }, (error, output) => error ? reject(new Error('Native signature-verified discovery failed; no browser was launched.')) : resolve(output))
  })
  const browser = JSON.parse(stdout.trim())
  assert.ok(['Chrome', 'Edge'].includes(browser.name))
  assert.ok(path.win32.isAbsolute(browser.executable))
  assert.equal((await realpath(browser.executable)).toLowerCase(), browser.executable.toLowerCase())
  assert.ok(/\\(?:Google\\Chrome|Microsoft\\Edge)\\Application\\(?:chrome|msedge)\.exe$/i.test(browser.executable))
})
