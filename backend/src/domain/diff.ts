import { stableStringify } from './hash.ts'
import { matchByIdentity } from './identity.ts'

export type ChangeKind = 'added' | 'cancelled' | 'arrival' | 'departure' | 'flight' | 'room' | 'hotel_change' | 'date_change'

export interface CanonicalBooking {
  id: string | null
  crewId: string | null
  hotelId: string | null
  airportCode: string
  stayDate: string | null
  fullName: string
  position: string | null
  gender: 'M' | 'F' | null
  arrivalFlight: string
  arrivalLocalDate: string
  arrivalLocalTime: string
  departureFlight: string
  departureLocalDate: string
  departureLocalTime: string
  roomType: 'SGL' | 'DBL' | null
  recordStatus: 'active' | 'cancelled'
  replacementOf: string | null
}

export interface ChangeEvent {
  entityKey: string
  groupKey: string
  linkedGroupKey: string | null
  linkKey: string | null
  kind: ChangeKind
  before: CanonicalBooking | null
  after: CanonicalBooking | null
  changedFields: string[]
}

export interface DiffResult {
  events: ChangeEvent[]
  unresolvedAbsences: string[]
  ambiguous: boolean
}

export function groupKeyOf(booking: Pick<CanonicalBooking, 'hotelId' | 'airportCode' | 'stayDate'>): string | null {
  if (!booking.hotelId || !booking.stayDate) return null
  return `${booking.hotelId}|${booking.airportCode}|${booking.stayDate}`
}

export function contentKeyOf(booking: CanonicalBooking): string {
  return stableStringify({
    fullName: booking.fullName,
    position: booking.position,
    gender: booking.gender,
    airportCode: booking.airportCode,
    stayDate: booking.stayDate,
    hotelId: booking.hotelId,
    arrivalFlight: booking.arrivalFlight,
    arrivalLocalDate: booking.arrivalLocalDate,
    arrivalLocalTime: booking.arrivalLocalTime,
    departureFlight: booking.departureFlight,
    departureLocalDate: booking.departureLocalDate,
    departureLocalTime: booking.departureLocalTime,
    roomType: booking.roomType,
    recordStatus: booking.recordStatus,
    replacementOf: booking.replacementOf,
  })
}

function changed(before: string, after: string): boolean {
  return before !== after
}

function fields(pairs: Array<[string, string, string]>): string[] {
  return pairs.flatMap(([field, before, after]) => (changed(before, after) ? [field] : []))
}

function entityKey(booking: CanonicalBooking): string {
  return booking.id ?? `content:${contentKeyOf(booking)}`
}

export function diffBookings(input: {
  before: readonly CanonicalBooking[]
  after: readonly CanonicalBooking[]
  completeness: 'full' | 'unknown'
}): DiffResult {
  const matched = matchByIdentity(input.before, input.after, (booking) => booking.id, contentKeyOf)
  if (matched.ambiguous) return { events: [], unresolvedAbsences: [], ambiguous: true }

  const events: ChangeEvent[] = []
  const unresolvedAbsences: string[] = []
  for (const booking of matched.added) {
    const groupKey = groupKeyOf(booking)
    if (!groupKey) continue
    events.push({
      entityKey: entityKey(booking),
      groupKey,
      linkedGroupKey: null,
      linkKey: booking.replacementOf ? `repl-${booking.replacementOf}` : null,
      kind: 'added',
      before: null,
      after: booking,
      changedFields: ['fullName', 'arrivalFlight', 'arrivalLocalDate', 'arrivalLocalTime', 'departureFlight', 'departureLocalDate', 'departureLocalTime', 'roomType'],
    })
  }

  const removed = input.completeness === 'full' ? matched.removed : []
  if (input.completeness !== 'full') {
    for (const booking of matched.removed) unresolvedAbsences.push(entityKey(booking))
  }
  for (const booking of removed) {
    if (booking.recordStatus === 'cancelled') continue
    const groupKey = groupKeyOf(booking)
    if (!groupKey) continue
    events.push({
      entityKey: entityKey(booking),
      groupKey,
      linkedGroupKey: null,
      linkKey: null,
      kind: 'cancelled',
      before: booking,
      after: null,
      changedFields: ['recordStatus'],
    })
  }

  for (const pair of matched.pairs) {
    pushPair(pair.before, pair.after, events)
  }
  linkReplacements(events)
  return { events, unresolvedAbsences, ambiguous: false }
}

