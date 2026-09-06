const fs = require('node:fs')
const path = require('node:path')

// Never load native token/desktop COM APIs in launcher tests. Keep the actual
// process-result verifier, but all identity/desktop calls go through test blocks.
function installLauncherSecurityFixture(root, directory) {
  const source = fs.readFileSync(path.join(root, 'scripts/local-launch-security.ps1'), 'utf8')
  const verifier = source.slice(source.indexOf('function Assert-LocalLaunchedProcess'))
  if (!verifier.startsWith('function Assert-LocalLaunchedProcess')) throw new Error('missing result verifier')
  fs.writeFileSync(path.join(directory, 'scripts/local-launch-security.ps1'), `
function Get-LocalLauncherContext {
  param([int]$ProcessId = $PID)
  if (Test-Path variable:global:LauncherContextMock) { return (& $global:LauncherContextMock $ProcessId) }
  [pscustomobject]@{ UserSid = 'S-1-5-21-fixture'; SessionId = 1; Integrity = 8192; Elevated = $false }
}
function Get-LocalDesktopShell {
  param($ExpectedContext)
  if (Test-Path variable:global:DesktopShellMock) { return (& $global:DesktopShellMock $ExpectedContext) }
  throw 'COM desktop dispatch must be mocked in every test'
}
${verifier}
`)
  fs.copyFileSync(path.join(root, 'scripts/start-local-user.ps1'), path.join(directory, 'scripts/start-local-user.ps1'))
}

module.exports = { installLauncherSecurityFixture }
