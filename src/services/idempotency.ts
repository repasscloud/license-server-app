// Idempotency-Key support for admin API mutations: the first response for (actor, key) is stored
// and replayed for identical retries; reusing a key for a different request is rejected.

import { sha256Hex } from '../crypto/hashing.ts';
import type { Sql } from '../db/client.ts';
import { AppError, conflict, invalid } from '../lib/errors.ts';

export async function withIdempotency(
  sql: Sql,
  actorId: string,
  key: string | null,
  req: { method: string; path: string; body: string },
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown; replayed: boolean }> {
  if (!key) return { ...(await run()), replayed: false };
  if (!/^[A-Za-z0-9_.:-]{8,200}$/.test(key)) throw invalid('Idempotency-Key must be 8-200 characters of [A-Za-z0-9_.:-]');
  const hash = await sha256Hex(`${req.method}\n${req.path}\n${req.body}`);
  const claimed = await sql`
    INSERT INTO idempotency_records (actor_id, idempotency_key, method, path, request_hash, expires_at)
    VALUES (${actorId}, ${key}, ${req.method}, ${req.path}, ${hash}, now() + interval '24 hours')
    ON CONFLICT (actor_id, idempotency_key) DO NOTHING RETURNING actor_id`;
  if (!claimed.length) {
    const [rec] = await sql<{ request_hash: string; status_code: number | null; response_body: unknown }[]>`
      SELECT request_hash, status_code, response_body FROM idempotency_records WHERE actor_id = ${actorId} AND idempotency_key = ${key}`;
    if (!rec || rec.request_hash !== hash) throw conflict('Idempotency-Key was already used with a different request');
    if (rec.status_code === null) throw new AppError('conflict', 'A request with this Idempotency-Key is still in progress');
    return { status: rec.status_code, body: rec.response_body, replayed: true };
  }
  try {
    const result = await run();
    await sql`UPDATE idempotency_records SET status_code = ${result.status}, response_body = ${sql.json((result.body ?? null) as never)}
              WHERE actor_id = ${actorId} AND idempotency_key = ${key}`;
    return { ...result, replayed: false };
  } catch (e) {
    // Failed requests release the key so the client can retry.
    await sql`DELETE FROM idempotency_records WHERE actor_id = ${actorId} AND idempotency_key = ${key} AND status_code IS NULL`;
    throw e;
  }
}
