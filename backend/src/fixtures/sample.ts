import { HttpError } from '../errors.ts'

export interface SampleBookingInput {
  sourceBookingId: string | null
  sourceCrewId: string | null
  sourceHotelId: string | null
  airportCode: string
  stayDate: string | null
  fullName: string
  position: string | null
  gender: 'M' | 'F' | null
  arrivalFlight: string
  arrivalLocalDate: string
  arrivalLocalTime: string
  departureFlight: string
  departureLocalDate: string
  departureLocalTime: string
  roomType: 'SGL' | 'DBL' | null
  recordStatus: 'active' | 'cancelled'
  replacementOf: string | null
}

export interface SampleFixture {
  name: string
  fail: boolean
  completeness: 'full' | 'unknown'
  bookings: SampleBookingInput[]
  windowFrom: string
  windowTo: string
}

function person(patch: Partial<SampleBookingInput> & Pick<SampleBookingInput, 'fullName' | 'airportCode'>): SampleBookingInput {
  return {
    sourceBookingId: patch.sourceBookingId ?? null,
    sourceCrewId: patch.sourceCrewId ?? patch.sourceBookingId ?? null,
    sourceHotelId: patch.sourceHotelId ?? null,
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

const ivan = person({ sourceBookingId: 'b-ivan', sourceHotelId: 'angel', airportCode: 'SVX', fullName: 'Иванов И.И.' })
const petr = person({
  sourceBookingId: 'b-petr',
  sourceHotelId: 'bereg',
  airportCode: 'SVX',
  fullName: 'Петров П.П.',
  arrivalFlight: '200',
  arrivalLocalTime: '09:10',
  departureFlight: '201',
  departureLocalTime: '21:00',
})

function doubles(): SampleBookingInput[] {
  const males = ['d1', 'd2', 'd3', 'd4'].map((id, index) =>
    person({
      sourceBookingId: id,
      sourceHotelId: 'angel',
      airportCode: 'SVX',
      fullName: `Орлов О.${index + 1}.`,
      roomType: 'DBL',
      arrivalFlight: String(300 + index),
    }),
  )
  return [
    ...males,
    person({
      sourceBookingId: 'd5',
      sourceHotelId: 'angel',
      airportCode: 'SVX',
      fullName: 'Орлова О.А.',
      gender: 'F',
      roomType: 'DBL',
      arrivalFlight: '310',
    }),
  ]
}

const FIXTURES: Record<string, SampleFixture> = {
  base: { name: 'base', fail: false, completeness: 'full', bookings: [ivan, petr], windowFrom: '2026-10-09', windowTo: '2026-10-13' },
  delayed: {
    name: 'delayed',
    fail: false,
    completeness: 'full',
    bookings: [{ ...ivan, arrivalLocalTime: '13:10' }, petr],
    windowFrom: '2026-10-09',
    windowTo: '2026-10-13',
  },
  delayed_more: {
    name: 'delayed_more',
    fail: false,
    completeness: 'full',
    bookings: [{ ...ivan, arrivalLocalTime: '13:40' }, petr],
    windowFrom: '2026-10-09',
    windowTo: '2026-10-13',
  },
  reverted: { name: 'reverted', fail: false, completeness: 'full', bookings: [ivan, petr], windowFrom: '2026-10-09', windowTo: '2026-10-13' },
  moved: {
    name: 'moved',
    fail: false,
    completeness: 'full',
    bookings: [{ ...ivan, sourceHotelId: 'bereg' }, petr],
    windowFrom: '2026-10-09',
    windowTo: '2026-10-13',
  },
  namesakes: {
    name: 'namesakes',
    fail: false,
    completeness: 'full',
    bookings: [
      person({ sourceBookingId: 'n1', sourceHotelId: 'angel', airportCode: 'SVX', fullName: 'Смирнов С.С.', arrivalFlight: '113' }),
      person({ sourceBookingId: 'n2', sourceHotelId: 'angel', airportCode: 'SVX', fullName: 'Смирнов С.С.', arrivalFlight: '500', departureFlight: '501' }),
    ],
    windowFrom: '2026-10-09',
    windowTo: '2026-10-13',
  },
  ambiguous: {
    name: 'ambiguous',
    fail: false,
    completeness: 'full',
    bookings: [
      person({ sourceBookingId: null, sourceCrewId: null, sourceHotelId: null, airportCode: 'AER', fullName: 'Смирнов С.С.', arrivalFlight: '113' }),
      person({ sourceBookingId: null, sourceCrewId: null, sourceHotelId: null, airportCode: 'AER', fullName: 'Смирнов С.С.', arrivalFlight: '777', departureFlight: '778' }),
    ],
    windowFrom: '2026-10-09',
    windowTo: '2026-10-13',
  },
  partial: {
    name: 'partial',
    fail: false,
    completeness: 'unknown',
    bookings: [petr],
    windowFrom: '2026-10-09',
    windowTo: '2026-10-13',
  },
  doubles: { name: 'doubles', fail: false, completeness: 'full', bookings: doubles(), windowFrom: '2026-10-09', windowTo: '2026-10-13' },
  outage: { name: 'outage', fail: true, completeness: 'full', bookings: [], windowFrom: '2026-10-09', windowTo: '2026-10-13' },
}

export function sampleFixture(name: string): SampleFixture {
  const fixture = FIXTURES[name]
  if (!fixture) throw new HttpError(422, 'UNKNOWN_FIXTURE', 'Неизвестный синтетический набор')
  return fixture
}

export function sampleFixtureNames(): string[] {
  return Object.keys(FIXTURES)
}
