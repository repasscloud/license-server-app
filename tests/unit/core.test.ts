import { describe, expect, it } from 'vitest';
import { ipInCidr, isValidCidr } from '../../src/auth/cidr.ts';
import { base32Decode, base32Encode, totpAt, verifyTotp } from '../../src/auth/totp.ts';
import { computeEffectivePolicy, validateOfferShape, validatePolicy, validatePrice, type PolicyRows } from '../../src/domain/policy.ts';
import { MailerSendTransport, MailError } from '../../src/integrations/mail.ts';
import { formEncode, signStripePayload, StripeClient, StripeError, verifyStripeSignature, WebhookSignatureError } from '../../src/integrations/stripe.ts';
import { base64UrlDecode, base64UrlEncode, encodeUtf8 } from '../../src/lib/encoding.ts';
import { compareSemver } from '../../src/lib/semver.ts';
import { addInterval, rfc3339 } from '../../src/lib/time.ts';
import { renderTemplate } from '../../src/services/email.ts';
import { generateActivationKey, normaliseActivationKey } from '../../src/services/licensing.ts';
import { verifyMailerSendSignature } from '../../src/services/mail-webhooks.ts';

describe('TOTP (RFC 6238 SHA-1 vectors, 6-digit truncation)', () => {
  const secret = encodeUtf8('12345678901234567890');
  it('matches the RFC test vectors', async () => {
    expect(await totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(await totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(await totpAt(secret, Math.floor(1234567890 / 30))).toBe('005924');
    expect(await totpAt(secret, Math.floor(20000000000 / 30))).toBe('353130');
  });
  it('accepts ±1 step, rejects replays and junk', async () => {
    const now = 1111111109_000;
    expect(await verifyTotp(secret, '081804', null, now)).toBe(Math.floor(1111111109 / 30));
    expect(await verifyTotp(secret, '081804', Math.floor(1111111109 / 30), now)).toBeNull();
    expect(await verifyTotp(secret, 'abcdef', null, now)).toBeNull();
  });
  it('base32 round-trips', () => {
    const b = crypto.getRandomValues(new Uint8Array(20));
    expect([...base32Decode(base32Encode(b))]).toEqual([...b]);
  });
});

describe('CIDR', () => {
  it('matches IPv4 and IPv6', () => {
    expect(ipInCidr('203.0.113.9', '203.0.113.0/24')).toBe(true);
    expect(ipInCidr('203.0.114.9', '203.0.113.0/24')).toBe(false);
    expect(ipInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(ipInCidr('2001:db9::1', '2001:db8::/32')).toBe(false);
    expect(ipInCidr('203.0.113.9', '2001:db8::/32')).toBe(false);
    expect(isValidCidr('10.0.0.0/33')).toBe(false);
    expect(isValidCidr('::/0')).toBe(true);
  });
});

describe('encodings and time', () => {
  it('base64url is unpadded and strict', () => {
    expect(base64UrlEncode(new Uint8Array([251, 255]))).toBe('-_8');
    expect(() => base64UrlDecode('-_8=')).toThrow();
    expect(() => base64UrlDecode('ab+c')).toThrow();
    expect(() => base64UrlDecode('-_9')).toThrow(/non-canonical/);
  });
  it('RFC 3339 whole seconds UTC', () => {
    expect(rfc3339(new Date('2026-10-11T00:00:00.999Z'))).toBe('2026-10-11T00:00:00Z');
  });
  it('month arithmetic clamps like Stripe', () => {
    expect(addInterval(new Date('2026-01-31T00:00:00Z'), 'month', 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addInterval(new Date('2028-02-29T00:00:00Z'), 'year', 1).toISOString()).toBe('2029-02-28T00:00:00.000Z');
  });
  it('semver ordering', () => {
    expect(compareSemver('2.10.0', '2.9.9')).toBe(1);
    expect(compareSemver('2.1.0-rc.1', '2.1.0')).toBe(-1);
    expect(compareSemver('2.1.0-rc.2', '2.1.0-rc.10')).toBe(-1);
    expect(() => compareSemver('2.1', '2.1.0')).toThrow();
  });
});

describe('activation keys', () => {
  it('generates 150-bit typable keys and normalises user input', () => {
    const k = generateActivationKey();
    expect(k).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/);
    expect(normaliseActivationKey(k.toLowerCase())).toBe(k.replace(/-/g, ''));
    // Case-insensitive; Crockford look-alikes I/L -> 1 and O -> 0.
    expect(normaliseActivationKey('abcde-fghil-ooooo-12345-67890-abcde')).toBe('ABCDEFGH11000001234567890ABCDE');
    expect(normaliseActivationKey('ABCDE FGHJK')).toBeNull();
    expect(normaliseActivationKey('U'.repeat(30))).toBeNull();
    expect(normaliseActivationKey('A'.repeat(300))).toBeNull();
  });
});

describe('email templates', () => {
  it('escapes variables in HTML and only inserts server-built raw HTML via triple braces', () => {
    const vars = { name: '<script>x</script>', table: 'ignored' };
    expect(renderTemplate('<p>{{name}}</p>{{{table}}}', vars, { table: '<b>ok</b>' }, true)).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p><b>ok</b>');
    expect(renderTemplate('{{name}}', vars, {}, false)).toBe('<script>x</script>');
  });
});

describe('Stripe adapter', () => {
  it('form-encodes nested params like Stripe expects', () => {
    expect(decodeURIComponent(formEncode({ line_items: [{ price: 'p', quantity: 2 }], metadata: { a: 'b' }, expand: ['x'] }))).toBe('line_items[0][price]=p&line_items[0][quantity]=2&metadata[a]=b&expand[0]=x');
  });
  it('verifies webhook signatures on the raw body, with tolerance', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 't', created: 1, livemode: false, api_version: null, data: { object: { id: 'x' } } });
    const sig = await signStripePayload(body, 'whsec_x', 1000);
    expect((await verifyStripeSignature(body, sig, 'whsec_x', 1000)).id).toBe('evt_1');
    await expect(verifyStripeSignature(body + ' ', sig, 'whsec_x', 1000)).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(verifyStripeSignature(body, sig, 'whsec_y', 1000)).rejects.toThrow(/mismatch/);
    await expect(verifyStripeSignature(body, sig, 'whsec_x', 2000)).rejects.toThrow(/tolerance/);
    await expect(verifyStripeSignature(body, null, 'whsec_x', 1000)).rejects.toThrow(/missing/);
    const multi = `${sig},v1=${'0'.repeat(64)}`;
    expect((await verifyStripeSignature(body, multi, 'whsec_x', 1000)).id).toBe('evt_1');
  });
  it('requires idempotency keys for POST and classifies errors', async () => {
    const fake = (status: number) => (async () => new Response(JSON.stringify({ error: { message: 'm' } }), { status })) as unknown as typeof fetch;
    const c = new StripeClient({ secretKey: 'sk_test_x', apiVersion: 'v', fetchImpl: fake(500) });
    await expect(c.request('POST', '/v1/prices', {})).rejects.toThrow(/idempotency/);
    await expect(c.request('GET', '/v1/prices/x')).rejects.toMatchObject({ retryable: true, status: 500 });
    const c4 = new StripeClient({ secretKey: 'sk_test_x', apiVersion: 'v', fetchImpl: fake(400) });
    await expect(c4.request('GET', '/v1/prices/x')).rejects.toSatisfy((e: unknown) => e instanceof StripeError && !e.retryable);
    expect(new StripeClient({ secretKey: 'sk_live_x', apiVersion: 'v' }).livemode).toBe(true);
  });
});

