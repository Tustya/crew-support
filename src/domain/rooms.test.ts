import { describe, expect, it } from 'vitest'
import { assignRooms, roomPairs } from './rooms'
import type { Booking } from './types'

function guest(id: string, roomType: Booking['roomType'] = 'DBL', patch: Partial<Booking> = {}): Booking {
  return {
    id,
    crewId: `crew-${id}`,
    fullName: `Гость ${id}`,
    hotelId: 'hotel-angel',
    airportCode: 'SVX',
    localStayDate: '2026-10-09',
    arrivalFlight: 'CS101',
    arrivalLocalDate: '2026-10-09',
    arrivalLocalTime: '14:20',
    departureFlight: 'CS201',
    departureLocalDate: '2026-10-10',
    departureLocalTime: '08:10',
    roomType,
    recordStatus: 'active',
    ...patch,
  }
}

function members(bookings: Booking[], keptPairs: string[][] = []): string[][] {
  return assignRooms(bookings, keptPairs).map((room) => room.bookingIds)
}

describe('раскладка по номерам', () => {
  it('четыре дабла дают две пары в порядке табельного номера', () => {
    expect(members([guest('d'), guest('b'), guest('c'), guest('a')])).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('сохранённые пары не меняют соседей при повторной раскладке', () => {
    const bookings = [guest('a'), guest('b'), guest('c'), guest('d')]
    const kept = [['a', 'c'], ['b', 'd']]
    expect(roomPairs(assignRooms(bookings, kept))).toEqual(kept)
  })

  it('новый дабл между соседями по номеру не разбивает пару', () => {
    expect(members([guest('a'), guest('b'), guest('c')], [['a', 'c']])).toEqual([['a', 'c'], ['b']])
  })

  it('уход одного из пары отдаёт второго свободному, другая пара целая', () => {
    const rooms = members([guest('a'), guest('c'), guest('d'), guest('e')], [['a', 'b'], ['c', 'd']])
    expect(rooms).toEqual([['a', 'e'], ['c', 'd']])
  })

  it('нечётный дабл живёт один', () => {
    const rooms = assignRooms([guest('a'), guest('b'), guest('c')], [])
    expect(rooms.map((room) => [room.kind, room.bookingIds])).toEqual([['DBL', ['a', 'b']], ['DBL', ['c']]])
  })

  it('сингл и отменённый в пару не попадают', () => {
    const rooms = assignRooms([guest('a'), guest('b', 'SGL'), guest('c', 'DBL', { recordStatus: 'cancelled' }), guest('d')], [])
    expect(rooms.map((room) => [room.kind, room.bookingIds])).toEqual([['DBL', ['a', 'd']], ['SGL', ['b']], ['DBL', ['c']]])
  })

  it('разные гостиницы не смешиваются', () => {
    const rooms = members([guest('a'), guest('b', 'DBL', { hotelId: 'hotel-neva', airportCode: 'LED' })])
    expect(rooms).toEqual([['a'], ['b']])
  })
})
