import { useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, CheckCircle, Clock, Users, RefreshCw, ArrowUpRight, Copy, Plug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  StatsCard,
  ProviderStatusCard,
  RequestChart,
  QuickActions,
  RecentActivity,
} from '@/components/dashboard'
import { useDashboardStore } from '@/stores/dashboardStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { localProxyOrigin } from '@/lib/proxyStatusObserver'
import { useToast } from '@/hooks/use-toast'

export function Dashboard() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const navigate = useNavigate()
  const {
    proxyStatus,
    stats,
    providers,
    activities,
    chartData,
    isLoading,
    error,
    lastUpdated,
    refreshData,
  } = useDashboardStore()
  const { proxyEnabled, setProxyEnabled } = useSettingsStore()
  const hasLoadedRef = useRef(false)

  useEffect(() => {
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true
      refreshData()
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      useDashboardStore.getState().refreshData()
    }, 60000)
    
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (proxyStatus) {
      setProxyEnabled(proxyStatus.isRunning)
    }
  }, [proxyStatus, setProxyEnabled])

  useEffect(() => {
    if (!window.electronAPI?.proxy?.onStatusChanged) return
    
    const unsubscribe = window.electronAPI.proxy.onStatusChanged((status) => {
      useDashboardStore.getState().setProxyStatus(status)
      setProxyEnabled(status.isRunning)
    })
    
    return unsubscribe
  }, [setProxyEnabled])

  const handleToggleProxy = useCallback(async () => {
    if (!window.electronAPI?.proxy) return
    
    try {
      if (proxyStatus?.isRunning) {
        await window.electronAPI.proxy.stop()
      } else {
        await window.electronAPI.proxy.start()
      }
      await refreshData()
    } catch (err) {
      console.error('Failed to toggle proxy:', err)
    }
  }, [proxyStatus, setProxyEnabled, refreshData])

  const handleAddAccount = useCallback(() => {
    navigate('/providers')
  }, [navigate])

  const handleToolCalling = useCallback(() => {
    navigate('/models?tab=prompts')
  }, [navigate])

  const handleViewLogs = useCallback(() => {
    navigate('/logs')
  }, [navigate])

  const handleActivityClick = useCallback((item: { id: string; type: string; title: string }) => {
    navigate('/logs?tab=request&highlight=' + item.id)
  }, [navigate])

  const isElectron = !!window.electronAPI
  const localOrigin = proxyStatus ? localProxyOrigin(proxyStatus) : null
  const baseUrl = localOrigin ? `${localOrigin}/v1` : null
  const handleCopyBaseUrl = async () => {
    if (!baseUrl) return
    try {
      await navigator.clipboard.writeText(baseUrl)
      toast({ title: t('dashboard.addressCopied') })
    } catch {
      toast({ title: t('dashboard.copyFailed'), variant: 'destructive' })
    }
  }

  return (
    <div className="dashboard-page mx-auto max-w-[1440px] space-y-6">
      <div className="grid gap-4 xl:grid-cols-[1.1fr_1fr]">
        <section className="dashboard-hero flex flex-col justify-between rounded-2xl border bg-card p-6 lg:p-7" aria-labelledby="dashboard-title">
          <div>
            <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('dashboard.eyebrow')}</p>
            <h1 id="dashboard-title" className="max-w-xl text-2xl font-semibold leading-snug tracking-tight lg:text-[28px]">{t('dashboard.heroTitle')}</h1>
            <p className="mt-3 max-w-xl text-sm leading-7 text-muted-foreground">{t('dashboard.heroDescription')}</p>
          </div>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button onClick={handleAddAccount}>{t('dashboard.manageAccounts')}<ArrowUpRight className="ml-2 h-4 w-4" /></Button>
            <Button variant="outline" onClick={() => navigate('/proxy')}>{t('dashboard.configureApi')}</Button>
          </div>
        </section>
        <section className="dashboard-connection rounded-2xl border bg-card p-6" aria-labelledby="connection-title">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
            <h2 id="connection-title" className="flex items-center gap-2 text-sm font-semibold"><Plug className="h-4 w-4 text-primary" />{t('dashboard.connectionTitle')}</h2>
            <span className={cn('rounded-md border px-2 py-1 text-[11px]', proxyStatus?.isRunning ? 'text-[var(--accent-primary)]' : 'text-muted-foreground')}>
              {proxyStatus ? (proxyStatus.isRunning ? t('dashboard.proxyRunning') : t('dashboard.proxyStopped')) : t('shell.waitingStatus')}
            </span>
          </div>
          <dl className="space-y-4">
            <div>
              <dt className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t('dashboard.openaiBaseUrl')}</dt>
              <dd className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/40 p-2.5">
                <code className="min-w-0 flex-1 break-all text-xs" data-testid="dashboard-base-url">{baseUrl || t('shell.waitingStatus')}</code>
                <button type="button" onClick={handleCopyBaseUrl} disabled={!baseUrl} aria-label={t('dashboard.copyAddress')} title={t('dashboard.copyAddress')}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"><Copy className="h-3.5 w-3.5" /></button>
              </dd>
            </div>
            <div>
              <dt className="mb-1 text-[11px] font-medium text-muted-foreground">{t('dashboard.anthropicEndpoint')}</dt>
              <dd><code className="break-all text-xs">{localOrigin ? `${localOrigin}/v1/messages` : t('shell.waitingStatus')}</code></dd>
            </div>
          </dl>
          <div className="mt-5 flex items-start justify-between gap-3 border-t pt-4">
            <p className="text-xs leading-5 text-muted-foreground">{t('dashboard.apiKeyHelp')}</p>
            <button type="button" onClick={() => navigate('/api-keys')} className="shrink-0 rounded text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t('dashboard.manageKeys')}<ArrowUpRight className="ml-1 inline h-3 w-3" /></button>
          </div>
        </section>
      </div>

      {!isElectron && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400">
          <p className="font-medium">{t('dashboard.browserMode')}</p>
          <p>{t('dashboard.browserModeDesc')}</p>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="dashboard-section-heading flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t('dashboard.overviewTitle')}</h2>
        <div className="flex items-center gap-3">
          {lastUpdated && <span className="text-[11px] text-muted-foreground">{t('dashboard.lastUpdated')}: {new Date(lastUpdated).toLocaleTimeString()}</span>}
          <Button variant="outline" size="sm" onClick={refreshData} disabled={isLoading}>
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', isLoading && 'animate-spin')} />{t('dashboard.refresh')}
          </Button>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatsCard
          title={t('dashboard.totalRequests')}
          value={stats.totalRequests.toLocaleString()}
          icon={Activity}
          trend={{
            value: stats.requestsTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
        <StatsCard
          title={t('dashboard.successRate')}
          value={`${stats.successRate}%`}
          icon={CheckCircle}
          trend={{
            value: stats.successRateTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
        <StatsCard
          title={t('dashboard.avgResponseTime')}
          value={`${stats.avgLatency}ms`}
          icon={Clock}
          trend={{
            value: stats.latencyTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
        <StatsCard
          title={t('dashboard.activeAccountCount')}
          value={stats.activeAccounts}
          icon={Users}
          trend={{
            value: stats.accountsTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RequestChart data={chartData} />
        </div>
        <div>
          <QuickActions
            proxyRunning={proxyStatus?.isRunning ?? proxyEnabled}
            onToggleProxy={handleToggleProxy}
            onAddAccount={handleAddAccount}
            onToolCalling={handleToolCalling}
            onViewLogs={handleViewLogs}
            isLoading={isLoading}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 items-stretch">
        <ProviderStatusCard providers={providers} />
        <RecentActivity
          activities={activities}
          onItemClick={handleActivityClick}
        />
      </div>
    </div>
  )
}
