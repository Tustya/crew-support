import { describe, expect, it } from 'vitest'
import { letterRows, roomPairsOf } from './email'
import { defaultColumns } from './templates'
import type { Booking } from './types'

function guest(id: string, fullName: string, roomType: Booking['roomType']): Booking {
  return {
    id,
    crewId: `crew-${id}`,
    fullName,
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
    gender: 'M',
    recordStatus: 'active',
  }
}

describe('строки письма по номерам', () => {
  const bookings = [guest('a', 'Яковлев', 'DBL'), guest('b', 'Борисов', 'SGL'), guest('c', 'Волков', 'DBL'), guest('d', 'Андреев', 'DBL')]

  it('держит соседей по номеру рядом и подписывает тип номера', () => {
    const rows = letterRows({ latest: bookings, baseline: bookings, columns: defaultColumns(), keptPairs: [['a', 'd']] })
    expect(rows.map((row) => [row.bookingId, row.roomLabel])).toEqual([
      ['d', 'Дабл'],
      ['a', 'Дабл'],
      ['b', 'Сингл'],
      ['c', 'Дабл'],
    ])
    expect(rows[0]?.roomKey).toBe(rows[1]?.roomKey)
    expect(roomPairsOf(rows)).toEqual([['a', 'd']])
  })
})
