import { randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Pool } from 'pg'
import type { AppConfig } from '../config.ts'
import { buildCsv } from '../domain/csv.ts'
import { normalizeAviabitTable, ImportSchemaError } from '../domain/aviabit.ts'
import { diffBookings, type CanonicalBooking } from '../domain/diff.ts'
import { readFirstSheet, XlsxLimitError } from '../domain/xlsx.ts'
import { HttpError } from '../errors.ts'
import { createPool, withTransaction } from '../db/pool.ts'
import { runImportedRows, runSampleCheck } from '../services/ingest.ts'
import { loadDraftView, patchDraft, prepareGroup, rebuildDraft, reviewDraft } from '../services/drafts.ts'
import { beginSend, confirmExternal, establishBaseline, finishSend, handoffDraft } from '../services/delivery.ts'
import { createHotel, holdException, patchHotel, patchSettings, publishTemplate, recordAcceptedImport, recordRejectedImport, resolveException } from '../services/directory.ts'
import { loadState, projectGroups, sourceProblem, type Actor } from '../services/state.ts'
import { runScheduler } from '../services/scheduler.ts'
import { AuthBusyError, warmPasswordCheck } from '../domain/password.ts'
import { actorFromSession, clearedSessionCookie, loginWithPassword, logoutSession, readSessionToken, sessionCookie } from '../services/session.ts'

const hits = new Map<string, number[]>()

export interface RunningServer {
  url: string
  close: () => Promise<void>
}

