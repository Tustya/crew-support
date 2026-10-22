import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { bookingsFingerprint, contentKeyOf, diffBookings, groupKeyOf, type CanonicalBooking } from '../domain/diff.ts'
import { sha256, sha256Hex, stableStringify } from '../domain/hash.ts'
import { indexHotels, resolveHotelMapping } from '../domain/hotels.ts'
import { nextQuietTimer } from '../domain/timer.ts'
import { HttpError } from '../errors.ts'
import { sampleFixture, type SampleBookingInput } from '../fixtures/sample.ts'
import { writeAudit } from './audit.ts'
import { bookingGroupKey, type Actor } from './state.ts'
import { baselineBookingsFromPayload, type StoredPayload } from '../domain/payload.ts'

const SERIES_ID = 'sample'
const MAX_ROWS = 5000

export interface CheckResult {
  jobId: string
  runId: string
  snapshotId: string | null
  duplicate: boolean
  status: 'succeeded' | 'failed'
  errorCode: string | null
}

export async function runSampleCheck(
  client: PoolClient,
  input: { fixtureName: string; trigger: 'manual' | 'schedule'; actor: Actor | null; now: Date; correlationId: string },
): Promise<CheckResult> {
  const fixture = sampleFixture(input.fixtureName)
  if (fixture.bookings.length > MAX_ROWS) throw new HttpError(422, 'SNAPSHOT_TOO_LARGE', 'Слишком много строк')
  const nowIso = input.now.toISOString()
  await client.query(
    `UPDATE jobs SET status = 'failed', last_error_code = 'INTERRUPTED', locked_until = NULL, updated_at = $1
     WHERE dedupe_key = 'source-check' AND status = 'running' AND locked_until < $1`,
    [nowIso],
  )
  const job = await client.query<{ id: string }>(
    `INSERT INTO jobs (job_type, subject_key, due_at, status, attempt, locked_until, dedupe_key)
     VALUES ('source-check', $1, $2, 'running', 1, $2::timestamptz + interval '30 seconds', 'source-check')
     RETURNING id`,
    [fixture.name, nowIso],
  )
  const jobId = job.rows[0]?.id
  if (!jobId) throw new HttpError(409, 'SOURCE_CHECK_ACTIVE', 'Проверка источника уже выполняется')
  const run = await client.query<{ id: string }>(
    `INSERT INTO source_runs (adapter, trigger, status, started_at, source_cursor) VALUES ('sample', $1, 'running', $2, $3) RETURNING id`,
    [input.trigger, nowIso, fixture.name],
  )
  const runId = run.rows[0]?.id ?? ''
  if (fixture.fail) {
    await finishRun(client, runId, jobId, 'failed', 'SOURCE_UNAVAILABLE', null, nowIso)
    await writeAudit(client, audit(input, 'source.check_failed', runId, 'error', { fixture: fixture.name }))
    return { jobId, runId, snapshotId: null, duplicate: false, status: 'failed', errorCode: 'SOURCE_UNAVAILABLE' }
  }
  const resolved = await resolveFixture(client, fixture.bookings)
  const hash = sha256(stableStringify(resolved.bookings.map((booking) => contentKeyOf(booking)).sort()))
  const latest = await client.query<{ id: string; hash: string; seq: number; completeness: 'full' | 'unknown' }>(
    `SELECT id, hash, seq, completeness FROM snapshots WHERE series_id = $1 ORDER BY seq DESC LIMIT 1`,
    [SERIES_ID],
  )
  const previous = latest.rows[0]
  if (previous && previous.hash === hash) {
    await finishRun(client, runId, jobId, 'succeeded', null, hash, nowIso)
    await writeAudit(client, audit(input, 'source.check_duplicate', runId, 'ok', { fixture: fixture.name }))
    return { jobId, runId, snapshotId: previous.id, duplicate: true, status: 'succeeded', errorCode: null }
  }
  const seq = Number(previous?.seq ?? 0) + 1
  const blocked = resolved.issues.length > 0 || fixture.completeness !== 'full'
  const snapshot = await client.query<{ id: string }>(
    `INSERT INTO snapshots (source_run_id, source, series_id, seq, window_from, window_to, fetched_at, hash, validation_status, completeness, validation_issues)
     VALUES ($1, 'sample', $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb) RETURNING id`,
    [runId, SERIES_ID, seq, fixture.windowFrom, fixture.windowTo, nowIso, hash, blocked ? 'blocked' : 'accepted', fixture.completeness, JSON.stringify(resolved.issues.slice(0, 50))],
  )
  const snapshotId = snapshot.rows[0]?.id ?? ''
  await insertBookings(client, snapshotId, resolved.bookings, resolved.raw)
  const previousBookings = previous ? await loadBookings(client, previous.id) : []
  const comparable = Boolean(previous) && fixture.completeness === 'full' && previous?.completeness === 'full' && resolved.issues.length === 0
  const hop = comparable
    ? diffBookings({ before: previousBookings, after: resolved.bookings, completeness: 'full' })
    : { events: [], unresolvedAbsences: [], ambiguous: resolved.issues.some((issue) => issue.code === 'IDENTITY_AMBIGUOUS') }
  if (comparable && !hop.ambiguous) await insertEvents(client, hop.events, previous?.id ?? '', snapshotId, nowIso)
  await ensureGroups(client, resolved.bookings, nowIso)
  if (!blocked && !hop.ambiguous) await applyTimers(client, resolved.bookings, nowIso)
  else await insertCompletenessExceptions(client, resolved.bookings, previousBookings, snapshotId, fixture.completeness, hop.ambiguous)
  await insertMappingExceptions(client, resolved.issues, snapshotId)
  await finishRun(client, runId, jobId, 'succeeded', blocked ? 'SNAPSHOT_BLOCKED' : null, hash, nowIso)
  await writeAudit(client, audit(input, 'source.check_succeeded', snapshotId, 'ok', { fixture: fixture.name, blocked }))
  return { jobId, runId, snapshotId, duplicate: false, status: 'succeeded', errorCode: blocked ? 'SNAPSHOT_BLOCKED' : null }
}

