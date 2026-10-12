// Test fixtures. Uses the PUBLIC test-vector seeds for signing keys (never for production).
import { readFileSync } from 'node:fs';
import { loadConfig, type Config, type Env } from '../../src/config.ts';
import type { SignatureAlgorithm } from '../../src/crypto/algorithms.ts';
import type { Sql } from '../../src/db/client.ts';
import { base64Encode, hexDecode } from '../../src/lib/encoding.ts';
import type { Actor } from '../../src/services/actor.ts';
import * as catalogue from '../../src/services/catalogue.ts';
import { createCustomer } from '../../src/services/customers.ts';
import { importSigningKey, publishSigningKey, setKeyEligibility, setKeyTrust } from '../../src/services/signing-keys.ts';

export const VECTORS = JSON.parse(readFileSync(new URL('../fixtures/v1-test-vectors.json', import.meta.url), 'utf8')) as {
  keys: Array<{ keyId: string; algorithm: SignatureAlgorithm; testOnlyPrivateSeedHex: string; publicKey: string }>;
};

const rnd32 = () => base64Encode(crypto.getRandomValues(new Uint8Array(32)));

export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    PUBLIC_BASE_URL: 'http://localhost:8787',
    MAIL_FROM_EMAIL: 'licensing@example.test',
    MAIL_FROM_NAME: 'Test',
    SUPPORT_EMAIL: 'support@example.test',
    STRIPE_API_VERSION: '2026-09-30.endive',
    SIGNING_KEK_ACTIVE_VERSION: '1',
    APP_DATA_KEY_ACTIVE_VERSION: '1',
    MAIL_TRANSPORT: 'capture',
    SIGNING_KEK_V1: rnd32(),
    APP_DATA_KEY_V1: rnd32(),
    MACHINE_PEPPER: rnd32(),
    AUTH_PEPPER: rnd32(),
    API_TOKEN_PEPPER: rnd32(),
    STRIPE_SECRET_KEY: 'sk_test_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_' + rnd32(),
    ...overrides,
  };
}

export function testConfig(overrides: Partial<Env> = {}): { env: Env; config: Config } {
  const env = testEnv(overrides);
  return { env, config: loadConfig(env) };
}

const ALL = [
  'products:read', 'products:write', 'prices:read', 'prices:write', 'stripe:sync', 'customers:read', 'customers:write',
  'entitlements:read', 'entitlements:issue', 'entitlements:revoke', 'licenses:read', 'licenses:issue', 'licenses:renew',
  'activations:read', 'activations:release', 'transfers:write', 'subscriptions:read', 'subscriptions:manage', 'checkouts:read',
  'signing_keys:read_public', 'signing_keys:manage', 'email:read', 'email:retry', 'email:templates', 'webhooks:read',
  'webhooks:reconcile', 'audit:read', 'tokens:manage', 'admins:manage',
];

export function superActor(): Actor {
  return { type: 'admin', id: 'adm_test', label: 'test-admin', permissions: new Set(ALL), mfaAt: new Date() };
}

export const deviceActor: Actor = { type: 'device', id: null, label: 'device' };

export interface SeededProduct {
  productId: string;
  majorId: string;
  editions: Record<string, string>; // wire id -> edition policy id
}

/** Product + major + the four v1 editions + shipped minimum release + eligible vector keys. */
export async function seedProduct(sql: Sql, config: Config, actor: Actor, slug = 'cursedelete', major = 2, keys: string[] = ['vector-ed25519', 'vector-mldsa65']): Promise<SeededProduct> {
  const p = await catalogue.createProduct(sql, actor, { slug, name: slug.toUpperCase() });
  const m = await catalogue.createMajor(sql, actor, { productId: p.id, majorVersion: major, protocolId: 'repass-v1', defaultTransferAllowance: 3 });
  await catalogue.updateProduct(sql, actor, p.id, { status: 'active' });
  await catalogue.updateMajor(sql, actor, m.id, { status: 'active' });
  await catalogue.upsertRelease(sql, actor, { productMajorId: m.id, version: `${major}.1.0`, status: 'shipped', isMinimumSupported: true });
  const editions: Record<string, string> = {};
  for (const [ed, model, own] of [
    ['community', 'none', 'individual'],
    ['education', 'none', 'institution'],
    ['business', 'device_seats', 'organisation'],
    ['enterprise', 'none', 'organisation'],
  ] as const) {
    const ep = await catalogue.upsertEditionPolicy(sql, actor, { productMajorId: m.id, editionId: ed, displayName: ed[0]!.toUpperCase() + ed.slice(1), activationModel: model, ownership: own });
    editions[ed] = ep.id;
  }
  for (const keyId of keys) {
    const v = VECTORS.keys.find((k) => k.keyId === keyId)!;
    const existing = await sql`SELECT 1 FROM signing_keys WHERE id = ${keyId}`;
    if (!existing.length) {
      await importSigningKey(sql, config.signingKeks, actor, { keyId, algorithm: v.algorithm, privateKey: hexDecode(v.testOnlyPrivateSeedHex), origin: 'test_vector' });
      await publishSigningKey(sql, actor, keyId);
    }
    await setKeyTrust(sql, actor, { keyId, productMajorId: m.id, trustedSinceVersion: `${major}.1.0` });
    await setKeyEligibility(sql, actor, { keyId, productMajorId: m.id, eligible: true });
  }
  return { productId: p.id, majorId: m.id, editions };
}

export async function makeOffer(sql: Sql, actor: Actor, sku: string, components: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return catalogue.createOffer(sql, actor, { sku, name: sku, kind: components.length > 1 ? 'bundle' : 'single', billing: 'one_time', components, ...extra });
}

export async function makeCustomer(sql: Sql, actor: Actor, kind: 'individual' | 'organisation' = 'organisation', email = `buyer-${Math.random().toString(36).slice(2)}@example.test`) {
  return createCustomer(sql, actor, { kind, displayName: kind === 'organisation' ? 'Example Pty Ltd' : 'Jane Citizen', organisationName: kind === 'organisation' ? 'Example Pty Ltd' : null, billingEmail: email });
}
