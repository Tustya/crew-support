import type { PoolClient } from 'pg'

export async function writeAudit(
  client: PoolClient,
  input: {
    occurredAt: string
    actorId: string | null
    serviceActor: string | null
    action: string
    entityType: string
    entityId: string | null
    groupKey: string | null
    result: 'ok' | 'error' | 'denied'
    details: Record<string, string | number | boolean | null>
    correlationId: string
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (occurred_at, actor_user_id, service_actor, action, entity_type, entity_id, group_key, result, safe_details, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [
      input.occurredAt,
      input.actorId,
      input.serviceActor,
      input.action,
      input.entityType,
      input.entityId,
      input.groupKey,
      input.result,
      JSON.stringify(input.details),
      input.correlationId,
    ],
  )
}
