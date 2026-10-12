// Brief §15.2 acceptance checklist against a REAL PostgreSQL database.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyEnvelope, type Envelope, type TrustedKey } from '../../src/crypto/envelope.ts';
import type { Sql } from '../../src/db/client.ts';
import { validateActivationClaimsV1, validateLicenseClaimsV1 } from '../../src/domain/v1-claims.ts';
import { base64UrlDecode, base64UrlEncode } from '../../src/lib/encoding.ts';
import type { Config } from '../../src/config.ts';
import { grantEntitlements } from '../../src/services/entitlements.ts';
import { amendEntitlement, grantTransfers, releaseActivation, resetTransfers, revokeEntitlement, unrevokeEntitlement } from '../../src/services/licensing.ts';
import { activate, deactivate, MachineError, renew } from '../../src/services/machine.ts';
import { freshDatabase } from '../helpers/db.ts';
import { deviceActor, makeCustomer, makeOffer, seedProduct, superActor, testConfig, VECTORS, type SeededProduct } from '../helpers/fixtures.ts';

let sql: Sql;
let drop: () => Promise<void>;
let config: Config;
let seeded: SeededProduct;
const admin = superActor();
const trusted: TrustedKey[] = VECTORS.keys.map((k) => ({ keyId: k.keyId, algorithm: k.algorithm, publicKey: base64UrlDecode(k.publicKey) }));

const secret = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
const device = (n: number) => n.toString(16).toUpperCase().padStart(64, '0');

async function expectMachineError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof MachineError && e.code === code);
}

async function assertValid(env: Envelope, format: string) {
  const r = await verifyEnvelope(JSON.stringify(env), format, trusted);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.verifiedKeyIds).toEqual(['vector-ed25519', 'vector-mldsa65']);
    const problems = format === 'repass-license-v1' ? validateLicenseClaimsV1(r.claims) : validateActivationClaimsV1(r.claims);
    expect(problems).toEqual([]);
    return r.claims;
  }
  throw new Error('unreachable');
}

async function grant(sku: string, opts: { quantity?: number; expiresAt?: Date; kind?: 'individual' | 'organisation' } = {}) {
  const c = await makeCustomer(sql, admin, opts.kind ?? 'organisation');
  const g = await grantEntitlements(sql, config, admin, { customerId: c.id, offerSku: sku, quantity: opts.quantity ?? 1, expiresAt: opts.expiresAt ?? null, reason: 'test grant' });
  return { customerId: c.id, ...g.entitlements[0]! };
}

beforeAll(async () => {
  ({ sql, drop } = await freshDatabase());
  ({ config } = testConfig());
  seeded = await seedProduct(sql, config, admin);
  await makeOffer(sql, admin, 'cd2-community', [{ editionPolicyId: seeded.editions.community, termType: 'perpetual' }], { billing: 'free' });
  await makeOffer(sql, admin, 'cd2-education', [{ editionPolicyId: seeded.editions.education, termType: 'perpetual' }]);
  await makeOffer(sql, admin, 'cd2-enterprise', [{ editionPolicyId: seeded.editions.enterprise, termType: 'perpetual' }]);
  await makeOffer(sql, admin, 'cd2-business-3', [{ editionPolicyId: seeded.editions.business, termType: 'perpetual', seatsPerUnit: 3, transferAllowance: 2 }]);
  await makeOffer(sql, admin, 'cd2-business-sub', [{ editionPolicyId: seeded.editions.business, termType: 'subscription', seatsPerUnit: 1, quantityScalesSeats: true }], { billing: 'recurring', maxQuantity: 50 });
});
afterAll(async () => drop?.());

