// Fixed-window rate limiting stored in PostgreSQL (portable, consistent across isolates and
// regions, and Free-plan friendly: one upsert per request checks every dimension at once).
// Identifiers (IPs, key hashes) are HMAC-hashed before use; raw IPs are never stored.

import type { Db } from '../db/client.ts';

export interface Limit {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  exceeded: string[];
}

export async function checkRateLimits(db: Db, limits: Limit[], now = new Date()): Promise<RateDecision> {
  if (limits.length === 0) return { allowed: true, retryAfterSeconds: 0, exceeded: [] };
  const keys = limits.map((l) => l.key);
  const windows = limits.map((l) => new Date(Math.floor(now.getTime() / (l.windowSeconds * 1000)) * l.windowSeconds * 1000));
  const rows = await db<{ bucket_key: string; hits: number }[]>`
    INSERT INTO rate_limit_buckets (bucket_key, window_start, hits)
    SELECT x->>0, (x->>1)::timestamptz, 1 FROM jsonb_array_elements(${db.json(keys.map((k, i) => [k, windows[i]!.toISOString()]) as never)}::jsonb) AS x
    ON CONFLICT (bucket_key, window_start) DO UPDATE SET hits = rate_limit_buckets.hits + 1
    RETURNING bucket_key, hits`;
  const exceeded: string[] = [];
  let retry = 0;
  limits.forEach((l, i) => {
    const r = rows.find((x) => x.bucket_key === l.key);
    if (r && r.hits > l.limit) {
      exceeded.push(l.key.split(':').slice(0, 2).join(':'));
      retry = Math.max(retry, Math.ceil((windows[i]!.getTime() + l.windowSeconds * 1000 - now.getTime()) / 1000));
    }
  });
  return { allowed: exceeded.length === 0, retryAfterSeconds: retry, exceeded };
}

export async function purgeRateLimitBuckets(db: Db): Promise<number> {
  const r = await db`DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '1 day'`;
  return r.count;
}
