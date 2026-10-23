import type { PoolClient } from 'pg'
import { applyOverrides, applyTokens, hasMarkup, letterRows, overrideProblems, pickTemplateKey, renderLetter, type LetterPayload, type PublicLetterRow } from '../domain/letter.ts'
import { sha256, stableStringify } from '../domain/hash.ts'
import { blockText, type MailTemplate, type TemplateBlock } from '../domain/templates.ts'
import { HttpError } from '../errors.ts'
import { writeAudit } from './audit.ts'
import { groupById, loadState, sourceProblem, type Actor } from './state.ts'
import type { StoredPayload } from '../domain/payload.ts'

const OPEN_DRAFT = ['active', 'reviewed', 'sending', 'handed_off']

export async function prepareGroup(
  client: PoolClient,
  input: { groupId: string; actor: Actor; now: Date; correlationId: string; bypassQuiet: boolean; reason: string | null; automatic: boolean },
): Promise<{ draftId: string; revision: number; fingerprint: string }> {
  const locked = await client.query<{ group_key: string }>('SELECT group_key FROM work_groups WHERE id = $1 FOR UPDATE', [input.groupId])
  const groupKey = locked.rows[0]?.group_key
  if (!groupKey) throw new HttpError(404, 'GROUP_NOT_FOUND', 'Группа не найдена')
  const state = await loadState(client)
  const group = groupById(state, input.now, input.groupId)
  if (!group) throw new HttpError(404, 'GROUP_NOT_FOUND', 'Группа не найдена')
  const source = sourceProblem(state, input.now)
  if (source) throw new HttpError(409, source, 'Источник не готов к подготовке письма')
  if (!group.baselineBookings) throw new HttpError(409, 'BASELINE_NOT_CONFIRMED', 'Нет подтверждённой базы уведомления')
  if (group.exceptions.some((item) => item.blocking)) throw new HttpError(409, 'GROUP_BLOCKED', 'Группа заблокирована')
  if (group.changeCount === 0) throw new HttpError(409, 'NOTHING_TO_PREPARE', 'Нет изменений для письма')
  const dueAt = group.dueAt ? new Date(group.dueAt).getTime() : null
  if ((dueAt === null || dueAt > input.now.getTime()) && !input.bypassQuiet) throw new HttpError(409, 'QUIET_PERIOD', 'Интервал тишины ещё не прошёл')
  if (input.bypassQuiet && (input.reason ?? '').trim().length < 3) throw new HttpError(422, 'REASON_REQUIRED', 'Нужно основание для подготовки до срока')
  const existing = await client.query(`SELECT id FROM drafts WHERE group_key = $1 AND status = ANY($2::text[])`, [groupKey, OPEN_DRAFT])
  if (existing.rows.length > 0) throw new HttpError(409, 'DRAFT_EXISTS', 'Для группы уже есть рабочее письмо')
  const created = await insertDraft(client, state, group, input.actor, input.now, input.correlationId, input.automatic)
  if (input.bypassQuiet) {
    await writeAudit(client, {
      occurredAt: input.now.toISOString(),
      actorId: input.actor.id,
      serviceActor: null,
      action: 'draft.bypass_quiet',
      entityType: 'draft',
      entityId: created.draftId,
      groupKey,
      result: 'ok',
      details: { reasonLength: (input.reason ?? '').trim().length },
      correlationId: input.correlationId,
    })
  }
  return created
}

