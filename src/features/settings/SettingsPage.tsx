import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { DirectoryHotel, SettingsDto } from '../../api/types'
import { letterRows, normalizeEmails, templateProblems } from '../../domain/email'
import { defaultTemplate } from '../../domain/templates'
import { sourceProblemText } from '../../domain/labels'
import { formatMsk } from '../../domain/time'
import type { MailTemplate, TemplateId } from '../../domain/types'
import { useSession } from '../../state/useSession'
import { useWorkplace } from '../../state/workplace'
import { EmailPreview } from '../../ui/EmailPreview'
import { Badge, Button, Dialog, EmptyState, Field, cardClass, inputClass } from '../../ui/kit'
import { isIata } from './iata'

const TABS = [
  ['aviabit', 'Aviabit'],
  ['mail', 'Почта'],
  ['auto', 'Автоматизация'],
  ['templates', 'Шаблоны писем'],
  ['hotels', 'Гостиницы и получатели'],
] as const

type Tab = (typeof TABS)[number][0]

const REQUIRED_COLUMNS = ['Аэропорт', 'Фамилия И.О.', 'Рейс прибытия', 'Дата и время прибытия', 'Рейс отправления', 'Дата и время отправления', 'Тип комнаты', 'Идентификатор брони', 'Код гостиницы']

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const EDITABLE: Array<keyof SettingsDto> = ['pollMinutes', 'quietMinutes', 'autoCheck', 'autoPrepare', 'stayScope', 'staleAfterMinutes', 'senderName']

export function SettingsPage() {
  const loaded = useWorkplace((state) => state.loaded)
  const settings = useWorkplace((state) => state.settings)
  const [params, setParams] = useSearchParams()
  const tab: Tab = TABS.some((item) => item[0] === params.get('tab')) ? (params.get('tab') as Tab) : 'aviabit'
  if (!loaded || !settings) return <p className="text-sm text-ink-soft">Загрузка…</p>
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[28px] font-bold leading-9">Настройки</h1>
        <p className="text-ink-soft">Источники, автоматизация и письма</p>
      </div>
      <div className="flex gap-2 overflow-auto" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`min-h-11 whitespace-nowrap rounded-full px-3 py-2 text-sm ${tab === id ? 'bg-brand-soft font-semibold' : 'bg-white'}`} onClick={() => setParams({ tab: id })}>
            {label}
          </button>
        ))}
      </div>
      <SettingsForm key={settings.version} tab={tab} settings={settings} hotelParam={params.get('hotel')} />
    </div>
  )
}