function pushPair(previous: CanonicalBooking, next: CanonicalBooking, events: ChangeEvent[]): void {
  const previousKey = groupKeyOf(previous)
  const nextKey = groupKeyOf(next)
  if (previous.hotelId !== next.hotelId || previous.airportCode !== next.airportCode) {
    pushMove(previous, next, previousKey, nextKey, 'hotel_change', events)
    return
  }
  if (previous.stayDate !== next.stayDate) {
    pushMove(previous, next, previousKey, nextKey, 'date_change', events)
    return
  }
  if (!nextKey) return
  if (previous.recordStatus !== 'cancelled' && next.recordStatus === 'cancelled') {
    events.push({
      entityKey: entityKey(previous),
      groupKey: nextKey,
      linkedGroupKey: null,
      linkKey: null,
      kind: 'cancelled',
      before: previous,
      after: next,
      changedFields: ['recordStatus'],
    })
    return
  }
  const categories: Array<{ kind: ChangeKind; changedFields: string[] }> = [
    {
      kind: 'arrival',
      changedFields: fields([
        ['arrivalLocalDate', previous.arrivalLocalDate, next.arrivalLocalDate],
        ['arrivalLocalTime', previous.arrivalLocalTime, next.arrivalLocalTime],
      ]),
    },
    {
      kind: 'departure',
      changedFields: fields([
        ['departureLocalDate', previous.departureLocalDate, next.departureLocalDate],
        ['departureLocalTime', previous.departureLocalTime, next.departureLocalTime],
      ]),
    },
    {
      kind: 'flight',
      changedFields: fields([
        ['arrivalFlight', previous.arrivalFlight, next.arrivalFlight],
        ['departureFlight', previous.departureFlight, next.departureFlight],
      ]),
    },
    {
      kind: 'room',
      changedFields: fields([
        ['roomType', previous.roomType ?? '', next.roomType ?? ''],
        ['gender', previous.gender ?? '', next.gender ?? ''],
      ]),
    },
  ]
  for (const category of categories) {
    if (category.changedFields.length === 0) continue
    events.push({
      entityKey: entityKey(next),
      groupKey: nextKey,
      linkedGroupKey: null,
      linkKey: null,
      kind: category.kind,
      before: previous,
      after: next,
      changedFields: category.changedFields.filter((field) => field !== 'gender'),
    })
  }
}

function pushMove(
  previous: CanonicalBooking,
  next: CanonicalBooking,
  previousKey: string | null,
  nextKey: string | null,
  kind: 'hotel_change' | 'date_change',
  events: ChangeEvent[],
): void {
  const linkKey = `move-${entityKey(previous)}`
  const changedFields = fields([
    ['hotelId', previous.hotelId ?? '', next.hotelId ?? ''],
    ['airportCode', previous.airportCode, next.airportCode],
    ['stayDate', previous.stayDate ?? '', next.stayDate ?? ''],
    ['arrivalLocalTime', previous.arrivalLocalTime, next.arrivalLocalTime],
    ['departureLocalTime', previous.departureLocalTime, next.departureLocalTime],
  ])
  if (previousKey) {
    events.push({
      entityKey: entityKey(previous),
      groupKey: previousKey,
      linkedGroupKey: nextKey,
      linkKey,
      kind,
      before: previous,
      after: next,
      changedFields,
    })
  }
  if (nextKey) {
    events.push({
      entityKey: entityKey(next),
      groupKey: nextKey,
      linkedGroupKey: previousKey,
      linkKey,
      kind,
      before: previous,
      after: next,
      changedFields,
    })
  }
}

function linkReplacements(events: ChangeEvent[]): void {
  const replacementByOldId = new Map<string, string>()
  for (const event of events) {
    const replacedId = event.after?.replacementOf
    if (event.kind === 'added' && replacedId) replacementByOldId.set(replacedId, event.linkKey ?? `repl-${replacedId}`)
  }
  for (const event of events) {
    const linkKey = replacementByOldId.get(event.entityKey)
    if (event.kind === 'cancelled' && linkKey) event.linkKey = linkKey
  }
}

export function bookingsFingerprint(bookings: readonly CanonicalBooking[]): string {
  return stableStringify([...bookings].map(contentKeyOf).sort())
}