export async function runImportedRows(
  client: PoolClient,
  input: { filename: string; rows: SampleBookingInput[]; actor: Actor; now: Date; correlationId: string },
): Promise<CheckResult> {
  if (input.rows.length === 0) throw new HttpError(422, 'SNAPSHOT_EMPTY', 'В выгрузке нет строк')
  if (input.rows.length > MAX_ROWS) throw new HttpError(422, 'SNAPSHOT_TOO_LARGE', 'Слишком много строк')
  const nowIso = input.now.toISOString()
  const dates = input.rows.map((row) => row.stayDate).filter((date): date is string => Boolean(date)).sort()
  const windowFrom = dates[0] ?? nowIso.slice(0, 10)
  const windowTo = dates[dates.length - 1] ?? windowFrom
  await client.query(
    `UPDATE jobs SET status = 'failed', last_error_code = 'INTERRUPTED', locked_until = NULL, updated_at = $1
     WHERE dedupe_key = 'source-check' AND status = 'running' AND locked_until < $1`,
    [nowIso],
  )
  const job = await client.query<{ id: string }>(
    `INSERT INTO jobs (job_type, subject_key, due_at, status, attempt, locked_until, dedupe_key)
     VALUES ('source-check', $1, $2, 'running', 1, $2::timestamptz + interval '30 seconds', 'source-check')
     RETURNING id`,
    [input.filename, nowIso],
  )
  const jobId = job.rows[0]?.id
  if (!jobId) throw new HttpError(409, 'SOURCE_CHECK_ACTIVE', 'Проверка источника уже выполняется')
  const run = await client.query<{ id: string }>(
    `INSERT INTO source_runs (adapter, trigger, status, started_at, source_cursor) VALUES ('workbook', 'manual', 'running', $1, $2) RETURNING id`,
    [nowIso, input.filename],
  )
  const runId = run.rows[0]?.id ?? ''
  const resolved = await resolveFixture(client, input.rows)
  const hash = sha256(stableStringify(resolved.bookings.map((booking) => contentKeyOf(booking)).sort()))
  const latest = await client.query<{ id: string; hash: string; seq: number; completeness: 'full' | 'unknown' }>(
    `SELECT id, hash, seq, completeness FROM snapshots WHERE series_id = 'workbook' ORDER BY seq DESC LIMIT 1`,
  )
  const previous = latest.rows[0]
  if (previous && previous.hash === hash) {
    await finishRun(client, runId, jobId, 'succeeded', null, hash, nowIso)
    await writeAudit(client, audit(input, 'source.import_duplicate', runId, 'ok', { filename: input.filename }))
    return { jobId, runId, snapshotId: previous.id, duplicate: true, status: 'succeeded', errorCode: null }
  }
  const seq = Number(previous?.seq ?? 0) + 1
  const blocked = resolved.issues.length > 0
  const snapshot = await client.query<{ id: string }>(
    `INSERT INTO snapshots (source_run_id, source, series_id, seq, window_from, window_to, fetched_at, hash, validation_status, completeness, validation_issues)
     VALUES ($1, 'workbook', 'workbook', $2, $3, $4, $5, $6, $7, 'full', $8::jsonb) RETURNING id`,
    [runId, seq, windowFrom, windowTo, nowIso, hash, blocked ? 'blocked' : 'accepted', JSON.stringify(resolved.issues.slice(0, 50))],
  )
  const snapshotId = snapshot.rows[0]?.id ?? ''
  await insertBookings(client, snapshotId, resolved.bookings, resolved.raw)
  const previousBookings = previous ? await loadBookings(client, previous.id) : []
  const comparable = Boolean(previous) && previous?.completeness === 'full' && resolved.issues.length === 0
  const hop = comparable
    ? diffBookings({ before: previousBookings, after: resolved.bookings, completeness: 'full' })
    : { events: [], unresolvedAbsences: [], ambiguous: resolved.issues.some((issue) => issue.code === 'IDENTITY_AMBIGUOUS') }
  if (comparable && !hop.ambiguous) await insertEvents(client, hop.events, previous?.id ?? '', snapshotId, nowIso)
  await ensureGroups(client, resolved.bookings, nowIso)
  if (!blocked && !hop.ambiguous) await applyTimers(client, resolved.bookings, nowIso)
  else await insertCompletenessExceptions(client, resolved.bookings, previousBookings, snapshotId, 'full', hop.ambiguous)
  await insertMappingExceptions(client, resolved.issues, snapshotId)
  await finishRun(client, runId, jobId, 'succeeded', blocked ? 'SNAPSHOT_BLOCKED' : null, hash, nowIso)
  await writeAudit(client, audit(input, 'source.import_succeeded', snapshotId, 'ok', { filename: input.filename, blocked }))
  return { jobId, runId, snapshotId, duplicate: false, status: 'succeeded', errorCode: blocked ? 'SNAPSHOT_BLOCKED' : null }
}

