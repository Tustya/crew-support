import type { PoolClient } from 'pg'
import { bookingsFingerprint, diffBookings, type CanonicalBooking, type ChangeEvent } from '../domain/diff.ts'
import { sha256, stableStringify } from '../domain/hash.ts'
import { stayInScope, type StayScope } from '../domain/time.ts'
import { resolveQueueStatus, type QueueStatus } from '../domain/status.ts'
import type { StoredPayload } from '../domain/payload.ts'
import { baselineBookingsFromPayload } from '../domain/payload.ts'

export interface Actor {
  id: string
  externalSubject: string
  displayName: string
  role: 'specialist' | 'lead' | 'system'
}

export interface SettingsRow {
  pollMinutes: number
  quietMinutes: number
  autoCheck: boolean
  autoPrepare: boolean
  stayScope: StayScope
  staleAfterMinutes: number
  templateVersion: number
  rowVersion: number
  senderName: string
}

export interface HotelRow {
  id: string
  sourceHotelId: string | null
  name: string
  city: string
  airportCode: string
  timezone: string
  recipients: string[]
  cc: string[]
  contractStatus: 'confirmed' | 'none' | 'unknown'
  active: boolean
  rowVersion: number
  comment: string
}

export interface SnapshotHead {
  id: string
  seq: number
  seriesId: string
  fetchedAt: string
  hash: string
  validationStatus: 'accepted' | 'blocked'
  completeness: 'full' | 'unknown'
  validationIssues: unknown[]
}

interface SnapshotQueryRow {
  id: string
  seq: number
  series_id: string
  fetched_at: string
  hash: string
  validation_status: 'accepted' | 'blocked'
  completeness: 'full' | 'unknown'
  validation_issues: unknown
}

export interface GroupRow {
  id: string
  groupKey: string
  hotelId: string | null
  airportCode: string
  stayDate: string
  lastChangeAt: string | null
  dueAt: string | null
  rowVersion: number
  lastFingerprint: string | null
}

export interface DraftHead {
  id: string
  groupKey: string
  status: string
  revision: number
  rowVersion: number
  sourceFingerprint: string
  recipientsFingerprint: string
  templateVersion: number
  versionId: string
  payload: StoredPayload
  renderedSubject: string
  renderedContent: string
  recipientTo: string[]
  recipientCc: string[]
  reviewedAt: string | null
  reviewedFingerprint: string | null
}

export interface ExceptionRow {
  id: string
  groupKey: string | null
  kind: string
  severity: 'blocking' | 'warning'
  status: 'open' | 'held' | 'resolved'
  message: string
}

export interface WorkState {
  settings: SettingsRow
  hotels: HotelRow[]
  latest: SnapshotHead | null
  previous: SnapshotHead | null
  bookings: Map<string, CanonicalBooking[]>
  baselines: Map<string, { payload: StoredPayload; revisionNo: number; sourceSnapshotId: string | null }>
  groups: GroupRow[]
  drafts: Map<string, DraftHead>
  exceptions: ExceptionRow[]
  lastRunStatus: string | null
  lastErrorCode: string | null
  lastSuccessAt: string | null
}

