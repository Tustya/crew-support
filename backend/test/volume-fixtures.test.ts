import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'
import { normalizeAviabitTable, type NormalizedAviabitRow } from '../src/domain/aviabit.ts'
import { diffBookings, type CanonicalBooking, type ChangeKind } from '../src/domain/diff.ts'
import { readFirstSheet } from '../src/domain/xlsx.ts'

const HOTELS = new Set(['angel', 'bereg', 'south', 'north'])

test('volume workbooks hold 300 valid rows and walk every change kind', async () => {
  const directory = new URL('../fixtures/volume/', import.meta.url)
  const names = (await readdir(directory)).filter((name) => name.endsWith('.xlsx')).sort()
  assert.deepEqual(names, [
    '01-baseline.xlsx',
    '02-arrival.xlsx',
    '03-departure.xlsx',
    '04-flight.xlsx',
    '05-room.xlsx',
    '06-cancel-and-new.xlsx',
    '07-hotel.xlsx',
    '08-stay-date.xlsx',
    '09-second-wave.xlsx',
    '10-all-kinds.xlsx',
  ])
  const snapshots = await Promise.all(names.map(async (name) => load(new URL(name, directory))))
  const counts = snapshots.map((rows, index) => diffCount(snapshots[index - 1] ?? [], rows))
  assert.deepEqual(counts[1], { arrival: 50 })
  assert.deepEqual(counts[2], { departure: 50 })
  assert.deepEqual(counts[3], { flight: 50 })
  assert.deepEqual(counts[4], { room: 50 })
  assert.deepEqual(counts[5], { cancelled: 30, added: 30 })
  assert.deepEqual(counts[6], { hotel_change: 60 })
  assert.deepEqual(counts[7], { date_change: 60 })
  assert.deepEqual(counts[8], { arrival: 50, room: 10 })
  assert.deepEqual(counts[9], { arrival: 40, departure: 40, flight: 40, room: 40, cancelled: 20, added: 20, hotel_change: 50, date_change: 50 })
})

async function load(url: URL): Promise<CanonicalBooking[]> {
  const rows = normalizeAviabitTable(readFirstSheet(await readFile(url)))
  assert.equal(rows.length, 300, url.pathname)
  const seen = new Set<string>()
  return rows.map((row) => {
    assert.deepEqual(row.issues, [], `${row.sourceBookingId}: ${row.issues.join(',')}`)
    assert.ok(row.sourceBookingId && !seen.has(row.sourceBookingId))
    seen.add(row.sourceBookingId)
    assert.ok(row.sourceHotelId && HOTELS.has(row.sourceHotelId))
    assert.ok(row.gender && row.roomType && (row.localStayDate ?? row.arrivalLocalDate))
    return toBooking(row)
  })
}

function toBooking(row: NormalizedAviabitRow): CanonicalBooking {
  return {
    id: row.sourceBookingId,
    crewId: row.sourceCrewId,
    hotelId: row.sourceHotelId,
    airportCode: row.airportCode,
    stayDate: row.localStayDate ?? row.arrivalLocalDate,
    fullName: row.fullNameSource,
    position: row.position,
    gender: row.gender,
    arrivalFlight: row.arrivalFlight,
    arrivalLocalDate: row.arrivalLocalDate,
    arrivalLocalTime: row.arrivalLocalTime,
    departureFlight: row.departureFlight,
    departureLocalDate: row.departureLocalDate,
    departureLocalTime: row.departureLocalTime,
    roomType: row.roomType,
    recordStatus: 'active',
    replacementOf: null,
  }
}

function diffCount(before: CanonicalBooking[], after: CanonicalBooking[]): Partial<Record<ChangeKind, number>> {
  const diff = diffBookings({ before, after, completeness: 'full' })
  assert.equal(diff.ambiguous, false)
  const counts: Partial<Record<ChangeKind, number>> = {}
  for (const event of diff.events) counts[event.kind] = (counts[event.kind] ?? 0) + 1
  return counts
}
