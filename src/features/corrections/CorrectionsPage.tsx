import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { WorkGroup } from '../../api/types'
import { KIND_LABEL, STATUS_LABEL } from '../../domain/labels'
import { formatMsk, formatStay } from '../../domain/time'
import { useWorkplace } from '../../state/workplace'
import { Badge, Button, Drawer, EmptyState, cardClass } from '../../ui/kit'

export function CorrectionsPage() {
  const loaded = useWorkplace((state) => state.loaded)
  const queue = useWorkplace((state) => state.groups)
  const snapshots = useWorkplace((state) => state.snapshots)
  const fetchCorrections = useWorkplace((state) => state.fetchCorrections)
  const pushToast = useWorkplace((state) => state.pushToast)
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const basis = params.get('basis') === 'previous' ? 'previous' : 'baseline'
  const [query, setQuery] = useState(params.get('q') ?? '')
  const [airport, setAirport] = useState(params.get('airport') ?? 'all')
  const [flat, setFlat] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [selectedKey, setSelectedKey] = useState<string | null>(params.get('group'))
  const [rowWindow, setRowWindow] = useState(100)
  const [previousGroups, setPreviousGroups] = useState<WorkGroup[] | null>(null)
  useEffect(() => {
    if (basis !== 'previous' || !loaded) return
    let active = true
    fetchCorrections('previous')
      .then((items) => {
        if (active) setPreviousGroups(items)
      })
      .catch(() => pushToast('Сравнение со снимком не загрузилось'))
    return () => {
      active = false
    }
  }, [basis, fetchCorrections, loaded, pushToast, snapshots])
  const source = useMemo(() => (basis === 'previous' ? (previousGroups ?? []) : queue), [basis, previousGroups, queue])
  const groups = useMemo(() => source.filter((group) => group.changes.length > 0), [source])
  const [latest, previous] = snapshots
  const visible = groups.filter((group) => {
    if (airport !== 'all' && group.airportCode !== airport) return false
    if (!query.trim()) return true
    const haystack = `${group.hotel.name} ${group.changes.map((change) => change.fullName).join(' ')}`.toLowerCase()
    return haystack.includes(query.trim().toLowerCase())
  })
  const groupByKey = new Map(source.map((group) => [group.groupKey, group]))
  const selected = queue.find((group) => group.key === selectedKey) ?? source.find((group) => group.key === selectedKey) ?? null
  const shownGroups = visible.length > 100 ? visible.slice(0, rowWindow) : visible
  const blocks = flat
    ? [{ key: 'flat', changes: shownGroups.flatMap((group) => group.changes), group: null }]
    : shownGroups.map((group) => ({ key: group.key, changes: group.changes, group }))
  if (!loaded) return <p className="text-sm text-ink-soft">Загрузка…</p>
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-bold leading-9">Корректировки</h1>
          <p className="text-ink-soft">Сравнение размещения и рейсов</p>
        </div>
        <Button tone="ghost" onClick={() => navigate('/history?tab=snapshots')}>Сравнить выгрузки</Button>
      </div>
      <div className={`${cardClass} flex flex-wrap items-center gap-3`}>
        <button type="button" className={`min-h-11 rounded-full px-3 py-2 text-sm ${basis === 'baseline' ? 'bg-brand-soft' : 'bg-muted'}`} onClick={() => setParams({ basis: 'baseline' })}>
          С последним уведомлённым состоянием
        </button>
        <button type="button" className={`min-h-11 rounded-full px-3 py-2 text-sm ${basis === 'previous' ? 'bg-brand-soft' : 'bg-muted'}`} onClick={() => setParams({ basis: 'previous' })}>
          С последним полученным снимком
        </button>
        <span className="text-xs tabular-nums text-ink-soft">
          {basis === 'previous' ? (previous ? formatMsk(previous.fetchedAt) : 'второго снимка нет') : 'уведомлённая база'} → {latest ? formatMsk(latest.fetchedAt) : 'нет'}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <input className="h-11 rounded-xl bg-white px-3" placeholder="ФИО или гостиница" value={query} aria-label="Поиск" onChange={(event) => setQuery(event.target.value)} />
        <select className="h-11 rounded-xl bg-white px-3" value={airport} aria-label="Аэропорт" onChange={(event) => setAirport(event.target.value)}>
          <option value="all">Все аэропорты</option>
          {[...new Set(groups.map((group) => group.airportCode))].map((code) => <option key={code}>{code}</option>)}
        </select>
        <Button tone="ghost" onClick={() => setFlat((value) => !value)}>{flat ? 'По гостиницам' : 'Список изменений'}</Button>
        <Button tone="ghost" onClick={() => setCollapsed((value) => !value)}>{collapsed ? 'Развернуть все' : 'Свернуть все'}</Button>
      </div>
      {visible.length === 0 ? (
        <EmptyState title={snapshots.length === 0 ? 'Данных ещё нет' : 'Различий нет'} action={<Button onClick={() => navigate('/overview')}>Загрузить Excel</Button>} />
      ) : null}
      <div className="flex flex-col gap-4">
        {blocks.map((block) => (
          <section key={block.key} className={cardClass}>
            {block.group ? (
              <button type="button" className="mb-3 flex min-h-11 w-full items-center justify-between text-left" onClick={() => setSelectedKey(block.group.key)}>
                <span>
                  <span className="block text-lg font-bold">{block.group.hotel.name}</span>
                  <span className="text-xs text-ink-soft">{block.group.airportCode} · {formatStay(block.group.localStayDate)} · {block.changes.length}</span>
                </span>
                <Badge tone={block.group.status}>{STATUS_LABEL[block.group.status]}</Badge>
              </button>
            ) : null}
            {!collapsed ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="text-xs text-ink-soft"><tr><th>ФИО</th>{flat ? <th>Гостиница</th> : null}<th>Тип</th><th>Было</th><th>Стало</th><th>Обнаружено</th></tr></thead>
                  <tbody>
                    {(block.changes.length > 100 ? block.changes.slice(0, rowWindow) : block.changes).map((change) => {
                      const owner = groupByKey.get(change.groupKey)
                      return (
                        <tr key={change.id} className="border-t border-line align-top">
                          <td className="py-3 pr-3" title={change.fullName}>
                            {change.fullName}
                            {change.replacement ? <span className="ml-2 rounded-full bg-brand-soft px-2 py-0.5 text-xs">Замена</span> : null}
                            {change.kind === 'cancelled' ? <span className="ml-2 rounded-full bg-[#fdecea] px-2 py-0.5 text-xs text-danger">Отмена</span> : null}
                            {change.kind === 'added' ? <span className="ml-2 rounded-full bg-[#e5f6ee] px-2 py-0.5 text-xs text-ok">Новая</span> : null}
                          </td>
                          {flat ? <td>{owner ? `${owner.hotel.name} · ${formatStay(owner.localStayDate)}` : '—'}</td> : null}
                          <td>{KIND_LABEL[change.kind]}{change.linkedGroupKey ? ` → ${formatStay(change.linkedGroupKey.split('|')[2] ?? '')}` : ''}</td>
                          <td className="text-ink-soft">{change.fields.map((field) => field.before).filter(Boolean).join(' · ') || '—'}</td>
                          <td className="font-semibold">{change.fields.map((field) => `${field.label}: ${field.after || '—'}`).join(' · ')}</td>
                          <td className="tabular-nums">{change.detectedAt ? formatMsk(change.detectedAt) : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}
            {block.changes.length > rowWindow ? <button type="button" className="mt-3 min-h-11 text-sm font-semibold text-brand-strong" onClick={() => setRowWindow((count) => count + 100)}>Ещё {block.changes.length - rowWindow}</button> : null}
          </section>
        ))}
        {visible.length > rowWindow ? <button type="button" className="min-h-11 text-sm font-semibold text-brand-strong" onClick={() => setRowWindow((count) => count + 100)}>Ещё {visible.length - rowWindow}</button> : null}
      </div>
      <Drawer open={Boolean(selected)} title={selected?.hotel.name ?? 'Группа'} width={560} onClose={() => setSelectedKey(null)}>
        {selected ? (
          <div className="flex flex-col gap-3 text-sm">
            <p>{selected.airportCode} · {formatStay(selected.localStayDate)} · {selected.changes.length} изм.</p>
            <Badge tone={selected.status}>{STATUS_LABEL[selected.status]}</Badge>
            {selected.exceptions.map((item) => <p key={item.id} className="text-danger">{item.message}</p>)}
            <Button onClick={() => navigate(`/mail?group=${selected.key}`)}>{selected.draftId ? 'Открыть черновик' : 'Перейти к письмам'}</Button>
            <Button tone="ghost" onClick={() => navigate(`/history?hotel=${selected.hotel.id}&date=${selected.localStayDate}`)}>История гостиницы</Button>
          </div>
        ) : null}
      </Drawer>
    </div>
  )
}
