import { Pool, types, type PoolClient } from 'pg'

types.setTypeParser(1082, (value) => value)
types.setTypeParser(1114, (value) => value)
types.setTypeParser(1184, (value) => value)
types.setTypeParser(20, (value) => Number(value))

export type Db = Pool | PoolClient

export async function assertRuntimeRole(
  client: { query: (sql: string) => Promise<{ rows: Array<{ rolsuper?: boolean }> }> },
  nodeEnv: string,
): Promise<void> {
  if (nodeEnv !== 'production') return
  const result = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')
  if (result.rows[0]?.rolsuper) throw new Error('DB_SUPERUSER_FORBIDDEN')
}

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10, statement_timeout: 8_000 })
}

let openTransactions = 0

export function transactionDepth(): number {
  return openTransactions
}

export async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  openTransactions += 1
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    openTransactions -= 1
    client.release()
  }
}
