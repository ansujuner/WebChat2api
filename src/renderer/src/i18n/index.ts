import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import zhCN from './locales/zh-CN.json'
import enUS from './locales/en-US.json'

const resources = {
  'zh-CN': {
    translation: zhCN,
  },
  'en-US': {
    translation: enUS,
  },
}

i18n.on('languageChanged', language => {
  if (typeof document !== 'undefined') document.documentElement.lang = language.startsWith('en') ? 'en-US' : 'zh-CN'
})

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'zh-CN',
    supportedLngs: ['zh-CN', 'en-US'],
    debug: false,
    interpolation: {
      escapeValue: false,
    },
    detection: {
      // Respect a saved choice, but a fresh installation always starts in Chinese.
      order: ['localStorage'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
      convertDetectedLanguage: (lng: string) => {
        if (lng.includes('zh')) return 'zh-CN'
        if (lng.includes('en')) return 'en-US'
        return 'zh-CN'
      },
    },
  })

export default i18n