async function insertDraft(
  client: PoolClient,
  state: Awaited<ReturnType<typeof loadState>>,
  group: NonNullable<ReturnType<typeof groupById>>,
  actor: Actor,
  now: Date,
  correlationId: string,
  automatic: boolean,
): Promise<{ draftId: string; revision: number; fingerprint: string }> {
  const templateKey = pickTemplateKey(group.changes.map((change) => change.kind))
  const template = await loadTemplate(client, templateKey)
  const hotel = state.hotels.find((item) => item.id === group.hotel?.id)
  if (!hotel) throw new HttpError(409, 'HOTEL_MAPPING_MISSING', 'Гостиница не сопоставлена')
  const stay = group.stayDate.split('-').reverse().join('.')
  const variables = {
    hotel_name: hotel.name,
    airport_code: group.airportCode,
    stay_date: stay,
    local_timezone: hotel.timezone,
    change_count: String(group.changeCount),
    sender_name: state.settings.senderName,
  }
  const rows = letterRows({
    latest: group.latestBookings,
    baseline: group.baselineBookings,
    keptPairs: roomPairsOf(state.baselines.get(group.groupKey)?.payload.roomPairs ?? []),
  })
  const letter: LetterPayload = {
    subject: applyTokens(blockText(template, 'subject'), variables),
    greeting: applyTokens(blockText(template, 'greeting'), variables),
    intro: applyTokens(blockText(template, 'intro'), variables),
    closing: applyTokens(blockText(template, 'closing'), variables),
    signature: applyTokens(blockText(template, 'signature'), variables),
    rows,
    columns: template.columns,
    newLabel: template.newLabel,
    cancelLabel: template.cancelLabel,
    templateKey,
    manualEdits: false,
  }
  assertPlain(letter)
  if (!state.latest) throw new HttpError(409, 'SOURCE_NOT_READY', 'Источник не готов к подготовке письма')
  const payload: StoredPayload = { bookings: group.latestBookings, roomPairs: pairsFromRows(rows), letter }
  const fingerprint = sha256(stableStringify(letter))
  const draft = await client.query<{ id: string }>(
    `INSERT INTO drafts (group_key, status, current_revision, source_snapshot_id, template_version_id, created_by)
     VALUES ($1, 'active', 1, $2, $3, $4) RETURNING id`,
    [group.groupKey, state.latest.id, template.id, automatic ? null : actor.id],
  )
  const draftId = draft.rows[0]?.id ?? ''
  await client.query(
    `INSERT INTO draft_versions (
      draft_id, revision, source_fingerprint, recipients_fingerprint, payload, rendered_subject, rendered_content,
      recipient_to, recipient_cc, template_version
    ) VALUES ($1, 1, $2, $3, $4::jsonb, $5, $6, $7::jsonb, $8::jsonb, $9)`,
    [
      draftId,
      group.liveFingerprint,
      group.recipientFingerprint,
      JSON.stringify(payload),
      letter.subject,
      renderLetter(letter),
      JSON.stringify(hotel.recipients),
      JSON.stringify(hotel.cc),
      state.settings.templateVersion,
    ],
  )
  await client.query(`UPDATE work_groups SET current_draft_id = $2, updated_at = $3 WHERE group_key = $1`, [group.groupKey, draftId, now.toISOString()])
  await writeAudit(client, {
    occurredAt: now.toISOString(),
    actorId: automatic ? null : actor.id,
    serviceActor: automatic ? 'scheduler' : null,
    action: 'draft.prepared',
    entityType: 'draft',
    entityId: draftId,
    groupKey: group.groupKey,
    result: 'ok',
    details: { revision: 1 },
    correlationId,
  })
  return { draftId, revision: 1, fingerprint }
}

function roomPairsOf(pairs: string[][] | undefined): string[][] {
  return pairs ?? []
}

function pairsFromRows(rows: readonly PublicLetterRow[]): string[][] {
  const grouped = new Map<string, string[]>()
  for (const row of rows) {
    if (row.badge === 'cancel') continue
    const list = grouped.get(row.roomKey) ?? []
    list.push(row.bookingId)
    grouped.set(row.roomKey, list)
  }
  return [...grouped.values()].filter((ids) => ids.length === 2)
}

async function loadTemplate(client: PoolClient, templateKey: string): Promise<MailTemplate & { id: string }> {
  const result = await client.query<{ id: string; blocks: TemplateBlock[]; columns: MailTemplate['columns']; new_label: string; cancel_label: string }>(
    `SELECT id, blocks, columns, new_label, cancel_label FROM template_versions WHERE template_key = $1 ORDER BY version DESC LIMIT 1`,
    [templateKey],
  )
  const row = result.rows[0]
  if (!row) throw new HttpError(409, 'TEMPLATE_MISSING', 'Шаблон не найден')
  return { id: row.id, templateKey: templateKey as MailTemplate['templateKey'], blocks: row.blocks, columns: row.columns, newLabel: row.new_label, cancelLabel: row.cancel_label }
}

function assertPlain(letter: LetterPayload): void {
  const texts = [letter.subject, letter.greeting, letter.intro, letter.closing, letter.signature, ...letter.rows.map((row) => row.fullName)]
  if (texts.some((text) => hasMarkup(text))) throw new HttpError(422, 'MARKUP_FORBIDDEN', 'HTML в письме запрещён')
}

export function letterFingerprint(letter: LetterPayload): string {
  return sha256(stableStringify(letter))
}

