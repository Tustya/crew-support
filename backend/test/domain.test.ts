import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeAviabitTable, parseFlight, parseLocalDate, parseLocalTime, locateHeader, ImportSchemaError } from '../src/domain/aviabit.ts'
import { buildCsv } from '../src/domain/csv.ts'
import { diffBookings, type CanonicalBooking } from '../src/domain/diff.ts'
import { indexHotels, resolveHotelMapping } from '../src/domain/hotels.ts'
import { matchByIdentity } from '../src/domain/identity.ts'
import { letterRows } from '../src/domain/letter.ts'
import { baselineBookingsFromPayload, selectConfirmedPayload, type StoredPayload } from '../src/domain/payload.ts'
import { assignRooms } from '../src/domain/rooms.ts'
import { templateProblems, defaultTemplate } from '../src/domain/templates.ts'
import { nextQuietTimer } from '../src/domain/timer.ts'
import { localIsoDate, stayInScope } from '../src/domain/time.ts'
import { assertSafeConfig, DEV_AUTH_PEPPER, readConfig } from '../src/config.ts'
import { assertRuntimeRole } from '../src/db/pool.ts'

function booking(patch: Partial<CanonicalBooking> & Pick<CanonicalBooking, 'id' | 'fullName'>): CanonicalBooking {
  return {
    crewId: patch.id,
    hotelId: 'hotel-a',
    airportCode: 'SVX',
    stayDate: '2026-10-09',
    position: 'Пилот',
    gender: 'M',
    arrivalFlight: '113',
    arrivalLocalDate: '2026-10-09',
    arrivalLocalTime: '12:40',
    departureFlight: '6950',
    departureLocalDate: '2026-10-09',
    departureLocalTime: '18:30',
    roomType: 'SGL',
    recordStatus: 'active',
    replacementOf: null,
    ...patch,
  }
}

test('quiet timer moves dueAt to the latest meaningful change', () => {
  const first = nextQuietTimer(undefined, '2026-10-20T11:00:00.000Z', 60)
  const second = nextQuietTimer(first, '2026-10-20T11:05:00.000Z', 60)
  assert.equal(second.dueAt, '2026-10-20T12:05:00.000Z')
  assert.equal(second.quietStartedAt, first.quietStartedAt)
  assert.equal(second.lastChangeAt, '2026-10-20T11:05:00.000Z')
})

test('local stay date uses the airport timezone', () => {
  const instant = new Date('2026-10-09T20:30:00.000Z')
  assert.equal(localIsoDate(instant, 'Europe/Moscow'), '2026-10-09')
  assert.equal(localIsoDate(instant, 'Asia/Yekaterinburg'), '2026-10-10')
  assert.equal(stayInScope('2026-10-10', 'today', instant, 'Asia/Yekaterinburg'), true)
  assert.equal(stayInScope('2026-10-10', 'today', instant, 'Europe/Moscow'), false)
})

test('stable ids keep namesakes apart and a missing row is a cancellation only for a full snapshot', () => {
  const left = booking({ id: 'a', fullName: 'Смирнов С.С.', arrivalFlight: '113' })
  const right = booking({ id: 'b', fullName: 'Смирнов С.С.', arrivalFlight: '500' })
  const named = diffBookings({ before: [left], after: [left, right], completeness: 'full' })
  assert.equal(named.ambiguous, false)
  assert.equal(named.events.some((event) => event.kind === 'added' && event.entityKey === 'b'), true)
  const incomplete = diffBookings({ before: [left, right], after: [left], completeness: 'unknown' })
  assert.equal(incomplete.events.some((event) => event.kind === 'cancelled'), false)
  assert.deepEqual(incomplete.unresolvedAbsences, ['b'])
})

