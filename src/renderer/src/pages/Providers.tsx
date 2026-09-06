/**
 * Provider Management Page
 * Integrates all components for CRUD operations on providers and accounts
 */

import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '@/hooks/use-toast'
import { useProvidersStore } from '@/stores/providersStore'
import {
  ProviderCard,
  AddProviderDialog,
  CustomProviderForm,
  AccountList,
  AddAccountDialog,
  AccountDetail,
  ProviderFilter,
} from '@/components/providers'
import { ModelEditor } from '@/components/models/ModelEditor'
import type { 
  Provider, 
  ProviderStatus, 
  BuiltinProviderConfig,
  CustomProviderFormData,
  Account,
} from '@/types/electron'
import { FilterType, StatusFilter } from '@/components/providers/ProviderFilter'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Server, ArrowLeft, Plus, Download } from 'lucide-react'
import { validatedAccountIdentity } from '../../../shared/accountIdentity'
import { accountAvailability } from '../../../shared/accountAvailability'
import { useAccountLiveness } from '@/hooks/useAccountLiveness'
import { AccountLivenessPanel } from '@/components/providers/AccountLivenessPanel'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

type ViewMode = 'providers' | 'accounts' | 'account-detail'

export function Providers() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const store = useProvidersStore()
  const liveness = useAccountLiveness()
  const hasLoadedRef = useRef(false)

  useEffect(() => {
    let disposed = false
    const unsubscribe = window.electronAPI?.accounts?.onChanged(() => {
      void window.electronAPI.accounts.getAll().then(accounts => {
        if (!disposed) useProvidersStore.getState().setAccounts(accounts)
      }).catch(() => { if (!disposed) toast({ title: t('accountAvailability.updateFailed'), variant: 'destructive' }) })
    })
    return () => { disposed = true; unsubscribe?.() }
  }, [t, toast])
  
  const [viewMode, setViewMode] = useState<ViewMode>('providers')
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<FilterType>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [isRefreshing, setIsRefreshing] = useState(false)
  
  const [showAddProviderDialog, setShowAddProviderDialog] = useState(false)
  const [showCustomProviderForm, setShowCustomProviderForm] = useState(false)
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null)
  const [deletingProvider, setDeletingProvider] = useState<Provider | null>(null)
  const [isDeletingProvider, setIsDeletingProvider] = useState(false)
  const deletingProviderRef = useRef(false)
  const [updatingModelProvider, setUpdatingModelProvider] = useState<string | null>(null)
  const modelUpdateRef = useRef(false)
  
  const [showAddAccountDialog, setShowAddAccountDialog] = useState(false)
  const [editingAccount, setEditingAccount] = useState<Account | null>(null)
  
  const [showModelEditor, setShowModelEditor] = useState(false)
  const [modelEditorProvider, setModelEditorProvider] = useState<{ id: string; name: string } | null>(null)
  
  useEffect(() => {
    if (hasLoadedRef.current) return
    hasLoadedRef.current = true
    
    const loadInitialData = async () => {
      if (!window.electronAPI?.providers?.getAll) {
        console.log('electronAPI not available')
        useProvidersStore.getState().setIsLoading(false)
        useProvidersStore.getState().setProviders([])
        useProvidersStore.getState().setBuiltinProviders([])
        useProvidersStore.getState().setAccounts([])
        return
      }
      
      try {
        useProvidersStore.getState().setIsLoading(true)
        const [providersData, builtinData, accountsData] = await Promise.all([
          window.electronAPI.providers.getAll(),
          window.electronAPI.providers.getBuiltin(),
          window.electronAPI.accounts.getAll(),
        ])
        
        useProvidersStore.getState().setProviders(providersData)
        useProvidersStore.getState().setBuiltinProviders(builtinData)
        useProvidersStore.getState().setAccounts(accountsData)
        
        const existingStatuses = useProvidersStore.getState().providerStatuses
        const statusMap: Record<string, ProviderStatus> = { ...existingStatuses }
        const countMap: Record<string, { total: number; active: number }> = {}
        
        for (const provider of providersData) {
          if (provider.status) {
            statusMap[provider.id] = provider.status
          } else if (!statusMap[provider.id]) {
            statusMap[provider.id] = 'unknown'
          }
          const providerAccounts = accountsData.filter(a => a.providerId === provider.id)
          countMap[provider.id] = {
            total: providerAccounts.length,
            active: providerAccounts.filter(a => accountAvailability(a).available).length,
          }
        }
        
        useProvidersStore.getState().setProviderStatuses(statusMap)
        useProvidersStore.getState().setAccountCounts(countMap)
      } catch (error) {
        console.error('Failed to load providers:', error)
      } finally {
        useProvidersStore.getState().setIsLoading(false)
      }
    }
    
    loadInitialData()
  }, [])

  const filteredProviders = store.providers.filter((provider) => {
    const matchesSearch = 
      provider.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      provider.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      provider.supportedModels?.some(model => 
        model.toLowerCase().includes(searchQuery.toLowerCase())
      )

    if (!matchesSearch) return false

    switch (typeFilter) {
      case 'builtin':
        if (provider.type !== 'builtin') return false
        break
      case 'custom':
        if (provider.type !== 'custom') return false
        break
      case 'enabled':
        if (!provider.enabled) return false
        break
      case 'disabled':
        if (provider.enabled) return false
        break
    }

    if (statusFilter !== 'all') {
      if (store.providerStatuses[provider.id] !== statusFilter) return false
    }

    return true
  })

  const handleToggleProvider = async (id: string, enabled: boolean) => {
    try {
      await window.electronAPI.providers.update(id, { enabled })
      store.updateProvider(id, { enabled })
      toast({
        title: enabled ? t('providers.enabled') : t('providers.disabled'),
        description: enabled ? t('providers.providerEnabled') : t('providers.providerDisabled'),
      })
    } catch (error) {
      toast({
        title: t('providers.operationFailed'),
        description: t('providers.cannotUpdateProviderStatus'),
        variant: 'destructive',
      })
    }
  }

  const handleEditProvider = (id: string) => {
    const provider = store.providers.find(p => p.id === id)
    if (provider) {
      setEditingProvider(provider)
      setShowCustomProviderForm(true)
    }
  }

  const handleDeleteProvider = async (id: string) => {
    if (deletingProviderRef.current) return
    deletingProviderRef.current = true
    setIsDeletingProvider(true)
    try {
      const success = await window.electronAPI.providers.delete(id)
      if (!success) throw new Error('Provider deletion failed')
      if (success) {
        store.removeProvider(id)
        setDeletingProvider(null)
        toast({
          title: t('providers.deleteSuccess'),
          description: t('providers.providerDeleted'),
        })
      }
    } catch (error) {
      toast({
        title: t('providers.deleteFailed'),
        description: t('providers.cannotDeleteProvider'),
        variant: 'destructive',
      })
    } finally {
      deletingProviderRef.current = false
      setIsDeletingProvider(false)
    }
  }

  const handleDuplicateProvider = async (id: string) => {
    try {
      const newProvider = await window.electronAPI.providers.duplicate(id)
      store.addProvider(newProvider)
      toast({
        title: t('providers.duplicateSuccess'),
        description: t('providers.providerDuplicated'),
      })
    } catch (error) {
      toast({
        title: t('providers.duplicateFailed'),
        description: t('providers.cannotDuplicateProvider'),
        variant: 'destructive',
      })
    }
  }

  const handleCheckProviderStatus = async (id: string) => {
    try {
      const result = await window.electronAPI.providers.checkStatus(id)
      store.updateProviderStatus(id, result.status)
      toast({
        title: result.status === 'online' ? t('providers.providerOnline') : t('providers.providerOffline'),
        description: result.error || `${t('providers.latency')}: ${result.latency}ms`,
        variant: result.status === 'online' ? 'default' : 'destructive',
      })
    } catch (error) {
      toast({
        title: t('providers.checkFailed'),
        description: t('providers.cannotCheckProviderStatus'),
        variant: 'destructive',
      })
    }
  }

  const handleCheckAllStatus = async () => {
    setIsRefreshing(true)
    try {
      const statuses = await window.electronAPI.providers.checkAllStatus()
      const newStatusMap: Record<string, ProviderStatus> = {}
      for (const [id, result] of Object.entries(statuses)) {
        newStatusMap[id] = result.status
      }
      store.setProviderStatuses(newStatusMap)
      toast({
        title: t('providers.statusRefreshed'),
        description: `${t('providers.onlineCount')}: ${Object.values(newStatusMap).filter(s => s === 'online').length} / ${store.providers.length}`,
      })
    } catch (error) {
      toast({
        title: t('providers.refreshFailed'),
        description: t('providers.cannotRefreshProviderStatus'),
        variant: 'destructive',
      })
    } finally {
      setIsRefreshing(false)
    }
  }

  const fetchProviderModels = async (providerId: string): Promise<string[]> => {
    if (modelUpdateRef.current) throw new Error('Model update already running')
    modelUpdateRef.current = true
    setUpdatingModelProvider(providerId)
    try {
      const result = await window.electronAPI.providers.updateModels(providerId)
      if (!result?.success) throw new Error('Could not refresh models')
      const providers = await window.electronAPI.providers.getAll()
      useProvidersStore.getState().setProviders(providers)
      useProvidersStore.getState().setModelsLastUpdated(Date.now())
      return providers.find(provider => provider.id === providerId)?.supportedModels || []
    } finally {
      modelUpdateRef.current = false
      setUpdatingModelProvider(null)
    }
  }

  const handleUpdateModels = async (providerId: string) => {
    try {
      toast({
        title: t('providers.updatingModels'),
        description: t('providers.updatingModels'),
      })
      
      await fetchProviderModels(providerId)
      toast({ title: t('providers.modelsUpdated'), description: t('providers.modelsUpdatedDesc') })
    } catch (error) {
      toast({
        title: t('providers.updateModelsFailed'),
        description: t('customProvider.fetchFailed'),
        variant: 'destructive',
      })
    }
  }

  const handleManageModels = (providerId: string) => {
    const provider = store.providers.find(p => p.id === providerId)
    if (provider) {
      setModelEditorProvider({ id: provider.id, name: provider.name })
      setShowModelEditor(true)
    }
  }

  const handleManageAccounts = (providerId: string) => {
    store.setSelectedProviderId(providerId)
    setViewMode('accounts')
  }

  const handleSelectBuiltinProvider = async (provider: BuiltinProviderConfig, credentials: Record<string, string>, accountInfo?: { email?: string; userId?: string }) => {
    // Browser login may have just created this provider with its live catalog.
    const currentProviders = await window.electronAPI.providers.getAll()
    useProvidersStore.getState().setProviders(currentProviders)
    let targetProvider = currentProviders.find(p => p.id === provider.id)
    
    if (!targetProvider) {
      const newProvider = await window.electronAPI.providers.add({
        id: provider.id,
        name: provider.name,
        type: 'builtin',
        authType: provider.authType,
        apiEndpoint: provider.apiEndpoint,
        headers: provider.headers,
        description: provider.description,
        supportedModels: provider.supportedModels,
        credentialFields: provider.credentialFields,
      })
      store.addProvider(newProvider)
      targetProvider = newProvider
    }
    
    if (credentials && Object.keys(credentials).length > 0) {
      const account = await window.electronAPI.accounts.add({
        providerId: targetProvider.id,
        nameSource: 'auto',
        ...validatedAccountIdentity(accountInfo),
        credentials: credentials,
      })
      store.addAccount(account)
      if (account.providerId === 'arena') useProvidersStore.getState().setProviders(await window.electronAPI.providers.getAll())
      
      const providerAccounts = store.getAccountsByProvider(targetProvider.id)
      store.updateAccountCount(targetProvider.id, providerAccounts.length, providerAccounts.filter(a => accountAvailability(a).available).length)
    }
    
    setShowAddProviderDialog(false)
    toast({
      title: t('providers.addSuccess'),
      description: `${provider.name} ${t('providers.accounts')} ${t('providers.accountAdded')}`,
    })
  }

  const handleCreateCustomProvider = () => {
    setShowAddProviderDialog(false)
    setEditingProvider(null)
    setShowCustomProviderForm(true)
  }

  const handleCustomProviderFormSubmit = async (data: CustomProviderFormData) => {
    try {
      if (editingProvider) {
        const updated = await window.electronAPI.providers.update(editingProvider.id, {
          name: data.name,
          authType: data.authType,
          apiEndpoint: data.apiEndpoint,
          headers: data.headers,
          description: data.description,
          supportedModels: data.supportedModels,
          credentialFields: data.credentialFields,
        })
        if (!updated) throw new Error('Provider update failed')
        if (updated) {
          store.updateProvider(editingProvider.id, updated)
          toast({
            title: t('providers.updateSuccess'),
            description: t('providers.providerConfigUpdated'),
          })
        }
      } else {
        const newProvider = await window.electronAPI.providers.add({
          name: data.name,
          type: 'custom',
          authType: data.authType,
          apiEndpoint: data.apiEndpoint,
          headers: data.headers,
          description: data.description,
          supportedModels: data.supportedModels,
          credentialFields: data.credentialFields,
        })
        store.addProvider(newProvider)
        store.setSelectedProviderId(newProvider.id)
        setEditingAccount(null)
        setViewMode('accounts')
        setShowAddAccountDialog(true)
        toast({
          title: t('providers.createSuccess'),
          description: t('providers.customProviderCreated'),
        })
      }
      setShowCustomProviderForm(false)
      setEditingProvider(null)
    } catch (error) {
      toast({
        title: editingProvider ? t('providers.updateFailed') : t('providers.createFailed'),
        description: t('customProvider.saveFailed'),
        variant: 'destructive',
      })
      throw new Error('Custom provider save failed')
    }
  }

  const handleAddAccount = async (data: {
    name: string
    nameSource?: 'auto' | 'custom'
    email?: string
    providerUserId?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }) => {
    if (!store.selectedProviderId) return
    
    try {
      const account = await window.electronAPI.accounts.add({
        providerId: store.selectedProviderId,
        name: data.name,
        nameSource: data.nameSource,
        email: data.email,
        providerUserId: data.providerUserId,
        credentials: data.credentials,
        dailyLimit: data.dailyLimit,
      })
      store.addAccount(account)
      
      const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
      store.updateAccountCount(
        store.selectedProviderId,
        providerAccounts.length,
        providerAccounts.filter(a => accountAvailability(a).available).length
      )
      
      setShowAddAccountDialog(false)
      toast({
        title: t('providers.addSuccess'),
        description: t('providers.accountAdded'),
      })
    } catch (error) {
      toast({
        title: t('providers.addFailed'),
        description: t('providers.cannotAddAccount'),
        variant: 'destructive',
      })
      throw new Error(t('providers.cannotAddAccount'))
    }
  }

  const handleUpdateAccount = async (id: string, updates: Partial<Account>) => {
    try {
      const account = store.getAccountById(id)
      if (!account) return
      
      const updated = await window.electronAPI.accounts.update(id, updates)
      if (!updated) throw new Error('Account update failed')
      if (updated) {
        store.updateAccount(id, updated)
        
        if (store.selectedProviderId) {
          const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
          store.updateAccountCount(
            store.selectedProviderId,
            providerAccounts.length,
            providerAccounts.filter(a => accountAvailability(a).available).length
          )
        }
        
        toast({
          title: t('providers.updateSuccess'),
          description: t('providers.accountUpdated'),
        })
      }
    } catch (error) {
      toast({
        title: t('providers.updateFailed'),
        description: t('providers.operationFailed'),
        variant: 'destructive',
      })
      throw new Error(t('providers.operationFailed'))
    }
  }

  const handleDeleteAccount = async (id: string) => {
    try {
      const success = await window.electronAPI.accounts.delete(id)
      if (success) {
        const account = store.getAccountById(id)
        store.removeAccount(id)
        
        if (account && store.selectedProviderId) {
          const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
          store.updateAccountCount(
            store.selectedProviderId,
            providerAccounts.length,
            providerAccounts.filter(a => accountAvailability(a).available).length
          )
        }
        
        toast({
          title: t('providers.deleteSuccess'),
          description: t('providers.accountDeleted'),
        })
      }
    } catch (error) {
      toast({
        title: t('providers.deleteFailed'),
        description: error instanceof Error ? error.message : t('providers.operationFailed'),
        variant: 'destructive',
      })
    }
  }

  const handleValidateAccount = async (id: string) => {
    try {
      const isValid = await window.electronAPI.accounts.validate(id)
      if (isValid) {
        const validated = await window.electronAPI.accounts.getById(id)
        store.updateAccount(id, validated || { status: 'active' })
        
        if (store.selectedProviderId) {
          const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
          store.updateAccountCount(
            store.selectedProviderId,
            providerAccounts.length,
            providerAccounts.filter(a => accountAvailability(a).available).length
          )
        }
        
        toast({
          title: t('providers.validateSuccess'),
          description: t('providers.credentialsValid'),
        })
      } else {
        store.updateAccount(id, { status: 'error', errorMessage: t('providers.validateFailed') })
        
        if (store.selectedProviderId) {
          const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
          store.updateAccountCount(
            store.selectedProviderId,
            providerAccounts.length,
            providerAccounts.filter(a => accountAvailability(a).available).length
          )
        }
        
        toast({
          title: t('providers.validateFailed'),
          description: t('providers.credentialsInvalid'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('providers.operationFailed')
      store.updateAccount(id, { status: 'error', errorMessage })
      
      if (store.selectedProviderId) {
        const providerAccounts = store.getAccountsByProvider(store.selectedProviderId)
        store.updateAccountCount(
          store.selectedProviderId,
          providerAccounts.length,
          providerAccounts.filter(a => accountAvailability(a).available).length
        )
      }
      
      toast({
        title: t('providers.validateFailed'),
        description: errorMessage,
        variant: 'destructive',
      })
    }
  }

  const handleValidateToken = async (providerId: string, credentials: Record<string, string>) => {
    return await window.electronAPI.accounts.validateToken(providerId, credentials)
  }

  const handleViewAccountDetail = (account: Account) => {
    store.setSelectedAccountId(account.id)
    setViewMode('account-detail')
  }

  const handleBackToProviders = () => {
    setViewMode('providers')
    store.setSelectedProviderId(null)
    store.setSelectedAccountId(null)
  }

  const handleBackToAccounts = () => {
    setViewMode('accounts')
    store.setSelectedAccountId(null)
  }

  const stats = {
    total: store.providers.length,
    builtin: store.providers.filter(p => p.type === 'builtin').length,
    custom: store.providers.filter(p => p.type === 'custom').length,
    enabled: store.providers.filter(p => p.enabled).length,
    online: Object.values(store.providerStatuses).filter(s => s === 'online').length,
  }

  if (store.isLoading) {
    return (
      <div className="flex items-center justify-center h-[50vh]">
        <div className="text-muted-foreground">{t('providers.loading')}</div>
      </div>
    )
  }

  const selectedProvider = store.selectedProviderId 
    ? store.getProviderById(store.selectedProviderId) 
    : null

  const selectedAccount = store.selectedAccountId 
    ? store.getAccountById(store.selectedAccountId) 
    : null

  const providerAccounts = store.selectedProviderId 
    ? store.getAccountsByProvider(store.selectedProviderId) 
    : []

  if (viewMode === 'account-detail' && selectedAccount && selectedProvider) {
    return (
      <div className="space-y-6">
        <AccountLivenessPanel controller={liveness} />
        <AccountDetail
          account={selectedAccount}
          provider={selectedProvider}
          onBack={handleBackToAccounts}
          onEdit={async () => {
            const fullAccount = await window.electronAPI.accounts.getById(selectedAccount.id, true)
            setEditingAccount(fullAccount || selectedAccount)
            setViewMode('accounts')
            setShowAddAccountDialog(true)
          }}
          onDelete={() => handleDeleteAccount(selectedAccount.id)}
          onValidate={() => handleValidateAccount(selectedAccount.id)}
          onTest={() => { void liveness.start({ accountIds: [selectedAccount.id] }) }}
          livenessBusy={liveness.busy}
        />
      </div>
    )
  }

  if (viewMode === 'accounts' && selectedProvider) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <button
            onClick={handleBackToProviders}
            className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
            <span>{t('providers.backToProviderList')}</span>
          </button>
        </div>

        <div>
          <h2 className="text-2xl font-bold tracking-tight">
            {selectedProvider.name} - {t('providers.accountManagement')}
          </h2>
          <p className="text-muted-foreground">
            {selectedProvider.type === 'custom' ? t('customProvider.accountPageHelp') : t('providers.manageAllAccounts')}
          </p>
          {selectedProvider.type === 'custom' && <Button className="mt-3" variant="outline" size="sm" disabled={updatingModelProvider !== null || providerAccounts.length === 0} onClick={() => { void handleUpdateModels(selectedProvider.id) }}>
            <Download className="mr-2 h-4 w-4" />{t('customProvider.fetchModels')}
          </Button>}
        </div>

        <AccountLivenessPanel controller={liveness} />

        <AccountList
          accounts={providerAccounts}
          providerId={selectedProvider.id}
          onAddAccount={() => setShowAddAccountDialog(true)}
          onEditAccount={async (account) => {
            const fullAccount = await window.electronAPI.accounts.getById(account.id, true)
            setEditingAccount(fullAccount || account)
            setShowAddAccountDialog(true)
          }}
          onDeleteAccount={handleDeleteAccount}
          onValidateAccount={handleValidateAccount}
          onViewDetail={handleViewAccountDetail}
          onTestAccount={id => { void liveness.start({ accountIds: [id] }) }}
          onTestProvider={() => { void liveness.start({ providerId: selectedProvider.id }) }}
          livenessBusy={liveness.busy}
        />

        <AddAccountDialog
          open={showAddAccountDialog}
          onOpenChange={(open) => {
            setShowAddAccountDialog(open)
            if (!open) setEditingAccount(null)
          }}
          provider={selectedProvider}
          onAddAccount={handleAddAccount}
          onValidateToken={handleValidateToken}
          editingAccount={editingAccount}
          onUpdateAccount={handleUpdateAccount}
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">{t('providers.title')}</h2>
          <p className="text-muted-foreground">{t('providers.subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={handleCreateCustomProvider}><Plus className="mr-2 h-4 w-4" />{t('providers.createCustomProvider')}</Button>
          <Button variant="outline" disabled={liveness.busy || store.accounts.length === 0}
            onClick={() => { void liveness.start({}) }}>{t('accountLiveness.allAccounts')}</Button>
        </div>
      </div>

      <AccountLivenessPanel controller={liveness} />

      <ProviderFilter
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        onRefresh={handleCheckAllStatus}
        onAddProvider={() => setShowAddProviderDialog(true)}
        isRefreshing={isRefreshing}
        stats={stats}
      />

      {filteredProviders.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Server className="h-12 w-12 mb-4 opacity-50" />
          <p className="text-lg font-medium">{t('providers.noProvidersFound')}</p>
          <p className="text-sm">
            {searchQuery || typeFilter !== 'all' || statusFilter !== 'all'
              ? t('providers.tryAdjustingFilters')
              : t('providers.clickToAddProvider')}
          </p>
        </div>
      ) : (
        <ScrollArea className="h-[calc(100vh-280px)]">
          <div className="grid gap-4 pr-4">
            {filteredProviders.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                status={store.providerStatuses[provider.id]}
                accountCount={store.accountCounts[provider.id]?.total || 0}
                activeAccountCount={store.accountCounts[provider.id]?.active || 0}
                onToggle={handleToggleProvider}
                onEdit={handleEditProvider}
                onDelete={id => setDeletingProvider(store.getProviderById(id) || null)}
                onDuplicate={handleDuplicateProvider}
                onCheckStatus={handleCheckProviderStatus}
                onManageAccounts={handleManageAccounts}
                onUpdateModels={handleUpdateModels}
                onManageModels={handleManageModels}
                isUpdatingModels={updatingModelProvider !== null}
              />
            ))}
          </div>
        </ScrollArea>
      )}

      <AddProviderDialog
        open={showAddProviderDialog}
        onOpenChange={setShowAddProviderDialog}
        builtinProviders={store.builtinProviders}
        onSelectBuiltin={handleSelectBuiltinProvider}
        onCreateCustom={handleCreateCustomProvider}
        onValidateToken={handleValidateToken}
      />

      <CustomProviderForm
        key={editingProvider?.id || 'new-custom-provider'}
        open={showCustomProviderForm}
        providerId={editingProvider?.id}
        onFetchModels={editingProvider && store.accounts.some(account => account.providerId === editingProvider.id) ? () => fetchProviderModels(editingProvider.id) : undefined}
        onOpenChange={(open) => {
          setShowCustomProviderForm(open)
          if (!open) setEditingProvider(null)
        }}
        onSubmit={handleCustomProviderFormSubmit}
        initialData={editingProvider ? {
          name: editingProvider.name,
          authType: editingProvider.authType,
          apiEndpoint: editingProvider.apiEndpoint,
          headers: editingProvider.headers,
          description: editingProvider.description || '',
          supportedModels: editingProvider.supportedModels || [],
          credentialFields: editingProvider.credentialFields,
        } : undefined}
      />

      <Dialog open={!!deletingProvider} onOpenChange={open => { if (!open && !deletingProviderRef.current) setDeletingProvider(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('providers.deleteProvider')}</DialogTitle>
            <DialogDescription>{t('customProvider.deleteConfirm', { name: deletingProvider?.name, count: deletingProvider ? store.getAccountsByProvider(deletingProvider.id).length : 0 })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={isDeletingProvider} onClick={() => setDeletingProvider(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" disabled={isDeletingProvider} onClick={() => { if (deletingProvider) void handleDeleteProvider(deletingProvider.id) }}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {modelEditorProvider && (
        <ModelEditor
          open={showModelEditor}
          onOpenChange={(open) => {
            setShowModelEditor(open)
            if (!open) setModelEditorProvider(null)
          }}
          providerId={modelEditorProvider.id}
          providerName={modelEditorProvider.name}
        />
      )}
    </div>
  )
}

export default Providers