describe('MailerSend adapter', () => {
  const mail = { from: { email: 'a@b.c', name: 'A' }, to: { email: 'x@y.z', name: null }, subject: 's', html: '<p>h</p>', text: 't', templateId: null, personalization: {}, tags: ['purchase_confirmation'], idempotencyKey: 'eml_1' };
  const t = (res: () => Promise<Response>) => new MailerSendTransport('tok', 'https://api.mailersend.test', res as unknown as typeof fetch);
  it('sends the documented request shape and reads x-message-id', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const tr = new MailerSendTransport('tok', 'https://api.mailersend.test', (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 202, headers: { 'x-message-id': 'abc' } });
    }) as unknown as typeof fetch);
    expect(await tr.send(mail)).toEqual({ messageId: 'abc' });
    expect(seen!.url).toBe('https://api.mailersend.test/v1/email');
    expect(JSON.parse(seen!.init.body as string)).toMatchObject({ from: { email: 'a@b.c' }, to: [{ email: 'x@y.z' }], subject: 's', html: '<p>h</p>', text: 't', tags: ['purchase_confirmation'] });
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('classifies 429 (retry-after), 422 (permanent), timeout (uncertain), suppressed', async () => {
    await expect(t(async () => new Response('{}', { status: 429, headers: { 'retry-after': '17' } })).send(mail)).rejects.toMatchObject({ retryable: true, retryAfterSeconds: 17 });
    await expect(t(async () => new Response('{"message":"bad"}', { status: 422 })).send(mail)).rejects.toMatchObject({ retryable: false });
    await expect(t(async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }).send(mail)).rejects.toMatchObject({ uncertain: true });
    await expect(t(async () => new Response(null, { status: 202 })).send(mail)).rejects.toSatisfy((e: unknown) => e instanceof MailError && !e.retryable);
  });
  it('verifies webhook signatures', async () => {
    const body = '{"type":"activity.delivered"}';
    const key = await crypto.subtle.importKey('raw', encodeUtf8('s3cret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, encodeUtf8(body))).toString('hex');
    await expect(verifyMailerSendSignature(body, sig, 's3cret')).resolves.toBeUndefined();
    await expect(verifyMailerSendSignature(body, sig, 'other')).rejects.toThrow();
    await expect(verifyMailerSendSignature(body, null, 's3cret')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Policy engine: per-product diversity under the repass-v1 protocol (mandate §3 examples A–D).
// ---------------------------------------------------------------------------------------------

function rows(edition: string, model: 'none' | 'device_seats', comp: Partial<PolicyRows['component']> = {}, ep: Partial<PolicyRows['editionPolicy']> = {}, protocol = 'repass-v1'): PolicyRows {
  return {
    product: { id: 'prd_1', slug: 'app', name: 'App' },
    major: { id: 'pmj_1', major_version: 1, protocol_id: protocol, default_transfer_allowance: 3, activation_key_email: true },
    editionPolicy: { id: `pep_${edition}`, edition_id: edition, wire_id: edition, display_name: edition, activation_model: model, ownership: 'organisation', transfer_allowance: null, certificate_lifetime_seconds: null, offline_policy: 'indefinite', ...ep },
    component: { id: 'ocp_1', term_type: 'perpetual', term_interval: null, term_interval_count: null, seats_per_unit: model === 'device_seats' ? 1 : null, quantity_scales_seats: false, trial_days: null, grace_days: 0, transfer_allowance: null, refund_action: 'revoke', dispute_action: 'review', ...comp },
    offer: { id: 'off_1', sku: 'sku' },
  };
}
const ok = (r: PolicyRows, q = 1) => validatePolicy(computeEffectivePolicy(r, q));
const editionModel = (e: string) => (e === 'business' ? 'device_seats' : 'none') as 'none' | 'device_seats';

describe('policy engine (data-driven, protocol-validated)', () => {
  it('Product A: free community, monthly business seats, perpetual enterprise valid; education subscription refused by v1', () => {
    expect(ok(rows('community', 'none'))).toEqual([]);
    expect(ok(rows('business', 'device_seats', { term_type: 'subscription', seats_per_unit: 5 }))).toEqual([]);
    expect(ok(rows('enterprise', 'none'))).toEqual([]);
    expect(ok(rows('education', 'none', { term_type: 'subscription' })).map((p) => p.rule)).toEqual(['v1.perpetual']);
  });
  it('Product B: subscriptions for all four editions — only business is expressible in v1', () => {
    const r = ['community', 'education', 'business', 'enterprise'].map((e) => ok(rows(e, editionModel(e), { term_type: 'subscription' })).length === 0);
    expect(r).toEqual([false, false, true, false]);
  });
  it('Product C: perpetual for 0, 1 or all editions is configurable', () => {
    for (const e of ['community', 'education', 'business', 'enterprise']) expect(ok(rows(e, editionModel(e)))).toEqual([]);
  });
  it('Product D: a single paid non-perpetual edition (fixed-term business)', () => {
    expect(ok(rows('business', 'device_seats', { term_type: 'fixed_term', term_interval: 'month', term_interval_count: 6 }))).toEqual([]);
  });
  it('v1 couples device seats with business only; certificate lifetime only with seats; unknown protocol refused', () => {
    expect(ok(rows('business', 'none')).map((p) => p.rule)).toContain('v1.business.seats');
    expect(ok(rows('enterprise', 'device_seats')).map((p) => p.rule)).toContain('v1.device.business_only');
    expect(ok(rows('enterprise', 'none', {}, { certificate_lifetime_seconds: 86400 })).map((p) => p.rule)).toContain('v1.certificate');
    expect(ok(rows('business', 'device_seats', {}, { offline_policy: 'periodic_check' })).map((p) => p.rule)).toContain('v1.periodic');
    expect(ok(rows('custom', 'none')).map((p) => p.rule)).toContain('v1.edition');
    expect(ok(rows('community', 'none', {}, {}, 'repass-v2')).map((p) => p.rule)).toEqual(['protocol.unimplemented']);
  });
  it('quantity scales seats; transfer allowance precedence component > edition > major', () => {
    expect(computeEffectivePolicy(rows('business', 'device_seats', { seats_per_unit: 2, quantity_scales_seats: true }), 5).seats).toBe(10);
    expect(computeEffectivePolicy(rows('business', 'device_seats'), 5).seats).toBe(1);
    expect(computeEffectivePolicy(rows('business', 'device_seats'), 1).transferAllowance).toBe(3);
    expect(computeEffectivePolicy(rows('business', 'device_seats', {}, { transfer_allowance: 5 }), 1).transferAllowance).toBe(5);
    expect(computeEffectivePolicy(rows('business', 'device_seats', { transfer_allowance: 7 }, { transfer_allowance: 5 }), 1).transferAllowance).toBe(7);
    expect(computeEffectivePolicy(rows('enterprise', 'none'), 1).transferAllowance).toBeNull();
  });
  it('offer shape: bundles, billing/term coherence, quantity rules', () => {
    const p = (e: string, t: 'perpetual' | 'subscription' = 'perpetual') => computeEffectivePolicy(rows(e, editionModel(e), { term_type: t }), 1);
    expect(validateOfferShape({ kind: 'bundle', billing: 'one_time', maxQuantity: 1, components: [{ productMajorId: 'a', policy: p('enterprise'), quantityScalesSeats: false }, { productMajorId: 'a', policy: p('enterprise'), quantityScalesSeats: false }] }).map((x) => x.rule)).toContain('offer.bundle.duplicate');
    expect(validateOfferShape({ kind: 'single', billing: 'recurring', maxQuantity: 1, components: [{ productMajorId: 'a', policy: p('enterprise'), quantityScalesSeats: false }] }).map((x) => x.rule)).toContain('offer.billing.recurring');
    expect(validateOfferShape({ kind: 'single', billing: 'one_time', maxQuantity: 1, components: [{ productMajorId: 'a', policy: p('business', 'subscription'), quantityScalesSeats: false }] }).map((x) => x.rule)).toContain('offer.billing.subscription');
    expect(validateOfferShape({ kind: 'single', billing: 'one_time', maxQuantity: 5, components: [{ productMajorId: 'a', policy: p('enterprise'), quantityScalesSeats: false }] }).map((x) => x.rule)).toContain('offer.quantity');
  });
  it('prices: integer minor units, free means zero, recurring needs an interval', () => {
    expect(validatePrice({ billing: 'free', unitAmount: 100, recurringInterval: null }).map((x) => x.rule)).toEqual(['price.free']);
    expect(validatePrice({ billing: 'one_time', unitAmount: 0, recurringInterval: null }).map((x) => x.rule)).toEqual(['price.zero']);
    expect(validatePrice({ billing: 'one_time', unitAmount: 1.5, recurringInterval: null }).map((x) => x.rule)).toEqual(['price.amount']);
    expect(validatePrice({ billing: 'recurring', unitAmount: 100, recurringInterval: null }).map((x) => x.rule)).toEqual(['price.interval']);
  });
});
