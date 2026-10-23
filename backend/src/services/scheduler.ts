import type { Pool } from 'pg'
import type { AppConfig } from '../config.ts'
import { withTransaction } from '../db/pool.ts'
import { runSampleCheck } from './ingest.ts'
import { prepareGroup } from './drafts.ts'
import { sweepUnknownDeliveries } from './delivery.ts'

export async function runScheduler(pool: Pool, config: AppConfig): Promise<void> {
  await sweepExpiredMail(pool, config)
  await prepareDueGroups(pool, config)
  await pollSource(pool, config)
}

async function prepareDueGroups(pool: Pool, config: AppConfig): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    const prepared = await withTransaction(pool, async (client) => {
      const settings = await client.query<{ auto_prepare: boolean }>('SELECT auto_prepare FROM app_settings WHERE id = 1')
      if (!settings.rows[0]?.auto_prepare) return false
      const due = await client.query<{ id: string }>(
        `SELECT wg.id
         FROM queue_views q
         JOIN work_groups wg ON wg.id = q.group_id
         WHERE q.basis = 'baseline'
           AND q.due_at IS NOT NULL AND q.due_at <= $1
           AND NOT EXISTS (
             SELECT 1 FROM drafts d WHERE d.group_key = wg.group_key AND d.status IN ('active', 'reviewed', 'sending', 'handed_off')
           )
         ORDER BY q.due_at
         FOR UPDATE OF wg SKIP LOCKED
         LIMIT 1`,
        [config.now().toISOString()],
      )
      const groupId = due.rows[0]?.id
      if (!groupId) return false
      const actor = { id: '', externalSubject: 'system:scheduler', displayName: 'Система', role: 'system' as const }
      try {
        await prepareGroup(client, { groupId, actor, now: config.now(), correlationId: 'scheduler', bypassQuiet: false, reason: null, automatic: true })
      } catch {
        return false
      }
      return true
    })
    if (!prepared) return
  }
}

async function pollSource(pool: Pool, config: AppConfig): Promise<void> {
  if (config.sourceAdapter !== 'sample') return
  await withTransaction(pool, async (client) => {
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(8412001) AS locked')
    if (!lock.rows[0]?.locked) return
    const settings = await client.query<{ auto_check: boolean; poll_minutes: number }>('SELECT auto_check, poll_minutes FROM app_settings WHERE id = 1')
    if (!settings.rows[0]?.auto_check) return
    const last = await client.query<{ source_cursor: string | null; finished_at: string | null }>(
      `SELECT source_cursor, finished_at FROM source_runs WHERE status = 'succeeded' AND adapter = 'sample' ORDER BY finished_at DESC LIMIT 1`,
    )
    const cursor = last.rows[0]?.source_cursor
    const finishedAt = last.rows[0]?.finished_at
    if (!cursor || !finishedAt) return
    const due = config.now().getTime() >= new Date(finishedAt).getTime() + settings.rows[0].poll_minutes * 60_000
    if (!due) return
    await runSampleCheck(client, { fixtureName: cursor, trigger: 'schedule', actor: null, now: config.now(), correlationId: 'scheduler' })
  })
}

async function sweepExpiredMail(pool: Pool, config: AppConfig): Promise<void> {
  await withTransaction(pool, async (client) => {
    await sweepUnknownDeliveries(client, config.now(), config.unknownAfterSeconds)
  })
}
