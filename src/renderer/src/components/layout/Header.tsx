import { useTranslation } from 'react-i18next'
import { Sun, Moon, Play, Pause } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import brandMark from '@/assets/brand/webchat2api.svg'
import { LanguageSwitcher } from './LanguageSwitcher'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { observeProxyStatus } from '@/lib/proxyStatusObserver'
import { useToast } from '@/hooks/use-toast'

export function Header() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { toggleTheme, isDark } = useTheme()
  const { language } = useSettingsStore()
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyLoading, setProxyLoading] = useState(false)
  const [port, setPort] = useState<number | null>(null)
  const [host, setHost] = useState('127.0.0.1')

  useEffect(() => {
    if (!window.electronAPI?.proxy?.onStatusChanged) return
    const observer = observeProxyStatus(window.electronAPI, status => {
      setProxyEnabled(status.isRunning)
      setPort(status.port)
      setHost(status.host || '127.0.0.1')
    }, error => console.error('Failed to read proxy status:', error))
    return () => observer.dispose()
  }, [])

  const handleToggleProxy = async () => {
    if (proxyLoading || port === null) return
    setProxyLoading(true)
    try {
      const success = proxyEnabled
        ? await window.electronAPI.proxy.stop()
        : await window.electronAPI.proxy.start()
      const status = await window.electronAPI.proxy.getStatus()
      setProxyEnabled(status.isRunning)
      setPort(status.port)
      setHost(status.host || '127.0.0.1')
      if (!success) throw new Error(language === 'zh-CN' ? '代理启动或停止失败，请查看日志。' : 'Proxy start or stop failed. Check Logs.')
    } catch (error) {
      toast({ title: t('common.error'), description: error instanceof Error ? error.message : String(error), variant: 'destructive' })
    } finally {
      setProxyLoading(false)
    }
  }

  return (
    <header className="app-header flex h-16 shrink-0 items-center justify-between gap-4 border-b px-5 drag-region">
      <div className="flex items-center gap-3 no-drag">
        <img src={brandMark} alt="" className="h-9 w-9 object-contain" />
        <div className="flex flex-col gap-0.5">
          <span className="text-base font-semibold leading-tight tracking-tight">WebChat2api</span>
          <span className="text-[11px] text-muted-foreground">{t('shell.subtitle')}</span>
        </div>
      </div>

      <div className="flex items-center gap-3 no-drag">
        <LanguageSwitcher />
        <button
          type="button"
          onClick={toggleTheme}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="theme-toggle"
          aria-label={isDark ? t('settings.themeLight') : t('settings.themeDark')}
          title={isDark ? t('settings.themeLight') : t('settings.themeDark')}
        >
          {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        <div className="flex items-center gap-2 rounded-lg border py-1 pl-3 pr-1" data-testid="proxy-status">
          <span className={cn('h-1.5 w-1.5 rounded-full', proxyLoading ? 'bg-amber-500 animate-pulse' : proxyEnabled ? 'bg-[var(--accent-primary)]' : 'bg-muted-foreground')} />
          <div className="hidden min-w-0 flex-col sm:flex">
            <span className="text-[10px] leading-tight text-muted-foreground">
              {port === null ? t('shell.waitingStatus') : proxyEnabled ? t('dashboard.running') : t('dashboard.stopped')}
            </span>
            <span className="font-mono text-xs">{port === null ? '—' : `${host}:${port}`}</span>
          </div>
          <button type="button" onClick={handleToggleProxy} disabled={proxyLoading || port === null}
            className="flex h-8 w-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={proxyEnabled ? t('proxyStatus.stop') : t('proxyStatus.start')}
            title={proxyEnabled ? t('proxyStatus.stop') : t('proxyStatus.start')} data-testid="proxy-toggle">
            {proxyLoading ? <span className="text-xs">…</span> : proxyEnabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </header>
  )
}
