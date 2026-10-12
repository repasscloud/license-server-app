import { inject } from 'vitest';
import postgres from 'postgres';
import { createSql, type Sql } from '../../src/db/client.ts';

/** Clone the migrated template into a fresh database for one test file. */
export async function freshDatabase(): Promise<{ sql: Sql; url: string; drop: () => Promise<void> }> {
  const adminUrl = inject('pgAdminUrl');
  const template = inject('pgTemplate');
  const name = `repass_t_${Math.random().toString(36).slice(2, 10)}`;
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  await admin.end();
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const sql = createSql(url, { max: 20 });
  return {
    sql,
    url,
    drop: async () => {
      await sql.end({ timeout: 5 });
      const a = postgres(adminUrl, { max: 1, onnotice: () => {} });
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.end();
    },
  };
}
