import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { formatMsk, formatStay } from '../../domain/time'
import { diffBookings } from '../../domain/diff'
import { useDemoStore } from '../../state/store'
import { Button, Drawer, EmptyState, cardClass } from '../../ui/kit'
import { EmailPreview } from '../../ui/EmailPreview'

export function HistoryPage() {
  const data = useDemoStore((state) => state.data)
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const tab = params.get('tab') === 'snapshots' || params.get('tab') === 'notices' ? params.get('tab') : 'events'
  const hotel = params.get('hotel') ?? ''
  const date = params.get('date') ?? ''
  const [leftId, setLeftId] = useState('')
  const [rightId, setRightId] = useState('')
  const [eventId, setEventId] = useState<string | null>(null)
  const events = useMemo(
    () => data.activities.filter((item) => (!hotel || item.hotelName === data.hotels.find((entry) => entry.id === hotel)?.name) && (!date || item.localStayDate === date)),
    [data.activities, data.hotels, date, hotel],
  )
  const snapshots = data.snapshots.filter((snapshot) => snapshot.seriesId === data.seriesId)
  const event = data.activities.find((item) => item.id === eventId) ?? null
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-bold leading-9">История</h1>
          <p className="text-ink-soft">Проверки, снимки и действия смены · демо-журнал</p>
        </div>
        <Button tone="ghost" onClick={() => downloadCsv(tab === 'events' ? events.map((item) => [formatMsk(item.timestamp), item.actor, item.action, item.hotelName, item.localStayDate, item.description, item.result]) : [])}>
          Выгрузить журнал · демо
        </Button>
      </div>
      <div className="flex gap-2">
        {[
          ['events', 'События'],
          ['snapshots', 'Снимки'],
          ['notices', 'Уведомления'],
        ].map(([id, label]) => (
          <button key={id} type="button" className={`rounded-full px-3 py-2 text-sm ${tab === id ? 'bg-brand-soft font-semibold' : 'bg-white'}`} onClick={() => setParams({ tab: id, hotel, date })}>
            {label}
          </button>
        ))}
        <button type="button" className="text-sm font-semibold text-brand-strong" onClick={() => setParams({ tab: tab ?? 'events' })}>Очистить фильтры</button>
      </div>
      {tab === 'events' ? (
        events.length === 0 ? <EmptyState title={data.activities.length === 0 ? 'В этой демонстрации ещё не было действий' : 'За выбранный период событий нет'} /> : (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="text-xs text-ink-soft"><tr><th>Время МСК</th><th>Инициатор</th><th>Тип</th><th>Гостиница</th><th>Дата</th><th>Описание</th><th>Результат</th></tr></thead>
              <tbody>
                {events.slice(0, 25).map((item) => (
                  <tr key={item.id} tabIndex={0} className="cursor-pointer border-t border-line hover:bg-muted" onClick={() => setEventId(item.id)} onKeyDown={(eventKey) => { if (eventKey.key === 'Enter') setEventId(item.id) }}>
                    <td className="py-3 tabular-nums">{formatMsk(item.timestamp)}</td>
                    <td>{item.actor}</td>
                    <td>{item.action}</td>
                    <td>{item.hotelName || '—'}</td>
                    <td>{item.localStayDate ? formatStay(item.localStayDate) : '—'}</td>
                    <td>{item.description}</td>
                    <td>{item.result}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
      {tab === 'snapshots' ? (
        <div className={cardClass}>
          <div className="mb-3 flex flex-wrap gap-2">
            <select className="h-10 rounded-xl bg-muted px-3" value={leftId} aria-label="Левый снимок" onChange={(event) => setLeftId(event.target.value)}>
              <option value="">Первый снимок</option>
              {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.label}</option>)}
            </select>
            <select className="h-10 rounded-xl bg-muted px-3" value={rightId} aria-label="Правый снимок" onChange={(event) => setRightId(event.target.value)}>
              <option value="">Второй снимок</option>
              {snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshot.label}</option>)}
            </select>
            <Button
              disabled={!leftId || !rightId || leftId === rightId}
              onClick={() => navigate(`/corrections?basis=previous&historical=1&left=${leftId}&right=${rightId}`)}
            >
              Сравнить
            </Button>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-ink-soft"><tr><th>Получен</th><th>Источник</th><th>Окно</th><th>Записи</th></tr></thead>
            <tbody>
              {snapshots.map((snapshot) => (
                <tr key={snapshot.id} className="border-t border-line">
                  <td className="py-3 tabular-nums">{formatMsk(snapshot.fetchedAt)}</td>
                  <td>{snapshot.source === 'demo_api' ? 'демо-API' : 'демо-файл'} · {snapshot.label}</td>
                  <td>{formatStay(snapshot.windowFrom)} — {formatStay(snapshot.windowTo)}</td>
                  <td>{snapshot.bookings.length} / ошибок {snapshot.validationIssues.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <HistoricalDiff leftId={leftId} rightId={rightId} />
        </div>
      ) : null}
      {tab === 'notices' ? <NoticeTable /> : null}
      <Drawer open={Boolean(event)} title={event?.action ?? 'Событие'} onClose={() => setEventId(null)}>
        {event ? (
          <div className="flex flex-col gap-2 text-sm">
            <p>{formatMsk(event.timestamp)} · {event.actor}</p>
            <p>{event.description}</p>
            {event.groupKey ? <Button onClick={() => navigate(`/corrections?group=${event.groupKey}`)}>Открыть текущую карточку</Button> : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}

function HistoricalDiff({ leftId, rightId }: { leftId: string; rightId: string }) {
  const snapshots = useDemoStore((state) => state.data.snapshots)
  const left = snapshots.find((snapshot) => snapshot.id === leftId)
  const right = snapshots.find((snapshot) => snapshot.id === rightId)
  if (!left || !right) return null
  const events = diffBookings({ before: left.bookings, after: right.bookings, detectedAt: right.fetchedAt, fromSnapshotId: left.id, toSnapshotId: right.id })
  return <p className="mt-3 text-sm">Историческое сравнение: {events.length} событий. Очередь и уведомления не меняются.</p>
}

function NoticeTable() {
  const notifications = useDemoStore((state) => state.data.notifications)
  const [id, setId] = useState<string | null>(null)
  const selected = notifications.find((item) => item.id === id) ?? null
  if (notifications.length === 0) return <EmptyState title="Уведомлений ещё нет" />
  return (
    <>
      <div className={`${cardClass} overflow-x-auto`}>
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-ink-soft"><tr><th>Гостиница</th><th>Дата</th><th>Тема</th><th>Версия</th><th>Транспорт</th><th>Время</th></tr></thead>
          <tbody>
            {notifications.map((item) => (
              <tr key={item.id} className="cursor-pointer border-t border-line" onClick={() => setId(item.id)}>
                <td className="py-3">{item.hotelName}</td>
                <td>{formatStay(item.localStayDate)}</td>
                <td>{item.subject}</td>
                <td>v{item.revision}</td>
                <td>{item.transport}</td>
                <td className="tabular-nums">{item.sentAt ? formatMsk(item.sentAt) : item.handedOffAt ? formatMsk(item.handedOffAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Drawer open={Boolean(selected)} title="Архив письма" onClose={() => setId(null)}>
        {selected ? <EmailPreview hotelName={selected.hotelName} airportCode={selected.airportCode} stayDate={selected.localStayDate} timezoneLabel={selected.timezoneLabel} greeting={selected.greeting} intro={selected.intro} closing={selected.closing} signature={selected.signature} rows={selected.rows} columns={selected.columns} newLabel={selected.newLabel} cancelLabel={selected.cancelLabel} caption="Сохранённая версия" /> : null}
      </Drawer>
    </>
  )
}

function downloadCsv(rows: string[][]) {
  const header = ['время', 'инициатор', 'тип', 'гостиница', 'дата', 'описание', 'результат']
  const body = [header, ...rows].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\n')
  const blob = new Blob([`\uFEFF${body}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'crew-support-demo-journal.csv'
  link.click()
  URL.revokeObjectURL(url)
}
