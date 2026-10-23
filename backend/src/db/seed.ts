import { readConfig } from '../config.ts'
import { hashPassword } from '../domain/password.ts'
import { createPool } from './pool.ts'

export const DEFAULT_PASSWORD = '8e9sVY7Ji1xoZxRL2ZU6'

const localUsers = [
  { subject: 'dev-lead', email: 'lead@crew-support.local', fullName: 'Соколов Андрей Викторович', position: 'Старший смены', role: 'lead' },
  { subject: 'dev-specialist', email: 'specialist@crew-support.local', fullName: 'Орлова Елена Павловна', position: 'Специалист смены', role: 'specialist' },
] as const

const hotels = [
  ['angel', 'Гостиница Ангел', 'Екатеринбург', 'SVX', 'Asia/Yekaterinburg', 'hotel-angel@example.com'],
  ['bereg', 'Гостиница Берег', 'Екатеринбург', 'SVX', 'Asia/Yekaterinburg', 'hotel-bereg@example.com'],
  ['south', 'Гостиница Юг', 'Сочи', 'AER', 'Europe/Moscow', 'hotel-south@example.com'],
  ['north', 'Гостиница Север', 'Сочи', 'AER', 'Europe/Moscow', 'hotel-north@example.com'],
] as const

async function seed(): Promise<void> {
  const config = readConfig(process.env)
  if (config.nodeEnv === 'production') throw new Error('seed is refused in production')
  if (config.authPepper.length < 32) throw new Error('AUTH_PEPPER must be at least 32 characters')
  const pool = createPool(config.databaseUrl)
  try {
    for (const user of localUsers) {
      const existing = await pool.query<{ password_hash: string | null }>(
        'SELECT password_hash FROM app_users WHERE external_subject = $1',
        [user.subject],
      )
      const passwordHash = existing.rows[0]?.password_hash ?? await hashPassword(DEFAULT_PASSWORD, config.authPepper)
      await pool.query(
        `INSERT INTO app_users (external_subject, display_name, role, email, position_title, password_hash)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (external_subject) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           role = EXCLUDED.role,
           email = EXCLUDED.email,
           position_title = EXCLUDED.position_title,
           password_hash = COALESCE(app_users.password_hash, EXCLUDED.password_hash),
           updated_at = now()`,
        [user.subject, user.fullName, user.role, user.email, user.position, passwordHash],
      )
    }
    for (const [sourceHotelId, name, city, airportCode, timezone, email] of hotels) {
      await pool.query(
        `INSERT INTO hotels (source_hotel_id, name, city, airport_code, timezone, recipients, cc, contract_status, active)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, '[]'::jsonb, 'confirmed', true)
         ON CONFLICT (source_hotel_id) WHERE source_hotel_id IS NOT NULL DO NOTHING`,
        [sourceHotelId, name, city, airportCode, timezone, JSON.stringify([email])],
      )
    }
    console.log(`lead@crew-support.local ${DEFAULT_PASSWORD}`)
    console.log(`specialist@crew-support.local ${DEFAULT_PASSWORD}`)
  } finally {
    await pool.end()
  }
}

await seed()
