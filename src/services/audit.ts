// Append-only audit log. Never pass secrets, full activation keys, client secrets, tokens,
// raw IPs or email addresses in `detail` — use ids, hints and hashes only.

import type { Db } from '../db/client.ts';
import type { Actor } from './actor.ts';

export interface AuditEntry {
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  outcome?: 'success' | 'denied' | 'failure';
  detail?: Record<string, unknown>;
}

export async function audit(db: Db, actor: Actor, e: AuditEntry): Promise<void> {
  await db`
    INSERT INTO audit_events (actor_type, actor_id, action, resource_type, resource_id, outcome, request_id, ip_hash, detail)
    VALUES (${actor.type}, ${actor.id}, ${e.action}, ${e.resourceType ?? null}, ${e.resourceId ?? null},
            ${e.outcome ?? 'success'}, ${actor.requestId ?? null}, ${actor.ipHash ?? null}, ${db.json((e.detail ?? {}) as never)})`;
}

export async function listAudit(db: Db, f: { resourceType?: string; resourceId?: string; actorId?: string; action?: string; outcome?: string; beforeId?: number; limit?: number }) {
  return db<{ id: number; occurred_at: Date; actor_type: string; actor_id: string | null; action: string; resource_type: string | null; resource_id: string | null; outcome: string; request_id: string | null; detail: unknown }[]>`
    SELECT id, occurred_at, actor_type, actor_id, action, resource_type, resource_id, outcome, request_id, detail FROM audit_events
    WHERE (${f.resourceType ?? null}::text IS NULL OR resource_type = ${f.resourceType ?? null})
      AND (${f.resourceId ?? null}::text IS NULL OR resource_id = ${f.resourceId ?? null})
      AND (${f.actorId ?? null}::text IS NULL OR actor_id = ${f.actorId ?? null})
      AND (${f.action ?? null}::text IS NULL OR action LIKE ${(f.action ?? '') + '%'})
      AND (${f.outcome ?? null}::text IS NULL OR outcome = ${f.outcome ?? null})
      AND (${f.beforeId ?? null}::bigint IS NULL OR id < ${f.beforeId ?? 0})
    ORDER BY id DESC LIMIT ${Math.min(f.limit ?? 100, 500)}`;
}

/** Full safe audit row; IP hashes and other internal columns are not exported. */
export async function getAuditEvent(db: Db, id: number) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const [row] = await db<{ id: number; occurred_at: Date; actor_type: string; actor_id: string | null; action: string; resource_type: string | null; resource_id: string | null; outcome: string; request_id: string | null; detail: unknown }[]>`
    SELECT id, occurred_at, actor_type, actor_id, action, resource_type, resource_id, outcome, request_id, detail FROM audit_events WHERE id = ${id}`;
  return row ?? null;
}
