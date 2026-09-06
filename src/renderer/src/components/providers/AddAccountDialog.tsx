/**
 * Add Account Dialog Component
 * Supports OAuth login and manual input methods
 */

import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { 
  ExternalLink, 
  User, 
  AlertCircle,
  Loader2,
  CheckCircle2,
  Eye,
  EyeOff,
  Copy,
  Check
} from 'lucide-react'
import type { Provider, CredentialField, Account, BuiltinProviderConfig, ProviderVendor } from '@/types/electron'
import { accountEmail, accountUserId, validatedAccountIdentity } from '../../../../shared/accountIdentity'
import { supportsAccountLogin } from '../../../../shared/accountReauthentication'

/**
 * Map OAuth credentials to provider credential field names
 * OAuth returns credentials with keys like 'chatglm_refresh_token', but providers expect 'refresh_token'
 * DeepSeek stores token as JSON: {"value":"..."}
 */
function mapOAuthCredentials(providerId: string | undefined, credentials: Record<string, string>): Record<string, string> {
  if (!providerId) return credentials

  const credentialKeyMap: Record<string, string> = {
    'glm': 'chatglm_refresh_token',
    'deepseek': 'userToken',
    'qwen': 'tongyi_sso_ticket',
    'qwen-ai': 'tongyi_sso_ticket',
    'zai': 'tongyi_sso_ticket',
    'perplexity': '__Secure-next-auth.session-token',
    'mimo': 'serviceToken',
  }

  const providerFieldNames: Record<string, string> = {
    'glm': 'refresh_token',
    'deepseek': 'token',
    'qwen': 'ticket',
    'qwen-ai': 'ticket',
    'zai': 'ticket',
    'perplexity': 'sessionToken',
    'mimo': 'service_token',
  }

  const oauthKey = credentialKeyMap[providerId]
  if (oauthKey && credentials[oauthKey]) {
    const fieldName = providerFieldNames[providerId]
    if (fieldName) {
      // Handle JSON-wrapped tokens (DeepSeek stores token as {"value":"..."})
      let tokenValue = credentials[oauthKey]
      if (providerId === 'deepseek' && tokenValue && tokenValue.startsWith('{') && tokenValue.endsWith('}')) {
        try {
          const parsed = JSON.parse(tokenValue)
          if (parsed.value) {
            tokenValue = parsed.value
          }
        } catch (e) {
          console.error('[AddAccountDialog] Invalid JSON token wrapper')
        }
      }
      return { [fieldName]: tokenValue }
    }
  }

  // For Perplexity, if we have the secure token, map it
  if (providerId === 'perplexity' && credentials['__Secure-next-auth.session-token']) {
    return { sessionToken: credentials['__Secure-next-auth.session-token'] }
  }
  if (providerId === 'perplexity' && credentials['next-auth.session-token']) {
    return { sessionToken: credentials['next-auth.session-token'] }
  }

  // For Mimo, map all three tokens
  if (providerId === 'mimo') {
    const result: Record<string, string> = {}
    // OAuth already returns credentials in correct format (service_token, user_id, ph_token)
    // Check for final format first
    if (credentials['service_token']) {
      result['service_token'] = credentials['service_token']
    } else if (credentials['serviceToken']) {
      result['service_token'] = credentials['serviceToken']
    }
    if (credentials['user_id']) {
      result['user_id'] = credentials['user_id']
    } else if (credentials['userId']) {
      result['user_id'] = credentials['userId']
    }
    if (credentials['ph_token']) {
      result['ph_token'] = credentials['ph_token']
    } else if (credentials['xiaomichatbot_ph']) {
      result['ph_token'] = credentials['xiaomichatbot_ph']
    }
    return result
  }

  return credentials
}

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: Provider | null
  onAddAccount: (data: {
    name: string
    nameSource?: 'auto' | 'custom'
    email?: string
    providerUserId?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }) => Promise<void>
  onValidateToken: (providerId: string, credentials: Record<string, string>) => Promise<{
    valid: boolean
    error?: string
    userInfo?: {
      userId?: string
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>
  editingAccount?: Account | null
  onUpdateAccount?: (id: string, updates: Partial<Account>) => Promise<void>
}

export function AddAccountDialog({
  open,
  onOpenChange,
  provider,
  onAddAccount,
  onValidateToken,
  editingAccount,
  onUpdateAccount,
}: AddAccountDialogProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<string>('manual')
  const [name, setName] = useState('')
  const nameWasEdited = useRef(false)
  const credentialRevision = useRef(0)
  const credentialsWereEdited = useRef(false)
  const credentialBaselineReady = useRef(true)
  const dialogTarget = useRef({ key: '', version: 0, open: false })
  const operation = useRef<{ version: number; credentials: number; kind: 'login' | 'validate' | 'save' } | null>(null)
  const targetKey = `${open ? 'open' : 'closed'}:${provider?.id || ''}:${editingAccount?.id || 'new'}`
  if (dialogTarget.current.key !== targetKey) {
    dialogTarget.current = { key: targetKey, version: dialogTarget.current.version + 1, open }
  }
  const [dailyLimit, setDailyLimit] = useState<string>('')
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [isValidating, setIsValidating] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    valid?: boolean
    error?: string
    userInfo?: {
      userId?: string
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isOAuthLoading, setIsOAuthLoading] = useState(false)
  const [oauthStatus, setOAuthStatus] = useState<string>('')
  const [accountLoginSaved, setAccountLoginSaved] = useState(false)

  const isEditing = !!editingAccount
  const builtinProvider = provider as BuiltinProviderConfig | null
  const credentialFields: CredentialField[] = builtinProvider?.credentialFields || getDefaultCredentialFields(provider?.authType, t)
  const supportsOAuth = provider?.type === 'builtin' && supportsAccountLogin(provider.id)
  const canLogin = supportsOAuth
  const isAccountReauthentication = canLogin && isEditing
  const busy = isValidating || isSubmitting || isOAuthLoading

  const beginOperation = (kind: 'login' | 'validate' | 'save') => {
    if (!dialogTarget.current.open || operation.current) return null
    const request = { version: dialogTarget.current.version, credentials: credentialRevision.current, kind }
    operation.current = request
    return request
  }
  const ownsOperation = (request: NonNullable<typeof operation.current>) =>
    operation.current === request && dialogTarget.current.open && dialogTarget.current.version === request.version
  const canApplyResult = (request: NonNullable<typeof operation.current>) =>
    ownsOperation(request) && credentialRevision.current === request.credentials
  const handleDialogOpenChange = (value: boolean) => {
    if (!value) {
      dialogTarget.current = { ...dialogTarget.current, open: false, version: dialogTarget.current.version + 1 }
      credentialRevision.current += 1
    }
    onOpenChange(value)
  }

  useEffect(() => {
    credentialRevision.current += 1
    operation.current = null
    setIsValidating(false)
    setIsSubmitting(false)
    setIsOAuthLoading(false)
    setOAuthStatus('')
    setAccountLoginSaved(false)
    credentialsWereEdited.current = false
    credentialBaselineReady.current = true
    if (open) {
      if (editingAccount) {
        setName(editingAccount.name)
        nameWasEdited.current = editingAccount.nameSource !== 'auto'
        setValidationResult({})
        setDailyLimit(editingAccount.dailyLimit?.toString() || '')
        setCredentials({ ...(editingAccount.credentials || {}) })
        setActiveTab(supportsOAuth ? 'oauth' : 'manual')
      } else {
        resetForm()
      }
    }
    return () => { dialogTarget.current.version += 1; credentialRevision.current += 1 }
  }, [open, editingAccount?.id, provider?.id])

  const resetForm = () => {
    credentialRevision.current += 1
    credentialsWereEdited.current = false
    credentialBaselineReady.current = true
    setName('')
    nameWasEdited.current = false
    setDailyLimit('')
    setCredentials({})
    setValidationResult({})
    setActiveTab(provider?.id === 'arena' ? 'oauth' : 'manual')
    setIsOAuthLoading(false)
    setOAuthStatus('')
    setAccountLoginSaved(false)
  }

  const handleCredentialChange = (fieldName: string, value: string) => {
    if (operation.current || !credentialBaselineReady.current) return
    credentialRevision.current += 1
    credentialsWereEdited.current = true
    setCredentials(prev => ({
      ...prev,
      [fieldName]: value,
    }))
    setValidationResult({})
    setOAuthStatus('')
    setAccountLoginSaved(false)
    if (!nameWasEdited.current && !isEditing) setName('')
  }

  const applyValidatedName = (info?: { email?: string; userId?: string }) => {
    if (nameWasEdited.current) return
    const email = accountEmail(info?.email)
    const userId = accountUserId(info?.userId)
    if (email || userId) setName(email || `${provider?.name} · ${userId}`)
  }

  const handleValidate = async () => {
    if (!provider || !open || operation.current || !credentialBaselineReady.current) return

    const requiredFields = credentialFields.filter(f => f.required)
    const missingFields = requiredFields.filter(f => !credentials[f.name])
    
    if (missingFields.length > 0) {
      setValidationResult({
        valid: false,
        error: t('providers.fillRequiredFields', { fields: missingFields.map(f => f.label).join(', ') }),
      })
      return
    }

    const request = beginOperation('validate')
    if (!request) return
    setIsValidating(true)
    setValidationResult({})
    setOAuthStatus('')
    setAccountLoginSaved(false)

    try {
      const result = await onValidateToken(provider.id, { ...credentials })
      if (!canApplyResult(request)) return
      setValidationResult(result)

      if (result.valid && result.userInfo) {
        applyValidatedName(result.userInfo)
      }
    } catch (error) {
      if (!canApplyResult(request)) return
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : t('providers.validateFailed'),
      })
    } finally {
      if (ownsOperation(request)) { operation.current = null; setIsValidating(false) }
    }
  }

  const handleSubmit = async () => {
    if (!provider || !open || operation.current) return
    if (provider?.id === 'arena' && !isEditing && !validationResult.valid) return
    const requiredFields = credentialFields.filter(f => f.required)
    const missingFields = (!isEditing || credentialsWereEdited.current) ? requiredFields.filter(f => !credentials[f.name]) : []
    
    if (missingFields.length > 0) {
      setValidationResult({
        valid: false,
        error: t('providers.fillRequiredFields', { fields: missingFields.map(f => f.label).join(', ') }),
      })
      return
    }

    const request = beginOperation('save')
    if (!request) return
    setIsSubmitting(true)

    try {
      const data = {
        name: name.trim(),
        nameSource: nameWasEdited.current && name.trim() ? 'custom' as const : 'auto' as const,
        ...(validationResult.valid ? validatedAccountIdentity(validationResult.userInfo) : {}),
        ...(!isEditing || credentialsWereEdited.current ? { credentials: { ...credentials } } : {}),
        dailyLimit: dailyLimit ? parseInt(dailyLimit, 10) : undefined,
      }

      if (isEditing && editingAccount) {
        if (!onUpdateAccount) throw new Error(t('providers.saveFailed'))
        await onUpdateAccount(editingAccount.id, data)
      } else {
        await onAddAccount({ ...data, credentials: { ...credentials } })
      }

      if (!canApplyResult(request)) return
      onOpenChange(false)
      resetForm()
    } catch (error) {
      if (!canApplyResult(request)) return
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : t('providers.saveFailed'),
      })
    } finally {
      if (ownsOperation(request)) { operation.current = null; setIsSubmitting(false) }
    }
  }

  const handleAccountReauthentication = async () => {
    if (!editingAccount || !isAccountReauthentication || credentialsWereEdited.current) return
    const request = beginOperation('login')
    if (!request) return
    const accountId = editingAccount.id
    setIsOAuthLoading(true)
    setValidationResult({})
    setAccountLoginSaved(false)
    setOAuthStatus(t(provider?.id === 'zai' ? 'providers.accountLoginRestoring' : 'providers.accountReloginRestoring'))
    try {
      const result = await window.electronAPI.accounts.reauthenticate(accountId)
      if (!canApplyResult(request)) return
      if (!result || result.accountId !== accountId || !result.success || !['restored', 'updated'].includes(result.state)) {
        const allowedErrors = ['invalid_account', 'unsupported_provider', 'busy', 'cancelled', 'timeout', 'identity_mismatch', 'identity_unverified', 'login_required', 'network_error', 'route_changed', 'browser_error', 'account_changed', 'save_failed']
        const code = result?.accountId === accountId && allowedErrors.includes(result.errorCode || '') ? result.errorCode : 'browser_error'
        setOAuthStatus(t(`providers.accountLoginErrors.${code}`))
        return
      }
      // Main has already verified this account and committed any new credentials.
      // Never let an old editor draft overwrite that saved value on a later save.
      credentialsWereEdited.current = false
      credentialBaselineReady.current = false
      setCredentials({})
      setAccountLoginSaved(true)
      setOAuthStatus(t(result.state === 'updated' ? 'providers.accountLoginUpdated' : 'providers.accountLoginRestored'))
      try {
        const refreshed = await window.electronAPI.accounts.getById(accountId, true)
        if (!canApplyResult(request)) return
        if (!refreshed || refreshed.id !== accountId || refreshed.providerId !== provider?.id) throw new Error('Account baseline unavailable')
        setCredentials({ ...refreshed.credentials })
        credentialBaselineReady.current = true
        credentialRevision.current += 1
        applyValidatedName({ email: refreshed.email, userId: refreshed.providerUserId })
      } catch {
        if (canApplyResult(request)) setOAuthStatus(t('providers.accountLoginSavedRefreshFailed'))
      }
    } catch {
      if (canApplyResult(request)) setOAuthStatus(t('providers.accountLoginErrors.browser_error'))
    } finally {
      if (ownsOperation(request)) { operation.current = null; setIsOAuthLoading(false) }
    }
  }

  const handleOpenOAuthBrowser = async () => {
    if (!provider || !canLogin) return
    if (isAccountReauthentication) return handleAccountReauthentication()
    const request = beginOperation('login')
    if (!request) return
    setIsOAuthLoading(true)
    setValidationResult({})
    setOAuthStatus(t('providers.openingLoginWindow'))
    
    try {
      const result = await window.electronAPI?.oauth.startInAppLogin(
        provider.id,
        provider.id as ProviderVendor
      )
      if (!canApplyResult(request)) return
      
      if (result?.success && result.credentials) {
        const previousUserId = accountUserId(editingAccount?.providerUserId)
        const nextUserId = accountUserId(result.accountInfo?.userId)
        const previousEmail = accountEmail(editingAccount?.email)
        const nextEmail = accountEmail(result.accountInfo?.email)
        if ((previousUserId && nextUserId && previousUserId !== nextUserId)
          || (previousEmail && nextEmail && previousEmail.toLowerCase() !== nextEmail.toLowerCase())) {
          setOAuthStatus(t('providers.reloginIdentityMismatch'))
          return
        }
        // Map OAuth credentials to provider credential field names
        const mappedCredentials = mapOAuthCredentials(provider?.id, result.credentials)
        if (!mappedCredentials || Array.isArray(mappedCredentials) || !Object.keys(mappedCredentials).length
          || Object.values(mappedCredentials).some(value => typeof value !== 'string')
          || credentialFields.some(field => field.required && !mappedCredentials[field.name]?.trim())) {
          setOAuthStatus(t('providers.reloginInvalidCredentials'))
          return
        }
        credentialRevision.current += 1
        credentialsWereEdited.current = true
        setCredentials({ ...mappedCredentials })
        setOAuthStatus(t(isEditing ? 'providers.reloginSaveRequired' : 'providers.loginSuccess'))
        
        applyValidatedName(result.accountInfo)
        
        setValidationResult({
          valid: true,
          userInfo: result.accountInfo
        })
      } else {
        const errorMsg = result?.error || ''
        const translatedError = errorMsg === 'Login window was closed' 
          ? t('providers.loginWindowClosed')
          : errorMsg === 'A login window is already open' || errorMsg === 'A login process is already in progress'
            ? t('providers.loginWindowAlreadyOpen')
            : errorMsg.includes('Guest account') 
              ? t('providers.guestAccountNotAllowed')
              : t('providers.loginFailed')
        setOAuthStatus(translatedError)
      }
    } catch (error) {
      if (canApplyResult(request)) setOAuthStatus(t('providers.loginFailed'))
    } finally {
      if (ownsOperation(request)) { operation.current = null; setIsOAuthLoading(false) }
    }
  }

  if (!provider) return null

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              {isEditing ? t(provider.type === 'custom' ? 'providers.updateCredentials' : 'providers.editAccount') : t('providers.addAccount')}
            </DialogTitle>
            <DialogDescription>
              {provider.type === 'custom' ? t('customProvider.keyAccountHelp') : t('providers.manageAllAccounts')} - {provider.name}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('providers.accountName')}</Label>
              <Input
                id="name"
                placeholder={t('providers.accountNamePlaceholder')}
                value={name}
                disabled={busy}
                onChange={(e) => {
                  if (operation.current) return
                  nameWasEdited.current = !!e.target.value.trim()
                  setName(e.target.value)
                }}
              />
              <p className="text-xs text-muted-foreground">{t('providers.accountNameAutoHelp')}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="dailyLimit">{t('providers.dailyLimitOptional')}</Label>
              <Input
                id="dailyLimit"
                type="number"
                placeholder={t('providers.dailyLimitPlaceholder')}
                value={dailyLimit}
                disabled={busy}
                onChange={(e) => { if (!operation.current) setDailyLimit(e.target.value) }}
              />
            </div>

            {canLogin && (
              <Tabs value={activeTab} onValueChange={value => { if (!operation.current) setActiveTab(value) }}>
                <TabsList className={provider?.id === 'arena' ? 'grid w-full grid-cols-1' : 'grid w-full grid-cols-2'}>
                  {provider?.id !== 'arena' && <TabsTrigger value="manual" disabled={busy}>{t('providers.manualInput')}</TabsTrigger>}
                  <TabsTrigger value="oauth" disabled={busy}>{t(provider?.id === 'arena' ? 'arena.browserLogin' : 'providers.oauthLogin')}</TabsTrigger>
                </TabsList>

                <TabsContent value="manual" className="mt-4">
                  <CredentialFieldsForm
                    fields={credentialFields}
                    credentials={credentials}
                    onChange={handleCredentialChange}
                    t={t}
                    providerId={provider?.id}
                    disabled={busy || !credentialBaselineReady.current}
                  />
                </TabsContent>

                <TabsContent value="oauth" className="mt-4">
                  <div className="flex flex-col items-center justify-center py-6 space-y-4">
                    <div className="text-center">
                      <p className="text-sm text-muted-foreground mb-4">
                        {t(isAccountReauthentication ? provider.id === 'zai' ? 'providers.accountLoginHelp' : provider.id === 'arena' ? 'providers.arenaAccountReloginHelp' : 'providers.accountReloginHelp' : provider?.id === 'arena' ? 'arena.browserLoginHelp' : provider?.id === 'deepseek' ? 'deepseek.externalBrowserLoginHelp' : 'providers.clickToOpenOAuth')}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t(isAccountReauthentication ? ['zai', 'arena'].includes(provider.id) ? 'providers.accountLoginSessionHelp' : 'providers.accountReloginSessionHelp' : provider?.id === 'arena' ? 'arena.profileOnlyHelp' : 'providers.oauthAutoCapture')}
                      </p>
                    </div>
                    <Button 
                      onClick={handleOpenOAuthBrowser}
                      disabled={busy || (isAccountReauthentication && credentialsWereEdited.current)}
                      data-testid="account-oauth-login"
                    >
                      {isOAuthLoading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {oauthStatus || t('providers.loggingIn')}
                        </>
                      ) : (
                        <>
                          <ExternalLink className="mr-2 h-4 w-4" />
                          {t(isAccountReauthentication ? provider.id === 'zai' ? 'providers.openAccountLogin' : 'providers.relogin' : provider?.id === 'arena' ? 'arena.browserLogin' : 'providers.openOAuthLogin')}
                        </>
                      )}
                    </Button>
                    {isAccountReauthentication && credentialsWereEdited.current && (
                      <p role="status" className="text-sm text-amber-600">{t('providers.accountLoginSaveDraftFirst')}</p>
                    )}
                    {oauthStatus && !isOAuthLoading && (
                      <p role="status" className={`text-sm ${accountLoginSaved || validationResult.valid ? 'text-green-600' : 'text-red-500'}`}>
                        {oauthStatus}
                      </p>
                    )}
                  </div>
                </TabsContent>
              </Tabs>
            )}

            {provider?.id !== 'arena' && !canLogin && (
              <CredentialFieldsForm
                fields={credentialFields}
                credentials={credentials}
                onChange={handleCredentialChange}
                t={t}
                providerId={provider?.id}
                disabled={busy || !credentialBaselineReady.current}
              />
            )}

            {validationResult.error && (
              <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 p-3 rounded-lg">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{validationResult.error}</span>
              </div>
            )}

            {validationResult.valid && validationResult.userInfo && (
              <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 p-3 rounded-lg">
                <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                <div>
                  <span className="font-medium">{t('providers.validationSuccess')}</span>
                  {validationResult.userInfo.quota !== undefined && (
                    <span className="ml-2">
                      {t('providers.quota')}: {validationResult.userInfo.used || 0} / {validationResult.userInfo.quota}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="mt-6">
            <Button
              variant="outline"
              onClick={() => handleDialogOpenChange(false)}
              disabled={isSubmitting}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="outline"
              onClick={handleValidate}
              disabled={busy || !credentialBaselineReady.current}
            >
              {isValidating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('oauth.validating')}
                </>
              ) : (
                <>
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  {t('providers.validateCredentials')}
                </>
              )}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={busy || (provider?.id === 'arena' && !isEditing && !validationResult.valid)}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('providers.saving')}
                </>
              ) : (
                isEditing ? t('providers.saveChanges') : t('providers.addAccount')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface CredentialFieldsFormProps {
  fields: CredentialField[]
  credentials: Record<string, string>
  onChange: (fieldName: string, value: string) => void
  t: (key: string) => string
  providerId?: string
  disabled?: boolean
}

function CredentialFieldsForm({ fields, credentials, onChange, t, providerId, disabled }: CredentialFieldsFormProps) {
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({})
  const [copiedFields, setCopiedFields] = useState<Record<string, boolean>>({})

  const toggleFieldVisibility = (fieldName: string) => {
    setVisibleFields(prev => ({
      ...prev,
      [fieldName]: !prev[fieldName]
    }))
  }

  const copyToClipboard = async (fieldName: string, value: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopiedFields(prev => ({ ...prev, [fieldName]: true }))
      setTimeout(() => {
        setCopiedFields(prev => ({ ...prev, [fieldName]: false }))
      }, 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const getFieldTranslation = (field: CredentialField) => {
    if (!providerId) return { label: field.label, placeholder: field.placeholder, helpText: field.helpText }

    const translations: Record<string, Record<string, { label: string; placeholder: string; helpText: string }>> = {
      deepseek: {
        token: {
          label: t('deepseek.userToken'),
          placeholder: t('deepseek.userTokenPlaceholder'),
          helpText: t('deepseek.userTokenHelp'),
        },
      },
      glm: {
        refresh_token: {
          label: t('glm.refreshToken'),
          placeholder: t('glm.refreshTokenPlaceholder'),
          helpText: t('glm.refreshTokenHelp'),
        },
      },
      kimi: {
        token: {
          label: t('kimi.accessToken'),
          placeholder: t('kimi.accessTokenPlaceholder'),
          helpText: t('kimi.accessTokenHelp'),
        },
      },
      minimax: {
        token: {
          label: t('minimax.token'),
          placeholder: t('minimax.tokenPlaceholder'),
          helpText: t('minimax.tokenHelp'),
        },
        realUserID: {
          label: t('minimax.realUserID'),
          placeholder: t('minimax.realUserIDPlaceholder'),
          helpText: t('minimax.realUserIDHelp'),
        },
      },
      qwen: {
        ticket: {
          label: t('qwen.ssoTicket'),
          placeholder: t('qwen.ssoTicketPlaceholder'),
          helpText: t('qwen.ssoTicketHelp'),
        },
      },
      'qwen-ai': {
        token: {
          label: t('qwen-ai.token'),
          placeholder: t('qwen-ai.tokenPlaceholder'),
          helpText: t('qwen-ai.tokenHelp'),
        },
        cookies: {
          label: t('qwen-ai.cookies'),
          placeholder: t('qwen-ai.cookiesPlaceholder'),
          helpText: t('qwen-ai.cookiesHelp'),
        },
      },
      zai: {
        token: {
          label: t('zai.token'),
          placeholder: t('zai.tokenPlaceholder'),
          helpText: t('zai.tokenHelp'),
        },
      },
      mimo: {
        service_token: {
          label: t('mimo.serviceToken'),
          placeholder: t('mimo.serviceTokenPlaceholder'),
          helpText: t('mimo.serviceTokenHelp'),
        },
        user_id: {
          label: t('mimo.userId'),
          placeholder: t('mimo.userIdPlaceholder'),
          helpText: t('mimo.userIdHelp'),
        },
        ph_token: {
          label: t('mimo.phToken'),
          placeholder: t('mimo.phTokenPlaceholder'),
          helpText: t('mimo.phTokenHelp'),
        },
      },
      perplexity: {
        sessionToken: {
          label: t('perplexity.sessionToken'),
          placeholder: t('perplexity.sessionTokenPlaceholder'),
          helpText: t('perplexity.sessionTokenHelp'),
        },
      },
    }

    const providerTranslations = translations[providerId]
    if (providerTranslations && providerTranslations[field.name]) {
      return providerTranslations[field.name]
    }

    return { label: field.label, placeholder: field.placeholder, helpText: field.helpText }
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const translated = getFieldTranslation(field)
        const isPasswordField = field.type === 'password'
        const isVisible = visibleFields[field.name]
        const isCopied = copiedFields[field.name]
        const fieldValue = credentials[field.name] || ''
        
        return (
          <div key={field.name} className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor={field.name}>{translated.label}</Label>
              {field.required && (
                <Badge variant="outline" className="text-xs">{t('providers.required')}</Badge>
              )}
            </div>
            {field.type === 'textarea' ? (
              <div className="relative">
                <textarea
                  id={field.name}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 pr-20"
                  placeholder={translated.placeholder}
                  value={fieldValue}
                  disabled={disabled}
                  onChange={(e) => onChange(field.name, e.target.value)}
                />
                <div className="absolute right-1 top-1 flex gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => copyToClipboard(field.name, fieldValue)}
                    disabled={disabled || !fieldValue}
                  >
                    {isCopied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => toggleFieldVisibility(field.name)}
                    disabled={disabled}
                  >
                    {isVisible ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
              </div>
            ) : isPasswordField ? (
              <div className="relative">
                <Input
                  id={field.name}
                  type={isVisible ? 'text' : 'password'}
                  placeholder={translated.placeholder}
                  value={fieldValue}
                  disabled={disabled}
                  onChange={(e) => onChange(field.name, e.target.value)}
                  className="pr-20"
                />
                <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => copyToClipboard(field.name, fieldValue)}
                    disabled={disabled || !fieldValue}
                  >
                    {isCopied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => toggleFieldVisibility(field.name)}
                    disabled={disabled}
                  >
                    {isVisible ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <Input
                id={field.name}
                type={field.type}
                placeholder={translated.placeholder}
                value={fieldValue}
                disabled={disabled}
                onChange={(e) => onChange(field.name, e.target.value)}
              />
            )}
            {translated.helpText && (
              <p className="text-xs text-muted-foreground">{translated.helpText}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function getDefaultCredentialFields(authType?: string, t?: (key: string) => string): CredentialField[] {
  const fieldConfigs: Record<string, CredentialField[]> = {
    token: [
      {
        name: 'token',
        label: 'API Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterApiToken') : 'Enter API Token',
      },
    ],
    cookie: [
      {
        name: 'cookie',
        label: 'Cookie',
        type: 'textarea',
        required: true,
        placeholder: t ? t('providers.enterCookieString') : 'Enter complete Cookie string',
      },
    ],
    oauth: [
      {
        name: 'access_token',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterOAuthAccessToken') : 'Enter OAuth Access Token',
      },
    ],
    refresh_token: [
      {
        name: 'refresh_token',
        label: 'Refresh Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterRefreshToken') : 'Enter Refresh Token',
      },
    ],
    jwt: [
      {
        name: 'jwt',
        label: 'JWT Token',
        type: 'textarea',
        required: true,
        placeholder: t ? t('providers.enterJwtToken') : 'Enter JWT Token (starts with eyJ)',
      },
    ],
  }

  return fieldConfigs[authType || 'token'] || fieldConfigs.token
}

export default AddAccountDialog
