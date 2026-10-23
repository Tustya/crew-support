import type { PoolClient } from 'pg'
import type { CanonicalBooking, ChangeEvent } from '../domain/diff.ts'
import { sourceProblem, loadState, projectGroups, type QueueGroup } from './state.ts'

const WRITE_CHUNK = 200

const FIELD_LABELS: Record<string, string> = {
  fullName: 'ФИО',
  arrivalFlight: 'Рейс прибытия',
  arrivalLocalDate: 'Дата прилёта',
  arrivalLocalTime: 'Время прилёта',
  departureFlight: 'Рейс вылета',
  departureLocalDate: 'Дата вылета',
  departureLocalTime: 'Время вылета',
  roomType: 'Тип номера',
  gender: 'Пол',
  hotelId: 'Гостиница',
  localStayDate: 'Дата размещения',
  recordStatus: 'Состояние заявки',
}

const RECORD_STATUS: Record<string, string> = { active: 'активна', cancelled: 'отмена' }

const STATUS_RANK = `CASE q.status
  WHEN 'needs_decision' THEN 0
  WHEN 'needs_baseline' THEN 1
  WHEN 'stale' THEN 2
  WHEN 'needs_review' THEN 3
  WHEN 'reviewed' THEN 4
  WHEN 'preparing' THEN 5
  WHEN 'waiting' THEN 6
  WHEN 'handed_off' THEN 7
  WHEN 'sent' THEN 8
  ELSE 9
END`

const IN_WINDOW = `(
  settings.stay_scope = 'both'
  OR q.hotel_id IS NULL
  OR (settings.stay_scope = 'today' AND q.stay_date = timezone(q.hotel_timezone, $1::timestamptz)::date)
  OR (settings.stay_scope = 'tomorrow' AND q.stay_date = (timezone(q.hotel_timezone, $1::timestamptz)::date + 1))
)`

export interface PublicQueueGroup {
  id: string
  groupKey: string
  hotel: { id: string; name: string; timezone: string; city: string } | null
  airportCode: string
  stayDate: string
  status: string
  changeCount: number
  changes: unknown
  lastMeaningfulChangeAt: string | null
  dueAt: string | null
  draftId: string | null
  draftStatus: string | null
  revision: number | null
  version: number
  exceptions: unknown
  crewNames: string[]
}

interface QueueFilter {
  basis: 'baseline' | 'previous'
  corrections: boolean
  limit: number
  offset: number
  status: string | null
  airport: string | null
  date: string | null
  hotel: string | null
  query: string | null
}

export async function rebuildQueueViews(client: PoolClient, now: Date, groupKey?: string): Promise<void> {
  const state = await loadState(client, groupKey)
  const bases: Array<'baseline' | 'previous'> = groupKey ? ['baseline'] : ['baseline', 'previous']
  if (groupKey) {
    await client.query(`DELETE FROM queue_views WHERE basis = 'baseline' AND group_key = $1`, [groupKey])
  } else {
    await client.query('DELETE FROM queue_views')
  }
  const hotels = new Map(state.hotels.map((hotel) => [hotel.id, hotel.name]))
  for (const basis of bases) {
    await insertViews(client, projectGroups(state, now, basis), basis, hotels)
  }
  await client.query('UPDATE app_settings SET data_generation = data_generation + 1 WHERE id = 1')
}

export async function readOverviewCounts(client: PoolClient, now: Date): Promise<Record<string, number>> {
  const rows = await client.query<{ status: string; count: number }>(
    `SELECT q.status, count(*)::int AS count
     FROM queue_views q CROSS JOIN app_settings settings
     WHERE q.basis = 'baseline' AND ${IN_WINDOW}
     GROUP BY q.status`,
    [now.toISOString()],
  )
  const counts: Record<string, number> = {}
  for (const row of rows.rows) counts[row.status] = row.count
  return counts
}

