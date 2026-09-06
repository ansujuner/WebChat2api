import { oauthManager } from '../oauth/manager'
import { externalBrowserLoginManager, type LoginBrowserEnvironment } from '../oauth/externalBrowserLogin'
import { getProviderProxyConfig } from '../network/proxy'

export interface DeepSeekLoginReport {
  live: false
  stream: false
  protocol: 'openai'
  status: 'awaiting_login' | 'passed' | 'login_not_completed' | 'login_busy'
  accountVerified: boolean
  environment: LoginBrowserEnvironment | null
}

/** Explicit interactive login test. Report only environment checks and success, never credentials. */
export async function runDeepSeekLoginProbe(progress: (report: DeepSeekLoginReport) => Promise<void>): Promise<DeepSeekLoginReport> {
  const base: DeepSeekLoginReport = { live: false, stream: false, protocol: 'openai', status: 'awaiting_login', accountVerified: false, environment: null }
  if (oauthManager.isInAppLoginOpen()) return { ...base, status: 'login_busy' }
  let settled = false
  let successful = false
  let environment: LoginBrowserEnvironment | null = null
  let login: Promise<void> | undefined
  try {
    const proxyMode = getProviderProxyConfig('deepseek')
    login = oauthManager.startInAppLogin('deepseek', 'deepseek', 10 * 60 * 1000, proxyMode).then(result => {
      successful = result.success && !!result.credentials
      settled = true
      // A diagnostic does not add another account or export the returned token.
    }, () => { settled = true })
    while (!settled) {
      environment = await externalBrowserLoginManager.getBrowserEnvironment() ?? environment
      if (!settled) await progress({ ...base, environment })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([login, new Promise<void>(resolve => { timer = setTimeout(resolve, 1500) })])
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    const normalEnvironment = !!environment?.providerPages.length && environment.providerPages.every(page => !page.electron && !page.tauri && !page.unsafeWarningVisible)
    return { ...base, environment, accountVerified: successful, status: successful && normalEnvironment ? 'passed' : 'login_not_completed' }
  } catch {
    // Browser/IO errors can contain request data or credentials. Never export them.
    throw new Error('The DeepSeek login diagnostic could not be completed.')
  } finally {
    if (login && !settled) {
      try {
        oauthManager.cancelInAppLogin()
        await login
      } catch {
        throw new Error('The DeepSeek login diagnostic could not close its login window.')
      }
    }
  }
}
