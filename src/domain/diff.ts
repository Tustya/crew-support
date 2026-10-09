import type { Booking, ChangeEvent, ChangeKind, FieldDelta, Snapshot } from './types'

const FIELD_LABELS: Record<string, string> = {
  fullName: 'ФИО',
  arrivalFlight: 'Рейс прибытия',
  arrivalLocalDate: 'Дата прилёта',
  arrivalLocalTime: 'Время прилёта',
  departureFlight: 'Рейс вылета',
  departureLocalDate: 'Дата вылета',
  departureLocalTime: 'Время вылета',
  roomType: 'Тип номера',
  hotelId: 'Гостиница',
  localStayDate: 'Дата размещения',
  recordStatus: 'Состояние заявки',
}

export function groupKeyOf(booking: Pick<Booking, 'hotelId' | 'airportCode' | 'localStayDate'>): string {
  return `${booking.hotelId}|${booking.airportCode}|${booking.localStayDate}`
}

export function bookingFingerprint(booking: Booking): string {
  return [
    booking.id,
    booking.crewId,
    booking.fullName,
    booking.hotelId,
    booking.airportCode,
    booking.localStayDate,
    booking.arrivalFlight,
    booking.arrivalLocalDate,
    booking.arrivalLocalTime,
    booking.departureFlight,
    booking.departureLocalDate,
    booking.departureLocalTime,
    booking.roomType,
    booking.recordStatus,
  ].join('~')
}

export function fingerprintBookings(bookings: Booking[]): string {
  return bookings.map(bookingFingerprint).sort().join('|')
}

function delta(field: string, before: string, after: string): FieldDelta | null {
  if (before === after) return null
  return { field, label: FIELD_LABELS[field] ?? field, before, after }
}

function collect(pairs: Array<[string, string, string]>): FieldDelta[] {
  return pairs.flatMap(([field, before, after]) => {
    const change = delta(field, before, after)
    return change ? [change] : []
  })
}

function eventId(toSnapshotId: string, bookingId: string, kind: ChangeKind, groupKey: string): string {
  return `${toSnapshotId}|${bookingId}|${kind}|${groupKey}`
}

interface DiffInput {
  before: Booking[]
  after: Booking[]
  detectedAt: string
  fromSnapshotId: string
  toSnapshotId: string
}

export function diffBookings(input: DiffInput): ChangeEvent[] {
  const beforeById = new Map(input.before.map((booking) => [booking.id, booking]))
  const afterById = new Map(input.after.map((booking) => [booking.id, booking]))
  const events: ChangeEvent[] = []

  const push = (event: ChangeEvent) => {
    events.push(event)
  }

  for (const afterBooking of input.after) {
    const previous = beforeById.get(afterBooking.id)
    if (!previous) {
      push(buildAdded(afterBooking, input))
      continue
    }
    if (previous.hotelId !== afterBooking.hotelId || previous.airportCode !== afterBooking.airportCode) {
      push(buildMove(previous, afterBooking, input, 'hotel_change', groupKeyOf(previous), groupKeyOf(afterBooking)))
      push(buildMove(previous, afterBooking, input, 'hotel_change', groupKeyOf(afterBooking), groupKeyOf(previous)))
      continue
    }
    if (previous.localStayDate !== afterBooking.localStayDate) {
      push(buildMove(previous, afterBooking, input, 'date_change', groupKeyOf(previous), groupKeyOf(afterBooking)))
      push(buildMove(previous, afterBooking, input, 'date_change', groupKeyOf(afterBooking), groupKeyOf(previous)))
      continue
    }
    if (previous.recordStatus !== 'cancelled' && afterBooking.recordStatus === 'cancelled') {
      push(buildCancelled(previous, afterBooking, input))
      continue
    }
    pushCategory(previous, afterBooking, input, events)
  }

  for (const previous of input.before) {
    if (!afterById.has(previous.id) && previous.recordStatus !== 'cancelled') {
      push(buildMissing(previous, input))
    }
  }

  const replacementByOldId = new Map<string, string>()
  for (const event of events) {
    const replacedId = event.afterBooking?.replacementOf
    if (event.kind === 'added' && replacedId) {
      event.replacementId = `repl-${replacedId}`
      replacementByOldId.set(replacedId, event.replacementId)
    }
  }
  for (const event of events) {
    const replacementId = replacementByOldId.get(event.bookingId)
    if (event.kind === 'cancelled' && replacementId) event.replacementId = replacementId
  }
  return events
}

