// Real-client interoperability: run CurseDelete's own conformance checker
// (repasscloud/cursedelete-2, `cargo run -p cursdel-license --example conformance`) against
// licences and certificates issued by THIS server through its normal DB issuance path.
// CurseDelete is an interop fixture, not an architectural assumption.
//
// Set CURSEDELETE_CONFORMANCE_BIN to the built example binary, e.g.
//   git clone https://github.com/repasscloud/cursedelete-2 && cd cursedelete-2
//   cargo build -p cursdel-license --example conformance
//   export CURSEDELETE_CONFORMANCE_BIN=$PWD/target/debug/examples/conformance
// The suite is SKIPPED (and reported as blocked) when the binary is unavailable.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importPrivateKey } from '../../src/crypto/algorithms.ts';
import { buildEnvelope } from '../../src/crypto/envelope.ts';
import type { Sql } from '../../src/db/client.ts';
import { base64UrlDecode, base64UrlEncode, decodeUtf8, hexDecode } from '../../src/lib/encoding.ts';
import { grantEntitlements } from '../../src/services/entitlements.ts';
import { activate } from '../../src/services/machine.ts';
import { freshDatabase } from '../helpers/db.ts';
import { deviceActor, makeCustomer, makeOffer, seedProduct, superActor, testConfig, VECTORS } from '../helpers/fixtures.ts';

const BIN = process.env.CURSEDELETE_CONFORMANCE_BIN ?? '';
const available = BIN !== '' && existsSync(BIN);
const DEVICE = '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF';

let sql: Sql;
let drop: () => Promise<void>;
const dir = mkdtempSync(join(tmpdir(), 'repass-conf-'));
const { config } = testConfig();
const admin = superActor();
const keyArgs = VECTORS.keys.flatMap((k) => ['--key', `${k.keyId}:${k.algorithm}:${k.publicKey}`]);

