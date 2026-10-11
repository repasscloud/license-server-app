// Runs the real Worker bundle in workerd (`wrangler dev`, local mode) against real PostgreSQL via
// the local Hyperdrive binding. Proves: Workers-runtime compatibility (no Node-only server
// dependencies), native Web Crypto ML-DSA-65 under webcrypto_modern_algorithms, postgres.js over
// Hyperdrive-style connection strings, and the HTTP contract end to end.
// It does NOT measure production CPU (workerd timers do not advance during computation and local
// mode enforces no CPU limit) — see scripts/bench-cpu.ts and docs/STATUS.md.

import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { verifyEnvelope, type TrustedKey } from '../../src/crypto/envelope.ts';
import type { Sql } from '../../src/db/client.ts';
import { base64UrlDecode, base64UrlEncode } from '../../src/lib/encoding.ts';
import { grantEntitlements } from '../../src/services/entitlements.ts';
import { freshDatabase } from '../helpers/db.ts';
import { makeCustomer, makeOffer, seedProduct, superActor, testConfig, VECTORS } from '../helpers/fixtures.ts';
import { bootstrapAdminToken } from '../helpers/http.ts';

let sql: Sql;
let drop: () => Promise<void>;
let proc: ChildProcess;
let base = '';
let key = '';
let enterpriseKey = '';
let token = '';
let log = '';
const { env, config } = testConfig();
const trusted: TrustedKey[] = VECTORS.keys.map((k) => ({ keyId: k.keyId, algorithm: k.algorithm, publicKey: base64UrlDecode(k.publicKey) }));
const timings: Record<string, number[]> = {};

function runtimeUrl(url: string): string {
  const u = new URL(url);
  const [user, pass] = inject('pgRuntimeAuth').split(':');
  u.username = user!;
  u.password = pass!;
  return u.toString();
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const t = performance.now();
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  (timings[path.replace(/(lic|act)_[0-9A-Z]+/, ':id')] ??= []).push(performance.now() - t);
  return r;
}

beforeAll(async () => {
  let url: string;
  ({ sql, drop, url } = await freshDatabase());
  const s = await seedProduct(sql, config, superActor());
  await makeOffer(sql, superActor(), 'biz', [{ editionPolicyId: s.editions.business, termType: 'perpetual', seatsPerUnit: 2 }]);
  await makeOffer(sql, superActor(), 'ent', [{ editionPolicyId: s.editions.enterprise, termType: 'perpetual' }]);
  const c = await makeCustomer(sql, superActor());
  key = (await grantEntitlements(sql, config, superActor(), { customerId: c.id, offerSku: 'biz', reason: 'workers test' })).entitlements[0]!.activationKey;
  enterpriseKey = (await grantEntitlements(sql, config, superActor(), { customerId: c.id, offerSku: 'ent', reason: 'workers test' })).entitlements[0]!.activationKey;
  ({ token } = await bootstrapAdminToken(sql, config, ['products:read', 'audit:read']));

  const port = 18000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  const vars = Object.entries({ ...env, ENVIRONMENT: 'development', PUBLIC_BASE_URL: base }).filter(([, v]) => typeof v === 'string').flatMap(([k, v]) => ['--var', `${k}:${v}`]);
  proc = spawn('npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--show-interactive-dev-session=false', ...vars], {
    cwd: process.cwd(),
    // Connect as the least-privilege runtime role from sql/roles.sql (proves the grants suffice).
    // CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false: never let wrangler inject a local .env file.
    env: { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: runtimeUrl(url), CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', WRANGLER_SEND_METRICS: 'false', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (d) => (log += d));
  proc.stderr!.on('data', (d) => (log += d));
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`wrangler dev did not start:\n${log.slice(-3000)}`);
}, 120_000);

afterAll(async () => {
  proc?.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  await drop?.();
  const summary = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, { n: v.length, medianWallMs: Math.round(v.sort((a, b) => a - b)[Math.floor(v.length / 2)]!) }]));
  console.log(`[workerd wall-clock timings incl. local DB] ${JSON.stringify(summary)}`);
});

describe('Worker in workerd with PostgreSQL via Hyperdrive binding', () => {
  it('health and readiness (database reachable through the Hyperdrive binding)', async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ status: 'ok' });
    const r = await fetch(`${base}/readyz`);
    expect(await r.json()).toMatchObject({ database: 'ok' });
  });

  it('v1 activation in workerd produces envelopes with native ML-DSA-65 + Ed25519 signatures', async () => {
    const secrets: string[] = [];
    let licenseId = '';
    let firstAct = '';
    for (let i = 1; i <= 2; i++) {
      const s = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
      secrets.push(s);
      const r = await post('/v1/activations', { productId: 'cursedelete', majorVersion: 2, activationKey: key, deviceId: String(i).repeat(64), clientSecret: s });
      expect(r.status, log.slice(-2000)).toBe(200);
      const b = (await r.json()) as { license: unknown; activation: unknown };
      const lic = await verifyEnvelope(JSON.stringify(b.license), 'repass-license-v1', trusted);
      const cert = await verifyEnvelope(JSON.stringify(b.activation), 'repass-activation-v1', trusted);
      expect(lic.ok && lic.verifiedKeyIds).toEqual(['vector-ed25519', 'vector-mldsa65']);
      expect(cert.ok).toBe(true);
      if (lic.ok) licenseId = lic.claims.licenseId as string;
      if (cert.ok && i === 1) firstAct = cert.claims.activationId as string;
    }
    const full = await post('/v1/activations', { productId: 'cursedelete', majorVersion: 2, activationKey: key, deviceId: '9'.repeat(64), clientSecret: secrets[0] });
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: string }).error).toBe('seat_limit');
    for (let i = 0; i < 5; i++) {
      const rn = await post(`/v1/licenses/${licenseId}/renew`, { productId: 'cursedelete', majorVersion: 2, activation: { activationId: firstAct, deviceId: '1'.repeat(64), clientSecret: secrets[0] } });
      expect(rn.status).toBe(200);
    }
    const de = await post(`/v1/activations/${firstAct}/deactivate`, { productId: 'cursedelete', majorVersion: 2, deviceId: '1'.repeat(64), clientSecret: secrets[0] });
    expect(de.status).toBe(204);
    for (let i = 0; i < 5; i++) {
      const pr = await post('/v1/activations', { productId: 'cursedelete', majorVersion: 2, activationKey: enterpriseKey, deviceId: 'x', clientSecret: secrets[0] });
      expect(pr.status).toBe(200);
    }
  });

  it('machine error contract and security headers', async () => {
    const r = await post('/v1/activations', { nope: true });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid_request', message: expect.any(String) });
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('admin API with a PAT, no cookies', async () => {
    const r = await fetch(`${base}/api/admin/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect((await fetch(`${base}/api/admin/v1/me`)).status).toBe(401);
  });

  it('portals render server-side HTML under a strict CSP', async () => {
    for (const p of ['/admin/login', '/portal/login', '/store', '/']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    }
  });

  it('rejects unsigned Stripe webhooks', async () => {
    const r = await fetch(`${base}/webhooks/stripe`, { method: 'POST', body: '{"id":"evt_x"}', headers: { 'stripe-signature': 't=1,v1=00' } });
    expect(r.status).toBe(400);
  });
});
