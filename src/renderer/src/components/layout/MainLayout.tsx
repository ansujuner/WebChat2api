import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { useTranslation } from 'react-i18next'

export function MainLayout() {
  const { t } = useTranslation()
  return (
    <div className="app-shell flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <a href="#main-content" onClick={(event) => {
        // HashRouter owns the URL fragment; move focus without changing the route.
        event.preventDefault()
        const content = document.getElementById('main-content')
        content?.focus({ preventScroll: true })
        content?.scrollIntoView({ block: 'start', behavior: 'auto' })
      }} className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground">{t('shell.skipNavigation')}</a>
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main id="main-content" tabIndex={-1} className="app-main min-w-0 flex-1 overflow-auto p-5 lg:p-7 focus:outline-none">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
