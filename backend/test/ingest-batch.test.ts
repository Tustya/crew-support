import assert from 'node:assert/strict'
import test from 'node:test'
import type { CanonicalBooking } from '../src/domain/diff.ts'
import type { SampleBookingInput } from '../src/fixtures/sample.ts'
import { applyTimers, insertBookings } from '../src/services/ingest.ts'

function booking(index: number): CanonicalBooking {
  return {
    id: `b-${index}`,
    crewId: null,
    hotelId: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    airportCode: 'SVX',
    stayDate: '2026-10-20',
    fullName: `Crew ${index}`,
    position: null,
    gender: 'M',
    arrivalFlight: '100',
    arrivalLocalDate: '2026-10-20',
    arrivalLocalTime: '12:00',
    departureFlight: '200',
    departureLocalDate: '2026-10-21',
    departureLocalTime: '08:00',
    roomType: 'SGL',
    recordStatus: 'active',
    replacementOf: null,
  }
}

function source(index: number): SampleBookingInput {
  const row = booking(index)
  return {
    sourceBookingId: row.id,
    sourceCrewId: null,
    sourceHotelId: String(index),
    airportCode: row.airportCode,
    stayDate: row.stayDate,
    fullName: row.fullName,
    position: null,
    gender: 'M',
    arrivalFlight: row.arrivalFlight,
    arrivalLocalDate: row.arrivalLocalDate,
    arrivalLocalTime: row.arrivalLocalTime,
    departureFlight: row.departureFlight,
    departureLocalDate: row.departureLocalDate,
    departureLocalTime: row.departureLocalTime,
    roomType: 'SGL',
    recordStatus: 'active',
    replacementOf: null,
  }
}

test('five thousand bookings are inserted in chunks', async () => {
  const statements: string[] = []
  const client = {
    async query(sql: string) {
      statements.push(sql)
      return { rows: [] }
    },
  }
  const count = 5000
  await insertBookings(client as never, '00000000-0000-0000-0000-000000000001', Array.from({ length: count }, (_, index) => booking(index)), Array.from({ length: count }, (_, index) => source(index)))
  const inserts = statements.filter((sql) => sql.includes('INSERT INTO snapshot_bookings'))
  assert.ok(inserts.length < count)
  assert.equal(inserts.length, 13)
})

test('timer updates are batched by group instead of one statement per group', async () => {
  const statements: string[] = []
  const count = 800
  const client = {
    async query(sql: string) {
      statements.push(sql)
      if (sql.includes('app_settings')) return { rows: [{ quiet_minutes: 60 }] }
      if (sql.includes('notification_baselines')) return { rows: [] }
      if (sql.includes('FROM work_groups')) return { rows: [] }
      return { rows: [] }
    },
  }
  await applyTimers(client as never, Array.from({ length: count }, (_, index) => booking(index)), '2026-10-20T11:00:00.000Z')
  const updates = statements.filter((sql) => sql.startsWith('UPDATE work_groups'))
  assert.ok(updates.length < count)
  assert.equal(updates.length, 2)
})
