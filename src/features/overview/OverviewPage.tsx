import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { KIND_LABEL, STATUS_LABEL, summarizeChanges } from '../../domain/labels'
import { ageLabel, formatMsk, formatStay, mskDate, nextDate, pluralWord, remainingMinutes } from '../../domain/time'
import type { GroupView } from '../../domain/types'
import { selectGroups } from '../../domain/view'
import { useDemoStore } from '../../state/store'
import { Badge, Banner, Button, Dialog, Drawer, EmptyState, cardClass } from '../../ui/kit'
import { OVERVIEW_CARDS, matchesOverviewCard, overviewCardCount, type OverviewCard } from './overviewCards'

export function OverviewPage() {
  const data = useDemoStore((state) => state.data)
  const startCalm = useDemoStore((state) => state.startCalm)
  const runCheck = useDemoStore((state) => state.runCheck)
  const recoverSource = useDemoStore((state) => state.recoverSource)
  const importSample = useDemoStore((state) => state.importSample)
  const setBaseline = useDemoStore((state) => state.setBaseline)
  const prepareGroup = useDemoStore((state) => state.prepareGroup)
  const navigate = useNavigate()
  const [card, setCard] = useState<OverviewCard | null>(null)
  const [dates, setDates] = useState<'today' | 'tomorrow' | 'both'>('both')
  const [airport, setAirport] = useState('all')
  const [query, setQuery] = useState('')
  const [showDone, setShowDone] = useState(false)
  const [selected, setSelected] = useState<GroupView | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [upload, setUpload] = useState<{ name: string; size: number; at: string } | null>(null)
  const groups = selectGroups(data)
  const today = mskDate(data.clockIso)
  const tomorrow = nextDate(today)
  const visible = useMemo(() => {
    return groups.filter((group) => {
      if (!showDone && (group.status === 'unchanged' || group.status === 'sent')) return false
      if (dates === 'today' && group.localStayDate !== today) return false
      if (dates === 'tomorrow' && group.localStayDate !== tomorrow) return false
      if (airport !== 'all' && group.airportCode !== airport) return false
      if (!matchesOverviewCard(group, card)) return false
      if (!query.trim()) return true
      const haystack = `${group.hotel.name} ${group.hotel.city} ${group.latestBookings.map((booking) => booking.fullName).join(' ')}`.toLowerCase()
      return haystack.includes(query.trim().toLowerCase())
    })
  }, [airport, card, dates, groups, query, showDone, today, tomorrow])
  if (data.phase !== 'running') {
    return (
      <EmptyState
        title="Запустить демо-смену"
        action={<Button onClick={startCalm}>Запустить демо-смену</Button>}
      />
    )
  }
  const needsBase = !data.baselineEstablished
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold leading-9">Обзор смены</h1>
          <p className="text-ink-soft">Контроль корректировок размещения экипажей</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={runCheck} disabled={data.checking}>
            {data.checking ? 'Проверяем…' : 'Проверить сейчас'}
          </Button>
          <Button tone="ghost" onClick={() => setImportOpen(true)}>
            Загрузить Excel
          </Button>
        </div>
      </div>
      <div className={`${cardClass} flex flex-wrap gap-6 text-sm`}>
        <span>Источник: {data.settings.sourceMode === 'demo_api' ? 'демо-API' : 'ручные образцы'}</span>
        <span className="tabular-nums">Последняя проверка: {data.lastSuccessAt ? formatMsk(data.lastSuccessAt) : 'нет'}</span>
        <span className="tabular-nums">Следующая: {data.nextCheckAt ? formatMsk(data.nextCheckAt) : 'выключена'}</span>
        <span>Почта: {data.settings.mailMode === 'in_app' ? 'демо в интерфейсе' : 'передача в клиент · демо'}</span>
      </div>
      {data.sourceStatus === 'error' ? (
        <Banner tone="error">
          Демо-API не ответил. Данные от {data.lastSuccessAt ? formatMsk(data.lastSuccessAt) : 'последнего снимка'} сохранены.
          <span className="ml-3">
            <Button tone="ghost" onClick={recoverSource}>Повторить</Button>
          </span>
        </Banner>
      ) : null}
      {needsBase ? (
        <Banner tone="info">
          Сначала выберите исходное состояние.
          <span className="ml-3">
            <Button tone="soft" onClick={setBaseline}>Исходная рассылка уже выполнена</Button>
          </span>
        </Banner>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {OVERVIEW_CARDS.map((item) => {
          const count = overviewCardCount(groups, item.id)
          return <Stat key={item.id} title={item.title} value={count} unit={pluralWord(count, ...item.unit)} active={card === item.id} onClick={() => setCard(card === item.id ? null : item.id)} />
        })}
      </div>
      <section className={cardClass}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg font-bold">Рабочая очередь · {visible.length}</h2>
          {(['both', 'today', 'tomorrow'] as const).map((value) => (
            <button key={value} type="button" className={`rounded-full px-3 py-1 text-sm ${dates === value ? 'bg-brand-soft' : 'bg-muted'}`} onClick={() => setDates(value)}>
              {value === 'both' ? 'Обе даты' : value === 'today' ? 'Сегодня' : 'Завтра'}
            </button>
          ))}
          <select className="h-10 rounded-xl bg-muted px-3" value={airport} onChange={(event) => setAirport(event.target.value)} aria-label="Аэропорт">
            <option value="all">Все аэропорты</option>
            {[...new Set(groups.map((group) => group.airportCode))].map((code) => (
              <option key={code}>{code}</option>
            ))}
          </select>
          <input className="h-10 rounded-xl bg-muted px-3" placeholder="Гостиница, город, ФИО" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Поиск" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showDone} onChange={(event) => setShowDone(event.target.checked)} />
            Показать обработанные
          </label>
          <button type="button" className="text-sm font-semibold text-brand-strong" onClick={() => { setCard(null); setDates('both'); setAirport('all'); setQuery(''); setShowDone(false) }}>
            Сбросить фильтры
          </button>
        </div>
        {visible.length === 0 && card ? (
          <EmptyState title="Здесь делать нечего" action={<Button tone="ghost" onClick={() => setCard(null)}>Показать все</Button>} />
        ) : visible.length === 0 ? (
          <EmptyState title={groups.some((group) => group.changes.length > 0) ? 'Нет результатов' : 'Неуведомлённых изменений нет'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead className="text-xs text-ink-soft">
                <tr>
                  <th className="py-2">Гостиница</th>
                  <th>Размещение</th>
                  <th>Изменения</th>
                  <th>Последнее изменение</th>
                  <th>Подготовка</th>
                  <th>Состояние</th>
                  <th>Действие</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((group) => (
                  <tr
                    key={group.key}
                    tabIndex={0}
                    className="cursor-pointer border-t border-line hover:bg-muted focus:bg-brand-soft"
                    onClick={() => setSelected(group)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') setSelected(group)
                    }}
                  >
                    <td className="py-3 pr-3">
                      <span className="block font-semibold">{group.hotel.name}</span>
                      <span className="text-xs text-ink-soft">{group.hotel.city} · {group.airportCode}</span>
                    </td>
                    <td className="tabular-nums" title={`${group.hotel.timezone} ${group.hotel.utcOffset}`}>{formatStay(group.localStayDate)}</td>
                    <td>{group.changes.length ? summarizeChanges(group.changes.map((change) => change.kind)) : '—'}</td>
                    <td className="tabular-nums">{group.lastChangeAt ? `${formatMsk(group.lastChangeAt)} · ${ageLabel(group.lastChangeAt, data.clockIso)}` : '—'}</td>
                    <td>{group.draft ? `черновик v${group.draft.revision}` : group.dueAt ? quietLabel(group.dueAt, data.clockIso) : '—'}</td>
                    <td><Badge tone={group.status}>{STATUS_LABEL[group.status]}</Badge></td>
                    <td>
                      <button
                        type="button"
                        className="font-semibold text-brand-strong"
                        onClick={(event) => {
                          event.stopPropagation()
                          openAction(group, data.clockIso, navigate, prepareGroup, setSelected)
                        }}
                      >
                        {actionLabel(group)}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className={cardClass}>
          <h2 className="mb-3 text-lg font-bold">Последние события</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {data.activities.slice(0, 6).map((item) => (
              <li key={item.id} className="flex justify-between gap-3 border-b border-line py-2">
                <span>
                  <span className="tabular-nums text-ink-soft">{formatMsk(item.timestamp)}</span> {item.action}
                  {item.hotelName ? ` · ${item.hotelName}` : ''} — {item.description}
                </span>
                <Badge tone={item.result}>{item.actor}</Badge>
              </li>
            ))}
          </ul>
        </section>
        <section className={cardClass}>
          <h2 className="mb-3 text-lg font-bold">Источник</h2>
          <p className="text-sm">Окно 06.10.2026 — 10.10.2026 · записей {data.snapshots.at(-1)?.bookings.length ?? 0}</p>
          <p className="mt-2 text-sm tabular-nums">Успех: {data.lastSuccessAt ? formatMsk(data.lastSuccessAt) : 'нет'}</p>
          <p className="text-sm tabular-nums">Ошибка: {data.lastErrorAt ? formatMsk(data.lastErrorAt) : 'нет'}</p>
          <p className="mt-2 text-sm">База: {data.baselineEstablished ? 'подтверждена для демо' : 'не выбрана'}</p>
          <button type="button" className="mt-3 text-sm font-semibold text-brand-strong" onClick={() => navigate('/history?tab=snapshots')}>
            История снимков
          </button>
        </section>
      </div>
      <span className="sr-only">{today}</span>
      <Drawer open={Boolean(selected)} title={selected?.hotel.name ?? 'Группа'} onClose={() => setSelected(null)}>
        {selected ? <GroupBody group={selected} now={data.clockIso} onMail={() => navigate(`/mail?draft=${selected.draft?.id ?? ''}&group=${selected.key}`)} onHistory={() => navigate(`/history?hotel=${selected.hotel.id}&date=${selected.localStayDate}`)} onPrepare={() => prepareGroup(selected.key)} /> : null}
      </Drawer>
      <Dialog
        open={importOpen}
        title="Сравнить выгрузки"
        onClose={() => setImportOpen(false)}
        footer={
          <>
            <Button
              onClick={() => {
                importSample()
                setImportOpen(false)
              }}
            >
              Использовать демо-образцы
            </Button>
            <Button tone="ghost" disabled title="Структура ещё не согласована">
              Сравнить файл
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={cardClass}>Предыдущая · {data.snapshots.at(-2)?.label ?? 'нет'}</div>
          <div className={cardClass}>Новая · {data.snapshots.at(-1)?.label ?? 'нет'}</div>
        </div>
        <label className="mt-4 block text-sm font-semibold">
          Свой файл
          <input
            className="mt-2 block text-sm font-normal"
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (!file) return
              setUpload({ name: file.name, size: file.size, at: formatMsk(data.clockIso) })
            }}
          />
        </label>
        {upload ? (
          <p className="mt-3 text-sm">
            {upload.name}, {upload.size} байт, {upload.at}. Структура ещё не согласована — сравнение недоступно.
          </p>
        ) : null}
      </Dialog>
      </div>
  )
}

function quietLabel(dueAt: string, nowIso: string): string {
  const minutes = remainingMinutes(dueAt, nowIso)
  return minutes > 0 ? `ещё ${minutes} мин` : 'тишина прошла'
}

function Stat({ title, value, unit, active, onClick }: { title: string; value: number; unit: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={`${cardClass} text-left ${active ? 'ring-2 ring-brand-strong' : ''}`}>
      <span className="block text-3xl font-bold tabular-nums">{value}</span>
      <span className="text-xs text-ink-soft">{unit}</span>
      <span className="mt-2 block text-sm font-semibold">{title}</span>
    </button>
  )
}

function actionLabel(group: GroupView): string {
  if (group.status === 'needs_review') return 'Проверить письмо'
  if (group.status === 'reviewed') return 'Открыть письмо'
  if (group.status === 'stale') return 'Обновить черновик'
  if (group.status === 'needs_decision') return group.exceptions.some((item) => item.kind === 'no_address' || item.kind === 'no_contract') ? 'Настроить получателя' : 'Разобрать'
  if (group.status === 'waiting') return 'Посмотреть изменения'
  if (group.status === 'needs_baseline') return 'Выбрать базу'
  return 'Посмотреть'
}

function openAction(group: GroupView, nowIso: string, navigate: (path: string) => void, prepareGroup: (key: string) => void, setSelected: (group: GroupView) => void) {
  if (group.status === 'needs_review' || group.status === 'reviewed') {
    navigate(`/mail?draft=${group.draft?.id ?? ''}&group=${group.key}`)
    return
  }
  if (group.status === 'stale') {
    navigate(`/mail?group=${group.key}`)
    return
  }
  if (group.status === 'needs_decision' && group.exceptions.some((item) => item.kind === 'no_address' || item.kind === 'no_contract')) {
    navigate(`/settings?tab=hotels&hotel=${group.hotel.id}`)
    return
  }
  if (!group.draft && group.status === 'waiting' && group.dueAt && group.dueAt <= nowIso) prepareGroup(group.key)
  setSelected(group)
}

function GroupBody({ group, now, onMail, onHistory, onPrepare }: { group: GroupView; now: string; onMail: () => void; onHistory: () => void; onPrepare: () => void }) {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>{formatStay(group.localStayDate)} · {group.airportCode} · {group.hotel.recipients.join(', ') || 'адрес не задан'}</p>
      <Badge tone={group.status}>{STATUS_LABEL[group.status]}</Badge>
      {group.dueAt ? <p className="tabular-nums">Тишина до {formatMsk(group.dueAt)} · {quietLabel(group.dueAt, now)}</p> : null}
      <table className="w-full text-left">
        <thead className="text-xs text-ink-soft"><tr><th>Поле</th><th>Было</th><th>Стало</th></tr></thead>
        <tbody>
          {group.changes.flatMap((change) => change.fields.map((field) => (
            <tr key={`${change.id}-${field.field}`} className="border-t border-line">
              <td className="py-2">{field.label}</td>
              <td className="text-ink-soft">{field.before || '—'}</td>
              <td className="font-semibold">{field.after || '—'}</td>
            </tr>
          )))}
        </tbody>
      </table>
      {group.changes.length === 0 ? <p>Изменений относительно уведомлённого состояния нет.</p> : null}
      <p className="text-xs text-ink-soft">{group.changes.map((change) => KIND_LABEL[change.kind]).join(', ')}</p>
      <div className="mt-auto flex gap-2">
        <Button onClick={group.draft ? onMail : onPrepare}>{group.draft ? 'Открыть письмо' : 'Подготовить сейчас'}</Button>
        <Button tone="ghost" onClick={onHistory}>Вся история</Button>
      </div>
    </div>
  )
}
