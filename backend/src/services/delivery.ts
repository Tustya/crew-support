import type { PoolClient } from 'pg'
import { sha256 } from '../domain/hash.ts'
import { baselineBookingsFromPayload, selectConfirmedPayload, type StoredPayload } from '../domain/payload.ts'
import { HttpError } from '../errors.ts'
import type { AppConfig } from '../config.ts'
import { writeAudit } from './audit.ts'
import { letterFingerprint } from './drafts.ts'
import { rebuildQueueViews } from './queueView.ts'
import { groupById, loadState, sourceProblem, type Actor } from './state.ts'
import { diffBookings } from '../domain/diff.ts'
import { nextQuietTimer } from '../domain/timer.ts'
import { bookingsFingerprint } from '../domain/diff.ts'

const SYNTHETIC = /(^|\.)example\.(com|org|net)$|^localhost$/

export async function handoffDraft(
  client: PoolClient,
  input: { draftId: string; actor: Actor; now: Date; correlationId: string; revision: number; idempotencyKey: string },
): Promise<{ notificationId: string; transportStatus: string }> {
  const replay = await claimIdempotency(client, `handoff:${input.draftId}`, input.idempotencyKey, sha256(String(input.revision)))
  if (replay) return replay
  const prepared = await assertReviewed(client, input)
  const notification = await client.query<{ id: string }>(
    `INSERT INTO notifications (draft_version_id, group_key, transport_operation, transport_status, actor_id, archived_payload)
     VALUES ($1, $2, 'handoff', 'handed_off', $3, $4::jsonb) RETURNING id`,
    [prepared.versionId, prepared.groupKey, input.actor.id, JSON.stringify(prepared.payload)],
  )
  const notificationId = notification.rows[0]?.id ?? ''
  await client.query(`UPDATE drafts SET status = 'handed_off', updated_at = $2, row_version = row_version + 1 WHERE id = $1`, [input.draftId, input.now.toISOString()])
  const body = { notificationId, transportStatus: 'handed_off' }
  await completeIdempotency(client, `handoff:${input.draftId}`, input.idempotencyKey, 200, body)
  await writeAudit(client, {
    occurredAt: input.now.toISOString(),
    actorId: input.actor.id,
    serviceActor: null,
    action: 'draft.handed_off',
    entityType: 'notification',
    entityId: notificationId,
    groupKey: prepared.groupKey,
    result: 'ok',
    details: { revision: input.revision },
    correlationId: input.correlationId,
  })
  await rebuildQueueViews(client, input.now, prepared.groupKey)
  return body
}

