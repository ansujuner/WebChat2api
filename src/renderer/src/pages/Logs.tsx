import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { RequestLogList } from '@/components/logs'

export default function LogsPage() {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('logs.title')}</h1>
          <p className="text-muted-foreground">{t('logs.description')}</p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
          <RequestLogList />
        </CardContent>
      </Card>
    </div>
  )
}
