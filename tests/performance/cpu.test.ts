// CPU-time evidence for the Workers Free 10 ms/invocation budget.
//
// Workers bills CPU time, not wall time; waiting on PostgreSQL/Stripe/MailerSend I/O is free.
// workerd in local mode cannot report CPU, so we run the SAME request code path in Node (same V8,
// native crypto; Node uses OpenSSL where workerd uses BoringSSL) and measure process.cpuUsage()
// around each request. The DB server runs in a separate process, so its CPU is excluded, as on
// Workers. Results are hardware-dependent: Cloudflare edge CPUs may be slower than this machine.
// The authoritative check is production `cpuTime` in Workers Logs (docs/runbooks/free-plan-limits.md).

import { writeFileSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair, importPrivateKey, sign, type SignatureAlgorithm } from '../../src/crypto/algorithms.ts';
import { open, seal, signingKeyAad } from '../../src/crypto/aead.ts';
import type { Sql } from '../../src/db/client.ts';
import { base64UrlEncode, encodeUtf8 } from '../../src/lib/encoding.ts';
import { grantEntitlements } from '../../src/services/entitlements.ts';
import { freshDatabase } from '../helpers/db.ts';
import { makeCustomer, makeOffer, seedProduct, superActor, testConfig } from '../helpers/fixtures.ts';
import { bootstrapAdminToken, Client, httpEnv } from '../helpers/http.ts';

const results: Record<string, unknown> = {};
let sql: Sql;
let drop: () => Promise<void>;
let url: string;
const { env, config } = testConfig();

function cpuMs<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = process.cpuUsage();
  return fn().then((value) => {
    const d = process.cpuUsage(start);
    return { ms: (d.user + d.system) / 1000, value };
  });
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { n: s.length, p50: +s[Math.floor(s.length * 0.5)]!.toFixed(3), p95: +s[Math.floor(s.length * 0.95)]!.toFixed(3), max: +s[s.length - 1]!.toFixed(3) };
};

beforeAll(async () => {
  ({ sql, drop, url } = await freshDatabase());
});
afterAll(async () => {
  results.environment = { node: process.version, cpu: cpus()[0]?.model, date: new Date().toISOString() };
  mkdirSync('docs/perf', { recursive: true });
  writeFileSync('docs/perf/cpu-latest.json', JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
  await drop?.();
});

describe('CPU cost of critical operations (ms of CPU per operation)', () => {
  it('signature primitives', async () => {
    const msg = encodeUtf8('repass-license-v1\n' + JSON.stringify({ schemaVersion: 1, licenseId: 'lic_x'.padEnd(30, 'x') }));
    for (const alg of ['Ed25519', 'ECDSA-P256-SHA256', 'ML-DSA-65'] as SignatureAlgorithm[]) {
      const { privateKey } = await generateKeyPair(alg);
      const key = await importPrivateKey(alg, privateKey);
      await sign(alg, key, msg);
      const xs: number[] = [];
      for (let i = 0; i < 100; i++) xs.push((await cpuMs(() => sign(alg, key, msg))).ms);
      results[`sign.${alg}`] = stats(xs);
    }
    const kek = config.signingKeks;
    const s = await seal(kek, crypto.getRandomValues(new Uint8Array(32)), signingKeyAad('k', 'Ed25519', 'ed25519-seed32', 1));
    const xs: number[] = [];
    for (let i = 0; i < 100; i++) xs.push((await cpuMs(() => open(kek, s, signingKeyAad('k', 'Ed25519', 'ed25519-seed32', 1)))).ms);
    results['aes-gcm.unwrap-signing-key'] = stats(xs);
    expect(Object.keys(results).length).toBeGreaterThan(3);
  });

  it('full HTTP request paths through the Worker app (warm isolate)', async () => {
    const httpenv = httpEnv(url, env);
    const s = await seedProduct(sql, config, superActor());
    await makeOffer(sql, superActor(), 'biz', [{ editionPolicyId: s.editions.business, termType: 'perpetual', seatsPerUnit: 1000 }]);
    await makeOffer(sql, superActor(), 'ent', [{ editionPolicyId: s.editions.enterprise, termType: 'perpetual' }]);
    const c = await makeCustomer(sql, superActor());
    const biz = (await grantEntitlements(sql, config, superActor(), { customerId: c.id, offerSku: 'biz', reason: 'perf' })).entitlements[0]!;
    const ent = (await grantEntitlements(sql, config, superActor(), { customerId: c.id, offerSku: 'ent', reason: 'perf' })).entitlements[0]!;
    const { token } = await bootstrapAdminToken(sql, config, ['products:read', 'licenses:read']);
    const client = new Client(httpenv);
    const run = async (name: string, n: number, f: (i: number) => Promise<Response>) => {
      const cold = await cpuMs(() => f(-1));
      const xs: number[] = [];
      for (let i = 0; i < n; i++) {
        const r = await cpuMs(() => f(i));
        if (r.value.status >= 500) throw new Error(`${name} failed ${r.value.status}`);
        xs.push(r.ms);
      }
      results[`http.${name}`] = { firstCallInIsolate: +cold.ms.toFixed(3), warm: stats(xs) };
    };
    const secret = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
    // Business activation: licence (Ed25519 + ML-DSA-65) + certificate (Ed25519 + ML-DSA-65), seat txn.
    await run('v1.activate.business.new-device', 40, (i) => client.request('/v1/activations', { method: 'POST', json: { productId: 'cursedelete', majorVersion: 2, activationKey: biz.activationKey, deviceId: `D${i + 2}`.padEnd(64, '0'), clientSecret: secret } }));
    await run('v1.activate.enterprise.provision', 40, () => client.request('/v1/activations', { method: 'POST', json: { productId: 'cursedelete', majorVersion: 2, activationKey: ent.activationKey, deviceId: 'x', clientSecret: secret } }));
    await run('v1.renew.licence-only', 40, () => client.request(`/v1/licenses/${ent.licenseId}/renew`, { method: 'POST', json: { productId: 'cursedelete', majorVersion: 2 } }));
    await run('admin-api.get-products', 40, () => client.request('/api/admin/v1/products', { token }));
    await run('portal.login-page', 40, () => client.request('/portal/login'));
    await run('store.page', 20, () => client.request('/store'));
  });
});
