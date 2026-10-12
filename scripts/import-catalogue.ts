// Import the stripe-catalogue CSV through the admin API (same preview/apply flow as the admin
// portal's Import CSV page). Only rows with _ls:import = yes are imported (see
// stripe-catalogue/README-LICENSE-SERVER.md).
//
//   npm run catalogue:import -- stripe-catalogue/products.csv             # upload + preview
//   npm run catalogue:import -- stripe-catalogue/products.csv --apply     # preview, then apply it
//   npm run catalogue:import -- --apply-id imp_…                          # apply a reviewed preview
//
// --apply refuses when the preview rejected rows (fix them, or pass --skip-rejected to apply the
// rest). API base: --api URL, else $REPASS_API (e.g. https://license-server.repasscloud.com/api/admin/v1).
// Token (products:write + prices:write): $REPASS_ADMIN_TOKEN, else the macOS Keychain item
// "repass-admin-pat" (see docs/runbooks/terminal-admin-api.md).

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { userInfo } from 'node:os';

interface PlanRow { line: number; sku: string; name: string; action: string; stripeProductId: string | null; changes: string[]; warnings: string[]; errors: string[] }
interface PlanEntity { label: string; action: string; changes: string[]; errors: string[] }
interface Summary { selected: number; skipped: number; create: number; link: number; update: number; unchanged: number; errors: number; entitiesToCreate: number; entityErrors: number }
interface Import {
  id: string; status: string; stripeMode: string; summary: Summary; plan: { entities: PlanEntity[]; rows: PlanRow[] };
  result: { rows: Array<{ line: number; sku: string; outcome: string; error?: string }>; counts: Record<string, number> } | null;
}

function usage(msg?: string): never {
  if (msg) console.error(msg);
  console.error('usage: node scripts/import-catalogue.ts <products.csv> [--apply [--skip-rejected]] | --apply-id imp_…  [--api https://…/api/admin/v1] [--show-skipped]');
  process.exit(2);
}

const args = process.argv.slice(2);
let file: string | undefined;
let applyId: string | undefined;
let api = process.env.REPASS_API ?? '';
let apply = false;
let skipRejected = false;
let showSkipped = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--apply') apply = true;
  else if (a === '--skip-rejected') skipRejected = true;
  else if (a === '--show-skipped') showSkipped = true;
  else if (a === '--apply-id') applyId = args[++i] ?? usage('--apply-id needs an import id');
  else if (a === '--api') api = args[++i] ?? usage('--api needs a URL');
  else if (a.startsWith('-')) usage(`unknown option ${a}`);
  else if (!file) file = a;
  else usage('only one CSV file');
}
if (!file && !applyId) usage();
if (file && applyId) usage('give a CSV file or --apply-id, not both');
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

const token = adminToken();
async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Import> {
  const res = await fetch(`${api.replace(/\/$/, '')}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => null)) as (Import & { error?: { code: string; message: string } }) | null;
  if (!res.ok || !json || json.error) {
    console.error(`${method} ${path} refused (HTTP ${res.status}): ${json?.error?.message ?? 'no response body'}`);
    process.exit(1);
  }
  return json;
}

function printPlan(imp: Import) {
  for (const e of imp.plan.entities) {
    if (e.action === 'unchanged') continue;
    console.log(`${e.action.toUpperCase().padEnd(9)} ${e.label}`);
    for (const c of e.changes) console.log(`    would: ${c}`);
    for (const x of e.errors) console.log(`    ERROR: ${x}`);
  }
  for (const r of imp.plan.rows) {
    if (r.action === 'skipped' && !showSkipped) continue;
    console.log(`Line ${r.line}: ${r.action.toUpperCase().padEnd(9)} ${r.sku}${r.name ? `  (${r.name})` : ''}${r.stripeProductId ? `  [${r.stripeProductId}]` : ''}`);
    for (const c of r.changes) console.log(`    would: ${c}`);
    for (const w of r.warnings) console.log(`    note: ${w}`);
    for (const x of r.errors) console.log(`    ERROR: ${x}`);
  }
  const s = imp.summary;
  console.log(`PREVIEW ${imp.id} (Stripe ${imp.stripeMode} mode): ${s.selected} selected (${s.skipped} skipped) · ${s.create} create, ${s.link} link, ${s.update} update, ${s.unchanged} unchanged, `
    + `${s.errors} rejected · ${s.entitiesToCreate} product/major/edition to create, ${s.entityErrors} with errors`);
}

function printResult(imp: Import) {
  for (const r of imp.result?.rows ?? []) {
    if (r.outcome === 'skipped' && !showSkipped) continue;
    console.log(`Line ${r.line}: ${r.outcome.toUpperCase().padEnd(9)} ${r.sku}${r.error ? `  ERROR: ${r.error}` : ''}`);
  }
  console.log(`APPLIED ${imp.id}: ${JSON.stringify(imp.result?.counts ?? {})}`);
}

let imp: Import;
if (applyId) {
  imp = await call('POST', `/catalogue/imports/${encodeURIComponent(applyId)}/apply`, {});
  printResult(imp);
} else {
  imp = await call('POST', '/catalogue/imports', { csv: readFileSync(file!, 'utf8'), fileName: basename(file!) });
  printPlan(imp);
  const rejected = imp.summary.errors + imp.summary.entityErrors;
  if (!apply) {
    console.log(`Review it, then: npm run catalogue:import -- --apply-id ${imp.id}   (or open /admin/catalogue/imports/${imp.id})`);
  } else if (rejected && !skipRejected) {
    console.error(`Not applied: ${rejected} rejected row(s)/item(s). Fix the CSV and re-run, or add --skip-rejected to apply the rest.`);
    process.exit(1);
  } else {
    imp = await call('POST', `/catalogue/imports/${imp.id}/apply`, {});
    printResult(imp);
  }
}
const counts = imp.result?.counts;
process.exit(imp.summary.errors + imp.summary.entityErrors || (counts && (counts.errors || counts.partial)) ? 1 : 0);
