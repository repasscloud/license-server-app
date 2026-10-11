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