export async function patchDraft(
  client: PoolClient,
  input: {
    draftId: string
    actor: Actor
    now: Date
    correlationId: string
    expectedRevision: number
    subject: string
    intro: string
    closing: string
    signature: string
    recipients: string[]
    cc: string[]
    overrides: Array<{ bookingId: string; field: string; value: string; reason: string }>
  },
): Promise<{ revision: number; fingerprint: string; status: string }> {
  const draft = await lockDraft(client, input.draftId)
  if (draft.current_revision !== input.expectedRevision) throw new HttpError(409, 'REVISION_CONFLICT', 'Версия письма уже изменилась')
  if (!['active', 'reviewed'].includes(draft.status)) throw new HttpError(409, 'DRAFT_LOCKED', 'Письмо нельзя изменить в этом состоянии')
  const texts = [input.subject, input.intro, input.closing, input.signature, ...input.overrides.map((item) => item.value)]
  if (texts.some((text) => hasMarkup(text) || text.length > 2000)) throw new HttpError(422, 'MARKUP_FORBIDDEN', 'HTML в письме запрещён')
  if (input.overrides.some((item) => item.reason.trim().length < 3)) throw new HttpError(422, 'REASON_REQUIRED', 'Для ручной правки нужно основание')
  const state = await loadState(client)
  const group = [...state.groups].find((item) => item.groupKey === draft.group_key)
  const hotel = state.hotels.find((item) => item.id === group?.hotelId)
  if (!hotel) throw new HttpError(409, 'HOTEL_MAPPING_MISSING', 'Гостиница не сопоставлена')
  const allow = new Set([...hotel.recipients, ...hotel.cc].map((item) => item.toLowerCase()))
  const recipients = uniqueEmails(input.recipients)
  const cc = uniqueEmails(input.cc)
  if (recipients.length === 0 || [...recipients, ...cc].some((item) => !allow.has(item))) {
    throw new HttpError(422, 'RECIPIENT_NOT_ALLOWED', 'Адрес вне справочника гостиницы')
  }
  const current = await currentVersion(client, draft.id, draft.current_revision)
  const letter = current.payload.letter
  if (!letter) throw new HttpError(409, 'DRAFT_EMPTY', 'У версии нет текста')
  if (overrideProblems(letter.rows, input.overrides).length > 0) throw new HttpError(422, 'OVERRIDE_INVALID', 'Ручная правка некорректна')
  const rows = applyOverrides(letter.rows, input.overrides)
  const nextLetter: LetterPayload = {
    ...letter,
    subject: input.subject,
    intro: input.intro,
    closing: input.closing,
    signature: input.signature,
    rows,
    manualEdits: true,
  }
  assertPlain(nextLetter)
  const revision = draft.current_revision + 1
  const payload: StoredPayload = { ...current.payload, letter: nextLetter, roomPairs: pairsFromRows(rows) }
  await client.query(
    `INSERT INTO draft_versions (
      draft_id, revision, source_fingerprint, recipients_fingerprint, payload, rendered_subject, rendered_content,
      recipient_to, recipient_cc, manual_override, template_version
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb, $11)`,
    [
      draft.id,
      revision,
      current.source_fingerprint,
      current.recipients_fingerprint,
      JSON.stringify(payload),
      nextLetter.subject,
      renderLetter(nextLetter),
      JSON.stringify(recipients),
      JSON.stringify(cc),
      JSON.stringify(input.overrides),
      current.template_version,
    ],
  )
  await client.query(`UPDATE drafts SET current_revision = $2, status = 'active', row_version = row_version + 1, updated_at = $3 WHERE id = $1`, [
    draft.id,
    revision,
    input.now.toISOString(),
  ])
  await writeAudit(client, {
    occurredAt: input.now.toISOString(),
    actorId: input.actor.id,
    serviceActor: null,
    action: 'draft.revised',
    entityType: 'draft',
    entityId: draft.id,
    groupKey: draft.group_key,
    result: 'ok',
    details: { revision },
    correlationId: input.correlationId,
  })
  return { revision, fingerprint: letterFingerprint(nextLetter), status: 'active' }
}