export async function readSourceFacts(client: PoolClient, now: Date): Promise<{
  adapterReady: { lastRunStatus: string | null; lastSuccessAt: string | null; latest: { validationStatus: string } | null; settings: { staleAfterMinutes: number } }
  lastErrorCode: string | null
  latestSnapshotId: string | null
  validationStatus: string | null
  problem: string | null
}> {
  const settings = await client.query<{ stale_after_minutes: number }>('SELECT stale_after_minutes FROM app_settings WHERE id = 1')
  const lastRun = await client.query<{ status: string; error_code: string | null }>('SELECT status, error_code FROM source_runs ORDER BY started_at DESC LIMIT 1')
  const lastSuccess = await client.query<{ finished_at: Date | string }>('SELECT finished_at FROM source_runs WHERE status = $1 ORDER BY finished_at DESC LIMIT 1', ['succeeded'])
  const latest = await client.query<{ id: string; validation_status: string }>('SELECT id, validation_status FROM snapshots ORDER BY fetched_at DESC, seq DESC LIMIT 1')
  const head = latest.rows[0]
  const facts = {
    lastRunStatus: lastRun.rows[0]?.status ?? null,
    lastSuccessAt: asIso(lastSuccess.rows[0]?.finished_at ?? null),
    latest: head ? { validationStatus: head.validation_status } : null,
    settings: { staleAfterMinutes: Number(settings.rows[0]?.stale_after_minutes ?? 15) },
  }
  return {
    adapterReady: facts,
    lastErrorCode: lastRun.rows[0]?.error_code ?? null,
    latestSnapshotId: head?.id ?? null,
    validationStatus: head?.validation_status ?? null,
    problem: sourceProblem(facts, now),
  }
}

export async function readQueueGroup(client: PoolClient, groupId: string): Promise<PublicQueueGroup | null> {
  const rows = await client.query<QueueRow>(`${selectColumns()} FROM queue_views q WHERE q.group_id = $1 AND q.basis = 'baseline'`, [groupId])
  const row = rows.rows[0]
  return row ? mapRow(row) : null
}