function buildAdded(booking: Booking, input: DiffInput): ChangeEvent {
  const groupKey = groupKeyOf(booking)
  return {
    id: eventId(input.toSnapshotId, booking.id, 'added', groupKey),
    bookingId: booking.id,
    crewId: booking.crewId,
    fullName: booking.fullName,
    groupKey,
    kind: 'added',
    fields: personFields(null, booking),
    beforeBooking: null,
    afterBooking: booking,
    detectedAt: input.detectedAt,
    fromSnapshotId: input.fromSnapshotId,
    toSnapshotId: input.toSnapshotId,
  }
}

function buildCancelled(previous: Booking, afterBooking: Booking, input: DiffInput): ChangeEvent {
  const groupKey = groupKeyOf(previous)
  return {
    id: eventId(input.toSnapshotId, previous.id, 'cancelled', groupKey),
    bookingId: previous.id,
    crewId: previous.crewId,
    fullName: previous.fullName,
    groupKey,
    kind: 'cancelled',
    fields: personFields(previous, afterBooking),
    beforeBooking: previous,
    afterBooking,
    detectedAt: input.detectedAt,
    fromSnapshotId: input.fromSnapshotId,
    toSnapshotId: input.toSnapshotId,
  }
}

function buildMissing(previous: Booking, input: DiffInput): ChangeEvent {
  const groupKey = groupKeyOf(previous)
  return {
    id: eventId(input.toSnapshotId, previous.id, 'cancelled', groupKey),
    bookingId: previous.id,
    crewId: previous.crewId,
    fullName: previous.fullName,
    groupKey,
    kind: 'cancelled',
    fields: [{ field: 'recordStatus', label: 'Состояние заявки', before: 'активна', after: 'отмена' }],
    beforeBooking: previous,
    afterBooking: null,
    detectedAt: input.detectedAt,
    fromSnapshotId: input.fromSnapshotId,
    toSnapshotId: input.toSnapshotId,
  }
}

function buildMove(
  previous: Booking,
  afterBooking: Booking,
  input: DiffInput,
  kind: 'hotel_change' | 'date_change',
  groupKey: string,
  linkedGroupKey: string,
): ChangeEvent {
  return {
    id: eventId(input.toSnapshotId, previous.id, kind, groupKey),
    bookingId: previous.id,
    crewId: afterBooking.crewId,
    fullName: afterBooking.fullName,
    groupKey,
    linkedGroupKey,
    replacementId: `move-${previous.id}`,
    kind,
    fields: personFields(previous, afterBooking),
    beforeBooking: previous,
    afterBooking,
    detectedAt: input.detectedAt,
    fromSnapshotId: input.fromSnapshotId,
    toSnapshotId: input.toSnapshotId,
  }
}

function pushCategory(previous: Booking, afterBooking: Booking, input: DiffInput, events: ChangeEvent[]): void {
  const categories: Array<{ kind: ChangeKind; fields: FieldDelta[] }> = [
    {
      kind: 'arrival',
      fields: collect([
        ['arrivalLocalDate', previous.arrivalLocalDate, afterBooking.arrivalLocalDate],
        ['arrivalLocalTime', previous.arrivalLocalTime, afterBooking.arrivalLocalTime],
      ]),
    },
    {
      kind: 'departure',
      fields: collect([
        ['departureLocalDate', previous.departureLocalDate, afterBooking.departureLocalDate],
        ['departureLocalTime', previous.departureLocalTime, afterBooking.departureLocalTime],
      ]),
    },
    {
      kind: 'flight',
      fields: collect([
        ['arrivalFlight', previous.arrivalFlight, afterBooking.arrivalFlight],
        ['departureFlight', previous.departureFlight, afterBooking.departureFlight],
      ]),
    },
    {
      kind: 'room',
      fields: collect([['roomType', previous.roomType, afterBooking.roomType]]),
    },
  ]
  for (const category of categories) {
    if (category.fields.length === 0) continue
    const groupKey = groupKeyOf(afterBooking)
    events.push({
      id: eventId(input.toSnapshotId, afterBooking.id, category.kind, groupKey),
      bookingId: afterBooking.id,
      crewId: afterBooking.crewId,
      fullName: afterBooking.fullName,
      groupKey,
      kind: category.kind,
      fields: category.fields,
      beforeBooking: previous,
      afterBooking,
      detectedAt: input.detectedAt,
      fromSnapshotId: input.fromSnapshotId,
      toSnapshotId: input.toSnapshotId,
    })
  }
}

