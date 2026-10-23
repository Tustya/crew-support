import type { CanonicalBooking } from './diff.ts'
import { assignRooms, type RoomAssignment } from './rooms.ts'

export const ALLOWED_TOKENS = [
  'hotel_name',
  'airport_code',
  'stay_date',
  'local_timezone',
  'change_count',
  'sender_name',
] as const

const TOKEN_PATTERN = /\{([a-z0-9_]+)\}/g

export interface ColumnSetting {
  key: string
  title: string
  visible: boolean
}

export interface PublicLetterRow {
  bookingId: string
  fullName: string
  arrivalFlight: string
  arrivalDate: string
  arrivalTime: string
  departureFlight: string
  departureDate: string
  departureTime: string
  roomType: string
  roomKey: string
  roomLabel: string
  badge: 'new' | 'cancel' | null
  changedFields: string[]
  manualFields: string[]
}

export interface LetterPayload {
  subject: string
  greeting: string
  intro: string
  closing: string
  signature: string
  rows: PublicLetterRow[]
  columns: ColumnSetting[]
  newLabel: string
  cancelLabel: string
  templateKey: string
  manualEdits: boolean
}

const ROOM_LABEL = { SGL: 'Сингл', DBL: 'Дабл' } as const

export function unknownTokens(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const name = match[1] ?? ''
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

function formatStay(isoDate: string): string {
  const [year, month, day] = isoDate.split('-')
  if (!year || !month || !day) return isoDate
  return `${day}.${month}.${year}`
}

function badgeFor(current: CanonicalBooking | undefined, previous: CanonicalBooking | undefined): 'new' | 'cancel' | null {
  if (current && current.recordStatus !== 'cancelled' && !previous) return 'new'
  if (current?.recordStatus === 'cancelled' && previous && previous.recordStatus !== 'cancelled') return 'cancel'
  if (!current && previous && previous.recordStatus !== 'cancelled') return 'cancel'
  return null
}

export function letterRows(input: {
  latest: readonly CanonicalBooking[]
  baseline: readonly CanonicalBooking[] | null
  keptPairs?: readonly (readonly string[])[]
}): PublicLetterRow[] {
  const latestById = new Map(input.latest.filter((booking) => booking.id).map((booking) => [booking.id as string, booking]))
  const baselineById = new Map((input.baseline ?? []).filter((booking) => booking.id).map((booking) => [booking.id as string, booking]))
  const ids = [...new Set([...latestById.keys(), ...baselineById.keys()])]
  const drafts: Array<Omit<PublicLetterRow, 'roomKey' | 'roomLabel'>> = []
  const guests = []
  for (const id of ids) {
    const current = latestById.get(id)
    const previous = baselineById.get(id)
    if (current && current.recordStatus === 'cancelled' && previous?.recordStatus === 'cancelled') continue
    if (!current && previous?.recordStatus === 'cancelled') continue
    const source = current?.recordStatus === 'cancelled' ? current : (current ?? previous)
    if (!source || !source.gender || !source.roomType) continue
    const badge = badgeFor(current, previous)
    guests.push({
      id,
      crewId: source.crewId ?? id,
      gender: source.gender,
      roomType: source.roomType,
      recordStatus: badge === 'cancel' ? 'cancelled' as const : source.recordStatus,
    })
    drafts.push({
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
      changedFields: changedColumns(current, previous, badge),
      manualFields: [],
    })
  }
  return placeInRooms(drafts, assignRooms(guests, input.keptPairs ?? []))
}

function changedColumns(current: CanonicalBooking | undefined, previous: CanonicalBooking | undefined, badge: 'new' | 'cancel' | null): string[] {
  if (badge === 'new' || badge === 'cancel') {
    return ['fullName', 'arrivalFlight', 'arrivalDate', 'arrivalTime', 'departureFlight', 'departureDate', 'departureTime', 'roomType']
  }
  if (!current || !previous) return []
  const fields: string[] = []
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

function placeInRooms(rows: Array<Omit<PublicLetterRow, 'roomKey' | 'roomLabel'>>, rooms: readonly RoomAssignment[]): PublicLetterRow[] {
  const roomByBookingId = new Map(rooms.flatMap((room) => room.bookingIds.map((bookingId) => [bookingId, room] as const)))
  const placed = rows.flatMap((row) => {
    const room = roomByBookingId.get(row.bookingId)
    if (!room) return []
    const roomLabel = ROOM_LABEL[room.kind]
    return [{ ...row, roomKey: room.key, roomLabel }]
  })
  const leadNameByRoom = new Map<string, string>()
  for (const row of [...placed].sort((left, right) => left.fullName.localeCompare(right.fullName, 'ru'))) {
    if (!leadNameByRoom.has(row.roomKey)) leadNameByRoom.set(row.roomKey, row.fullName)
  }
  return placed.sort(
    (left, right) =>
      (leadNameByRoom.get(left.roomKey) ?? '').localeCompare(leadNameByRoom.get(right.roomKey) ?? '', 'ru') ||
      left.roomKey.localeCompare(right.roomKey) ||
      left.fullName.localeCompare(right.fullName, 'ru'),
  )
}

export function renderLetter(payload: LetterPayload): string {
  const lines = [payload.subject, payload.greeting, payload.intro, payload.newLabel, payload.cancelLabel]
  for (const row of payload.rows) {
    const cells = [
      row.fullName,
      row.arrivalFlight,
      row.arrivalDate,
      mark(row.arrivalTime, row.changedFields.includes('arrivalTime')),
      row.departureFlight,
      row.departureDate,
      row.departureTime,
      row.roomType,
      row.roomLabel,
      row.badge ?? '',
    ]
    lines.push(cells.join(' | '))
  }
  lines.push(payload.closing, payload.signature)
  return lines.filter((line) => line !== '').join('\n')
}

function mark(value: string, changed: boolean): string {
  return changed ? `*${value}*` : value
}

const OVERRIDE_FIELDS = new Set(['fullName', 'arrivalFlight', 'arrivalDate', 'arrivalTime', 'departureFlight', 'departureDate', 'departureTime', 'roomType'])

export function overrideProblems(
  rows: readonly { bookingId: string }[],
  overrides: readonly { bookingId: string; field: string; value: string; reason: string }[],
): string[] {
  const problems: string[] = []
  if (overrides.length > 50) problems.push('too_many')
  const bookingIds = new Set(rows.map((row) => row.bookingId))
  const seen = new Set<string>()
  for (const item of overrides) {
    const pair = `${item.bookingId}\n${item.field}`
    if (seen.has(pair)) problems.push('duplicate')
    seen.add(pair)
    if (!OVERRIDE_FIELDS.has(item.field)) {
      problems.push('field')
      continue
    }
    if (!bookingIds.has(item.bookingId)) problems.push('booking')
    if (item.reason.trim().length < 3 || item.reason.length > 500) problems.push('reason')
    if (!overrideValueFits(item.field, item.value)) problems.push('value')
  }
  return problems
}

function overrideValueFits(field: string, value: string): boolean {
  if (field === 'fullName') return value.trim().length >= 1 && value.length <= 250
  if (field === 'roomType') return value === 'SGL' || value === 'DBL'
  if (field === 'arrivalDate' || field === 'departureDate') return isCalendarDate(value)
  if (field === 'arrivalTime' || field === 'departureTime') return isClockTime(value)
  if (field === 'arrivalFlight' || field === 'departureFlight') return /^[A-Z0-9-]{1,10}$/i.test(value)
  return false
}

function isCalendarDate(value: string): boolean {
  const matched = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value)
  if (!matched) return false
  const day = Number(matched[1])
  const month = Number(matched[2])
  const year = Number(matched[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function isClockTime(value: string): boolean {
  const matched = /^(\d{2}):(\d{2})$/.exec(value)
  if (!matched) return false
  return Number(matched[1]) <= 23 && Number(matched[2]) <= 59
}

export function applyOverrides(
  rows: readonly PublicLetterRow[],
  overrides: readonly { bookingId: string; field: string; value: string }[],
): PublicLetterRow[] {
  const allowed = new Set(['fullName', 'arrivalFlight', 'arrivalDate', 'arrivalTime', 'departureFlight', 'departureDate', 'departureTime', 'roomType'])
  return rows.map((row) => {
    const relevant = overrides.filter((item) => item.bookingId === row.bookingId && allowed.has(item.field))
    if (relevant.length === 0) return { ...row, changedFields: [...row.changedFields], manualFields: [...row.manualFields] }
    const next: PublicLetterRow = { ...row, changedFields: [...row.changedFields], manualFields: [...row.manualFields] }
    for (const item of relevant) {
      if (item.field === 'fullName') next.fullName = item.value
      if (item.field === 'arrivalFlight') next.arrivalFlight = item.value
      if (item.field === 'arrivalDate') next.arrivalDate = item.value
      if (item.field === 'arrivalTime') next.arrivalTime = item.value
      if (item.field === 'departureFlight') next.departureFlight = item.value
      if (item.field === 'departureDate') next.departureDate = item.value
      if (item.field === 'departureTime') next.departureTime = item.value
      if (item.field === 'roomType') next.roomType = item.value
      if (!next.manualFields.includes(item.field)) next.manualFields.push(item.field)
    }
    return next
  })
}

export function pickTemplateKey(kinds: readonly string[]): 'adjustment' | 'new_booking' | 'cancellation' {
  if (kinds.length === 0) return 'adjustment'
  if (kinds.every((kind) => kind === 'added')) return 'new_booking'
  if (kinds.every((kind) => kind === 'cancelled')) return 'cancellation'
  return 'adjustment'
}
