import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { STATUS_LABEL } from '../../domain/labels'
import { formatMsk, formatStay } from '../../domain/time'
import type { Draft, GroupView } from '../../domain/types'
import { canReview, canSend, selectGroups } from '../../domain/view'
import { useDemoStore } from '../../state/store'
import { EmailPreview } from '../../ui/EmailPreview'
import { Badge, Banner, Button, Dialog, EmptyState, cardClass, inputClass } from '../../ui/kit'

const TABS = [
  ['review', 'На проверке'],
  ['reviewed', 'Проверенные'],
  ['waiting', 'Ожидание'],
  ['problems', 'Проблемы'],
  ['sent', 'Отправленные'],
] as const

export function MailPage() {
  const data = useDemoStore((state) => state.data)
  const saveLetter = useDemoStore((state) => state.saveLetter)
  const reviewLetter = useDemoStore((state) => state.reviewLetter)
  const sendLetter = useDemoStore((state) => state.sendLetter)
  const handoffLetter = useDemoStore((state) => state.handoffLetter)
  const rebuildDraft = useDemoStore((state) => state.rebuildDraft)
  const prepareGroup = useDemoStore((state) => state.prepareGroup)
  const [params, setParams] = useSearchParams()
  const tab = TABS.some((item) => item[0] === params.get('tab')) ? (params.get('tab') as (typeof TABS)[number][0]) : 'review'
  const groups = selectGroups(data)
  const reviewCount = groups.filter((group) => group.status === 'needs_review').length
  const listed = tab === 'sent' ? [] : groups.filter((group) => matchTab(group, tab))
  const selectedKey = params.get('group') ?? listed[0]?.key ?? ''
  const selected = groups.find((group) => group.key === selectedKey) ?? null
  const draft = selected?.draft ?? data.drafts.find((item) => item.id === params.get('draft')) ?? null
  const [mode, setMode] = useState<'preview' | 'edit' | 'diff'>('preview')
  const [subject, setSubject] = useState('')
  const [intro, setIntro] = useState('')
  const [closing, setClosing] = useState('')
  const [signature, setSignature] = useState('')
  const [recipients, setRecipients] = useState('')
  const [confirmReview, setConfirmReview] = useState(false)
  const [confirmSend, setConfirmSend] = useState(false)
  const [confirmRebuild, setConfirmRebuild] = useState(false)
  useEffect(() => {
    if (!draft) return
    setSubject(draft.subject)
    setIntro(draft.intro)
    setClosing(draft.closing)
    setSignature(draft.signature)
    setRecipients(draft.recipients.join(', '))
  }, [draft])
  const dirty = Boolean(draft && (subject !== draft.subject || intro !== draft.intro || closing !== draft.closing || signature !== draft.signature || recipients !== draft.recipients.join(', ')))
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[28px] font-bold leading-9">Письма</h1>
        <p className="text-ink-soft">{reviewCount} актуальных черновиков</p>
      </div>
      <div className="flex gap-2 overflow-auto">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={`rounded-full px-3 py-2 text-sm ${tab === id ? 'bg-brand-soft font-semibold' : 'bg-white'}`} onClick={() => setParams({ tab: id })}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'sent' ? (
        <SentList />
      ) : listed.length === 0 ? (
        <EmptyState title={tab === 'reviewed' ? 'Проверенных писем нет' : tab === 'waiting' ? 'Ожидающих групп нет' : tab === 'problems' ? 'Проблем нет' : 'Черновиков на проверке нет'} />
      ) : (
        <div className="grid min-h-[560px] gap-4 lg:grid-cols-[320px_1fr]">
          <ul className="flex flex-col gap-2">
            {listed.map((group) => (
              <li key={group.key}>
                <button type="button" className={`${cardClass} w-full text-left ${group.key === selectedKey ? 'ring-2 ring-brand-strong' : ''}`} onClick={() => setParams({ tab, group: group.key, draft: group.draft?.id ?? '' })}>
                  <span className="block font-semibold">{group.hotel.name}</span>
                  <span className="text-xs text-ink-soft">{group.hotel.city} · {group.airportCode} · {formatStay(group.localStayDate)}</span>
                  <span className="mt-2 block text-sm">{group.draft?.subject ?? 'Черновик ещё не собран'}</span>
                  <span className="mt-2 flex items-center justify-between text-xs">
                    <Badge tone={group.status}>{STATUS_LABEL[group.status]}</Badge>
                    <span>{group.changes.length} изм.</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && draft ? (
            <section className={`${cardClass} flex flex-col gap-4`}>
              {selected.status === 'stale' || draft.templateVersion !== data.settings.templateVersion ? (
                <Banner tone="warn">{selected.status === 'stale' ? 'Появились новые данные. Отправка закрыта.' : 'Есть новая версия шаблона.'}</Banner>
              ) : null}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={selected.status}>{STATUS_LABEL[selected.status]}</Badge>
                <span>v{draft.revision}</span>
                <span className="text-ink-soft">{draft.saved ? `сохранено ${formatMsk(draft.createdAt)}` : 'есть несохранённое'}</span>
              </div>
              <p className="text-sm">От: {data.settings.senderAddress}</p>
              <label className="text-sm font-semibold">Кому
                <input className={`${inputClass} mt-1 w-full font-normal`} value={recipients} onChange={(event) => setRecipients(event.target.value)} />
              </label>
              <div className="flex gap-2">
                {(['preview', 'edit', 'diff'] as const).map((item) => (
                  <button key={item} type="button" className={`rounded-full px-3 py-1 text-sm ${mode === item ? 'bg-brand-soft' : 'bg-muted'}`} onClick={() => setMode(item)}>
                    {item === 'preview' ? 'Предпросмотр' : item === 'edit' ? 'Редактирование' : 'Изменения'}
                  </button>
                ))}
              </div>
              {mode === 'edit' ? (
                <div className="flex flex-col gap-3">
                  <textarea className="min-h-16 rounded-xl bg-muted p-3" value={subject} onChange={(event) => setSubject(event.target.value)} aria-label="Тема" />
                  <textarea className="min-h-24 rounded-xl bg-muted p-3" value={intro} onChange={(event) => setIntro(event.target.value)} aria-label="Вступление" />
                  <textarea className="min-h-16 rounded-xl bg-muted p-3" value={closing} onChange={(event) => setClosing(event.target.value)} aria-label="Заключение" />
                  <textarea className="min-h-16 rounded-xl bg-muted p-3" value={signature} onChange={(event) => setSignature(event.target.value)} aria-label="Подпись" />
                </div>
              ) : null}
              {mode === 'diff' ? (
                <ul className="text-sm">
                  {selected.changes.map((change) => (
                    <li key={change.id} className="border-b border-line py-2">{change.fullName}: {change.fields.map((field) => `${field.label} ${field.before} → ${field.after}`).join('; ')}</li>
                  ))}
                </ul>
              ) : (
                <EmailPreview {...previewProps(draft, { subject, intro, closing, signature })} caption="Так письмо увидит гостиница" />
              )}
              <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 bg-white py-3">
                <span className="mr-auto text-xs text-ink-soft">{dirty ? 'Есть изменения' : 'Сохранено'}</span>
                <Button tone="ghost" onClick={() => saveLetter(draft.id, { subject, greeting: draft.greeting, intro, closing, signature, recipients: recipients.split(/[\s,;]+/).filter(Boolean), cc: draft.cc, overrides: draft.overrides })}>Сохранить черновик</Button>
                <Button tone="ghost" disabled={!canReview(selected) || dirty || data.sendingDraftId === draft.id} onClick={() => setConfirmReview(true)}>Отметить проверенным</Button>
                {data.settings.mailMode === 'handoff' ? (
                  <Button tone="accent" disabled={draft.reviewedRevision !== draft.revision || selected.status === 'stale'} onClick={() => handoffLetter(draft.id)}>Передать в почту · демо</Button>
                ) : (
                  <Button tone="accent" disabled={!canSend(data, selected) || dirty} onClick={() => setConfirmSend(true)}>Отправить · демо</Button>
                )}
                <Button tone="soft" onClick={() => (draft.manualEdits ? setConfirmRebuild(true) : rebuildDraft(draft.groupKey))}>Обновить черновик</Button>
              </div>
            </section>
          ) : selected ? (
            <section className={cardClass}>
              <p className="mb-3">Черновик появится после тишины.</p>
              <Button onClick={() => prepareGroup(selected.key)}>Подготовить сейчас</Button>
            </section>
          ) : (
            <EmptyState title="Выберите письмо слева" />
          )}
        </div>
      )}
      <Dialog open={confirmReview} title="Проверка письма" onClose={() => setConfirmReview(false)} footer={<Button onClick={() => { if (draft) reviewLetter(draft.id); setConfirmReview(false) }}>Проверены получатели, даты и все изменения</Button>}>
        <p className="text-sm">{selected?.hotel.name}, {selected ? formatStay(selected.localStayDate) : ''}, {recipients}</p>
      </Dialog>
      <Dialog open={confirmSend} title="Отправить · демо" onClose={() => setConfirmSend(false)} footer={<Button tone="accent" disabled={Boolean(data.sendingDraftId)} onClick={() => { if (draft) sendLetter(draft.id); setConfirmSend(false) }}>Подтвердить демо-отправку</Button>}>
        <p className="text-sm">Реальное письмо не будет отправлено. Получатели: {recipients}</p>
      </Dialog>
      <Dialog open={confirmRebuild} title="Обновить черновик" onClose={() => setConfirmRebuild(false)} footer={<Button onClick={() => { if (draft) rebuildDraft(draft.groupKey); setConfirmRebuild(false) }}>Сохранить копию и пересобрать</Button>}>
        <p className="text-sm">Ручные правки автоматически не переносятся. Старая версия останется в архиве.</p>
      </Dialog>
    </div>
  )
}

