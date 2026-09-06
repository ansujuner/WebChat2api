const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '../..')
const fixtureParent = path.join(root, 'logs', 'launcher-tests')
const windowsTest = process.platform === 'win32' ? test : test.skip
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`
const controlledNames = [
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', 'ENABLE_TOOL_SEARCH',
]
const envFingerprint = () => createHash('sha256').update(JSON.stringify(controlledNames.map(name => [name, process.env[name]]))).digest('hex')

function fixture(t, behavior = '$global:LASTEXITCODE = 0') {
  fs.mkdirSync(fixtureParent, { recursive: true })
  const dir = fs.mkdtempSync(path.join(fixtureParent, 'claude-'))
  const script = path.join(dir, 'start-claude-code.ps1')
  const fakeClaude = path.join(dir, 'fake-claude.ps1')
  fs.copyFileSync(path.join(root, 'scripts', 'start-claude-code.ps1'), script)
  fs.writeFileSync(fakeClaude, `
$global:childObserved = [pscustomobject]@{
  BaseUrl = $env:ANTHROPIC_BASE_URL
  TokenMatchesExpected = ($env:ANTHROPIC_AUTH_TOKEN -ceq $env:CHAT2API_TEST_EXPECTED_KEY)
  ApiKeyAbsent = (-not (Test-Path -LiteralPath 'Env:ANTHROPIC_API_KEY'))
  CustomHeadersAbsent = (-not (Test-Path -LiteralPath 'Env:ANTHROPIC_CUSTOM_HEADERS'))
  BedrockAbsent = (-not (Test-Path -LiteralPath 'Env:CLAUDE_CODE_USE_BEDROCK'))
  VertexAbsent = (-not (Test-Path -LiteralPath 'Env:CLAUDE_CODE_USE_VERTEX'))
  FoundryAbsent = (-not (Test-Path -LiteralPath 'Env:CLAUDE_CODE_USE_FOUNDRY'))
  Model = $env:ANTHROPIC_MODEL
  Opus = $env:ANTHROPIC_DEFAULT_OPUS_MODEL
  Sonnet = $env:ANTHROPIC_DEFAULT_SONNET_MODEL
  Haiku = $env:ANTHROPIC_DEFAULT_HAIKU_MODEL
  DisabledBetas = $env:CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  ToolSearch = $env:ENABLE_TOOL_SEARCH
  Arguments = @($args)
}
${behavior}
`, 'utf8')
  const initialFiles = Object.fromEntries(fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name), 'utf8')]))
  t.after(() => {
    const resolved = fs.realpathSync(dir)
    const allowed = fs.realpathSync(fixtureParent) + path.sep
    assert.ok(resolved.startsWith(allowed), 'cleanup target must remain within workspace launcher fixtures')
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return { dir, script, fakeClaude, initialFiles }
}

function runPowerShell(f, { args = '-Model fixture-model -BaseUrl http://127.0.0.1:8080 -ApiKey $secureKey', setup = '', installed = true, expectedToken } = {}) {
  const token = expectedToken ?? `fixture-only-${randomUUID()}`
  const beforeParent = envFingerprint()
  const source = `
