import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'

export function useTheme() {
  const { theme, setTheme } = useSettingsStore()

  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches)
  const isDark = theme === 'system' ? systemDark : theme === 'dark'

  useEffect(() => {
    if (theme !== 'system') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    setSystemDark(mediaQuery.matches)
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemDark(e.matches)
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  useEffect(() => {
    window.document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  }, [isDark])

  const toggleTheme = () => {
    setTheme(isDark ? 'light' : 'dark')
  }

  return {
    theme,
    setTheme,
    toggleTheme,
    isDark,
  }
}
