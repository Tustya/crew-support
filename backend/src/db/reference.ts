import type { Pool, PoolClient } from 'pg'
import { defaultTemplates } from '../domain/templates.ts'
import type { Db } from './pool.ts'

export async function ensureTemplates(db: Db): Promise<void> {
  for (const template of defaultTemplates()) {
    await db.query(
      `INSERT INTO template_versions (template_key, version, blocks, columns, new_label, cancel_label)
       SELECT $1, 1, $2::jsonb, $3::jsonb, $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM template_versions WHERE template_key = $1 AND version = 1)`,
      [template.templateKey, JSON.stringify(template.blocks), JSON.stringify(template.columns), template.newLabel, template.cancelLabel],
    )
  }
}

export async function resetBusinessData(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`TRUNCATE TABLE
      delivery_attempts,
      notification_baselines,
      notifications,
      draft_versions,
      drafts,
      change_events,
      exceptions,
      work_groups,
      snapshot_bookings,
      snapshots,
      source_runs,
      import_batches,
      audit_events,
      jobs,
      request_dedup,
      template_versions,
      hotels,
      app_users,
      integration_configs
      RESTART IDENTITY CASCADE`)
    await client.query(`UPDATE app_settings SET
      poll_minutes = 5,
      quiet_minutes = 60,
      auto_check = false,
      auto_prepare = false,
      stay_scope = 'both',
      stale_after_minutes = 15,
      template_version = 1,
      row_version = 1,
      sender_name = 'Crew Support',
      updated_at = now()
      WHERE id = 1`)
    await client.query(`INSERT INTO integration_configs (adapter_key, status, safe_endpoint_label)
      VALUES ('source', 'disabled', 'not-configured'), ('mail', 'disabled', 'not-configured')`)
    await ensureTemplates(client)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export async function insertUser(db: Pool | PoolClient, subject: string, name: string, role: 'specialist' | 'lead'): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO app_users (external_subject, display_name, role) VALUES ($1, $2, $3) RETURNING id`,
    [subject, name, role],
  )
  return result.rows[0]?.id ?? ''
}