function audit(
  input: { actor: Actor | null; now: Date; correlationId: string },
  action: string,
  entityId: string,
  result: 'ok' | 'error',
  details: Record<string, string | number | boolean | null>,
) {
  return {
    occurredAt: input.now.toISOString(),
    actorId: input.actor?.id ?? null,
    serviceActor: input.actor ? null : 'scheduler',
    action,
    entityType: 'source_run',
    entityId,
    groupKey: null,
    result,
    details,
    correlationId: input.correlationId,
  }
}

async function finishRun(client: PoolClient, runId: string, jobId: string, status: 'succeeded' | 'failed', errorCode: string | null, hash: string | null, nowIso: string): Promise<void> {
  await client.query(`UPDATE source_runs SET status = $2, finished_at = $3, error_code = $4, input_hash = $5 WHERE id = $1`, [runId, status, nowIso, errorCode, hash])
  await client.query(`UPDATE jobs SET status = $2, last_error_code = $3, locked_until = NULL, updated_at = $4 WHERE id = $1`, [jobId, status, errorCode, nowIso])
}

interface ResolvedFixture {
  bookings: CanonicalBooking[]
  raw: SampleBookingInput[]
  issues: Array<{ code: string; groupKey: string | null }>
}

async function resolveFixture(client: PoolClient, rows: readonly SampleBookingInput[]): Promise<ResolvedFixture> {
  const hotels = await client.query<{ id: string; source_hotel_id: string | null; airport_code: string }>('SELECT id, source_hotel_id, airport_code FROM hotels')
  const index = indexHotels(hotels.rows.map((row) => ({ id: row.id, sourceHotelId: row.source_hotel_id, airportCode: row.airport_code.trim() })))
  const bookings: CanonicalBooking[] = []
  const issues: Array<{ code: string; groupKey: string | null }> = []
  rows.forEach((row, rowIndex) => {
    const mapping = resolveHotelMapping(index, row.sourceHotelId, row.airportCode)
    const hotelId = 'hotelId' in mapping ? mapping.hotelId : null
    if ('error' in mapping) issues.push({ code: mapping.error, groupKey: row.stayDate ? `unresolved|${row.airportCode}|${row.stayDate}` : null })
    if (!row.roomType || !row.gender || !row.stayDate) issues.push({ code: 'SOURCE_ROW_INVALID', groupKey: null })
    bookings.push({
      id: row.sourceBookingId,
      crewId: row.sourceCrewId,
      hotelId,
      airportCode: row.airportCode,
      stayDate: row.stayDate,
      fullName: row.fullName,
      position: row.position,
      gender: row.gender,
      arrivalFlight: row.arrivalFlight,
      arrivalLocalDate: row.arrivalLocalDate,
      arrivalLocalTime: row.arrivalLocalTime,
      departureFlight: row.departureFlight,
      departureLocalDate: row.departureLocalDate,
      departureLocalTime: row.departureLocalTime,
      roomType: row.roomType,
      recordStatus: row.recordStatus,
      replacementOf: row.replacementOf,
    })
    void rowIndex
  })
  const identity = diffBookings({ before: [], after: bookings, completeness: 'full' })
  if (identity.ambiguous) issues.push({ code: 'IDENTITY_AMBIGUOUS', groupKey: bookingGroupKey(bookings[0] ?? emptyBooking()) })
  const seen = new Set<string>()
  for (const booking of bookings) {
    if (!booking.id) continue
    if (seen.has(booking.id)) issues.push({ code: 'DUPLICATE_SOURCE_ID', groupKey: bookingGroupKey(booking) })
    seen.add(booking.id)
  }
  if (bookings.some((booking) => !booking.id)) {
    const probe = diffBookings({ before: bookings, after: bookings.map((booking) => ({ ...booking, arrivalFlight: `${booking.arrivalFlight}*` })), completeness: 'full' })
    if (probe.ambiguous) issues.push({ code: 'IDENTITY_AMBIGUOUS', groupKey: bookingGroupKey(bookings[0] ?? emptyBooking()) })
  }
  return { bookings, raw: [...rows], issues: dedupeIssues(issues) }
}

