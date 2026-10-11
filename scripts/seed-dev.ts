// DEVELOPMENT FIXTURES ONLY. Seeds a local database with the CurseDelete example catalogue and
// the PUBLIC test-vector signing keys (from LICENSING-SERVER-BRIEF.md §15.3). Refuses to run
// against a non-local host. Never run against staging/production.
//
//   DATABASE_URL=postgres://…@127.0.0.1/repass_dev SIGNING_KEK_V1=… APP_DATA_KEY_V1=… MACHINE_PEPPER=… node scripts/seed-dev.ts

import { readFileSync } from 'node:fs';
import type { SignatureAlgorithm } from '../src/crypto/algorithms.ts';
import { hexDecode } from '../src/lib/encoding.ts';
import * as catalogue from '../src/services/catalogue.ts';
import { importSigningKey, publishSigningKey, setKeyEligibility, setKeyTrust } from '../src/services/signing-keys.ts';
import { operatorDeps } from './lib/operator.ts';
import type { Actor } from '../src/services/actor.ts';

const url = new URL(process.env.DATABASE_URL ?? 'postgres://invalid');
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
  console.error('seed-dev only runs against a local database.');
  process.exit(1);
}
const vectors = JSON.parse(readFileSync(new URL('../tests/fixtures/v1-test-vectors.json', import.meta.url), 'utf8')) as { keys: Array<{ keyId: string; algorithm: SignatureAlgorithm; testOnlyPrivateSeedHex: string }> };
const { sql, config } = operatorDeps();
const all = ['products:read', 'products:write', 'prices:read', 'prices:write', 'signing_keys:manage', 'signing_keys:read_public'];
const actor: Actor = { type: 'admin', id: 'adm_seed', label: 'seed-dev', permissions: new Set(all), mfaAt: new Date() };
try {
  const exists = await sql`SELECT 1 FROM products WHERE slug = 'cursedelete'`;
  if (exists.length) {
    console.log('Already seeded.');
  } else {
    const p = await catalogue.createProduct(sql, actor, { slug: 'cursedelete', name: 'CurseDelete', description: 'Secure deletion (development fixture)' });
    await catalogue.updateProduct(sql, actor, p.id, { status: 'active' });
    const m = await catalogue.createMajor(sql, actor, { productId: p.id, majorVersion: 2, protocolId: 'repass-v1', defaultTransferAllowance: 3 });
    await catalogue.updateMajor(sql, actor, m.id, { status: 'active' });
    await catalogue.upsertRelease(sql, actor, { productMajorId: m.id, version: '2.1.0', status: 'shipped', isMinimumSupported: true });
    const ep: Record<string, string> = {};
    for (const [ed, model, own] of [['community', 'none', 'individual'], ['education', 'none', 'institution'], ['business', 'device_seats', 'organisation'], ['enterprise', 'none', 'organisation']] as const) {
      ep[ed] = (await catalogue.upsertEditionPolicy(sql, actor, { productMajorId: m.id, editionId: ed, displayName: ed[0]!.toUpperCase() + ed.slice(1), activationModel: model, ownership: own })).id;
    }
    for (const k of vectors.keys.filter((x) => x.keyId !== 'vector-p256')) {
      await importSigningKey(sql, config.signingKeks, actor, { keyId: k.keyId, algorithm: k.algorithm, privateKey: hexDecode(k.testOnlyPrivateSeedHex), origin: 'test_vector', notes: 'PUBLIC TEST VECTOR — development only' });
      await publishSigningKey(sql, actor, k.keyId);
      await setKeyTrust(sql, actor, { keyId: k.keyId, productMajorId: m.id, trustedSinceVersion: '2.1.0' });
      await setKeyEligibility(sql, actor, { keyId: k.keyId, productMajorId: m.id, eligible: true });
    }
    await catalogue.createOffer(sql, actor, { sku: 'cd2-community', name: 'CurseDelete 2 Community registration', kind: 'single', billing: 'free', components: [{ editionPolicyId: ep.community, termType: 'perpetual' }] });
    await catalogue.createOffer(sql, actor, { sku: 'cd2-business-annual', name: 'CurseDelete 2 Business (annual, per seat)', kind: 'single', billing: 'recurring', maxQuantity: 100, components: [{ editionPolicyId: ep.business, termType: 'subscription', seatsPerUnit: 1, quantityScalesSeats: true }] });
    await catalogue.createOffer(sql, actor, { sku: 'cd2-enterprise', name: 'CurseDelete 2 Enterprise (perpetual)', kind: 'single', billing: 'one_time', components: [{ editionPolicyId: ep.enterprise, termType: 'perpetual' }] });
    console.log('Seeded development catalogue (offers are drafts: add prices, sync to Stripe test mode, activate).');
  }
} finally {
  await sql.end();
}
