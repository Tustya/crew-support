import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { Letter, Notice, WorkGroup } from '../../api/types'
import { STATUS_LABEL } from '../../domain/labels'
import { formatMsk, formatStay, pluralWord } from '../../domain/time'
import { useWorkplace } from '../../state/workplace'
import { EmailPreview } from '../../ui/EmailPreview'
import { Badge, Banner, Button, Dialog, EmptyState, Field, cardClass, inputClass } from '../../ui/kit'

const TABS = [
  ['review', 'На проверке'],
  ['reviewed', 'Проверенные'],
  ['waiting', 'Ожидание'],
  ['problems', 'Проблемы'],
  ['sent', 'Отправленные'],
] as const

type Tab = (typeof TABS)[number][0]

const TRANSPORT_LABEL: Record<Notice['transport'], string> = {
  sending: 'Отправляется',
  sent: 'Отправлено',
  send_failed: 'Ошибка отправки',
  delivery_unknown: 'Статус доставки неизвестен',
  handed_off: 'Передано, не подтверждено',
  external_confirmed: 'Подтверждено вне системы',
}

export function MailPage() {
  const loaded = useWorkplace((state) => state.loaded)
  const groups = useWorkplace((state) => state.groups)
  const letters = useWorkplace((state) => state.letters)
  const busy = useWorkplace((state) => state.busy)
  const prepareGroup = useWorkplace((state) => state.prepareGroup)
  const [params, setParams] = useSearchParams()
  const requestedGroup = groups.find((group) => group.key === params.get('group'))
  const tab: Tab = TABS.some((item) => item[0] === params.get('tab')) ? (params.get('tab') as Tab) : requestedGroup ? tabOf(requestedGroup) : 'review'
  const reviewCount = groups.filter((group) => group.status === 'needs_review').length
  const listed = tab === 'sent' ? [] : groups.filter((group) => matchTab(group, tab))
  const selectedKey = params.get('group') ?? listed[0]?.key ?? ''
  const selected = groups.find((group) => group.key === selectedKey) ?? null
  const letter = selected ? letters[selected.key] ?? null : null
  if (!loaded) return <p className="text-sm text-ink-soft">Загрузка…</p>
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[28px] font-bold leading-9">Письма</h1>
        <p className="text-ink-soft">{reviewCount} {pluralWord(reviewCount, 'черновик на проверке', 'черновика на проверке', 'черновиков на проверке')}</p>
      </div>
      <div className="flex gap-2 overflow-auto" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`min-h-11 whitespace-nowrap rounded-full px-3 py-2 text-sm ${tab === id ? 'bg-brand-soft font-semibold' : 'bg-white'}`} onClick={() => setParams({ tab: id })}>
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
                <button type="button" className={`${cardClass} w-full text-left ${group.key === selectedKey ? 'ring-2 ring-brand-strong' : ''}`} onClick={() => setParams({ tab, group: group.key })}>
                  <span className="block font-semibold">{group.hotel.name}</span>
                  <span className="text-xs text-ink-soft">{group.hotel.city} · {group.airportCode} · {formatStay(group.localStayDate)}</span>
                  <span className="mt-2 block text-sm">{letters[group.key]?.subject ?? 'Черновик ещё не собран'}</span>
                  <span className="mt-2 flex items-center justify-between text-xs">
                    <Badge tone={group.status}>{STATUS_LABEL[group.status]}</Badge>
                    <span>{group.changes.length} изм.</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected && letter ? (
            <LetterEditor key={`${letter.id}:${letter.revision}`} group={selected} letter={letter} />
          ) : selected ? (
            <section className={`${cardClass} min-w-0`}>
              <p className="mb-3">Черновик появится после паузы.</p>
              <Button disabled={busy === 'prepare' || selected.changes.length === 0} onClick={() => void prepareGroup(selected.key)}>Подготовить сейчас</Button>
            </section>
          ) : (
            <EmptyState title="Выберите письмо слева" />
          )}
        </div>
      )}
    </div>
  )
}

