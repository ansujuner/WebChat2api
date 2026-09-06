import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'

export function LanguageSwitcher() {
  const { t } = useTranslation()
  const { language, setLanguage } = useSettingsStore()
  return <div className="language-switcher inline-flex items-center rounded-lg border p-0.5" role="group"
    aria-label={t('shell.language')} data-testid="language-switcher">
    {([{ id: 'zh-CN', label: '中文' }, { id: 'en-US', label: 'EN' }] as const).map(option =>
      <button key={option.id} type="button" lang={option.id} data-language={option.id}
        aria-label={option.id === 'zh-CN' ? t('header.switchToChinese') : t('header.switchToEnglish')}
        aria-pressed={language === option.id}
        className={cn('rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', language === option.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}
        onClick={() => { if (language !== option.id) setLanguage(option.id) }}>{option.label}</button>,
    )}
  </div>
}
