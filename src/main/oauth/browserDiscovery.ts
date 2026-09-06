import { normalizeNetworkProxyConfig, type ProviderProxyConfig } from '../network/providerContext.ts'
import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

export interface InstalledLoginBrowser { name: 'Chrome' | 'Edge'; executable: string }

export function windowsBrowserCandidates(env: NodeJS.ProcessEnv = process.env): InstalledLoginBrowser[] {
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter((root): root is string => !!root && path.win32.isAbsolute(root))
  return ['Chrome', 'Edge'].flatMap(name => roots.map(root => ({
    name: name as InstalledLoginBrowser['name'],
    executable: path.win32.join(root, ...(name === 'Chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'])),
  }))).filter((candidate, index, all) => all.findIndex(other => other.executable.toLowerCase() === candidate.executable.toLowerCase()) === index)
}

export function browserChildEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Chromium uses OS proxy settings (or explicit direct mode), not inherited Node proxy/debug flags.
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(https?_proxy|all_proxy|no_proxy|electron_run_as_node|node_options|node_extra_ca_certs|sslkeylogfile|chrome_log_file|psmodulepath)$/i.test(key)))
}

function hasTrustedSignature(candidate: InstalledLoginBrowser, signal?: AbortSignal): Promise<boolean> {
  const systemRoot = process.env.SystemRoot
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) return Promise.resolve(false)
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  // Executable path is data in an environment variable, never interpolated into shell source.
  const script = "$ErrorActionPreference='Stop'; $s=Get-AuthenticodeSignature -LiteralPath $env:CHAT2API_BROWSER_VERIFY_PATH; @{status=[string]$s.Status; subject=[string]$s.SignerCertificate.Subject} | ConvertTo-Json -Compress"
  return new Promise(resolve => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 10000, maxBuffer: 16384, signal,
      // A parent PowerShell 7 can export incompatible module paths into Windows PowerShell 5.1.
      // Resolve signature/JSON cmdlets only from this trusted system shell's own modules.
      env: { ...browserChildEnvironment(), PSModulePath: path.win32.join(path.win32.dirname(powershell), 'Modules'), CHAT2API_BROWSER_VERIFY_PATH: candidate.executable },
    }, (error, stdout) => {
      if (error) { resolve(false); return }
      try {
        const result = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim())
        const publisher = candidate.name === 'Chrome' ? /(?:^|,\s*)O=Google (?:LLC|Inc\.)(?:,|$)/ : /(?:^|,\s*)O=Microsoft Corporation(?:,|$)/
        resolve(result.status === 'Valid' && typeof result.subject === 'string' && publisher.test(result.subject))
      } catch { resolve(false) }
    })
  })
}

export async function findInstalledLoginBrowser(signal?: AbortSignal): Promise<InstalledLoginBrowser> {
  if (process.platform !== 'win32') throw new Error('Automatic system-browser login currently supports Windows. Use the provider website and manual token import on this platform.')
  for (const candidate of windowsBrowserCandidates()) {
    if (signal?.aborted) throw new Error('Browser discovery was cancelled.')
    try {
      if (!(await stat(candidate.executable)).isFile()) continue
      const canonical = await realpath(candidate.executable)
      // Do not follow user-controlled links to an unrelated executable or PATH entry.
      if (canonical.toLowerCase() !== path.win32.resolve(candidate.executable).toLowerCase()) continue
      if (await hasTrustedSignature(candidate, signal)) return { ...candidate, executable: canonical }
    } catch { /* Missing/inaccessible installations are not usable browser candidates. */ }
  }
  throw new Error('No verified Google Chrome or Microsoft Edge installation was found. Install or repair the current official browser, or use manual token import.')
}

export function loginBrowserArguments(profileDirectory: string, proxy: ProviderProxyConfig | 'system' | 'none'): string[] {
  if (!path.isAbsolute(profileDirectory)) throw new Error('An isolated absolute browser profile path is required.')
  const config = normalizeNetworkProxyConfig(proxy)
  return [
    `--user-data-dir=${profileDirectory}`, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
    '--new-window', ...(config.mode === 'none' ? ['--no-proxy-server'] : config.mode === 'custom' ? [`--proxy-server=${config.url}`, '--proxy-bypass-list=<-loopback>'] : []), 'https://chat.deepseek.com/',
  ]
}
