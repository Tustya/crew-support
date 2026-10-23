import type { CanonicalBooking } from './diff.ts'
import type { LetterPayload } from './letter.ts'

export interface StoredPayload {
  bookings: CanonicalBooking[]
  roomPairs: string[][]
  letter: LetterPayload | null
}

export function selectConfirmedPayload(archivedPayload: StoredPayload, latestPayload: StoredPayload | null): StoredPayload {
  if (latestPayload && archivedPayload === latestPayload) return archivedPayload
  return archivedPayload
}

function letterRoomType(value: string): 'SGL' | 'DBL' {
  if (value === 'SGL' || value === 'DBL') return value
  throw new Error('ROOM_TYPE_INVALID')
}

function isoFromDisplayDate(value: string): string {
  const matched = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value)
  if (!matched) return value
  return `${matched[3]}-${matched[2]}-${matched[1]}`
}

export function baselineBookingsFromPayload(payload: StoredPayload): CanonicalBooking[] {
  if (!payload.letter) return payload.bookings.filter((booking) => booking.recordStatus !== 'cancelled')
  const byId = new Map(payload.bookings.map((booking) => [booking.id, booking]))
  const bookings: CanonicalBooking[] = []
  for (const row of payload.letter.rows) {
    if (row.badge === 'cancel' || !row.bookingId) continue
    const source = byId.get(row.bookingId)
    if (!source) continue
    bookings.push({
      ...source,
      fullName: row.fullName,
      arrivalFlight: row.arrivalFlight,
      arrivalLocalDate: isoFromDisplayDate(row.arrivalDate),
      arrivalLocalTime: row.arrivalTime,
      departureFlight: row.departureFlight,
      departureLocalDate: isoFromDisplayDate(row.departureDate),
      departureLocalTime: row.departureTime,
      roomType: letterRoomType(row.roomType),
      recordStatus: 'active',
    })
  }
  return bookings
}