function emptyBooking(): CanonicalBooking {
  return {
    id: null,
    crewId: null,
    hotelId: null,
    airportCode: 'XXX',
    stayDate: null,
    fullName: '',
    position: null,
    gender: null,
    arrivalFlight: '',
    arrivalLocalDate: '',
    arrivalLocalTime: '',
    departureFlight: '',
    departureLocalDate: '',
    departureLocalTime: '',
    roomType: null,
    recordStatus: 'active',
    replacementOf: null,
  }
}

function dedupeIssues(issues: Array<{ code: string; groupKey: string | null }>): Array<{ code: string; groupKey: string | null }> {
  const seen = new Set<string>()
  const unique = []
  for (const issue of issues) {
    const key = `${issue.code}|${issue.groupKey ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(issue)
  }
  return unique
}

async function insertBookings(client: PoolClient, snapshotId: string, bookings: readonly CanonicalBooking[], raw: readonly SampleBookingInput[]): Promise<void> {
  for (let index = 0; index < bookings.length; index += 1) {
    const booking = bookings[index]
    const source = raw[index]
    if (!booking || !source) continue
    await client.query(
      `INSERT INTO snapshot_bookings (
        snapshot_id, source_booking_id, source_crew_id, sheet_name, source_row_no, source_row_hash, hotel_id, airport_code, stay_date,
        full_name, position, gender, arrival_local_date, arrival_local_time, departure_local_date, departure_local_time,
        arrival_flight, departure_flight, room_type, record_status, replacement_of, raw_sanitized
      ) VALUES (
        $1, $2, $3, 'synthetic', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, '{}'::jsonb
      )`,
      [
        snapshotId,
        booking.id,
        booking.crewId,
        index + 1,
        sha256Hex(contentKeyOf(booking) + index),
        booking.hotelId,
        booking.airportCode,
        booking.stayDate,
        booking.fullName,
        booking.position,
        booking.gender,
        booking.arrivalLocalDate || null,
        booking.arrivalLocalTime || null,
        booking.departureLocalDate || null,
        booking.departureLocalTime || null,
        booking.arrivalFlight,
        booking.departureFlight,
        booking.roomType,
        booking.recordStatus,
        booking.replacementOf,
      ],
    )
  }
}

async function loadBookings(client: PoolClient, snapshotId: string): Promise<CanonicalBooking[]> {
  const result = await client.query<{
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
  }>(
    `SELECT source_booking_id, source_crew_id, hotel_id, airport_code, stay_date, full_name, position, gender,
            arrival_flight, arrival_local_date, arrival_local_time, departure_flight, departure_local_date, departure_local_time,
            room_type, record_status, replacement_of
     FROM snapshot_bookings WHERE snapshot_id = $1`,
    [snapshotId],
  )
  return result.rows.map((row) => ({
    id: row.source_booking_id,
    crewId: row.source_crew_id,
    hotelId: row.hotel_id,
    airportCode: row.airport_code.trim(),
    stayDate: row.stay_date ? String(row.stay_date).slice(0, 10) : null,
    fullName: row.full_name,
    position: row.position,
    gender: row.gender,
    arrivalFlight: row.arrival_flight ?? '',
    arrivalLocalDate: row.arrival_local_date ? String(row.arrival_local_date).slice(0, 10) : '',
    arrivalLocalTime: row.arrival_local_time ? String(row.arrival_local_time).slice(0, 5) : '',
    departureFlight: row.departure_flight ?? '',
    departureLocalDate: row.departure_local_date ? String(row.departure_local_date).slice(0, 10) : '',
    departureLocalTime: row.departure_local_time ? String(row.departure_local_time).slice(0, 5) : '',
    roomType: row.room_type,
    recordStatus: row.record_status ?? 'active',
    replacementOf: row.replacement_of,
  }))
}

async function insertEvents(client: PoolClient, events: ReturnType<typeof diffBookings>['events'], fromId: string, toId: string, nowIso: string): Promise<void> {
  for (const event of events) {
    if (!event.groupKey) continue
    await client.query(
      `INSERT INTO change_events (id, group_key, entity_key, kind, before_booking, after_booking, changed_fields, first_detected_at, from_snapshot_id, to_snapshot_id, link_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11)`,
      [randomUUID(), event.groupKey, event.entityKey, event.kind, JSON.stringify(event.before), JSON.stringify(event.after), JSON.stringify(event.changedFields), nowIso, fromId, toId, event.linkKey],
    )
  }
}

async function ensureGroups(client: PoolClient, bookings: readonly CanonicalBooking[], nowIso: string): Promise<void> {
  const keys = new Set<string>()
  for (const booking of bookings) {
    const key = bookingGroupKey(booking)
    if (key) keys.add(key)
  }
  for (const key of [...keys].sort()) {
    const parsed = parseGroupKey(key)
    await client.query(
      `INSERT INTO work_groups (group_key, hotel_id, airport_code, stay_date, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (group_key) DO NOTHING`,
      [key, parsed.hotelId, parsed.airportCode, parsed.stayDate, nowIso],
    )
  }
}

function parseGroupKey(groupKey: string): { hotelId: string | null; airportCode: string; stayDate: string } {
  if (groupKey.startsWith('unresolved|')) {
    const [, airportCode, stayDate] = groupKey.split('|')
    return { hotelId: null, airportCode: airportCode ?? 'XXX', stayDate: stayDate ?? '1970-01-01' }
  }
  const [hotelId, airportCode, stayDate] = groupKey.split('|')
  return { hotelId: hotelId ?? null, airportCode: airportCode ?? 'XXX', stayDate: stayDate ?? '1970-01-01' }
}

async function applyTimers(client: PoolClient, bookings: readonly CanonicalBooking[], nowIso: string): Promise<void> {
  const settings = await client.query<{ quiet_minutes: number }>('SELECT quiet_minutes FROM app_settings WHERE id = 1')
  const quietMinutes = settings.rows[0]?.quiet_minutes ?? 60
  const baselines = await client.query<{ group_key: string; payload: StoredPayload }>(
    `SELECT DISTINCT ON (group_key) group_key, payload FROM notification_baselines ORDER BY group_key, revision_no DESC`,
  )
  const baselineByKey = new Map(baselines.rows.map((row) => [row.group_key, baselineBookingsFromPayload(row.payload)]))
  const grouped = new Map<string, CanonicalBooking[]>()
  for (const booking of bookings) {
    const key = bookingGroupKey(booking)
    if (!key) continue
    const list = grouped.get(key) ?? []
    list.push(booking)
    grouped.set(key, list)
  }
  const existing = await client.query<{ group_key: string; quiet_started_at: string | null; last_fingerprint: string | null }>(
    'SELECT group_key, quiet_started_at, last_fingerprint FROM work_groups ORDER BY group_key FOR UPDATE',
  )
  const keys = new Set<string>([...grouped.keys(), ...baselineByKey.keys(), ...existing.rows.map((row) => row.group_key)])
  const currentByKey = new Map(existing.rows.map((row) => [row.group_key, row]))
  for (const key of [...keys].sort()) {
    const latestGroup = grouped.get(key) ?? []
    const fingerprint = sha256(bookingsFingerprint(latestGroup))
    const current = currentByKey.get(key)
    const baseline = baselineByKey.get(key)
    if (!baseline) {
      await client.query(`UPDATE work_groups SET last_fingerprint = $2, updated_at = $3 WHERE group_key = $1`, [key, fingerprint, nowIso])
      continue
    }
    const net = diffBookings({ before: baseline, after: latestGroup, completeness: 'full' })
    if (net.ambiguous || net.unresolvedAbsences.length > 0) continue
    if (net.events.length === 0) {
      await client.query(
        `UPDATE work_groups SET due_at = NULL, quiet_started_at = NULL, last_fingerprint = $2, updated_at = $3, row_version = row_version + 1 WHERE group_key = $1`,
        [key, fingerprint, nowIso],
      )
      continue
    }
    if (current?.last_fingerprint === fingerprint) continue
    const timer = nextQuietTimer(
      current?.quiet_started_at ? { quietStartedAt: new Date(current.quiet_started_at).toISOString(), lastChangeAt: nowIso, dueAt: nowIso } : undefined,
      nowIso,
      quietMinutes,
    )
    await client.query(
      `UPDATE work_groups SET quiet_started_at = $2, last_change_at = $3, due_at = $4, last_fingerprint = $5, updated_at = $3, row_version = row_version + 1 WHERE group_key = $1`,
      [key, timer.quietStartedAt, timer.lastChangeAt, timer.dueAt, fingerprint],
    )
  }
}

async function insertMappingExceptions(client: PoolClient, issues: Array<{ code: string; groupKey: string | null }>, snapshotId: string): Promise<void> {
  for (const issue of issues) {
    if (!issue.groupKey || issue.code === 'IDENTITY_AMBIGUOUS' || issue.code === 'SOURCE_ROW_INVALID') continue
    await insertException(client, issue.groupKey, issue.code.toLowerCase(), exceptionMessage(issue.code), snapshotId)
  }
}

async function insertCompletenessExceptions(
  client: PoolClient,
  bookings: readonly CanonicalBooking[],
  previous: readonly CanonicalBooking[],
  snapshotId: string,
  completeness: 'full' | 'unknown',
  ambiguous: boolean,
): Promise<void> {
  if (completeness === 'full' && !ambiguous) return
  const keys = new Set<string>()
  for (const booking of [...bookings, ...previous]) {
    const key = bookingGroupKey(booking) ?? (groupKeyOf(booking) ? groupKeyOf(booking) : null)
    if (key) keys.add(key)
  }
  const kind = ambiguous ? 'identity_ambiguous' : 'snapshot_completeness_unknown'
  const message = ambiguous ? 'Нет устойчивого идентификатора заявки' : 'Полнота снимка не подтверждена'
  for (const key of keys) await insertException(client, key, kind, message, snapshotId)
}

async function insertException(client: PoolClient, groupKey: string, kind: string, message: string, snapshotId: string): Promise<void> {
  const existing = await client.query(
    `SELECT 1 FROM exceptions WHERE group_key = $1 AND kind = $2 AND snapshot_id = $3 AND status <> 'resolved' LIMIT 1`,
    [groupKey, kind, snapshotId],
  )
  if (existing.rows.length > 0) return
  await client.query(
    `INSERT INTO exceptions (group_key, kind, severity, status, message, snapshot_id) VALUES ($1, $2, 'blocking', 'open', $3, $4)`,
    [groupKey, kind, message, snapshotId],
  )
}

function exceptionMessage(code: string): string {
  if (code === 'HOTEL_MAPPING_AMBIGUOUS') return 'По аэропорту несколько гостиниц, выбор не сделан'
  if (code === 'HOTEL_MAPPING_MISSING') return 'Нет утверждённого сопоставления гостиницы'
  if (code === 'UNKNOWN_HOTEL') return 'Гостиница из источника отсутствует в справочнике'
  if (code === 'IDENTITY_AMBIGUOUS') return 'Нет устойчивого идентификатора заявки'
  return 'Строка источника не принята'
}
