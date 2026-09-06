import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Download, Loader2, Plus, X } from 'lucide-react'
import type { CustomProviderFormData } from '@/types/electron'
export type { CustomProviderFormData } from '@/types/electron'

interface CustomProviderFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (data: CustomProviderFormData) => Promise<void>
  initialData?: Partial<CustomProviderFormData>
  providerId?: string
  onFetchModels?: () => Promise<string[]>
}

const secretHeader = (key: string) => /authorization|cookie|api[-_]?key|token|secret|password/i.test(key)
const initialForm = (data?: Partial<CustomProviderFormData>): CustomProviderFormData => ({
  name: data?.name || '', authType: 'token', apiEndpoint: data?.apiEndpoint || '',
  headers: { ...(data?.headers || { 'Content-Type': 'application/json' }) }, description: data?.description || '',
  supportedModels: [...(data?.supportedModels || [])],
  credentialFields: [{ name: 'apiKey', label: 'API Key', type: 'password', required: data?.credentialFields?.find(field => field.name === 'apiKey')?.required !== false }],
})

export function CustomProviderForm({ open, onOpenChange, onSubmit, initialData, providerId, onFetchModels }: CustomProviderFormProps) {
  const { t } = useTranslation()
  const [formData, setFormData] = useState(() => initialForm(initialData))
  const [modelsText, setModelsText] = useState((initialData?.supportedModels || []).join('\n'))
  const [newHeaderKey, setNewHeaderKey] = useState('')
  const [newHeaderValue, setNewHeaderValue] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'save' | 'models' | null>(null)
  const [notice, setNotice] = useState('')
  const operation = useRef(false)
  const revision = useRef(0)

  useEffect(() => {
    revision.current += 1
    if (open) {
      setFormData(initialForm(initialData)); setModelsText((initialData?.supportedModels || []).join('\n'))
      setNewHeaderKey(''); setNewHeaderValue(''); setErrors({}); setNotice(''); setBusy(null); operation.current = false
    }
    return () => { revision.current += 1 }
  }, [open, providerId])

  const handleAddHeader = () => {
    const key = newHeaderKey.trim(), value = newHeaderValue.trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || !value || /[\r\n]/.test(value) || secretHeader(key)) {
      setErrors(previous => ({ ...previous, headers: t('customProvider.headerInvalid') })); return
    }
    setFormData(previous => ({ ...previous, headers: { ...previous.headers, [key]: value } }))
    setNewHeaderKey(''); setNewHeaderValue(''); setErrors(previous => ({ ...previous, headers: '' }))
  }

  const handleSubmit = async () => {
    if (operation.current) return
    const nextErrors: Record<string, string> = {}
    if (!formData.name.trim()) nextErrors.name = t('providers.providerNameRequired')
    try {
      const url = new URL(formData.apiEndpoint.trim())
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error()
    } catch { nextErrors.apiEndpoint = t('customProvider.urlInvalid') }
    const models = [...new Set(modelsText.split(/[\n,]/).map(value => value.trim()).filter(Boolean))]
    if (models.length > 10000 || models.some(model => model.length > 256 || /[\x00-\x1f\x7f]/.test(model))) nextErrors.models = t('customProvider.modelsInvalid')
    if (Object.entries(formData.headers).some(([key, value]) => secretHeader(key) || /[\r\n]/.test(value))) nextErrors.headers = t('customProvider.headerInvalid')
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) return
    operation.current = true; setBusy('save')
    const current = revision.current
    try {
      await onSubmit({ ...formData, name: formData.name.trim(), apiEndpoint: formData.apiEndpoint.trim(), supportedModels: models })
      if (current === revision.current) onOpenChange(false)
    } catch {
      if (current === revision.current) setErrors(previous => ({ ...previous, submit: t('customProvider.saveFailed') }))
    } finally {
      if (current === revision.current) { operation.current = false; setBusy(null) }
    }
  }

  const handleFetchModels = async () => {
    if (!onFetchModels || operation.current || formData.apiEndpoint.trim() !== initialData?.apiEndpoint?.trim()) return
    operation.current = true; setBusy('models'); setNotice('')
    const current = revision.current
    try {
      const models = await onFetchModels()
      if (current === revision.current) {
        // Fetching adds IDs without discarding manually entered models.
        setModelsText(previous => [...new Set([...previous.split(/[\n,]/).map(value => value.trim()).filter(Boolean), ...models])].join('\n'))
        setNotice(t('customProvider.modelsFetched', { count: models.length }))
      }
    } catch {
      if (current === revision.current) setNotice(t('customProvider.fetchFailed'))
    } finally {
      if (current === revision.current) { operation.current = false; setBusy(null) }
    }
  }

  return <Dialog open={open} onOpenChange={value => { if (!operation.current) onOpenChange(value) }}>
    <DialogContent className="sm:max-w-[680px]">
      <DialogHeader>
        <DialogTitle>{providerId ? t('providers.editProvider') : t('providers.createCustomProvider')}</DialogTitle>
        <DialogDescription>{t('customProvider.description')}</DialogDescription>
      </DialogHeader>
      <div className="max-h-[65vh] space-y-5 overflow-y-auto px-1 py-2">
        <div className="rounded-lg border bg-muted/40 p-3 text-xs leading-6 text-muted-foreground">
          <Badge variant="secondary">OpenAI-compatible</Badge>
          <p className="mt-1">{t('customProvider.accountHelp')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="custom-provider-name">{t('providers.providerName')} *</Label>
          <Input id="custom-provider-name" maxLength={50} value={formData.name} disabled={!!busy} onChange={event => setFormData(previous => ({ ...previous, name: event.target.value }))} placeholder={t('customProvider.namePlaceholder')} />
          {errors.name && <p role="alert" className="text-xs text-destructive">{errors.name}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="custom-provider-url">Base URL *</Label>
          <Input id="custom-provider-url" maxLength={2048} value={formData.apiEndpoint} disabled={!!busy} onChange={event => setFormData(previous => ({ ...previous, apiEndpoint: event.target.value }))} placeholder="https://api.example.com/v1" autoComplete="off" />
          <p className="text-xs leading-5 text-muted-foreground">{t('customProvider.baseUrlHelp')}</p>
          {errors.apiEndpoint && <p role="alert" className="text-xs text-destructive">{errors.apiEndpoint}</p>}
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="custom-provider-no-auth">{t('customProvider.noAuth')}</Label>
            <Switch id="custom-provider-no-auth" checked={formData.credentialFields[0].required === false} disabled={!!busy}
              onCheckedChange={checked => setFormData(previous => ({ ...previous, credentialFields: previous.credentialFields.map(field => ({ ...field, required: !checked })) }))} />
          </div>
          <p className="text-xs text-muted-foreground">{t('customProvider.noAuthHelp')}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="custom-provider-models">{t('providers.supportedModels')}</Label>
          <Textarea id="custom-provider-models" value={modelsText} disabled={!!busy} onChange={event => setModelsText(event.target.value)} rows={4} placeholder={t('customProvider.modelsPlaceholder')} />
          <p className="text-xs leading-5 text-muted-foreground">{t('customProvider.modelsHelp')}</p>
          {errors.models && <p role="alert" className="text-xs text-destructive">{errors.models}</p>}
          {providerId && <Button type="button" variant="outline" size="sm" onClick={handleFetchModels} disabled={!!busy || !onFetchModels || formData.apiEndpoint.trim() !== initialData?.apiEndpoint?.trim()}>
            {busy === 'models' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}{t('customProvider.fetchModels')}
          </Button>}
          {providerId && <p className="text-xs text-muted-foreground">{t('customProvider.fetchHelp')}</p>}
          {notice && <p role="status" className="text-xs text-muted-foreground">{notice}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="custom-provider-description">{t('providers.description')}</Label>
          <Textarea id="custom-provider-description" maxLength={1000} value={formData.description} disabled={!!busy} onChange={event => setFormData(previous => ({ ...previous, description: event.target.value }))} rows={2} />
        </div>
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">{t('customProvider.advancedHeaders')}</summary>
          <p className="mt-2 text-xs text-muted-foreground">{t('customProvider.headerHelp')}</p>
          <div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2">
            <Input aria-label={t('providers.headerName')} value={newHeaderKey} disabled={!!busy} onChange={event => setNewHeaderKey(event.target.value)} placeholder={t('providers.headerName')} />
            <Input aria-label={t('providers.headerValue')} value={newHeaderValue} disabled={!!busy} onChange={event => setNewHeaderValue(event.target.value)} placeholder={t('providers.headerValue')} />
            <Button type="button" variant="outline" disabled={!!busy} onClick={handleAddHeader} aria-label={t('customProvider.addHeader')}><Plus className="h-4 w-4" /></Button>
          </div>
          <div className="mt-3 space-y-2">{Object.entries(formData.headers).map(([key, value]) => <div key={key} className="flex items-start justify-between gap-2 rounded bg-muted p-2 text-xs">
            <span className="break-all"><strong>{key}:</strong> {secretHeader(key) ? '••••••••' : value}</span>
            <button type="button" disabled={!!busy} aria-label={t('customProvider.removeHeader', { name: key })} className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setFormData(previous => ({ ...previous, headers: Object.fromEntries(Object.entries(previous.headers).filter(([name]) => name !== key)) }))}><X className="h-4 w-4" /></button>
          </div>)}</div>
          {errors.headers && <p role="alert" className="mt-2 text-xs text-destructive">{errors.headers}</p>}
        </details>
        {errors.submit && <p role="alert" className="text-sm text-destructive">{errors.submit}</p>}
      </div>
      <DialogFooter>
        <Button variant="outline" disabled={!!busy} onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
        <Button disabled={!!busy} onClick={handleSubmit}>{busy === 'save' && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{providerId ? t('providers.saveChanges') : t('customProvider.createAndAddKey')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export default CustomProviderForm