$ErrorActionPreference = 'Stop'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$controlledNames = ${psQuote(JSON.stringify(controlledNames))} | ConvertFrom-Json
# Only test-owned environment values are observed. No Claude profile/settings are read.
foreach ($name in $controlledNames) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
function Get-Command {
  [CmdletBinding()]
  param([Parameter(Position=0)] [string[]]$Name)
  ${installed ? `[pscustomobject]@{ Source = ${psQuote(f.fakeClaude)} }` : 'return $null'}
}
function Read-Host { throw 'Unexpected interactive API-key prompt in isolated test' }
$global:hostMessages = @()
function Write-Host { param($Object) $global:hostMessages += [string]$Object }
function Start-Process { throw 'Unexpected real process launch' }
function Get-Snapshot {
  $result = [ordered]@{}
  foreach ($name in $controlledNames) {
    $result[$name] = [pscustomobject]@{ Exists = (Test-Path -LiteralPath "Env:$name"); Value = [Environment]::GetEnvironmentVariable($name, 'Process') }
  }
  return $result
}
function Get-FixtureFiles {
  # PowerShell may create its own runtime cache before the launcher is invoked.
  # Compare the fixture after runtime initialization, not against a virgin HOME.
  return @(Get-ChildItem -LiteralPath ${psQuote(f.dir)} -Recurse -File | Sort-Object FullName | ForEach-Object {
    [pscustomobject]@{ Path = $_.FullName; Length = $_.Length; LastWrite = $_.LastWriteTimeUtc.Ticks }
  })
}
${setup}
$before = Get-Snapshot
$secureKey = [Security.SecureString]::new()
foreach ($character in $env:CHAT2API_TEST_EXPECTED_KEY.ToCharArray()) { $secureKey.AppendChar($character) }
$global:childObserved = $null
$failure = $null
$beforeFiles = Get-FixtureFiles
try { & ${psQuote(f.script)} ${args} } catch { $failure = $_.Exception.Message }
[pscustomobject]@{ Before = $before; After = (Get-Snapshot); Child = $global:childObserved; Failure = $failure; HostContainsToken = (($global:hostMessages -join " ").Contains($env:CHAT2API_TEST_EXPECTED_KEY)); BeforeFiles = @($beforeFiles); AfterFiles = @(Get-FixtureFiles) } | ConvertTo-Json -Compress -Depth 6
`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', source], {
    encoding: 'utf8', cwd: f.dir, windowsHide: true, timeout: 30000,
    env: { ...process.env, CHAT2API_TEST_EXPECTED_KEY: token,
      USERPROFILE: f.dir, HOME: f.dir, APPDATA: path.join(f.dir, 'appdata'), LOCALAPPDATA: path.join(f.dir, 'localappdata'),
      CLAUDE_CONFIG_DIR: path.join(f.dir, 'claude-config'),
      PSModuleAnalysisCachePath: 'NUL',
    },
  })
  assert.equal(envFingerprint(), beforeParent, 'the Node parent environment is unchanged')
  assert.equal(result.status, 0, result.stderr)
  assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token), 'API key must never appear in console output')
  for (const [name, content] of Object.entries(f.initialFiles)) assert.equal(fs.readFileSync(path.join(f.dir, name), 'utf8'), content, 'fixture files remain unchanged')
  const output = JSON.parse(result.stdout)
  assert.equal(output.HostContainsToken, false, 'API key must never appear in host output')
  assert.deepEqual(output.AfterFiles, output.BeforeFiles, 'launcher must not write credentials/settings or additional files')
  for (const entry of output.AfterFiles) {
    assert.ok(path.resolve(entry.Path).startsWith(path.resolve(f.dir) + path.sep), 'only fixture files are inspected')
    // The NoAuth placeholder is intentionally present in the source; real test keys are not.
    if (token !== 'chat2api-local') assert.ok(!fs.readFileSync(entry.Path).includes(Buffer.from(token)), 'API key must never be saved to a file')
  }
  return output
}

windowsTest('Claude Code launcher passes isolated gateway/model/auth settings only during the child call', t => {
  const f = fixture(t)
  const actual = runPowerShell(f, { args: '-Model fixture-model -BaseUrl http://127.0.0.1:8080/ -ApiKey $secureKey -ClaudeArguments @("--print", "fixture with spaces")', setup: `
