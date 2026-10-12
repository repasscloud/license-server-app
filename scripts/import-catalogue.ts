// Import offers from the stripe-catalogue CSV through the admin API (POST /catalogue/import).
// Only rows with _ls:import = yes are imported (see stripe-catalogue/README-LICENSE-SERVER.md).
// Dry run by default; --apply performs the import.
//
//   npm run catalogue:import -- stripe-catalogue/products.csv            # dry run
//   npm run catalogue:import -- stripe-catalogue/products.csv --apply
//
// API base: --api URL, else $REPASS_API (e.g. https://license-server.repasscloud.com/api/admin/v1).
// Token (products:write + prices:write): $REPASS_ADMIN_TOKEN, else the macOS Keychain item
// "repass-admin-pat" (see docs/runbooks/terminal-admin-api.md).

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';

interface Row { line: number; sku: string; name: string; action: string; changes: string[]; warnings: string[]; error?: string }
interface Result { dryRun: boolean; selected: number; skipped: number; created: number; updated: number; unchanged: number; errors: number; rows: Row[] }

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error('usage: node scripts/import-catalogue.ts <products.csv> [--apply] [--api https://…/api/admin/v1] [--show-skipped]');
  process.exit(2);
}

const args = process.argv.slice(2);
let file: string | undefined;
let api = process.env.REPASS_API ?? '';
let apply = false;
let showSkipped = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--apply') apply = true;
  else if (a === '--show-skipped') showSkipped = true;
  else if (a === '--api') api = args[++i] ?? usage('--api needs a URL');
  else if (a.startsWith('-')) usage(`unknown option ${a}`);
  else if (!file) file = a;
  else usage('only one CSV file');
}
if (!file) usage();
if (!/^https?:\/\//.test(api)) usage('Set --api or REPASS_API to the admin API base, e.g. https://license-server.repasscloud.com/api/admin/v1');

function adminToken(): string {
  if (process.env.REPASS_ADMIN_TOKEN) return process.env.REPASS_ADMIN_TOKEN;
  try {
    return execFileSync('security', ['find-generic-password', '-a', userInfo().username, '-s', 'repass-admin-pat', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    console.error('No admin token: set REPASS_ADMIN_TOKEN or store one in the Keychain as "repass-admin-pat".');
    process.exit(2);
  }
}

const csv = readFileSync(file, 'utf8');
const res = await fetch(`${api.replace(/\/$/, '')}/catalogue/import`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${adminToken()}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
  body: JSON.stringify({ csv, apply }),
});
const body = (await res.json().catch(() => null)) as (Result & { error?: { code: string; message: string } }) | null;
if (!res.ok || !body || body.error) {
  console.error(`Import refused (HTTP ${res.status}): ${body?.error?.message ?? 'no response body'}`);
  process.exit(1);
}

for (const r of body.rows) {
  if (r.action === 'skipped' && !showSkipped) continue;
  console.log(`Line ${r.line}: ${r.action.toUpperCase().padEnd(9)} ${r.sku}${r.name ? `  (${r.name})` : ''}`);
  for (const c of r.changes) console.log(`    ${apply ? 'done' : 'would'}: ${c}`);
  for (const w of r.warnings) console.log(`    note: ${w}`);
  if (r.error) console.log(`    ERROR: ${r.error}`);
}
console.log(`${body.dryRun ? 'DRY RUN' : 'APPLIED'}: ${body.selected} selected (${body.skipped} skipped) · ${body.created} create, ${body.updated} update, ${body.unchanged} unchanged, ${body.errors} error(s)`);
if (body.dryRun && body.selected) console.log('Re-run with --apply to perform these changes.');
process.exit(body.errors ? 1 : 0);
