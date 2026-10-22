export const AVIABIT_VISIBLE_COLUMNS_V0 = [
  'airportCode',
  'fullNameSource',
  'position',
  'gender',
  'arrivalFlight',
  'arrivalLocalDate',
  'arrivalLocalTime',
  'departureFlight',
  'departureLocalDate',
  'departureLocalTime',
  'roomType',
  'hotelDurationRaw',
] as const

export type AviabitColumn = (typeof AVIABIT_VISIBLE_COLUMNS_V0)[number]

const LEAVES: Record<string, AviabitColumn> = {
  'аэропорт': 'airportCode',
  'фамилия и.о.': 'fullNameSource',
  'должность': 'position',
  'пол': 'gender',
  'рейс прибытия': 'arrivalFlight',
  'дата прибытия': 'arrivalLocalDate',
  'время прибытия': 'arrivalLocalTime',
  'рейс отправления': 'departureFlight',
  'дата отправления': 'departureLocalDate',
  'время отправления': 'departureLocalTime',
  'тип комнаты': 'roomType',
  'время в гостинице': 'hotelDurationRaw',
}

const OPTIONAL: Record<string, 'sourceBookingId' | 'sourceHotelId' | 'localStayDate'> = {
  'идентификатор брони': 'sourceBookingId',
  'код гостиницы': 'sourceHotelId',
  'дата проживания': 'localStayDate',
}

export class ImportSchemaError extends Error {
  readonly code: 'HEADER_NOT_FOUND' | 'SOURCE_ROW_INVALID'

  constructor(code: 'HEADER_NOT_FOUND' | 'SOURCE_ROW_INVALID') {
    super(code)
    this.code = code
  }
}

export interface NormalizedAviabitRow {
  airportCode: string
  fullNameSource: string
  position: string | null
  gender: 'M' | 'F' | null
  arrivalFlight: string
  arrivalLocalDate: string
  arrivalLocalTime: string
  departureFlight: string
  departureLocalDate: string
  departureLocalTime: string
  roomType: 'SGL' | 'DBL' | null
  hotelDurationRaw: string | null
  hotelDurationMinutes: number | null
  sourceBookingId: string | null
  sourceCrewId: string | null
  sourceHotelId: string | null
  hotelId: null
  localStayDate: string | null
  issues: string[]
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/ё/g, 'е')
}

function headerScore(row: readonly string[]): number {
  return row.reduce((count, value) => count + (LEAVES[normalizeHeader(value)] ? 1 : 0), 0)
}

function columnsOf(labels: readonly string[]): Partial<Record<AviabitColumn, number>> | null {
  const columns: Partial<Record<AviabitColumn, number>> = {}
  labels.forEach((label, columnIndex) => {
    const field = LEAVES[label]
    if (field && columns[field] === undefined) columns[field] = columnIndex
  })
  return AVIABIT_VISIBLE_COLUMNS_V0.every((field) => columns[field] !== undefined) ? columns : null
}

export function locateHeader(rows: readonly (readonly string[])[]): { headerIndex: number; columns: Partial<Record<AviabitColumn, number>> } {
  for (let index = 0; index < rows.length; index += 1) {
    const current = rows[index] ?? []
    const next = rows[index + 1] ?? []
    const own = columnsOf(current.map((value) => normalizeHeader(value)))
    if (own) return { headerIndex: index, columns: own }
    if (headerScore(next) >= 2) {
      const combined = columnsOf(combineHeader(current, next))
      if (combined) return { headerIndex: index + 1, columns: combined }
    }
  }
  throw new ImportSchemaError('HEADER_NOT_FOUND')
}

function combineHeader(parent: readonly string[], child: readonly string[]): string[] {
  const width = Math.max(parent.length, child.length)
  const combined: string[] = []
  let carried = ''
  for (let index = 0; index < width; index += 1) {
    const parentCell = normalizeHeader(parent[index] ?? '')
    if (parentCell) carried = parentCell
    const childCell = normalizeHeader(child[index] ?? '')
    combined.push(childCell || parentCell || carried)
  }
  return combined
}

export function excelSerialToIsoDate(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null
  return new Date(Date.UTC(1899, 11, 30) + Math.trunc(serial) * 86_400_000).toISOString().slice(0, 10)
}

export function parseLocalDate(value: string | number): string | null {
  if (typeof value === 'number') return excelSerialToIsoDate(value)
  const text = value.trim()
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text)
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  return null
}

export function parseLocalTime(value: string | number): string | null {
  if (typeof value === 'number') {
    if (value < 0 || value >= 1) return null
    const total = Math.round(value * 1440)
    const hours = Math.floor(total / 60)
    const minutes = total % 60
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }
  const matched = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value.trim())
  if (!matched) return null
  return `${matched[1]}:${matched[2]}`
}

export function parseFlight(value: string | number): { text: string | null; issue: string | null } {
  if (typeof value === 'number') return { text: null, issue: 'FLIGHT_NUMERIC_AMBIGUOUS' }
  const text = value.trim()
  if (!text) return { text: null, issue: 'FLIGHT_EMPTY' }
  return { text, issue: null }
}

