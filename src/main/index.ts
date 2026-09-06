// Must precede any modules that create Axios instances during import.
import './network/bootstrap'
import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { createWindow, getMainWindow, loadUrl, loadFile, openDevTools } from './window/manager'
import { createTrayManager, TrayManager } from './tray/TrayManager'
import { registerIpcHandlers } from './ipc/handlers'
import { UpdaterManager } from './updater'
import { storeManager } from './store/store'
import { mkdir, writeFile } from 'node:fs/promises'
import { startProxyService } from './ipc/handlers'
import { runLocalProbe, runDeepSeekModesProbe } from './diagnostics/localProbe'
import { runDeepSeekLoginProbe } from './diagnostics/deepseekLoginProbe'
import { runZaiAccountLoginProbe } from './diagnostics/zaiAccountLoginProbe'
import { zaiAccountBrowserManager } from './oauth/zaiAccountBrowser'
import { externalBrowserLoginManager } from './oauth/externalBrowserLogin'
import { runToolCallingSmoke } from './diagnostics/toolCallingSmoke'
import { arenaBrowserManager } from './arena/browserManager'
import { initializeArenaRateLimits } from './arena/rateLimit'
import { runArenaLoginProbe, runArenaProbe } from './diagnostics/arenaProbe'

// Prevent uncaught exceptions from crashing the app
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason)
})

// Use the supported runtime defaults. The old Electron 33 JIT/GPU workaround
// must not disable browser capabilities or sandboxing on the upgraded engine.

declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean
    }
  }
}

const gotTheLock = app.requestSingleInstanceLock()
const commandOnly = process.argv.some(arg => arg.startsWith('--chat2api-probe=') || arg === '--chat2api-quit')

if (!gotTheLock || commandOnly) {
  // A diagnostic helper must never boot another app/profile if the existing
  // instance exits between its process check and single-instance dispatch.
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    enqueueLocalCommand(argv)
    const mainWindow = getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore()
      }
      mainWindow.show()
      mainWindow.focus()
    }
  })

  initializeApp()
}

let trayManager: TrayManager | null = null
let appReadyForCommands = false
let localCommands: Promise<void> = Promise.resolve()
let pendingLocalCommands: string[][] = []
let loginShutdownPending = false
let loginShutdownComplete = false

// Explicit local diagnostics only. Normal launches never generate provider chats.
function enqueueLocalCommand(argv: string[]): void {
  if (!appReadyForCommands) {
    pendingLocalCommands = [...pendingLocalCommands, [...argv]]
    return
  }
  if (argv.includes('--chat2api-quit')) {
    app.quit()
    return
  }
  localCommands = localCommands.then(async () => {
    const mode = argv.find(arg => /^--chat2api-probe=(catalog|live|stream|deepseek|login|tools|arena-login|arena-relogin|arena|accounts|zai-login|zai-liveness|accounts-status|network)$/.test(arg))?.split('=')[1]
    if (!mode) return
    const outputDirectory = app.isPackaged ? join(app.getPath('userData'), 'diagnostics') : join(app.getAppPath(), 'artifacts')
    const reportPath = join(outputDirectory, `proxy-${mode}-probe.json`)
    const options = { live: !['catalog', 'login', 'arena-login', 'arena-relogin', 'zai-login', 'accounts-status', 'network'].includes(mode), stream: mode === 'stream', protocol: mode === 'stream' ? 'anthropic' as const : 'openai' as const }
    try {
      // Check report writability before any real generation.
      await mkdir(outputDirectory, { recursive: true })
      await writeFile(reportPath, JSON.stringify({ status: 'running', checkedAt: new Date().toISOString() }), 'utf8')
      if (mode === 'arena-relogin') {
        const { runArenaAccountLoginProbe } = await import('./diagnostics/arenaAccountLoginProbe')
        const save = (report: object) => writeFile(reportPath, JSON.stringify({ ...report, checkedAt: new Date().toISOString() }, null, 2), 'utf8')
        await save(await runArenaAccountLoginProbe(save))
        return
      }
      if (mode === 'network') {
        const { runProviderNetworkProbe } = await import('./diagnostics/providerNetworkProbe')
        await writeFile(reportPath, JSON.stringify({ ...options, ...await runProviderNetworkProbe(), checkedAt: new Date().toISOString() }, null, 2), 'utf8')
        return
      }
      if (mode === 'login' || mode === 'arena-login' || mode === 'zai-login') {
        const save = (report: unknown) => writeFile(reportPath, JSON.stringify({ ...(report as object), checkedAt: new Date().toISOString() }, null, 2), 'utf8')
        await save(await (mode === 'login' ? runDeepSeekLoginProbe(save) : mode === 'zai-login' ? runZaiAccountLoginProbe(save) : runArenaLoginProbe(save)))
        return
      }
      if (mode === 'accounts' || mode === 'zai-liveness' || mode === 'accounts-status') {
        const { runAccountLivenessProbe, getAccountLiveness, summarizeAccountLivenessJob } = await import('./diagnostics/accountLiveness')
        const current = mode === 'accounts-status' ? await getAccountLiveness() : null
        const report = mode === 'accounts-status' ? (current ? summarizeAccountLivenessJob(current) : { status: 'no_result' })
          : await runAccountLivenessProbe(mode === 'zai-liveness' ? { providerId: 'zai' } : {})
        await writeFile(reportPath, JSON.stringify({ ...options, ...report, checkedAt: new Date().toISOString() }, null, 2), 'utf8')
        return
      }
      await startProxyService()
      if (mode === 'arena') {
        await writeFile(reportPath, JSON.stringify({ ...options, ...await runArenaProbe(), checkedAt: new Date().toISOString() }, null, 2), 'utf8')
        return
      }
      if (mode === 'tools') {
        const result = await runToolCallingSmoke({})
        await writeFile(reportPath, JSON.stringify({ ...options, result, status: result.success ? 'passed' : 'needs_attention', checkedAt: new Date().toISOString() }, null, 2), 'utf8')
        return
      }
      const report = mode === 'deepseek' ? await runDeepSeekModesProbe() : await runLocalProbe(options)
      await writeFile(reportPath, JSON.stringify({ ...report, checkedAt: new Date().toISOString() }, null, 2), 'utf8')
      console.log(`[Diagnostics] ${mode}: ${report.status}; port ${report.port}`)
    } catch {
      console.error('[Diagnostics] Local probe failed; no credentials or upstream response were exported.')
      try {
        await writeFile(reportPath, JSON.stringify({ ...options, status: 'local_probe_failed', checkedAt: new Date().toISOString() }), 'utf8')
      } catch {
        console.error('[Diagnostics] Report location is not writable.')
      }
    }
  })
}

