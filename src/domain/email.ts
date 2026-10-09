import { formatStay } from './time'
import type { Booking, ColumnKey, ColumnSetting, Hotel, MailRow, MailTemplate, TemplateBlock, TemplateId } from './types'

export const ALLOWED_TOKENS = [
  'hotel_name',
  'airport_name',
  'airport_code',
  'stay_date',
  'local_timezone',
  'change_count',
  'sender_name',
] as const

const TOKEN_PATTERN = /\{([a-z0-9_]+)\}/g
const EMAIL_PATTERN = /^[a-z0-9._+-]+@example\.com$/i

export function isDemoEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim())
}

export function normalizeEmails(values: string[]): string[] {
  const unique = new Set<string>()
  for (const value of values) {
    const email = value.trim().toLowerCase()
    if (email) unique.add(email)
  }
  return [...unique]
}

export function unknownTokens(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const name = match[1]
    if (!ALLOWED_TOKENS.includes(name as (typeof ALLOWED_TOKENS)[number])) found.add(`{${name}}`)
  }
  return [...found]
}

export function hasMarkup(text: string): boolean {
  return /[<>]/.test(text)
}

export function applyTokens(text: string, variables: Record<string, string>): string {
  return text.replace(TOKEN_PATTERN, (full, name: string) => {
    if (!ALLOWED_TOKENS.includes(name as (typeof ALLOWED_TOKENS)[number])) return full
    return variables[name] || full
  })
}

export function templateTexts(template: MailTemplate): string[] {
  return [template.newLabel, template.cancelLabel, ...template.blocks.map((block) => block.text)]
}

export function templateProblems(template: MailTemplate): string[] {
  const problems: string[] = []
  if (!template.newLabel.trim() || !template.cancelLabel.trim()) problems.push('Метки новой заявки и отмены должны быть заполнены')
  if (template.newLabel.trim() === template.cancelLabel.trim()) problems.push('Метки должны различаться')
  for (const text of templateTexts(template)) {
    if (hasMarkup(text)) problems.push('Доступны только текст и блоки письма')
    const unknown = unknownTokens(text)
    if (unknown.length > 0) problems.push(`Неизвестные переменные: ${unknown.join(', ')}`)
  }
  return [...new Set(problems)]
}

export function recipientKey(hotel: Hotel | undefined): string {
  if (!hotel) return 'missing-hotel'
  const recipients = [...hotel.recipients].sort().join(',')
  const copies = [...hotel.cc].sort().join(',')
  return `${hotel.contractStatus}|${hotel.active ? '1' : '0'}|${recipients}|${copies}`
}

export function columnValue(row: MailRow, key: ColumnKey): string {
  return row[key]
}

export function letterRows(input: {
  latest: Booking[]
  baseline: Booking[] | null
  columns: ColumnSetting[]
}): MailRow[] {
  const latestById = new Map(input.latest.map((booking) => [booking.id, booking]))
  const baselineById = new Map((input.baseline ?? []).map((booking) => [booking.id, booking]))
  const ids = [...new Set([...latestById.keys(), ...baselineById.keys()])]
  const rows: MailRow[] = []
  for (const id of ids) {
    const current = latestById.get(id)
    const previous = baselineById.get(id)
    if (current && current.recordStatus === 'cancelled' && previous?.recordStatus === 'cancelled') continue
    if (!current && previous?.recordStatus === 'cancelled') continue
    const source = current?.recordStatus === 'cancelled' ? current : (current ?? previous)
    if (!source) continue
    const badge = badgeFor(current, previous)
    const changedFields = changedColumns(current, previous, badge)
    rows.push({
      bookingId: id,
      fullName: source.fullName,
      arrivalFlight: source.arrivalFlight,
      arrivalDate: formatStay(source.arrivalLocalDate),
      arrivalTime: source.arrivalLocalTime,
      departureFlight: source.departureFlight,
      departureDate: formatStay(source.departureLocalDate),
      departureTime: source.departureLocalTime,
      roomType: source.roomType,
      badge,
      changedFields,
      manualFields: [],
    })
  }
  return rows.sort((left, right) => left.fullName.localeCompare(right.fullName, 'ru'))
}

function badgeFor(current: Booking | undefined, previous: Booking | undefined): 'new' | 'cancel' | null {
  if (current && current.recordStatus !== 'cancelled' && !previous) return 'new'
  if (current?.recordStatus === 'cancelled' && previous && previous.recordStatus !== 'cancelled') return 'cancel'
  if (!current && previous && previous.recordStatus !== 'cancelled') return 'cancel'
  return null
}

function changedColumns(current: Booking | undefined, previous: Booking | undefined, badge: 'new' | 'cancel' | null): ColumnKey[] {
  if (badge === 'new' || badge === 'cancel') {
    return ['fullName', 'arrivalFlight', 'arrivalDate', 'arrivalTime', 'departureFlight', 'departureDate', 'departureTime', 'roomType']
  }
  if (!current || !previous) return []
  const fields: ColumnKey[] = []
  if (current.arrivalFlight !== previous.arrivalFlight) fields.push('arrivalFlight')
  if (current.arrivalLocalDate !== previous.arrivalLocalDate) fields.push('arrivalDate')
  if (current.arrivalLocalTime !== previous.arrivalLocalTime) fields.push('arrivalTime')
  if (current.departureFlight !== previous.departureFlight) fields.push('departureFlight')
  if (current.departureLocalDate !== previous.departureLocalDate) fields.push('departureDate')
  if (current.departureLocalTime !== previous.departureLocalTime) fields.push('departureTime')
  if (current.roomType !== previous.roomType) fields.push('roomType')
  if (current.fullName !== previous.fullName) fields.push('fullName')
  return fields
}

export function applyOverrides(rows: MailRow[], overrides: { bookingId: string; field: ColumnKey; value: string }[]): MailRow[] {
  if (overrides.length === 0) return rows
  return rows.map((row) => {
    const relevant = overrides.filter((item) => item.bookingId === row.bookingId)
    if (relevant.length === 0) return row
    const next = { ...row, manualFields: [...row.manualFields] }
    for (const item of relevant) {
      next[item.field] = item.value
      if (!next.manualFields.includes(item.field)) next.manualFields.push(item.field)
    }
    return next
  })
}

export function blockText(template: MailTemplate, kind: TemplateBlock['kind']): string {
  return template.blocks.find((block) => block.kind === kind)?.text ?? ''
}

export function pickTemplateId(kinds: string[]): TemplateId {
  if (kinds.length === 0) return 'adjustment'
  const unique = new Set(kinds)
  if ([...unique].every((kind) => kind === 'added')) return 'new_booking'
  if ([...unique].every((kind) => kind === 'cancelled')) return 'cancellation'
  return 'adjustment'
}