$env:ANTHROPIC_BASE_URL = 'https://prior.example.test'
$env:ANTHROPIC_AUTH_TOKEN = 'prior-token-fixture'
$env:ANTHROPIC_API_KEY = 'prior-key-fixture'
$env:ANTHROPIC_CUSTOM_HEADERS = 'X-Fixture: prior'
$env:CLAUDE_CODE_USE_BEDROCK = '1'
$env:CLAUDE_CODE_USE_VERTEX = '1'
$env:CLAUDE_CODE_USE_FOUNDRY = '1'
$env:ENABLE_TOOL_SEARCH = 'true'
` })
  assert.equal(actual.Failure, null)
  assert.deepEqual(actual.After, actual.Before)
  assert.deepEqual(actual.Child, { BaseUrl: 'http://127.0.0.1:8080', TokenMatchesExpected: true, ApiKeyAbsent: true,
    CustomHeadersAbsent: true, BedrockAbsent: true, VertexAbsent: true, FoundryAbsent: true,
    Model: 'fixture-model', Opus: 'fixture-model', Sonnet: 'fixture-model', Haiku: 'fixture-model',
    DisabledBetas: '1', ToolSearch: 'false', Arguments: ['--print', 'fixture with spaces'] })
})

windowsTest('Claude Code launcher restores absent variables by deleting them, including after child failure', t => {
  const f = fixture(t, "throw 'simulated Claude fixture failure'")
  const actual = runPowerShell(f)
  assert.equal(actual.Failure, 'simulated Claude fixture failure')
  assert.equal(actual.Child.TokenMatchesExpected, true)
  assert.deepEqual(actual.After, actual.Before)
  for (const entry of Object.values(actual.After)) assert.deepEqual(entry, { Exists: false, Value: null })
})

windowsTest('Claude Code launcher restores existing values after a nonzero child exit', t => {
  const f = fixture(t, '$global:LASTEXITCODE = 17')
  const actual = runPowerShell(f, { setup: "$env:ANTHROPIC_MODEL = 'prior-model'; $env:ANTHROPIC_AUTH_TOKEN = 'prior-fixture-token'" })
  assert.match(actual.Failure, /exited with code 17/)
  assert.deepEqual(actual.After, actual.Before)
  assert.equal(actual.After.ANTHROPIC_MODEL.Value, 'prior-model')
})

windowsTest('Claude Code launcher NoAuth uses only the documented local placeholder and never prompts', t => {
  const f = fixture(t)
  const actual = runPowerShell(f, { args: '-Model fixture-model -BaseUrl http://localhost:8080 -NoAuth', expectedToken: 'chat2api-local' })
  assert.equal(actual.Failure, null)
  assert.equal(actual.Child.TokenMatchesExpected, true)
  assert.deepEqual(actual.After, actual.Before)
})

windowsTest('Claude Code launcher rejects /v1 paths and remote cleartext HTTP before invoking Claude', t => {
  const f = fixture(t)
  for (const [url, message] of [['http://127.0.0.1:8080/v1', /must not include \/v1/], ['http://192.0.2.7:8080', /Use HTTPS for a remote gateway/]]) {
    const actual = runPowerShell(f, { args: `-Model fixture-model -BaseUrl ${psQuote(url)} -NoAuth` })
    assert.match(actual.Failure, message)
    assert.equal(actual.Child, null)
    assert.deepEqual(actual.After, actual.Before)
  }
})

windowsTest('Claude Code launcher reports a missing CLI without installing or invoking anything', t => {
  const f = fixture(t)
  const actual = runPowerShell(f, { installed: false, args: '-NoAuth' })
  assert.match(actual.Failure, /Claude Code is not on PATH.*official Claude Code setup guide/)
  assert.equal(actual.Child, null)
  assert.deepEqual(actual.After, actual.Before)
})

windowsTest('Claude Code launcher never guesses a default port', t => {
  const f = fixture(t)
  const actual = runPowerShell(f, { args: '-Model fixture-model -NoAuth' })
  assert.match(actual.Failure, /Specify -BaseUrl.*does not guess port 8080 or 8081/)
  assert.equal(actual.Child, null)
  assert.deepEqual(actual.After, actual.Before)
})
