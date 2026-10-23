import type { PoolClient } from 'pg'
import { sha256Hex } from '../domain/hash.ts'
import { isValidTimeZone } from '../domain/time.ts'
import { templateProblems, type MailTemplate, type TemplateBlock } from '../domain/templates.ts'
import { HttpError } from '../errors.ts'
import { writeAudit } from './audit.ts'
import { rebuildQueueViews } from './queueView.ts'
import type { Actor } from './state.ts'

const EMAIL = /^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i

export async function createHotel(
  client: PoolClient,
  actor: Actor,
  now: Date,
  correlationId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const hotel = parseHotel(body)
  const inserted = await client.query<{ id: string; row_version: number }>(
    `INSERT INTO hotels (source_hotel_id, name, city, airport_code, timezone, recipients, cc, contract_status, active, comment, recipient_source)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, 'local') RETURNING id, row_version`,
    [hotel.sourceHotelId, hotel.name, hotel.city, hotel.airportCode, hotel.timezone, JSON.stringify(hotel.recipients), JSON.stringify(hotel.cc), hotel.contractStatus, hotel.active, hotel.comment],
  )
  const row = inserted.rows[0]
  await writeAudit(client, audit(actor, now, correlationId, 'hotel.created', row?.id ?? null, { airport: hotel.airportCode }))
  return { id: row?.id, version: Number(row?.row_version ?? 1), ...publicHotel(hotel) }
}

export async function patchHotel(
  client: PoolClient,
  actor: Actor,
  now: Date,
  correlationId: string,
  hotelId: string,
  expectedVersion: number,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const current = await client.query<{ row_version: number }>('SELECT row_version FROM hotels WHERE id = $1 FOR UPDATE', [hotelId])
  const row = current.rows[0]
  if (!row) throw new HttpError(404, 'HOTEL_NOT_FOUND', 'Гостиница не найдена')
  if (Number(row.row_version) !== expectedVersion) throw new HttpError(412, 'VERSION_CONFLICT', 'Гостиницу уже изменили')
  const hotel = parseHotel(body)
  const updated = await client.query<{ row_version: number }>(
    `UPDATE hotels SET source_hotel_id = $2, name = $3, city = $4, airport_code = $5, timezone = $6, recipients = $7::jsonb, cc = $8::jsonb,
      contract_status = $9, active = $10, comment = $11, row_version = row_version + 1, updated_at = $12 WHERE id = $1 RETURNING row_version`,
    [hotelId, hotel.sourceHotelId, hotel.name, hotel.city, hotel.airportCode, hotel.timezone, JSON.stringify(hotel.recipients), JSON.stringify(hotel.cc), hotel.contractStatus, hotel.active, hotel.comment, now.toISOString()],
  )
  await writeAudit(client, audit(actor, now, correlationId, 'hotel.updated', hotelId, { airport: hotel.airportCode }))
  await rebuildQueueViews(client, now)
  return { id: hotelId, version: Number(updated.rows[0]?.row_version ?? expectedVersion + 1), ...publicHotel(hotel) }
}

function parseHotel(body: Record<string, unknown>) {
  const name = text(body.name, 200)
  const city = text(body.city, 120)
  const airportCode = text(body.airportCode, 3).toUpperCase()
  const timezone = text(body.timezone, 80)
  const contractStatus = body.contractStatus
  const active = body.active !== false
  if (!/^[A-Z]{3}$/.test(airportCode)) throw new HttpError(422, 'AIRPORT_INVALID', 'Код аэропорта должен быть IATA')
  if (!isValidTimeZone(timezone)) throw new HttpError(422, 'TIMEZONE_INVALID', 'Нужна IANA timezone аэропорта')
  if (contractStatus !== 'confirmed' && contractStatus !== 'none' && contractStatus !== 'unknown') throw new HttpError(422, 'CONTRACT_INVALID', 'Статус договора не распознан')
  if (body.recipientSource === 'aviabit') throw new HttpError(422, 'SOURCE_NOT_CONFIGURED', 'Получатели Aviabit не подключаются из формы')
  return {
    sourceHotelId: body.sourceHotelId === null || body.sourceHotelId === undefined || body.sourceHotelId === '' ? null : text(body.sourceHotelId, 80),
    name,
    city,
    airportCode,
    timezone,
    recipients: emails(body.recipients),
    cc: emails(body.cc ?? []),
    contractStatus,
    active,
    comment: typeof body.comment === 'string' ? body.comment.slice(0, 500) : '',
  }
}