export async function beginSend(
  client: PoolClient,
  config: AppConfig,
  input: { draftId: string; actor: Actor; now: Date; correlationId: string; revision: number; idempotencyKey: string; confirmed: boolean },
): Promise<{ notificationId: string; transportStatus: string; pending: boolean }> {
  if (config.mailAdapter === 'disabled') throw new HttpError(503, 'MAIL_NOT_CONFIGURED', 'Почтовый шлюз не настроен')
  if (!input.confirmed) throw new HttpError(422, 'CONFIRMATION_REQUIRED', 'Нужно явное подтверждение')
  const replay = await claimIdempotency(client, `send:${input.draftId}`, input.idempotencyKey, sha256(`send:${input.revision}`))
  if (replay) return { ...replay, pending: false }
  const prepared = await assertReviewed(client, input)
  const recipients = [...prepared.recipients, ...prepared.cc]
  if (!config.allowSyntheticRecipients && recipients.some((email) => SYNTHETIC.test(email.split('@')[1] ?? email))) {
    throw new HttpError(422, 'DEMO_RECIPIENT_FORBIDDEN', 'Синтетический адрес нельзя отправить')
  }
  const existing = await client.query<{ id: string; transport_status: string }>(
    `SELECT id, transport_status FROM notifications WHERE draft_version_id = $1 AND transport_operation = 'send'`,
    [prepared.versionId],
  )
  const current = existing.rows[0]
  if (current && current.transport_status !== 'send_failed') throw new HttpError(409, 'DELIVERY_UNKNOWN', 'Повторная отправка этой версии заблокирована')
  let notificationId = current?.id
  if (!notificationId) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO notifications (draft_version_id, group_key, transport_operation, transport_status, actor_id, archived_payload)
       VALUES ($1, $2, 'send', 'sending', $3, $4::jsonb) RETURNING id`,
      [prepared.versionId, prepared.groupKey, input.actor.id, JSON.stringify(prepared.payload)],
    )
    notificationId = inserted.rows[0]?.id
  } else {
    await client.query(`UPDATE notifications SET transport_status = 'sending', updated_at = $2 WHERE id = $1`, [notificationId, input.now.toISOString()])
  }
  await client.query(
    `INSERT INTO delivery_attempts (notification_id, request_key, started_at, result) VALUES ($1, $2, $3, 'pending')`,
    [notificationId, input.idempotencyKey, input.now.toISOString()],
  )
  await client.query(`UPDATE drafts SET status = 'sending', updated_at = $2 WHERE id = $1`, [input.draftId, input.now.toISOString()])
  const body = { notificationId: notificationId ?? '', transportStatus: 'sending' }
  await completeIdempotency(client, `send:${input.draftId}`, input.idempotencyKey, 202, body)
  return { ...body, pending: true }
}

export async function finishSend(
  client: PoolClient,
  input: { notificationId: string; outcome: 'accept' | 'reject' | 'timeout'; now: Date; correlationId: string; actorId: string },
): Promise<{ notificationId: string; transportStatus: string }> {
  const notification = await client.query<{ id: string; group_key: string; archived_payload: StoredPayload; transport_status: string }>(
    'SELECT id, group_key, archived_payload, transport_status FROM notifications WHERE id = $1 FOR UPDATE',
    [input.notificationId],
  )
  const row = notification.rows[0]
  if (!row) throw new HttpError(404, 'NOTIFICATION_NOT_FOUND', 'Уведомление не найдено')
  if (input.outcome === 'timeout') {
    await client.query(`UPDATE delivery_attempts SET result = 'unknown', finished_at = $2, error_code = 'DELIVERY_UNKNOWN' WHERE notification_id = $1 AND result = 'pending'`, [
      row.id,
      input.now.toISOString(),
    ])
    await client.query(`UPDATE notifications SET transport_status = 'delivery_unknown', updated_at = $2 WHERE id = $1`, [row.id, input.now.toISOString()])
    await writeAudit(client, audit(input, row.group_key, 'delivery.unknown', row.id))
    await rememberDelivery(client, row.id, 'delivery_unknown')
    await rebuildQueueViews(client, input.now, row.group_key)
    return { notificationId: row.id, transportStatus: 'delivery_unknown' }
  }
  if (input.outcome === 'reject') {
    await client.query(`UPDATE delivery_attempts SET result = 'rejected', finished_at = $2, error_code = 'PROVIDER_REJECTED' WHERE notification_id = $1 AND result = 'pending'`, [
      row.id,
      input.now.toISOString(),
    ])
    await client.query(`UPDATE notifications SET transport_status = 'send_failed', updated_at = $2 WHERE id = $1`, [row.id, input.now.toISOString()])
    await client.query(`UPDATE drafts SET status = 'send_failed', updated_at = $2 WHERE group_key = $1 AND status = 'sending'`, [row.group_key, input.now.toISOString()])
    await writeAudit(client, audit(input, row.group_key, 'delivery.rejected', row.id))
    await rememberDelivery(client, row.id, 'send_failed')
    await rebuildQueueViews(client, input.now, row.group_key)
    return { notificationId: row.id, transportStatus: 'send_failed' }
  }
  const latest = await latestPayload(client, row.group_key)
  const archived = selectConfirmedPayload(row.archived_payload, latest)
  await client.query(`UPDATE delivery_attempts SET result = 'accepted', finished_at = $2, error_code = NULL WHERE notification_id = $1 AND result = 'pending'`, [
    row.id,
    input.now.toISOString(),
  ])
  await client.query(`UPDATE notifications SET transport_status = 'sent', sent_at = $2, updated_at = $2 WHERE id = $1`, [row.id, input.now.toISOString()])
  await client.query(`UPDATE drafts SET status = 'sent', updated_at = $2 WHERE group_key = $1 AND status = 'sending'`, [row.group_key, input.now.toISOString()])
  await writeBaseline(client, row.group_key, archived, row.id, 'send', input.actorId, input.now.toISOString(), null)
  await refreshTimer(client, row.group_key, input.now.toISOString())
  await writeAudit(client, audit(input, row.group_key, 'delivery.sent', row.id))
  await rememberDelivery(client, row.id, 'sent')
  await rebuildQueueViews(client, input.now, row.group_key)
  return { notificationId: row.id, transportStatus: 'sent' }
}

export async function confirmExternal(
  client: PoolClient,
  input: { notificationId: string; actor: Actor; now: Date; correlationId: string; basis: string; sentAt: string; confirmed: boolean },
): Promise<{ baselineRevision: number; groupKey: string }> {
  if (!input.confirmed) throw new HttpError(422, 'CONFIRMATION_REQUIRED', 'Нужно явное подтверждение')
  if (input.basis.trim().length < 3 || input.basis.length > 500) throw new HttpError(422, 'BASIS_REQUIRED', 'Нужно основание подтверждения')
  const sentAt = new Date(input.sentAt)
  if (Number.isNaN(sentAt.getTime()) || sentAt.getTime() > input.now.getTime() + 86_400_000) throw new HttpError(422, 'SENT_AT_INVALID', 'Время отправки некорректно')
  const notification = await client.query<{ id: string; group_key: string; transport_status: string; archived_payload: StoredPayload; draft_version_id: string }>(
    'SELECT id, group_key, transport_status, archived_payload, draft_version_id FROM notifications WHERE id = $1 FOR UPDATE',
    [input.notificationId],
  )
  const row = notification.rows[0]
  if (!row) throw new HttpError(404, 'NOTIFICATION_NOT_FOUND', 'Уведомление не найдено')
  if (row.transport_status !== 'handed_off') throw new HttpError(409, 'NOT_HANDED_OFF', 'Подтверждается только переданное письмо')
  await client.query('SELECT group_key FROM work_groups WHERE group_key = $1 FOR UPDATE', [row.group_key])
  const latest = await latestPayload(client, row.group_key)
  const archived = selectConfirmedPayload(row.archived_payload, latest)
  const nowIso = input.now.toISOString()
  const revision = await writeBaseline(client, row.group_key, archived, row.id, 'external_confirm', input.actor.id, nowIso, input.basis.trim())
  await client.query(
    `UPDATE notifications SET transport_status = 'external_confirmed', sent_at = $2, external_confirmation_at = $3, confirmation_basis = $4, updated_at = $3 WHERE id = $1`,
    [row.id, sentAt.toISOString(), nowIso, input.basis.trim()],
  )
  await client.query(`UPDATE drafts SET status = 'external_confirmed', updated_at = $2 WHERE group_key = $1 AND status = 'handed_off'`, [row.group_key, nowIso])
  await refreshTimer(client, row.group_key, nowIso)
  await writeAudit(client, {
    occurredAt: nowIso,
    actorId: input.actor.id,
    serviceActor: null,
    action: 'notification.external_confirmed',
    entityType: 'notification',
    entityId: row.id,
    groupKey: row.group_key,
    result: 'ok',
    details: { baselineRevision: revision },
    correlationId: input.correlationId,
  })
  await rebuildQueueViews(client, input.now, row.group_key)
  return { baselineRevision: revision, groupKey: row.group_key }
}

export async function establishBaseline(
  client: PoolClient,
  input: { groupId: string; snapshotId: string; actor: Actor; now: Date; correlationId: string; evidence: string; confirmed: boolean },
): Promise<{ revisionNo: number; groupKey: string }> {
  if (!input.confirmed) throw new HttpError(422, 'CONFIRMATION_REQUIRED', 'Нужно явное подтверждение')
  if (input.evidence.trim().length < 3) throw new HttpError(422, 'EVIDENCE_REQUIRED', 'Нужно основание базы')
  const group = await client.query<{ group_key: string; hotel_id: string | null }>('SELECT group_key, hotel_id FROM work_groups WHERE id = $1 FOR UPDATE', [input.groupId])
  const row = group.rows[0]
  if (!row) throw new HttpError(404, 'GROUP_NOT_FOUND', 'Группа не найдена')
  const head = await client.query<{ validation_status: string; completeness: string; series_id: string; seq: number }>(
    'SELECT validation_status, completeness, series_id, seq FROM snapshots WHERE id = $1',
    [input.snapshotId],
  )
  const snapshot = head.rows[0]
  if (!snapshot) throw new HttpError(404, 'SNAPSHOT_NOT_FOUND', 'Снимок не найден')
  if (snapshot.completeness !== 'full') throw new HttpError(409, 'SNAPSHOT_NOT_FULL', 'Снимок неполный')
  if (snapshot.validation_status !== 'accepted') throw new HttpError(409, 'SNAPSHOT_BLOCKED', 'Снимок не принят')
  const newer = await client.query('SELECT id FROM snapshots WHERE series_id = $1 AND seq > $2 LIMIT 1', [snapshot.series_id, snapshot.seq])
  if (newer.rows[0]) throw new HttpError(409, 'SNAPSHOT_STALE', 'Есть более новый снимок')
  const bookings = await client.query(
    `SELECT source_booking_id, source_crew_id, hotel_id, airport_code, stay_date::text, full_name, position, gender, arrival_flight,
            arrival_local_date::text, arrival_local_time::text, departure_flight, departure_local_date::text, departure_local_time::text,
            room_type, record_status, replacement_of
     FROM snapshot_bookings WHERE snapshot_id = $1`,
    [input.snapshotId],
  )
  const payload: StoredPayload = {
    bookings: bookings.rows
      .map((item) => ({
        id: item.source_booking_id as string | null,
        crewId: item.source_crew_id as string | null,
        hotelId: item.hotel_id as string | null,
        airportCode: String(item.airport_code).trim(),
        stayDate: item.stay_date ? String(item.stay_date).slice(0, 10) : null,
        fullName: String(item.full_name),
        position: (item.position as string | null) ?? null,
        gender: item.gender as 'M' | 'F' | null,
        arrivalFlight: String(item.arrival_flight ?? ''),
        arrivalLocalDate: item.arrival_local_date ? String(item.arrival_local_date).slice(0, 10) : '',
        arrivalLocalTime: item.arrival_local_time ? String(item.arrival_local_time).slice(0, 5) : '',
        departureFlight: String(item.departure_flight ?? ''),
        departureLocalDate: item.departure_local_date ? String(item.departure_local_date).slice(0, 10) : '',
        departureLocalTime: item.departure_local_time ? String(item.departure_local_time).slice(0, 5) : '',
        roomType: item.room_type as 'SGL' | 'DBL' | null,
        recordStatus: (item.record_status as 'active' | 'cancelled' | null) ?? 'active',
        replacementOf: (item.replacement_of as string | null) ?? null,
      }))
      .filter((booking) => {
        const key = booking.hotelId && booking.stayDate ? `${booking.hotelId}|${booking.airportCode}|${booking.stayDate}` : null
        return key === row.group_key && booking.recordStatus !== 'cancelled'
      }),
    roomPairs: [],
    letter: null,
  }
  if (payload.bookings.length === 0) throw new HttpError(409, 'SNAPSHOT_GROUP_EMPTY', 'В снимке нет этой группы')
  const revisionNo = await writeBaseline(client, row.group_key, payload, null, 'manual_base', input.actor.id, input.now.toISOString(), input.evidence.trim())
  await refreshTimer(client, row.group_key, input.now.toISOString())
  await writeAudit(client, {
    occurredAt: input.now.toISOString(),
    actorId: input.actor.id,
    serviceActor: null,
    action: 'baseline.established',
    entityType: 'work_group',
    entityId: input.groupId,
    groupKey: row.group_key,
    result: 'ok',
    details: { revisionNo },
    correlationId: input.correlationId,
  })
  await rebuildQueueViews(client, input.now, row.group_key)
  return { revisionNo, groupKey: row.group_key }
}

async function assertReviewed(
  client: PoolClient,
  input: { draftId: string; actor: Actor; now: Date; revision: number },
): Promise<{ versionId: string; groupKey: string; payload: StoredPayload; recipients: string[]; cc: string[] }> {
  const draft = await client.query<{ id: string; group_key: string; status: string; current_revision: number }>(
    'SELECT id, group_key, status, current_revision FROM drafts WHERE id = $1 FOR UPDATE',
    [input.draftId],
  )
  const row = draft.rows[0]
  if (!row) throw new HttpError(404, 'DRAFT_NOT_FOUND', 'Письмо не найдено')
  if (row.current_revision !== input.revision || row.status !== 'reviewed') throw new HttpError(409, 'REVIEW_REQUIRED', 'Нужна проверка актуальной версии')
  await client.query('SELECT group_key FROM work_groups WHERE group_key = $1 FOR UPDATE', [row.group_key])
  const version = await client.query<{
    id: string
    payload: StoredPayload
    source_fingerprint: string
    recipients_fingerprint: string
    template_version: number
    reviewed_fingerprint: string | null
    recipient_to: string[]
    recipient_cc: string[]
  }>(
    `SELECT id, payload, source_fingerprint, recipients_fingerprint, template_version, reviewed_fingerprint, recipient_to, recipient_cc
     FROM draft_versions WHERE draft_id = $1 AND revision = $2`,
    [row.id, row.current_revision],
  )
  const current = version.rows[0]
  if (!current?.payload.letter || !current.reviewed_fingerprint) throw new HttpError(409, 'REVIEW_REQUIRED', 'Версия не проверена')
  const state = await loadState(client, row.group_key)
  const source = sourceProblem(state, input.now)
  if (source) throw new HttpError(409, source, 'Источник не готов')
  const projected = groupById(state, input.now, state.groups.find((group) => group.groupKey === row.group_key)?.id ?? '')
  if (!projected || projected.exceptions.some((item) => item.blocking)) throw new HttpError(409, 'GROUP_BLOCKED', 'Группа заблокирована')
  const fingerprint = letterFingerprint(current.payload.letter)
  const reviewed = sha256(`${current.source_fingerprint}|${current.recipients_fingerprint}|${current.template_version}|${fingerprint}`)
  if (
    reviewed !== current.reviewed_fingerprint ||
    projected.liveFingerprint !== current.source_fingerprint ||
    projected.recipientFingerprint !== current.recipients_fingerprint ||
    state.settings.templateVersion !== current.template_version
  ) {
    throw new HttpError(409, 'STALE_DRAFT', 'Письмо устарело')
  }
  return {
    versionId: current.id,
    groupKey: row.group_key,
    payload: current.payload,
    recipients: current.recipient_to,
    cc: current.recipient_cc,
  }
}

async function writeBaseline(
  client: PoolClient,
  groupKey: string,
  payload: StoredPayload,
  notificationId: string | null,
  establishedBy: 'manual_base' | 'send' | 'external_confirm',
  actorId: string,
  nowIso: string,
  evidence: string | null,
): Promise<number> {
  const snapshot = await client.query<{ id: string }>('SELECT id FROM snapshots ORDER BY fetched_at DESC LIMIT 1')
  const next = await client.query<{ revision_no: number }>(
    'SELECT COALESCE(MAX(revision_no), 0) + 1 AS revision_no FROM notification_baselines WHERE group_key = $1',
    [groupKey],
  )
  const revisionNo = Number(next.rows[0]?.revision_no ?? 1)
  const stored: StoredPayload = {
    bookings: baselineBookingsFromPayload(payload),
    roomPairs: payload.roomPairs,
    letter: payload.letter,
  }
  await client.query(
    `INSERT INTO notification_baselines (group_key, payload, source_snapshot_id, notification_id, established_by, established_by_user, confirmed_at, revision_no, evidence)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9)`,
    [groupKey, JSON.stringify(stored), snapshot.rows[0]?.id ?? null, notificationId, establishedBy, actorId, nowIso, revisionNo, evidence],
  )
  return revisionNo
}

async function latestPayload(client: PoolClient, groupKey: string): Promise<StoredPayload | null> {
  const state = await loadState(client, groupKey)
  const group = state.groups.find((item) => item.groupKey === groupKey)
  if (!group) return null
  const projected = groupById(state, new Date(), group.id)
  return { bookings: projected?.latestBookings ?? [], roomPairs: [], letter: null }
}

async function refreshTimer(client: PoolClient, groupKey: string, nowIso: string): Promise<void> {
  const state = await loadState(client, groupKey)
  const settings = state.settings.quietMinutes
  const group = state.groups.find((item) => item.groupKey === groupKey)
  const projected = group ? groupById(state, new Date(nowIso), group.id) : null
  if (!projected?.baselineBookings) return
  const net = diffBookings({ before: projected.baselineBookings, after: projected.latestBookings, completeness: 'full' })
  const fingerprint = sha256(bookingsFingerprint(projected.latestBookings))
  if (net.events.length === 0 || net.ambiguous) {
    await client.query(`UPDATE work_groups SET due_at = NULL, quiet_started_at = NULL, last_fingerprint = $2, updated_at = $3, row_version = row_version + 1 WHERE group_key = $1`, [
      groupKey,
      fingerprint,
      nowIso,
    ])
    return
  }
  const timer = nextQuietTimer(undefined, nowIso, settings)
  await client.query(
    `UPDATE work_groups SET quiet_started_at = $2, last_change_at = $3, due_at = $4, last_fingerprint = $5, updated_at = $3, row_version = row_version + 1 WHERE group_key = $1`,
    [groupKey, timer.quietStartedAt, timer.lastChangeAt, timer.dueAt, fingerprint],
  )
}

async function claimIdempotency(client: PoolClient, scope: string, key: string, hash: string): Promise<{ notificationId: string; transportStatus: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(key)) throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', 'Нужен Idempotency-Key в формате UUID')
  const inserted = await client.query(
    `INSERT INTO request_dedup (scope, key, request_hash, status, expires_at) VALUES ($1, $2, $3, 'in_progress', now() + interval '1 day') ON CONFLICT DO NOTHING RETURNING key`,
    [scope, key, hash],
  )
  if (inserted.rows.length > 0) return null
  const existing = await client.query<{ request_hash: string; status: string; response_body: { notificationId?: string; transportStatus?: string } | null }>(
    'SELECT request_hash, status, response_body FROM request_dedup WHERE scope = $1 AND key = $2',
    [scope, key],
  )
  const row = existing.rows[0]
  if (!row) throw new HttpError(409, 'IN_PROGRESS', 'Запрос уже выполняется')
  if (row.request_hash !== hash) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Ключ уже использован с другим телом')
  if (row.status === 'completed' && row.response_body?.notificationId && row.response_body.transportStatus) {
    return { notificationId: row.response_body.notificationId, transportStatus: row.response_body.transportStatus }
  }
  throw new HttpError(409, 'IN_PROGRESS', 'Запрос уже выполняется')
}

async function completeIdempotency(client: PoolClient, scope: string, key: string, code: number, body: { notificationId: string; transportStatus: string }): Promise<void> {
  await client.query(`UPDATE request_dedup SET status = 'completed', response_code = $3, response_body = $4::jsonb WHERE scope = $1 AND key = $2`, [
    scope,
    key,
    code,
    JSON.stringify(body),
  ])
}

async function rememberDelivery(client: PoolClient, notificationId: string, transportStatus: string): Promise<void> {
  await client.query(`UPDATE request_dedup SET response_body = jsonb_build_object('notificationId', $1::text, 'transportStatus', $2::text), response_code = 202 WHERE response_body->>'notificationId' = $1`, [
    notificationId,
    transportStatus,
  ])
}

function audit(input: { now: Date; correlationId: string; actorId: string }, groupKey: string, action: string, entityId: string) {
  return {
    occurredAt: input.now.toISOString(),
    actorId: input.actorId,
    serviceActor: null,
    action,
    entityType: 'notification',
    entityId,
    groupKey,
    result: 'ok' as const,
    details: {},
    correlationId: input.correlationId,
  }
}

export async function sweepUnknownDeliveries(client: PoolClient, now: Date, unknownAfterSeconds: number): Promise<number> {
  const result = await client.query<{ id: string }>(
    `UPDATE notifications SET transport_status = 'delivery_unknown', updated_at = $1
     WHERE transport_status = 'sending'
       AND id IN (
         SELECT notification_id FROM delivery_attempts
         WHERE result = 'pending' AND started_at < $1::timestamptz - make_interval(secs => $2)
       )
     RETURNING id`,
    [now.toISOString(), unknownAfterSeconds],
  )
  if (result.rows.length === 0) return 0
  await client.query(
    `UPDATE delivery_attempts SET result = 'unknown', finished_at = $2, error_code = 'DELIVERY_UNKNOWN'
     WHERE notification_id = ANY($1::uuid[]) AND result = 'pending'`,
    [result.rows.map((row) => row.id), now.toISOString()],
  )
  return result.rows.length
}