function SettingsForm({ tab, settings, hotelParam }: { tab: Tab; settings: SettingsDto; hotelParam: string | null }) {
  const session = useSession()
  const source = useWorkplace((state) => state.source)
  const integrations = useWorkplace((state) => state.integrations)
  const snapshots = useWorkplace((state) => state.snapshots)
  const templates = useWorkplace((state) => state.templates)
  const hotels = useWorkplace((state) => state.hotels)
  const busy = useWorkplace((state) => state.busy)
  const saveSettings = useWorkplace((state) => state.saveSettings)
  const publishTemplate = useWorkplace((state) => state.publishTemplate)
  const saveHotel = useWorkplace((state) => state.saveHotel)
  const [draft, setDraft] = useState(settings)
  const [templateId, setTemplateId] = useState<TemplateId>('adjustment')
  const [template, setTemplate] = useState<MailTemplate>(templates.adjustment)
  const [hotel, setHotel] = useState<DirectoryHotel | null>(() => hotels.find((item) => item.id === hotelParam) ?? null)
  const lead = session.me?.role === 'lead'
  const patch = Object.fromEntries(EDITABLE.filter((key) => draft[key] !== settings[key]).map((key) => [key, draft[key]])) as Partial<SettingsDto>
  const dirty = Object.keys(patch).length > 0
  const mail = integrations.find((item) => item.adapter === 'mail')
  const quietExample = useMemo(() => `Изменение в 14:07 → черновик не раньше ${addQuiet('14:07', draft.quietMinutes)}`, [draft.quietMinutes])
  return (
    <>
      {tab === 'aviabit' ? (
        <section className={`${cardClass} max-w-3xl`}>
          <h2 className="mb-4 text-lg font-bold">Источник размещения</h2>
          <div className="grid gap-4 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={source?.problem ? 'error' : source?.lastSuccessAt ? 'ok' : 'info'}>{snapshots[0]?.source ?? 'Нет данных'}</Badge>
              <span className="tabular-nums text-ink-soft">Последний снимок: {source?.lastSuccessAt ? formatMsk(source.lastSuccessAt) : 'нет'}</span>
            </p>
            {source?.problem ? <p className="text-danger">{sourceProblemText(source.problem)}</p> : null}
            <div>
              <p className="mb-2 font-semibold">Колонки выгрузки</p>
              <ul className="flex flex-wrap gap-2">
                {REQUIRED_COLUMNS.map((column) => <li key={column} className="rounded-full bg-muted px-3 py-1">{column}</li>)}
              </ul>
            </div>
          </div>
        </section>
      ) : null}
      {tab === 'mail' ? (
        <section className={`${cardClass} max-w-3xl`}>
          <h2 className="mb-4 text-lg font-bold">Почтовый транспорт</h2>
          <div className="grid gap-4">
            <p className="flex items-center gap-2 text-sm">
              <Badge tone={mail?.configured ? 'ok' : 'info'}>{mail?.configured ? 'Отправка в интерфейсе' : 'Передача в почтовый клиент'}</Badge>
            </p>
            <Field label="Имя отправителя">
              <input className={inputClass} disabled={!lead} value={draft.senderName} onChange={(event) => setDraft({ ...draft, senderName: event.target.value })} />
            </Field>
            <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked disabled readOnly /> Всегда требовать проверку человеком</label>
          </div>
        </section>
      ) : null}
      {tab === 'auto' ? (
        <section className="grid gap-4 lg:grid-cols-[minmax(0,720px)_1fr]">
          <div className={`${cardClass} grid gap-4`}>
            <label className="flex min-h-11 items-center gap-2 text-sm font-semibold"><input type="checkbox" disabled={!lead} checked={draft.autoCheck} onChange={(event) => setDraft({ ...draft, autoCheck: event.target.checked })} /> Автопроверка</label>
            <Field label="Проверять каждые, мин"><input className={inputClass} disabled={!lead} type="number" min={1} max={60} value={draft.pollMinutes} onChange={(event) => setDraft({ ...draft, pollMinutes: Number(event.target.value) })} /></Field>
            <Field label="Готовить после паузы, мин"><input className={inputClass} type="number" min={1} max={120} value={draft.quietMinutes} onChange={(event) => setDraft({ ...draft, quietMinutes: Number(event.target.value) })} /></Field>
            <Field label="Обрабатывать даты">
              <select className={inputClass} disabled={!lead} value={draft.stayScope} onChange={(event) => setDraft({ ...draft, stayScope: event.target.value as SettingsDto['stayScope'] })}>
                <option value="today">Сегодня</option>
                <option value="tomorrow">Завтра</option>
                <option value="both">Сегодня и завтра</option>
              </select>
            </Field>
            <Field label="Предупреждать об устаревших данных, мин"><input className={inputClass} disabled={!lead} type="number" min={2} max={180} value={draft.staleAfterMinutes} onChange={(event) => setDraft({ ...draft, staleAfterMinutes: Number(event.target.value) })} /></Field>
            <label className="flex min-h-11 items-center gap-2 text-sm font-semibold"><input type="checkbox" disabled={!lead} checked={draft.autoPrepare} onChange={(event) => setDraft({ ...draft, autoPrepare: event.target.checked })} /> Автоматически готовить черновики</label>
          </div>
          <aside className={cardClass}>
            <h2 className="mb-2 text-lg font-bold">Пример</h2>
            <p className="text-sm">{quietExample}. Пауза отдельная для каждой гостиницы и даты.</p>
          </aside>
        </section>
      ) : null}
      {tab === 'templates' ? (
        <TemplateBuilder
          templateId={templateId}
          template={template}
          lead={lead}
          saving={busy === 'template'}
          onPick={(id) => { setTemplateId(id); setTemplate(templates[id]) }}
          onChange={setTemplate}
          onSave={() => void publishTemplate(templateId, template)}
        />
      ) : null}
      {tab === 'hotels' ? (
        <section className={cardClass}>
          <div className="mb-3 flex justify-between">
            <h2 className="text-lg font-bold">Гостиницы</h2>
            <Button disabled={!lead} onClick={() => setHotel(blankHotel())}>Добавить гостиницу</Button>
          </div>
          {hotels.length === 0 ? <EmptyState title="Гостиниц нет" /> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-xs text-ink-soft"><tr><th>Название</th><th>IATA</th><th>Получатели</th><th>Договор</th><th></th></tr></thead>
                <tbody>
                  {hotels.map((item) => (
                    <tr key={item.id} className="border-t border-line">
                      <td className="py-3">{item.name}{item.active ? '' : ' · отключена'}<span className="block text-xs text-ink-soft">{item.city}{item.sourceHotelId ? ` · ${item.sourceHotelId}` : ''}</span></td>
                      <td>{item.airportCode}</td>
                      <td className={item.recipients.length ? undefined : 'text-danger'}>{item.recipients.join(', ') || 'нет'}</td>
                      <td>{item.contractStatus === 'confirmed' ? 'Подтверждён' : item.contractStatus === 'none' ? 'Нет' : 'Неизвестно'}</td>
                      <td><button type="button" className="min-h-11 font-semibold text-brand-strong disabled:opacity-50" disabled={!lead} onClick={() => setHotel(item)}>Изменить</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
      {dirty ? (
        <div className="sticky bottom-4 flex items-center justify-between rounded-2xl bg-ink px-4 py-3 text-sm text-white">
          <span>Есть изменения</span>
          <span className="flex gap-2">
            <Button tone="ghost" onClick={() => setDraft(settings)}>Отменить</Button>
            <Button disabled={busy === 'settings'} onClick={() => void saveSettings(patch)}>Сохранить</Button>
          </span>
        </div>
      ) : null}
      {hotel ? <HotelDialog key={hotel.id} hotel={hotel} saving={busy === 'hotel'} onClose={() => setHotel(null)} onSave={async (next) => { if (await saveHotel(next)) setHotel(null) }} /> : null}
    </>
  )
}

function TemplateBuilder({ templateId, template, lead, saving, onPick, onChange, onSave }: { templateId: TemplateId; template: MailTemplate; lead: boolean; saving: boolean; onPick: (id: TemplateId) => void; onChange: (template: MailTemplate) => void; onSave: () => void }) {
  const problems = templateProblems(template)
  const rows = letterRows({
    latest: [{ id: 'preview', crewId: 'crew-preview', fullName: 'Соколова Мария Андреевна', hotelId: 'preview', airportCode: 'SVX', localStayDate: '2026-10-09', arrivalFlight: 'CS 101', arrivalLocalDate: '2026-10-09', arrivalLocalTime: '17:45', departureFlight: 'CS 202', departureLocalDate: '2026-10-10', departureLocalTime: '08:10', roomType: 'SGL', gender: 'F', recordStatus: 'active' }],
    baseline: [{ id: 'preview', crewId: 'crew-preview', fullName: 'Соколова Мария Андреевна', hotelId: 'preview', airportCode: 'SVX', localStayDate: '2026-10-09', arrivalFlight: 'CS 101', arrivalLocalDate: '2026-10-09', arrivalLocalTime: '14:20', departureFlight: 'CS 202', departureLocalDate: '2026-10-10', departureLocalTime: '08:10', roomType: 'SGL', gender: 'F', recordStatus: 'active' }],
    columns: template.columns,
  })
  const textOf = (kind: MailTemplate['blocks'][number]['kind']) => template.blocks.find((block) => block.kind === kind)?.text ?? ''
  return (
    <div className="grid gap-4 lg:grid-cols-[45%_55%]">
      <section className={cardClass}>
        <select className={`${inputClass} mb-4`} value={templateId} aria-label="Шаблон" onChange={(event) => onPick(event.target.value as TemplateId)}>
          <option value="adjustment">Корректировка</option>
          <option value="new_booking">Новая заявка</option>
          <option value="cancellation">Отмена</option>
        </select>
        {template.blocks.filter((block) => block.kind !== 'header' && block.kind !== 'table').map((block) => (
          <Field key={block.id} label={block.title}>
            <textarea className="min-h-16 rounded-xl bg-muted p-3 font-normal" disabled={!lead} value={block.text} onChange={(event) => onChange({ ...template, blocks: template.blocks.map((item) => (item.id === block.id ? { ...item, text: event.target.value } : item)) })} />
          </Field>
        ))}
        <div className="mt-3 flex gap-2">
          <input className={inputClass} disabled={!lead} value={template.newLabel} aria-label="Метка новой заявки" onChange={(event) => onChange({ ...template, newLabel: event.target.value })} />
          <input className={inputClass} disabled={!lead} value={template.cancelLabel} aria-label="Метка отмены" onChange={(event) => onChange({ ...template, cancelLabel: event.target.value })} />
        </div>
        <ul className="mt-3 text-sm text-danger">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
        <div className="mt-4 flex gap-2">
          <Button disabled={!lead || problems.length > 0 || saving} onClick={onSave}>Опубликовать</Button>
          <Button tone="ghost" disabled={!lead} onClick={() => onChange(defaultTemplate(templateId))}>Восстановить стандартный</Button>
        </div>
      </section>
      <EmailPreview hotelName="Гостиница" airportCode="SVX" stayDate="2026-10-09" timezoneLabel="+05:00" greeting={textOf('greeting')} intro={textOf('intro')} closing={textOf('closing')} signature={textOf('signature')} rows={rows} columns={template.columns} newLabel={template.newLabel} cancelLabel={template.cancelLabel} caption="Предпросмотр" />
    </div>
  )
}

function HotelDialog({ hotel, saving, onClose, onSave }: { hotel: DirectoryHotel; saving: boolean; onClose: () => void; onSave: (hotel: DirectoryHotel) => void }) {
  const [draft, setDraft] = useState(hotel)
  const [error, setError] = useState('')
  const listText = (values: string[]) => values.join(', ')
  const parseList = (value: string) => value.split(/[\s,;]+/).filter(Boolean)
  const submit = () => {
    const recipients = normalizeEmails(draft.recipients)
    const cc = normalizeEmails(draft.cc)
    if (!draft.name.trim() || !draft.city.trim() || !isIata(draft.airportCode)) {
      setError('Нужны название, город и IATA из трёх букв')
      return
    }
    if ([...recipients, ...cc].some((email) => !EMAIL_PATTERN.test(email))) {
      setError('Проверьте адреса: нужен формат name@domain')
      return
    }
    onSave({ ...draft, recipients, cc })
  }
  return (
    <Dialog open title={hotel.name || 'Новая гостиница'} onClose={onClose} footer={<Button disabled={saving} onClick={submit}>Сохранить</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Название"><input className={inputClass} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
        <Field label="Город"><input className={inputClass} value={draft.city} onChange={(event) => setDraft({ ...draft, city: event.target.value })} /></Field>
        <Field label="IATA"><input className={inputClass} maxLength={3} value={draft.airportCode} onChange={(event) => setDraft({ ...draft, airportCode: event.target.value.toUpperCase() })} /></Field>
        <Field label="Код в выгрузке"><input className={inputClass} value={draft.sourceHotelId} onChange={(event) => setDraft({ ...draft, sourceHotelId: event.target.value })} /></Field>
        <Field label="Часовой пояс"><input className={inputClass} placeholder="Asia/Yekaterinburg" value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></Field>
        <Field label="Договор">
          <select className={inputClass} value={draft.contractStatus} onChange={(event) => setDraft({ ...draft, contractStatus: event.target.value as DirectoryHotel['contractStatus'] })}>
            <option value="confirmed">Подтверждён</option>
            <option value="none">Нет</option>
            <option value="unknown">Неизвестно</option>
          </select>
        </Field>
        <Field label="Кому"><input className={inputClass} type="email" multiple value={listText(draft.recipients)} onChange={(event) => setDraft({ ...draft, recipients: parseList(event.target.value) })} /></Field>
        <Field label="Копия"><input className={inputClass} type="email" multiple value={listText(draft.cc)} onChange={(event) => setDraft({ ...draft, cc: parseList(event.target.value) })} /></Field>
        <label className="flex min-h-11 items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={draft.active} onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /> Активна</label>
      </div>
      {error ? <p className="mt-3 text-sm text-danger" role="alert">{error}</p> : null}
    </Dialog>
  )
}

function blankHotel(): DirectoryHotel {
  return { id: `new-${Date.now()}`, sourceHotelId: '', version: 0, name: '', city: '', airportCode: '', airportName: '', timezone: 'Europe/Moscow', utcOffset: '+03:00', recipients: [], cc: [], contractStatus: 'unknown', active: true, recipientSource: 'local', comment: '', sourceRecipients: [], sourceCc: [] }
}

function addQuiet(time: string, minutes: number): string {
  const [hour = 0, minute = 0] = time.split(':').map(Number)
  const total = hour * 60 + minute + minutes
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}
