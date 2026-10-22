import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, currentSubject } from '../../api/client'
import type { ChangeDto, Notice } from '../../api/types'
import { KIND_LABEL } from '../../domain/labels'
import { formatMsk, formatStay } from '../../domain/time'
import { useWorkplace } from '../../state/workplace'
import { EmailPreview } from '../../ui/EmailPreview'
import { Button, Drawer, EmptyState, cardClass } from '../../ui/kit'

const TABS = [
  ['events', 'События'],
  ['snapshots', 'Снимки'],
  ['notices', 'Уведомления'],
] as const

const RESULT_LABEL = { ok: 'Успешно', error: 'Ошибка', info: '—' } as const

const TRANSPORT_LABEL: Record<Notice['transport'], string> = {
  sending: 'Отправляется',
  sent: 'Отправлено',
  send_failed: 'Ошибка',
  delivery_unknown: 'Неизвестно',
  handed_off: 'Передано',
  external_confirmed: 'Подтверждено',
}

export function HistoryPage() {
  const loaded = useWorkplace((state) => state.loaded)
  const journal = useWorkplace((state) => state.journal)
  const hotels = useWorkplace((state) => state.hotels)
  const groups = useWorkplace((state) => state.groups)
  const pushToast = useWorkplace((state) => state.pushToast)
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const tab = params.get('tab') === 'snapshots' || params.get('tab') === 'notices' ? params.get('tab') : 'events'
  const hotel = params.get('hotel') ?? ''
  const date = params.get('date') ?? ''
  const [eventId, setEventId] = useState<string | null>(null)
  const hotelName = hotels.find((entry) => entry.id === hotel)?.name
  const events = useMemo(() => journal.filter((item) => (!hotel || item.hotelName === hotelName) && (!date || item.localStayDate === date)), [date, hotel, hotelName, journal])
  const event = journal.find((item) => item.id === eventId) ?? null
  const eventGroup = groups.find((group) => group.groupKey === event?.groupKey)
  const exportJournal = async () => {
    try {
      const response = await fetch('/api/v1/audit/export', { headers: { 'x-dev-subject': currentSubject() ?? '' } })
      if (!response.ok) throw new Error('export')
      download(await response.blob(), 'crew-support-journal.csv')
    } catch {
      pushToast('Журнал не выгрузился')
    }
  }
  if (!loaded) return <p className="text-sm text-ink-soft">Загрузка…</p>
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-bold leading-9">История</h1>
          <p className="text-ink-soft">Проверки, снимки и действия смены</p>
        </div>
        <Button tone="ghost" onClick={() => void exportJournal()}>Выгрузить журнал</Button>
      </div>
      <div className="flex flex-wrap gap-2" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`min-h-11 rounded-full px-3 py-2 text-sm ${tab === id ? 'bg-brand-soft font-semibold' : 'bg-white'}`} onClick={() => setParams({ tab: id, hotel, date })}>
            {label}
          </button>
        ))}
        {hotel || date ? (
          <button type="button" className="min-h-11 text-sm font-semibold text-brand-strong" onClick={() => setParams({ tab: tab ?? 'events' })}>
            Очистить фильтры{hotelName ? ` · ${hotelName}` : ''}{date ? ` · ${formatStay(date)}` : ''}
          </button>
        ) : null}
      </div>
      {tab === 'events' ? (
        events.length === 0 ? (
          <EmptyState title={journal.length === 0 ? 'Действий ещё не было' : 'За выбранный период событий нет'} />
        ) : (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs text-ink-soft"><tr><th>Время МСК</th><th>Инициатор</th><th>Тип</th><th>Гостиница</th><th>Дата</th><th>Описание</th><th>Результат</th></tr></thead>
              <tbody>
                {events.map((item) => (
                  <tr key={item.id} tabIndex={0} className="cursor-pointer border-t border-line hover:bg-muted" onClick={() => setEventId(item.id)} onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter') setEventId(item.id) }}>
                    <td className="py-3 tabular-nums">{formatMsk(item.timestamp)}</td>
                    <td>{item.actor}</td>
                    <td>{item.action}</td>
                    <td>{item.hotelName || '—'}</td>
                    <td>{item.localStayDate ? formatStay(item.localStayDate) : '—'}</td>
                    <td>{item.description}</td>
                    <td className={item.result === 'error' ? 'text-danger' : undefined}>{RESULT_LABEL[item.result]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      {tab === 'snapshots' ? <SnapshotTable /> : null}
      {tab === 'notices' ? <NoticeTable hotelName={hotelName} date={date} /> : null}
      <Drawer open={Boolean(event)} title={event?.action ?? 'Событие'} onClose={() => setEventId(null)}>
        {event ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>{formatMsk(event.timestamp)} · {event.actor}</p>
            {event.hotelName ? <p>{event.hotelName}{event.localStayDate ? ` · ${formatStay(event.localStayDate)}` : ''}</p> : null}
            <p>{event.description}</p>
            {eventGroup ? <Button onClick={() => navigate(`/corrections?group=${eventGroup.key}`)}>Открыть текущую карточку</Button> : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}

function SnapshotTable() {
  const snapshots = useWorkplace((state) => state.snapshots)
  const pushToast = useWorkplace((state) => state.pushToast)
  const [leftId, setLeftId] = useState('')
  const [rightId, setRightId] = useState('')
  const [result, setResult] = useState<{ events: ChangeDto[]; ambiguous: boolean } | null>(null)
  const compare = async () => {
    try {
      setResult(await api<{ events: ChangeDto[]; ambiguous: boolean }>(`/api/v1/snapshots/compare?leftId=${leftId}&rightId=${rightId}`))
    } catch {
      pushToast('Сравнение не выполнено')
    }
  }
  if (snapshots.length === 0) return <EmptyState title="Снимков ещё нет" />
  return (
    <div className={cardClass}>
      <div className="mb-3 flex flex-wrap gap-2">
        <select className="h-11 rounded-xl bg-muted px-3" value={leftId} aria-label="Ранний снимок" onChange={(event) => { setLeftId(event.target.value); setResult(null) }}>
          <option value="">Первый снимок</option>
          {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.label}</option>)}
        </select>
        <select className="h-11 rounded-xl bg-muted px-3" value={rightId} aria-label="Поздний снимок" onChange={(event) => { setRightId(event.target.value); setResult(null) }}>
          <option value="">Второй снимок</option>
          {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.label}</option>)}
        </select>
        <Button disabled={!leftId || !rightId || leftId === rightId} onClick={() => void compare()}>Сравнить</Button>
      </div>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-ink-soft"><tr><th>Получен</th><th>Источник</th><th>Окно</th><th>Записи</th></tr></thead>
        <tbody>
          {snapshots.map((snapshot) => (
            <tr key={snapshot.id} className="border-t border-line">
              <td className="py-3 tabular-nums">{formatMsk(snapshot.fetchedAt)}</td>
              <td>{snapshot.source} · {snapshot.label.split(' · ')[0]}</td>
              <td>{snapshot.windowFrom && snapshot.windowTo ? `${formatStay(snapshot.windowFrom)} — ${formatStay(snapshot.windowTo)}` : '—'}</td>
              <td>{snapshot.rowCount} / ошибок {snapshot.issueCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result ? (
        <div className="mt-4 text-sm">
          <p className="font-semibold">{result.ambiguous ? 'Сравнение неоднозначно — нужны идентификаторы брони' : `Различий: ${result.events.length}. Очередь не меняется.`}</p>
          <ul className="mt-2">
            {result.events.map((change) => (
              <li key={`${change.entityKey}-${change.kind}-${change.groupKey}`} className="border-t border-line py-2">
                {change.after?.fullName ?? change.before?.fullName} · {KIND_LABEL[change.kind]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function NoticeTable({ hotelName, date }: { hotelName?: string; date: string }) {
  const notices = useWorkplace((state) => state.notices)
  const [id, setId] = useState<string | null>(null)
  const visible = notices.filter((item) => (!hotelName || item.hotelName === hotelName) && (!date || item.localStayDate === date))
  const selected = notices.find((item) => item.id === id) ?? null
  if (visible.length === 0) return <EmptyState title="Уведомлений ещё нет" />
  return (
    <>
      <div className={`${cardClass} overflow-x-auto`}>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-ink-soft"><tr><th>Гостиница</th><th>Дата</th><th>Тема</th><th>Версия</th><th>Транспорт</th><th>Время</th></tr></thead>
          <tbody>
            {visible.map((item) => (
              <tr key={item.id} tabIndex={0} className="cursor-pointer border-t border-line hover:bg-muted" onClick={() => setId(item.id)} onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter') setId(item.id) }}>
                <td className="py-3">{item.hotelName}</td>
                <td>{formatStay(item.localStayDate)}</td>
                <td>{item.letter?.subject ?? '—'}</td>
                <td>v{item.revision}</td>
                <td>{TRANSPORT_LABEL[item.transport]}</td>
                <td className="tabular-nums">{formatMsk(item.sentAt ?? item.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Drawer open={Boolean(selected)} title="Архив письма" width={760} onClose={() => setId(null)}>
        {selected?.letter ? (
          <EmailPreview
            hotelName={selected.hotelName}
            airportCode={selected.airportCode}
            stayDate={selected.localStayDate}
            timezoneLabel={selected.timezoneLabel}
            greeting={selected.letter.greeting}
            intro={selected.letter.intro}
            closing={selected.letter.closing}
            signature={selected.letter.signature}
            rows={selected.letter.rows}
            columns={selected.letter.columns}
            newLabel={selected.letter.newLabel}
            cancelLabel={selected.letter.cancelLabel}
            caption="Сохранённая версия"
          />
        ) : null}
      </Drawer>
    </>
  )
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