function personFields(before: Booking | null, after: Booking): FieldDelta[] {
  const left = before
  return collect([
    ['fullName', left?.fullName ?? '', after.fullName],
    ['arrivalFlight', left?.arrivalFlight ?? '', after.arrivalFlight],
    ['arrivalLocalDate', left?.arrivalLocalDate ?? '', after.arrivalLocalDate],
    ['arrivalLocalTime', left?.arrivalLocalTime ?? '', after.arrivalLocalTime],
    ['departureFlight', left?.departureFlight ?? '', after.departureFlight],
    ['departureLocalDate', left?.departureLocalDate ?? '', after.departureLocalDate],
    ['departureLocalTime', left?.departureLocalTime ?? '', after.departureLocalTime],
    ['roomType', left?.roomType ?? '', after.roomType],
    ['hotelId', left?.hotelId ?? '', after.hotelId],
    ['localStayDate', left?.localStayDate ?? '', after.localStayDate],
    ['recordStatus', left?.recordStatus ?? '', after.recordStatus],
  ])
}

export function replayDiffs(snapshots: Snapshot[]): ChangeEvent[] {
  const ordered = [...snapshots].sort((left, right) => left.sequence - right.sequence)
  const events: ChangeEvent[] = []
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]
    const current = ordered[index]
    if (previous.seriesId !== current.seriesId) continue
    events.push(
      ...diffBookings({
        before: previous.bookings,
        after: current.bookings,
        detectedAt: current.fetchedAt,
        fromSnapshotId: previous.id,
        toSnapshotId: current.id,
      }),
    )
  }
  return events
}

export function groupBookings(bookings: Booking[]): Map<string, Booking[]> {
  const grouped = new Map<string, Booking[]>()
  for (const booking of bookings) {
    const key = groupKeyOf(booking)
    const list = grouped.get(key)
    if (list) list.push(booking)
    else grouped.set(key, [booking])
  }
  return grouped
}

export function linkCrossGroupMoves(events: ChangeEvent[]): ChangeEvent[] {
  const byBookingId = new Map<string, ChangeEvent[]>()
  for (const event of events) {
    const list = byBookingId.get(event.bookingId)
    if (list) list.push(event)
    else byBookingId.set(event.bookingId, [event])
  }
  for (const [bookingId, list] of byBookingId) {
    const groupKeys = [...new Set(list.map((event) => event.groupKey))]
    if (groupKeys.length < 2) continue
    const before = list.find((event) => event.beforeBooking)?.beforeBooking
    const after = list.find((event) => event.afterBooking)?.afterBooking
    const kind: ChangeKind =
      before && after && (before.hotelId !== after.hotelId || before.airportCode !== after.airportCode)
        ? 'hotel_change'
        : 'date_change'
    for (const event of list) {
      event.kind = kind
      event.linkedGroupKey = groupKeys.find((key) => key !== event.groupKey)
      event.replacementId = `move-${bookingId}`
      event.id = `${event.toSnapshotId}|${bookingId}|${kind}|${event.groupKey}`
    }
  }
  return events
}

export function applyDetectedTimes(events: ChangeEvent[], history: ChangeEvent[]): ChangeEvent[] {
  const detectedAtById = new Map<string, string>()
  for (const event of history) {
    detectedAtById.set(`${event.bookingId}|${event.kind}|${event.groupKey}`, event.detectedAt)
  }
  return events.map((event) => {
    const detectedAt = detectedAtById.get(`${event.bookingId}|${event.kind}|${event.groupKey}`)
    return detectedAt ? { ...event, detectedAt } : event
  })
}