export interface QueueGroup {
  id: string
  groupKey: string
  hotel: { id: string; name: string; timezone: string; city: string } | null
  airportCode: string
  stayDate: string
  status: QueueStatus
  changeCount: number
  changes: ChangeEvent[]
  lastMeaningfulChangeAt: string | null
  dueAt: string | null
  draftId: string | null
  draftStatus: string | null
  revision: number | null
  version: number
  exceptions: Array<{ id: string; kind: string; message: string; blocking: boolean }>
  latestBookings: CanonicalBooking[]
  baselineBookings: CanonicalBooking[] | null
  liveFingerprint: string
  recipientFingerprint: string
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function asIso(value: string | Date | null): string | null {
  if (!value) return null
  return new Date(value).toISOString()
}

function asDate(value: string | Date | null): string {
  if (!value) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function asClock(value: string | null): string {
  if (!value) return ''
  return String(value).slice(0, 5)
}

export function recipientFingerprint(hotel: Pick<HotelRow, 'contractStatus' | 'active' | 'recipients' | 'cc'> | null): string {
  if (!hotel) return sha256('missing-hotel')
  return sha256(
    stableStringify({
      active: hotel.active,
      contractStatus: hotel.contractStatus,
      recipients: [...hotel.recipients].map((item) => item.toLowerCase()).sort(),
      cc: [...hotel.cc].map((item) => item.toLowerCase()).sort(),
    }),
  )
}

export function bookingGroupKey(booking: CanonicalBooking): string | null {
  if (!booking.stayDate) return null
  if (booking.hotelId) return `${booking.hotelId}|${booking.airportCode}|${booking.stayDate}`
  return `unresolved|${booking.airportCode}|${booking.stayDate}`
}

function mapBooking(row: {
  source_booking_id: string | null
  source_crew_id: string | null
  hotel_id: string | null
  airport_code: string
  stay_date: string | null
  full_name: string
  position: string | null
  gender: 'M' | 'F' | null
  arrival_flight: string | null
  arrival_local_date: string | null
  arrival_local_time: string | null
  departure_flight: string | null
  departure_local_date: string | null
  departure_local_time: string | null
  room_type: 'SGL' | 'DBL' | null
  record_status: 'active' | 'cancelled' | null
  replacement_of: string | null
}): CanonicalBooking {
  return {
    id: row.source_booking_id,
    crewId: row.source_crew_id,
    hotelId: row.hotel_id,
    airportCode: row.airport_code.trim(),
    stayDate: asDate(row.stay_date) || null,
    fullName: row.full_name,
    position: row.position,
    gender: row.gender,
    arrivalFlight: row.arrival_flight ?? '',
    arrivalLocalDate: asDate(row.arrival_local_date),
    arrivalLocalTime: asClock(row.arrival_local_time),
    departureFlight: row.departure_flight ?? '',
    departureLocalDate: asDate(row.departure_local_date),
    departureLocalTime: asClock(row.departure_local_time),
    roomType: row.room_type,
    recordStatus: row.record_status ?? 'active',
    replacementOf: row.replacement_of,
  }
}

export async function loadState(client: PoolClient): Promise<WorkState> {
  const settingsResult = await client.query<{
    poll_minutes: number
    quiet_minutes: number
    auto_check: boolean
    auto_prepare: boolean
    stay_scope: StayScope
    stale_after_minutes: number
    template_version: number
    row_version: number
    sender_name: string
  }>('SELECT * FROM app_settings WHERE id = 1')
  const settingsRow = settingsResult.rows[0]
  if (!settingsRow) throw new Error('settings missing')
  const hotelsResult = await client.query<{
    id: string
    source_hotel_id: string | null
    name: string
    city: string
    airport_code: string
    timezone: string
    recipients: unknown
    cc: unknown
    contract_status: HotelRow['contractStatus']
    active: boolean
    row_version: number
    comment: string
  }>('SELECT * FROM hotels ORDER BY name')
  const latestResult = await client.query<SnapshotQueryRow>(
    `SELECT id, seq, series_id, fetched_at, hash, validation_status, completeness, validation_issues
     FROM snapshots ORDER BY fetched_at DESC, seq DESC LIMIT 1`,
  )
  const latestRow = latestResult.rows[0]
  const previousResult = latestRow
    ? await client.query<SnapshotQueryRow>(
        `SELECT id, seq, series_id, fetched_at, hash, validation_status, completeness, validation_issues
         FROM snapshots WHERE series_id = $1 AND seq < $2 ORDER BY seq DESC LIMIT 1`,
        [latestRow.series_id, latestRow.seq],
      )
    : { rows: [] as SnapshotQueryRow[] }
  const snapshotIds = [latestRow?.id, previousResult.rows[0]?.id].filter((id): id is string => Boolean(id))
  const bookingResult = snapshotIds.length
    ? await client.query<{ snapshot_id: string } & Parameters<typeof mapBooking>[0]>(
        `SELECT snapshot_id, source_booking_id, source_crew_id, hotel_id, airport_code, stay_date, full_name, position, gender,
                arrival_flight, arrival_local_date, arrival_local_time, departure_flight, departure_local_date, departure_local_time,
                room_type, record_status, replacement_of
         FROM snapshot_bookings WHERE snapshot_id = ANY($1::uuid[])`,
        [snapshotIds],
      )
    : { rows: [] }
  const bookings = new Map<string, CanonicalBooking[]>()
  for (const row of bookingResult.rows) {
    const list = bookings.get(row.snapshot_id) ?? []
    list.push(mapBooking(row))
    bookings.set(row.snapshot_id, list)
  }
  const baselineResult = await client.query<{ group_key: string; payload: StoredPayload; revision_no: number; source_snapshot_id: string | null }>(
    `SELECT DISTINCT ON (group_key) group_key, payload, revision_no, source_snapshot_id
     FROM notification_baselines ORDER BY group_key, revision_no DESC`,
  )
  const groupResult = await client.query<{
    id: string
    group_key: string
    hotel_id: string | null
    airport_code: string
    stay_date: string
    last_change_at: string | null
    due_at: string | null
    row_version: number
    last_fingerprint: string | null
  }>('SELECT id, group_key, hotel_id, airport_code, stay_date, last_change_at, due_at, row_version, last_fingerprint FROM work_groups')
  const draftResult = await client.query<{
    id: string
    group_key: string
    status: string
    current_revision: number
    row_version: number
    source_fingerprint: string
    recipients_fingerprint: string
    template_version: number
    version_id: string
    payload: StoredPayload
    rendered_subject: string
    rendered_content: string
    recipient_to: unknown
    recipient_cc: unknown
    reviewed_at: string | null
    reviewed_fingerprint: string | null
    created_at: string
  }>(
    `SELECT d.id, d.group_key, d.status, d.current_revision, d.row_version, d.created_at,
            v.source_fingerprint, v.recipients_fingerprint, v.template_version, v.id AS version_id, v.payload,
            v.rendered_subject, v.rendered_content, v.recipient_to, v.recipient_cc, v.reviewed_at, v.reviewed_fingerprint
     FROM drafts d
     JOIN draft_versions v ON v.draft_id = d.id AND v.revision = d.current_revision
     ORDER BY d.created_at DESC`,
  )
  const exceptionResult = await client.query<ExceptionRow & { group_key: string | null }>(
    `SELECT id, group_key, kind, severity, status, message FROM exceptions WHERE status <> 'resolved'`,
  )
  const lastRun = await client.query<{ status: string; error_code: string | null }>(
    'SELECT status, error_code FROM source_runs ORDER BY started_at DESC LIMIT 1',
  )
  const lastSuccess = await client.query<{ finished_at: string }>(
    `SELECT finished_at FROM source_runs WHERE status = 'succeeded' ORDER BY finished_at DESC LIMIT 1`,
  )
  const drafts = new Map<string, DraftHead>()
  for (const row of draftResult.rows) {
    if (drafts.has(row.group_key)) continue
    drafts.set(row.group_key, {
      id: row.id,
      groupKey: row.group_key,
      status: row.status,
      revision: row.current_revision,
      rowVersion: row.row_version,
      sourceFingerprint: row.source_fingerprint,
      recipientsFingerprint: row.recipients_fingerprint,
      templateVersion: row.template_version,
      versionId: row.version_id,
      payload: row.payload,
      renderedSubject: row.rendered_subject,
      renderedContent: row.rendered_content,
      recipientTo: asStringArray(row.recipient_to),
      recipientCc: asStringArray(row.recipient_cc),
      reviewedAt: asIso(row.reviewed_at),
      reviewedFingerprint: row.reviewed_fingerprint,
    })
  }
  const head = (row: (typeof latestResult.rows)[number] | undefined): SnapshotHead | null =>
    row
      ? {
          id: row.id,
          seq: Number(row.seq),
          seriesId: row.series_id,
          fetchedAt: new Date(row.fetched_at).toISOString(),
          hash: row.hash,
          validationStatus: row.validation_status,
          completeness: row.completeness,
          validationIssues: Array.isArray(row.validation_issues) ? row.validation_issues : [],
        }
      : null
  return {
    settings: {
      pollMinutes: settingsRow.poll_minutes,
      quietMinutes: settingsRow.quiet_minutes,
      autoCheck: settingsRow.auto_check,
      autoPrepare: settingsRow.auto_prepare,
      stayScope: settingsRow.stay_scope,
      staleAfterMinutes: settingsRow.stale_after_minutes,
      templateVersion: settingsRow.template_version,
      rowVersion: Number(settingsRow.row_version),
      senderName: settingsRow.sender_name,
    },
    hotels: hotelsResult.rows.map((row) => ({
      id: row.id,
      sourceHotelId: row.source_hotel_id,
      name: row.name,
      city: row.city,
      airportCode: row.airport_code.trim(),
      timezone: row.timezone,
      recipients: asStringArray(row.recipients),
      cc: asStringArray(row.cc),
      contractStatus: row.contract_status,
      active: row.active,
      rowVersion: Number(row.row_version),
      comment: row.comment,
    })),
    latest: head(latestRow),
    previous: head(previousResult.rows[0]),
    bookings,
    baselines: new Map(
      baselineResult.rows.map((row) => [
        row.group_key,
        { payload: row.payload, revisionNo: row.revision_no, sourceSnapshotId: row.source_snapshot_id },
      ]),
    ),
    groups: groupResult.rows.map((row) => ({
      id: row.id,
      groupKey: row.group_key,
      hotelId: row.hotel_id,
      airportCode: row.airport_code.trim(),
      stayDate: asDate(row.stay_date),
      lastChangeAt: asIso(row.last_change_at),
      dueAt: asIso(row.due_at),
      rowVersion: Number(row.row_version),
      lastFingerprint: row.last_fingerprint,
    })),
    drafts,
    exceptions: exceptionResult.rows,
    lastRunStatus: lastRun.rows[0]?.status ?? null,
    lastErrorCode: lastRun.rows[0]?.error_code ?? null,
    lastSuccessAt: asIso(lastSuccess.rows[0]?.finished_at ?? null),
  }
}

export function sourceProblem(state: WorkState, now: Date): string | null {
  if (state.lastRunStatus === 'failed') return 'SOURCE_UNAVAILABLE'
  if (!state.lastSuccessAt || state.lastRunStatus !== 'succeeded') return 'SOURCE_NOT_READY'
  if (now.getTime() - new Date(state.lastSuccessAt).getTime() > state.settings.staleAfterMinutes * 60_000) return 'SOURCE_STALE'
  if (!state.latest || state.latest.validationStatus !== 'accepted') return 'SOURCE_NOT_TRUSTED'
  return null
}

function indexBookings(bookings: readonly CanonicalBooking[]): Map<string, CanonicalBooking[]> {
  const grouped = new Map<string, CanonicalBooking[]>()
  for (const booking of bookings) {
    const key = bookingGroupKey(booking)
    if (!key) continue
    const list = grouped.get(key) ?? []
    list.push(booking)
    grouped.set(key, list)
  }
  return grouped
}

export function projectGroups(state: WorkState, now: Date, basis: 'baseline' | 'previous'): QueueGroup[] {
  const latestBookings = state.latest ? (state.bookings.get(state.latest.id) ?? []) : []
  const previousBookings = state.previous ? (state.bookings.get(state.previous.id) ?? []) : []
  const latestByGroup = indexBookings(latestBookings)
  const hop =
    state.latest && state.previous
      ? diffBookings({
          before: previousBookings,
          after: latestBookings,
          completeness: state.latest.completeness === 'full' && state.previous.completeness === 'full' ? 'full' : 'unknown',
        })
      : { events: [], unresolvedAbsences: [], ambiguous: false }
  const hotelsById = new Map(state.hotels.map((hotel) => [hotel.id, hotel]))
  return state.groups.map((group) => {
    const hotel = group.hotelId ? (hotelsById.get(group.hotelId) ?? null) : null
    const latestGroup = latestByGroup.get(group.groupKey) ?? []
    const baseline = state.baselines.get(group.groupKey) ?? null
    const baselineBookings = baseline ? baselineBookingsFromPayload(baseline.payload) : null
    let changes: ChangeEvent[] = []
    if (basis === 'previous') changes = hop.ambiguous ? [] : hop.events.filter((event) => event.groupKey === group.groupKey)
    else if (baselineBookings && state.latest?.completeness === 'full' && state.latest.validationStatus === 'accepted') {
      const net = diffBookings({ before: baselineBookings, after: latestGroup, completeness: 'full' })
      changes = net.ambiguous ? [] : net.events.filter((event) => event.groupKey === group.groupKey)
    }
    const draft = state.drafts.get(group.groupKey) ?? null
    const liveFingerprint = sha256(bookingsFingerprint(latestGroup))
    const recipients = recipientFingerprint(hotel)
    const drifted = Boolean(
      draft && (draft.sourceFingerprint !== liveFingerprint || draft.recipientsFingerprint !== recipients || draft.templateVersion !== state.settings.templateVersion),
    )
    const exceptions = exceptionsFor(state, group, hotel, latestGroup, changes.length > 0 || Boolean(draft), now, draft)
    const blocking = exceptions.some((item) => item.blocking)
    const openDraft = draft && ['active', 'reviewed', 'sending', 'handed_off', 'sent', 'external_confirmed'].includes(draft.status) ? draft : null
    return {
      id: group.id,
      groupKey: group.groupKey,
      hotel: hotel ? { id: hotel.id, name: hotel.name, timezone: hotel.timezone, city: hotel.city } : null,
      airportCode: group.airportCode,
      stayDate: group.stayDate,
      status: resolveQueueStatus({
        hasBaseline: Boolean(baseline),
        changeCount: changes.length,
        blocking,
        draftStatus: openDraft?.status ?? null,
        drifted,
        preparing: openDraft?.status === 'sending',
      }),
      changeCount: changes.length,
      changes,
      lastMeaningfulChangeAt: group.lastChangeAt,
      dueAt: group.dueAt,
      draftId: openDraft?.id ?? null,
      draftStatus: openDraft?.status ?? null,
      revision: openDraft?.revision ?? null,
      version: group.rowVersion,
      exceptions,
      latestBookings: latestGroup,
      baselineBookings,
      liveFingerprint,
      recipientFingerprint: recipients,
    }
  })
}

function exceptionsFor(
  state: WorkState,
  group: GroupRow,
  hotel: HotelRow | null,
  latestGroup: readonly CanonicalBooking[],
  pending: boolean,
  now: Date,
  draft: DraftHead | null,
): Array<{ id: string; kind: string; message: string; blocking: boolean }> {
  const items: Array<{ id: string; kind: string; message: string; blocking: boolean }> = []
  for (const row of state.exceptions) {
    if (row.groupKey !== group.groupKey) continue
    items.push({ id: row.id, kind: row.kind, message: row.message, blocking: row.severity === 'blocking' })
  }
  if (!hotel) {
    if (!items.some((item) => item.kind.startsWith('hotel_'))) {
      items.push({ id: `hotel:${group.id}`, kind: 'unknown_hotel', message: 'Гостиница не сопоставлена', blocking: true })
    }
  } else {
    if (!hotel.active) items.push({ id: `inactive:${group.id}`, kind: 'inactive', message: 'Гостиница отключена', blocking: true })
    if (hotel.recipients.length === 0) items.push({ id: `address:${group.id}`, kind: 'no_address', message: 'Нет адреса получателя', blocking: true })
    if (hotel.contractStatus !== 'confirmed') items.push({ id: `contract:${group.id}`, kind: 'no_contract', message: 'Договор не подтверждён', blocking: true })
    if (pending && !stayInScope(group.stayDate, state.settings.stayScope, now, hotel.timezone)) {
      items.push({ id: `scope:${group.id}`, kind: 'outside_period', message: 'Вне выбранного периода', blocking: true })
    }
  }
  if (draft && /\{[a-z0-9_]+\}/.test(draft.renderedContent)) {
    items.push({ id: `token:${group.id}`, kind: 'missing_token', message: 'В письме осталась нераскрытая переменная', blocking: true })
  }
  if (new Set(latestGroup.map((booking) => booking.id).filter(Boolean)).size !== latestGroup.filter((booking) => booking.id).length) {
    items.push({ id: `duplicate:${group.id}`, kind: 'ambiguous', message: 'Повторяющийся идентификатор заявки', blocking: true })
  }
  return items
}

export function groupById(state: WorkState, now: Date, groupId: string): QueueGroup | null {
  return projectGroups(state, now, 'baseline').find((group) => group.id === groupId) ?? null
}
