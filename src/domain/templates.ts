import type { ColumnKey, ColumnSetting, MailTemplate, Settings, TemplateBlock, TemplateId } from './types'

const COLUMN_TITLES: Record<ColumnKey, string> = {
  fullName: 'ФИО',
  arrivalFlight: 'Рейс прибытия',
  arrivalDate: 'Дата прилёта',
  arrivalTime: 'Время прилёта',
  departureFlight: 'Рейс вылета',
  departureDate: 'Дата вылета',
  departureTime: 'Время вылета',
  roomType: 'Тип номера',
}

const COLUMN_KEYS: ColumnKey[] = [
  'fullName',
  'arrivalFlight',
  'arrivalDate',
  'arrivalTime',
  'departureFlight',
  'departureDate',
  'departureTime',
  'roomType',
]

export function defaultColumns(): ColumnSetting[] {
  return COLUMN_KEYS.map((key) => ({ key, title: COLUMN_TITLES[key], visible: true }))
}

function blocks(id: TemplateId, intro: string): TemplateBlock[] {
  return [
    { id: `${id}-subject`, kind: 'subject', title: 'Тема', hint: 'Переменные подставляются при сборке', text: 'Корректировка заявки на размещение в гостинице от АК «Победа» — {airport_code}, {stay_date}', required: true },
    { id: `${id}-greeting`, kind: 'greeting', title: 'Приветствие', hint: 'Необязательный текст', text: 'Добрый день!', required: false },
    { id: `${id}-intro`, kind: 'intro', title: 'Вступление', hint: 'Гостиница видит этот текст над таблицей', text: intro, required: false },
    { id: `${id}-header`, kind: 'header', title: 'Шапка размещения', hint: 'Дата, аэропорт и гостиница. Удалить нельзя', text: '', required: true },
    { id: `${id}-table`, kind: 'table', title: 'Таблица', hint: 'Системный блок, не текстовая переменная', text: '', required: true },
    { id: `${id}-closing`, kind: 'closing', title: 'Заключение', hint: 'Необязательный текст', text: 'Просим подтвердить получение корректировки.', required: false },
    { id: `${id}-signature`, kind: 'signature', title: 'Подпись', hint: 'Имя отправителя берётся из настроек почты', text: '{sender_name}\nCrew Support · демонстрация', required: false },
  ]
}

export function defaultTemplate(id: TemplateId): MailTemplate {
  const intro =
    id === 'cancellation'
      ? 'Добрый день! Направляем отмену размещения экипажа АК «Победа». Просим учесть обновлённые данные.'
      : id === 'new_booking'
        ? 'Добрый день! Направляем новую заявку на размещение экипажа АК «Победа».'
        : 'Добрый день! Направляем корректировку заявки на размещение экипажа АК «Победа». Изменения выделены красным курсивом. Просим учесть обновлённые данные.'
  const name = id === 'cancellation' ? 'Отмена' : id === 'new_booking' ? 'Новая заявка' : 'Корректировка'
  return { id, name, blocks: blocks(id, intro), columns: defaultColumns(), newLabel: 'Новая заявка', cancelLabel: 'Отмена' }
}

export function defaultSettings(): Settings {
  return {
    sourceMode: 'demo_api',
    aviabitBaseUrl: 'https://aviabit.example',
    reportName: 'Размещение экипажей',
    sourceTimezone: 'Europe/Moscow',
    mailMode: 'in_app',
    connectionName: 'Почта · демо',
    senderName: 'Crew Support',
    senderAddress: 'crew-support@example.com',
    replyTo: 'crew-support@example.com',
    serviceCc: 'shift-log@example.com',
    mailEndpoint: 'https://mail.example',
    draftFolder: 'Drafts',
    autoCheck: true,
    pollMinutes: 5,
    quietMinutes: 10,
    stayScope: 'both',
    staleAfterMinutes: 15,
    autoPrepare: true,
    requireHumanReview: true,
    templateVersion: 1,
    templates: {
      adjustment: defaultTemplate('adjustment'),
      new_booking: defaultTemplate('new_booking'),
      cancellation: defaultTemplate('cancellation'),
    },
  }
}
