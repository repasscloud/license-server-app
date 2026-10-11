// Usage: DATABASE_URL=postgres://migrator@host/db npm run db:migrate
// Use the DIRECT (non-pooled) connection with the migration/owner role, never Hyperdrive.
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { migrate } from './lib/migrator.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required (direct connection, migration role).');
  process.exit(2);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  const r = await migrate(sql, dir, (m) => console.log(m));
  console.log(`migrations applied: ${r.applied.length}, already present: ${r.skipped.length}`);
} finally {
  await sql.end();
}
