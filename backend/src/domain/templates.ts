import { hasMarkup, unknownTokens, type ColumnSetting } from './letter.ts'

export interface TemplateBlock {
  kind: 'subject' | 'greeting' | 'intro' | 'header' | 'table' | 'closing' | 'signature'
  text: string
}

export interface MailTemplate {
  templateKey: 'adjustment' | 'new_booking' | 'cancellation'
  blocks: TemplateBlock[]
  columns: ColumnSetting[]
  newLabel: string
  cancelLabel: string
}

const COLUMN_TITLES: Record<string, string> = {
  fullName: 'ФИО',
  arrivalFlight: 'Рейс прибытия',
  arrivalDate: 'Дата прилёта',
  arrivalTime: 'Время прилёта',
  departureFlight: 'Рейс вылета',
  departureDate: 'Дата вылета',
  departureTime: 'Время вылета',
  roomType: 'Тип номера',
}

const COLUMN_KEYS = Object.keys(COLUMN_TITLES)
const BLOCK_KINDS: TemplateBlock['kind'][] = ['subject', 'greeting', 'intro', 'header', 'table', 'closing', 'signature']

export function defaultColumns(): ColumnSetting[] {
  return COLUMN_KEYS.map((key) => ({ key, title: COLUMN_TITLES[key] ?? key, visible: true }))
}

function blocks(intro: string): TemplateBlock[] {
  return [
    { kind: 'subject', text: 'Корректировка размещения — {airport_code}, {stay_date}' },
    { kind: 'greeting', text: 'Добрый день!' },
    { kind: 'intro', text: intro },
    { kind: 'header', text: '' },
    { kind: 'table', text: '' },
    { kind: 'closing', text: 'Просим подтвердить получение корректировки.' },
    { kind: 'signature', text: '{sender_name}' },
  ]
}

export function defaultTemplate(templateKey: MailTemplate['templateKey']): MailTemplate {
  const intro =
    templateKey === 'cancellation'
      ? 'Направляем отмену размещения экипажа. Просим учесть обновлённые данные.'
      : templateKey === 'new_booking'
        ? 'Направляем новую заявку на размещение экипажа.'
        : 'Направляем корректировку размещения экипажа. Изменения отмечены в таблице.'
  return { templateKey, blocks: blocks(intro), columns: defaultColumns(), newLabel: 'Новая заявка', cancelLabel: 'Отмена' }
}

export function defaultTemplates(): MailTemplate[] {
  return [defaultTemplate('adjustment'), defaultTemplate('new_booking'), defaultTemplate('cancellation')]
}

export function templateProblems(template: MailTemplate): string[] {
  const problems: string[] = []
  if (!template.newLabel.trim() || !template.cancelLabel.trim()) problems.push('Метки должны быть заполнены')
  if (template.newLabel.trim() === template.cancelLabel.trim()) problems.push('Метки должны различаться')
  const kinds = template.blocks.map((block) => block.kind)
  for (const kind of BLOCK_KINDS) {
    if (!kinds.includes(kind)) problems.push(`Нет блока ${kind}`)
  }
  if (new Set(kinds).size !== kinds.length) problems.push('Блоки повторяются')
  const columnKeys = template.columns.map((column) => column.key)
  if (columnKeys.some((key) => !COLUMN_KEYS.includes(key)) || new Set(columnKeys).size !== COLUMN_KEYS.length) {
    problems.push('Набор колонок не совпадает со списком письма')
  }
  for (const text of [template.newLabel, template.cancelLabel, ...template.blocks.map((block) => block.text)]) {
    if (hasMarkup(text)) problems.push('Доступны только текст и блоки письма')
    const unknown = unknownTokens(text)
    if (unknown.length > 0) problems.push(`Неизвестные переменные: ${unknown.join(', ')}`)
  }
  return [...new Set(problems)]
}

export function blockText(template: MailTemplate, kind: TemplateBlock['kind']): string {
  return template.blocks.find((block) => block.kind === kind)?.text ?? ''
}