export async function readQueuePage(client: PoolClient, now: Date, filter: QueueFilter): Promise<{ items: PublicQueueGroup[]; total: number }> {
  const values: unknown[] = [now.toISOString(), filter.basis]
  const clauses = ['q.basis = $2', IN_WINDOW]
  if (filter.corrections) clauses.push(`($2 = 'previous' OR q.has_baseline OR q.change_count > 0)`)
  if (filter.status) {
    values.push(filter.status)
    clauses.push(`q.status = $${values.length}`)
  }
  if (filter.airport) {
    values.push(filter.airport.toUpperCase())
    clauses.push(`q.airport_code = $${values.length}`)
  }
  if (filter.date && /^\d{4}-\d{2}-\d{2}$/.test(filter.date)) {
    values.push(filter.date)
    clauses.push(`q.stay_date = $${values.length}::date`)
  } else if (filter.date) {
    clauses.push('false')
  }
  if (filter.hotel && /^[0-9a-f-]{36}$/i.test(filter.hotel)) {
    values.push(filter.hotel)
    clauses.push(`q.hotel_id = $${values.length}::uuid`)
  } else if (filter.hotel) {
    clauses.push('false')
  }
  if (filter.query) {
    values.push(`%${filter.query.replace(/[\\%_]/g, '\\$&')}%`)
    const pattern = `$${values.length}`
    clauses.push(`(
      q.hotel_name ILIKE ${pattern} ESCAPE '\\'
      OR q.hotel_city ILIKE ${pattern} ESCAPE '\\'
      OR q.airport_code ILIKE ${pattern} ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM unnest(q.crew_names) AS crew_name WHERE crew_name ILIKE ${pattern} ESCAPE '\\')
    )`)
  }
  values.push(filter.limit, filter.offset)
  const rows = await client.query<QueueRow & { total_count: number }>(
    `${selectColumns()}, count(*) OVER() AS total_count
     FROM queue_views q CROSS JOIN app_settings settings
     WHERE ${clauses.join(' AND ')}
     ORDER BY ${STATUS_RANK}, q.hotel_name, q.stay_date, q.group_id
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  )
  return { items: rows.rows.map(mapRow), total: Number(rows.rows[0]?.total_count ?? 0) }
}

async function insertViews(client: PoolClient, groups: QueueGroup[], basis: 'baseline' | 'previous', hotels: Map<string, string>): Promise<void> {
  for (let offset = 0; offset < groups.length; offset += WRITE_CHUNK) {
    const slice = groups.slice(offset, offset + WRITE_CHUNK)
    await client.query(
      `INSERT INTO queue_views (
        group_id, basis, status, change_count, crew_names, changes, exceptions, draft_id, draft_status, revision, due_at,
        stay_date, airport_code, hotel_id, hotel_name, hotel_city, hotel_timezone, group_key, hotel, last_change_at, version, has_baseline
      )
      SELECT group_id, $1, status, change_count, ARRAY(SELECT jsonb_array_elements_text(row.crew_names::jsonb)), changes::jsonb, exceptions::jsonb, draft_id, draft_status, revision, due_at::timestamptz,
             stay_date::date, airport_code, hotel_id, hotel_name, hotel_city, hotel_timezone, group_key, hotel::jsonb, last_change_at::timestamptz, version, has_baseline
      FROM unnest(
        $2::uuid[], $3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::uuid[], $9::text[], $10::int[], $11::text[],
        $12::text[], $13::text[], $14::uuid[], $15::text[], $16::text[], $17::text[], $18::text[], $19::text[], $20::text[], $21::bigint[], $22::boolean[]
      ) AS row(
        group_id, status, change_count, crew_names, changes, exceptions, draft_id, draft_status, revision, due_at,
        stay_date, airport_code, hotel_id, hotel_name, hotel_city, hotel_timezone, group_key, hotel, last_change_at, version, has_baseline
      )`,
      [
        basis,
        slice.map((group) => group.id),
        slice.map((group) => group.status),
        slice.map((group) => group.changeCount),
        slice.map((group) => JSON.stringify(group.latestBookings.map((booking) => booking.fullName))),
        slice.map((group) => JSON.stringify(slimChanges(group.changes, hotels))),
        slice.map((group) => JSON.stringify(group.exceptions)),
        slice.map((group) => group.draftId),
        slice.map((group) => group.draftStatus),
        slice.map((group) => group.revision),
        slice.map((group) => group.dueAt),
        slice.map((group) => group.stayDate),
        slice.map((group) => group.airportCode),
        slice.map((group) => group.hotel?.id ?? null),
        slice.map((group) => group.hotel?.name ?? ''),
        slice.map((group) => group.hotel?.city ?? ''),
        slice.map((group) => group.hotel?.timezone ?? 'UTC'),
        slice.map((group) => group.groupKey),
        slice.map((group) => JSON.stringify(group.hotel)),
        slice.map((group) => group.lastMeaningfulChangeAt),
        slice.map((group) => group.version),
        slice.map((group) => group.baselineBookings !== null),
      ],
    )
  }
}

function slimChanges(events: ChangeEvent[], hotels: Map<string, string>) {
  return events.map((event) => ({
    entityKey: event.entityKey,
    groupKey: event.groupKey,
    kind: event.kind,
    fullName: event.after?.fullName ?? event.before?.fullName ?? '—',
    linkedGroupKey: event.linkedGroupKey,
    replacement: Boolean(event.after?.replacementOf),
    fields: event.kind === 'cancelled'
      ? [{ field: 'recordStatus', label: FIELD_LABELS.recordStatus ?? 'recordStatus', before: 'активна', after: 'отмена' }]
      : event.changedFields
          .map((field) => ({
            field,
            label: FIELD_LABELS[field] ?? field,
            before: displayValue(event.before, field, hotels),
            after: displayValue(event.after, field, hotels),
          }))
          .filter((delta) => delta.before !== delta.after),
  }))
}

function displayValue(booking: CanonicalBooking | null, field: string, hotels: Map<string, string>): string {
  if (!booking) return ''
  const value = (booking as unknown as Record<string, unknown>)[field]
  if (field === 'recordStatus') return RECORD_STATUS[String(value)] ?? ''
  if (field === 'hotelId') return value ? (hotels.get(String(value)) ?? '') : ''
  return value === null || value === undefined ? '' : String(value)
}

interface QueueRow {
  group_id: string
  group_key: string
  hotel: { id: string; name: string; timezone: string; city: string } | null
  airport_code: string
  stay_date: string
  status: string
  change_count: number
  changes: unknown
  last_change_at: Date | string | null
  due_at: Date | string | null
  draft_id: string | null
  draft_status: string | null
  revision: number | null
  version: string | number
  exceptions: unknown
  crew_names: string[]
}

function selectColumns(): string {
  return `SELECT q.group_id, q.group_key, q.hotel, q.airport_code, to_char(q.stay_date, 'YYYY-MM-DD') AS stay_date, q.status, q.change_count,
    q.changes, q.last_change_at, q.due_at, q.draft_id, q.draft_status, q.revision, q.version, q.exceptions, q.crew_names`
}

function mapRow(row: QueueRow): PublicQueueGroup {
  return {
    id: row.group_id,
    groupKey: row.group_key,
    hotel: row.hotel,
    airportCode: row.airport_code,
    stayDate: row.stay_date,
    status: row.status,
    changeCount: row.change_count,
    changes: row.changes,
    lastMeaningfulChangeAt: asIso(row.last_change_at),
    dueAt: asIso(row.due_at),
    draftId: row.draft_id,
    draftStatus: row.draft_status,
    revision: row.revision === null ? null : Number(row.revision),
    version: Number(row.version),
    exceptions: row.exceptions,
    crewNames: row.crew_names,
  }
}

function asIso(value: Date | string | null): string | null {
  if (!value) return null
  return new Date(value).toISOString()
}