function publicHotel(hotel: ReturnType<typeof parseHotel>): Record<string, unknown> {
  return hotel
}

export async function patchSettings(
  client: PoolClient,
  actor: Actor,
  now: Date,
  correlationId: string,
  expectedVersion: number,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const allowed = new Set(['pollMinutes', 'quietMinutes', 'autoCheck', 'autoPrepare', 'stayScope', 'staleAfterMinutes', 'senderName'])
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new HttpError(422, 'FIELD_NOT_ALLOWED', 'Поле настройки недоступно')
  }
  if (actor.role === 'specialist' && Object.keys(body).some((key) => key !== 'quietMinutes')) throw new HttpError(403, 'FORBIDDEN', 'Недостаточно прав')
  const current = await client.query<{
    poll_minutes: number
    quiet_minutes: number
    auto_check: boolean
    auto_prepare: boolean
    stay_scope: string
    stale_after_minutes: number
    sender_name: string
    row_version: number
    template_version: number
  }>('SELECT * FROM app_settings WHERE id = 1 FOR UPDATE')
  const row = current.rows[0]
  if (!row || Number(row.row_version) !== expectedVersion) throw new HttpError(412, 'VERSION_CONFLICT', 'Настройки уже изменены')
  const quietMinutes = numberField(body.quietMinutes, row.quiet_minutes)
  const pollMinutes = numberField(body.pollMinutes, row.poll_minutes)
  const staleAfterMinutes = numberField(body.staleAfterMinutes, row.stale_after_minutes)
  const stayScope = body.stayScope ?? row.stay_scope
  if (quietMinutes < 1 || quietMinutes > 120 || pollMinutes < 1 || pollMinutes > 60) throw new HttpError(422, 'RANGE_INVALID', 'Интервал вне допустимых границ')
  if (staleAfterMinutes < pollMinutes) throw new HttpError(422, 'RANGE_INVALID', 'Порог устаревания не может быть меньше периода проверки')
  if (stayScope !== 'today' && stayScope !== 'tomorrow' && stayScope !== 'both') throw new HttpError(422, 'RANGE_INVALID', 'Период размещения не распознан')
  const senderName = body.senderName === undefined ? row.sender_name : text(body.senderName, 120)
  const updated = await client.query<{ row_version: number }>(
    `UPDATE app_settings SET poll_minutes = $1, quiet_minutes = $2, auto_check = $3, auto_prepare = $4, stay_scope = $5,
      stale_after_minutes = $6, sender_name = $7, row_version = row_version + 1, updated_at = $8 WHERE id = 1 RETURNING row_version`,
    [pollMinutes, quietMinutes, booleanField(body.autoCheck, row.auto_check), booleanField(body.autoPrepare, row.auto_prepare), stayScope, staleAfterMinutes, senderName, now.toISOString()],
  )
  if (quietMinutes !== row.quiet_minutes) {
    await client.query(
      `UPDATE work_groups SET due_at = last_change_at + make_interval(mins => $1), row_version = row_version + 1, updated_at = $2
       WHERE due_at IS NOT NULL AND last_change_at IS NOT NULL`,
      [quietMinutes, now.toISOString()],
    )
  }
  await writeAudit(client, audit(actor, now, correlationId, 'settings.updated', '1', { quietMinutes }))
  await rebuildQueueViews(client, now)
  return { version: Number(updated.rows[0]?.row_version), pollMinutes, quietMinutes, autoCheck: booleanField(body.autoCheck, row.auto_check), autoPrepare: booleanField(body.autoPrepare, row.auto_prepare), stayScope, staleAfterMinutes, senderName, templateVersion: row.template_version, requireHumanReview: true }
}