function matchTab(group: GroupView, tab: string): boolean {
  if (tab === 'review') return group.status === 'needs_review'
  if (tab === 'reviewed') return group.status === 'reviewed' || group.status === 'handed_off'
  if (tab === 'waiting') return group.status === 'waiting' || group.status === 'preparing'
  if (tab === 'problems') return group.status === 'stale' || group.status === 'needs_decision' || group.status === 'needs_baseline'
  return false
}

function previewProps(draft: Draft, edits: { subject: string; intro: string; closing: string; signature: string }) {
  return {
    hotelName: draft.hotelName,
    airportCode: draft.airportCode,
    stayDate: draft.localStayDate,
    timezoneLabel: draft.timezoneLabel,
    greeting: draft.greeting,
    intro: edits.intro,
    closing: edits.closing,
    signature: edits.signature,
    rows: draft.rows,
    columns: draft.columns,
    newLabel: draft.newLabel,
    cancelLabel: draft.cancelLabel,
  }
}

function SentList() {
  const notifications = useDemoStore((state) => state.data.notifications)
  const confirmOutside = useDemoStore((state) => state.confirmOutside)
  const [id, setId] = useState<string | null>(notifications[0]?.id ?? null)
  const selected = notifications.find((item) => item.id === id) ?? null
  if (notifications.length === 0) return <EmptyState title="Отправленных писем ещё нет" />
  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <ul className="flex flex-col gap-2">
        {notifications.map((item) => (
          <li key={item.id}>
            <button type="button" className={`${cardClass} w-full text-left`} onClick={() => setId(item.id)}>
              <span className="font-semibold">{item.hotelName}</span>
              <span className="block text-xs text-ink-soft">{item.transport === 'sent' ? 'Отправлено · демо' : item.transport === 'handed_off' ? 'Передано, не подтверждено' : 'Подтверждено вне системы'}</span>
            </button>
          </li>
        ))}
      </ul>
      {selected ? (
        <div className="flex flex-col gap-3">
          <EmailPreview hotelName={selected.hotelName} airportCode={selected.airportCode} stayDate={selected.localStayDate} timezoneLabel={selected.timezoneLabel} greeting={selected.greeting} intro={selected.intro} closing={selected.closing} signature={selected.signature} rows={selected.rows} columns={selected.columns} newLabel={selected.newLabel} cancelLabel={selected.cancelLabel} caption={`Архив v${selected.revision}, только чтение`} />
          {selected.transport === 'handed_off' ? <Button onClick={() => confirmOutside(selected.id)}>Подтвердить отправку вне системы · демо</Button> : null}
        </div>
      ) : null}
    </div>
  )
}