async function initializeApp(): Promise<void> {
  app.on('ready', async () => {
    await setupApp()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('activate', () => {
    const mainWindow = getMainWindow()
    if (!mainWindow) {
      createWindow()
    } else {
      mainWindow.show()
    }
  })

  app.on('before-quit', (event) => {
    // Let the app-owned browser close and remove its temporary profile before
    // Electron exits. Repeated quit events must not race the same cleanup.
    if (!loginShutdownComplete && (loginShutdownPending || externalBrowserLoginManager.isWindowOpen() || arenaBrowserManager.hasOpenBrowsers() || zaiAccountBrowserManager.hasOpenBrowsers())) {
      event.preventDefault()
      if (!loginShutdownPending) {
        loginShutdownPending = true
        void Promise.all([externalBrowserLoginManager.cancelAndWait(), arenaBrowserManager.destroy(), zaiAccountBrowserManager.destroy()]).catch(() => {
          console.error('[OAuth] The isolated login browser could not finish closing before exit.')
        }).finally(() => {
          loginShutdownComplete = true
          app.quit()
        })
      }
      return
    }
    app.isQuitting = true
    trayManager?.destroy()
  })

  app.on('will-quit', () => {
    cleanup()
  })
}

async function setupApp(): Promise<void> {
  try { initializeArenaRateLimits(app.getPath('userData')) }
  catch { console.error('[Arena] Quota storage is unavailable; Arena submissions remain disabled until app data is restored.') }
  const mainWindow = createWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'WebChat2api',
    show: false,
  })

  await registerIpcHandlers(mainWindow)

  trayManager = createTrayManager(mainWindow)

  await loadAppContent(mainWindow)

  appReadyForCommands = true
  const queued = pendingLocalCommands
  pendingLocalCommands = []
  queued.forEach(enqueueLocalCommand)

  if (process.env.NODE_ENV === 'development') {
    openDevTools()
  }
}

async function loadAppContent(mainWindow: BrowserWindow): Promise<void> {
  const isDev = process.env.NODE_ENV === 'development'

  if (isDev) {
    try {
      await loadUrl(process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173')
    } catch (error) {
      console.error('Failed to load development server:', error)
    }
  } else {
    try {
      await loadFile(join(__dirname, '../renderer/index.html'))
    } catch (error) {
      console.error('Failed to load production files:', error)
    }
  }
}

function cleanup(): void {
  console.log('Application is exiting, performing cleanup...')
  storeManager.flushPendingWrites()
  const updaterManager = UpdaterManager.getInstance()
  updaterManager.destroy()
}

export function restartApp(): void {
  app.relaunch()
  app.quit()
}

export function getAppVersion(): string {
  return app.getVersion()
}

export function isAppQuitting(): boolean {
  return app.isQuitting ?? false
}

export { getMainWindow }