function LetterEditor({ group, letter }: { group: WorkGroup; letter: Letter }) {
  const settings = useWorkplace((state) => state.settings)
  const integrations = useWorkplace((state) => state.integrations)
  const busy = useWorkplace((state) => state.busy)
  const saveLetter = useWorkplace((state) => state.saveLetter)
  const reviewLetter = useWorkplace((state) => state.reviewLetter)
  const handoffLetter = useWorkplace((state) => state.handoffLetter)
  const sendLetter = useWorkplace((state) => state.sendLetter)
  const rebuildLetter = useWorkplace((state) => state.rebuildLetter)
  const [mode, setMode] = useState<'preview' | 'edit' | 'diff'>('preview')
  const [subject, setSubject] = useState(letter.subject)
  const [intro, setIntro] = useState(letter.intro)
  const [closing, setClosing] = useState(letter.closing)
  const [signature, setSignature] = useState(letter.signature)
  const [recipients, setRecipients] = useState(letter.recipients.join(', '))
  const [confirmReview, setConfirmReview] = useState(false)
  const [confirmSend, setConfirmSend] = useState(false)
  const [confirmRebuild, setConfirmRebuild] = useState(false)
  const mailInApp = integrations.some((item) => item.adapter === 'mail' && item.configured)
  const working = busy === `letter:${letter.id}`
  const stale = group.status === 'stale'
  const dirty = subject !== letter.subject || intro !== letter.intro || closing !== letter.closing || signature !== letter.signature || recipients !== letter.recipients.join(', ')
  const canReview = group.status === 'needs_review' && !dirty && !working
  const canDeliver = letter.status === 'reviewed' && group.status === 'reviewed' && !dirty && !working
  const delivered = ['sending', 'sent', 'handed_off', 'external_confirmed'].includes(letter.status)
  const canRebuild = !working && (!delivered || group.status === 'stale')
  const recipientList = recipients.split(/[\s,;]+/).filter(Boolean)
  return (
    <section className={`${cardClass} flex min-w-0 flex-col gap-4`}>
      {stale ? <Banner tone="warn">Появились новые данные. Отправка закрыта — обновите черновик.</Banner> : null}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={group.status}>{STATUS_LABEL[group.status]}</Badge>
        <span>v{letter.revision}</span>
        <span className="text-ink-soft">{dirty ? 'есть несохранённое' : `сохранено ${formatMsk(letter.createdAt)}`}</span>
      </div>
      <p className="text-sm">От: {settings?.senderName ?? '—'}</p>
      <label className="text-sm font-semibold">
        Кому
        <input className={`${inputClass} mt-1 w-full font-normal`} value={recipients} onChange={(event) => setRecipients(event.target.value)} />
      </label>
      <div className="flex gap-2" role="tablist">
        {(['preview', 'edit', 'diff'] as const).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={mode === item} className={`min-h-11 rounded-full px-3 py-1 text-sm ${mode === item ? 'bg-brand-soft' : 'bg-muted'}`} onClick={() => setMode(item)}>
            {item === 'preview' ? 'Предпросмотр' : item === 'edit' ? 'Редактирование' : 'Изменения'}
          </button>
        ))}
      </div>
      {mode === 'edit' ? (
        <div className="flex flex-col gap-3">
          <Field label="Тема"><textarea className="min-h-16 rounded-xl bg-muted p-3 font-normal" value={subject} onChange={(event) => setSubject(event.target.value)} /></Field>
          <Field label="Вступление"><textarea className="min-h-24 rounded-xl bg-muted p-3 font-normal" value={intro} onChange={(event) => setIntro(event.target.value)} /></Field>
          <Field label="Заключение"><textarea className="min-h-16 rounded-xl bg-muted p-3 font-normal" value={closing} onChange={(event) => setClosing(event.target.value)} /></Field>
          <Field label="Подпись"><textarea className="min-h-16 rounded-xl bg-muted p-3 font-normal" value={signature} onChange={(event) => setSignature(event.target.value)} /></Field>
        </div>
      ) : null}
      {mode === 'diff' ? (
        <ul className="text-sm">
          {group.changes.map((change) => (
            <li key={change.id} className="border-b border-line py-2">{change.fullName}: {change.fields.map((field) => `${field.label} ${field.before || '—'} → ${field.after || '—'}`).join('; ')}</li>
          ))}
        </ul>
      ) : (
        <EmailPreview
          hotelName={group.hotel.name}
          airportCode={group.airportCode}
          stayDate={group.localStayDate}
          timezoneLabel={group.hotel.utcOffset}
          greeting={letter.greeting}
          intro={intro}
          closing={closing}
          signature={signature}
          rows={letter.rows}
          columns={letter.columns}
          newLabel={letter.newLabel}
          cancelLabel={letter.cancelLabel}
          caption="Так письмо увидит гостиница"
        />
      )}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 bg-white py-3">
        <span className="mr-auto text-xs text-ink-soft">{dirty ? 'Есть изменения' : 'Сохранено'}</span>
        <Button tone="ghost" disabled={!dirty || working} onClick={() => void saveLetter(letter, { subject, intro, closing, signature, recipients: recipientList })}>Сохранить черновик</Button>
        <Button tone="ghost" disabled={!canReview} title={dirty ? 'Сначала сохраните черновик' : undefined} onClick={() => setConfirmReview(true)}>Отметить проверенным</Button>
        {mailInApp ? (
          <Button tone="accent" disabled={!canDeliver} onClick={() => setConfirmSend(true)}>Отправить</Button>
        ) : (
          <Button tone="ok" disabled={!canDeliver} onClick={() => void handoffLetter(letter)}>Передать в почту</Button>
        )}
        <Button tone="soft" disabled={!canRebuild} onClick={() => (letter.manualEdits ? setConfirmRebuild(true) : void rebuildLetter(letter))}>Обновить черновик</Button>
      </div>
      <Dialog open={confirmReview} title="Проверка письма" onClose={() => setConfirmReview(false)} footer={<Button onClick={() => { setConfirmReview(false); void reviewLetter(letter) }}>Проверены получатели, даты и все изменения</Button>}>
        <p className="text-sm">{group.hotel.name}, {formatStay(group.localStayDate)}, {recipients}</p>
      </Dialog>
      <Dialog open={confirmSend} title="Отправить письмо" onClose={() => setConfirmSend(false)} footer={<Button tone="accent" disabled={working} onClick={() => { setConfirmSend(false); void sendLetter(letter) }}>Отправить</Button>}>
        <p className="text-sm">Получатели: {recipients}</p>
      </Dialog>
      <Dialog open={confirmRebuild} title="Обновить черновик" onClose={() => setConfirmRebuild(false)} footer={<Button onClick={() => { setConfirmRebuild(false); void rebuildLetter(letter) }}>Сохранить копию и пересобрать</Button>}>
        <p className="text-sm">Ручные правки не переносятся. Старая версия останется в архиве.</p>
      </Dialog>
    </section>
  )
}

