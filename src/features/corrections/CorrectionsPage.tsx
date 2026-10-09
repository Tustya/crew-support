import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { KIND_LABEL, STATUS_LABEL } from '../../domain/labels'
import { formatMsk, formatStay } from '../../domain/time'
import type { GroupView } from '../../domain/types'
import { latestSnapshot, previousSnapshot, selectGroups } from '../../domain/view'
import { useDemoStore } from '../../state/store'
import { Badge, Button, Drawer, EmptyState, cardClass } from '../../ui/kit'

export function CorrectionsPage() {
  const data = useDemoStore((state) => state.data)
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const basis = params.get('basis') === 'previous' ? 'previous' : 'baseline'
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [airport, setAirport] = useState(params.get('airport') ?? 'all')
  const [flat, setFlat] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [selected, setSelected] = useState<GroupView | null>(null)
  const groups = useMemo(() => selectGroups(data, basis).filter((group) => group.changes.length > 0 || group.status === 'needs_baseline'), [basis, data])
  const latest = latestSnapshot(data)
  const previous = previousSnapshot(data)
  const visible = groups.filter((group) => {
    if (airport !== 'all' && group.airportCode !== airport) return false
    if (!query.trim()) return true
    const haystack = `${group.hotel.name} ${group.changes.map((change) => change.fullName).join(' ')}`.toLowerCase()
    return haystack.includes(query.trim().toLowerCase())
  })
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-bold leading-9">Корректировки</h1>
          <p className="text-ink-soft">Сравнение размещения и рейсов</p>
        </div>
        <Button tone="ghost" onClick={() => navigate('/overview')}>Сравнить выгрузки</Button>
      </div>
      <div className={`${cardClass} flex flex-wrap items-center gap-3`}>
        <button type="button" className={`rounded-full px-3 py-2 text-sm ${basis === 'baseline' ? 'bg-brand-soft' : 'bg-muted'}`} onClick={() => setParams({ basis: 'baseline' })}>
          С последним уведомлённым состоянием
        </button>
        <button type="button" className={`rounded-full px-3 py-2 text-sm ${basis === 'previous' ? 'bg-brand-soft' : 'bg-muted'}`} onClick={() => setParams({ basis: 'previous' })}>
          С последним полученным снимком
        </button>
        <span className="text-xs tabular-nums text-ink-soft">
          {basis === 'previous' ? previous ? formatMsk(previous.fetchedAt) : 'второго снимка нет' : 'уведомлённая база'} → {latest ? formatMsk(latest.fetchedAt) : 'нет'}
        </span>
        {data.historicalCompare ? <Badge tone="info">Историческое сравнение не меняет очередь</Badge> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <input className="h-10 rounded-xl bg-white px-3" placeholder="ФИО или рейс" value={query} aria-label="Поиск" onChange={(event) => setQuery(event.target.value)} />
        <select className="h-10 rounded-xl bg-white px-3" value={airport} aria-label="Аэропорт" onChange={(event) => setAirport(event.target.value)}>
          <option value="all">Все аэропорты</option>
          {[...new Set(groups.map((group) => group.airportCode))].map((code) => <option key={code}>{code}</option>)}
        </select>
        <Button tone="ghost" onClick={() => setFlat((value) => !value)}>{flat ? 'По гостиницам' : 'Список изменений'}</Button>
        <Button tone="ghost" onClick={() => setCollapsed((value) => !value)}>{collapsed ? 'Развернуть все' : 'Свернуть все'}</Button>
      </div>
      {!data.baselineEstablished && basis === 'baseline' ? <EmptyState title="Нельзя определить корректировки. Сначала выберите исходное состояние." /> : null}
      {visible.length === 0 && data.baselineEstablished ? <EmptyState title="После проверки различий нет" action={<Button onClick={() => navigate('/overview')}>Проверить снова</Button>} /> : null}
      <div className="flex flex-col gap-4">
        {(flat ? [{ key: 'flat', hotel: visible[0]?.hotel, changes: visible.flatMap((group) => group.changes), groups: visible }] : visible.map((group) => ({ key: group.key, hotel: group.hotel, changes: group.changes, groups: [group] }))).map((block) => (
          <section key={block.key} className={cardClass}>
            {!flat && block.groups[0] ? (
              <button type="button" className="mb-3 flex w-full items-center justify-between text-left" onClick={() => setSelected(block.groups[0])}>
                <span>
                  <span className="block text-lg font-bold">{block.groups[0].hotel.name}</span>
                  <span className="text-xs text-ink-soft">{block.groups[0].airportCode} · {formatStay(block.groups[0].localStayDate)} · {block.changes.length}</span>
                </span>
                <Badge tone={block.groups[0].status}>{STATUS_LABEL[block.groups[0].status]}</Badge>
              </button>
            ) : null}
            {!collapsed ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="text-xs text-ink-soft"><tr><th>ФИО</th>{flat ? <th>Гостиница</th> : null}<th>Тип</th><th>Было</th><th>Стало</th><th>Обнаружено</th></tr></thead>
                  <tbody>
                    {block.changes.map((change) => (
                      <tr key={change.id} className="border-t border-line align-top">
                        <td className="py-3 pr-3" title={change.fullName}>
                          {change.fullName}
                          {change.replacementId ? <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-xs">Замена</span> : null}
                          {change.kind === 'cancelled' ? <span className="ml-2 rounded-full bg-[#fdecea] px-2 py-0.5 text-xs text-danger">Отмена</span> : null}
                          {change.kind === 'added' ? <span className="ml-2 rounded-full bg-[#e5f6ee] px-2 py-0.5 text-xs text-ok">Новая</span> : null}
                        </td>
                        {flat ? <td>{change.groupKey.split('|')[0]} · {formatStay(change.groupKey.split('|')[2] ?? '')}</td> : null}
                        <td>{KIND_LABEL[change.kind]}{change.linkedGroupKey ? ` → ${change.linkedGroupKey.split('|')[2]}` : ''}</td>
                        <td className="text-ink-soft">{change.fields.map((field) => field.before).join(' · ') || '—'}</td>
                        <td className="font-semibold">{change.fields.map((field) => `${field.label}: ${field.after}`).join(' · ')}</td>
                        <td className="tabular-nums">{formatMsk(change.detectedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        ))}
      </div>
      <Drawer open={Boolean(selected)} title={selected?.changes[0]?.fullName ?? 'Запись'} width={560} onClose={() => setSelected(null)}>
        {selected ? (
          <div className="flex flex-col gap-3 text-sm">
            <p>{selected.hotel.name} · {selected.airportCode} · {formatStay(selected.localStayDate)}</p>
            {selected.exceptions.map((item) => <p key={item.id} className="text-danger">{item.message}</p>)}
            <Button onClick={() => navigate(`/mail?group=${selected.key}&draft=${selected.draft?.id ?? ''}`)}>Открыть черновик</Button>
            <Button tone="ghost" onClick={() => navigate(`/history?hotel=${selected.hotel.id}&date=${selected.localStayDate}`)}>История гостиницы</Button>
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