function parseGender(value: string): 'M' | 'F' | null {
  const text = value.trim().toUpperCase()
  if (text === 'М' || text === 'M') return 'M'
  if (text === 'Ж' || text === 'F') return 'F'
  return null
}

function durationMinutes(value: string): number | null {
  const matched = /^(\d{2}):(\d{2})$/.exec(value.trim())
  if (!matched) return null
  return Number(matched[1]) * 60 + Number(matched[2])
}

function cell(row: readonly (string | number | null)[], index: number | undefined): string | number | null {
  if (index === undefined) return null
  return row[index] ?? null
}

function asText(value: string | number | null): string {
  return value === null ? '' : String(value)
}

export function normalizeAviabitTable(rows: readonly (readonly (string | number | null)[])[]): NormalizedAviabitRow[] {
  const headerSource = rows.map((row) => row.map((value) => (value === null ? '' : String(value))))
  const located = locateHeader(headerSource)
  const headerLabels = combineHeader(headerSource[located.headerIndex - 1] ?? [], headerSource[located.headerIndex] ?? [])
  const optional: Partial<Record<'sourceBookingId' | 'sourceHotelId' | 'localStayDate', number>> = {}
  headerLabels.forEach((label, columnIndex) => {
    const field = OPTIONAL[label]
    if (field && optional[field] === undefined) optional[field] = columnIndex
  })
  const parsed: NormalizedAviabitRow[] = []
  for (let index = located.headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? []
    if (isSkippable(row)) continue
    const airport = asText(cell(row, located.columns.airportCode)).trim().toUpperCase()
    const arrivalProbe = asText(cell(row, located.columns.arrivalFlight)).trim()
    const departureProbe = asText(cell(row, located.columns.departureFlight)).trim()
    if (!/^[A-Z]{3}$/.test(airport) && arrivalProbe === '' && departureProbe === '') continue
    const issues: string[] = []
    if (!/^[A-Z]{3}$/.test(airport)) {
      issues.push('AIRPORT_INVALID')
    }
    const arrivalFlight = parseFlight(typed(cell(row, located.columns.arrivalFlight)))
    const departureFlight = parseFlight(typed(cell(row, located.columns.departureFlight)))
    if (arrivalFlight.issue) issues.push(arrivalFlight.issue)
    if (departureFlight.issue) issues.push(departureFlight.issue)
    const arrivalDate = parseLocalDate(typed(cell(row, located.columns.arrivalLocalDate)))
    const departureDate = parseLocalDate(typed(cell(row, located.columns.departureLocalDate)))
    const arrivalTime = parseLocalTime(typed(cell(row, located.columns.arrivalLocalTime)))
    const departureTime = parseLocalTime(typed(cell(row, located.columns.departureLocalTime)))
    if (!arrivalDate || !departureDate || !arrivalTime || !departureTime) issues.push('LOCAL_DATETIME_INVALID')
    const roomText = asText(cell(row, located.columns.roomType)).trim().toUpperCase()
    const roomType = roomText === 'SGL' || roomText === 'DBL' ? roomTypeOf(roomText) : null
    if (!roomType) issues.push('ROOM_TYPE_INVALID')
    const durationRaw = asText(cell(row, located.columns.hotelDurationRaw)).trim()
    const sourceBookingId = asText(cell(row, optional.sourceBookingId)).trim() || null
    const stayText = asText(cell(row, optional.localStayDate)).trim()
    const localStayDate = stayText ? parseLocalDate(typed(cell(row, optional.localStayDate))) : null
    if (stayText && !localStayDate) issues.push('LOCAL_DATETIME_INVALID')
    parsed.push({
      airportCode: airport,
      fullNameSource: asText(cell(row, located.columns.fullNameSource)).trim(),
      position: asText(cell(row, located.columns.position)).trim() || null,
      gender: parseGender(asText(cell(row, located.columns.gender))),
      arrivalFlight: arrivalFlight.text ?? '',
      arrivalLocalDate: arrivalDate ?? '',
      arrivalLocalTime: arrivalTime ?? '',
      departureFlight: departureFlight.text ?? '',
      departureLocalDate: departureDate ?? '',
      departureLocalTime: departureTime ?? '',
      roomType,
      hotelDurationRaw: durationRaw || null,
      hotelDurationMinutes: durationRaw ? durationMinutes(durationRaw) : null,
      sourceBookingId,
      sourceCrewId: sourceBookingId,
      sourceHotelId: asText(cell(row, optional.sourceHotelId)).trim() || null,
      hotelId: null,
      localStayDate,
      issues,
    })
  }
  return parsed
}

function roomTypeOf(value: 'SGL' | 'DBL'): 'SGL' | 'DBL' {
  return value
}

function typed(value: string | number | null): string | number {
  if (value === null) return ''
  return value
}

function isSkippable(row: readonly (string | number | null)[]): boolean {
  const texts = row.map((value) => (value === null ? '' : String(value).trim())).filter((value) => value !== '')
  if (texts.length === 0) return true
  if (texts.some((value) => /^итого\b/i.test(value))) return true
  const headerish = texts.every((value) => LEAVES[normalizeHeader(value)] !== undefined || /локальная дата/i.test(value))
  return headerish
}
