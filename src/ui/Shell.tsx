import { useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { sourceProblemText } from '../domain/labels'
import { formatMsk } from '../domain/time'
import { useSession } from '../state/useSession'
import { useWorkplace } from '../state/workplace'
import { Badge, Button, cardClass, cx } from './kit'

const LINKS = [
  { to: '/overview', label: 'Обзор', icon: '◎' },
  { to: '/corrections', label: 'Корректировки', icon: '⇄' },
  { to: '/mail', label: 'Письма', icon: '✉' },
  { to: '/history', label: 'История', icon: '☰' },
  { to: '/settings', label: 'Настройки', icon: '⚙' },
]

const ACCOUNTS = [
  { subject: 'dev-specialist', label: 'Специалист смены' },
  { subject: 'dev-lead', label: 'Старший смены' },
]

const REFRESH_MS = 60_000
const TICK_MS = 30_000

export function Shell() {
  const session = useSession()
  if (!session.ready) return <p className="p-6 text-sm text-ink-soft">Загрузка…</p>
  if (!session.me) return <SignIn error={session.error} onChoose={session.choose} />
  return <Workspace displayName={session.me.displayName} onLeave={session.leave} />
}

function SignIn({ error, onChoose }: { error: string | null; onChoose: (subject: string) => void }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-canvas px-4 text-ink">
      <section className={`${cardClass} flex w-full max-w-sm flex-col gap-3`}>
        <h1 className="text-[28px] font-bold leading-9">Crew Support</h1>
        <p className="text-ink-soft">Гостиницы экипажей</p>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {ACCOUNTS.map((account) => (
          <Button key={account.subject} onClick={() => onChoose(account.subject)}>
            {account.label}
          </Button>
        ))}
      </section>
    </main>
  )
}

function Workspace({ displayName, onLeave }: { displayName: string; onLeave: () => void }) {
  const source = useWorkplace((state) => state.source)
  const integrations = useWorkplace((state) => state.integrations)
  const groups = useWorkplace((state) => state.groups)
  const latestSource = useWorkplace((state) => state.snapshots[0]?.source)
  const toasts = useWorkplace((state) => state.toasts)
  const dismissToast = useWorkplace((state) => state.dismissToast)
  const reviewCount = groups.filter((group) => group.status === 'needs_review').length
  const mailInApp = integrations.some((item) => item.adapter === 'mail' && item.configured)
  const sourceTone = source?.problem === 'SOURCE_UNAVAILABLE' ? 'error' : source?.problem ? 'waiting' : source?.lastSuccessAt ? 'ok' : 'info'
  const sourceLabel = source?.problem ? sourceProblemText(source.problem).toLowerCase() : (latestSource ?? 'нет данных')

  useEffect(() => {
    const { tick, refresh } = useWorkplace.getState()
    const ticker = window.setInterval(tick, TICK_MS)
    const poller = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, REFRESH_MS)
    return () => {
      window.clearInterval(ticker)
      window.clearInterval(poller)
    }
  }, [])

  return (
    <div className="min-h-full bg-canvas text-ink">
      <header className="fixed inset-x-0 top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-line bg-white px-4 md:px-6">
        <p className="text-sm font-bold leading-5">Crew Support / Гостиницы</p>
        <div className="flex items-center gap-3 text-xs text-ink-soft">
          <Badge tone={sourceTone}>Aviabit · {sourceLabel}</Badge>
          <span className="hidden lg:inline">Почта · {mailInApp ? 'отправка в интерфейсе' : 'передача в клиент'}</span>
          <span className="hidden tabular-nums xl:inline">{source?.lastSuccessAt ? formatMsk(source.lastSuccessAt) : 'снимка нет'}</span>
          <span className="font-semibold text-ink">{displayName}</span>
        </div>
      </header>
      <div className="shell-body pt-16">
        <aside className="hidden min-h-[calc(100vh-4rem)] flex-col border-r border-line bg-white md:flex">
          <nav className="flex flex-1 flex-col gap-1 p-2" aria-label="Разделы">
            {LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                title={link.label}
                aria-label={link.label}
                className={({ isActive }) => cx('flex h-11 items-center gap-3 rounded-2xl px-3 text-sm font-semibold', isActive ? 'bg-brand-soft text-ink' : 'text-ink-soft hover:bg-muted')}
              >
                <span aria-hidden="true">{link.icon}</span>
                <span className="hidden min-[1366px]:inline">{link.label}</span>
                {link.to === '/mail' && reviewCount > 0 ? <span className="ml-auto hidden rounded-full bg-brand-strong px-2 py-0.5 text-xs text-white min-[1366px]:inline">{reviewCount}</span> : null}
              </NavLink>
            ))}
          </nav>
          <div className="border-t border-line p-3 text-xs">
            <p className="hidden font-semibold min-[1366px]:block">{displayName}</p>
            <button type="button" className="mt-2 min-h-11 font-semibold text-brand-strong" onClick={onLeave}>
              Выйти
            </button>
          </div>
        </aside>
        <main className="min-w-0 px-4 pb-24 pt-6 md:px-6">
          <Outlet />
        </main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-white md:hidden" aria-label="Разделы">
        {LINKS.map((link) => (
          <NavLink key={link.to} to={link.to} className={({ isActive }) => cx('flex min-h-11 flex-1 flex-col items-center py-2 text-[11px]', isActive ? 'text-brand-strong' : 'text-ink-soft')}>
            <span aria-hidden="true">{link.icon}</span>
            {link.label}
          </NavLink>
        ))}
      </nav>
      <div className="fixed bottom-16 right-4 z-40 flex w-80 flex-col gap-2 md:bottom-4" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <button key={toast.id} type="button" className="rounded-2xl bg-ink px-4 py-3 text-left text-sm text-white" onClick={() => dismissToast(toast.id)}>
            {toast.text}
          </button>
        ))}
      </div>
    </div>
  )
}
