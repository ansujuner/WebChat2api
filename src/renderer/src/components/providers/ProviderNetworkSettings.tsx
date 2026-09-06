import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useProvidersStore } from '@/stores/providersStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { Provider, ProviderNetworkProxyMode, ProviderNetworkStatus } from '@/types/electron'
import { normalizeProviderProxyUrl } from '../../../../shared/providerNetwork'

const normalizedMode = (provider: Provider) => provider.networkProxyMode || 'inherit'

/** A route preview is deliberately separate from account/connection testing. */
export function ProviderNetworkSettings({ provider }: { provider: Provider }) {
  const { t } = useTranslation()
  const globalMode = useSettingsStore(state => state.oauthProxyMode)
  const mode = normalizedMode(provider)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const [status, setStatus] = useState<ProviderNetworkStatus | null>(null)
  const [customEditor, setCustomEditor] = useState(false)
  const [proxyUrl, setProxyUrl] = useState(provider.networkProxyUrl || '')
  const customDraft = useRef(false)
  const draftUrl = useRef(provider.networkProxyUrl || '')
  const lifecycle = useRef(0)
  const mounted = useRef(false)
  const saveOperation = useRef<object | null>(null)
  const checkOperation = useRef(0)
  const checkBusy = useRef(false)

  useEffect(() => {
    mounted.current = true
    lifecycle.current += 1
    saveOperation.current = null
    setSaving(false)
    setFeedback(null)
    return () => {
      mounted.current = false
      lifecycle.current += 1
      saveOperation.current = null
      checkOperation.current += 1
    }
  }, [provider.id])

  useEffect(() => {
    customDraft.current = false
    draftUrl.current = provider.networkProxyUrl || ''
    setCustomEditor(false)
    setProxyUrl(provider.networkProxyUrl || '')
  }, [provider.id, mode, provider.networkProxyUrl])

  // A preview belongs to this saved provider route, never to a previous setting.
  useEffect(() => {
    checkOperation.current += 1
    checkBusy.current = false
    setChecking(false)
    setStatus(null)
  }, [provider.id, provider.apiEndpoint, provider.networkProxyUrl, mode, globalMode])

  const isCurrent = (generation: number) => mounted.current && lifecycle.current === generation
  const currentProvider = () => useProvidersStore.getState().providers.find(item => item.id === provider.id)

  const save = async (value: string) => {
    if (!['inherit', 'system', 'none', 'custom'].includes(value)) return
    if (saveOperation.current || (value === mode && value !== 'custom')) return
    let customUrl: string | undefined
    if (value === 'custom') {
      try { customUrl = normalizeProviderProxyUrl(draftUrl.current) } catch {
        setFeedback('provider.proxy.invalidUrl')
        return
      }
    }
    const before = currentProvider()
    if (!before || normalizedMode(before) !== mode || before.networkProxyUrl !== provider.networkProxyUrl) return
    const operation = {}
    const generation = lifecycle.current
    saveOperation.current = operation // Protect against two events in the same render.
    checkOperation.current += 1
    checkBusy.current = false
    setSaving(true)
    setChecking(false)
    setStatus(null)
    setFeedback(null)
    try {
      const updates: Partial<Provider> = { networkProxyMode: value as ProviderNetworkProxyMode, ...(customUrl ? { networkProxyUrl: customUrl } : {}) }
      const saved = await window.electronAPI.providers.update(provider.id, updates)
      if (!isCurrent(generation)) return
      if (!saved || saved.id !== provider.id || normalizedMode(saved) !== value || (customUrl && saved.networkProxyUrl !== customUrl)) throw new Error('save_failed')
      const latest = currentProvider()
      if (!latest || normalizedMode(latest) !== mode || latest.networkProxyUrl !== before.networkProxyUrl) {
        setFeedback('provider.proxy.saveChanged')
        return
      }
      // Do not overwrite unrelated fields with an older, whole-provider response.
      useProvidersStore.getState().updateProvider(provider.id, updates)
      customDraft.current = false
      setCustomEditor(false)
      setFeedback('provider.proxy.saved')
    } catch {
      if (isCurrent(generation)) setFeedback('provider.proxy.saveFailed')
    } finally {
      if (isCurrent(generation) && saveOperation.current === operation) {
        saveOperation.current = null
        setSaving(false)
      }
    }
  }

  const checkRoute = async () => {
    if (saveOperation.current || checkBusy.current || customDraft.current) return
    const before = currentProvider()
    if (!before || normalizedMode(before) !== mode) return
    const generation = lifecycle.current
    const operation = ++checkOperation.current
    const globalAtStart = useSettingsStore.getState().oauthProxyMode
    const expectedMode = mode === 'inherit' ? globalAtStart : mode
    checkBusy.current = true
    setChecking(true)
    setStatus(null)
    setFeedback(null)
    const stillCurrent = () => {
      const latest = currentProvider()
      return isCurrent(generation) && operation === checkOperation.current && !!latest
        && normalizedMode(latest) === mode && latest.apiEndpoint === before.apiEndpoint
        && latest.networkProxyUrl === before.networkProxyUrl
        && useSettingsStore.getState().oauthProxyMode === globalAtStart
    }
    try {
      const result = await window.electronAPI.providers.getNetworkStatus(provider.id)
      if (!stillCurrent()) return
      if (!result || result.mode !== expectedMode || !['direct', 'proxy', 'unknown'].includes(result.route)
        || (result.mode === 'none' && result.route === 'proxy')) throw new Error('invalid_route_status')
      setStatus({ mode: result.mode, route: result.route })
    } catch {
      if (stillCurrent()) setFeedback('provider.proxy.checkFailed')
    } finally {
      if (isCurrent(generation) && operation === checkOperation.current) {
        checkBusy.current = false
        setChecking(false)
      }
    }
  }

  const routeKey = status?.route === 'proxy' ? (status.mode === 'custom' ? 'resolvedCustomProxy' : 'resolvedProxy')
    : status?.route === 'unknown' ? 'routeUnknown'
      : status?.mode === 'system' ? 'systemDirect' : status?.mode === 'custom' ? 'customDirect' : 'direct'
  const effectiveMode = mode === 'inherit' ? globalMode : mode

  return (
    <section className="mt-4 space-y-2 border-t pt-3" data-testid={`provider-network-settings-${provider.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={`provider-network-mode-${provider.id}`} className="flex items-center gap-1.5 text-xs">
          <Globe className="h-3.5 w-3.5" />{t('provider.proxy.title')}
        </Label>
        <Select value={customEditor ? 'custom' : mode} disabled={saving} onValueChange={value => {
          if (saveOperation.current) return
          if (value === 'custom') { customDraft.current = true; setCustomEditor(true); setStatus(null); checkOperation.current += 1; checkBusy.current = false; setChecking(false); return }
          if (value === mode) { customDraft.current = false; draftUrl.current = provider.networkProxyUrl || ''; setCustomEditor(false); setProxyUrl(draftUrl.current); setFeedback(null); return }
          void save(value)
        }}>
          <SelectTrigger id={`provider-network-mode-${provider.id}`} data-testid={`provider-network-mode-${provider.id}`} className="h-8 w-[210px] text-xs" aria-label={t('provider.proxy.selectLabel', { name: provider.name })}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t('provider.proxy.inherit')}</SelectItem>
            <SelectItem value="system">{t('provider.proxy.system')}</SelectItem>
            <SelectItem value="none">{t('provider.proxy.none')}</SelectItem>
            <SelectItem value="custom">{t('provider.proxy.custom')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {(customEditor || mode === 'custom') && <div className="space-y-2">
        <Label className="text-xs" htmlFor={`provider-network-url-${provider.id}`}>{t('provider.proxy.urlLabel')}</Label>
        <Input id={`provider-network-url-${provider.id}`} data-testid={`provider-network-url-${provider.id}`} value={proxyUrl} disabled={saving} placeholder="http://127.0.0.1:7890" autoComplete="off" spellCheck={false} onChange={event => {
          if (saveOperation.current) return
          draftUrl.current = event.target.value; customDraft.current = true
          setProxyUrl(event.target.value); setCustomEditor(true); setFeedback(null); setStatus(null)
          checkOperation.current += 1; checkBusy.current = false; setChecking(false)
        }} />
        <p className="text-xs text-muted-foreground">{t('provider.proxy.urlHelp')}</p>
        {customEditor && <>
          <p className="text-xs text-amber-600 dark:text-amber-400">{t('provider.proxy.unsaved')}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={saving} data-testid={`provider-network-save-${provider.id}`} onClick={() => { void save('custom') }}>{t('provider.proxy.saveCustom')}</Button>
            <Button type="button" size="sm" variant="ghost" disabled={saving} data-testid={`provider-network-cancel-${provider.id}`} onClick={() => { if (saveOperation.current) return; customDraft.current = false; draftUrl.current = provider.networkProxyUrl || ''; setCustomEditor(false); setProxyUrl(draftUrl.current); setFeedback(null) }}>{t('common.cancel')}</Button>
          </div>
        </>}
      </div>}
      {mode === 'inherit' && <p className="text-xs text-muted-foreground">{t('provider.proxy.globalDefault', { mode: t(`provider.proxy.${effectiveMode}`) })}</p>}
      <p className="text-xs text-muted-foreground">{t('provider.proxy.scope')}</p>
      <Button type="button" size="sm" variant="outline" disabled={saving || checking || customEditor} data-testid={`provider-network-check-${provider.id}`} onClick={() => { void checkRoute() }}>
        {(saving || checking) && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
        {t(saving ? 'provider.proxy.saving' : checking ? 'provider.proxy.checking' : 'provider.proxy.checkRoute')}
      </Button>
      <div role="status" aria-live="polite" data-testid={`provider-network-status-${provider.id}`} className="space-y-1 text-xs">
        {feedback && <p className={feedback === 'provider.proxy.saved' ? 'text-muted-foreground' : 'text-destructive'}>{t(feedback)}</p>}
        {status && <p>{t(`provider.proxy.${routeKey}`)}</p>}
      </div>
      <p className="text-xs text-muted-foreground">{t('provider.proxy.routeOnly')}</p>
    </section>
  )
}
