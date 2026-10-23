import { randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { AppConfig } from '../config.ts'
import { sha256Hex } from '../domain/hash.ts'
import { AuthBusyError, rejectUnknownPassword, verifyPassword } from '../domain/password.ts'
import { HttpError } from '../errors.ts'
import { withTransaction } from '../db/pool.ts'
import { writeAudit } from './audit.ts'
import type { Actor } from './state.ts'

export const SESSION_COOKIE = 'crew_session'
const ABSOLUTE_SESSION_MS = 12 * 60 * 60 * 1000
const IDLE_SESSION_MS = 30 * 60 * 1000
const SLIDE_AFTER_MS = 60_000
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const EMAIL_FAILURE_LIMIT = 5
const IP_FAILURE_LIMIT = 30
const EMAIL_PATTERN = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/

interface CredentialRow {
  id: string
  external_subject: string
  display_name: string
  role: Actor['role']
  active: boolean
  position_title: string | null
  password_hash: string | null
}

interface SessionRow {
  id: string
  external_subject: string
  display_name: string
  role: Actor['role']
  active: boolean
  position_title: string | null
  session_id: string
  expires_at: string
  last_seen_at: string
  revoked_at: string | null
}

export interface IssuedSession {
  actor: Actor
  token: string
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ABSOLUTE_SESSION_MS / 1000}${secure ? '; Secure' : ''}`
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`
}

export function readSessionToken(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue
    const token = part.slice(separator + 1).trim()
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    return token
  }
  return null
}

