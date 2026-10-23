import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { WorkGroup } from '../../api/types'
import { STATUS_LABEL, sourceProblemText, statusRank, summarizeChanges, summarizeKindCounts } from '../../domain/labels'
import { ageLabel, formatMsk, formatStay, mskDate, nextDate, pluralWord, remainingMinutes } from '../../domain/time'
import { useWorkplace } from '../../state/workplace'
import { Badge, Banner, Button, Dialog, Drawer, EmptyState, cardClass } from '../../ui/kit'
import { OVERVIEW_CARDS, overviewCardCount, passesQueueFilter, type OverviewCard, type QueueDateFilter, type QueueFilterGroup } from './overviewCards'

export function OverviewPage() {
  const loaded = useWorkplace((state) => state.loaded)
  const nowIso = useWorkplace((state) => state.nowIso)
  const allGroups = useWorkplace((state) => state.groups)
  const letters = useWorkplace((state) => state.letters)
  const source = useWorkplace((state) => state.source)
  const journal = useWorkplace((state) => state.journal)
  const snapshots = useWorkplace((state) => state.snapshots)
  const integrations = useWorkplace((state) => state.integrations)
  const busy = useWorkplace((state) => state.busy)
  const refresh = useWorkplace((state) => state.refresh)
  const establishBaseline = useWorkplace((state) => state.establishBaseline)
  const prepareGroup = useWorkplace((state) => state.prepareGroup)
  const importWorkbook = useWorkplace((state) => state.importWorkbook)
  const navigate = useNavigate()
  const [card, setCard] = useState<OverviewCard | null>(null)
  const [dates, setDates] = useState<QueueDateFilter>('both')
  const [airport, setAirport] = useState('all')
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const workbookRef = useRef<HTMLInputElement>(null)
  const [baseOpen, setBaseOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const groups = useMemo(() => [...allGroups].sort((left, right) => statusRank(left.status) - statusRank(right.status)), [allGroups])
  const today = mskDate(nowIso)
  const tomorrow = nextDate(today)
  const inScope = (group: WorkGroup, selected: OverviewCard | null) => passesQueueFilter(toQueueGroup(group), { dates, today, tomorrow, airport, query, card: selected })
  const listed = useMemo(() => groups.filter((group) => inScope(group, null)), [airport, dates, groups, query, today, tomorrow])
  const visible = useMemo(() => listed.filter((group) => inScope(group, card)), [airport, card, dates, listed, query, today, tomorrow])
  const selected = groups.find((group) => group.key === selectedKey) ?? null
  const needsBase = groups.some((group) => group.status === 'needs_baseline')
  const latest = snapshots[0]
  const mailInApp = integrations.some((item) => item.adapter === 'mail' && item.configured)
  const reload = async () => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }
  const openMail = (group: WorkGroup) => navigate(`/mail?group=${group.key}`)
  const openWorkbook = () => workbookRef.current?.click()
  const uploadWorkbook = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void importWorkbook(file)
  }
  if (!loaded) return <p className="text-sm text-ink-soft">Загрузка…</p>
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[28px] font-bold leading-9">Обзор смены</h1>
          <p className="text-ink-soft">Контроль корректировок размещения экипажей</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void reload()} disabled={refreshing}>
            {refreshing ? 'Обновляем…' : 'Обновить'}
          </Button>
          <Button tone="ghost" disabled={busy === 'import'} onClick={openWorkbook}>
            {busy === 'import' ? 'Загружаем…' : 'Загрузить Excel'}
          </Button>
          <input ref={workbookRef} className="hidden" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="Файл Excel" onChange={uploadWorkbook} />
        </div>
      </div>
      <div className={`${cardClass} flex flex-wrap gap-6 text-sm`}>
        <span>Источник: {latest?.source ?? 'нет данных'}</span>
        <span className="tabular-nums">Последний снимок: {source?.lastSuccessAt ? formatMsk(source.lastSuccessAt) : 'нет'}</span>
        <span>Почта: {mailInApp ? 'отправка в интерфейсе' : 'передача в клиент'}</span>
      </div>
      {source?.problem && groups.length > 0 ? (
        <Banner tone={source.problem === 'SOURCE_UNAVAILABLE' ? 'error' : 'warn'}>
          {sourceProblemText(source.problem)}. Данные от {source.lastSuccessAt ? formatMsk(source.lastSuccessAt) : 'последнего снимка'} сохранены.
          <span className="ml-3">
            <Button tone="ghost" disabled={busy === 'import'} onClick={openWorkbook}>Загрузить свежий Excel</Button>
          </span>
        </Banner>
      ) : null}
      {needsBase ? (
        <Banner tone="info">
          Сначала выберите исходное состояние.
          <span className="ml-3">
            <Button disabled={busy === 'baseline'} onClick={() => setBaseOpen(true)}>Исходная рассылка уже выполнена</Button>
          </span>
        </Banner>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {OVERVIEW_CARDS.map((item) => {
          const count = overviewCardCount(listed, item.id)
          return <Stat key={item.id} title={item.title} value={count} unit={pluralWord(count, ...item.unit)} active={card === item.id} onClick={() => setCard(card === item.id ? null : item.id)} />
        })}
      </div>
      <section className={cardClass}>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-lg font-bold">Рабочая очередь · {visible.length}</h2>
          {(['both', 'today', 'tomorrow', 'all'] as const).map((value) => (
            <button key={value} type="button" aria-pressed={dates === value} className={`min-h-11 rounded-full px-3 py-1 text-sm ${dates === value ? 'bg-brand font-semibold text-white' : 'bg-muted'}`} onClick={() => setDates(value)}>
              {value === 'both' ? 'Обе даты' : value === 'today' ? `Сегодня ${formatStay(today).slice(0, 5)}` : value === 'tomorrow' ? `Завтра ${formatStay(tomorrow).slice(0, 5)}` : 'Все даты'}
            </button>
          ))}
          <select className="h-11 rounded-xl bg-muted px-3" value={airport} onChange={(event) => setAirport(event.target.value)} aria-label="Аэропорт">
            <option value="all">Все аэропорты</option>
            {[...new Set(groups.map((group) => group.airportCode))].map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
          <input className="h-11 rounded-xl bg-muted px-3" placeholder="Гостиница, город, ФИО" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Поиск" />
          <button type="button" className="min-h-11 text-sm font-semibold text-brand-strong" onClick={() => { setCard(null); setDates('both'); setAirport('all'); setQuery('') }}>
            Сбросить фильтры
          </button>
        </div>
        {visible.length === 0 && card ? (
          <EmptyState title="Здесь делать нечего" action={<Button tone="ghost" onClick={() => setCard(null)}>Показать все</Button>} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={groups.length === 0 ? 'Данных ещё нет' : groups.some((group) => group.changes.length > 0) ? 'Нет результатов' : 'Неуведомлённых изменений нет'}
            action={groups.length === 0 ? <Button disabled={busy === 'import'} onClick={openWorkbook}>Загрузить Excel</Button> : undefined}
          />
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
                    onClick={() => setSelectedKey(group.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') setSelectedKey(group.key)
                    }}
                  >
                    <td className="py-3 pr-3">
                      <span className="block font-semibold">{group.hotel.name}</span>
                      <span className="text-xs text-ink-soft">{group.hotel.city} · {group.airportCode}</span>
                    </td>
                    <td className="tabular-nums" title={`${group.hotel.timezone} ${group.hotel.utcOffset}`}>{formatStay(group.localStayDate)}</td>
                    <td>{group.changes.length ? summarizeChanges(group.changes.map((change) => change.kind)) : '—'}</td>
                    <td className="tabular-nums">{group.lastChangeAt ? `${formatMsk(group.lastChangeAt)} · ${ageLabel(group.lastChangeAt, nowIso)}` : '—'}</td>
                    <td>{group.revision ? `черновик v${group.revision}` : group.dueAt ? quietLabel(group.dueAt, nowIso) : '—'}</td>
                    <td><Badge tone={group.status}>{STATUS_LABEL[group.status]}</Badge></td>
                    <td>
                      <button
                        type="button"
                        className="min-h-11 font-semibold text-brand-strong"
                        onClick={(event) => {
                          event.stopPropagation()
                          openAction(group, nowIso, { navigate, openMail, prepare: (key) => void prepareGroup(key), select: setSelectedKey, chooseBase: () => setBaseOpen(true) })
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
          {journal.length === 0 ? <p className="text-sm text-ink-soft">Событий ещё нет</p> : null}
          <ul className="flex flex-col gap-2 text-sm">
            {journal.slice(0, 6).map((item) => (
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
          <p className="text-sm">
            {latest?.windowFrom && latest.windowTo ? `Окно ${formatStay(latest.windowFrom)} — ${formatStay(latest.windowTo)} · ` : ''}записей {latest?.rowCount ?? 0}
          </p>
          <p className="mt-2 text-sm tabular-nums">Успех: {source?.lastSuccessAt ? formatMsk(source.lastSuccessAt) : 'нет'}</p>
          <p className="text-sm">Ошибка: {source?.lastErrorCode ?? 'нет'}</p>
          <p className="mt-2 text-sm">База: {groups.length === 0 ? 'нет данных' : needsBase ? 'не выбрана' : 'зафиксирована'}</p>
          <button type="button" className="mt-3 min-h-11 text-sm font-semibold text-brand-strong" onClick={() => navigate('/history?tab=snapshots')}>
            История снимков
          </button>
        </section>
      </div>
      <Drawer open={Boolean(selected)} title={selected?.hotel.name ?? 'Группа'} onClose={() => setSelectedKey(null)}>
        {selected ? (
          <GroupBody
            group={selected}
            hasDraft={Boolean(letters[selected.key])}
            nowIso={nowIso}
            preparing={busy === 'prepare'}
            onMail={() => openMail(selected)}
            onHistory={() => navigate(`/history?hotel=${selected.hotel.id}&date=${selected.localStayDate}`)}
            onPrepare={() => void prepareGroup(selected.key)}
          />
        ) : null}
      </Drawer>
      <BaselineDialog open={baseOpen} count={groups.filter((group) => group.status === 'needs_baseline').length} onClose={() => setBaseOpen(false)} onConfirm={() => { setBaseOpen(false); void establishBaseline() }} />
    </div>
  )
}

function toQueueGroup(group: WorkGroup): QueueFilterGroup {
  return {
    status: group.status,
    localStayDate: group.localStayDate,
    airportCode: group.airportCode,
    hotelName: group.hotel.name,
    city: group.hotel.city,
    crewNames: group.crewNames,
    changes: group.changes,
  }
}

function BaselineDialog({ open, count, onClose, onConfirm }: { open: boolean; count: number; onClose: () => void; onConfirm: () => void }) {
  return (
    <Dialog open={open} title="Исходное состояние" onClose={onClose} footer={<Button onClick={onConfirm}>Рассылка уже выполнена</Button>}>
      <p className="text-sm">Последний снимок станет базой для {pluralWord(count, 'группы', 'групп', 'групп')}: {count}. Дальше в письма попадут только новые изменения.</p>
    </Dialog>
  )
}

function quietLabel(dueAt: string, nowIso: string): string {
  const minutes = remainingMinutes(dueAt, nowIso)
  return minutes > 0 ? `ещё ${minutes} мин` : 'пауза прошла'
}

function Stat({ title, value, unit, active, onClick }: { title: string; value: number; unit: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} className={`${cardClass} text-left ${active ? 'ring-2 ring-brand-strong' : ''}`}>
      <span className="block text-3xl font-bold tabular-nums">{value}</span>
      <span className="text-xs text-ink-soft">{unit}</span>
      <span className="mt-2 block text-sm font-semibold">{title}</span>
    </button>
  )
}

function needsRecipient(group: WorkGroup): boolean {
  return group.exceptions.some((item) => item.kind === 'no_address' || item.kind === 'no_contract' || item.kind === 'unknown_hotel')
}

function actionLabel(group: WorkGroup): string {
  if (group.status === 'needs_review') return 'Проверить письмо'
  if (group.status === 'reviewed' || group.status === 'handed_off') return 'Открыть письмо'
  if (group.status === 'stale') return 'Обновить черновик'
  if (group.status === 'needs_decision') return needsRecipient(group) ? 'Настроить получателя' : 'Разобрать'
  if (group.status === 'waiting') return 'Посмотреть изменения'
  if (group.status === 'needs_baseline') return 'Задать отправную'
  return 'Посмотреть'
}

interface ActionHandlers {
  navigate: (path: string) => void
  openMail: (group: WorkGroup) => void
  prepare: (key: string) => void
  select: (key: string) => void
  chooseBase: () => void
}

function openAction(group: WorkGroup, nowIso: string, handlers: ActionHandlers) {
  if (group.status === 'needs_review' || group.status === 'reviewed' || group.status === 'handed_off' || group.status === 'stale') {
    handlers.openMail(group)
    return
  }
  if (group.status === 'needs_baseline') {
    handlers.chooseBase()
    return
  }
  if (group.status === 'needs_decision' && needsRecipient(group)) {
    handlers.navigate(`/settings?tab=hotels&hotel=${group.hotel.id}`)
    return
  }
  if (!group.draftId && group.status === 'waiting' && group.dueAt && group.dueAt <= nowIso) handlers.prepare(group.key)
  handlers.select(group.key)
}

function GroupBody({ group, hasDraft, nowIso, preparing, onMail, onHistory, onPrepare }: { group: WorkGroup; hasDraft: boolean; nowIso: string; preparing: boolean; onMail: () => void; onHistory: () => void; onPrepare: () => void }) {
  const canPrepare = group.changes.length > 0 && !group.exceptions.some((item) => item.blocking)
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>{formatStay(group.localStayDate)} · {group.airportCode} · {group.hotel.recipients.join(', ') || 'адрес не задан'}</p>
      <Badge tone={group.status}>{STATUS_LABEL[group.status]}</Badge>
      {group.dueAt ? <p className="tabular-nums">Пауза до {formatMsk(group.dueAt)} · {quietLabel(group.dueAt, nowIso)}</p> : null}
      {group.exceptions.map((item) => <p key={item.id} className="text-danger">{item.message}</p>)}
      <table className="w-full text-left">
        <thead className="text-xs text-ink-soft"><tr><th>Поле</th><th>Было</th><th>Стало</th></tr></thead>
        <tbody>
          {group.changes.flatMap((change) => change.fields.map((field) => (
            <tr key={`${change.id}-${field.field}`} className="border-t border-line">
              <td className="py-2">{change.fullName} · {field.label}</td>
              <td className="text-ink-soft">{field.before || '—'}</td>
              <td className="font-semibold">{field.after || '—'}</td>
            </tr>
          )))}
        </tbody>
      </table>
      {group.changes.length === 0 ? <p>Изменений относительно уведомлённого состояния нет.</p> : null}
      {group.changes.length > 0 ? <p className="text-xs text-ink-soft">{summarizeKindCounts(group.changes.map((change) => change.kind))}</p> : null}
      <div className="mt-auto flex gap-2">
        {hasDraft ? <Button onClick={onMail}>Открыть письмо</Button> : <Button disabled={!canPrepare || preparing} onClick={onPrepare}>Подготовить сейчас</Button>}
        <Button tone="ghost" onClick={onHistory}>Вся история</Button>
      </div>
    </div>
  )
}
