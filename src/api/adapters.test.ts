import { describe, expect, it } from 'vitest'
import { toJournalEntry, toNotice, toWorkGroup } from './adapters'
import type { AuditDto, BookingDto, DirectoryHotel, GroupDto, NotificationDto } from './types'

const hotel: DirectoryHotel = {
  id: 'h-1',
  sourceHotelId: 'angel',
  version: 1,
  name: 'Гостиница Ангел',
  city: 'Екатеринбург',
  airportCode: 'SVX',
  airportName: '',
  timezone: 'Asia/Yekaterinburg',
  utcOffset: '+05:00',
  recipients: ['hotel-angel@example.com'],
  cc: [],
  contractStatus: 'confirmed',
  active: true,
  recipientSource: 'local',
  comment: '',
  sourceRecipients: [],
  sourceCc: [],
}

const booking = (arrivalLocalTime: string): BookingDto => ({
  id: 'b-ivan',
  crewId: null,
  hotelId: 'h-1',
  airportCode: 'SVX',
  stayDate: '2026-10-09',
  fullName: 'Иванов И.И.',
  arrivalFlight: '0113',
  arrivalLocalDate: '2026-10-09',
  arrivalLocalTime,
  departureFlight: '0114',
  departureLocalDate: '2026-10-10',
  departureLocalTime: '08:10',
  roomType: 'SGL',
  recordStatus: 'active',
  replacementOf: null,
})

const group: GroupDto = {
  id: 'g-1',
  groupKey: 'h-1|SVX|2026-10-09',
  hotel: { id: 'h-1', name: 'Гостиница Ангел', city: 'Екатеринбург', timezone: 'Asia/Yekaterinburg' },
  airportCode: 'SVX',
  stayDate: '2026-10-09',
  status: 'waiting',
  changeCount: 1,
  changes: [{ entityKey: 'b-ivan', groupKey: 'h-1|SVX|2026-10-09', linkedGroupKey: null, linkKey: null, kind: 'arrival', before: booking('12:40'), after: booking('13:10'), changedFields: ['arrivalLocalTime'] }],
  lastMeaningfulChangeAt: '2026-10-09T05:00:00.000Z',
  dueAt: '2026-10-09T05:10:00.000Z',
  draftId: null,
  draftStatus: null,
  revision: null,
  exceptions: [],
  latestBookings: [booking('13:10')],
  baselineBookings: [booking('12:40')],
}

describe('api adapters', () => {
  it('shows a group change as labelled before and after values with the directory hotel', () => {
    const view = toWorkGroup(group, [hotel])
    expect(view.key).toBe('g-1')
    expect(view.hotel.recipients).toEqual(['hotel-angel@example.com'])
    expect(view.changes[0]?.fields).toEqual([{ field: 'arrivalLocalTime', label: 'Время прилёта', before: '12:40', after: '13:10' }])
    expect(view.changes[0]?.detectedAt).toBe('2026-10-09T05:00:00.000Z')
    expect(view.crewNames).toEqual(['Иванов И.И.'])
  })

  it('keeps an unmapped group visible with a readable placeholder hotel', () => {
    const view = toWorkGroup({ ...group, hotel: null }, [])
    expect(view.hotel.name).toBe('Гостиница не сопоставлена')
  })

  it('resolves the hotel and stay date of an archived notification from its group key', () => {
    const dto: NotificationDto = { id: 'n-1', group_key: 'h-1|SVX|2026-10-09', transport_status: 'handed_off', sent_at: null, external_confirmation_at: null, created_at: '2026-10-09T06:00:00.000Z', revision: 2, letter: null }
    const notice = toNotice(dto, [hotel])
    expect(notice.hotelName).toBe('Гостиница Ангел')
    expect(notice.localStayDate).toBe('2026-10-09')
    expect(notice.timezoneLabel).toBe('+05:00')
  })

  it('names the journal actor and translates the action', () => {
    const dto: AuditDto = { id: 'a-1', occurred_at: '2026-10-09T06:00:00.000Z', action: 'draft.handed_off', entity_type: 'draft', result: 'ok', group_key: 'h-1|SVX|2026-10-09', service_actor: null, display_name: 'Специалист смены', safe_details: {} }
    const entry = toJournalEntry(dto, [hotel])
    expect(entry.actor).toBe('Специалист смены')
    expect(entry.action).toBe('Передано в почту')
    expect(entry.hotelName).toBe('Гостиница Ангел')
  })
})
