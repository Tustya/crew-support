import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { isDemoEmail, normalizeEmails, templateProblems } from '../../domain/email'
import { letterRows } from '../../domain/email'
import { defaultTemplate } from '../../domain/templates'
import type { Hotel, MailTemplate, TemplateId } from '../../domain/types'
import { isIata } from './iata'
import { useDemoStore } from '../../state/store'
import { EmailPreview } from '../../ui/EmailPreview'
import { Button, Dialog, Field, inputClass, cardClass } from '../../ui/kit'

const TABS = [
  ['aviabit', 'Aviabit'],
  ['mail', 'Почта'],
  ['auto', 'Автоматизация'],
  ['templates', 'Шаблоны писем'],
  ['hotels', 'Гостиницы и получатели'],
] as const

export function SettingsPage() {
  const data = useDemoStore((state) => state.data)
  const secrets = useDemoStore((state) => state.secrets)
  const setSecret = useDemoStore((state) => state.setSecret)
  const saveSettings = useDemoStore((state) => state.saveSettings)
  const saveMailTemplate = useDemoStore((state) => state.saveMailTemplate)
  const saveDirectoryHotel = useDemoStore((state) => state.saveDirectoryHotel)
  const runCheck = useDemoStore((state) => state.runCheck)
  const [params, setParams] = useSearchParams()
  const tab = TABS.some((item) => item[0] === params.get('tab')) ? (params.get('tab') as (typeof TABS)[number][0]) : 'aviabit'
  const [draftSettings, setDraftSettings] = useState(data.settings)
  const [templateId, setTemplateId] = useState<TemplateId>(data.settings.templates.adjustment.id)
  const [template, setTemplate] = useState<MailTemplate>(data.settings.templates.adjustment)
  const [hotel, setHotel] = useState<Hotel | null>(null)
  const [showToken, setShowToken] = useState(false)
  const lead = data.role === 'lead'
  const dirty = JSON.stringify(draftSettings) !== JSON.stringify(data.settings)
  const quietExample = useMemo(() => `Изменение в 14:07 → черновик не раньше ${addQuiet('14:07', draftSettings.quietMinutes)}`, [draftSettings.quietMinutes])
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-[28px] font-bold leading-9">Настройки</h1>
        <p className="text-ink-soft">Источники, автоматизация и письма</p>
      </div>
      <div className="flex gap-2 overflow-auto">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={`rounded-full px-3 py-2 text-sm ${tab === id ? 'bg-brand-soft font-semibold' : 'bg-white'}`} onClick={() => setParams({ tab: id })}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'aviabit' ? (
        <section className={`${cardClass} max-w-3xl`}>
          <h2 className="mb-4 text-lg font-bold">Источник размещения</h2>
          <div className="grid gap-4">
            <Field label="Режим">
              <select className={inputClass} disabled={!lead} value={draftSettings.sourceMode} onChange={(event) => setDraftSettings({ ...draftSettings, sourceMode: event.target.value as typeof draftSettings.sourceMode })}>
                <option value="demo_api">Демо-API</option>
                <option value="manual_samples">Ручные образцы</option>
              </select>
            </Field>
            <Field label="Base URL">
              <input className={inputClass} disabled={!lead} placeholder="https://aviabit.example" value={draftSettings.aviabitBaseUrl} onChange={(event) => setDraftSettings({ ...draftSettings, aviabitBaseUrl: event.target.value })} />
            </Field>
            <Field label="API token · демонстрация">
              <div className="flex gap-2">
                <input className={inputClass} type={showToken ? 'text' : 'password'} value={secrets.aviabitToken} placeholder="Тестовое значение, только в памяти сессии" onChange={(event) => setSecret('aviabitToken', event.target.value)} />
                <Button tone="ghost" onClick={() => setShowToken((value) => !value)}>{showToken ? 'Скрыть' : 'Показать'}</Button>
              </div>
            </Field>
            <Field label="Отчёт">
              <input className={inputClass} disabled={!lead} value={draftSettings.reportName} onChange={(event) => setDraftSettings({ ...draftSettings, reportName: event.target.value })} />
            </Field>
            <p className="text-sm text-ink-soft">Сопоставление колонок: stable booking ID, crew ID, ФИО, hotel ID, IATA, местные даты и время, рейсы, тип номера. Названия реальной выгрузки будут уточнены. Недостающий stable ID — причина ручной проверки.</p>
            <div className="flex gap-2">
              <Button disabled={!lead} onClick={runCheck}>Проверить подключение · демо</Button>
              <Button tone="ghost" disabled={!lead} onClick={runCheck}>Получить образец · демо</Button>
            </div>
            {!lead ? <p className="text-sm text-ink-soft">Интеграции в этой демонстрации меняет руководитель.</p> : null}
          </div>
        </section>
      ) : null}
      {tab === 'mail' ? (
        <section className={`${cardClass} max-w-3xl`}>
          <h2 className="mb-4 text-lg font-bold">Почтовый транспорт</h2>
          <div className="grid gap-4">
            <Field label="Режим">
              <select className={inputClass} disabled={!lead} value={draftSettings.mailMode} onChange={(event) => setDraftSettings({ ...draftSettings, mailMode: event.target.value as typeof draftSettings.mailMode })}>
                <option value="in_app">Отправка в интерфейсе · демо</option>
                <option value="handoff">Передача черновика в почтовый клиент · демо</option>
              </select>
            </Field>
            <Field label="Имя отправителя"><input className={inputClass} disabled={!lead} value={draftSettings.senderName} onChange={(event) => setDraftSettings({ ...draftSettings, senderName: event.target.value })} /></Field>
            <Field label="Адрес отправителя"><input className={inputClass} disabled={!lead} value={draftSettings.senderAddress} onChange={(event) => setDraftSettings({ ...draftSettings, senderAddress: event.target.value })} /></Field>
            <Field label="Reply-to"><input className={inputClass} disabled={!lead} value={draftSettings.replyTo} onChange={(event) => setDraftSettings({ ...draftSettings, replyTo: event.target.value })} /></Field>
            <Field label="Служебная копия"><input className={inputClass} disabled={!lead} value={draftSettings.serviceCc} onChange={(event) => setDraftSettings({ ...draftSettings, serviceCc: event.target.value })} /></Field>
            <Field label="API endpoint"><input className={inputClass} disabled={!lead} value={draftSettings.mailEndpoint} onChange={(event) => setDraftSettings({ ...draftSettings, mailEndpoint: event.target.value })} /></Field>
            <Field label="Папка черновиков"><input className={inputClass} disabled={!lead || draftSettings.mailMode !== 'handoff'} value={draftSettings.draftFolder} onChange={(event) => setDraftSettings({ ...draftSettings, draftFolder: event.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked disabled readOnly /> Всегда требовать проверку человеком</label>
            <p className="text-sm text-ink-soft">Сейчас клиент — Thunderbird, но прототип к нему не подключается и ничего не отправляет по сети.</p>
          </div>
        </section>
      ) : null}
      {tab === 'auto' ? (
        <section className="grid gap-4 lg:grid-cols-[minmax(0,720px)_1fr]">
          <div className={`${cardClass} grid gap-4`}>
            <Field label="Автопроверка"><input type="checkbox" disabled={!lead} checked={draftSettings.autoCheck} onChange={(event) => setDraftSettings({ ...draftSettings, autoCheck: event.target.checked })} /></Field>
            <Field label="Проверять каждые, мин"><input className={inputClass} disabled={!lead} type="number" min={1} max={60} value={draftSettings.pollMinutes} onChange={(event) => setDraftSettings({ ...draftSettings, pollMinutes: Number(event.target.value) })} /></Field>
            <Field label="Готовить после тишины, мин"><input className={inputClass} type="number" min={1} max={120} value={draftSettings.quietMinutes} onChange={(event) => setDraftSettings({ ...draftSettings, quietMinutes: Number(event.target.value) })} /></Field>
            <p className="text-xs text-ink-soft">Таймер отдельный для каждой гостиницы и даты.</p>
            <Field label="Обрабатывать даты">
              <select className={inputClass} disabled={!lead} value={draftSettings.stayScope} onChange={(event) => setDraftSettings({ ...draftSettings, stayScope: event.target.value as typeof draftSettings.stayScope })}>
                <option value="today">Сегодня</option>
                <option value="tomorrow">Завтра</option>
                <option value="both">Сегодня и завтра</option>
              </select>
            </Field>
            <Field label="Предупреждать об устаревших данных, мин"><input className={inputClass} disabled={!lead} type="number" min={2} max={180} value={draftSettings.staleAfterMinutes} onChange={(event) => setDraftSettings({ ...draftSettings, staleAfterMinutes: Number(event.target.value) })} /></Field>
            <Field label="Автоматически готовить черновики"><input type="checkbox" disabled={!lead} checked={draftSettings.autoPrepare} onChange={(event) => setDraftSettings({ ...draftSettings, autoPrepare: event.target.checked })} /></Field>
            <p className="text-sm text-ink-soft">Плановые рассылки Aviabit 06:00 / 18:00 управляются отдельно.</p>
          </div>
          <aside className={cardClass}>
            <h2 className="mb-2 text-lg font-bold">Пример</h2>
            <p className="text-sm">{quietExample}. Правка в 14:12 остаётся в том же письме и срок не сдвигает.</p>
          </aside>
        </section>
      ) : null}
      {tab === 'templates' ? (
        <TemplateBuilder templateId={templateId} template={template} lead={lead} onPick={(id) => { setTemplateId(id); setTemplate(data.settings.templates[id]) }} onChange={setTemplate} onSave={() => saveMailTemplate(templateId, template)} />
      ) : null}
      {tab === 'hotels' ? (
        <section className={cardClass}>
          <div className="mb-3 flex justify-between">
            <h2 className="text-lg font-bold">Гостиницы</h2>
            <Button disabled={!lead} onClick={() => setHotel(blankHotel())}>Добавить гостиницу</Button>
          </div>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-ink-soft"><tr><th>Название</th><th>IATA</th><th>Получатели</th><th>Договор</th><th></th></tr></thead>
            <tbody>
              {data.hotels.map((item) => (
                <tr key={item.id} className="border-t border-line">
                  <td className="py-3">{item.name}<span className="block text-xs text-ink-soft">{item.city}</span></td>
                  <td>{item.airportCode}</td>
                  <td>{item.recipients.join(', ') || 'нет'}</td>
                  <td>{item.contractStatus === 'confirmed' ? 'Подтверждён' : item.contractStatus === 'none' ? 'Нет' : 'Неизвестно'}</td>
                  <td><button type="button" className="font-semibold text-brand-strong" onClick={() => setHotel(item)}>Изменить</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
      {dirty ? (
        <div className="sticky bottom-4 flex items-center justify-between rounded-2xl bg-ink px-4 py-3 text-sm text-white">
          <span>Есть изменения</span>
          <span className="flex gap-2">
            <Button tone="ghost" onClick={() => setDraftSettings(data.settings)}>Отменить</Button>
            <Button onClick={() => saveSettings(draftSettings)}>Сохранить</Button>
          </span>
        </div>
      ) : null}
      <HotelDialog hotel={hotel} onClose={() => setHotel(null)} onSave={(next) => { saveDirectoryHotel(next); setHotel(null) }} />
    </div>
  )
}

function TemplateBuilder({ templateId, template, lead, onPick, onChange, onSave }: { templateId: TemplateId; template: MailTemplate; lead: boolean; onPick: (id: TemplateId) => void; onChange: (template: MailTemplate) => void; onSave: () => void }) {
  const problems = templateProblems(template)
  const rows = letterRows({
    latest: [{ id: 'preview', crewId: 'crew-preview', fullName: 'Соколова Мария Андреевна', hotelId: 'hotel-angel', airportCode: 'SVX', localStayDate: '2026-10-09', arrivalFlight: 'CS 101', arrivalLocalDate: '2026-10-09', arrivalLocalTime: '17:45', departureFlight: 'CS 202', departureLocalDate: '2026-10-10', departureLocalTime: '08:10', roomType: 'SGL', gender: 'F', recordStatus: 'active' }],
    baseline: [{ id: 'preview', crewId: 'crew-preview', fullName: 'Соколова Мария Андреевна', hotelId: 'hotel-angel', airportCode: 'SVX', localStayDate: '2026-10-09', arrivalFlight: 'CS 101', arrivalLocalDate: '2026-10-09', arrivalLocalTime: '14:20', departureFlight: 'CS 202', departureLocalDate: '2026-10-10', departureLocalTime: '08:10', roomType: 'SGL', gender: 'F', recordStatus: 'active' }],
    columns: template.columns,
  })
  const textOf = (kind: MailTemplate['blocks'][number]['kind']) => template.blocks.find((block) => block.kind === kind)?.text ?? ''
  return (
    <div className="grid gap-4 lg:grid-cols-[45%_55%]">
      <section className={cardClass}>
        <select className={`${inputClass} mb-4`} value={templateId} onChange={(event) => onPick(event.target.value as TemplateId)}>
          <option value="adjustment">Корректировка</option>
          <option value="new_booking">Новая заявка</option>
          <option value="cancellation">Отмена</option>
        </select>
        {template.blocks.filter((block) => block.kind !== 'header' && block.kind !== 'table').map((block) => (
          <Field key={block.id} label={block.title}>
            <textarea className="min-h-16 rounded-xl bg-muted p-3 font-normal" disabled={!lead} value={block.text} onChange={(event) => onChange({ ...template, blocks: template.blocks.map((item) => item.id === block.id ? { ...item, text: event.target.value } : item) })} />
          </Field>
        ))}
        <div className="mt-3 flex gap-2">
          <input className={inputClass} disabled={!lead} value={template.newLabel} aria-label="Метка новой заявки" onChange={(event) => onChange({ ...template, newLabel: event.target.value })} />
          <input className={inputClass} disabled={!lead} value={template.cancelLabel} aria-label="Метка отмены" onChange={(event) => onChange({ ...template, cancelLabel: event.target.value })} />
        </div>
        <ul className="mt-3 text-sm text-danger">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
        <div className="mt-4 flex gap-2">
          <Button disabled={!lead || problems.length > 0} onClick={onSave}>Сохранить</Button>
          <Button tone="ghost" onClick={() => onChange(defaultTemplate(templateId))}>Восстановить стандартный</Button>
        </div>
      </section>
      <EmailPreview hotelName="Ангел" airportCode="SVX" stayDate="2026-10-09" timezoneLabel="+05:00" greeting={textOf('greeting')} intro={textOf('intro')} closing={textOf('closing')} signature={textOf('signature')} rows={rows} columns={template.columns} newLabel={template.newLabel} cancelLabel={template.cancelLabel} caption="Несохранённый предпросмотр" />
    </div>
  )
}

function HotelDialog({ hotel, onClose, onSave }: { hotel: Hotel | null; onClose: () => void; onSave: (hotel: Hotel) => void }) {
  const [draft, setDraft] = useState<Hotel | null>(hotel)
  const [error, setError] = useState('')
  if (hotel && draft?.id !== hotel.id) setDraft(hotel)
  return (
    <Dialog open={Boolean(hotel && draft)} title="Гостиница" onClose={onClose} footer={<Button onClick={() => { if (!draft) return; const recipients = normalizeEmails(draft.recipients); if (!isIata(draft.airportCode) || !draft.name.trim()) { setError('Нужны название и IATA из трёх букв'); return } if (recipients.some((email) => !isDemoEmail(email))) { setError('Адреса демо только @example.com'); return } onSave({ ...draft, recipients, recipientSource: 'local' }) }}>Сохранить</Button>}>
      {draft ? (
        <div className="grid gap-3">
          <Field label="Название"><input className={inputClass} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
          <Field label="IATA"><input className={inputClass} value={draft.airportCode} onChange={(event) => setDraft({ ...draft, airportCode: event.target.value.toUpperCase() })} /></Field>
          <Field label="Timezone"><input className={inputClass} value={draft.timezone} onChange={(event) => setDraft({ ...draft, timezone: event.target.value })} /></Field>
          <Field label="Кому"><input className={inputClass} value={draft.recipients.join(', ')} onChange={(event) => setDraft({ ...draft, recipients: event.target.value.split(/[\s,;]+/).filter(Boolean) })} /></Field>
          <Field label="Договор">
            <select className={inputClass} value={draft.contractStatus} onChange={(event) => setDraft({ ...draft, contractStatus: event.target.value as Hotel['contractStatus'] })}>
              <option value="confirmed">Подтверждён</option>
              <option value="none">Нет</option>
              <option value="unknown">Неизвестно</option>
            </select>
          </Field>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      ) : null}
    </Dialog>
  )
}

function blankHotel(): Hotel {
  return { id: `hotel-${Date.now()}`, name: '', city: '', airportCode: '', airportName: '', timezone: 'Europe/Moscow', utcOffset: '+03:00', recipients: [], cc: [], contractStatus: 'unknown', active: true, recipientSource: 'local', comment: '', sourceRecipients: [], sourceCc: [] }
}

function addQuiet(time: string, minutes: number): string {
  const [hour, minute] = time.split(':').map(Number)
  const total = hour * 60 + minute + minutes
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function isSettingsIata(value: string): boolean {
  return /^[A-Z]{3}$/.test(value)
}