export async function startServer(config: AppConfig): Promise<RunningServer> {
  if (config.authMode === 'password') await warmPasswordCheck(config.authPepper)
  const pool = createPool(config.databaseUrl)
  const timer = config.schedulerEnabled
    ? setInterval(() => {
        runScheduler(pool, config).catch((error: unknown) => {
          console.error(JSON.stringify({ message: 'scheduler failed', name: error instanceof Error ? error.name : 'error' }))
        })
      }, 5_000)
    : null
  timer?.unref()
  const server = createServer((req, res) => {
    void handle(req, res, pool, config).catch((error: unknown) => {
      const correlationId = randomUUID()
      sendError(res, error, correlationId)
    })
  })
  server.requestTimeout = config.requestTimeoutMs
  server.headersTimeout = config.headersTimeoutMs
  server.on('connection', (socket) => {
    socket.setTimeout(config.requestTimeoutMs)
    socket.on('timeout', () => socket.destroy())
  })
  await new Promise<void>((resolve) => server.listen(config.port, config.host, () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  return {
    url: `http://${config.host}:${port}`,
    close: async () => {
      if (timer) clearInterval(timer)
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
      await pool.end()
    },
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, pool: Pool, config: AppConfig): Promise<void> {
  const correlationId = correlation(req)
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  try {
    if (!allowRate(req, url, config)) throw new HttpError(429, 'RATE_LIMITED', 'Слишком много запросов')
    if (req.method === 'GET' && url.pathname === '/health/live') return send(res, 200, { status: 'live' }, correlationId)
    if (req.method === 'GET' && url.pathname === '/health/ready') {
      try {
        await pool.query('SELECT 1')
      } catch {
        return send(res, 503, { status: 'unavailable' }, correlationId)
      }
      return send(res, 200, { status: 'ready' }, correlationId)
    }
    assertOrigin(req, config)
    const params = matchRoute(req.method ?? 'GET', url.pathname)
    if (!params) throw new HttpError(404, 'NOT_FOUND', 'Маршрут не найден')
    if (params.route === 'login' || params.route === 'logout') {
      await handleCredential(req, res, pool, config, params.route, correlationId)
      return
    }
    const reply = deferredReply()
    await withTransaction(pool, async (client) => {
      const actor = await authenticate(req, config, client)
      if (!actor) throw new HttpError(401, 'UNAUTHENTICATED', 'Нет сессии')
      await dispatch(req, reply, url, params, actor, client, config, correlationId)
    })
    reply.flush(res)
  } catch (error) {
    sendError(res, error, correlationId)
  }
}

interface Reply {
  writeHead: (status: number, headers: Record<string, string>) => void
  end: (body: string) => void
}

function deferredReply(): Reply & { flush: (res: ServerResponse) => void } {
  let head: { status: number; headers: Record<string, string> } | null = null
  let body = ''
  return {
    writeHead: (status, headers) => {
      head = { status, headers }
    },
    end: (text) => {
      body = text
    },
    flush: (res) => {
      if (!head) throw new HttpError(500, 'INTERNAL', 'Ответ не сформирован')
      res.writeHead(head.status, head.headers)
      res.end(body)
    },
  }
}

async function dispatch(
  req: IncomingMessage,
  res: Reply,
  url: URL,
  params: Record<string, string>,
  actor: Actor,
  client: Parameters<Parameters<typeof withTransaction>[1]>[0],
  config: AppConfig,
  correlationId: string,
): Promise<void> {
  const now = config.now()
  const route = params.route
  if (config.authMode === 'password' && req.method !== 'GET' && req.method !== 'HEAD') assertCrewHeader(req)
  if (route === 'me') return send(res, 200, profile(actor), correlationId)
  if (route === 'overview') {
    const state = await loadState(client)
    const groups = projectGroups(state, now, 'baseline')
    const counts: Record<string, number> = {}
    for (const group of groups) counts[group.status] = (counts[group.status] ?? 0) + 1
    const events = await client.query<{ occurred_at: string; action: string; result: string }>(
      'SELECT occurred_at, action, result FROM audit_events ORDER BY occurred_at DESC LIMIT 8',
    )
    return send(res, 200, { counts, source: sourceView(state, now, config), recentEvents: events.rows }, correlationId)
  }
  if (route === 'groups') {
    const state = await loadState(client)
    let groups = projectGroups(state, now, 'baseline')
    const status = url.searchParams.get('status')
    const airport = url.searchParams.get('airport')
    const date = url.searchParams.get('date')
    const hotel = url.searchParams.get('hotel')
    const query = (url.searchParams.get('query') ?? '').toLowerCase()
    if (status) groups = groups.filter((group) => group.status === status)
    if (airport) groups = groups.filter((group) => group.airportCode === airport.toUpperCase())
    if (date) groups = groups.filter((group) => group.stayDate === date)
    if (hotel) groups = groups.filter((group) => group.hotel?.id === hotel)
    if (query) groups = groups.filter((group) => `${group.hotel?.name ?? ''} ${group.airportCode}`.toLowerCase().includes(query))
    return send(res, 200, page(groups.map(publicGroup), url), correlationId)
  }
  if (route === 'group') {
    const state = await loadState(client)
    const group = projectGroups(state, now, 'baseline').find((item) => item.id === params.id)
    if (!group) throw new HttpError(404, 'GROUP_NOT_FOUND', 'Группа не найдена')
    return send(res, 200, publicGroup(group), correlationId)
  }
  if (route === 'corrections') {
    const basis = url.searchParams.get('basis') === 'previous' ? 'previous' : 'baseline'
    const state = await loadState(client)
    const groups = projectGroups(state, now, basis).filter((group) => basis === 'previous' || group.baselineBookings !== null || group.changeCount > 0 || group.status === 'needs_baseline')
    return send(res, 200, { basis, items: groups.map(publicGroup), nextCursor: null }, correlationId)
  }
  if (route === 'snapshots') {
    const rows = await client.query(
      `SELECT s.id, s.seq, s.source, s.series_id, s.fetched_at, s.window_from, s.window_to, s.validation_status, s.completeness, s.hash,
              jsonb_array_length(s.validation_issues) AS issue_count, (SELECT count(*)::int FROM snapshot_bookings b WHERE b.snapshot_id = s.id) AS row_count
       FROM snapshots s ORDER BY s.fetched_at DESC, s.seq DESC LIMIT 100`,
    )
    return send(res, 200, { items: rows.rows, nextCursor: null }, correlationId)
  }
  if (route === 'snapshot') {
    const row = await client.query('SELECT id, seq, fetched_at, validation_status, completeness, validation_issues, hash FROM snapshots WHERE id = $1', [params.id])
    if (!row.rows[0]) throw new HttpError(404, 'SNAPSHOT_NOT_FOUND', 'Снимок не найден')
    return send(res, 200, row.rows[0], correlationId)
  }
  if (route === 'compare') {
    const leftId = url.searchParams.get('leftId')
    const rightId = url.searchParams.get('rightId')
    if (!leftId || !rightId) throw new HttpError(400, 'PAIR_REQUIRED', 'Нужны leftId и rightId')
    const beforeCount = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM change_events')
    const pair = await loadPair(client, leftId, rightId)
    const diff = diffBookings({ before: pair.left, after: pair.right, completeness: pair.completeness })
    const afterCount = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM change_events')
    return send(res, 200, { leftId, rightId, events: diff.ambiguous ? [] : diff.events, ambiguous: diff.ambiguous, unresolvedAbsences: diff.unresolvedAbsences, changed: beforeCount.rows[0]?.count !== afterCount.rows[0]?.count }, correlationId)
  }
  if (route === 'source-status') {
    const state = await loadState(client)
    return send(res, 200, sourceView(state, now, config), correlationId)
  }
  if (route === 'source-check') {
    requireRole(actor, ['specialist', 'lead'])
    if (config.sourceAdapter !== 'sample') throw new HttpError(503, 'SOURCE_NOT_CONFIGURED', 'Подключение Aviabit не настроено')
    const body = await readJson(req, config.bodyLimitBytes)
    const fixture = typeof body.fixture === 'string' ? body.fixture : 'base'
    await client.query('SELECT pg_advisory_xact_lock(8412001)')
    const result = await runSampleCheck(client, { fixtureName: fixture, trigger: 'manual', actor, now, correlationId })
    return send(res, 202, result, correlationId)
  }
  if (route === 'imports') {
    requireRole(actor, ['specialist', 'lead'])
    const filename = decodedFilename(headerOne(req, 'x-filename'))
    const bytes = await readRaw(req, config.importLimitBytes)
    let table: ReturnType<typeof readFirstSheet>
    try {
      table = readFirstSheet(bytes)
    } catch (error) {
      if (!(error instanceof XlsxLimitError)) throw error
      const importId = await recordRejectedImport(client, actor, now, correlationId, { filename, bytes })
      return send(res, 422, { error: { code: 'IMPORT_LIMIT_EXCEEDED', message: 'Файл превышает лимит разбора', details: { importId }, correlationId } }, correlationId)
    }
    let normalized: ReturnType<typeof normalizeAviabitTable>
    try {
      normalized = normalizeAviabitTable(table)
    } catch (error) {
      if (!(error instanceof ImportSchemaError)) throw error
      const importId = await recordRejectedImport(client, actor, now, correlationId, { filename, bytes })
      return send(res, 503, { error: { code: 'SOURCE_SCHEMA_UNVERIFIED', message: 'Формат выгрузки не утверждён', details: { importId }, correlationId } }, correlationId)
    }
    if (normalized.length === 0) {
      const importId = await recordRejectedImport(client, actor, now, correlationId, { filename, bytes })
      return send(res, 503, { error: { code: 'SOURCE_SCHEMA_UNVERIFIED', message: 'Формат выгрузки не утверждён', details: { importId }, correlationId } }, correlationId)
    }
    await client.query('SELECT pg_advisory_xact_lock(8412001)')
    const result = await runImportedRows(client, {
      filename,
      actor,
      now,
      correlationId,
      rows: normalized.map((row) => ({
        sourceBookingId: row.sourceBookingId,
        sourceCrewId: row.sourceCrewId,
        sourceHotelId: row.sourceHotelId,
        airportCode: row.airportCode,
        stayDate: row.localStayDate ?? (row.arrivalLocalDate || null),
        fullName: row.fullNameSource,
        position: row.position,
        gender: row.gender,
        arrivalFlight: row.arrivalFlight,
        arrivalLocalDate: row.arrivalLocalDate,
        arrivalLocalTime: row.arrivalLocalTime,
        departureFlight: row.departureFlight,
        departureLocalDate: row.departureLocalDate,
        departureLocalTime: row.departureLocalTime,
        roomType: row.roomType,
        recordStatus: 'active',
        replacementOf: null,
      })),
    })
    const importId = result.snapshotId ? await recordAcceptedImport(client, actor, now, correlationId, { filename, bytes, snapshotId: result.snapshotId, rowCount: normalized.length }) : null
    return send(res, 202, { ...result, importId, rowCount: normalized.length }, correlationId)
  }
  if (route === 'import') {
    const row = await client.query('SELECT id, filename_sanitized, status, sha256, size_bytes, error_report_safe, result_snapshot_id, unresolved_identity_count, unresolved_hotel_count FROM import_batches WHERE id = $1', [params.id])
    if (!row.rows[0]) throw new HttpError(404, 'IMPORT_NOT_FOUND', 'Импорт не найден')
    return send(res, 200, row.rows[0], correlationId)
  }
  if (route === 'baselines') {
    requireRole(actor, ['specialist', 'lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    const result = await establishBaseline(client, {
      groupId: requiredString(body.groupId),
      snapshotId: requiredString(body.snapshotId),
      actor,
      now,
      correlationId,
      evidence: requiredString(body.evidence),
      confirmed: body.confirmed === true,
    })
    return send(res, 201, result, correlationId)
  }
  if (route === 'prepare') {
    requireRole(actor, ['specialist', 'lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    const result = await prepareGroup(client, {
      groupId: params.id ?? '',
      actor,
      now,
      correlationId,
      bypassQuiet: body.bypassQuiet === true,
      reason: typeof body.reason === 'string' ? body.reason : null,
      automatic: false,
    })
    return send(res, 201, result, correlationId)
  }
  if (route === 'drafts') {
    const rows = await client.query('SELECT id, group_key, status, current_revision, created_at FROM drafts ORDER BY created_at DESC LIMIT 100')
    return send(res, 200, { items: rows.rows, nextCursor: null }, correlationId)
  }
  if (route === 'draft') return send(res, 200, await loadDraftView(client, params.id ?? ''), correlationId)
  if (route === 'draft-patch') {
    requireRole(actor, ['specialist', 'lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    const result = await patchDraft(client, {
      draftId: params.id ?? '',
      actor,
      now,
      correlationId,
      expectedRevision: requiredNumber(body.expectedRevision),
      subject: requiredString(body.subject),
      intro: requiredString(body.intro),
      closing: requiredString(body.closing),
      signature: requiredString(body.signature),
      recipients: stringList(body.recipients),
      cc: stringList(body.cc ?? []),
      overrides: Array.isArray(body.overrides) ? body.overrides as Array<{ bookingId: string; field: string; value: string; reason: string }> : [],
    })
    return send(res, 200, { id: params.id, ...result, reviewedAt: null }, correlationId)
  }
  if (route === 'draft-review') {
    requireRole(actor, ['specialist', 'lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    const result = await reviewDraft(client, {
      draftId: params.id ?? '',
      actor,
      now,
      correlationId,
      revision: requiredNumber(body.revision),
      fingerprint: requiredString(body.fingerprint),
      confirmed: body.confirmed === true,
    })
    return send(res, 200, result, correlationId)
  }
  if (route === 'draft-rebuild') {
    requireRole(actor, ['specialist', 'lead'])
    const result = await rebuildDraft(client, { draftId: params.id ?? '', actor, now, correlationId })
    return send(res, 200, result, correlationId)
  }
  if (route === 'draft-send') {
    requireRole(actor, ['specialist', 'lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    const idempotencyKey = headerOne(req, 'idempotency-key')
    if (!idempotencyKey) throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', 'Нужен Idempotency-Key')
    const started = await beginSend(client, config, {
      draftId: params.id ?? '',
      actor,
      now,
      correlationId,
      revision: requiredNumber(body.revision),
      idempotencyKey,
      confirmed: body.confirmed === true,
    })
    if (!started.pending) return send(res, 202, { notificationId: started.notificationId, transportStatus: started.transportStatus }, correlationId)
    const outcome = mailOutcome(req, config)
    const finished = await finishSend(client, { notificationId: started.notificationId, outcome, now, correlationId, actorId: actor.id })
    return send(res, 202, finished, correlationId)
  }
  if (route === 'draft-handoff') {
    requireRole(actor, ['specialist', 'lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    const idempotencyKey = headerOne(req, 'idempotency-key')
    if (!idempotencyKey) throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', 'Нужен Idempotency-Key')
    const result = await handoffDraft(client, { draftId: params.id ?? '', actor, now, correlationId, revision: requiredNumber(body.revision), idempotencyKey })
    return send(res, 200, result, correlationId)
  }
  if (route === 'notifications') {
    const rows = await client.query(
      `SELECT n.id, n.group_key, n.transport_status, n.sent_at, n.external_confirmation_at, n.created_at, v.revision, n.archived_payload -> 'letter' AS letter
       FROM notifications n JOIN draft_versions v ON v.id = n.draft_version_id ORDER BY n.created_at DESC LIMIT 100`,
    )
    return send(res, 200, { items: rows.rows, nextCursor: null }, correlationId)
  }
  if (route === 'notification') {
    const row = await client.query('SELECT id, group_key, transport_status, archived_payload, sent_at, external_confirmation_at, confirmation_basis, created_at FROM notifications WHERE id = $1', [params.id])
    if (!row.rows[0]) throw new HttpError(404, 'NOTIFICATION_NOT_FOUND', 'Уведомление не найдено')
    return send(res, 200, row.rows[0], correlationId)
  }
  if (route === 'confirm') {
    requireRole(actor, ['specialist', 'lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    const result = await confirmExternal(client, {
      notificationId: params.id ?? '',
      actor,
      now,
      correlationId,
      basis: requiredString(body.basis),
      sentAt: requiredString(body.sentAt),
      confirmed: body.confirmed === true,
    })
    return send(res, 200, result, correlationId)
  }
  if (route === 'audit') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 25), 100)
    const rows = await client.query(
      `SELECT a.id, a.occurred_at, a.action, a.entity_type, a.result, a.group_key, a.service_actor, a.safe_details, u.display_name
       FROM audit_events a LEFT JOIN app_users u ON u.id = a.actor_user_id ORDER BY a.occurred_at DESC, a.id DESC LIMIT $1`,
      [Number.isFinite(limit) ? limit : 25],
    )
    return send(res, 200, { items: rows.rows, nextCursor: null }, correlationId)
  }
  if (route === 'audit-export') {
    const rows = await client.query<{ occurred_at: Date | string; action: string; entity_type: string; result: string; group_key: string | null; service_actor: string | null; display_name: string | null }>(
      `SELECT a.occurred_at, a.action, a.entity_type, a.result, a.group_key, a.service_actor, u.display_name
       FROM audit_events a LEFT JOIN app_users u ON u.id = a.actor_user_id ORDER BY a.occurred_at DESC LIMIT 1000`,
    )
    const csv = buildCsv(
      ['occurred_at', 'actor', 'action', 'entity_type', 'result', 'group_key'],
      rows.rows.map((row) => [new Date(row.occurred_at).toISOString(), row.display_name ?? row.service_actor ?? 'system', row.action, row.entity_type, row.result, row.group_key ?? '']),
    )
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'x-correlation-id': correlationId })
    res.end(csv)
    return
  }
  if (route === 'settings') {
    const row = await client.query('SELECT poll_minutes, quiet_minutes, auto_check, auto_prepare, stay_scope, stale_after_minutes, template_version, row_version, sender_name FROM app_settings WHERE id = 1')
    const settings = row.rows[0] as { poll_minutes: number; quiet_minutes: number; auto_check: boolean; auto_prepare: boolean; stay_scope: string; stale_after_minutes: number; template_version: number; row_version: number; sender_name: string }
    return send(res, 200, { pollMinutes: settings.poll_minutes, quietMinutes: settings.quiet_minutes, autoCheck: settings.auto_check, autoPrepare: settings.auto_prepare, stayScope: settings.stay_scope, staleAfterMinutes: settings.stale_after_minutes, templateVersion: settings.template_version, version: Number(settings.row_version), senderName: settings.sender_name, requireHumanReview: true }, correlationId)
  }
  if (route === 'settings-patch') {
    requireRole(actor, ['specialist', 'lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    const result = await patchSettings(client, actor, now, correlationId, ifMatch(req), body)
    return send(res, 200, result, correlationId)
  }
  if (route === 'hotels') {
    const query = url.searchParams.get('query') ?? ''
    const rows = await client.query(
      `SELECT id, source_hotel_id, name, city, airport_code, timezone, recipients, cc, contract_status, active, row_version, comment
       FROM hotels WHERE name ILIKE $1 ESCAPE '\\' ORDER BY name LIMIT 100`,
      [`%${query.replace(/[\\%_]/g, '\\$&')}%`],
    )
    return send(res, 200, { items: rows.rows, nextCursor: null }, correlationId)
  }
  if (route === 'hotel-create') {
    requireRole(actor, ['lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    return send(res, 201, await createHotel(client, actor, now, correlationId, body), correlationId)
  }
  if (route === 'hotel-patch') {
    requireRole(actor, ['lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    return send(res, 200, await patchHotel(client, actor, now, correlationId, params.id ?? '', ifMatch(req), body), correlationId)
  }
  if (route === 'templates') {
    const rows = await client.query(
      `SELECT DISTINCT ON (template_key) template_key, version, blocks, columns, new_label, cancel_label FROM template_versions ORDER BY template_key, version DESC`,
    )
    return send(res, 200, { items: rows.rows }, correlationId)
  }
  if (route === 'template-versions') {
    const rows = await client.query('SELECT version, created_at FROM template_versions WHERE template_key = $1 ORDER BY version', [params.key])
    return send(res, 200, { items: rows.rows }, correlationId)
  }
  if (route === 'template-publish') {
    requireRole(actor, ['lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    return send(res, 201, await publishTemplate(client, actor, now, correlationId, params.key ?? '', body), correlationId)
  }
  if (route === 'exceptions') {
    const rows = await client.query(`SELECT id, group_key, kind, severity, status, message FROM exceptions WHERE status <> 'resolved' ORDER BY created_at DESC LIMIT 100`)
    return send(res, 200, { items: rows.rows, nextCursor: null }, correlationId)
  }
  if (route === 'exception-hold') {
    requireRole(actor, ['specialist', 'lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    await holdException(client, actor, now, correlationId, params.id ?? '', requiredString(body.comment))
    return send(res, 200, { status: 'held' }, correlationId)
  }
  if (route === 'exception-resolve') {
    requireRole(actor, ['specialist', 'lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    await resolveException(client, actor, now, correlationId, params.id ?? '', body)
    return send(res, 200, { status: 'resolved' }, correlationId)
  }
  if (route === 'integrations') {
    return send(res, 200, { items: [{ adapter: 'source', mode: config.sourceAdapter, configured: config.sourceAdapter === 'sample' }, { adapter: 'mail', mode: config.mailAdapter, configured: config.mailAdapter === 'scripted' }] }, correlationId)
  }
  if (route === 'integration-test') {
    requireRole(actor, ['lead'])
    const body = await readJson(req, config.bodyLimitBytes)
    if ('url' in body || 'endpoint' in body) throw new HttpError(400, 'URL_NOT_ACCEPTED', 'Адрес подключения из запроса не принимается')
    const adapter = params.adapter
    if (adapter === 'mail' || config.mailAdapter === 'disabled' && adapter === 'mail') throw new HttpError(503, 'MAIL_NOT_CONFIGURED', 'Почтовый шлюз не настроен')
    if (adapter === 'source' && config.sourceAdapter === 'disabled') throw new HttpError(503, 'SOURCE_NOT_CONFIGURED', 'Подключение Aviabit не настроено')
    if (adapter !== 'source' && adapter !== 'mail') throw new HttpError(404, 'NOT_FOUND', 'Адаптер не найден')
    await client.query(`UPDATE integration_configs SET last_test_at = $2, last_error_code = NULL, updated_at = $2 WHERE adapter_key = $1`, [adapter, now.toISOString()])
    return send(res, 200, { adapter, mode: adapter === 'source' ? config.sourceAdapter : config.mailAdapter, ok: adapter === 'source' && config.sourceAdapter === 'sample' }, correlationId)
  }
  if (route === 'job') {
    const row = await client.query('SELECT id, job_type, status, last_error_code, attempt, due_at FROM jobs WHERE id = $1', [params.id])
    if (!row.rows[0]) throw new HttpError(404, 'JOB_NOT_FOUND', 'Задание не найдено')
    return send(res, 200, row.rows[0], correlationId)
  }
  throw new HttpError(404, 'NOT_FOUND', 'Маршрут не найден')
}

function matchRoute(method: string, pathname: string): Record<string, string> | null {
  const routes: Array<[string, string, string]> = [
    ['POST', '/api/v1/session/logout', 'logout'],
    ['POST', '/api/v1/session', 'login'],
    ['GET', '/api/v1/me', 'me'],
    ['GET', '/api/v1/overview', 'overview'],
    ['GET', '/api/v1/groups', 'groups'],
    ['GET', '/api/v1/groups/:id', 'group'],
    ['POST', '/api/v1/groups/:id/prepare', 'prepare'],
    ['GET', '/api/v1/corrections', 'corrections'],
    ['GET', '/api/v1/snapshots/compare', 'compare'],
    ['GET', '/api/v1/snapshots', 'snapshots'],
    ['GET', '/api/v1/snapshots/:id', 'snapshot'],
    ['GET', '/api/v1/source/status', 'source-status'],
    ['POST', '/api/v1/source/check', 'source-check'],
    ['POST', '/api/v1/imports', 'imports'],
    ['GET', '/api/v1/imports/:id', 'import'],
    ['POST', '/api/v1/baselines', 'baselines'],
    ['GET', '/api/v1/drafts', 'drafts'],
    ['GET', '/api/v1/drafts/:id', 'draft'],
    ['PATCH', '/api/v1/drafts/:id', 'draft-patch'],
    ['POST', '/api/v1/drafts/:id/review', 'draft-review'],
    ['POST', '/api/v1/drafts/:id/rebuild', 'draft-rebuild'],
    ['POST', '/api/v1/drafts/:id/send', 'draft-send'],
    ['POST', '/api/v1/drafts/:id/handoff', 'draft-handoff'],
    ['GET', '/api/v1/notifications', 'notifications'],
    ['GET', '/api/v1/notifications/:id', 'notification'],
    ['POST', '/api/v1/notifications/:id/confirm-external', 'confirm'],
    ['GET', '/api/v1/audit/events', 'audit'],
    ['GET', '/api/v1/audit/export', 'audit-export'],
    ['GET', '/api/v1/settings', 'settings'],
    ['PATCH', '/api/v1/settings', 'settings-patch'],
    ['GET', '/api/v1/hotels', 'hotels'],
    ['POST', '/api/v1/hotels', 'hotel-create'],
    ['PATCH', '/api/v1/hotels/:id', 'hotel-patch'],
    ['GET', '/api/v1/templates', 'templates'],
    ['GET', '/api/v1/templates/:key/versions', 'template-versions'],
    ['POST', '/api/v1/templates/:key/versions', 'template-publish'],
    ['GET', '/api/v1/exceptions', 'exceptions'],
    ['POST', '/api/v1/exceptions/:id/hold', 'exception-hold'],
    ['POST', '/api/v1/exceptions/:id/resolve', 'exception-resolve'],
    ['GET', '/api/v1/integrations/status', 'integrations'],
    ['POST', '/api/v1/integrations/:adapter/test', 'integration-test'],
    ['GET', '/api/v1/jobs/:id', 'job'],
  ]
  for (const [routeMethod, pattern, route] of routes) {
    if (routeMethod !== method) continue
    const names: string[] = []
    const regex = new RegExp(`^${pattern.replace(/:([A-Za-z]+)/g, (_full, name: string) => { names.push(name); return '([^/]+)' })}$`)
    const found = regex.exec(pathname)
    if (!found) continue
    return { route, ...Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(found[index + 1] ?? '')])) }
  }
  return null
}

async function authenticate(req: IncomingMessage, config: AppConfig, client: Parameters<Parameters<typeof withTransaction>[1]>[0]): Promise<Actor | null> {
  if (config.authMode === 'disabled') throw new HttpError(401, 'AUTH_NOT_CONFIGURED', 'Корпоративный вход не настроен')
  if (config.authMode === 'password') {
    const token = readSessionToken(headerOne(req, 'cookie'))
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Нет сессии')
    const actor = await actorFromSession(client, token, config.now())
    if (!actor) throw new HttpError(401, 'UNAUTHENTICATED', 'Нет сессии')
    return actor
  }
  const subject = headerOne(req, 'x-dev-subject')
  if (!subject) throw new HttpError(401, 'UNAUTHENTICATED', 'Нет сессии')
  const result = await client.query<{ id: string; external_subject: string; display_name: string; role: Actor['role']; active: boolean; position_title: string | null }>(
    'SELECT id, external_subject, display_name, role, active, position_title FROM app_users WHERE external_subject = $1',
    [subject],
  )
  const user = result.rows[0]
  if (!user?.active) throw new HttpError(401, 'UNAUTHENTICATED', 'Нет сессии')
  return { id: user.id, externalSubject: user.external_subject, displayName: user.display_name, role: user.role, positionTitle: user.position_title }
}

function requireRole(actor: Actor, roles: Array<Actor['role']>): void {
  if (!roles.includes(actor.role)) throw new HttpError(403, 'FORBIDDEN', 'Недостаточно прав')
}

function permissions(role: Actor['role']): string[] {
  const specialist = ['queue.read', 'source.check', 'draft.write', 'baseline.establish', 'settings.quiet']
  if (role === 'lead') return [...specialist, 'hotel.write', 'template.write', 'settings.write', 'integration.test']
  if (role === 'specialist') return specialist
  return []
}

function sourceView(state: Awaited<ReturnType<typeof loadState>>, now: Date, config: AppConfig) {
  return {
    adapter: config.sourceAdapter,
    lastStatus: state.lastRunStatus,
    lastSuccessAt: state.lastSuccessAt,
    lastErrorCode: state.lastErrorCode,
    problem: sourceProblem(state, now),
    latestSnapshotId: state.latest?.id ?? null,
    validationStatus: state.latest?.validationStatus ?? null,
  }
}

function publicGroup(group: ReturnType<typeof projectGroups>[number]) {
  return {
    id: group.id,
    groupKey: group.groupKey,
    hotel: group.hotel,
    airportCode: group.airportCode,
    stayDate: group.stayDate,
    status: group.status,
    changeCount: group.changeCount,
    changes: group.changes,
    lastMeaningfulChangeAt: group.lastMeaningfulChangeAt,
    dueAt: group.dueAt,
    draftId: group.draftId,
    draftStatus: group.draftStatus,
    revision: group.revision,
    version: group.version,
    exceptions: group.exceptions,
    latestBookings: group.latestBookings,
    baselineBookings: group.baselineBookings,
  }
}

async function loadPair(client: Parameters<Parameters<typeof withTransaction>[1]>[0], leftId: string, rightId: string): Promise<{ left: CanonicalBooking[]; right: CanonicalBooking[]; completeness: 'full' | 'unknown' }> {
  const heads = await client.query<{ id: string; completeness: 'full' | 'unknown' }>('SELECT id, completeness FROM snapshots WHERE id = ANY($1::uuid[])', [[leftId, rightId]])
  if (heads.rows.length !== 2) throw new HttpError(404, 'SNAPSHOT_NOT_FOUND', 'Снимок не найден')
  const rows = await client.query(
    `SELECT snapshot_id, source_booking_id, source_crew_id, hotel_id, airport_code, stay_date::text, full_name, position, gender, arrival_flight,
            arrival_local_date::text, arrival_local_time::text, departure_flight, departure_local_date::text, departure_local_time::text, room_type, record_status, replacement_of
     FROM snapshot_bookings WHERE snapshot_id = ANY($1::uuid[])`,
    [[leftId, rightId]],
  )
  const mapRow = (row: Record<string, unknown>): CanonicalBooking => ({
    id: (row.source_booking_id as string | null) ?? null,
    crewId: (row.source_crew_id as string | null) ?? null,
    hotelId: (row.hotel_id as string | null) ?? null,
    airportCode: String(row.airport_code).trim(),
    stayDate: row.stay_date ? String(row.stay_date).slice(0, 10) : null,
    fullName: String(row.full_name),
    position: (row.position as string | null) ?? null,
    gender: (row.gender as 'M' | 'F' | null) ?? null,
    arrivalFlight: String(row.arrival_flight ?? ''),
    arrivalLocalDate: row.arrival_local_date ? String(row.arrival_local_date).slice(0, 10) : '',
    arrivalLocalTime: row.arrival_local_time ? String(row.arrival_local_time).slice(0, 5) : '',
    departureFlight: String(row.departure_flight ?? ''),
    departureLocalDate: row.departure_local_date ? String(row.departure_local_date).slice(0, 10) : '',
    departureLocalTime: row.departure_local_time ? String(row.departure_local_time).slice(0, 5) : '',
    roomType: (row.room_type as 'SGL' | 'DBL' | null) ?? null,
    recordStatus: ((row.record_status as string | null) ?? 'active') as 'active' | 'cancelled',
    replacementOf: (row.replacement_of as string | null) ?? null,
  })
  const leftCompleteness = heads.rows.find((row) => row.id === leftId)?.completeness ?? 'unknown'
  const rightCompleteness = heads.rows.find((row) => row.id === rightId)?.completeness ?? 'unknown'
  return {
    left: rows.rows.filter((row) => row.snapshot_id === leftId).map((row) => mapRow(row as Record<string, unknown>)),
    right: rows.rows.filter((row) => row.snapshot_id === rightId).map((row) => mapRow(row as Record<string, unknown>)),
    completeness: leftCompleteness === 'full' && rightCompleteness === 'full' ? 'full' : 'unknown',
  }
}

function page<T>(items: T[], url: URL): { items: T[]; nextCursor: string | null } {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 25), 100)
  const offset = Number(url.searchParams.get('offset') ?? 0)
  const start = Number.isFinite(offset) ? offset : 0
  const slice = items.slice(start, start + (Number.isFinite(limit) ? limit : 25))
  return { items: slice, nextCursor: start + slice.length < items.length ? String(start + slice.length) : null }
}

function mailOutcome(req: IncomingMessage, config: AppConfig): 'accept' | 'reject' | 'timeout' {
  if (config.mailAdapter !== 'scripted' || config.nodeEnv === 'production') return 'timeout'
  const outcome = headerOne(req, 'x-test-mail-outcome')
  if (outcome === 'accept' || outcome === 'reject' || outcome === 'timeout') return outcome
  return 'timeout'
}

function assertOrigin(req: IncomingMessage, config: AppConfig): void {
  const origin = headerOne(req, 'origin')
  if (!origin || config.allowedOrigins.includes(origin)) return
  if (config.nodeEnv !== 'production' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return
  throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Источник запроса не разрешён')
}

export function clearRateLimits(): void {
  hits.clear()
}

function allowRate(req: IncomingMessage, url: URL, config: AppConfig): boolean {
  const login = req.method === 'POST' && url.pathname === '/api/v1/session'
  const key = `${login ? 'login:' : 'api:'}${clientAddress(req, config)}`
  const limit = login ? config.loginRateLimitPerMinute : config.rateLimitPerMinute
  const now = Date.now()
  const recent = (hits.get(key) ?? []).filter((at) => at > now - 60_000)
  if (recent.length >= limit) {
    hits.set(key, recent)
    return false
  }
  recent.push(now)
  hits.set(key, recent)
  if (hits.size > 10_000) {
    const oldest = hits.keys().next().value
    if (oldest) hits.delete(oldest)
  }
  return true
}

async function readJson(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const type = headerOne(req, 'content-type') ?? ''
  if (!type.includes('application/json')) throw new HttpError(415, 'UNSUPPORTED_MEDIA', 'Нужен application/json')
  const raw = await readRaw(req, limit)
  if (raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'INVALID_JSON', 'Ожидается объект JSON')
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'INVALID_JSON', 'Некорректный JSON')
  }
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new HttpError(413, 'BODY_TOO_LARGE', 'Тело запроса слишком большое')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function headerOne(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name]
  return typeof value === 'string' ? value : null
}

function decodedFilename(value: string | null): string {
  if (!value) return 'upload.bin'
  try {
    return decodeURIComponent(value).slice(0, 200)
  } catch {
    return value.slice(0, 200)
  }
}

function ifMatch(req: IncomingMessage): number {
  const value = headerOne(req, 'if-match')?.replaceAll('"', '')
  const version = Number(value)
  if (!value || !Number.isInteger(version)) throw new HttpError(428, 'PRECONDITION_REQUIRED', 'Нужен If-Match')
  return version
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(422, 'FIELD_INVALID', 'Поле заполнено некорректно')
  return value
}

function requiredNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new HttpError(422, 'FIELD_INVALID', 'Ожидается число')
  return value
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new HttpError(422, 'FIELD_INVALID', 'Ожидается список строк')
  return value as string[]
}

function correlation(req: IncomingMessage): string {
  const incoming = headerOne(req, 'x-correlation-id')
  if (incoming && /^[A-Za-z0-9._:-]{1,80}$/.test(incoming)) return incoming
  return randomUUID()
}

function send(res: Reply | ServerResponse, status: number, body: unknown, correlationId: string, extra: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'",
    'x-correlation-id': correlationId,
    ...extra,
  }
  if (status !== 204) headers['content-type'] = 'application/json; charset=utf-8'
  res.writeHead(status, headers)
  res.end(status === 204 ? '' : JSON.stringify(body))
}

function profile(actor: Actor) {
  return {
    subject: actor.externalSubject,
    displayName: actor.displayName,
    role: actor.role,
    position: actor.positionTitle ?? null,
    permissions: permissions(actor.role),
  }
}

function assertCrewHeader(req: IncomingMessage): void {
  if (headerOne(req, 'x-crew-request') !== '1') throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Источник запроса не разрешён')
}

function clientAddress(req: IncomingMessage, config: AppConfig): string {
  const remote = normalizeAddress(req.socket.remoteAddress ?? '')
  const forwarded = normalizeAddress(headerOne(req, 'x-real-ip') ?? '')
  if (forwarded && remote && isIP(remote) && isIP(forwarded) && config.trustedProxies.check(remote, remote.includes(':') ? 'ipv6' : 'ipv4')) {
    return forwarded.slice(0, 64)
  }
  return remote.slice(0, 64) || 'local'
}

function isClosedRequest(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = 'code' in error ? String(error.code) : ''
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ABORT_ERR' || error.message === 'aborted'
}

function normalizeAddress(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed
}

async function handleCredential(
  req: IncomingMessage,
  res: ServerResponse,
  pool: Pool,
  config: AppConfig,
  route: string,
  correlationId: string,
): Promise<void> {
  assertCrewHeader(req)
  if (route === 'logout') {
    await logoutSession(pool, config, readSessionToken(headerOne(req, 'cookie')), correlationId)
    send(res, 204, null, correlationId, { 'set-cookie': clearedSessionCookie(config.cookieSecure) })
    return
  }
  const body = await readJson(req, config.bodyLimitBytes)
  const issued = await loginWithPassword(pool, config, {
    email: body.email,
    password: body.password,
    ip: clientAddress(req, config),
    correlationId,
  })
  send(res, 200, profile(issued.actor), correlationId, { 'set-cookie': sessionCookie(issued.token, config.cookieSecure) })
}

function sendError(res: ServerResponse, error: unknown, correlationId: string): void {
  if (res.destroyed || isClosedRequest(error)) return
  if (res.headersSent) return
  const pgCode = typeof error === 'object' && error && 'code' in error ? String(error.code) : ''
  if (pgCode === '23505') {
    send(res, 409, { error: { code: 'CONFLICT', message: 'Конфликт уникальности', correlationId } }, correlationId)
    return
  }
  if (error instanceof AuthBusyError) {
    send(res, 503, { error: { code: 'AUTH_BUSY', message: 'Вход временно перегружен', correlationId } }, correlationId)
    return
  }
  if (error instanceof HttpError) {
    send(res, error.status, { error: { code: error.code, message: error.message, details: error.details, correlationId } }, correlationId)
    return
  }
  console.error(JSON.stringify({ correlationId, name: error instanceof Error ? error.name : 'error' }))
  send(res, 500, { error: { code: 'INTERNAL', message: 'Внутренняя ошибка', correlationId } }, correlationId)
}
