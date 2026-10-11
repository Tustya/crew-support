import { describe, expect, it } from 'vitest'
import { diffBookings } from './diff'
import { prepareDueGroups } from './flow'
import { patchLatest } from './flow'
import { defaultSettings } from './templates'
import { selectGroups } from './view'
import { addMinutes } from './time'
import { loadScenario } from '../fixtures/scenarios'
import type { Booking } from './types'

const settings = defaultSettings()

function booking(patch: Partial<Booking> = {}): Booking {
  return {
    id: 'b1',
    crewId: 'c1',
    fullName: 'Соколова Мария Андреевна',
    hotelId: 'hotel-angel',
    airportCode: 'SVX',
    localStayDate: '2026-10-09',
    arrivalFlight: 'CS101',
    arrivalLocalDate: '2026-10-09',
    arrivalLocalTime: '14:20',
    departureFlight: 'CS201',
    departureLocalDate: '2026-10-09',
    departureLocalTime: '21:10',
    roomType: 'SGL',
    gender: 'F',
    recordStatus: 'active',
    ...patch,
  }
}

describe('сравнение и очередь', () => {
  it('откат к уведомлённому времени убирает diff и оставляет историю', () => {
    const data = loadScenario('reverted', settings, 'specialist')
    expect(selectGroups(data).every((group) => group.changes.length === 0)).toBe(true)
    expect(data.activities.some((item) => item.description.includes('17:45'))).toBe(true)
    expect(data.activities.some((item) => item.description.includes('14:20'))).toBe(true)
  })

  it('не объявляет снимок новыми заявками без базы', () => {
    const groups = selectGroups(loadScenario('unknown_base', settings, 'specialist'))
    expect(groups.every((group) => group.status === 'needs_baseline')).toBe(true)
    expect(groups.every((group) => group.changes.length === 0)).toBe(true)
  })

  it('держит таймер только у затронутой гостиницы', () => {
    const calm = loadScenario('calm', settings, 'specialist')
    const shifted = { ...calm, clockIso: addMinutes(calm.clockIso, 12) }
    const next = patchLatest(shifted, 'b-svx-1', { arrivalLocalTime: '18:10' })
    expect(next.groupTimers['hotel-angel|SVX|2026-10-09'].dueAt).toBe(calm.groupTimers['hotel-angel|SVX|2026-10-09'].dueAt)
    expect(next.groupTimers['hotel-angel|SVX|2026-10-09'].lastChangeAt).toBe(shifted.clockIso)
    expect(next.groupTimers['hotel-neva|LED|2026-10-09']).toBeUndefined()
  })

  it('не создаёт второй черновик на тот же срок', () => {
    const once = loadScenario('delays', settings, 'specialist')
    const twice = prepareDueGroups(once)
    expect(twice.drafts).toHaveLength(once.drafts.length)
    expect(once.drafts).toHaveLength(1)
    const groups = selectGroups(once)
    expect(groups.filter((group) => group.status === 'needs_review')).toHaveLength(1)
    expect(groups.find((group) => group.key === 'hotel-angel|SVX|2026-10-09')?.status).toBe('waiting')
    expect(groups.flatMap((group) => group.changes)).toHaveLength(18)
  })

  it('связывает замену, переезд и переход даты', () => {
    const events = selectGroups(loadScenario('replacement', settings, 'specialist')).flatMap((group) => group.changes)
    expect(events.some((event) => event.kind === 'date_change' && event.linkedGroupKey)).toBe(true)
    expect(events.some((event) => event.kind === 'hotel_change' && event.linkedGroupKey)).toBe(true)
    expect(events.some((event) => event.replacementId?.startsWith('repl-'))).toBe(true)
  })

  it('считает чистый diff, а не промежуточный', () => {
    const base = booking()
    const delayed = booking({ arrivalLocalTime: '17:45' })
    expect(diffBookings({ before: [base], after: [delayed], detectedAt: 't', fromSnapshotId: 'a', toSnapshotId: 'b' })).toHaveLength(1)
    expect(diffBookings({ before: [base], after: [base], detectedAt: 't', fromSnapshotId: 'a', toSnapshotId: 'c' })).toHaveLength(0)
  })
})