describe('provisioning editions (community / education / enterprise)', () => {
  for (const sku of ['cd2-community', 'cd2-education', 'cd2-enterprise']) {
    it(`${sku}: returns the licence with activation:null and stores no device record`, async () => {
      const g = await grant(sku, { kind: sku === 'cd2-community' ? 'individual' : 'organisation' });
      const r = await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey.toLowerCase(), deviceId: device(1), clientSecret: secret() });
      expect(r.activation).toBeNull();
      const claims = await assertValid(r.license, 'repass-license-v1');
      expect(claims.licenseId).toBe(g.licenseId);
      expect(claims.perpetual).toBe(true);
      expect('maxActivations' in claims).toBe(false);
      expect(JSON.stringify(claims)).not.toMatch(/@/); // no email in licence
      const rows = await sql`SELECT 1 FROM activations WHERE license_id = ${g.licenseId}`;
      expect(rows.length).toBe(0);
    });
  }

  it('rejects unknown keys, other products and other majors', async () => {
    const g = await grant('cd2-enterprise');
    await expectMachineError(activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', deviceId: device(1), clientSecret: secret() }), 'invalid_key');
    await expectMachineError(activate(sql, config, deviceActor, { productId: 'otherapp', majorVersion: 2, activationKey: g.activationKey, deviceId: device(1), clientSecret: secret() }), 'product_mismatch');
    await expectMachineError(activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 3, activationKey: g.activationKey, deviceId: device(1), clientSecret: secret() }), 'version_mismatch');
    await expectMachineError(renew(sql, config, deviceActor, g.licenseId, { productId: 'cursedelete', majorVersion: 3 }), 'version_mismatch');
    await expectMachineError(renew(sql, config, deviceActor, 'lic_nope', { productId: 'cursedelete', majorVersion: 2 }), 'not_found');
  });
});