export async function publishTemplate(
  client: PoolClient,
  actor: Actor,
  now: Date,
  correlationId: string,
  templateKey: string,
  body: Record<string, unknown>,
): Promise<{ version: number }> {
  if (templateKey !== 'adjustment' && templateKey !== 'new_booking' && templateKey !== 'cancellation') throw new HttpError(404, 'TEMPLATE_NOT_FOUND', 'Шаблон не найден')
  const template: MailTemplate = {
    templateKey,
    blocks: Array.isArray(body.blocks) ? (body.blocks as TemplateBlock[]) : [],
    columns: Array.isArray(body.columns) ? body.columns as MailTemplate['columns'] : [],
    newLabel: text(body.newLabel, 80),
    cancelLabel: text(body.cancelLabel, 80),
  }
  const problems = templateProblems(template)
  if (problems.length > 0) throw new HttpError(422, 'TEMPLATE_INVALID', problems[0] ?? 'Шаблон отклонён')
  const next = await client.query<{ version: number }>('SELECT COALESCE(MAX(version), 0) + 1 AS version FROM template_versions WHERE template_key = $1', [templateKey])
  const version = Number(next.rows[0]?.version ?? 1)
  await client.query(
    `INSERT INTO template_versions (template_key, version, blocks, columns, new_label, cancel_label, author_id) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)`,
    [templateKey, version, JSON.stringify(template.blocks), JSON.stringify(template.columns), template.newLabel, template.cancelLabel, actor.id],
  )
  await client.query('UPDATE app_settings SET template_version = template_version + 1, row_version = row_version + 1, updated_at = $1 WHERE id = 1', [now.toISOString()])
  await writeAudit(client, audit(actor, now, correlationId, 'template.published', templateKey, { version }))
  await rebuildQueueViews(client, now)
  return { version }
}

export async function holdException(client: PoolClient, actor: Actor, now: Date, correlationId: string, exceptionId: string, comment: string): Promise<void> {
  if (comment.trim().length < 3) throw new HttpError(422, 'COMMENT_REQUIRED', 'Нужен комментарий')
  const result = await client.query(`UPDATE exceptions SET status = 'held', resolution = $2, updated_at = $3 WHERE id = $1 AND status <> 'resolved'`, [exceptionId, comment.trim().slice(0, 500), now.toISOString()])
  if (result.rowCount === 0) throw new HttpError(404, 'EXCEPTION_NOT_FOUND', 'Исключение не найдено')
  await writeAudit(client, audit(actor, now, correlationId, 'exception.held', exceptionId, {}))
  await rebuildQueueViews(client, now)
}

export async function resolveException(
  client: PoolClient,
  actor: Actor,
  now: Date,
  correlationId: string,
  exceptionId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const reason = text(body.reason, 500)
  const row = await client.query<{ kind: string; status: string }>('SELECT kind, status FROM exceptions WHERE id = $1 FOR UPDATE', [exceptionId])
  const exception = row.rows[0]
  if (!exception || exception.status === 'resolved') throw new HttpError(404, 'EXCEPTION_NOT_FOUND', 'Исключение не найдено')
  if (['identity_ambiguous', 'hotel_mapping_missing', 'hotel_mapping_ambiguous', 'unknown_hotel', 'snapshot_completeness_unknown'].includes(exception.kind)) {
    throw new HttpError(403, 'MAPPING_RESOLUTION_DISABLED', 'Ручное сопоставление источника отключено')
  }
  if (exception.kind === 'no_contract' || exception.kind === 'contract_status') throw new HttpError(409, 'DIRECTORY_STATE_REQUIRED', 'Договор меняется в справочнике, не комментарием')
  if (exception.kind !== 'manual') throw new HttpError(409, 'RESOLUTION_NOT_ALLOWED', 'Этот тип нельзя закрыть комментарием')
  await client.query(`UPDATE exceptions SET status = 'resolved', resolution = $2, resolution_type = 'manual', resolved_by = $3, resolved_at = $4, updated_at = $4 WHERE id = $1`, [
    exceptionId,
    reason,
    actor.id,
    now.toISOString(),
  ])
  await writeAudit(client, audit(actor, now, correlationId, 'exception.resolved', exceptionId, {}))
  await rebuildQueueViews(client, now)
}