export async function reviewDraft(
  client: PoolClient,
  input: { draftId: string; actor: Actor; now: Date; correlationId: string; revision: number; fingerprint: string; confirmed: boolean },
): Promise<{ status: string; reviewedAt: string }> {
  if (!input.confirmed) throw new HttpError(422, 'CONFIRMATION_REQUIRED', 'Нужно явное подтверждение')
  const draft = await lockDraft(client, input.draftId)
  if (draft.current_revision !== input.revision) throw new HttpError(409, 'REVISION_CONFLICT', 'Версия письма уже изменилась')
  const version = await currentVersion(client, draft.id, draft.current_revision)
  const letter = version.payload.letter
  if (!letter) throw new HttpError(409, 'DRAFT_EMPTY', 'У версии нет текста')
  if (letterFingerprint(letter) !== input.fingerprint) throw new HttpError(409, 'FINGERPRINT_MISMATCH', 'Текст письма не совпадает с сохранённой версией')
  const state = await loadState(client)
  const projected = projectDraft(state, input.now, draft.group_key)
  if (!projected) throw new HttpError(404, 'GROUP_NOT_FOUND', 'Группа не найдена')
  const source = sourceProblem(state, input.now)
  if (source) throw new HttpError(409, source, 'Источник не готов')
  if (projected.exceptions.some((item) => item.blocking)) throw new HttpError(409, 'GROUP_BLOCKED', 'Группа заблокирована')
  if (projected.liveFingerprint !== version.source_fingerprint || projected.recipientFingerprint !== version.recipients_fingerprint || state.settings.templateVersion !== version.template_version) {
    throw new HttpError(409, 'STALE_DRAFT', 'Письмо устарело')
  }
  const reviewedFingerprint = sha256(`${version.source_fingerprint}|${version.recipients_fingerprint}|${version.template_version}|${input.fingerprint}`)
  const reviewedAt = input.now.toISOString()
  await client.query(`UPDATE draft_versions SET reviewed_at = $2, reviewed_by = $3, reviewed_fingerprint = $4 WHERE id = $1`, [
    version.id,
    reviewedAt,
    input.actor.id,
    reviewedFingerprint,
  ])
  await client.query(`UPDATE drafts SET status = 'reviewed', updated_at = $2, row_version = row_version + 1 WHERE id = $1`, [draft.id, reviewedAt])
  await writeAudit(client, {
    occurredAt: reviewedAt,
    actorId: input.actor.id,
    serviceActor: null,
    action: 'draft.reviewed',
    entityType: 'draft',
    entityId: draft.id,
    groupKey: draft.group_key,
    result: 'ok',
    details: { revision: input.revision },
    correlationId: input.correlationId,
  })
  return { status: 'reviewed', reviewedAt }
}

export async function rebuildDraft(
  client: PoolClient,
  input: { draftId: string; actor: Actor; now: Date; correlationId: string },
): Promise<{ revision: number; fingerprint: string }> {
  const draft = await lockDraft(client, input.draftId)
  if (draft.status === 'sending') throw new HttpError(409, 'DRAFT_LOCKED', 'Письмо нельзя пересобрать')
  const state = await loadState(client)
  const groupId = state.groups.find((group) => group.groupKey === draft.group_key)?.id ?? ''
  const group = groupById(state, input.now, groupId)
  if (!group) throw new HttpError(404, 'GROUP_NOT_FOUND', 'Группа не найдена')
  if (['sent', 'handed_off', 'external_confirmed'].includes(draft.status)) {
    const version = await currentVersion(client, draft.id, draft.current_revision)
    const drifted = version.source_fingerprint !== group.liveFingerprint || version.recipients_fingerprint !== group.recipientFingerprint || version.template_version !== state.settings.templateVersion
    if (!drifted) throw new HttpError(409, 'DRAFT_LOCKED', 'Письмо нельзя пересобрать')
  }
  const templateKey = pickTemplateKey(group.changes.map((change) => change.kind))
  const template = await loadTemplate(client, templateKey)
  const hotel = state.hotels.find((item) => item.id === group.hotel?.id)
  if (!hotel || !state.latest) throw new HttpError(409, 'SOURCE_NOT_READY', 'Источник не готов')
  const variables = {
    hotel_name: hotel.name,
    airport_code: group.airportCode,
    stay_date: group.stayDate.split('-').reverse().join('.'),
    local_timezone: hotel.timezone,
    change_count: String(group.changeCount),
    sender_name: state.settings.senderName,
  }
  const rows = letterRows({ latest: group.latestBookings, baseline: group.baselineBookings, keptPairs: state.baselines.get(group.groupKey)?.payload.roomPairs ?? [] })
  const letter: LetterPayload = {
    subject: applyTokens(blockText(template, 'subject'), variables),
    greeting: applyTokens(blockText(template, 'greeting'), variables),
    intro: applyTokens(blockText(template, 'intro'), variables),
    closing: applyTokens(blockText(template, 'closing'), variables),
    signature: applyTokens(blockText(template, 'signature'), variables),
    rows,
    columns: template.columns,
    newLabel: template.newLabel,
    cancelLabel: template.cancelLabel,
    templateKey,
    manualEdits: false,
  }
  assertPlain(letter)
  const revision = draft.current_revision + 1
  const payload: StoredPayload = { bookings: group.latestBookings, roomPairs: pairsFromRows(rows), letter }
  await client.query(
    `INSERT INTO draft_versions (draft_id, revision, source_fingerprint, recipients_fingerprint, payload, rendered_subject, rendered_content, recipient_to, recipient_cc, template_version)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9::jsonb, $10)`,
    [draft.id, revision, group.liveFingerprint, group.recipientFingerprint, JSON.stringify(payload), letter.subject, renderLetter(letter), JSON.stringify(hotel.recipients), JSON.stringify(hotel.cc), state.settings.templateVersion],
  )
  await client.query(`UPDATE drafts SET current_revision = $2, status = 'active', source_snapshot_id = $3, template_version_id = $4, row_version = row_version + 1, updated_at = $5 WHERE id = $1`, [
    draft.id,
    revision,
    state.latest.id,
    template.id,
    input.now.toISOString(),
  ])
  return { revision, fingerprint: letterFingerprint(letter) }
}