export async function loginWithPassword(
  pool: Pool,
  config: AppConfig,
  input: { email: unknown; password: unknown; ip: string; correlationId: string },
): Promise<IssuedSession> {
  if (config.authMode !== 'password') throw new HttpError(401, 'AUTH_NOT_CONFIGURED', 'Корпоративный вход не настроен')
  const email = normalizeEmail(input.email)
  const password = typeof input.password === 'string' ? input.password : null
  if (!email || password === null || password.length === 0 || password.length > 200) {
    throw new HttpError(422, 'FIELD_INVALID', 'Поле заполнено некорректно')
  }
  const now = config.now()
  const emailHash = sha256Hex(email)
  const ip = input.ip.slice(0, 64) || 'local'
  const gate = await withTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 1::bigint))', [emailHash])
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 2::bigint))', [ip])
    await client.query('DELETE FROM auth_attempts WHERE attempted_at < $1', [new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()])
    const counts = await client.query<{ email_failures: number; ip_failures: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE email_hash = $1 AND succeeded = false) AS email_failures,
         COUNT(*) FILTER (WHERE ip = $2 AND succeeded = false) AS ip_failures
       FROM auth_attempts
       WHERE attempted_at > $3 AND (email_hash = $1 OR ip = $2)`,
      [emailHash, ip, new Date(now.getTime() - ATTEMPT_WINDOW_MS).toISOString()],
    )
    const user = await client.query<CredentialRow>(
      `SELECT id, external_subject, display_name, role, active, position_title, password_hash
       FROM app_users WHERE email = $1`,
      [email],
    )
    const limited = Number(counts.rows[0]?.email_failures ?? 0) >= EMAIL_FAILURE_LIMIT || Number(counts.rows[0]?.ip_failures ?? 0) >= IP_FAILURE_LIMIT
    if (limited) {
      await recordAttempt(client, emailHash, ip, false, now)
      await writeAudit(client, auditInput(now, user.rows[0]?.id ?? null, input.correlationId, 'denied', { reason: 'rate_limited' }))
      return { limited: true, user: user.rows[0] ?? null, attemptId: null }
    }
    const attemptId = await recordAttempt(client, emailHash, ip, false, now)
    return { limited: false, user: user.rows[0] ?? null, attemptId }
  })
  if (gate.limited) throw new HttpError(429, 'RATE_LIMITED', 'Слишком много попыток. Подождите 15 минут.')
  let matches = false
  try {
    matches = gate.user?.password_hash
      ? await verifyPassword(password, config.authPepper, gate.user.password_hash)
      : false
    if (!gate.user?.password_hash) await rejectUnknownPassword(password, config.authPepper)
  } catch (error) {
    if (error instanceof AuthBusyError && gate.attemptId) {
      await withTransaction(pool, async (client) => {
        await client.query('DELETE FROM auth_attempts WHERE id = $1', [gate.attemptId])
      })
    }
    throw error
  }
  const actor = gate.user && matches && gate.user.active ? toActor(gate.user) : null
  const token = actor ? randomBytes(32).toString('base64url') : ''
  await withTransaction(pool, async (client) => {
    if (actor && gate.attemptId) await client.query('UPDATE auth_attempts SET succeeded = true WHERE id = $1', [gate.attemptId])
    if (!actor) {
      await writeAudit(client, auditInput(now, gate.user?.id ?? null, input.correlationId, 'denied', { reason: 'bad_credentials' }))
      return
    }
    await client.query(
      `INSERT INTO auth_sessions (user_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $3)`,
      [actor.id, sha256Hex(token), now.toISOString(), new Date(now.getTime() + ABSOLUTE_SESSION_MS).toISOString()],
    )
    await writeAudit(client, auditInput(now, actor.id, input.correlationId, 'ok', {}))
  })
  if (!actor) throw new HttpError(401, 'UNAUTHENTICATED', 'Неверная почта или пароль')
  return { actor, token }
}

export async function logoutSession(pool: Pool, config: AppConfig, token: string | null, correlationId: string): Promise<void> {
  if (!token) return
  const now = config.now()
  await withTransaction(pool, async (client) => {
    const revoked = await client.query<{ user_id: string }>(
      `UPDATE auth_sessions SET revoked_at = $2
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING user_id`,
      [sha256Hex(token), now.toISOString()],
    )
    const userId = revoked.rows[0]?.user_id
    if (!userId) return
    await writeAudit(client, {
      occurredAt: now.toISOString(),
      actorId: userId,
      serviceActor: null,
      action: 'auth.logout',
      entityType: 'session',
      entityId: null,
      groupKey: null,
      result: 'ok',
      details: {},
      correlationId,
    })
  })
}

export async function actorFromSession(client: PoolClient, token: string, now: Date): Promise<Actor | null> {
  const result = await client.query<SessionRow>(
    `SELECT u.id, u.external_subject, u.display_name, u.role, u.active, u.position_title,
            s.id AS session_id, s.expires_at, s.last_seen_at, s.revoked_at
     FROM auth_sessions s
     JOIN app_users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [sha256Hex(token)],
  )
  const row = result.rows[0]
  if (!row?.active || row.revoked_at) return null
  const expiresAt = new Date(row.expires_at).getTime()
  const lastSeenAt = new Date(row.last_seen_at).getTime()
  if (!Number.isFinite(expiresAt) || !Number.isFinite(lastSeenAt)) return null
  if (expiresAt <= now.getTime() || now.getTime() - lastSeenAt >= IDLE_SESSION_MS) return null
  if (now.getTime() - lastSeenAt >= SLIDE_AFTER_MS) {
    await client.query('UPDATE auth_sessions SET last_seen_at = $2 WHERE id = $1 AND revoked_at IS NULL', [row.session_id, now.toISOString()])
  }
  return toActor(row)
}

function toActor(row: { id: string; external_subject: string; display_name: string; role: Actor['role']; position_title: string | null }): Actor {
  return {
    id: row.id,
    externalSubject: row.external_subject,
    displayName: row.display_name,
    role: row.role,
    positionTitle: row.position_title,
  }
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (!EMAIL_PATTERN.test(email) || email.length > 200) return null
  return email
}

async function recordAttempt(client: PoolClient, emailHash: string, ip: string, succeeded: boolean, now: Date): Promise<string> {
  const inserted = await client.query<{ id: string | number }>(
    'INSERT INTO auth_attempts (email_hash, ip, succeeded, attempted_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [emailHash, ip, succeeded, now.toISOString()],
  )
  return String(inserted.rows[0]?.id ?? '')
}

function auditInput(now: Date, actorId: string | null, correlationId: string, result: 'ok' | 'denied', details: Record<string, string>): {
  occurredAt: string
  actorId: string | null
  serviceActor: string | null
  action: string
  entityType: string
  entityId: string | null
  groupKey: string | null
  result: 'ok' | 'denied'
  details: Record<string, string>
  correlationId: string
} {
  return {
    occurredAt: now.toISOString(),
    actorId,
    serviceActor: actorId ? null : 'auth',
    action: 'auth.login',
    entityType: 'session',
    entityId: null,
    groupKey: null,
    result,
    details,
    correlationId,
  }
}
