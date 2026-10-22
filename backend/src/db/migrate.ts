import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256Hex } from '../domain/hash.ts'
import { createPool } from './pool.ts'
import { ensureTemplates } from './reference.ts'

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url))

export async function migrate(databaseUrl: string): Promise<string[]> {
  const pool = createPool(databaseUrl)
  const applied: string[] = []
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    const names = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()
    for (const name of names) {
      const sql = await readFile(path.join(migrationsDir, name), 'utf8')
      const checksum = sha256Hex(sql)
      const existing = await pool.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version = $1', [name])
      const current = existing.rows[0]
      if (current) {
        if (current.checksum !== checksum) throw new Error(`checksum mismatch for ${name}`)
        continue
      }
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [name, checksum])
        await client.query('COMMIT')
        applied.push(name)
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    }
    await ensureTemplates(pool)
    return applied
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const applied = await migrate(databaseUrl)
  console.log(applied.length === 0 ? 'migrations up to date' : `applied ${applied.join(', ')}`)
}
