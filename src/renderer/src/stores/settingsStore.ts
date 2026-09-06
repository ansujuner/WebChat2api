import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AppConfig } from '@/types/electron'
import i18n from '@/i18n'

export type Theme = 'light' | 'dark' | 'system'
export type Language = 'zh-CN' | 'en-US'
export type CloseBehavior = 'minimize' | 'close' | 'ask'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type OAuthProxyMode = 'system' | 'none'

interface SettingsState {
  theme: Theme
  setTheme: (theme: Theme) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  proxyEnabled: boolean
  setProxyEnabled: (enabled: boolean) => void
  oauthProxyMode: OAuthProxyMode
  setOauthProxyMode: (mode: OAuthProxyMode) => Promise<void>
  proxyModeSaving: boolean
  language: Language
  setLanguage: (language: Language) => void
  autoStart: boolean
  setAutoStart: (enabled: boolean) => void
  autoStartProxy: boolean
  setAutoStartProxy: (enabled: boolean) => void
  minimizeToTray: boolean
  setMinimizeToTray: (enabled: boolean) => void
  closeBehavior: CloseBehavior
  setCloseBehavior: (behavior: CloseBehavior) => void
  enableNotifications: boolean
  setEnableNotifications: (enabled: boolean) => void
  logLevel: LogLevel
  setLogLevel: (level: LogLevel) => void
  logRetentionDays: number
  setLogRetentionDays: (days: number) => void
  maxLogs: number
  setMaxLogs: (count: number) => void
  credentialEncryption: boolean
  setCredentialEncryption: (enabled: boolean) => void
  logDesensitization: boolean
  setLogDesensitization: (enabled: boolean) => void
  config: AppConfig | null
  setConfig: (config: AppConfig) => void
  updateConfig: (updates: Partial<AppConfig>) => Promise<void>
  fetchConfig: () => Promise<void>
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      setTheme: async (theme) => {
        if (theme !== 'light' && theme !== 'dark' && theme !== 'system') return
        set({ theme })
        try {
          const saved = await window.electronAPI.config.update({ theme })
          if (!saved) throw new Error('Theme configuration could not be saved')
          set((state) => ({ config: state.config ? { ...state.config, theme: state.theme } : null }))
        } catch (error) {
          console.error('Failed to update theme:', error)
        }
      },
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      proxyEnabled: false,
      setProxyEnabled: (enabled) => set({ proxyEnabled: enabled }),
      oauthProxyMode: 'system',
      proxyModeSaving: false,
      setOauthProxyMode: async (mode) => {
        if (mode !== 'system' && mode !== 'none') throw new Error('Invalid network proxy mode')
        if (get().proxyModeSaving) throw new Error('Network proxy configuration is already being saved')
        set({ proxyModeSaving: true })
        try {
          const saved = await window.electronAPI.config.update({ oauthProxyMode: mode })
          if (!saved) throw new Error('Network proxy configuration could not be saved')
          set((state) => ({
            oauthProxyMode: mode,
            config: state.config ? { ...state.config, oauthProxyMode: mode } : null,
          }))
        } finally {
          set({ proxyModeSaving: false })
        }
      },
      language: i18n.resolvedLanguage === 'en-US' ? 'en-US' : 'zh-CN',
      setLanguage: async (language) => {
        if (language !== 'zh-CN' && language !== 'en-US') return
        set({ language })
        await i18n.changeLanguage(language)
        try {
          const saved = await window.electronAPI.config.update({ language })
          if (!saved) throw new Error('Language configuration could not be saved')
          set((state) => ({ config: state.config ? { ...state.config, language: state.language } : null }))
        } catch (error) {
          console.error('Failed to update language:', error)
        }
      },
      autoStart: false,
      setAutoStart: async (enabled) => {
        set({ autoStart: enabled })
        try {
          await window.electronAPI.config.update({ autoStart: enabled })
        } catch (error) {
          console.error('Failed to update autoStart:', error)
        }
      },
      autoStartProxy: false,
      setAutoStartProxy: async (enabled) => {
        set({ autoStartProxy: enabled })
        try {
          await window.electronAPI.config.update({ autoStartProxy: enabled })
        } catch (error) {
          console.error('Failed to update autoStartProxy:', error)
        }
      },
      minimizeToTray: true,
      setMinimizeToTray: (enabled) => set({ minimizeToTray: enabled }),
      closeBehavior: 'minimize',
      setCloseBehavior: (behavior) => set({ closeBehavior: behavior }),
      enableNotifications: true,
      setEnableNotifications: (enabled) => set({ enableNotifications: enabled }),
      logLevel: 'info',
      setLogLevel: (level) => set({ logLevel: level }),
      logRetentionDays: 30,
      setLogRetentionDays: (days) => set({ logRetentionDays: days }),
      maxLogs: 10000,
      setMaxLogs: (count) => set({ maxLogs: count }),
      credentialEncryption: true,
      setCredentialEncryption: (enabled) => set({ credentialEncryption: enabled }),
      logDesensitization: true,
      setLogDesensitization: (enabled) => set({ logDesensitization: enabled }),
      config: null,
      setConfig: (config) => set({ config, oauthProxyMode: config.oauthProxyMode || 'system' }),
      updateConfig: async (updates) => {
        const currentConfig = get().config
        if (!currentConfig) return
        
        const newConfig = {
          ...currentConfig,
          ...updates,
          requestLogConfig: updates.requestLogConfig
            ? {
                ...currentConfig.requestLogConfig,
                ...updates.requestLogConfig,
              }
            : currentConfig.requestLogConfig,
        }
        set({ config: newConfig })
        
        try {
          await window.electronAPI.config.update(updates)
        } catch (error) {
          console.error('Failed to update config:', error)
          set({ config: currentConfig })
        }
      },
      fetchConfig: async () => {
        try {
          const config = await window.electronAPI.config.get()
          const language = config.language === 'en-US' || config.language === 'zh-CN' ? config.language : get().language
          set({ 
            config,
            autoStart: config.autoStart,
            autoStartProxy: config.autoStartProxy,
            oauthProxyMode: config.oauthProxyMode || 'system',
            language,
          })
          await i18n.changeLanguage(language)
        } catch (error) {
          console.error('Failed to fetch config:', error)
        }
      },
    }),
    {
      name: 'chat2api-settings',
      // In-flight UI state must never be restored after a crash/restart.
      partialize: ({ proxyModeSaving: _saving, ...state }) => state,
      merge: (persisted, current) => {
        const saved = persisted as Partial<SettingsState> | undefined
        return { ...current, ...saved,
          theme: saved?.theme === 'light' || saved?.theme === 'dark' || saved?.theme === 'system' ? saved.theme : current.theme,
          language: saved?.language === 'en-US' || saved?.language === 'zh-CN' ? saved.language : current.language,
          proxyModeSaving: false }
      },
      onRehydrateStorage: () => (state) => {
        if (state?.language === 'zh-CN' || state?.language === 'en-US') {
          i18n.changeLanguage(state.language)
        }
      },
    }
  )
)