test('rows without a source id are not paired into a stable identity', () => {
  const before = [booking({ id: null, fullName: 'Смирнов С.С.', arrivalFlight: '113' })]
  const after = [booking({ id: null, fullName: 'Смирнов С.С.', arrivalFlight: '777' })]
  const matched = diffBookings({ before, after, completeness: 'full' })
  assert.equal(matched.ambiguous, true)
  assert.deepEqual(matched.events, [])
  assert.equal(matchByIdentity(before, after, (row) => row.id, (row) => row.fullName).added.length, 0)
})

test('hotel mapping never picks the first hotel at an airport', () => {
  const index = indexHotels([
    { id: 'south', sourceHotelId: 'south', airportCode: 'AER' },
    { id: 'north', sourceHotelId: 'north', airportCode: 'AER' },
  ])
  assert.deepEqual(resolveHotelMapping(index, null, 'AER'), { error: 'HOTEL_MAPPING_AMBIGUOUS' })
  assert.deepEqual(resolveHotelMapping(index, null, 'SVX'), { error: 'HOTEL_MAPPING_MISSING' })
  assert.deepEqual(resolveHotelMapping(index, 'south', 'AER'), { hotelId: 'south' })
})

test('doubles pair inside one gender and the letter does not publish gender', () => {
  const males = ['d1', 'd2', 'd3', 'd4'].map((id) => ({ id, crewId: id, gender: 'M' as const, roomType: 'DBL' as const, recordStatus: 'active' as const }))
  assert.equal(assignRooms(males.slice(0, 2)).filter((room) => room.bookingIds.length === 2).length, 1)
  assert.equal(assignRooms(males.slice(0, 3)).length, 2)
  assert.equal(assignRooms(males).filter((room) => room.bookingIds.length === 2).length, 2)
  const mixed = assignRooms([...males.slice(0, 1), { id: 'f1', crewId: 'f1', gender: 'F', roomType: 'DBL', recordStatus: 'active' }])
  assert.equal(mixed.every((room) => room.bookingIds.length === 1), true)
  const rows = letterRows({
    latest: [booking({ id: 'd1', fullName: 'Орлов О.А.', roomType: 'DBL', gender: 'M' }), booking({ id: 'd2', fullName: 'Орлов О.Б.', roomType: 'DBL', gender: 'M', crewId: 'd2' })],
    baseline: [],
  })
  assert.equal(rows.length, 2)
  assert.equal(rows.every((row) => !('gender' in row)), true)
  assert.equal(JSON.stringify(rows).includes('<'), false)
})

test('a letter room type outside SGL and DBL is rejected', () => {
  const source = booking({ id: 'a', fullName: 'Иванов И.И.' })
  const payload: StoredPayload = {
    bookings: [source],
    roomPairs: [],
    letter: {
      subject: 'Тема',
      greeting: 'Здравствуйте',
      intro: 'Текст',
      closing: 'Конец',
      signature: 'Crew Support',
      columns: [],
      newLabel: 'Новая',
      cancelLabel: 'Отмена',
      templateKey: 'adjustment',
      manualEdits: true,
      rows: [{
        bookingId: 'a',
        fullName: source.fullName,
        arrivalFlight: source.arrivalFlight,
        arrivalDate: '09.10.2026',
        arrivalTime: source.arrivalLocalTime,
        departureFlight: source.departureFlight,
        departureDate: '09.10.2026',
        departureTime: source.departureLocalTime,
        roomType: 'TWIN',
        roomKey: '1',
        roomLabel: 'Твин',
        badge: null,
        changedFields: [],
        manualFields: ['roomType'],
      }],
    },
  }
  assert.throws(() => baselineBookingsFromPayload(payload), /ROOM_TYPE_INVALID/)
})

test('confirmed baseline is the archived letter, not the latest snapshot', () => {
  const archived: StoredPayload = { bookings: [booking({ id: 'a', fullName: 'Иванов И.И.', arrivalLocalTime: '12:40' })], roomPairs: [], letter: null }
  const latest: StoredPayload = { bookings: [booking({ id: 'a', fullName: 'Иванов И.И.', arrivalLocalTime: '19:40' })], roomPairs: [], letter: null }
  assert.equal(selectConfirmedPayload(archived, latest).bookings[0]?.arrivalLocalTime, '12:40')
})

