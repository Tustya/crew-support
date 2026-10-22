import { Pool, types, type PoolClient } from 'pg'

types.setTypeParser(1082, (value) => value)
types.setTypeParser(1114, (value) => value)
types.setTypeParser(1184, (value) => value)
types.setTypeParser(20, (value) => Number(value))

export type Db = Pool | PoolClient

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10, statement_timeout: 8_000 })
}

export async function withTransaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await run(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