describe('business seats and transfers', () => {
  it('N devices activate, N+1 gets seat_limit, same device re-uses its seat', async () => {
    const g = await grant('cd2-business-3');
    const ids: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const r = await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(i), clientSecret: secret() });
      const lic = await assertValid(r.license, 'repass-license-v1');
      expect(lic.maxActivations).toBe(3);
      const cert = await assertValid(r.activation!, 'repass-activation-v1');
      expect(cert.deviceId).toBe(device(i));
      expect(cert.expiresAt).toBeNull();
      ids.push(cert.activationId as string);
    }
    await expectMachineError(activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(4), clientSecret: secret() }), 'seat_limit');
    // Re-activation of device 2 with a NEW client secret keeps the activationId, consumes no seat.
    const s2 = secret();
    const again = await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(2), clientSecret: s2 });
    const cert = await assertValid(again.activation!, 'repass-activation-v1');
    expect(cert.activationId).toBe(ids[1]);
    // The rotated secret now authenticates renew.
    const rn = await renew(sql, config, deviceActor, g.licenseId, { productId: 'cursedelete', majorVersion: 2, activation: { activationId: ids[1]!, deviceId: device(2), clientSecret: s2 } });
    expect(rn.activation).not.toBeNull();
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM activations WHERE license_id = ${g.licenseId} AND status = 'active'`;
    expect(count!.n).toBe(3);
  });

  it('concurrent activations never exceed maxActivations (real row locks)', async () => {
    const g = await grant('cd2-business-3');
    const attempts = Array.from({ length: 12 }, (_, i) =>
      activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(100 + i), clientSecret: secret() }).then(
        () => 'ok',
        (e) => (e instanceof MachineError ? e.code : String(e)),
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok').length).toBe(3);
    expect(results.filter((r) => r === 'seat_limit').length).toBe(9);
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM activations WHERE license_id = ${g.licenseId} AND status = 'active'`;
    expect(count!.n).toBe(3);
  });

  it('concurrent re-activation of the same device yields one activation', async () => {
    const g = await grant('cd2-business-3');
    const results = await Promise.all(Array.from({ length: 6 }, () => activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(7), clientSecret: secret() })));
    const ids = new Set(await Promise.all(results.map(async (r) => (await assertValid(r.activation!, 'repass-activation-v1')).activationId)));
    expect(ids.size).toBe(1);
  });

  it('transfer rule: release + new device counts once; allowance+1 is transfer_limit; reset clears; grant adds', async () => {
    const g = await grant('cd2-business-3'); // allowance 2
    const secrets: Record<number, string> = {};
    const acts: Record<number, string> = {};
    for (let i = 1; i <= 3; i++) {
      secrets[i] = secret();
      const r = await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(i), clientSecret: secrets[i]! });
      acts[i] = (await assertValid(r.activation!, 'repass-activation-v1')).activationId as string;
    }
    // Filling never-used seats consumed no transfers.
    // Release device 1 from the app; activate device 4 => transfer #1.
    await deactivate(sql, config, deviceActor, acts[1]!, { productId: 'cursedelete', majorVersion: 2, deviceId: device(1), clientSecret: secrets[1]! });
    await expectMachineError(deactivate(sql, config, deviceActor, acts[1]!, { productId: 'cursedelete', majorVersion: 2, deviceId: device(1), clientSecret: secrets[1]! }), 'activation_inactive');
    await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(4), clientSecret: secret() });
    // Portal release of device 2; next renew from device 2 learns it is inactive.
    await releaseActivation(sql, { type: 'customer', id: g.customerId, label: 'customer' }, acts[2]!, 'portal');
    await expectMachineError(renew(sql, config, deviceActor, g.licenseId, { productId: 'cursedelete', majorVersion: 2, activation: { activationId: acts[2]!, deviceId: device(2), clientSecret: secrets[2]! } }), 'activation_inactive');
    await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(5), clientSecret: secret() }); // transfer #2
    await releaseActivation(sql, admin, acts[3]!, 'support');
    await expectMachineError(activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(6), clientSecret: secret() }), 'transfer_limit');
    await grantTransfers(sql, admin, g.licenseId, 1, 'customer replaced hardware');
    await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(6), clientSecret: secret() });
    // Seat is now full again; release another and verify reset clears the window.
    const [row4] = await sql<{ id: string }[]>`SELECT id FROM activations WHERE license_id = ${g.licenseId} AND device_id = ${device(4)}`;
    const d4 = row4!.id;
    await releaseActivation(sql, admin, d4, 'support');
    await expectMachineError(activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(8), clientSecret: secret() }), 'transfer_limit');
    await resetTransfers(sql, admin, g.licenseId, 'annual review');
    await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(8), clientSecret: secret() });
  });

  it('wrong secret or device => unauthorized; unknown activation => not_found', async () => {
    const g = await grant('cd2-business-3');
    const s = secret();
    const r = await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(1), clientSecret: s });
    const actId = (await assertValid(r.activation!, 'repass-activation-v1')).activationId as string;
    await expectMachineError(renew(sql, config, deviceActor, g.licenseId, { productId: 'cursedelete', majorVersion: 2, activation: { activationId: actId, deviceId: device(1), clientSecret: secret() } }), 'unauthorized');
    await expectMachineError(renew(sql, config, deviceActor, g.licenseId, { productId: 'cursedelete', majorVersion: 2, activation: { activationId: actId, deviceId: device(2), clientSecret: s } }), 'unauthorized');
    await expectMachineError(deactivate(sql, config, deviceActor, actId, { productId: 'cursedelete', majorVersion: 2, deviceId: device(1), clientSecret: secret() }), 'unauthorized');
    await expectMachineError(deactivate(sql, config, deviceActor, 'act_missing', { productId: 'cursedelete', majorVersion: 2, deviceId: device(1), clientSecret: s }), 'not_found');
  });

  it('seat reduction below active count blocks new activations without deactivating devices', async () => {
    const g = await grant('cd2-business-3');
    for (let i = 1; i <= 3; i++) await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(i), clientSecret: secret() });
    await amendEntitlement(sql, admin, g.licenseId, { seats: 1, reason: 'downgrade' });
    const [count] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM activations WHERE license_id = ${g.licenseId} AND status = 'active'`;
    expect(count!.n).toBe(3);
    await expectMachineError(activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(9), clientSecret: secret() }), 'seat_limit');
    const rn = await renew(sql, config, deviceActor, g.licenseId, { productId: 'cursedelete', majorVersion: 2 });
    expect((await assertValid(rn.license, 'repass-license-v1')).maxActivations).toBe(1);
  });
});

describe('revocation and subscriptions', () => {
  it('revoke => activate and renew return revoked; deactivate still releases; unrevoke restores', async () => {
    const g = await grant('cd2-business-3');
    const s = secret();
    const r = await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(1), clientSecret: s });
    const actId = (await assertValid(r.activation!, 'repass-activation-v1')).activationId as string;
    await revokeEntitlement(sql, admin, g.licenseId, { reason: 'chargeback' });
    await expectMachineError(activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(2), clientSecret: secret() }), 'revoked');
    await expectMachineError(renew(sql, config, deviceActor, g.licenseId, { productId: 'cursedelete', majorVersion: 2 }), 'revoked');
    await deactivate(sql, config, deviceActor, actId, { productId: 'cursedelete', majorVersion: 2, deviceId: device(1), clientSecret: s });
    const [a] = await sql<{ status: string }[]>`SELECT status FROM activations WHERE id = ${actId}`;
    expect(a!.status).toBe('inactive');
    await unrevokeEntitlement(sql, admin, g.licenseId, 'resolved');
    await renew(sql, config, deviceActor, g.licenseId, { productId: 'cursedelete', majorVersion: 2 });
  });

  it('subscription licence carries expiresAt; renewal keeps licenseId; expired => subscription_expired', async () => {
    const exp = new Date(Date.now() + 30 * 86400_000);
    const g = await grant('cd2-business-sub', { quantity: 4, expiresAt: exp });
    const r = await activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(1), clientSecret: secret() });
    const lic = await assertValid(r.license, 'repass-license-v1');
    expect(lic.perpetual).toBe(false);
    expect(lic.maxActivations).toBe(4);
    expect(lic.expiresAt).toBe(new Date(Math.floor(exp.getTime() / 1000) * 1000).toISOString().replace('.000', ''));
    // Simulate invoice.paid extension and check renew returns the new date with the same id.
    const newExp = new Date(exp.getTime() + 365 * 86400_000);
    await sql`UPDATE entitlements SET expires_at = ${newExp} WHERE id = ${g.entitlementId}`;
    const rn = await renew(sql, config, deviceActor, g.licenseId, { productId: 'cursedelete', majorVersion: 2 });
    const c2 = await assertValid(rn.license, 'repass-license-v1');
    expect(c2.licenseId).toBe(g.licenseId);
    expect(c2.expiresAt).toBe(newExp.toISOString().replace(/\.\d{3}Z$/, 'Z'));
    await sql`UPDATE entitlements SET expires_at = now() - interval '1 day' WHERE id = ${g.entitlementId}`;
    await expectMachineError(renew(sql, config, deviceActor, g.licenseId, { productId: 'cursedelete', majorVersion: 2 }), 'subscription_expired');
    await expectMachineError(activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(2), clientSecret: secret() }), 'subscription_expired');
  });

  it('never signs with a key that is not eligible: no eligible key => failure and no seat consumed', async () => {
    const g = await grant('cd2-business-3');
    await sql`UPDATE key_compatibilities SET eligible = false WHERE product_major_id = ${seeded.majorId}`;
    try {
      await expect(activate(sql, config, deviceActor, { productId: 'cursedelete', majorVersion: 2, activationKey: g.activationKey, deviceId: device(1), clientSecret: secret() })).rejects.toThrow(/No signing key is eligible/);
      const rows = await sql`SELECT 1 FROM activations WHERE license_id = ${g.licenseId}`;
      expect(rows.length).toBe(0);
    } finally {
      await sql`UPDATE key_compatibilities SET eligible = true WHERE product_major_id = ${seeded.majorId}`;
    }
  });

  it('audits machine calls without secrets', async () => {
    const rows = await sql<{ detail: unknown }[]>`SELECT detail FROM audit_events WHERE action LIKE 'machine.%' OR action LIKE 'activation.%'`;
    const blob = JSON.stringify(rows);
    expect(rows.length).toBeGreaterThan(10);
    expect(blob).not.toMatch(/[A-Za-z0-9_-]{43}/); // no client secrets
    expect(blob).not.toMatch(/[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}/); // no activation keys
  });
});
