import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { readConfig } from '../src/config.ts'
import { createPool } from '../src/db/pool.ts'
import { migrate } from '../src/db/migrate.ts'
import { resetBusinessData } from '../src/db/reference.ts'
import { hashPassword } from '../src/domain/password.ts'
import { startServer, type RunningServer } from '../src/http/server.ts'

const databaseUrl = process.env.DATABASE_URL ?? 'postgres://crew:crew@127.0.0.1:54329/crew_support_test'
const pepper = 'test-pepper-0123456789abcdef0123456789'
const password = '8e9sVY7Ji1xoZxRL2ZU6'
let now = new Date('2026-10-23T08:00:00.000Z')
let server: RunningServer
let pool = createPool(databaseUrl)
let passwordHash = ''

async function sessionApi(path: string, options: { method?: string; body?: unknown; cookie?: string; crew?: boolean } = {}) {
  const headers = new Headers()
  if (options.crew !== false) headers.set('x-crew-request', '1')
  if (options.cookie) headers.set('cookie', options.cookie)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  const response = await fetch(`${server.url}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  const setCookie = response.headers.getSetCookie().find((item) => item.startsWith('crew_session=')) ?? ''
  return {
    status: response.status,
    body: text ? JSON.parse(text) as Record<string, unknown> : {},
    text,
    cookie: setCookie.split(';')[0] ?? '',
    setCookie,
  }
}

function errorOf(body: Record<string, unknown>): { code: string; message: string } {
  const error = body.error as { code: string; message: string }
  return { code: error.code, message: error.message }
}

before(async () => {
  passwordHash = await hashPassword(password, pepper)
  await migrate(databaseUrl)
  server = await startServer(readConfig({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl,
    AUTH_MODE: 'password',
    AUTH_PEPPER: pepper,
    SOURCE_ADAPTER: 'sample',
    MAIL_ADAPTER: 'disabled',
    PORT: '0',
    RATE_LIMIT_PER_MINUTE: '10000',
  }, () => now))
})

after(async () => {
  await server.close()
  await pool.end()
})

beforeEach(async () => {
  now = new Date('2026-10-23T08:00:00.000Z')
  await resetBusinessData(pool)
  await pool.query(
    `INSERT INTO app_users (external_subject, display_name, role, email, position_title, password_hash) VALUES
      ('dev-specialist', 'Орлова Елена Павловна', 'specialist', 'specialist@crew-support.local', 'Специалист смены', $1),
      ('dev-lead', 'Соколов Андрей Викторович', 'lead', 'lead@crew-support.local', 'Старший смены', $1)`,
    [passwordHash],
  )
})

test('password login returns the full name and ignores the dev subject header', async () => {
  const forged = await fetch(`${server.url}/api/v1/me`, { headers: { 'x-dev-subject': 'dev-lead' } })
  assert.equal(forged.status, 401)
  const logged = await sessionApi('/api/v1/session', {
    method: 'POST',
    body: { email: ' Specialist@crew-support.local ', password },
  })
  assert.equal(logged.status, 200)
  assert.match(logged.setCookie, /HttpOnly/)
  assert.match(logged.setCookie, /SameSite=Strict/)
  assert.equal(logged.body.displayName, 'Орлова Елена Павловна')
  assert.equal(logged.body.position, 'Специалист смены')
  assert.equal(logged.body.role, 'specialist')
  const me = await sessionApi('/api/v1/me', { cookie: logged.cookie })
  assert.equal(me.body.displayName, 'Орлова Елена Павловна')
  const journal = await sessionApi('/api/v1/audit/events?limit=5', { cookie: logged.cookie })
  const items = journal.body.items as Array<{ display_name: string | null; action: string }>
  assert.equal(items.some((item) => item.action === 'auth.login' && item.display_name === 'Орлова Елена Павловна'), true)
})

test('unknown email and a wrong password look the same', async () => {
  const wrong = await sessionApi('/api/v1/session', { method: 'POST', body: { email: 'lead@crew-support.local', password: 'not-the-password' } })
  const missing = await sessionApi('/api/v1/session', { method: 'POST', body: { email: 'nobody@crew-support.local', password: 'not-the-password' } })
  assert.equal(wrong.status, 401)
  assert.equal(missing.status, wrong.status)
  assert.deepEqual(errorOf(missing.body), errorOf(wrong.body))
  const stored = await pool.query<{ packed: string }>('SELECT safe_details::text AS packed FROM audit_events')
  const packed = stored.rows.map((row) => row.packed).join('\n')
  assert.equal(packed.includes(password), false)
  assert.equal(packed.includes('not-the-password'), false)
  assert.equal(packed.includes('nobody@crew-support.local'), false)
  assert.equal(packed.includes('lead@crew-support.local'), false)
})

test('the sixth failure in fifteen minutes is rejected', async () => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await sessionApi('/api/v1/session', { method: 'POST', body: { email: 'lead@crew-support.local', password: 'not-the-password' } })
    assert.equal(failed.status, 401)
  }
  const blocked = await sessionApi('/api/v1/session', { method: 'POST', body: { email: 'lead@crew-support.local', password } })
  assert.equal(blocked.status, 429)
  assert.equal(errorOf(blocked.body).code, 'RATE_LIMITED')
})

test('logout revokes the session and a stale absolute expiry is rejected', async () => {
  const logged = await sessionApi('/api/v1/session', { method: 'POST', body: { email: 'lead@crew-support.local', password } })
  assert.equal(logged.body.displayName, 'Соколов Андрей Викторович')
  const left = await sessionApi('/api/v1/session/logout', { method: 'POST', cookie: logged.cookie })
  assert.equal(left.status, 204)
  assert.match(left.setCookie, /Max-Age=0/)
  const afterLogout = await sessionApi('/api/v1/me', { cookie: logged.cookie })
  assert.equal(afterLogout.status, 401)
  const again = await sessionApi('/api/v1/session', { method: 'POST', body: { email: 'lead@crew-support.local', password } })
  await pool.query(
    `UPDATE auth_sessions SET created_at = $1, expires_at = $2, last_seen_at = $3 WHERE revoked_at IS NULL`,
    ['2026-10-22T18:00:00.000Z', '2026-10-23T06:00:00.000Z', now.toISOString()],
  )
  const expired = await sessionApi('/api/v1/me', { cookie: again.cookie })
  assert.equal(expired.status, 401)
})

test('login without the crew header is refused and users cannot be registered', async () => {
  const bare = await sessionApi('/api/v1/session', { method: 'POST', crew: false, body: { email: 'lead@crew-support.local', password } })
  assert.equal(bare.status, 403)
  const created = await sessionApi('/api/v1/users', { method: 'POST', body: { email: 'new@crew-support.local', password } })
  assert.equal(created.status, 404)
})

test('an idle session is rejected', async () => {
  const logged = await sessionApi('/api/v1/session', { method: 'POST', body: { email: 'specialist@crew-support.local', password } })
  now = new Date(now.getTime() + 31 * 60 * 1000)
  const me = await sessionApi('/api/v1/me', { cookie: logged.cookie })
  assert.equal(me.status, 401)
})
