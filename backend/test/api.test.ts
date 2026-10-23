import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sheetWorkbook } from './support/xlsx-bytes.ts'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { readConfig } from '../src/config.ts'
import { createPool } from '../src/db/pool.ts'
import { migrate } from '../src/db/migrate.ts'
import { insertUser, resetBusinessData } from '../src/db/reference.ts'
import { importPauseWaiting, pauseNextImport, startServer, type RunningServer } from '../src/http/server.ts'
import { transactionDepth } from '../src/db/pool.ts'
import { runScheduler } from '../src/services/scheduler.ts'

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://crew:crew@127.0.0.1:54329/crew_support_test'
let now = new Date('2026-10-20T11:00:00.000Z')
let server: RunningServer
let pool = createPool(databaseUrl)

async function api(path: string, options: { method?: string; role?: 'specialist' | 'lead' | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers = new Headers(options.headers)
  if (options.role !== null) headers.set('x-dev-subject', options.role === 'lead' ? 'dev-lead' : 'dev-specialist')
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(`${server.url}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {}, text }
}

function listed<T>(response: { body: Record<string, unknown> }): T[] {
  return response.body.items as T[]
}

before(async () => {
  await migrate(databaseUrl)
  server = await startServer(readConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    AUTH_MODE: 'mock',
    SOURCE_ADAPTER: 'sample',
    MAIL_ADAPTER: 'scripted',
    PORT: '0',
    RATE_LIMIT_PER_MINUTE: '10000',
    UNKNOWN_AFTER_SECONDS: '60',
  }, () => now))
})

after(async () => {
  await server.close()
  await pool.end()
})

beforeEach(async () => {
  now = new Date('2026-10-20T11:00:00.000Z')
  await resetBusinessData(pool)
  await insertUser(pool, 'dev-specialist', 'Специалист смены', 'specialist')
  await insertUser(pool, 'dev-lead', 'Старший смены', 'lead')
  for (const hotel of [
    ['angel', 'Гостиница Ангел', 'Екатеринбург', 'SVX', 'Asia/Yekaterinburg'],
    ['bereg', 'Гостиница Берег', 'Екатеринбург', 'SVX', 'Asia/Yekaterinburg'],
    ['south', 'Гостиница Юг', 'Сочи', 'AER', 'Europe/Moscow'],
    ['north', 'Гостиница Север', 'Сочи', 'AER', 'Europe/Moscow'],
  ]) {
    await pool.query(
      `INSERT INTO hotels (source_hotel_id, name, city, airport_code, timezone, recipients, cc, contract_status, active)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, '[]'::jsonb, 'confirmed', true)`,
      [hotel[0], hotel[1], hotel[2], hotel[3], hotel[4], JSON.stringify([`hotel-${hotel[0]}@example.com`])],
    )
  }
})

test('anonymous and forged role are rejected', async () => {
  assert.equal((await api('/api/v1/me', { role: null })).status, 401)
  const denied = await api('/api/v1/templates/adjustment/versions', { method: 'POST', body: { blocks: [], columns: [], newLabel: 'a', cancelLabel: 'b' }, headers: { 'x-role': 'lead' } })
  assert.equal(denied.status, 403)
  assert.equal(denied.body.error && (denied.body.error as { code: string }).code, 'FORBIDDEN')
})

test('unchanged polls do not move the queue and a later change resets dueAt', async () => {
  const first = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  assert.equal(first.status, 202)
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  const snapshots = await pool.query('SELECT count(*)::int AS count FROM snapshots')
  assert.equal(snapshots.rows[0]?.count, 1)
  const listed = await api('/api/v1/groups?limit=100')
  const items = listed.body.items as Array<{ id: string; dueAt: string | null; crewNames: string[] }>
  const angel = items.find((item) => item.crewNames.some((name) => name.startsWith('Иванов')))
  const petr = items.find((item) => item.crewNames.some((name) => name.startsWith('Петров')))
  assert.ok(angel && petr)
  assert.equal(angel.dueAt, null)
  const baseline = await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: first.body.snapshotId, evidence: 'Сверка с рассылкой 06:00', confirmed: true } })
  assert.equal(baseline.status, 201)
  const blocked = await api(`/api/v1/groups/${petr.id}/prepare`, { method: 'POST', body: {} })
  assert.equal((blocked.body.error as { code: string }).code, 'BASELINE_NOT_CONFIRMED')
  now = new Date('2026-10-20T11:00:00.000Z')
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  now = new Date('2026-10-20T11:05:00.000Z')
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed_more' } })
  const after = await api('/api/v1/groups?limit=100')
  const nextItems = after.body.items as Array<{ dueAt: string | null; crewNames: string[] }>
  const ivan = nextItems.find((item) => item.crewNames.some((name) => name.startsWith('Иванов')))
  const other = nextItems.find((item) => item.crewNames.some((name) => name.startsWith('Петров')))
  assert.equal(ivan?.dueAt, '2026-10-20T12:05:00.000Z')
  assert.equal(other?.dueAt, null)
  const eventsBefore = await pool.query('SELECT count(*)::int AS count FROM change_events')
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'reverted' } })
  const quiet = await api('/api/v1/groups?limit=100')
  const reverted = (quiet.body.items as Array<{ dueAt: string | null; crewNames: string[] }>).find((item) => item.crewNames.some((name) => name.startsWith('Иванов')))
  assert.equal(reverted?.dueAt, null)
  const eventsAfter = await pool.query('SELECT count(*)::int AS count FROM change_events')
  assert.ok(eventsAfter.rows[0].count > eventsBefore.rows[0].count)
})

test('handoff keeps the baseline and external confirmation stores the archived letter', async () => {
  const checked = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  const angel = await angelGroup()
  await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: checked.body.snapshotId, evidence: 'Рассылка 06:00 зафиксирована', confirmed: true } })
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  const prepared = await api(`/api/v1/groups/${angel.id}/prepare`, { method: 'POST', body: { bypassQuiet: true, reason: 'Сверка со сменой' } })
  assert.equal(prepared.status, 201)
  const draft = await api(`/api/v1/drafts/${prepared.body.draftId}`)
  const reviewed = await api(`/api/v1/drafts/${prepared.body.draftId}/review`, { method: 'POST', body: { revision: draft.body.revision, fingerprint: draft.body.fingerprint, confirmed: true } })
  assert.equal(reviewed.status, 200)
  const before = await pool.query('SELECT count(*)::int AS count FROM notification_baselines')
  const handed = await api(`/api/v1/drafts/${prepared.body.draftId}/handoff`, { method: 'POST', body: { revision: draft.body.revision }, headers: { 'idempotency-key': randomUUID() } })
  assert.equal(handed.status, 200)
  const afterHandoff = await pool.query('SELECT count(*)::int AS count FROM notification_baselines')
  assert.equal(afterHandoff.rows[0].count, before.rows[0].count)
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed_more' } })
  const confirmed = await api(`/api/v1/notifications/${handed.body.notificationId}/confirm-external`, {
    method: 'POST',
    body: { confirmed: true, basis: 'Письмо отправлено из корпоративного клиента', sentAt: '2026-10-20T11:10:00.000Z' },
  })
  assert.equal(confirmed.status, 200)
  const current = await angelGroup()
  assert.equal(current.baselineBookings[0]?.arrivalLocalTime, '13:10')
  assert.equal(current.latestBookings[0]?.arrivalLocalTime, '13:40')
  assert.ok(current.changeCount > 0)
})

test('letter views carry everything the hotel preview renders', async () => {
  const checked = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  const angel = await angelGroup()
  await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: checked.body.snapshotId, evidence: 'Рассылка 06:00 зафиксирована', confirmed: true } })
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  const prepared = await api(`/api/v1/groups/${angel.id}/prepare`, { method: 'POST', body: { bypassQuiet: true, reason: 'Сверка со сменой' } })
  const draft = await api(`/api/v1/drafts/${prepared.body.draftId}`)
  assert.equal(draft.body.greeting, 'Добрый день!')
  assert.ok((draft.body.columns as Array<{ key: string }>).some((column) => column.key === 'arrivalTime'))
  assert.equal(draft.body.newLabel, 'Новая заявка')
  assert.equal(typeof draft.body.templateVersion, 'number')
  assert.ok(draft.body.createdAt)
  await api(`/api/v1/drafts/${prepared.body.draftId}/review`, { method: 'POST', body: { revision: draft.body.revision, fingerprint: draft.body.fingerprint, confirmed: true } })
  await api(`/api/v1/drafts/${prepared.body.draftId}/handoff`, { method: 'POST', body: { revision: draft.body.revision }, headers: { 'idempotency-key': randomUUID() } })
  const [notice] = listed<{ id: string; revision: number; subject: string; letter?: unknown }>(await api('/api/v1/notifications'))
  assert.equal(notice?.revision, draft.body.revision)
  assert.equal(notice?.letter, undefined)
  const opened = await api(`/api/v1/notifications/${notice?.id}`)
  assert.equal((opened.body.archived_payload as { letter: { subject: string } }).letter.subject, draft.body.subject)
  assert.ok(listed<{ display_name: string | null }>(await api('/api/v1/audit/events?limit=5')).some((item) => item.display_name))
  assert.ok((listed<{ blocks: unknown[] }>(await api('/api/v1/templates'))[0]?.blocks.length ?? 0) > 0)
  assert.ok((listed<{ row_count: number }>(await api('/api/v1/snapshots'))[0]?.row_count ?? 0) > 0)
})

test('unknown mail delivery is not retried and does not move the baseline', async () => {
  const checked = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  const angel = await angelGroup()
  await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: checked.body.snapshotId, evidence: 'База смены', confirmed: true } })
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  const prepared = await api(`/api/v1/groups/${angel.id}/prepare`, { method: 'POST', body: { bypassQuiet: true, reason: 'Проверка доставки' } })
  const draft = await api(`/api/v1/drafts/${prepared.body.draftId}`)
  await api(`/api/v1/drafts/${prepared.body.draftId}/review`, { method: 'POST', body: { revision: draft.body.revision, fingerprint: draft.body.fingerprint, confirmed: true } })
  const key = randomUUID()
  const sent = await api(`/api/v1/drafts/${prepared.body.draftId}/send`, { method: 'POST', body: { revision: draft.body.revision, confirmed: true }, headers: { 'idempotency-key': key, 'x-test-mail-outcome': 'timeout' } })
  assert.equal(sent.status, 202)
  assert.equal(sent.body.transportStatus, 'delivery_unknown')
  const replay = await api(`/api/v1/drafts/${prepared.body.draftId}/send`, { method: 'POST', body: { revision: draft.body.revision, confirmed: true }, headers: { 'idempotency-key': key, 'x-test-mail-outcome': 'accept' } })
  assert.equal(replay.body.notificationId, sent.body.notificationId)
  assert.equal(replay.body.transportStatus, 'delivery_unknown')
  const again = await api(`/api/v1/drafts/${prepared.body.draftId}/send`, { method: 'POST', body: { revision: draft.body.revision, confirmed: true }, headers: { 'idempotency-key': randomUUID(), 'x-test-mail-outcome': 'accept' } })
  assert.equal(again.status, 409)
  const baselines = await pool.query(`SELECT established_by FROM notification_baselines`)
  assert.deepEqual(baselines.rows.map((row) => row.established_by), ['manual_base'])
})

test('historical compare and hostile input do not change stored state', async () => {
  const first = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  const second = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  const before = await pool.query('SELECT count(*)::int AS count FROM change_events')
  const compared = await api(`/api/v1/snapshots/compare?leftId=${first.body.snapshotId}&rightId=${second.body.snapshotId}`)
  const after = await pool.query('SELECT count(*)::int AS count FROM change_events')
  assert.equal(compared.status, 200)
  assert.equal(compared.body.changed, false)
  assert.equal(after.rows[0].count, before.rows[0].count)
  const hotels = await api(`/api/v1/hotels?query=${encodeURIComponent(`%' OR '1'='1`)}`)
  assert.equal(hotels.status, 200)
  assert.equal((hotels.body.items as unknown[]).length, 0)
  const count = await pool.query('SELECT count(*)::int AS count FROM hotels')
  assert.equal(count.rows[0].count, 4)
  await pool.query(`UPDATE app_users SET display_name = '=SUM(A1)' WHERE external_subject = 'dev-specialist'`)
  await api('/api/v1/baselines', { method: 'POST', body: { groupId: (await angelGroup()).id, snapshotId: second.body.snapshotId, evidence: 'Формула в имени', confirmed: true } })
  const exported = await fetch(`${server.url}/api/v1/audit/export`, { headers: { 'x-dev-subject': 'dev-specialist' } })
  const csv = await exported.text()
  assert.match(csv, /'=SUM\(A1\)/)
  const uploaded = await fetch(`${server.url}/api/v1/imports`, { method: 'POST', headers: { 'x-dev-subject': 'dev-specialist', 'content-type': 'application/octet-stream', 'x-filename': '../secret.xlsx' }, body: Buffer.from('not-a-workbook') })
  assert.equal(uploaded.status, 422)
  assert.equal(((await uploaded.json()) as { error: { code: string } }).error.code, 'IMPORT_LIMIT_EXCEEDED')
  const huge = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base', padding: 'x'.repeat(70_000) } })
  assert.equal(huge.status, 413)
  const origin = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' }, headers: { origin: 'https://evil.example' } })
  assert.equal(origin.status, 403)
  const local = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' }, headers: { origin: 'http://127.0.0.1:5173' } })
  assert.equal(local.status, 202)
  const url = await api('/api/v1/integrations/source/test', { method: 'POST', role: 'lead', body: { url: 'http://127.0.0.1/admin' } })
  assert.equal(url.status, 400)
})

test('two saves of one revision conflict and ambiguous rows do not prepare a letter', async () => {
  const checked = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  const angel = await angelGroup()
  await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: checked.body.snapshotId, evidence: 'База для правки', confirmed: true } })
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  const prepared = await api(`/api/v1/groups/${angel.id}/prepare`, { method: 'POST', body: { bypassQuiet: true, reason: 'Две вкладки' } })
  const draft = await api(`/api/v1/drafts/${prepared.body.draftId}`)
  const patch = { expectedRevision: draft.body.revision, subject: 'Корректировка', intro: 'Текст', closing: 'Конец', signature: 'Crew Support', recipients: ['hotel-angel@example.com'], cc: [], overrides: [] }
  const [first, second] = await Promise.all([
    api(`/api/v1/drafts/${prepared.body.draftId}`, { method: 'PATCH', body: patch }),
    api(`/api/v1/drafts/${prepared.body.draftId}`, { method: 'PATCH', body: patch }),
  ])
  assert.deepEqual([first.status, second.status].sort(), [200, 409])
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'ambiguous' } })
  const exceptions = await api('/api/v1/exceptions')
  assert.ok((exceptions.body.items as Array<{ kind: string }>).some((item) => item.kind === 'hotel_mapping_ambiguous' || item.kind === 'identity_ambiguous'))
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'partial' } })
  const cancelled = await pool.query(`SELECT count(*)::int AS count FROM change_events WHERE kind = 'cancelled'`)
  assert.equal(cancelled.rows[0].count, 0)
})

test('a baseline accepts only the latest full snapshot for that group', async () => {
  const first = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  const angel = await angelGroup()
  const partial = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'partial' } })
  const partialBaseline = await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: partial.body.snapshotId, evidence: 'Неполный снимок', confirmed: true } })
  assert.equal(partialBaseline.status, 409)
  assert.equal((partialBaseline.body.error as { code: string }).code, 'SNAPSHOT_NOT_FULL')
  const blocked = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'ambiguous' } })
  const blockedBaseline = await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: blocked.body.snapshotId, evidence: 'Закрытый снимок', confirmed: true } })
  assert.equal(blockedBaseline.status, 409)
  assert.equal((blockedBaseline.body.error as { code: string }).code, 'SNAPSHOT_BLOCKED')
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  const stale = await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: first.body.snapshotId, evidence: 'Старый снимок', confirmed: true } })
  assert.equal(stale.status, 409)
  assert.equal((stale.body.error as { code: string }).code, 'SNAPSHOT_STALE')
  const empty = await pool.query<{ id: string }>(
    `INSERT INTO snapshots (source_run_id, source, series_id, seq, fetched_at, hash, validation_status, completeness)
     SELECT source_run_id, source, series_id, (SELECT max(seq) + 1 FROM snapshots WHERE series_id = s.series_id), fetched_at, 'empty-for-group', 'accepted', 'full'
     FROM snapshots s WHERE id = $1 RETURNING id`,
    [first.body.snapshotId],
  )
  const missing = await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: empty.rows[0]?.id, evidence: 'Чужая группа', confirmed: true } })
  assert.equal(missing.status, 409)
  assert.equal((missing.body.error as { code: string }).code, 'SNAPSHOT_GROUP_EMPTY')
  const stored = await pool.query('SELECT count(*)::int AS count FROM notification_baselines')
  assert.equal(stored.rows[0].count, 0)
})

test('a manual override must name a real booking field', async () => {
  const checked = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  const angel = await angelGroup()
  await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: checked.body.snapshotId, evidence: 'База для правки', confirmed: true } })
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  const prepared = await api(`/api/v1/groups/${angel.id}/prepare`, { method: 'POST', body: { bypassQuiet: true, reason: 'Проверка правки' } })
  const draft = await api(`/api/v1/drafts/${prepared.body.draftId}`)
  const revision = draft.body.revision
  const row = (draft.body.rows as Array<{ bookingId: string; arrivalTime: string }>)[0]
  assert.ok(row)
  const patch = (overrides: unknown) =>
    api(`/api/v1/drafts/${prepared.body.draftId}`, {
      method: 'PATCH',
      body: { expectedRevision: revision, subject: 'Корректировка', intro: 'Текст', closing: 'Конец', signature: 'Crew Support', recipients: ['hotel-angel@example.com'], cc: [], overrides },
    })
  const cases = [
    [{ bookingId: row.bookingId, field: 'roomType', value: 'INVALID', reason: 'Чужой тип' }],
    [{ bookingId: 'missing-booking', field: 'fullName', value: 'Иванов И.И.', reason: 'Нет такой строки' }],
    [{ bookingId: row.bookingId, field: 'gender', value: 'M', reason: 'Чужое поле' }],
    [{ bookingId: row.bookingId, field: 'arrivalDate', value: '31.02.2026', reason: 'Нет такой даты' }],
    [{ bookingId: row.bookingId, field: 'arrivalTime', value: '25:00', reason: 'Нет такого часа' }],
    [
      { bookingId: row.bookingId, field: 'arrivalTime', value: '13:10', reason: 'Первая правка' },
      { bookingId: row.bookingId, field: 'arrivalTime', value: '14:10', reason: 'Вторая правка' },
    ],
    Array.from({ length: 51 }, () => ({ bookingId: row.bookingId, field: 'arrivalTime', value: '13:10', reason: 'Лишняя правка' })),
    [{ bookingId: row.bookingId, field: 'fullName', value: 12, reason: 'Не строка' }],
  ]
  for (const overrides of cases) {
    const rejected = await patch(overrides)
    assert.equal(rejected.status, 422)
    const stored = await api(`/api/v1/drafts/${prepared.body.draftId}`)
    assert.equal(stored.body.revision, revision)
  }
  const reviewed = await api(`/api/v1/drafts/${prepared.body.draftId}/review`, { method: 'POST', body: { revision, fingerprint: draft.body.fingerprint, confirmed: true } })
  assert.equal(reviewed.status, 200)
  const nextTime = row.arrivalTime === '13:10' ? '14:10' : '13:10'
  const saved = await patch([{ bookingId: row.bookingId, field: 'arrivalTime', value: nextTime, reason: 'Уточнение у экипажа' }])
  assert.equal(saved.status, 200)
  assert.notEqual(saved.body.fingerprint, draft.body.fingerprint)
  assert.equal(saved.body.status, 'active')
  const viewed = await api(`/api/v1/drafts/${prepared.body.draftId}`)
  assert.equal(viewed.body.reviewedAt, null)
})

test('page limits must be whole numbers inside the allowed range', async () => {
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  const open = await api('/api/v1/groups')
  const blank = await api('/api/v1/groups?limit=&offset=')
  assert.equal(blank.status, 200)
  assert.equal((blank.body.items as unknown[]).length, (open.body.items as unknown[]).length)
  assert.equal((await api('/api/v1/groups?limit=1')).body.items.length, 1)
  const paths = ['/api/v1/groups', '/api/v1/audit/events']
  for (const path of paths) {
    for (const query of ['limit=-1', 'limit=abc', 'limit=1e100', 'offset=-1']) {
      const rejected = await api(`${path}?${query}`)
      assert.equal(rejected.status, 422)
      assert.equal((rejected.body.error as { code: string }).code, 'PAGE_INVALID')
    }
  }
  const audit = await api('/api/v1/audit/events?limit=&offset=')
  assert.equal(audit.status, 200)
  assert.ok(Array.isArray(audit.body.items))
})

test('exporting the journal records who downloaded it', async () => {
  const exported = await fetch(`${server.url}/api/v1/audit/export`, { headers: { 'x-dev-subject': 'dev-specialist' } })
  assert.equal(exported.status, 200)
  const csv = await exported.text()
  assert.match(csv, /occurred_at,actor,action,entity_type,result,group_key/)
  const events = listed<{ action: string; display_name: string | null }>(await api('/api/v1/audit/events?limit=100'))
  const recorded = events.find((item) => item.action === 'audit.exported')
  assert.equal(typeof recorded?.display_name, 'string')
  assert.ok(recorded?.display_name)
})

test('workbook parse finishes before a database transaction and live health still answers', async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  pauseNextImport(gate)
  const pending = fetch(`${server.url}/api/v1/imports`, {
    method: 'POST',
    headers: { 'x-dev-subject': 'dev-specialist', 'content-type': 'application/octet-stream', 'x-filename': 'row-bomb.xlsx' },
    body: new Uint8Array(sheetWorkbook('<row r="1000000"><c r="A1"><v>1</v></c></row>')),
  })
  const started = Date.now()
  while (!importPauseWaiting()) {
    if (Date.now() - started > 5000) throw new Error('import did not pause')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(transactionDepth(), 0)
  const live = await fetch(`${server.url}/health/live`)
  assert.equal(live.status, 200)
  release()
  const uploaded = await pending
  assert.equal(uploaded.status, 422)
})

test('an oversized sheet is rejected and does not create a snapshot', async () => {
  const before = await pool.query('SELECT count(*)::int AS count FROM snapshots')
  const uploaded = await fetch(`${server.url}/api/v1/imports`, {
    method: 'POST',
    headers: { 'x-dev-subject': 'dev-specialist', 'content-type': 'application/octet-stream', 'x-filename': 'row-bomb.xlsx' },
    body: sheetWorkbook('<row r="1000000"><c r="A1"><v>1</v></c></row>'),
  })
  assert.equal(uploaded.status, 422)
  assert.equal(((await uploaded.json()) as { error: { code: string } }).error.code, 'IMPORT_LIMIT_EXCEEDED')
  const after = await pool.query('SELECT count(*)::int AS count FROM snapshots')
  assert.equal(after.rows[0].count, before.rows[0].count)
  const live = await fetch(`${server.url}/health/live`)
  assert.equal(live.status, 200)
})

test('workbook import builds a queue and the second file moves the arrival', async () => {
  const initial = await readFile(new URL('../fixtures/01-initial.xlsx', import.meta.url))
  const changed = await readFile(new URL('../fixtures/02-changes.xlsx', import.meta.url))
  const first = await fetch(`${server.url}/api/v1/imports`, { method: 'POST', headers: { 'x-dev-subject': 'dev-specialist', 'content-type': 'application/octet-stream', 'x-filename': '01-initial.xlsx' }, body: initial })
  assert.equal(first.status, 202)
  const angel = await angelGroup()
  assert.equal(angel.latestBookings.find((booking) => booking.fullName.startsWith('Иванов'))?.arrivalLocalTime, '12:40')
  await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: ((await first.json()) as { snapshotId: string }).snapshotId, evidence: 'Первая выгрузка', confirmed: true } })
  const second = await fetch(`${server.url}/api/v1/imports`, { method: 'POST', headers: { 'x-dev-subject': 'dev-specialist', 'content-type': 'application/octet-stream', 'x-filename': '02-changes.xlsx' }, body: changed })
  assert.equal(second.status, 202)
  const updated = await angelGroup()
  assert.equal(updated.latestBookings.find((booking) => booking.fullName.startsWith('Иванов'))?.arrivalLocalTime, '13:10')
  assert.equal(updated.baselineBookings[0]?.arrivalLocalTime, '12:40')
  assert.ok(updated.changeCount > 0)
})

test('scheduler prepares one draft and repeats the last sample without a second snapshot', async () => {
  const checked = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  const angel = await angelGroup()
  await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: checked.body.snapshotId, evidence: 'База для планировщика', confirmed: true } })
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  const settings = await api('/api/v1/settings')
  await api('/api/v1/settings', { method: 'PATCH', role: 'lead', headers: { 'if-match': `"${settings.body.version}"` }, body: { autoPrepare: true, autoCheck: true, staleAfterMinutes: 120 } })
  now = new Date('2026-10-20T12:05:00.000Z')
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: databaseUrl, AUTH_MODE: 'mock', SOURCE_ADAPTER: 'sample', MAIL_ADAPTER: 'scripted', PORT: '0' }, () => now)
  await Promise.all([runScheduler(pool, config), runScheduler(pool, config)])
  const drafts = await pool.query('SELECT count(*)::int AS count FROM drafts')
  assert.equal(drafts.rows[0].count, 1)
  const snapshots = await pool.query('SELECT count(*)::int AS count FROM snapshots')
  now = new Date('2026-10-20T12:20:00.000Z')
  await runScheduler(pool, config)
  const snapshotsAfter = await pool.query('SELECT count(*)::int AS count FROM snapshots')
  assert.equal(snapshotsAfter.rows[0].count, snapshots.rows[0].count)
})

test('handed-off letter rebuilds only after newer data makes it stale', async () => {
  const checked = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  const angel = await angelGroup()
  await api('/api/v1/baselines', { method: 'POST', body: { groupId: angel.id, snapshotId: checked.body.snapshotId, evidence: 'Рассылка 06:00 зафиксирована', confirmed: true } })
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  const prepared = await api(`/api/v1/groups/${angel.id}/prepare`, { method: 'POST', body: { bypassQuiet: true, reason: 'Сверка со сменой' } })
  const draft = await api(`/api/v1/drafts/${prepared.body.draftId}`)
  await api(`/api/v1/drafts/${prepared.body.draftId}/review`, { method: 'POST', body: { revision: draft.body.revision, fingerprint: draft.body.fingerprint, confirmed: true } })
  await api(`/api/v1/drafts/${prepared.body.draftId}/handoff`, { method: 'POST', body: { revision: draft.body.revision }, headers: { 'idempotency-key': randomUUID() } })
  const blocked = await api(`/api/v1/drafts/${prepared.body.draftId}/rebuild`, { method: 'POST', body: {} })
  assert.equal(blocked.status, 409)
  assert.equal((blocked.body.error as { code: string }).code, 'DRAFT_LOCKED')
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed_more' } })
  const rebuilt = await api(`/api/v1/drafts/${prepared.body.draftId}/rebuild`, { method: 'POST', body: {} })
  assert.equal(rebuilt.status, 200)
  const next = await api(`/api/v1/drafts/${prepared.body.draftId}`)
  assert.equal(next.body.status, 'active')
  assert.ok(Number(next.body.revision) > Number(draft.body.revision))
})

test('queue pages keep one order and a later row stays reachable by name', async () => {
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  const first = await api('/api/v1/groups?limit=1')
  const second = await api('/api/v1/groups?limit=1')
  const firstId = (first.body.items as Array<{ id: string }>)[0]?.id
  assert.equal((second.body.items as Array<{ id: string }>)[0]?.id, firstId)
  const corrections = await api('/api/v1/corrections?basis=previous&limit=100')
  const hop = (corrections.body.items as Array<{ crewNames: string[]; changeCount: number; changes: Array<{ kind: string }> }>).find((item) => item.crewNames.some((name) => name.startsWith('Иванов')))
  assert.equal(hop?.changes.some((change) => change.kind === 'arrival'), true)
  assert.ok((hop?.changeCount ?? 0) > 0)
  const anchorId = randomUUID()
  await pool.query(`INSERT INTO work_groups (id, group_key, airport_code, stay_date) VALUES ($1, 'anchor|SVX|2026-10-09', 'SVX', '2026-10-09')`, [anchorId])
  await pool.query(
    `INSERT INTO work_groups (group_key, airport_code, stay_date)
     SELECT 'filler-' || n || '|SVX|2026-10-09', 'SVX', '2026-10-09' FROM generate_series(1, 120) AS n`,
  )
  await pool.query(
    `INSERT INTO queue_views (group_id, basis, status, change_count, crew_names, changes, exceptions, stay_date, airport_code, hotel_name, group_key, version, has_baseline)
     SELECT id, 'baseline', 'unchanged', 0, ARRAY['Фоновый'], '[]'::jsonb, '[]'::jsonb, stay_date, airport_code, '', group_key, 1, false
     FROM work_groups WHERE group_key LIKE 'filler-%'`,
  )
  await pool.query(
    `INSERT INTO queue_views (group_id, basis, status, change_count, crew_names, changes, exceptions, stay_date, airport_code, hotel_name, group_key, version, has_baseline)
     VALUES ($1, 'baseline', 'needs_decision', 0, ARRAY['Яковлев Я.Я.'], '[]'::jsonb, '[]'::jsonb, '2026-10-09', 'SVX', '', 'anchor|SVX|2026-10-09', 1, false)`,
    [anchorId],
  )
  const top = await api('/api/v1/groups?limit=1')
  assert.equal((top.body.items as Array<{ id: string }>)[0]?.id, anchorId)
  const named = await api('/api/v1/groups?query=Иванов&limit=100')
  assert.equal((named.body.items as Array<{ crewNames: string[] }>).some((item) => item.crewNames.some((name) => name.startsWith('Иванов'))), true)
  const handed = await angelGroup()
  const checked = await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'base' } })
  await api('/api/v1/baselines', { method: 'POST', body: { groupId: handed.id, snapshotId: checked.body.snapshotId, evidence: 'База для статуса', confirmed: true } })
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'delayed' } })
  const prepared = await api(`/api/v1/groups/${handed.id}/prepare`, { method: 'POST', body: { bypassQuiet: true, reason: 'Статус строки' } })
  const draft = await api(`/api/v1/drafts/${prepared.body.draftId}`)
  await api(`/api/v1/drafts/${prepared.body.draftId}/review`, { method: 'POST', body: { revision: draft.body.revision, fingerprint: draft.body.fingerprint, confirmed: true } })
  await api(`/api/v1/drafts/${prepared.body.draftId}/handoff`, { method: 'POST', body: { revision: draft.body.revision }, headers: { 'idempotency-key': randomUUID() } })
  const stored = await pool.query<{ status: string }>(`SELECT status FROM queue_views WHERE group_id = $1 AND basis = 'baseline'`, [handed.id])
  const viewed = await api(`/api/v1/groups/${handed.id}`)
  assert.equal(stored.rows[0]?.status, 'handed_off')
  assert.equal(viewed.body.status, 'handed_off')
})

async function angelGroup(): Promise<{ id: string; changeCount: number; baselineBookings: Array<{ arrivalLocalTime: string; fullName: string }>; latestBookings: Array<{ arrivalLocalTime: string; fullName: string }> }> {
  const listed = await api('/api/v1/groups?limit=100&query=Иванов')
  const group = (listed.body.items as Array<{ id: string; groupKey: string; changeCount: number; crewNames: string[] }>).find((item) => item.crewNames.some((name) => name.startsWith('Иванов')))
  if (!group) throw new Error('angel group missing')
  const latest = await pool.query<{ arrival_local_time: string; full_name: string }>(
    `SELECT to_char(b.arrival_local_time, 'HH24:MI') AS arrival_local_time, b.full_name
     FROM snapshot_bookings b
     JOIN work_groups g ON g.group_key = $1
     WHERE b.snapshot_id = (SELECT id FROM snapshots ORDER BY fetched_at DESC, seq DESC LIMIT 1)
       AND b.hotel_id IS NOT DISTINCT FROM g.hotel_id
       AND btrim(b.airport_code) = g.airport_code
       AND b.stay_date = g.stay_date
     ORDER BY b.full_name`,
    [group.groupKey],
  )
  const baseline = await pool.query<{ arrival_local_time: string; full_name: string }>(
    `SELECT booking->>'arrivalLocalTime' AS arrival_local_time, booking->>'fullName' AS full_name
     FROM notification_baselines nb
     CROSS JOIN LATERAL jsonb_array_elements(nb.payload->'bookings') WITH ORDINALITY AS listed(booking, ordinality)
     WHERE nb.group_key = $1
       AND nb.revision_no = (SELECT max(revision_no) FROM notification_baselines WHERE group_key = $1)
     ORDER BY listed.ordinality`,
    [group.groupKey],
  )
  return {
    id: group.id,
    changeCount: group.changeCount,
    latestBookings: latest.rows.map((row) => ({ arrivalLocalTime: row.arrival_local_time, fullName: row.full_name })),
    baselineBookings: baseline.rows.map((row) => ({ arrivalLocalTime: row.arrival_local_time, fullName: row.full_name })),
  }
}