export async function recordRejectedImport(
  client: PoolClient,
  actor: Actor,
  now: Date,
  correlationId: string,
  file: { filename: string; bytes: Buffer },
): Promise<string> {
  const filename = file.filename.split(/[/\\]/).pop()?.replace(/[^A-Za-z0-9._-]/g, '_')?.slice(0, 120) || 'upload'
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO import_batches (filename_sanitized, format, sha256, size_bytes, status, schema_version, error_report_safe, created_by)
     VALUES ($1, 'unverified', $2, $3, 'rejected', 'AVIABIT_VISIBLE_COLUMNS_V0', $4::jsonb, $5) RETURNING id`,
    [filename, sha256Hex(file.bytes), file.bytes.length, JSON.stringify({ code: 'SOURCE_SCHEMA_UNVERIFIED' }), actor.id],
  )
  const id = inserted.rows[0]?.id ?? ''
  await writeAudit(client, audit(actor, now, correlationId, 'import.rejected', id, { bytes: file.bytes.length }))
  return id
}

export async function recordAcceptedImport(
  client: PoolClient,
  actor: Actor,
  now: Date,
  correlationId: string,
  file: { filename: string; bytes: Buffer; snapshotId: string; rowCount: number },
): Promise<string> {
  const filename = file.filename.split(/[/\\]/).pop()?.replace(/[^A-Za-z0-9._-]/g, '_')?.slice(0, 120) || 'upload'
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO import_batches (filename_sanitized, format, sha256, size_bytes, status, schema_version, row_count, result_snapshot_id, created_by)
     VALUES ($1, 'xlsx', $2, $3, 'accepted', 'AVIABIT_VISIBLE_COLUMNS_V0', $4, $5, $6) RETURNING id`,
    [filename, sha256Hex(file.bytes), file.bytes.length, file.rowCount, file.snapshotId, actor.id],
  )
  const id = inserted.rows[0]?.id ?? ''
  await writeAudit(client, audit(actor, now, correlationId, 'import.accepted', id, { rows: file.rowCount }))
  return id
}

function audit(actor: Actor, now: Date, correlationId: string, action: string, entityId: string | null, details: Record<string, string | number | boolean | null>) {
  return {
    occurredAt: now.toISOString(),
    actorId: actor.id,
    serviceActor: null,
    action,
    entityType: action.split('.')[0] ?? 'entity',
    entityId,
    groupKey: null,
    result: 'ok' as const,
    details,
    correlationId,
  }
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new HttpError(422, 'FIELD_INVALID', 'Поле заполнено некорректно')
  return value.trim()
}

function emails(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(422, 'RECIPIENT_INVALID', 'Список адресов некорректен')
  const unique = [...new Set(value.map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : '')))].filter(Boolean)
  if (unique.some((item) => item.length > 254 || !EMAIL.test(item))) throw new HttpError(422, 'RECIPIENT_INVALID', 'Адрес некорректен')
  return unique
}

function numberField(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new HttpError(422, 'RANGE_INVALID', 'Ожидается целое число')
  return value
}

function booleanField(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new HttpError(422, 'FIELD_INVALID', 'Ожидается да или нет')
  return value
}
