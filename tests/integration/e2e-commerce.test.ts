// End-to-end through the real HTTP stack + real PostgreSQL, with Stripe/MailerSend TEST DOUBLES:
// admin API (PAT) builds catalogue -> Stripe sync -> DB-priced checkout -> verified webhook ->
// entitlement/licence/key -> MailerSend email -> portal login -> machine activation ->
// renewals, seat changes, refunds, disputes, cancellation, bundles, price changes, drift, outages.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/config.ts';
import { loadConfig, type Config } from '../../src/config.ts';
import { verifyEnvelope, type TrustedKey } from '../../src/crypto/envelope.ts';
import type { Sql } from '../../src/db/client.ts';
import { makeDeps } from '../../src/http/context.ts';
import { drainJobs } from '../../src/jobs/runner.ts';
import { base64UrlDecode, base64UrlEncode, hexDecode } from '../../src/lib/encoding.ts';
import { dispatchEmails } from '../../src/services/email.ts';
import { importSigningKey, publishSigningKey, usableSigningKeyIds } from '../../src/services/signing-keys.ts';
import { freshDatabase } from '../helpers/db.ts';
import { FakeMailerSend, FakeStripe } from '../helpers/fake-providers.ts';
import { superActor, testEnv, VECTORS } from '../helpers/fixtures.ts';
import { bootstrapAdminToken, Client, httpEnv } from '../helpers/http.ts';

let sql: Sql;
let drop: () => Promise<void>;
let env: Env;
let config: Config;
let stripe: FakeStripe;
let mail: FakeMailerSend;
let admin: Client;
let token: string;
const trusted: TrustedKey[] = VECTORS.keys.map((k) => ({ keyId: k.keyId, algorithm: k.algorithm, publicKey: base64UrlDecode(k.publicKey) }));
const secret = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
const device = (n: number) => n.toString(16).toUpperCase().padStart(64, 'A');
/** The 43-char secret part of rpl_(pat|svc)_<16>_<43> (the secret itself may contain '_'). */
const tokenSecret = (t: string) => /^rpl_(?:pat|svc)_[0-9A-Z]{16}_([A-Za-z0-9_-]{43})$/.exec(t)![1]!;

const ids: Record<string, string> = {};

async function api(method: string, path: string, json?: unknown, opts: { token?: string; idem?: string } = {}) {
  const res = await admin.request(`/api/admin/v1${path}`, { method, json, token: opts.token ?? token, headers: opts.idem ? { 'idempotency-key': opts.idem } : undefined });
  const body = res.status === 204 ? null : await res.json();
  return { status: res.status, body: body as any, res };
}

