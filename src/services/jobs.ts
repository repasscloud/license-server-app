// Durable PostgreSQL job outbox. Jobs are inserted in the same transaction as the business
// change that requires them; Cron Triggers (and best-effort waitUntil kicks) drain bounded
// batches. Delivery is at-least-once; every handler is idempotent, so the business outcome is
// exactly-once. waitUntil() is never relied on for durability.

import type { Db, Sql } from '../db/client.ts';

export interface Job {
  id: number;
  kind: string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function enqueueJob(db: Db, kind: string, dedupeKey: string, payload: Record<string, unknown>, runAfter?: Date): Promise<void> {
  await db`INSERT INTO outbox_jobs (kind, dedupe_key, payload, run_after)
           VALUES (${kind}, ${dedupeKey}, ${db.json(payload as never)}, ${runAfter ?? new Date()})
           ON CONFLICT (dedupe_key) DO NOTHING`;
}

/** Claim up to `limit` due jobs. Expired leases (crashed invocations) are reclaimed. */
export async function claimJobs(sql: Sql, limit: number, kinds?: string[], leaseSeconds = 120): Promise<Job[]> {
  return sql<Job[]>`
    UPDATE outbox_jobs j SET status = 'running', attempts = j.attempts + 1, locked_until = now() + make_interval(secs => ${leaseSeconds})
    WHERE j.id IN (
      SELECT id FROM outbox_jobs
      WHERE ((status = 'pending' AND run_after <= now()) OR (status = 'running' AND locked_until < now()))
        AND (${!kinds} OR kind IN (SELECT jsonb_array_elements_text(${sql.json((kinds ?? []) as never)}::jsonb)))
      ORDER BY run_after, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING j.id, j.kind, j.dedupe_key, j.payload, j.attempts, j.max_attempts`;
}

export async function completeJob(sql: Sql, id: number): Promise<void> {
  await sql`UPDATE outbox_jobs SET status = 'done', locked_until = NULL, last_error = NULL WHERE id = ${id}`;
}

/** Exponential backoff: 30s, 1m, 2m, 4m ... capped at 6h; dead-letter after max_attempts. */
export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 6 * 3600);
}

export async function failJob(sql: Sql, job: Job, error: string, retryAfterSeconds?: number): Promise<'retry' | 'dead'> {
  const dead = job.attempts >= job.max_attempts;
  const delay = retryAfterSeconds ?? backoffSeconds(job.attempts);
  await sql`UPDATE outbox_jobs SET status = ${dead ? 'dead' : 'pending'}, locked_until = NULL, last_error = ${error.slice(0, 2000)},
            run_after = now() + make_interval(secs => ${delay}) WHERE id = ${job.id}`;
  return dead ? 'dead' : 'retry';
}

export async function retryDeadJob(sql: Sql, id: number): Promise<boolean> {
  const r = await sql`UPDATE outbox_jobs SET status = 'pending', attempts = 0, run_after = now(), last_error = NULL WHERE id = ${id} AND status = 'dead' RETURNING id`;
  return r.length === 1;
}

export async function listJobs(db: Db, opts: { status?: string; kind?: string; limit?: number }) {
  return db<{ id: number; kind: string; dedupe_key: string; status: string; attempts: number; max_attempts: number; run_after: Date; last_error: string | null; created_at: Date; updated_at: Date }[]>`
    SELECT id, kind, dedupe_key, status, attempts, max_attempts, run_after, last_error, created_at, updated_at FROM outbox_jobs
    WHERE (${opts.status ?? null}::text IS NULL OR status = ${opts.status ?? null}) AND (${opts.kind ?? null}::text IS NULL OR kind = ${opts.kind ?? null})
    ORDER BY id DESC LIMIT ${Math.min(opts.limit ?? 50, 500)}`;
}
