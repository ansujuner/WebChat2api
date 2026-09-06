import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import type { Account } from '@/types/electron'
import { useProvidersStore } from '@/stores/providersStore'

export function AccountAvailabilityControl({ account }: { account: Account }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const suspended = account.cooldownReason === 'temporary_ban' && (account.cooldownUntil === undefined || account.cooldownUntil > Date.now())
  const change = async (release: boolean, enabled?: boolean) => {
    if (release && !window.confirm(t('accountAvailability.releaseConfirm'))) return
    setBusy(true); setFailed(false)
    try {
      if (release) await window.electronAPI.accounts.clearSuspension(account.id)
      else await window.electronAPI.accounts.setEnabled(account.id, enabled!)
      useProvidersStore.getState().setAccounts(await window.electronAPI.accounts.getAll())
    } catch { setFailed(true) } finally { setBusy(false) }
  }
  return <div className="space-y-1 text-xs" onClick={event => event.stopPropagation()}>
    <label className="flex items-center gap-2">
      <Switch checked={account.enabled !== false} disabled={busy}
        aria-label={t('accountAvailability.switchLabel', { name: account.name })}
        onCheckedChange={enabled => { void change(false, enabled) }} />
      {t(account.enabled === false ? 'accountAvailability.disabled' : 'accountAvailability.enabled')}
    </label>
    {suspended && <div className="text-amber-600">
      <p>{account.cooldownUntil === undefined ? t('accountAvailability.manualReview') : t('accountAvailability.cooldownUntil', { time: new Date(account.cooldownUntil).toLocaleString() })}</p>
      {account.enabled === false && <p>{t('accountAvailability.staysDisabled')}</p>}
      <Button size="sm" variant="link" disabled={busy} onClick={() => { void change(true) }}>{t('accountAvailability.release')}</Button>
    </div>}
    {failed && <p role="alert" className="text-destructive">{t('accountAvailability.updateFailed')}</p>}
  </div>
}
