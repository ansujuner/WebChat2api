import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, FlaskConical, Settings2, Wrench, XCircle } from 'lucide-react'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  P0_TOOL_CLIENT_ADAPTERS,
  P0_TOOL_PROVIDER_SUPPORT,
  type ToolCallingConfig,
  type ToolCallingModeSetting,
  type ToolClientAdapterId,
} from '../../../../shared/toolCalling'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useProxyStore } from '@/stores/proxyStore'
import { toolSmokePresentation } from '@/lib/toolSmokePresentation'

type ToolCallingUpdate = Omit<Partial<ToolCallingConfig>, 'advanced'> & { advanced?: Partial<ToolCallingConfig['advanced']> }

function mergeToolCallingConfig(
  config: ToolCallingConfig,
  updates: ToolCallingUpdate,
): ToolCallingConfig {
  return {
    ...config,
    ...updates,
    advanced: {
      ...config.advanced,
      ...updates.advanced,
    },
    enabled: updates.mode === 'off' ? false : updates.enabled ?? config.enabled,
  }
}

export function ToolCallingPanel() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { appConfig, saveAppConfig } = useProxyStore()
  const [smokeStatus, setSmokeStatus] = useState<'not_run' | 'running' | 'pass' | 'failed' | 'blocked'>('not_run')
  const [smokeMessage, setSmokeMessage] = useState('')
  const [smokeView, setSmokeView] = useState<ReturnType<typeof toolSmokePresentation> | null>(null)
  const smokeRunning = useRef(false)
  const [smokeModels, setSmokeModels] = useState<Array<{model:string;providerId:string;providerName:string}>>([])
  const [smokeSelection, setSmokeSelection] = useState('auto')
  const config = appConfig?.toolCallingConfig ?? DEFAULT_TOOL_CALLING_CONFIG
  useEffect(() => {
    let active = true
    window.electronAPI?.toolCalling?.getStatus().then(status => {
      if (active) setSmokeModels(status.models ?? [])
    }).catch(() => { if (active) setSmokeMessage('toolCalling.smoke.loadFailed') })
    return () => { active = false }
  }, [t])
  const clientAdapters = P0_TOOL_CLIENT_ADAPTERS.filter(
    (adapter) => adapter.id === 'standard-openai-tools' || adapter.id === 'cherry-studio-mcp',
  )

  const selectedClient = useMemo(
    () => clientAdapters.find((adapter) => adapter.id === config.clientAdapterId),
    [config.clientAdapterId],
  )

  const saveConfig = (updates: ToolCallingUpdate) => {
    if (!appConfig) return
    saveAppConfig({ toolCallingConfig: mergeToolCallingConfig(config, updates) })
  }

  const runSmoke = async () => {
    if (smokeRunning.current) return
    smokeRunning.current = true
    setSmokeStatus('running')
    setSmokeMessage('')
    setSmokeView(null)
    try {
      const selected = smokeModels.find(item => `${item.providerId}/${item.model}` === smokeSelection)
      if (smokeSelection !== 'auto' && !selected) {
        setSmokeStatus('blocked')
        setSmokeMessage('toolCalling.smoke.modelUnavailable')
        return
      }
      const result = await window.electronAPI?.toolCalling?.runSmoke?.({
        clientAdapterId: config.clientAdapterId,
        ...(selected ? {model: selected.model, providerId: selected.providerId} : {}),
      })
      const view = toolSmokePresentation(result)
      setSmokeView(view)
      setSmokeStatus(view.status)
      setSmokeMessage(view.messageKey)
    } catch {
      setSmokeStatus('blocked')
      setSmokeMessage('toolCalling.smoke.unavailable')
    } finally {
      smokeRunning.current = false
    }
  }

  const enabled = config.enabled && config.mode !== 'off'

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2">
              <Wrench className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">{t('toolCalling.title')}</CardTitle>
              <CardDescription>{t('toolCalling.description')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant={enabled ? 'default' : 'destructive'}>
            {enabled ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            <AlertDescription>
              {enabled ? t('toolCalling.statusEnabled') : t('toolCalling.statusDisabled')}
            </AlertDescription>
          </Alert>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('toolCalling.clientType')}</Label>
              <Select
                value={config.clientAdapterId}
                onValueChange={(value) => saveConfig({ clientAdapterId: value as ToolClientAdapterId })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {clientAdapters.map((adapter) => (
                    <SelectItem key={adapter.id} value={adapter.id}>{adapter.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {selectedClient ? t(selectedClient.descriptionKey) : t('toolCalling.clients.unknown')}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t('toolCalling.mode')}</Label>
              <Select
                value={config.mode}
                onValueChange={(value) => saveConfig({
                  mode: value as ToolCallingModeSetting,
                  enabled: value !== 'off',
                })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t('toolCalling.modes.off')}</SelectItem>
                  <SelectItem value="auto">{t('toolCalling.modes.auto')}</SelectItem>
                  <SelectItem value="force">{t('toolCalling.modes.force')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('toolCalling.providerMatrix')}</Label>
            <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-5">
              {P0_TOOL_PROVIDER_SUPPORT.map((provider) => (
                <div key={provider.providerId} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{provider.label}</span>
                    <Badge variant="secondary">{t('toolCalling.supported')}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div>
              <Label>{t('toolCalling.smoke.title')}</Label>
              <p className="text-xs text-muted-foreground">{t('toolCalling.smoke.description')}</p>
            </div>
            <Select value={smokeSelection} onValueChange={setSmokeSelection} disabled={smokeStatus === 'running'}>
              <SelectTrigger aria-label={t('toolCalling.smoke.model')}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t('toolCalling.smoke.autoModel')}</SelectItem>
                {smokeModels.map(item => <SelectItem key={`${item.providerId}/${item.model}`} value={`${item.providerId}/${item.model}`}>{item.providerName} · {item.model}</SelectItem>)}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Badge variant={smokeStatus === 'pass' ? 'default' : 'outline'}>
                {t(`toolCalling.smoke.${smokeStatus}`)}
              </Badge>
              <Button variant="outline" size="sm" onClick={runSmoke} disabled={smokeStatus === 'running'}>
                <FlaskConical className="mr-2 h-4 w-4" />
                {t('toolCalling.smoke.run')}
              </Button>
            </div>
            {smokeMessage && <p role="status" className="break-words text-xs text-muted-foreground">{t(smokeMessage)}</p>}
            {smokeView?.checks.length ? <ul className="space-y-1 text-xs text-muted-foreground">{smokeView.checks.map((check, index) =>
              <li key={`${check.stage}-${index}`}>{t(`toolCalling.smoke.stage.${check.stage}`)}：{t(check.success ? 'toolCalling.smoke.pass' : smokeStatus === 'blocked' ? 'toolCalling.smoke.blocked' : 'toolCalling.smoke.failed')}</li>
            )}</ul> : null}
            {smokeView?.retryAt && <p className="text-xs text-muted-foreground">{t('toolCalling.smoke.retryAt', { time: new Date(smokeView.retryAt).toLocaleString() })}</p>}
            {smokeStatus === 'blocked' && <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t('toolCalling.smoke.blockedHelp')}</p>
              <Button size="sm" variant="outline" onClick={() => navigate('/providers')}>{t('toolCalling.smoke.accountAction')}</Button>
            </div>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Settings2 className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">{t('toolCalling.advanced.title')}</CardTitle>
                <CardDescription>{t('toolCalling.advanced.description')}</CardDescription>
              </div>
            </div>
            <Switch
              checked={config.diagnosticsEnabled}
              onCheckedChange={(diagnosticsEnabled) => saveConfig({ diagnosticsEnabled })}
            />
          </div>
        </CardHeader>
        {config.diagnosticsEnabled && (
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>{t('toolCalling.advanced.promptPreview')}</Label>
                <p className="text-xs text-muted-foreground">{t('toolCalling.advanced.promptPreviewDesc')}</p>
              </div>
              <Switch
                checked={config.advanced.promptPreviewEnabled}
                onCheckedChange={(promptPreviewEnabled) => saveConfig({ advanced: { promptPreviewEnabled } })}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('toolCalling.advanced.customTemplate')}</Label>
              <Textarea
                className="min-h-[160px] font-mono text-xs"
                value={config.advanced.customPromptTemplate ?? ''}
                onChange={(event) => saveConfig({
                  advanced: { customPromptTemplate: event.target.value || undefined },
                })}
                placeholder={t('toolCalling.advanced.customTemplatePlaceholder')}
              />
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