test('aviabit header is found by labels and numeric flights are not coerced', () => {
  const parent = ['Аэропорт', 'Фамилия И.О.', 'Должность', 'Пол', 'Рейс прибытия', 'Локальная дата и время аэропорта прибытия', '', 'Рейс отправления', 'Локальная дата и время аэропорта отправления', '', 'Тип комнаты', 'Время в гостинице']
  const child = ['', '', '', '', '', 'Дата прибытия', 'Время прибытия', '', 'Дата отправления', 'Время отправления', '', '']
  const blank = parent.map(() => '')
  const table = [blank, blank, parent, child, blank, ['Итого', '2'], ['Смена'], ['AER', 'Иванов И.И.', 'Пилот', 'М', '0113', '09.10.2026', '12:40', '6950', 46304, '18:30', 'SGL', '05:50']]
  const located = locateHeader(table.map((row) => row.map((cell) => String(cell))))
  assert.equal(located.headerIndex, 3)
  const rows = normalizeAviabitTable(table)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.arrivalFlight, '0113')
  assert.equal(rows[0]?.departureLocalDate, '2026-10-09')
  assert.equal(rows[0]?.localStayDate, null)
  assert.equal(rows[0]?.sourceBookingId, null)
  assert.equal(parseLocalDate(46304), '2026-10-09')
  assert.equal(parseLocalTime((12 * 60 + 40) / 1440), '12:40')
  assert.equal(parseFlight(113).issue, 'FLIGHT_NUMERIC_AMBIGUOUS')
  const broken = parent.filter((cell) => cell !== 'Тип комнаты')
  assert.throws(() => locateHeader([broken]), ImportSchemaError)
})

test('csv neutralizes spreadsheet formulas and unknown template tokens are rejected', () => {
  const csv = buildCsv(['actor'], [['=SUM(A1)']])
  assert.match(csv, /'=SUM\(A1\)/)
  const template = defaultTemplate('adjustment')
  template.blocks[0] = { kind: 'subject', text: 'Привет {password}' }
  assert.equal(templateProblems(template).some((problem) => problem.includes('{password}')), true)
})

test('production refuses a superuser database role', async () => {
  const superuser = { query: async () => ({ rows: [{ rolsuper: true }] }) }
  await assert.rejects(() => assertRuntimeRole(superuser, 'production'), /DB_SUPERUSER_FORBIDDEN/)
  await assertRuntimeRole({ query: async () => ({ rows: [{ rolsuper: false }] }) }, 'production')
  await assertRuntimeRole(superuser, 'development')
})

test('production boots fail-closed', () => {
  assert.throws(() => readConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://crew:crew@127.0.0.1/db', AUTH_MODE: 'mock' }))
  assert.throws(() => readConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://app@db/app', AUTH_MODE: 'password', AUTH_PEPPER: 'short' }))
  assert.throws(() => readConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://app@db/app', AUTH_MODE: 'password', AUTH_PEPPER: DEV_AUTH_PEPPER }))
  const password = readConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://app@db/app', AUTH_MODE: 'password', AUTH_PEPPER: 'production-pepper-0123456789abcdef' })
  assert.equal(password.authMode, 'password')
  assert.equal(password.cookieSecure, true)
  assert.throws(() => assertSafeConfig({
    nodeEnv: 'production',
    databaseUrl: 'postgres://app@db/app',
    authMode: 'disabled',
    authPepper: '',
    cookieSecure: true,
    sourceAdapter: 'sample',
    mailAdapter: 'disabled',
    host: '127.0.0.1',
    port: 8080,
    bodyLimitBytes: 100,
    importLimitBytes: 100,
    allowedOrigins: [],
    schedulerEnabled: false,
    allowSyntheticRecipients: false,
    unknownAfterSeconds: 120,
    rateLimitPerMinute: 10,
    now: () => new Date(),
  }))
})
