import { useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { actorLabel } from '../domain/labels'
import { formatMsk } from '../domain/time'
import { selectGroups } from '../domain/view'
import { SCENARIOS } from '../fixtures/scenarios'
import { useDemoStore } from '../state/store'
import { Badge, Button, Dialog, cx } from './kit'

const LINKS = [
  { to: '/overview', label: 'Обзор', icon: '◎' },
  { to: '/corrections', label: 'Корректировки', icon: '⇄' },
  { to: '/mail', label: 'Письма', icon: '✉' },
  { to: '/history', label: 'История', icon: '☰' },
  { to: '/settings', label: 'Настройки', icon: '⚙' },
]

export function Shell() {
  const data = useDemoStore((state) => state.data)
  const scenarioOpen = useDemoStore((state) => state.scenarioOpen)
  const setScenarioOpen = useDemoStore((state) => state.setScenarioOpen)
  const chooseScenario = useDemoStore((state) => state.chooseScenario)
  const setPaused = useDemoStore((state) => state.setPaused)
  const advanceMinutes = useDemoStore((state) => state.advanceMinutes)
  const tickSecond = useDemoStore((state) => state.tickSecond)
  const addChange = useDemoStore((state) => state.addChange)
  const armOutage = useDemoStore((state) => state.armOutage)
  const setRole = useDemoStore((state) => state.setRole)
  const resetAll = useDemoStore((state) => state.resetAll)
  const toasts = useDemoStore((state) => state.toasts)
  const dismissToast = useDemoStore((state) => state.dismissToast)
  const persistenceError = useDemoStore((state) => state.persistenceError)
  const reviewCount = selectGroups(data).filter((group) => group.status === 'needs_review').length

  useEffect(() => {
    const timer = window.setInterval(() => tickSecond(), 1000)
    return () => window.clearInterval(timer)
  }, [tickSecond])

  return (
    <div className="min-h-full bg-canvas text-ink">
      <header className="fixed inset-x-0 top-0 z-30 flex h-16 items-center justify-between gap-4 border-b border-line bg-white px-4 md:px-6">
        <div className="flex items-center gap-3">
          <div>
            <p className="text-sm font-bold leading-5">Crew Support / Гостиницы</p>
            <p className="text-xs text-ink-soft">Демо</p>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-soft">
          <Badge tone={data.sourceStatus === 'error' ? 'error' : data.sourceStatus === 'ok' ? 'ok' : 'info'}>
            Aviabit · {data.sourceStatus === 'ok' ? 'демо доступно' : data.sourceStatus === 'error' ? 'ошибка демо' : 'не настроено'}
          </Badge>
          <span className="hidden lg:inline">Почта · {data.settings.mailMode === 'in_app' ? 'отправка в интерфейсе' : 'передача в клиент'}</span>
          <span className="hidden tabular-nums xl:inline">{data.lastSuccessAt ? formatMsk(data.lastSuccessAt) : 'снимка нет'}</span>
          <span className="font-semibold text-ink">{actorLabel(data.role)}</span>
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
              className={({ isActive }) =>
                cx('flex h-11 items-center gap-3 rounded-2xl px-3 text-sm font-semibold', isActive ? 'bg-brand-soft text-ink' : 'text-ink-soft hover:bg-muted')
              }
            >
              <span aria-hidden="true">{link.icon}</span>
              <span className="hidden min-[1366px]:inline">{link.label}</span>
              {link.to === '/mail' && reviewCount > 0 ? <span className="ml-auto hidden rounded-full bg-brand-strong px-2 py-0.5 text-xs text-white min-[1366px]:inline">{reviewCount}</span> : null}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line p-3 text-xs">
          <p className="hidden font-semibold min-[1366px]:block">Демонстрация</p>
          <button type="button" className="mt-2 font-semibold text-brand-strong" onClick={() => setScenarioOpen(true)}>
            Сценарии
          </button>
          <p className="mt-2 hidden text-ink-soft min-[1366px]:block">{actorLabel(data.role)}</p>
        </div>
      </aside>
      <main className="min-w-0 px-4 pb-24 pt-6 md:px-6">
        {persistenceError ? <p className="mb-4 rounded-2xl bg-[#fdecea] px-4 py-3 text-sm text-danger">{persistenceError}</p> : null}
        {data.phase === 'running' && data.clockPaused ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-brand-soft px-4 py-3 text-sm">
            <span>Демонстрация приостановлена — продолжить</span>
            <Button tone="soft" onClick={() => setPaused(false)}>
              Продолжить
            </Button>
          </div>
        ) : null}
        <Outlet />
      </main>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-white md:hidden" aria-label="Разделы">
        {LINKS.map((link) => (
          <NavLink key={link.to} to={link.to} className={({ isActive }) => cx('flex flex-1 flex-col items-center py-2 text-[11px]', isActive ? 'text-brand-strong' : 'text-ink-soft')}>
            <span>{link.icon}</span>
            {link.label}
          </NavLink>
        ))}
      </nav>
      <div className="fixed bottom-16 right-4 z-40 flex w-80 flex-col gap-2 md:bottom-4">
        {toasts.map((toast) => (
          <button key={toast.id} type="button" className="rounded-2xl bg-ink px-4 py-3 text-left text-sm text-white" onClick={() => dismissToast(toast.id)}>
            {toast.text}
          </button>
        ))}
      </div>
      <Dialog open={scenarioOpen} title="Сценарии демонстрации" onClose={() => setScenarioOpen(false)}>
        <p className="mb-3 text-sm text-ink-soft">Смена сценария сбрасывает текущую демо-смену. Обычные настройки сохраняются.</p>
        <div className="mb-4 flex gap-2">
          <Button tone={data.role === 'specialist' ? 'primary' : 'ghost'} onClick={() => setRole('specialist')}>
            Специалист
          </Button>
          <Button tone={data.role === 'lead' ? 'primary' : 'ghost'} onClick={() => setRole('lead')}>
            Руководитель
          </Button>
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          <Button tone="ghost" onClick={() => setPaused(!data.clockPaused)}>
            {data.clockPaused ? 'Play' : 'Pause'}
          </Button>
          <Button tone="ghost" onClick={() => advanceMinutes(1)}>
            +1 минута
          </Button>
          <Button tone="ghost" onClick={() => advanceMinutes(5)}>
            +5 минут
          </Button>
          <Button tone="ghost" onClick={addChange}>
            Добавить изменение
          </Button>
          <Button tone="ghost" onClick={armOutage}>
            Ошибка Aviabit
          </Button>
        </div>
        <p className="mb-2 text-xs tabular-nums text-ink-soft">Демо-время {formatMsk(data.clockIso)}</p>
        <ul className="flex flex-col gap-2">
          {SCENARIOS.map((scenario) => (
            <li key={scenario.id}>
              <button type="button" className="w-full rounded-2xl bg-muted px-3 py-3 text-left" onClick={() => chooseScenario(scenario.id)}>
                <span className="block text-sm font-semibold">{scenario.title}</span>
                <span className="text-xs text-ink-soft">{scenario.summary}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-4">
          <Button
            tone="ghost"
            onClick={() => {
              if (window.confirm('Сбросить демонстрацию вместе с настройками?')) resetAll()
            }}
          >
            Полный сброс
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
