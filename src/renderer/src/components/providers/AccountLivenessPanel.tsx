import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import type { AccountLivenessReason } from '../../../../shared/accountLiveness'
import type { AccountLivenessController } from '@/hooks/useAccountLiveness'

const reasonKeys: Record<AccountLivenessReason, string> = {
  disabled: 'disabled', provider_disabled: 'provider_disabled', cooldown: 'cooldown', daily_limit: 'daily_limit',
  account_missing: 'account_missing', provider_missing: 'provider_missing', no_text_model: 'no_text_model',
  auth_required: 'auth_required', action_required: 'action_required', rate_limited: 'rate_limited', quota_unavailable: 'quota_unavailable',
  browser_unavailable: 'browser_unavailable', model_unavailable: 'model_unavailable',
  account_banned: 'account_banned', incomplete_response: 'incomplete_response', request_failed: 'request_failed',
  timeout: 'timeout', cancelled: 'cancelled', account_changed: 'account_changed', internal_error: 'internal_error',
}
const terminal = new Set(['passed', 'failed', 'skipped', 'cancelled'])
const time = (value?: number) => typeof value === 'number' && Number.isFinite(value) ? new Date(value).toLocaleString() : '—'

export function AccountLivenessPanel({ controller }: { controller: AccountLivenessController }) {
  const { t } = useTranslation()
  const { job, pending, error, cancel } = controller
  const results = job?.results || []
  const completed = results.filter(result => terminal.has(result.status)).length
  const count = (status: string) => results.filter(result => result.status === status).length
  return <section aria-label={t('accountLiveness.title')} className="space-y-2">
    <p className="text-xs text-muted-foreground">{t('accountLiveness.notice')}</p>
    {error && <p role="alert" className="text-sm text-destructive">{t('accountLiveness.controlError')}</p>}
    {job && <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{t('accountLiveness.title')} · {t(`accountLiveness.jobState.${job.state}`)}</CardTitle>
          {(job.state === 'running' || job.state === 'cancelling') && <Button size="sm" variant="outline"
            disabled={pending || job.state === 'cancelling'} onClick={() => { void cancel() }}>
            {t(job.state === 'cancelling' ? 'accountLiveness.cancelling' : 'accountLiveness.cancel')}
          </Button>}
        </div>
        <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {t('accountLiveness.progress', { completed, total: results.length, passed: count('passed'), failed: count('failed'), skipped: count('skipped'), cancelled: count('cancelled') })}
        </p>
        <Progress value={results.length ? completed / results.length * 100 : 0} aria-label={t('accountLiveness.progressLabel')} />
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">{t('accountLiveness.sessionOnly')} · {time(job.startedAt)}</p>
        {(job.state === 'running' || job.state === 'cancelling') && <p className="text-xs text-muted-foreground">{t('accountLiveness.cancelNotice')}</p>}
        <div className="max-h-72 overflow-y-auto">
          <ul className="divide-y">
            {results.map(result => <li key={result.accountId} className="py-2 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium break-all">{result.accountName}</span>
                <span className="text-xs text-muted-foreground">{result.providerId}</span>
                <span className={result.status === 'passed' ? 'text-green-600' : result.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
                  {t(`accountLiveness.resultStatus.${result.status}`)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground break-all">
                {t('accountLiveness.model')}: {result.model || '—'} · {t('accountLiveness.latency')}: {typeof result.latencyMs === 'number' ? `${Math.round(result.latencyMs)} ms` : '—'} · {time(result.finishedAt || result.startedAt)}
              </p>
              {result.reason && <p className="text-xs mt-1">{t(`accountLiveness.reasons.${Object.hasOwn(reasonKeys, result.reason) ? reasonKeys[result.reason] : 'internal_error'}`)}</p>}
              {result.retryAt && <p className="text-xs text-muted-foreground">{t('accountLiveness.retryAt', { time: time(result.retryAt) })}</p>}
            </li>)}
          </ul>
        </div>
        {!results.length && <p className="text-xs text-muted-foreground">{t('accountLiveness.empty')}</p>}
      </CardContent>
    </Card>}
  </section>
}
