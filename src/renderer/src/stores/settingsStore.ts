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
      setTheme: (theme) => set({ theme }),
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
      language: 'en-US',
      setLanguage: async (language) => {
        set({ language })
        await i18n.changeLanguage(language)
        try {
          await window.electronAPI.config.update({ language: language })
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
          set({ 
            config,
            autoStart: config.autoStart,
            autoStartProxy: config.autoStartProxy,
            oauthProxyMode: config.oauthProxyMode || 'system',
            language: config.language || 'en-US',
          })
        } catch (error) {
          console.error('Failed to fetch config:', error)
        }
      },
    }),
    {
      name: 'chat2api-settings',
      // In-flight UI state must never be restored after a crash/restart.
      partialize: ({ proxyModeSaving: _saving, ...state }) => state,
      merge: (persisted, current) => ({ ...current, ...(persisted as Partial<SettingsState>), proxyModeSaving: false }),
      onRehydrateStorage: () => (state) => {
        if (state?.language) {
          i18n.changeLanguage(state.language)
        }
      },
    }
  )
)
