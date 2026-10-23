import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sheetWorkbook } from './support/xlsx-bytes.ts'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { readConfig } from '../src/config.ts'
import { createPool } from '../src/db/pool.ts'
import { migrate } from '../src/db/migrate.ts'
import { insertUser, resetBusinessData } from '../src/db/reference.ts'
import { startServer, type RunningServer } from '../src/http/server.ts'
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
  const items = listed.body.items as Array<{ id: string; dueAt: string | null; latestBookings: Array<{ fullName: string }> }>
  const angel = items.find((item) => item.latestBookings.some((booking) => booking.fullName.startsWith('Иванов')))
  const petr = items.find((item) => item.latestBookings.some((booking) => booking.fullName.startsWith('Петров')))
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
  const nextItems = after.body.items as Array<{ dueAt: string | null; latestBookings: Array<{ fullName: string; arrivalLocalTime: string }> }>
  const ivan = nextItems.find((item) => item.latestBookings.some((booking) => booking.fullName.startsWith('Иванов')))
  const other = nextItems.find((item) => item.latestBookings.some((booking) => booking.fullName.startsWith('Петров')))
  assert.equal(ivan?.dueAt, '2026-10-20T12:05:00.000Z')
  assert.equal(other?.dueAt, null)
  const eventsBefore = await pool.query('SELECT count(*)::int AS count FROM change_events')
  await api('/api/v1/source/check', { method: 'POST', body: { fixture: 'reverted' } })
  const quiet = await api('/api/v1/groups?limit=100')
  const reverted = (quiet.body.items as Array<{ dueAt: string | null; latestBookings: Array<{ fullName: string }> }>).find((item) => item.latestBookings.some((booking) => booking.fullName.startsWith('Иванов')))
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
  const [notice] = listed<{ revision: number; letter: { subject: string } }>(await api('/api/v1/notifications'))
  assert.equal(notice?.revision, draft.body.revision)
  assert.equal(notice?.letter.subject, draft.body.subject)
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

async function angelGroup(): Promise<{ id: string; changeCount: number; baselineBookings: Array<{ arrivalLocalTime: string }>; latestBookings: Array<{ arrivalLocalTime: string; fullName: string }> }> {
  const listed = await api('/api/v1/groups?limit=100')
  const group = (listed.body.items as Array<{ id: string; changeCount: number; baselineBookings: Array<{ arrivalLocalTime: string }> | null; latestBookings: Array<{ arrivalLocalTime: string; fullName: string }> }>).find((item) => item.latestBookings.some((booking) => booking.fullName.startsWith('Иванов')))
  if (!group) throw new Error('angel group missing')
  return { ...group, baselineBookings: group.baselineBookings ?? [] }
}