function projectDraft(state: Awaited<ReturnType<typeof loadState>>, now: Date, groupKey: string) {
  const id = state.groups.find((group) => group.groupKey === groupKey)?.id
  return id ? groupById(state, now, id) : null
}

async function lockDraft(client: PoolClient, draftId: string): Promise<{ id: string; group_key: string; status: string; current_revision: number }> {
  const result = await client.query<{ id: string; group_key: string; status: string; current_revision: number }>(
    'SELECT id, group_key, status, current_revision FROM drafts WHERE id = $1 FOR UPDATE',
    [draftId],
  )
  const draft = result.rows[0]
  if (!draft) throw new HttpError(404, 'DRAFT_NOT_FOUND', 'Письмо не найдено')
  return draft
}

async function currentVersion(client: PoolClient, draftId: string, revision: number): Promise<{
  id: string
  payload: StoredPayload
  source_fingerprint: string
  recipients_fingerprint: string
  template_version: number
  reviewed_fingerprint: string | null
  recipient_to: string[]
  recipient_cc: string[]
}> {
  const result = await client.query<{
    id: string
    payload: StoredPayload
    source_fingerprint: string
    recipients_fingerprint: string
    template_version: number
    reviewed_fingerprint: string | null
    recipient_to: unknown
    recipient_cc: unknown
  }>(
    `SELECT id, payload, source_fingerprint, recipients_fingerprint, template_version, reviewed_fingerprint, recipient_to, recipient_cc
     FROM draft_versions WHERE draft_id = $1 AND revision = $2`,
    [draftId, revision],
  )
  const version = result.rows[0]
  if (!version) throw new HttpError(404, 'REVISION_NOT_FOUND', 'Версия не найдена')
  return {
    ...version,
    recipient_to: Array.isArray(version.recipient_to) ? version.recipient_to.filter((item): item is string => typeof item === 'string') : [],
    recipient_cc: Array.isArray(version.recipient_cc) ? version.recipient_cc.filter((item): item is string => typeof item === 'string') : [],
  }
}

function uniqueEmails(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))]
}

export async function loadDraftView(client: PoolClient, draftId: string): Promise<Record<string, unknown>> {
  const result = await client.query<{
    id: string
    status: string
    current_revision: number
    group_key: string
    payload: StoredPayload
    rendered_subject: string
    rendered_content: string
    recipient_to: unknown
    recipient_cc: unknown
    reviewed_at: string | null
    template_version: number
    created_at: string
  }>(
    `SELECT d.id, d.status, d.current_revision, d.group_key, v.payload, v.rendered_subject, v.rendered_content, v.recipient_to, v.recipient_cc, v.reviewed_at,
            v.template_version, v.created_at
     FROM drafts d JOIN draft_versions v ON v.draft_id = d.id AND v.revision = d.current_revision WHERE d.id = $1`,
    [draftId],
  )
  const row = result.rows[0]
  if (!row) throw new HttpError(404, 'DRAFT_NOT_FOUND', 'Письмо не найдено')
  const letter = row.payload.letter
  return {
    id: row.id,
    status: row.status,
    revision: row.current_revision,
    groupKey: row.group_key,
    subject: letter?.subject ?? row.rendered_subject,
    greeting: letter?.greeting ?? '',
    intro: letter?.intro ?? '',
    closing: letter?.closing ?? '',
    signature: letter?.signature ?? '',
    rows: letter?.rows ?? [],
    columns: letter?.columns ?? [],
    newLabel: letter?.newLabel ?? '',
    cancelLabel: letter?.cancelLabel ?? '',
    manualEdits: letter?.manualEdits ?? false,
    recipients: row.recipient_to,
    cc: row.recipient_cc,
    reviewedAt: row.reviewed_at,
    templateVersion: row.template_version,
    createdAt: row.created_at,
    fingerprint: letter ? letterFingerprint(letter) : null,
  }
}
