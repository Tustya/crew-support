import { groupKeyOf } from './diff'
import type { Booking, RoomType } from './types'

export interface Room {
  key: string
  kind: RoomType
  bookingIds: string[]
}

export function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const item of items) grouped.set(keyOf(item), [...(grouped.get(keyOf(item)) ?? []), item])
  return grouped
}

function bySeniority(left: Booking, right: Booking): number {
  return left.crewId.localeCompare(right.crewId) || left.id.localeCompare(right.id)
}

function chunkPairs<T>(items: T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / 2) }, (_, index) => items.slice(index * 2, index * 2 + 2))
}

function pairDoubles(doubles: Booking[], keptPairs: string[][]): Booking[][] {
  const doublesById = new Map(doubles.map((booking) => [booking.id, booking]))
  const keptRooms = keptPairs
    .map((pair) => pair.map((bookingId) => doublesById.get(bookingId)))
    .filter((pair): pair is Booking[] => pair.length === 2 && pair.every(Boolean) && pair[0]!.id !== pair[1]!.id)
  const pairedIds = new Set(keptRooms.flat().map((booking) => booking.id))
  const freeDoubles = doubles.filter((booking) => !pairedIds.has(booking.id))
  return [...keptRooms, ...chunkPairs(freeDoubles)]
}

function roomsOfGroup(bookings: Booking[], keptPairs: string[][]): Booking[][] {
  const isActiveDouble = (booking: Booking) => booking.recordStatus === 'active' && booking.roomType === 'DBL'
  const doubles = bookings.filter(isActiveDouble)
  const separate = bookings.filter((booking) => !isActiveDouble(booking)).map((booking) => [booking])
  return [...pairDoubles(doubles, keptPairs), ...separate]
}

export function assignRooms(bookings: Booking[], keptPairs: string[][]): Room[] {
  const groups = groupBy([...bookings].sort(bySeniority), groupKeyOf)
  return [...groups.values()]
    .flatMap((groupBookings) => roomsOfGroup(groupBookings, keptPairs))
    .map((occupants) => [...occupants].sort(bySeniority))
    .sort((left, right) => bySeniority(left[0]!, right[0]!))
    .map((occupants) => {
      const kind = occupants[0]!.roomType
      const bookingIds = occupants.map((booking) => booking.id)
      return { key: `${kind}:${bookingIds.join('+')}`, kind, bookingIds }
    })
}

export function roomPairs(rooms: Room[]): string[][] {
  return rooms.filter((room) => room.bookingIds.length === 2).map((room) => room.bookingIds)
}