async function ok(method: string, path: string, json?: unknown) {
  const r = await api(method, path, json);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

async function drain() {
  const d = makeDeps(env);
  try {
    for (let i = 0; i < 10; i++) {
      const s = await drainJobs({ ...d, log: () => {} }, 10);
      if (s.done + s.retried + s.dead === 0) break;
    }
  } finally {
    await d.sql.end();
  }
}

async function sendMail() {
  const d = makeDeps(env);
  try {
    return await dispatchEmails(d.sql, d.config, d.mail, 20);
  } finally {
    await d.sql.end();
  }
}

async function webhook(type: string, object: Record<string, unknown>, opts: { id?: string; tamper?: boolean } = {}) {
  const ev = await stripe.event(type, object, { id: opts.id });
  const res = await admin.request('/webhooks/stripe', { method: 'POST', body: opts.tamper ? ev.body.replace('"livemode":false', '"livemode":false ') : ev.body, headers: { 'stripe-signature': ev.signature, 'content-type': 'application/json' } });
  return { res, id: ev.id, json: (await res.json()) as any };
}

const CURRENCIES = ['aud', 'usd', 'eur', 'gbp', 'cad', 'nzd', 'sgd', 'hkd', 'jpy', 'cny', 'chf'];

// Business name the store form sends per buyer (organisation editions require it).
const BUSINESS: Record<string, string> = { 'it@example.org': 'Example Org Pty Ltd', 'buyer@corp.example': 'Corp', 'suite@buyer.example': 'Suite Buyer Ltd', 'mailfail@buyer.example': 'MF' };

async function checkout(sku: string, email: string, quantity = 1, key = `ck_${Math.random().toString(36).slice(2)}aaaaaaaa`, extra: Record<string, string> = {}) {
  const shopper = new Client(env);
  const csrf = await shopper.csrfFrom('/store');
  const res = await shopper.request('/checkout', { method: 'POST', form: { _csrf: csrf, sku, currency: 'aud', quantity: String(quantity), email, idempotencyKey: key, unitAmount: '1',
    name: 'Jane Citizen', businessName: BUSINESS[email] ?? 'Buyer Org', country: 'AU', ...extra } });
  return { res, key, location: res.headers.get('location') ?? '' };
}

const sessionIdFrom = (loc: string) => loc.split('/').pop()!;
const checkoutIdOf = (sessionId: string) => stripe.sessions.get(sessionId)!.client_reference_id as string;

beforeAll(async () => {
  let url: string;
  ({ sql, drop, url } = await freshDatabase());
  const base = testEnv();
  stripe = await new FakeStripe(base.STRIPE_WEBHOOK_SECRET as string).start();
  mail = await new FakeMailerSend().start();
  env = httpEnv(url, { ...base, STRIPE_API_BASE: stripe.url, MAILERSEND_API_BASE: mail.url, MAIL_TRANSPORT: 'mailersend', MAILERSEND_API_TOKEN: 'mlsn.test', MAILERSEND_WEBHOOK_SECRET: 'mswhsec_test' });
  config = loadConfig(env);
  admin = new Client(env);
  // Test-vector signing keys are imported by the restricted operator path (not the API).
  for (const k of VECTORS.keys) {
    await importSigningKey(sql, config.signingKeks, superActor(), { keyId: k.keyId, algorithm: k.algorithm, privateKey: hexDecode(k.testOnlyPrivateSeedHex), origin: 'test_vector' });
    await publishSigningKey(sql, superActor(), k.keyId);
  }
  ({ token } = await bootstrapAdminToken(sql, config, ['products:read', 'products:write', 'prices:read', 'prices:write', 'stripe:sync', 'customers:read', 'customers:write', 'entitlements:read', 'entitlements:issue', 'entitlements:revoke', 'licenses:read', 'licenses:issue', 'activations:read', 'activations:release', 'transfers:write', 'subscriptions:read', 'subscriptions:manage', 'checkouts:read', 'signing_keys:read_public', 'signing_keys:manage', 'email:read', 'email:retry', 'webhooks:read', 'webhooks:reconcile', 'audit:read', 'tokens:manage']));
});

afterAll(async () => {
  await stripe?.stop();
  await mail?.stop();
  await drop?.();
});

describe('catalogue onboarding through the admin API (no redeploy, data only)', () => {
  it('creates products, majors, releases, editions, key trust and offers', async () => {
    const p = await ok('POST', '/products', { slug: 'cursedelete', name: 'CurseDelete' });
    ids.product = p.id;
    await ok('PATCH', `/products/${p.id}`, { status: 'active' });
    const m = await ok('POST', '/majors', { productId: 'cursedelete', majorVersion: 2, protocolId: 'repass-v1', defaultTransferAllowance: 3 });
    ids.major = m.id;
    await ok('PATCH', `/majors/${m.id}`, { status: 'active' });
    await ok('POST', `/majors/${m.id}/releases`, { version: '2.1.0', status: 'shipped', isMinimumSupported: true });
    for (const [ed, model, own] of [['community', 'none', 'individual'], ['education', 'none', 'institution'], ['business', 'device_seats', 'organisation'], ['enterprise', 'none', 'organisation']]) {
      const ep = await ok('PUT', `/majors/${m.id}/edition-policies/${ed}`, { displayName: ed, activationModel: model, ownership: own });
      ids[`ep_${ed}`] = ep.id;
    }
    // A protocol-incompatible edition policy is refused with an explanation (ADR-0001).
    const bad = await api('PUT', `/majors/${m.id}/edition-policies/education`, { displayName: 'Edu', activationModel: 'device_seats', ownership: 'institution' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('protocol_incompatible');

    // Keys: eligibility requires recorded trust by the minimum supported release.
    const early = await api('POST', '/signing-keys/vector-ed25519/eligibility', { productMajorId: m.id, eligible: true });
    expect(early.status).toBe(404);
    for (const k of ['vector-ed25519', 'vector-mldsa65']) {
      await ok('PUT', `/signing-keys/${k}/trust`, { productMajorId: m.id, trustedSinceVersion: '2.1.0' });
      await ok('POST', `/signing-keys/${k}/eligibility`, { productMajorId: m.id, eligible: true });
    }
    const tooNew = await ok('PUT', '/signing-keys/vector-p256/trust', { productMajorId: m.id, trustedSinceVersion: '2.5.0' });
    expect(tooNew.effectiveEligible).toBe(false);
    const refused = await api('POST', '/signing-keys/vector-p256/eligibility', { productMajorId: m.id, eligible: true });
    expect(refused.status).toBe(412);
    expect(refused.body.error.message).toMatch(/predates first trusting release/);

    // Generated keys never expose private material through the API.
    const gen = await ok('POST', '/signing-keys', { algorithm: 'ML-DSA-65', keyId: 'repass-mldsa65-2027' });
    expect(Object.keys(gen).sort()).toEqual(['algorithm', 'compromisedAt', 'createdAt', 'fingerprint', 'kekVersion', 'keyId', 'notes', 'origin', 'publicKey', 'publishedAt', 'retiredAt', 'status']);
    expect(base64UrlDecode(gen.publicKey).length).toBe(1952);
    const [secretRow] = await sql<{ n: number }[]>`SELECT octet_length(ciphertext) AS n FROM signing_key_secrets WHERE signing_key_id = 'repass-mldsa65-2027'`;
    expect(secretRow!.n).toBe(32);

    // A second product for bundles.
    const p2 = await ok('POST', '/products', { slug: 'otherapp', name: 'OtherApp' });
    await ok('PATCH', `/products/${p2.id}`, { status: 'active' });
    const m2 = await ok('POST', '/majors', { productId: p2.id, majorVersion: 1, protocolId: 'repass-v1' });
    await ok('PATCH', `/majors/${m2.id}`, { status: 'active' });
    await ok('POST', `/majors/${m2.id}/releases`, { version: '1.0.0', status: 'shipped', isMinimumSupported: true });
    ids.ep_other_ent = (await ok('PUT', `/majors/${m2.id}/edition-policies/enterprise`, { displayName: 'Enterprise', activationModel: 'none', ownership: 'organisation' })).id;
    await ok('PUT', '/signing-keys/vector-ed25519/trust', { productMajorId: m2.id, trustedSinceVersion: '1.0.0' });
    await ok('POST', '/signing-keys/vector-ed25519/eligibility', { productMajorId: m2.id, eligible: true });
  });

  it('stops reusing envelopes signed by a key the minimum supported release no longer trusts', async () => {
    const Rollback = new Error('rollback');
    const major = ids.major!;
    await sql.begin(async (tx) => {
      expect((await usableSigningKeyIds(tx, major)).sort()).toEqual(['vector-ed25519', 'vector-mldsa65']);
      // Compatibility row stays `eligible`, but the trust interval no longer covers the minimum release.
      await tx`UPDATE key_compatibilities SET trusted_until_version = '2.5.0' WHERE product_major_id = ${major} AND signing_key_id = 'vector-ed25519'`;
      await tx`UPDATE product_releases SET version = '2.6.0' WHERE product_major_id = ${major} AND is_minimum_supported`;
      expect(await usableSigningKeyIds(tx, major)).toEqual(['vector-mldsa65']);
      throw Rollback;
    }).catch((e) => { if (e !== Rollback) throw e; });
  });

  it('refuses offers a v1 client cannot verify, accepts per-product diversity', async () => {
    // Education subscription is not expressible in repass-v1.
    const r = await api('POST', '/offers', { sku: 'bad-edu-sub', name: 'x', kind: 'single', billing: 'recurring', components: [{ editionPolicyId: ids.ep_education, termType: 'subscription' }] });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toMatch(/non-perpetual education/);
    const offers: Array<[string, unknown]> = [
      ['cd2-business-annual', { name: 'Business annual per seat', kind: 'single', billing: 'recurring', maxQuantity: 100, components: [{ editionPolicyId: ids.ep_business, termType: 'subscription', seatsPerUnit: 1, quantityScalesSeats: true, graceDays: 0, transferAllowance: 1 }] }],
      ['cd2-community-reg', { name: 'Community registration', kind: 'single', billing: 'free', components: [{ editionPolicyId: ids.ep_community, termType: 'perpetual' }] }],
      ['cd2-enterprise', { name: 'Enterprise perpetual', kind: 'single', billing: 'one_time', components: [{ editionPolicyId: ids.ep_enterprise, termType: 'perpetual', refundAction: 'revoke' }] }],
      ['suite-enterprise', { name: 'Suite bundle', kind: 'bundle', billing: 'one_time', components: [{ editionPolicyId: ids.ep_enterprise, termType: 'perpetual' }, { editionPolicyId: ids.ep_other_ent, termType: 'perpetual' }] }],
    ];
    for (const [sku, o] of offers) ids[`offer_${sku}`] = (await ok('POST', '/offers', { sku, ...(o as object) })).id;
    // Activation is refused until a synced price exists.
    const early = await api('POST', `/offers/${ids['offer_cd2-enterprise']}/status`, { status: 'active' });
    expect(early.status).toBe(412);
  });

  it('links each offer to a product created in Stripe; never creates or renames Stripe products', async () => {
    const link = (offer: string, stripeProductId: string) => api('PUT', `/offers/${offer}/stripe-product`, { stripeProductId });
    expect((await link(ids['offer_cd2-enterprise']!, 'price_123')).status).toBe(422);
    const unknown = await link(ids['offer_cd2-enterprise']!, 'prod_doesnotexist');
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.message).toMatch(/does not exist in this Stripe account \(test mode\)/);
    const archived = stripe.createProductDirect('Old product', { active: false });
    expect((await link(ids['offer_cd2-enterprise']!, archived)).body.error.message).toMatch(/archived in Stripe/);
    for (const sku of ['cd2-business-annual', 'cd2-community-reg', 'cd2-enterprise', 'suite-enterprise']) {
      ids[`prod_${sku}`] = stripe.createProductDirect(`CurseDelete 2 ${sku}`);
      const r = await link(sku, ids[`prod_${sku}`]!); // by SKU
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ offerId: ids[`offer_${sku}`], stripeProductId: ids[`prod_${sku}`], stripeProductName: `CurseDelete 2 ${sku}` });
    }
    // One product per offer.
    const taken = await link(ids['offer_cd2-enterprise']!, ids['prod_cd2-business-annual']!);
    expect(taken.status).toBe(409);
    expect(taken.body.error.message).toMatch(/already linked to offer cd2-business-annual/);
    // Only repass_* metadata is written; Stripe keeps the name, description and image.
    const p = stripe.products.get(ids['prod_cd2-enterprise']!)!;
    expect(p).toMatchObject({ name: 'CurseDelete 2 cd2-enterprise', description: 'CurseDelete 2 cd2-enterprise description', active: true,
      metadata: { repass_offer_id: ids['offer_cd2-enterprise'], repass_sku: 'cd2-enterprise' } });
    expect((p.images as string[])[0]).toMatch(/^https:\/\/img\.example\.test\//);
    // Renaming the offer or verifying the product never renames it in Stripe.
    await ok('PATCH', `/offers/${ids['offer_cd2-enterprise']}`, { name: 'Enterprise perpetual (renamed)', description: 'db text' });
    expect((await ok('POST', '/stripe/sync', { offerId: ids['offer_cd2-enterprise'], wait: true })).stripeProductId).toBe(ids['prod_cd2-enterprise']);
    expect(stripe.products.get(ids['prod_cd2-enterprise']!)).toMatchObject({ name: 'CurseDelete 2 cd2-enterprise', description: 'CurseDelete 2 cd2-enterprise description' });
    await ok('PATCH', `/offers/${ids['offer_cd2-enterprise']}`, { name: 'Enterprise perpetual' });
    const audits = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM audit_events WHERE action = 'stripe.product_linked'`;
    expect(audits[0]!.n).toBe(4);
    expect(stripe.requests.filter((r) => r.method === 'POST' && r.path === '/v1/products').length).toBe(0);
  });

  it('sets prices in every store currency in the database (no Stripe prices), then activates offers', async () => {
    // Zero price is refused for paid offers; unsupported currencies are refused.
    expect((await api('POST', '/prices', { offerId: ids['offer_cd2-enterprise'], currency: 'aud', unitAmount: 0 })).status).toBe(422);
    expect((await api('POST', '/prices', { offerId: ids['offer_cd2-enterprise'], currency: 'xyz', unitAmount: 100 })).status).toBe(422);
    // An offer is not sellable until every currency has a price.
    await ok('POST', `/offers/${ids['offer_cd2-enterprise']}/prices`, { prices: [{ currency: 'AUD', unitAmount: 99900 }] });
    const early = await api('POST', `/offers/${ids['offer_cd2-enterprise']}/status`, { status: 'active' });
    expect(early.status).toBe(412);
    expect(early.body.error.message).toMatch(/missing USD, EUR, GBP, CAD, NZD, SGD, HKD, JPY, CNY, CHF/);
    const offers: Array<[string, number, string | null]> = [['cd2-business-annual', 4900, 'year'], ['cd2-community-reg', 0, null], ['cd2-enterprise', 99900, null], ['suite-enterprise', 149900, null]];
    for (const [sku, amount, interval] of offers) {
      const set = await ok('POST', `/offers/${ids[`offer_${sku}`]}/prices`, { recurringInterval: interval, prices: CURRENCIES.filter((c) => !(sku === 'cd2-enterprise' && c === 'aud')).map((c) => ({ currency: c, unitAmount: amount })) });
      expect(set.missingCurrencies).toEqual([]);
      ids[`price_${sku}`] = sku === 'cd2-enterprise' ? (await sql<{ id: string }[]>`SELECT id FROM price_versions WHERE offer_id = ${ids['offer_cd2-enterprise']!} AND currency = 'aud'`)[0]!.id
        : set.prices.find((p: any) => p.currency === 'aud').id;
      await ok('POST', `/offers/${ids[`offer_${sku}`]}/status`, { status: 'active' });
    }
    // Prices are never Stripe objects.
    expect(stripe.requests.filter((r) => r.path === '/v1/prices').length).toBe(0);
    // Immutable price history: amount changes are rejected at the database level.
    await expect(sql`UPDATE price_versions SET unit_amount = 1 WHERE id = ${ids['price_cd2-enterprise']!}`).rejects.toThrow(/immutable/);
  });
});

describe('server-created checkout and verified fulfilment', () => {
  it('builds Checkout only from DB prices, is idempotent, and the success redirect proves nothing', async () => {
    const c1 = await checkout('cd2-business-annual', 'it@example.org', 3, 'ck_business_aaaaaaaaaaaa');
    expect(c1.res.status).toBe(303);
    expect(c1.location).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const sid = sessionIdFrom(c1.location);
    ids.bizSession = sid;
    const sent = stripe.requests.filter((r) => r.path === '/v1/checkout/sessions');
    expect(sent.length).toBe(1);
    const p = sent[0]!.params as any;
    // The amount is sent inline from the database price version, against the offer's Stripe product.
    expect(p.line_items[0]).toEqual({ price_data: { currency: 'aud', unit_amount: '4900', product: ids['prod_cd2-business-annual'], recurring: { interval: 'year', interval_count: '1' } }, quantity: '3' });
    const [chk] = await sql<{ stripe_product_id: string }[]>`SELECT stripe_product_id FROM checkouts WHERE stripe_checkout_session_id = ${sid}`;
    expect(chk!.stripe_product_id).toBe(ids['prod_cd2-business-annual']);
    expect(stripe.requests.filter((r) => r.method === 'POST' && r.path === '/v1/products').length).toBe(0);
    expect(p.mode).toBe('subscription');
    expect(p.customer).toMatch(/^cus_/);
    expect(p.customer_email).toBeUndefined();
    expect(p.success_url).toMatch(/\/checkout\/chk_.*\/return\?session_id=\{CHECKOUT_SESSION_ID\}$/);
    // Same idempotency key -> same session, no new Stripe session.
    const c2 = await checkout('cd2-business-annual', 'it@example.org', 3, 'ck_business_aaaaaaaaaaaa');
    expect(c2.location).toBe(c1.location);
    expect(stripe.requests.filter((r) => r.path === '/v1/checkout/sessions').length).toBe(1);
    // Visiting the success URL does not issue anything.
    const shopper = new Client(env);
    const ret = await shopper.request(`/checkout/${checkoutIdOf(sid)}/return?session_id=${sid}`);
    expect(await ret.text()).toMatch(/waiting for confirmation/);
    expect((await sql`SELECT 1 FROM entitlements`).length).toBe(0);
  });

  it('rejects bad signatures, stores verified events once, fulfils exactly once', async () => {
    // Relinking the offer while this session is open does not quarantine it: the checkout
    // recorded the product it was opened against.
    const replacement = stripe.createProductDirect('CurseDelete 2 Business (new artwork)');
    await ok('PUT', `/offers/${ids['offer_cd2-business-annual']}/stripe-product`, { stripeProductId: replacement });
    stripe.completeSession(ids.bizSession!, { name: 'Ann Admin', businessName: 'Example Org Pty Ltd', email: 'it@example.org' });
    const bad = await webhook('checkout.session.completed', stripe.publicSession(ids.bizSession!), { tamper: true });
    expect(bad.res.status).toBe(400);
    const good = await webhook('checkout.session.completed', stripe.publicSession(ids.bizSession!));
    expect(good.json.status).toBe('stored');
    const dup = await admin.request('/webhooks/stripe', { method: 'POST', body: (await stripe.event('x', {}, { id: good.id })).body.replace('"type":"x"', '"type":"checkout.session.completed"'), headers: { 'stripe-signature': 'bogus' } });
    expect(dup.status).toBe(400);
    await drain();
    // Replay of the same verified event id is a no-op.
    const ev = await stripe.event('checkout.session.completed', stripe.publicSession(ids.bizSession!), { id: good.id });
    const again = await admin.request('/webhooks/stripe', { method: 'POST', body: ev.body, headers: { 'stripe-signature': ev.signature } });
    expect(((await again.json()) as any).status).toBe('duplicate');
    // A different event for the same session (e.g. Stripe resends as async success) is also a no-op.
    await webhook('checkout.session.async_payment_succeeded', stripe.publicSession(ids.bizSession!));
    await drain();
    const ents = await sql<{ seats: number; expires_at: Date; term_type: string; organisation_name: string }[]>`SELECT seats, expires_at, term_type, organisation_name FROM entitlements`;
    expect(ents.length).toBe(1);
    expect(ents[0]!.seats).toBe(3);
    expect(ents[0]!.term_type).toBe('subscription');
    expect(ents[0]!.organisation_name).toBe('Example Org Pty Ltd');
    const sub = [...stripe.subscriptions.values()][0]!;
    expect(Math.floor(ents[0]!.expires_at.getTime() / 1000)).toBe(sub.items.data[0].current_period_end);
    const [purchase] = await sql<{ amount_total: number; currency: string }[]>`SELECT amount_total, currency FROM purchases`;
    expect(purchase).toMatchObject({ amount_total: 14700, currency: 'aud' });
  });

  it('emails through MailerSend with retry on 429 and records the provider id', async () => {
    mail.queue.push({ status: 429, retryAfter: 1 });
    const first = await sendMail();
    expect(first.failed).toBeGreaterThanOrEqual(1);
    await sql`UPDATE email_outbox SET next_attempt_at = now() WHERE status = 'failed'`;
    const second = await sendMail();
    expect(second.sent).toBeGreaterThanOrEqual(1);
    const msg = mail.sent.find((m) => /licence is ready/.test(m.subject))!;
    expect(msg.from.email).toBe('licensing@example.test');
    expect(msg.to[0].email).toBe('it@example.org');
    expect(msg.html).toContain('<table');
    ids.bizKey = /Activation key: ([0-9A-Z-]{35})/.exec(msg.text)![1]!;
    const [row] = await sql<{ status: string; provider_message_id: string; payload: boolean }[]>`SELECT status, provider_message_id, payload_ciphertext IS NOT NULL AS payload FROM email_outbox WHERE template_key = 'purchase_confirmation'`;
    expect(row).toMatchObject({ status: 'sent', payload: false });
    expect(row!.provider_message_id).toMatch(/^ms_/);
    // A retried webhook never produces a second purchase email.
    expect((await sql`SELECT 1 FROM email_outbox WHERE template_key = 'purchase_confirmation'`).length).toBe(1);
  });

  it('machine API over HTTP: activation with the emailed key, seat limit, renew, deactivate', async () => {
    const dev = new Client(env);
    const acts: Array<{ id: string; secret: string; device: string }> = [];
    for (let i = 1; i <= 3; i++) {
      const s = secret();
      const r = await dev.request('/v1/activations', { method: 'POST', json: { productId: 'cursedelete', majorVersion: 2, activationKey: ids.bizKey, deviceId: device(i), clientSecret: s } });
      expect(r.status).toBe(200);
      const b = (await r.json()) as any;
      const lic = await verifyEnvelope(JSON.stringify(b.license), 'repass-license-v1', trusted);
      const cert = await verifyEnvelope(JSON.stringify(b.activation), 'repass-activation-v1', trusted);
      expect(lic.ok && cert.ok).toBe(true);
      if (lic.ok) expect(lic.claims).toMatchObject({ edition: 'business', maxActivations: 3, perpetual: false, organisation: 'Example Org Pty Ltd' });
      if (cert.ok) acts.push({ id: cert.claims.activationId as string, secret: s, device: device(i) });
      ids.licenseId = lic.ok ? (lic.claims.licenseId as string) : '';
    }
    const full = await dev.request('/v1/activations', { method: 'POST', json: { productId: 'cursedelete', majorVersion: 2, activationKey: ids.bizKey, deviceId: device(9), clientSecret: secret() } });
    expect(full.status).toBe(409);
    expect(await full.json()).toEqual({ error: 'seat_limit', message: expect.any(String) });
    const malformed = await dev.request('/v1/activations', { method: 'POST', json: { productId: 'cursedelete' } });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as any).error).toBe('invalid_request');
    const rn = await dev.request(`/v1/licenses/${ids.licenseId}/renew`, { method: 'POST', json: { productId: 'cursedelete', majorVersion: 2, activation: { activationId: acts[0]!.id, deviceId: acts[0]!.device, clientSecret: acts[0]!.secret } } });
    expect(rn.status).toBe(200);
    const de = await dev.request(`/v1/activations/${acts[2]!.id}/deactivate`, { method: 'POST', json: { productId: 'cursedelete', majorVersion: 2, deviceId: acts[2]!.device, clientSecret: acts[2]!.secret } });
    expect(de.status).toBe(204);
    ids.act0 = acts[0]!.id;
    ids.act0secret = acts[0]!.secret;
  });

  it('invoice.paid renewal extends once, monotonically, keeping the licence id', async () => {
    const subId = [...stripe.subscriptions.keys()][0]!;
    const [before] = await sql<{ expires_at: Date }[]>`SELECT expires_at FROM entitlements`;
    const inv = stripe.renewSubscription(subId, 365);
    await webhook('invoice.paid', inv);
    await webhook('invoice.paid', inv); // second delivery, different event id
    await drain();
    const [after] = await sql<{ expires_at: Date }[]>`SELECT expires_at FROM entitlements`;
    expect(Math.floor(after!.expires_at.getTime() / 1000)).toBe(inv.lines.data[0]!.period.end);
    expect(after!.expires_at.getTime() - before!.expires_at.getTime()).toBe(365 * 86400_000);
    // An old invoice processed late cannot shorten the entitlement.
    const old = [...stripe.invoices.values()][0]!;
    await webhook('invoice.paid', old);
    await drain();
    const [still] = await sql<{ expires_at: Date }[]>`SELECT expires_at FROM entitlements`;
    expect(still!.expires_at.getTime()).toBe(after!.expires_at.getTime());
    // Each renewal charge gets one paid invoice and a receipt email with it attached (the first
    // charge was covered by the purchase invoice).
    const renewals = await sql<{ id: string; total: number }[]>`SELECT id, total FROM customer_invoices WHERE kind = 'renewal'`;
    expect(renewals).toEqual([{ id: expect.stringMatching(/^cin_/), total: 1000 }]);
    expect((await sql`SELECT 1 FROM customer_invoices WHERE stripe_invoice_id = ${old.id}`).length).toBe(0);
    await sendMail();
    const receipt = mail.sent.find((m) => /^Receipt TEST-RPL-\d{7}: /.test(m.subject))!;
    expect(receipt.attachments).toEqual([{ filename: expect.stringMatching(/^TEST-RPL-\d{7}\.pdf$/), content: expect.any(String), disposition: 'attachment' }]);
    const dev = new Client(env);
    const r = (await (await dev.request(`/v1/licenses/${ids.licenseId}/renew`, { method: 'POST', json: { productId: 'cursedelete', majorVersion: 2 } })).json()) as any;
    const v = await verifyEnvelope(JSON.stringify(r.license), 'repass-license-v1', trusted);
    expect(v.ok && v.claims.licenseId).toBe(ids.licenseId);
    expect(v.ok && v.claims.expiresAt).toBe(after!.expires_at.toISOString().replace(/\.\d{3}Z$/, 'Z'));
  });

  it('subscription quantity change updates seats with an audited snapshot; cancellation never revokes', async () => {
    const subId = [...stripe.subscriptions.keys()][0]!;
    stripe.subscriptions.get(subId)!.items.data[0].quantity = 5;
    await webhook('customer.subscription.updated', stripe.subscriptions.get(subId)!);
    await drain();
    expect((await sql<{ seats: number }[]>`SELECT seats FROM entitlements`)[0]!.seats).toBe(5);
    stripe.subscriptions.get(subId)!.status = 'canceled';
    stripe.subscriptions.get(subId)!.ended_at = Math.floor(Date.now() / 1000);
    await webhook('customer.subscription.deleted', stripe.subscriptions.get(subId)!);
    await drain();
    const [e] = await sql<{ status: string }[]>`SELECT status FROM entitlements`;
    expect(e!.status).toBe('active');
    expect((await sql`SELECT 1 FROM email_outbox WHERE template_key = 'subscription_cancelled'`).length).toBe(1);
  });

  it('dispute on the subscription payment follows product policy (review)', async () => {
    const inv = [...stripe.invoices.values()][0]!;
    const charge = stripe.charges.get(`ch_for_${inv._payment_intent}`)!;
    const dispute = { id: 'dp_test_1', object: 'dispute', charge: charge.id, payment_intent: charge.payment_intent, status: 'needs_response', reason: 'fraudulent' };
    stripe.disputes.set(dispute.id, dispute);
    await webhook('charge.dispute.created', dispute);
    await drain();
    const [e] = await sql<{ status: string; review_required: boolean }[]>`SELECT status, review_required FROM entitlements`;
    expect(e).toMatchObject({ status: 'active', review_required: true });
    // Support decides to keep the licence: the flag is cleared with an audited amendment.
    await ok('POST', `/licenses/${ids.licenseId}/amend`, { clearReview: true, reason: 'dispute evidence submitted' });
    expect((await sql<{ review_required: boolean }[]>`SELECT review_required FROM entitlements`)[0]!.review_required).toBe(false);
  });
});

describe('free registration, async payment, refunds, bundles', () => {
  it('$0 community registration issues a perpetual licence without device tracking', async () => {
    const c = await checkout('cd2-community-reg', 'jane@example.net');
    const sid = sessionIdFrom(c.location);
    stripe.completeSession(sid, { name: 'Jane Citizen', email: 'jane@example.net' });
    await webhook('checkout.session.completed', stripe.publicSession(sid));
    await drain();
    const [e] = await sql<{ term_type: string; customer_name: string; seats: number | null }[]>`
      SELECT e.term_type, e.customer_name, e.seats FROM entitlements e JOIN product_edition_policies ep ON ep.id = e.edition_policy_id WHERE ep.edition_id = 'community'`;
    expect(e).toMatchObject({ term_type: 'perpetual', customer_name: 'Jane Citizen', seats: null });
  });

  it('asynchronous payment: no entitlement until async success; failure never grants', async () => {
    const c = await checkout('cd2-enterprise', 'buyer@corp.example');
    const sid = sessionIdFrom(c.location);
    stripe.completeSession(sid, { paymentStatus: 'unpaid', businessName: 'Corp', email: 'buyer@corp.example' });
    await webhook('checkout.session.completed', stripe.publicSession(sid));
    await drain();
    const chk = checkoutIdOf(sid);
    expect((await sql<{ status: string }[]>`SELECT status FROM checkouts WHERE id = ${chk}`)[0]!.status).toBe('awaiting_payment');
    expect((await sql`SELECT 1 FROM purchases WHERE checkout_id = ${chk}`).length).toBe(0);
    stripe.sessions.get(sid)!.payment_status = 'paid';
    await webhook('checkout.session.async_payment_succeeded', stripe.publicSession(sid));
    await drain();
    expect((await sql`SELECT 1 FROM purchases WHERE checkout_id = ${chk}`).length).toBe(1);
    ids.entSession = sid;
  });

  it('full refund revokes per policy; activation then returns revoked; duplicate refund is a no-op', async () => {
    const s = stripe.sessions.get(ids.entSession!)!;
    const charge = stripe.charges.get(`ch_for_${s.payment_intent}`)!;
    charge.refunded = true;
    charge.amount_refunded = charge.amount;
    await webhook('charge.refunded', charge);
    await webhook('charge.refunded', charge);
    await drain();
    const rows = await sql<{ status: string }[]>`SELECT e.status FROM entitlements e JOIN purchases p ON p.customer_id = e.customer_id JOIN checkouts c ON c.id = p.checkout_id WHERE c.stripe_checkout_session_id = ${ids.entSession!}`;
    expect(rows.map((r) => r.status)).toEqual(['revoked']);
    expect((await sql`SELECT 1 FROM revocations WHERE source = 'stripe_refund'`).length).toBe(1);
    const [p] = await sql<{ status: string }[]>`SELECT status FROM purchases WHERE stripe_payment_intent_id = ${s.payment_intent}`;
    expect(p!.status).toBe('refunded');
  });

  it('bundle purchase yields one licence per component product (never multi-product)', async () => {
    const c = await checkout('suite-enterprise', 'suite@buyer.example');
    const sid = sessionIdFrom(c.location);
    stripe.completeSession(sid, { businessName: 'Suite Buyer Ltd', email: 'suite@buyer.example' });
    await webhook('checkout.session.completed', stripe.publicSession(sid));
    await drain();
    const rows = await sql<{ slug: string }[]>`
      SELECT p.slug FROM entitlements e JOIN product_majors m ON m.id = e.product_major_id JOIN products p ON p.id = m.product_id
      JOIN purchase_lines pl ON pl.id = e.purchase_line_id JOIN purchases pu ON pu.id = pl.purchase_id JOIN checkouts c ON c.id = pu.checkout_id
      WHERE c.stripe_checkout_session_id = ${sid} ORDER BY p.slug`;
    expect(rows.map((r) => r.slug)).toEqual(['cursedelete', 'otherapp']);
  });
});

describe('pricing changes, drift and provider outages', () => {
  it('a new price version supersedes the old for new sales only', async () => {
    await ok('POST', `/offers/${ids['offer_cd2-enterprise']}/prices`, { prices: [{ currency: 'aud', unitAmount: 119900 }] });
    const c = await checkout('cd2-enterprise', 'new@buyer.example');
    const s = stripe.sessions.get(sessionIdFrom(c.location))!;
    expect(s.amount_subtotal).toBe(119900);
    // Historical purchases keep their recorded amounts.
    expect((await sql`SELECT 1 FROM purchase_lines WHERE unit_amount = 99900`).length).toBe(1);
  });

  it('an offer missing a price in any currency is hidden and cannot be bought', async () => {
    const [usd] = await sql<{ id: string }[]>`SELECT id FROM price_versions WHERE offer_id = ${ids['offer_cd2-community-reg']!} AND currency = 'usd' AND status = 'active'`;
    await ok('POST', `/prices/${usd!.id}/archive`);
    expect(await (await new Client(env).request('/store/products/cursedelete')).text()).not.toMatch(/cd2-community-reg/);
    expect((await checkout('cd2-community-reg', 'x@y.example')).res.status).toBe(412);
    await ok('POST', `/offers/${ids['offer_cd2-community-reg']}/prices`, { prices: [{ currency: 'usd', unitAmount: 0 }] });
    expect(await (await new Client(env).request('/store/products/cursedelete')).text()).toMatch(/cd2-community-reg/);
    expect((await checkout('cd2-community-reg', 'x@y.example')).res.status).toBe(303);
  });

  it('Stripe outage: checkout fails truthfully, retry with the same key succeeds', async () => {
    stripe.failNext(/POST \/v1\/checkout\/sessions/, 503, 1);
    const k = 'ck_outage_aaaaaaaaaaaaaaaa';
    const c1 = await checkout('cd2-enterprise', 'outage@buyer.example', 1, k);
    expect(c1.res.status).toBe(503);
    const c2 = await checkout('cd2-enterprise', 'outage@buyer.example', 1, k);
    expect(c2.res.status).toBe(303);
  });

  it('MailerSend outage never loses a paid entitlement; email retries later', async () => {
    await sendMail(); // flush mail queued by earlier steps
    const c = await checkout('cd2-enterprise', 'mailfail@buyer.example');
    const sid = sessionIdFrom(c.location);
    stripe.completeSession(sid, { businessName: 'MF', email: 'mailfail@buyer.example' });
    await webhook('checkout.session.completed', stripe.publicSession(sid));
    await drain();
    mail.queue.push({ status: 500 }, { status: 500 }, { status: 500 });
    const r = await sendMail();
    expect(r.sent).toBe(0);
    expect((await sql`SELECT 1 FROM purchases p JOIN checkouts c ON c.id = p.checkout_id WHERE c.stripe_checkout_session_id = ${sid}`).length).toBe(1);
    const [m] = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM email_outbox WHERE template_key = 'purchase_confirmation' ORDER BY created_at DESC LIMIT 1`;
    expect(m).toMatchObject({ status: 'failed', attempts: 1 });
    // The customer can still retrieve everything from the portal; the email retries with backoff.
    mail.queue.length = 0; // provider recovers
    await sql`UPDATE email_outbox SET next_attempt_at = now() WHERE status = 'failed'`;
    expect((await sendMail()).sent).toBeGreaterThanOrEqual(1);
  });
});

describe('customer portal and realm separation', () => {
  let portal: Client;
  it('passwordless login: link email -> confirm POST -> session', async () => {
    portal = new Client(env);
    const csrf = await portal.csrfFrom('/portal/login');
    await portal.request('/portal/login', { method: 'POST', form: { _csrf: csrf, email: 'it@example.org' } });
    // The sign-in link is dispatched immediately after the response, not on the next cron tick.
    expect(mail.sent.some((m) => /sign-in link/.test(m.subject) && m.to[0].email === 'it@example.org')).toBe(true);
    // A new email address gets a link; the account is created unverified and has no customers.
    await portal.request('/portal/login', { method: 'POST', form: { _csrf: csrf, email: 'Newcomer@Example.net' } });
    await sendMail();
    const msg = [...mail.sent].reverse().find((m) => /sign-in link/.test(m.subject) && m.to[0].email === 'it@example.org')!;
    expect(mail.sent.some((m) => /sign-in link/.test(m.subject) && m.to[0].email === 'newcomer@example.net')).toBe(true);
    const [nu] = await sql<{ email_verified_at: Date | null; n: number }[]>`
      SELECT u.email_verified_at, (SELECT count(*)::int FROM customer_members m WHERE m.portal_user_id = u.id) AS n FROM portal_users u WHERE u.email = 'newcomer@example.net'`;
    expect(nu).toMatchObject({ email_verified_at: null, n: 0 });
    // Disabled accounts get nothing.
    await sql`INSERT INTO portal_users (id, email, status) VALUES ('usr_disabled_test', 'disabled@example.net', 'disabled')`;
    await portal.request('/portal/login', { method: 'POST', form: { _csrf: csrf, email: 'disabled@example.net' } });
    await sendMail();
    expect(mail.sent.some((m) => m.to[0].email === 'disabled@example.net')).toBe(false);
    const link = new URL(/https?:\/\/\S+\/portal\/auth\/verify\?token=[A-Za-z0-9_-]+/.exec(msg.text)![0]);
    const page = await portal.request(link.pathname + link.search);
    expect(await page.text()).toMatch(/Continue signing in/); // GET does not consume
    const csrf2 = await portal.csrfFrom(link.pathname + link.search);
    const res = await portal.request('/portal/auth/verify', { method: 'POST', form: { _csrf: csrf2, token: link.searchParams.get('token')! } });
    expect(res.status).toBe(303);
    // Single use.
    const reuse = await new Client(env).request('/portal/auth/verify', { method: 'POST', form: { token: link.searchParams.get('token')! } });
    expect(reuse.status).toBe(401);
    const home = await (await portal.request('/portal')).text();
    expect(home).toContain(ids.licenseId);
    expect(home).toMatch(/Release device/);
    const file = await portal.request(`/portal/licenses/${ids.licenseId}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-disposition')).toMatch(/cursedelete-v2-business-lic_/);
  });

  it('customers cannot see other customers, admin pages, or the admin API', async () => {
    const [other] = await sql<{ license_id: string }[]>`
      SELECT l.id AS license_id FROM licenses l JOIN entitlements e ON e.id = l.entitlement_id JOIN customers c ON c.id = e.customer_id WHERE c.billing_email = 'jane@example.net'`;
    const r = await portal.request(`/portal/licenses/${other!.license_id}/file`);
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toMatch(/err=Licen/);
    expect((await portal.request('/admin')).headers.get('location')).toMatch(/^\/admin\/login/);
    expect((await portal.request('/api/admin/v1/me')).status).toBe(401);
    // Cross-site form posts are rejected.
    const xs = await portal.request(`/portal/licenses/${ids.licenseId}/rotate-key`, { method: 'POST', body: 'x=1', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' } });
    expect(xs.status).toBe(403);
    // Real browsers may send `Origin: null` on same-origin posts; Sec-Fetch-Site decides then.
    const anon = new Client(env);
    const form = { 'content-type': 'application/x-www-form-urlencoded', origin: 'null' };
    const nullSame = await anon.request('/portal/login', { method: 'POST', body: 'email=null-origin%40example.org', headers: { ...form, 'sec-fetch-site': 'same-origin' } });
    expect(nullSame.status).toBe(200);
    const nullCross = await anon.request('/portal/login', { method: 'POST', body: 'email=null-origin%40example.org', headers: { ...form, 'sec-fetch-site': 'cross-site' } });
    expect(nullCross.status).toBe(403);
    expect((await anon.request('/portal/login')).headers.get('referrer-policy')).toBe('same-origin');
    // Missing CSRF token is rejected even from the same origin.
    const noCsrf = await portal.request(`/portal/licenses/${ids.licenseId}/rotate-key`, { method: 'POST', form: { x: '1' } });
    expect(noCsrf.status).toBe(403);
  });

  it('portal device release reaches the device on its next renew', async () => {
    const csrf = await portal.csrfFrom('/portal');
    const r = await portal.request(`/portal/activations/${ids.act0}/release`, { method: 'POST', form: { _csrf: csrf } });
    expect(r.status).toBe(303);
    const dev = new Client(env);
    const rn = await dev.request(`/v1/licenses/${ids.licenseId}/renew`, { method: 'POST', json: { productId: 'cursedelete', majorVersion: 2, activation: { activationId: ids.act0, deviceId: device(1), clientSecret: ids.act0secret } } });
    expect(rn.status).toBe(409);
    expect(((await rn.json()) as any).error).toBe('activation_inactive');
    // The organisation is told about the release (security notification).
    expect((await sql`SELECT 1 FROM email_outbox WHERE business_key = ${'device_released:' + ids.act0}`).length).toBe(1);
  });

  it('daily tick queues a 7-day expiry notice for terms that will not auto-renew', async () => {
    await sql`UPDATE entitlements SET expires_at = now() + interval '6 days 12 hours' WHERE id = (SELECT entitlement_id FROM licenses WHERE id = ${ids.licenseId!})`;
    const { dailyTick } = await import('../../src/jobs/runner.ts');
    const d = makeDeps(env);
    try {
      const r = await dailyTick({ ...d, log: () => {} });
      expect(r.expiringReminders).toBeGreaterThanOrEqual(1);
      expect((await d.sql`SELECT 1 FROM email_outbox WHERE template_key = 'subscription_expiring'`).length).toBe(1);
      await dailyTick({ ...d, log: () => {} });
      expect((await d.sql`SELECT 1 FROM email_outbox WHERE template_key = 'subscription_expiring'`).length).toBe(1);
    } finally {
      await d.sql.end();
    }
  });
});

describe('admin API tokens: scopes, revocation, idempotency, audit', () => {
  it('authenticates only well-formed, active tokens and enforces scopes', async () => {
    expect((await api('GET', '/me', undefined, { token: 'nope' })).status).toBe(401);
    expect((await admin.request('/api/admin/v1/me')).status).toBe(401);
    const ro = await bootstrapAdminToken(sql, config, ['products:read'], { roles: ['auditor'] });
    expect((await api('GET', '/products', undefined, { token: ro.token })).status).toBe(200);
    const denied = await api('POST', '/products', { slug: 'x', name: 'x' }, { token: ro.token });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('forbidden');
    // Scope present but owner lost the role -> effective permission removed immediately.
    const sw = await bootstrapAdminToken(sql, config, ['products:write'], { roles: ['catalogue_manager'] });
    await sql`DELETE FROM admin_user_roles WHERE admin_user_id = ${sw.adminId}`;
    expect((await api('POST', '/products', { slug: 'y', name: 'y' }, { token: sw.token })).status).toBe(403);
    // Revocation and expiry.
    await sql`UPDATE admin_api_tokens SET revoked_at = now() WHERE id = ${ro.tokenId}`;
    expect((await api('GET', '/products', undefined, { token: ro.token })).status).toBe(401);
    const ex = await bootstrapAdminToken(sql, config, ['products:read']);
    await sql`UPDATE admin_api_tokens SET expires_at = now() - interval '1 second' WHERE id = ${ex.tokenId}`;
    expect((await api('GET', '/products', undefined, { token: ex.token })).status).toBe(401);
    // CIDR restriction.
    const cidr = await bootstrapAdminToken(sql, config, ['products:read'], { allowedCidrs: ['203.0.113.0/24'] });
    expect((await admin.request('/api/admin/v1/products', { token: cidr.token, ip: '198.51.100.7' })).status).toBe(403);
    expect((await admin.request('/api/admin/v1/products', { token: cidr.token, ip: '203.0.113.9' })).status).toBe(200);
  });

  it('creates service-account tokens once, hashes them, rotates and revokes', async () => {
    const sa = await api('POST', '/service-accounts', { name: 'ci-catalogue', allowedScopes: ['products:read'] });
    expect(sa.status).toBe(403); // token lacks admins:manage
    const root = await bootstrapAdminToken(sql, config, ['admins:manage', 'tokens:manage', 'products:read']);
    const created = await api('POST', '/service-accounts', { name: 'ci-catalogue', allowedScopes: ['products:read'] }, { token: root.token });
    expect(created.status).toBe(201);
    const t = await api('POST', '/tokens', { name: 'ci', serviceAccountId: created.body.id, scopes: ['products:read'], expiresInDays: 7 }, { token: root.token });
    expect(t.status).toBe(201);
    expect(t.body.token).toMatch(/^rpl_svc_[0-9A-Z]{16}_[A-Za-z0-9_-]{43}$/);
    const [row] = await sql<{ secret_hash: Uint8Array }[]>`SELECT secret_hash FROM admin_api_tokens WHERE id = ${t.body.id}`;
    expect(Buffer.from(row!.secret_hash).toString()).not.toContain(tokenSecret(t.body.token));
    expect((await api('GET', '/products', undefined, { token: t.body.token })).status).toBe(200);
    expect((await api('POST', '/tokens', { name: 'esc', serviceAccountId: created.body.id, scopes: ['products:write'] }, { token: root.token })).status).toBe(403);
    const rotated = await api('POST', `/tokens/${t.body.id}/rotate`, {}, { token: root.token });
    expect(rotated.status).toBe(201);
    expect((await api('GET', '/products', undefined, { token: t.body.token })).status).toBe(401);
    expect((await api('GET', '/products', undefined, { token: rotated.body.token })).status).toBe(200);
    const listed = await api('GET', '/tokens', undefined, { token: root.token });
    expect(JSON.stringify(listed.body)).not.toContain(tokenSecret(rotated.body.token));
  });

  it('rotating another admin\'s PAT keeps its owner and revokes the old token in the same transaction', async () => {
    const owner = await bootstrapAdminToken(sql, config, ['products:read'], { roles: ['auditor'] });
    const root = await bootstrapAdminToken(sql, config, ['tokens:manage', 'products:read']);
    const rotated = await api('POST', `/tokens/${owner.tokenId}/rotate`, {}, { token: root.token });
    expect(rotated.status).toBe(201);
    expect(rotated.body.owner).toEqual({ type: 'admin', id: owner.adminId });
    const rows = await sql<{ id: string; admin_user_id: string; revoked_at: Date | null; rotated_from_id: string | null }[]>`
      SELECT id, admin_user_id, revoked_at, rotated_from_id FROM admin_api_tokens WHERE id IN (${owner.tokenId}, ${rotated.body.id})`;
    expect(rows.find((r) => r.id === rotated.body.id)).toMatchObject({ admin_user_id: owner.adminId, revoked_at: null, rotated_from_id: owner.tokenId });
    expect(rows.find((r) => r.id === owner.tokenId)!.revoked_at).not.toBeNull();
    // Disabling the original owner disables the replacement too.
    await sql`UPDATE admin_users SET status = 'disabled' WHERE id = ${owner.adminId}`;
    expect((await api('GET', '/products', undefined, { token: rotated.body.token })).status).toBe(401);
  });

  it('Idempotency-Key replays the first response; destructive operations need confirm', async () => {
    const a = await api('POST', '/customers', { kind: 'individual', displayName: 'Idem', billingEmail: 'idem@example.test' }, { idem: 'idem-key-0001' });
    const b = await api('POST', '/customers', { kind: 'individual', displayName: 'Idem', billingEmail: 'idem@example.test' }, { idem: 'idem-key-0001' });
    expect(b.res.headers.get('idempotent-replayed')).toBe('true');
    expect(b.body.id).toBe(a.body.id);
    expect((await api('POST', '/customers', { kind: 'individual', displayName: 'Other', billingEmail: 'o@example.test' }, { idem: 'idem-key-0001' })).status).toBe(409);
    expect((await api('POST', `/licenses/${ids.licenseId}/revoke`, { reason: 'test' })).status).toBe(412);
    expect((await api('POST', `/licenses/${ids.licenseId}/revoke`, { reason: 'test', confirm: ids.licenseId })).status).toBe(200);
    expect((await api('POST', `/licenses/${ids.licenseId}/unrevoke`, { reason: 'test', confirm: ids.licenseId })).status).toBe(200);
  });

  it('audits every API call without bearer secrets', async () => {
    const r = await api('GET', '/audit?action=api.&limit=200');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(20);
    const blob = JSON.stringify(await sql`SELECT detail, actor_id FROM audit_events`);
    expect(blob).not.toContain(tokenSecret(token));
    expect(blob).not.toMatch(/rpl_(pat|svc)_[0-9A-Z]{16}_[A-Za-z0-9_-]{43}/);
  });

  it('serves an OpenAPI 3.1 document', async () => {
    const r = await admin.request('/api/admin/v1/openapi.json');
    const doc = (await r.json()) as any;
    expect(doc.openapi).toBe('3.1.0');
    expect(Object.keys(doc.paths)).toContain('/v1/activations');
    expect(Object.keys(doc.paths).length).toBeGreaterThan(60);
  });
});

describe('store: one customer per email, flat tax, prices registered from Stripe', () => {
  const EMAIL = 'office@school.example';
  const custRows = (email: string) => sql<{ id: string; organisation_name: string | null; country: string | null; tax_id: string | null; stripe_customer_id: string | null }[]>`
    SELECT id, organisation_name, country, tax_id, stripe_customer_id FROM customers WHERE billing_email = ${email}`;
  const sessionParams = () => stripe.requests.filter((r) => r.path === '/v1/checkout/sessions').at(-1)!.params as any;

  it('prices every currency in the database, with a flat tax per currency', async () => {
    ids.offer_edu = (await ok('POST', '/offers', { sku: 'cd2-education', name: 'Education perpetual', kind: 'single', billing: 'one_time', components: [{ editionPolicyId: ids.ep_education, termType: 'perpetual' }] })).id;
    const set = await ok('POST', `/offers/${ids.offer_edu}/prices`, { prices: CURRENCIES.map((c) => (c === 'aud' ? { currency: 'AUD', unitAmount: 10000, taxRatePercent: 10, taxLabel: 'GST' } : c === 'usd' ? { currency: 'usd', unitAmount: 7000 } : { currency: c, unitAmount: c === 'jpy' ? 9800 : 6500 })) });
    expect(set.missingCurrencies).toEqual([]);
    expect(set.prices.find((p: any) => p.currency === 'aud')).toMatchObject({ unit_amount: 10000, tax_rate_bps: 1000, tax_label: 'GST', status: 'active' });
    // Tax rate and label go together.
    expect((await api('POST', '/prices', { offerId: ids.offer_edu, currency: 'aud', unitAmount: 1, taxRatePercent: 10 })).status).toBe(422);
    // Fully priced but never created in Stripe (database first): activatable; its Stripe product
    // is created at the first checkout.
    await ok('POST', `/offers/${ids.offer_edu}/status`, { status: 'active' });
    expect((await sql`SELECT stripe_product_id FROM stripe_product_mappings WHERE offer_id = ${ids.offer_edu!}`)[0]!.stripe_product_id).toBeNull();
  });

  it('shows every currency from the database, with tax added on top', async () => {
    const html = await (await new Client(env).request('/store/products/cursedelete?currency=usd&sku=cd2-education')).text();
    expect(html).toMatch(/<option value="usd" selected/);
    expect(html).toMatch(/data-price="usd"><b>70\.00 USD<\/b>/);
    expect(html).toMatch(/data-price="aud" hidden=""><b>110\.00 AUD<\/b> incl\. GST/);
    expect(html).toMatch(/100\.00 AUD \+ GST 10% \(10\.00 AUD\)/);
    expect(html).toMatch(/name="businessName" required/); // education needs business details
    expect(html).toMatch(/98 JPY|9,800 JPY/); // zero-decimal currency
    const js = await new Client(env).request('/assets/app.js');
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(await js.text()).toMatch(/toLowerCase/);
  });

  it('creates one customer and one Stripe customer per email; Checkout opens on it with tax and coupons', async () => {
    const missing = await checkout('cd2-education', EMAIL, 1, undefined, { businessName: '', country: '' });
    expect(missing.res.status).toBe(422);
    expect(await missing.res.text()).toMatch(/Business name and country are required/);

    const first = await checkout('cd2-education', EMAIL, 1, undefined, { businessName: 'Example School', country: 'au', businessIdentifier: '51 824 753 556' });
    expect(first.res.status).toBe(303);
    const p = sessionParams();
    const [c] = await custRows(EMAIL);
    expect(c).toMatchObject({ organisation_name: 'Example School', country: 'AU', tax_id: '51 824 753 556' });
    expect(p.customer).toBe(c!.stripe_customer_id);
    expect(p.customer_email).toBeUndefined();
    expect(p.currency).toBe('aud');
    expect(p.allow_promotion_codes).toBe('true');
    const taxRate = stripe.taxRates.get(p.line_items[0].tax_rates[0])!;
    expect(taxRate).toMatchObject({ display_name: 'GST', percentage: 10, inclusive: false });
    expect(stripe.sessions.get(sessionIdFrom(first.location))!.amount_total).toBe(11000);

    // Second purchase attempt (USD), anonymous form with different details: same customer, nothing overwritten.
    const second = await checkout('cd2-education', EMAIL, 1, undefined, { currency: 'usd', businessName: 'Someone Else Ltd', country: 'US' });
    expect(second.res.status).toBe(303);
    expect(sessionParams().customer).toBe(c!.stripe_customer_id);
    expect(sessionParams().line_items[0].tax_rates).toBeUndefined(); // USD price has no tax
    expect(await custRows(EMAIL)).toEqual([c]);
    expect(stripe.requests.filter((r) => r.method === 'POST' && r.path === '/v1/customers' && r.params.email === EMAIL).length).toBe(1);
    expect(stripe.requests.filter((r) => r.method === 'POST' && r.path === '/v1/tax_rates').length).toBe(1);
  });

  it('refuses to sell an edition the email already owns, until a subscription has expired', async () => {
    const sid = sessionIdFrom((await checkout('cd2-education', EMAIL)).location);
    stripe.completeSession(sid, { email: EMAIL, name: 'Office' });
    await webhook('checkout.session.completed', stripe.publicSession(sid));
    await drain();
    const again = await checkout('cd2-education', EMAIL);
    expect(again.res.status).toBe(409);
    expect(await again.res.text()).toMatch(/already licensed to this email address/);
    // it@example.org's Business subscription: blocked while current, allowed once expired.
    expect((await checkout('cd2-business-annual', 'it@example.org')).res.status).toBe(409);
    await sql`UPDATE entitlements e SET expires_at = now() - interval '1 day' FROM customers c
              WHERE c.id = e.customer_id AND c.billing_email = 'it@example.org' AND e.term_type = 'subscription'`;
    expect((await checkout('cd2-business-annual', 'it@example.org')).res.status).toBe(303);
  });

  it('issues a numbered paid tax invoice, emails it as a PDF and serves it to the customer only', async () => {
    const [inv] = await sql<{ id: string; number: number; kind: string; subtotal: number; tax: number; total: number; snapshot: any }[]>`
      SELECT i.id, i.number, i.kind, i.subtotal, i.tax, i.total, i.snapshot FROM customer_invoices i JOIN customers c ON c.id = i.customer_id WHERE c.billing_email = ${EMAIL}`;
    expect(inv).toMatchObject({ kind: 'purchase', subtotal: 10000, tax: 1000, total: 11000 });
    expect(inv!.snapshot).toMatchObject({ taxLabel: 'GST 10%', buyer: { businessName: 'Example School', email: EMAIL, taxId: '51 824 753 556' }, seller: { email: config.supportEmail } });
    await expect(sql`UPDATE customer_invoices SET total = 1 WHERE id = ${inv!.id}`).rejects.toThrow(/append-only/);
    await sendMail();
    const msg = mail.sent.find((m) => m.to[0].email === EMAIL && /licence is ready/.test(m.subject))!;
    const no = `TEST-RPL-${String(inv!.number).padStart(7, '0')}`;
    expect(msg.text).toMatch(new RegExp(`Your paid invoice ${no} is attached`));
    expect(msg.attachments[0].filename).toBe(`${no}.pdf`);
    const pdf = Buffer.from(msg.attachments[0].content, 'base64').toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    for (const t of ['Tax Invoice', 'PAID', no, 'Example School', 'GST 10%', '110.00 AUD', 'Balance due', 'TEST MODE']) expect(pdf).toContain(`(${t}`);
    // Admin API lists and downloads it; free registrations get no invoice.
    const [cust] = await custRows(EMAIL);
    expect((await ok('GET', `/customers/${cust!.id}/invoices`)).data.length).toBe(1);
    const dl = await admin.request(`/api/admin/v1/invoices/${inv!.id}.pdf`, { token });
    expect(dl.headers.get('content-type')).toBe('application/pdf');
    expect((await sql`SELECT 1 FROM customer_invoices i JOIN customers c ON c.id = i.customer_id WHERE c.billing_email = 'jane@example.net'`).length).toBe(0);
    // Another customer's portal session cannot download it.
    const other = new Client(env);
    const csrf = await other.csrfFrom('/portal/login');
    await other.request('/portal/login', { method: 'POST', form: { _csrf: csrf, email: 'jane@example.net' } });
    await sendMail();
    const link = new URL(/https?:\/\/\S+\/portal\/auth\/verify\?token=[A-Za-z0-9_-]+/.exec([...mail.sent].reverse().find((m) => m.to[0].email === 'jane@example.net')!.text)![0]);
    const vcsrf = await other.csrfFrom(link.pathname + link.search);
    await other.request('/portal/auth/verify', { method: 'POST', form: { _csrf: vcsrf, token: link.searchParams.get('token')! } });
    const denied = await other.request(`/portal/invoices/${inv!.id}.pdf`);
    expect(denied.headers.get('content-type')).not.toBe('application/pdf');
  });

  it('reuses a Stripe customer that already exists for the email (shared Stripe account)', async () => {
    const existing = { id: 'cus_from_other_project', object: 'customer', email: 'shared@buyer.example', created: 1_700_000_000 };
    stripe.customers.set(existing.id, existing);
    const r = await checkout('cd2-enterprise', 'shared@buyer.example', 1, undefined, { businessName: 'Shared Pty Ltd' });
    expect(r.res.status).toBe(303);
    expect(sessionParams().customer).toBe('cus_from_other_project');
    expect(stripe.requests.some((x) => x.method === 'POST' && x.path === '/v1/customers' && x.params.email === 'shared@buyer.example')).toBe(false);
    expect((await custRows('shared@buyer.example'))[0]!.stripe_customer_id).toBe('cus_from_other_project');
  });

  it('created a Stripe product only for the offer never linked, once, and reused it', async () => {
    expect(stripe.requests.filter((r) => r.path === '/v1/checkout/sessions').length).toBeGreaterThan(5);
    const created = stripe.requests.filter((r) => r.method === 'POST' && r.path === '/v1/products');
    expect(created.length).toBe(1);
    expect(created[0]).toMatchObject({ idempotencyKey: `repass-product-${ids.offer_edu}`,
      params: { name: 'Education perpetual', metadata: { repass_offer_id: ids.offer_edu, repass_sku: 'cd2-education', sku: 'cd2-education' } } });
    const [m] = await sql<{ stripe_product_id: string }[]>`SELECT stripe_product_id FROM stripe_product_mappings WHERE offer_id = ${ids.offer_edu!}`;
    const sessions = stripe.requests.filter((x) => x.path === '/v1/checkout/sessions');
    expect(sessions.filter((r) => (r.params as any).line_items[0].price_data.product === m!.stripe_product_id).length).toBeGreaterThan(1);
    // Every Checkout line item referenced the product recorded on its checkout.
    const linked = new Set((await sql<{ stripe_product_id: string }[]>`SELECT stripe_product_id FROM checkouts WHERE stripe_product_id IS NOT NULL`).map((r) => r.stripe_product_id));
    for (const r of sessions) expect(linked.has((r.params as any).line_items[0].price_data.product)).toBe(true);
  });
});