function check(licence: unknown, opts: { activation?: unknown; product?: string; major?: number; keys?: string[] } = {}) {
  const lp = join(dir, `l-${Math.random().toString(36).slice(2)}.license`);
  writeFileSync(lp, JSON.stringify(licence));
  const args = [...(opts.keys ?? keyArgs), '--product', opts.product ?? 'cursedelete', '--major', String(opts.major ?? 2), '--license', lp];
  if (opts.activation) {
    const ap = join(dir, `a-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(ap, JSON.stringify(opts.activation));
    args.push('--activation', ap, '--device', DEVICE);
  }
  const r = spawnSync(BIN, args, { encoding: 'utf8' });
  return { code: r.status, report: r.stdout };
}

async function forge(claims: Record<string, unknown>, format = 'repass-license-v1') {
  const k = VECTORS.keys.find((x) => x.algorithm === 'Ed25519')!;
  const signer = { keyId: k.keyId, algorithm: k.algorithm, key: await importPrivateKey(k.algorithm, hexDecode(k.testOnlyPrivateSeedHex)) };
  return (await buildEnvelope(format, claims, [signer], 8)).envelope;
}

const issued: Record<string, { license: unknown; activation: unknown }> = {};

describe.skipIf(!available)('CurseDelete conformance checker (real client verifier)', () => {
  beforeAll(async () => {
    ({ sql, drop } = await freshDatabase());
    const s = await seedProduct(sql, config, admin, 'cursedelete', 2, ['vector-ed25519', 'vector-p256', 'vector-mldsa65']);
    // All three algorithms are eligible so every licence is triple-signed.
    await makeOffer(sql, admin, 'c', [{ editionPolicyId: s.editions.community, termType: 'perpetual' }], { billing: 'free' });
    await makeOffer(sql, admin, 'e', [{ editionPolicyId: s.editions.education, termType: 'perpetual' }]);
    await makeOffer(sql, admin, 'n', [{ editionPolicyId: s.editions.enterprise, termType: 'perpetual' }]);
    await makeOffer(sql, admin, 'bp', [{ editionPolicyId: s.editions.business, termType: 'perpetual', seatsPerUnit: 3 }]);
    await makeOffer(sql, admin, 'bs', [{ editionPolicyId: s.editions.business, termType: 'subscription', seatsPerUnit: 2 }], { billing: 'recurring' });
    for (const sku of ['c', 'e', 'n', 'bp', 'bs']) {
      const cust = await makeCustomer(sql, admin, sku === 'c' ? 'individual' : 'organisation');
      const g = await grantEntitlements(sql, config, admin, { customerId: cust.id, offerSku: sku, expiresAt: sku === 'bs' ? new Date(Date.now() + 30 * 86400_000) : null, reason: 'conformance' });
      const r = await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.entitlements[0]!.activationKey, deviceId: DEVICE, clientSecret: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))) });
      issued[sku] = r;
    }
  });
  afterAll(async () => {
    await drop?.();
    rmSync(dir, { recursive: true, force: true });
  });

  for (const [sku, label] of [['c', 'community'], ['e', 'education'], ['n', 'enterprise'], ['bp', 'business perpetual'], ['bs', 'business subscription']] as const) {
    it(`accepts the server-issued ${label} licence${sku.startsWith('b') ? ' and activation certificate' : ''}`, () => {
      const r = check(issued[sku]!.license, { activation: sku.startsWith('b') ? issued[sku]!.activation : undefined });
      expect(r.code, r.report).toBe(0);
    });
  }

  it('accepts each algorithm on its own (Ed25519, ECDSA-P256 P1363, ML-DSA-65)', () => {
    for (const k of VECTORS.keys) {
      const r = check(issued.n!.license, { keys: ['--key', `${k.keyId}:${k.algorithm}:${k.publicKey}`] });
      expect(r.code, `${k.algorithm}: ${r.report}`).toBe(0);
    }
  });

  it('rejects wrong product and wrong major', () => {
    expect(check(issued.n!.license, { product: 'otherapp' }).code).toBe(1);
    expect(check(issued.n!.license, { major: 3 }).code).toBe(1);
  });

  it('rejects a tampered payload', () => {
    const env = structuredClone(issued.n!.license) as { payload: string };
    const claims = JSON.parse(decodeUtf8(base64UrlDecode(env.payload)));
    claims.edition = 'business';
    env.payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
    expect(check(env).code).toBe(1);
  });

  it('rejects rule-breaking licences the server itself refuses to issue', async () => {
    const base = { schemaVersion: 1, licenseId: 'lic_forged', customerId: 'cus_forged', productId: 'cursedelete', majorVersion: 2, issuedAt: '2026-10-11T00:00:00Z' };
    const nonPerpetualEnterprise = await forge({ ...base, edition: 'enterprise', perpetual: false, expiresAt: '2030-01-01T00:00:00Z' });
    const businessNoSeats = await forge({ ...base, edition: 'business', perpetual: true, expiresAt: null });
    const unknownField = await forge({ ...base, edition: 'community', perpetual: true, expiresAt: null, email: 'x@y.z' });
    expect(check(nonPerpetualEnterprise).code).toBe(1);
    expect(check(businessNoSeats).code).toBe(1);
    expect(check(unknownField).code).toBe(1);
  });

  it('rejects a certificate for a different device', () => {
    const r = spawnSync(BIN, [...keyArgs, '--product', 'cursedelete', '--major', '2', '--license', (() => { const p = join(dir, 'b.license'); writeFileSync(p, JSON.stringify(issued.bp!.license)); return p; })(),
      '--activation', (() => { const p = join(dir, 'b.json'); writeFileSync(p, JSON.stringify(issued.bp!.activation)); return p; })(), '--device', 'F'.repeat(64)], { encoding: 'utf8' });
    expect(r.status).toBe(1);
  });
});

describe.skipIf(available)('CurseDelete conformance checker', () => {
  it('BLOCKED: CURSEDELETE_CONFORMANCE_BIN not set or missing — real-client check not run', () => {
    expect(available).toBe(false);
  });
});
