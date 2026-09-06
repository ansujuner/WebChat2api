/** Local ad-hoc signature only. This is NOT an Apple Developer ID or notarization. */
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

async function main() {
  assert.equal(process.platform, 'darwin', 'Signing requires a native macOS runner')
  const source = path.resolve(process.argv[2])
  const app = fs.realpathSync(process.argv[3])
  const relative = path.relative(path.join(source, 'dist'), app)
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && app.endsWith('.app'))
  const { signAsync } = require(require.resolve('@electron/osx-sign', { paths: [source] }))
  const config = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
  await signAsync({
    app, platform: 'darwin', identity: '-', identityValidation: false,
    version: config.devDependencies.electron,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }),
  })
  console.log('Ad-hoc signature complete; Developer ID and notarization are not provided.')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
