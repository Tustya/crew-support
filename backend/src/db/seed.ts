import { readConfig } from '../config.ts'
import { createPool } from './pool.ts'
import { insertUser } from './reference.ts'

const hotels = [
  ['angel', 'Гостиница Ангел', 'Екатеринбург', 'SVX', 'Asia/Yekaterinburg', 'hotel-angel@example.com'],
  ['bereg', 'Гостиница Берег', 'Екатеринбург', 'SVX', 'Asia/Yekaterinburg', 'hotel-bereg@example.com'],
  ['south', 'Гостиница Юг', 'Сочи', 'AER', 'Europe/Moscow', 'hotel-south@example.com'],
  ['north', 'Гостиница Север', 'Сочи', 'AER', 'Europe/Moscow', 'hotel-north@example.com'],
] as const

async function seed(): Promise<void> {
  const config = readConfig(process.env)
  if (config.nodeEnv === 'production') throw new Error('seed is refused in production')
  const pool = createPool(config.databaseUrl)
  try {
    await insertUser(pool, 'dev-specialist', 'Специалист смены', 'specialist')
    await insertUser(pool, 'dev-lead', 'Старший смены', 'lead')
    for (const [sourceHotelId, name, city, airportCode, timezone, email] of hotels) {
      await pool.query(
        `INSERT INTO hotels (source_hotel_id, name, city, airport_code, timezone, recipients, cc, contract_status, active)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, '[]'::jsonb, 'confirmed', true)
         ON CONFLICT (source_hotel_id) WHERE source_hotel_id IS NOT NULL DO NOTHING`,
        [sourceHotelId, name, city, airportCode, timezone, JSON.stringify([email])],
      )
    }
  } finally {
    await pool.end()
  }
}

await seed()