function matchTab(group: WorkGroup, tab: Tab): boolean {
  return tabOf(group) === tab
}

function tabOf(group: WorkGroup): Tab {
  if (group.status === 'needs_review') return 'review'
  if (group.status === 'reviewed' || group.status === 'handed_off') return 'reviewed'
  if (group.status === 'waiting' || group.status === 'preparing') return 'waiting'
  if (group.status === 'stale' || group.status === 'needs_decision' || group.status === 'needs_baseline') return 'problems'
  return 'sent'
}

function SentList() {
  const notices = useWorkplace((state) => state.notices)
  const busy = useWorkplace((state) => state.busy)
  const confirmOutside = useWorkplace((state) => state.confirmOutside)
  const [id, setId] = useState<string | null>(notices[0]?.id ?? null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [basis, setBasis] = useState('Отправлено из почтового клиента')
  const selected = notices.find((item) => item.id === id) ?? notices[0] ?? null
  if (notices.length === 0) return <EmptyState title="Отправленных писем ещё нет" />
  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <ul className="flex flex-col gap-2">
        {notices.map((item) => (
          <li key={item.id}>
            <button type="button" className={`${cardClass} w-full text-left ${item.id === selected?.id ? 'ring-2 ring-brand-strong' : ''}`} onClick={() => setId(item.id)}>
              <span className="font-semibold">{item.hotelName}</span>
              <span className="block text-xs text-ink-soft">{formatStay(item.localStayDate)} · {TRANSPORT_LABEL[item.transport]}</span>
            </button>
          </li>
        ))}
      </ul>
      {selected ? (
        <div className="flex min-w-0 flex-col gap-3">
          {selected.letter ? (
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
              caption={`Архив v${selected.revision}, только чтение`}
            />
          ) : (
            <p className={cardClass}>Архив письма недоступен</p>
          )}
          {selected.transport === 'handed_off' ? (
            <div className="flex justify-end">
              <Button disabled={busy === `notice:${selected.id}`} onClick={() => setConfirmOpen(true)}>Подтвердить отправку вне системы</Button>
            </div>
          ) : null}
          <Dialog
            open={confirmOpen}
            title="Подтвердить отправку"
            onClose={() => setConfirmOpen(false)}
            footer={<Button disabled={!basis.trim()} onClick={() => { setConfirmOpen(false); void confirmOutside(selected.id, basis.trim()) }}>Подтвердить</Button>}
          >
            <label className="flex flex-col gap-1.5 text-sm font-semibold">
              Основание
              <input className={inputClass} value={basis} maxLength={500} onChange={(event) => setBasis(event.target.value)} />
            </label>
          </Dialog>
        </div>
      ) : null}
    </div>
  )
}
