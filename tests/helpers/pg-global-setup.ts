// Vitest global setup: provide a real PostgreSQL for integration tests.
// - If TEST_DATABASE_URL is set (CI service container), use it as the admin connection.
// - Otherwise create a throwaway local cluster with initdb/pg_ctl (PostgreSQL >= 15 binaries).
// A migrated template database is created; each test file clones it (see tests/helpers/db.ts).

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../scripts/lib/migrator.ts';

function pgBin(): string {
  for (const d of ['/opt/homebrew/opt/postgresql@18/bin', '/opt/homebrew/opt/postgresql@17/bin', '/usr/lib/postgresql/18/bin', '/usr/lib/postgresql/17/bin']) {
    if (existsSync(join(d, 'initdb'))) return d;
  }
  try {
    return execSync('pg_config --bindir').toString().trim();
  } catch {
    throw new Error('PostgreSQL server binaries not found; set TEST_DATABASE_URL or install PostgreSQL >= 15');
  }
}

let stop: (() => void) | undefined;

export default async function setup(project: TestProject) {
  let adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const bin = pgBin();
    const dir = mkdtempSync(join(tmpdir(), 'repass-pgtest-'));
    const port = 55000 + Math.floor(Math.random() * 5000);
    execFileSync(join(bin, 'initdb'), ['-D', join(dir, 'data'), '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' });
    execFileSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c max_connections=300 -c fsync=off`, '-l', join(dir, 'log'), '-w', 'start'], { stdio: 'ignore' });
    stop = () => {
      try {
        execFileSync(join(bin, 'pg_ctl'), ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  }
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  const template = `repass_tpl_${process.pid}`;
  await admin.unsafe(`DROP DATABASE IF EXISTS ${template}`);
  await admin.unsafe(`CREATE DATABASE ${template}`);
  const tplUrl = new URL(adminUrl);
  tplUrl.pathname = `/${template}`;
  const tpl = postgres(tplUrl.toString(), { max: 1, onnotice: () => {} });
  await migrate(tpl, fileURLToPath(new URL('../../migrations', import.meta.url)));
  // Apply the production least-privilege grants (sql/roles.sql) to the template so cloned test
  // databases carry them; the workerd test connects as repass_runtime.
  const runtimePassword = 'test_only_runtime_pw';
  await tpl.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repass_runtime') THEN CREATE ROLE repass_runtime LOGIN PASSWORD '${runtimePassword}'; END IF; END $$`);
  const roles = readFileSync(fileURLToPath(new URL('../../sql/roles.sql', import.meta.url)), 'utf8')
    .split('\n').filter((l) => !l.startsWith('\\') && !l.includes(":'runtime_password'") && !/^SELECT format|^WHERE NOT EXISTS/.test(l)).join('\n');
  await tpl.unsafe(roles);
  await tpl.unsafe(`ALTER ROLE repass_runtime PASSWORD '${runtimePassword}'`);
  await tpl.end();
  await admin.end();
  project.provide('pgAdminUrl', adminUrl);
  project.provide('pgRuntimeAuth', `repass_runtime:${runtimePassword}`);
  project.provide('pgTemplate', template);
  return async () => {
    const a = postgres(adminUrl!, { max: 1, onnotice: () => {} });
    await a.unsafe(`DROP DATABASE IF EXISTS ${template} WITH (FORCE)`).catch(() => {});
    await a.end();
    stop?.();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgTemplate: string;
    pgRuntimeAuth: string;
  }
}
