#Requires -Version 5.1
<# Launch Claude Code against this gateway without modifying global Claude settings. #>
[CmdletBinding()]
param(
    [string]$Model = 'deepseek-v4-flash',
    [string]$BaseUrl,
    [Security.SecureString]$ApiKey,
    [switch]$NoAuth,
    [string[]]$ClaudeArguments = @()
)
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Model)) { throw 'Choose a model ID shown in Chat2API.' }
$claude = Get-Command claude.exe, claude.cmd, claude -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $claude) { throw 'Claude Code is not on PATH. Install it using the official Claude Code setup guide, then run this launcher again.' }
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
    throw 'Specify -BaseUrl using the running address shown in Chat2API (without /v1). The launcher does not guess port 8080 or 8081.'
}
$uri = [Uri]$BaseUrl
if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
    throw 'BaseUrl must be an HTTP(S) origin, without credentials, query or fragment.'
}
if ($uri.AbsolutePath.Trim('/') -ne '') { throw 'BaseUrl must not include /v1; Claude Code adds /v1/messages itself.' }
if ($uri.Scheme -eq 'http' -and -not $uri.IsLoopback) { throw 'Use HTTPS for a remote gateway, or HTTP on localhost.' }
if (-not $NoAuth -and -not $ApiKey) { $ApiKey = Read-Host 'Enter the Chat2API proxy API Key (not a provider login token)' -AsSecureString }
if (-not $NoAuth -and $ApiKey.Length -eq 0) { throw 'A proxy API Key is required. Use -NoAuth only when proxy authentication is disabled.' }
$key = 'chat2api-local'
if ($ApiKey) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ApiKey)
    try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
$updates = @{
    ANTHROPIC_BASE_URL = $BaseUrl.TrimEnd('/')
    ANTHROPIC_AUTH_TOKEN = $key
    ANTHROPIC_API_KEY = $null
    ANTHROPIC_CUSTOM_HEADERS = $null
    CLAUDE_CODE_USE_BEDROCK = $null
    CLAUDE_CODE_USE_VERTEX = $null
    CLAUDE_CODE_USE_FOUNDRY = $null
    ANTHROPIC_MODEL = $Model
    ANTHROPIC_DEFAULT_OPUS_MODEL = $Model
    ANTHROPIC_DEFAULT_SONNET_MODEL = $Model
    ANTHROPIC_DEFAULT_HAIKU_MODEL = $Model
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    ENABLE_TOOL_SEARCH = 'false'
}
$before = @{}
try {
    foreach ($name in $updates.Keys) {
        $before[$name] = @{ Exists = (Test-Path -LiteralPath "Env:$name"); Value = [Environment]::GetEnvironmentVariable($name, 'Process') }
        if ($null -eq $updates[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($name, $updates[$name], 'Process') }
    }
    Write-Host "Claude Code gateway: $BaseUrl ; actual requested model: $Model"
    & $claude.Source @ClaudeArguments
    if ($LASTEXITCODE -ne 0) { throw "Claude Code exited with code $LASTEXITCODE." }
} finally {
    foreach ($name in $before.Keys) {
        if ($before[$name].Exists) { [Environment]::SetEnvironmentVariable($name, $before[$name].Value, 'Process') }
        else { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
    }
    $key = $null
    $updates.ANTHROPIC_AUTH_TOKEN = $null
}
