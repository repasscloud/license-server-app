// Forward-only SQL migration runner. Runs OUTSIDE the Worker (operator/CI), with the migration
// role. Each file runs in its own transaction under an advisory lock; applied checksums are
// verified so edited migrations are detected.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(sql: Sql, dir: string, log: (m: string) => void = () => {}): Promise<MigrationResult> {
  const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const result: MigrationResult = { applied: [], skipped: [] };
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727274001)`;
    const done = new Map((await tx<{ version: string; checksum: string }[]>`SELECT version, checksum FROM schema_migrations`).map((r) => [r.version, r.checksum]));
    for (const f of files) {
      const body = readFileSync(join(dir, f), 'utf8');
      const sum = createHash('sha256').update(body).digest('hex');
      const prev = done.get(f);
      if (prev) {
        if (prev !== sum) throw new Error(`migration ${f} was modified after being applied (checksum mismatch)`);
        result.skipped.push(f);
        continue;
      }
      log(`applying ${f}`);
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version, checksum) VALUES (${f}, ${sum})`;
      result.applied.push(f);
    }
  });
  return result;
}
