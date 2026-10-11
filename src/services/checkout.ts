// Server-created Stripe Checkout. The browser supplies what to buy and who is buying: never an
// amount, entitlement or seat count. The amount sent to Stripe (inline price_data) comes from
// the database price version, and an immutable snapshot of
// what will be granted is stored before Stripe is called. The success redirect proves nothing:
// fulfilment happens only from verified Stripe state (billing.ts).

import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Db, Sql } from '../db/client.ts';
import { computeEffectivePolicy, validatePolicy } from '../domain/policy.ts';
import { StripeClient, StripeError } from '../integrations/stripe.ts';
import { AppError, conflict, invalid, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import type { Actor } from './actor.ts';
import { audit } from './audit.ts';
import { loadPolicyRows, resolvePurchasable } from './catalogue.ts';
import { normaliseEmail, resolveStoreCustomer } from './customers.ts';
import { ensureStripeCustomer, ensureStripeProduct, ensureStripeTaxRate } from './stripe-sync.ts';

export const CreateCheckoutInput = z.object({
  sku: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((s) => s.toLowerCase()),
  quantity: z.coerce.number().int().min(1).max(10000).default(1),
  email: z.email().max(254).transform(normaliseEmail),
  /** Client-generated idempotency key; prevents duplicate sessions on double-submit/retry. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,100}$/),
  /** Purchaser's name (the customer's display name on first purchase). */
  name: z.string().trim().min(1).max(200).optional(),
  /** Required for Business / Enterprise / Education; identifier (ABN, VAT, EIN…) optional. */
  businessName: z.string().trim().max(200).optional().transform((v) => v || undefined),
  country: z.string().trim().optional().transform((v) => (v ? v.toUpperCase() : undefined)).refine((v) => v === undefined || /^[A-Z]{2}$/.test(v), 'Country must be a two-letter code'),
  businessIdentifier: z.string().trim().max(64).optional().transform((v) => v || undefined),
}).strict();

/** Editions sold to organisations: the store requires business name and country for these. */
const ORGANISATION_EDITIONS = new Set(['business', 'enterprise', 'education']);

export interface CheckoutSnapshot {
  version: 1;
  offer: { id: string; sku: string; name: string; kind: string; billing: string };
  price: { id: string; currency: string; unitAmount: number; recurringInterval: string | null; recurringIntervalCount: number | null; taxBehavior: string;
    /** Legacy (Stripe Price objects); new checkouts send the amount inline. */
    stripePriceId?: string | null;
    /** Flat exclusive tax added on top (e.g. 1000 = 10%), with its invoice label. */
    taxRateBps?: number | null; taxLabel?: string | null };
  quantity: number;
  components: Array<{ componentId: string; policy: ReturnType<typeof computeEffectivePolicy> }>;
}

export interface CheckoutView {
  id: string;
  status: string;
  url: string | null;
  offerSku: string;
  quantity: number;
  currency: string;
  expectedSubtotal: number;
}

function view(r: { id: string; status: string; stripe_checkout_url: string | null; quantity: number; currency: string; expected_subtotal: number; snapshot: CheckoutSnapshot }): CheckoutView {
  return { id: r.id, status: r.status, url: r.status === 'open' ? r.stripe_checkout_url : null, offerSku: r.snapshot.offer.sku, quantity: r.quantity, currency: r.currency, expectedSubtotal: r.expected_subtotal };
}

export async function createCheckout(sql: Sql, config: Config, stripe: StripeClient, actor: Actor, raw: unknown, ctx: { portalUserId?: string | null; customerId?: string | null } = {}, now = new Date()): Promise<CheckoutView> {
  const input = CreateCheckoutInput.parse(raw);
  // Idempotent replay: same key returns the same checkout (and refuses a different request).
  const [existing] = await sql<{ id: string; status: string; stripe_checkout_url: string | null; quantity: number; currency: string; expected_subtotal: number; snapshot: CheckoutSnapshot; email: string }[]>`
    SELECT id, status, stripe_checkout_url, quantity, currency, expected_subtotal, snapshot, email FROM checkouts WHERE idempotency_key = ${input.idempotencyKey}`;
  if (existing) {
    if (existing.snapshot.offer.sku !== input.sku || existing.quantity !== input.quantity || existing.currency !== input.currency || existing.email !== input.email) {
      throw conflict('Idempotency key was already used for a different checkout');
    }
    if (existing.status !== 'creating' && existing.status !== 'failed') return view(existing);
    return startStripeSession(sql, config, stripe, actor, existing.id, now);
  }

  const purchasable = await resolvePurchasable(sql, input.sku, input.currency, now);
  const { offer, price } = purchasable;
  if (input.quantity < offer.min_quantity || input.quantity > offer.max_quantity) throw invalid(`Quantity must be between ${offer.min_quantity} and ${offer.max_quantity}`);
  const needsOrganisation = offer.customer_kind === 'organisation' || purchasable.components.some((c) => ORGANISATION_EDITIONS.has(c.policy.edition.editionId));
  if (needsOrganisation && (!input.businessName || !input.country)) {
    throw invalid('Business name and country are required for Business, Enterprise and Education licences');
  }
  if (offer.customer_kind === 'individual' && input.businessName) throw invalid('This offer is only available to individual customers');
  // One customer per email, created (or found) before Stripe is called, so Checkout opens on
  // that customer with the email locked and nothing is ever duplicated.
  const customerId = ctx.customerId ?? await sql.begin((tx) => resolveStoreCustomer(tx, actor, {
    email: input.email, name: input.name ?? input.businessName ?? input.email.split('@')[0]!,
    organisation: needsOrganisation ? { businessName: input.businessName!, country: input.country!, businessIdentifier: input.businessIdentifier ?? null } : null,
  }));
  const [cust] = await sql<{ kind: string; status: string }[]>`SELECT kind, status FROM customers WHERE id = ${customerId}`;
  if (!cust || cust.status !== 'active') throw notFound('Customer');
  if (offer.customer_kind !== 'any' && offer.customer_kind !== cust.kind) throw invalid(`This offer is only available to ${offer.customer_kind} customers`);
  // Already owned: an active entitlement for the same product major + edition (an expired
  // subscription or fixed term does not count). Upgrades are a new SKU, usually with a coupon.
  for (const c of purchasable.components) {
    const owned = await sql`
      SELECT 1 FROM entitlements e JOIN product_edition_policies ep ON ep.id = e.edition_policy_id
      WHERE e.customer_id = ${customerId} AND e.status = 'active' AND e.product_major_id = ${c.policy.major.id}
        AND ep.edition_id = ${c.policy.edition.editionId} AND (e.expires_at IS NULL OR e.expires_at > ${now})`;
    if (owned.length) {
      throw conflict(`${c.policy.product.name} ${c.policy.major.majorVersion} ${c.policy.edition.displayName} is already licensed to this email address. Sign in to the customer portal to manage it, or contact us about upgrading.`);
    }
  }
  // Quantity-adjusted policies, validated again at purchase time.
  const components = [];
  for (const c of purchasable.components) {
    const comp = await sql<{ edition_policy_id: string }[]>`SELECT edition_policy_id FROM offer_entitlement_components WHERE id = ${c.componentId}`;
    const policy = computeEffectivePolicy(await loadPolicyRows(sql, comp[0]!.edition_policy_id, c.componentId), input.quantity);
    const problems = validatePolicy(policy);
    if (problems.length) throw new AppError('protocol_incompatible', problems.map((p) => p.message).join('; '));
    components.push({ componentId: c.componentId, policy });
  }
  const snapshot: CheckoutSnapshot = {
    version: 1,
    offer: { id: offer.id, sku: offer.sku, name: offer.name, kind: offer.kind, billing: offer.billing },
    price: { id: price.id, currency: price.currency, unitAmount: price.unit_amount, recurringInterval: price.recurring_interval, recurringIntervalCount: price.recurring_interval_count, taxBehavior: price.tax_behavior,
      taxRateBps: price.tax_rate_bps, taxLabel: price.tax_label },
    quantity: input.quantity,
    components,
  };
  const id = newId('chk');
  await sql`
    INSERT INTO checkouts (id, idempotency_key, customer_id, portal_user_id, email, offer_id, price_version_id, stripe_price_id, quantity, currency, unit_amount,
                           expected_subtotal, mode, snapshot, status, expires_at)
    VALUES (${id}, ${input.idempotencyKey}, ${customerId}, ${ctx.portalUserId ?? null}, ${input.email}, ${offer.id}, ${price.id}, ${null},
            ${input.quantity}, ${price.currency}, ${price.unit_amount}, ${price.unit_amount * input.quantity},
            ${offer.billing === 'recurring' ? 'subscription' : 'payment'}, ${sql.json(snapshot as never)}, 'creating', ${new Date(now.getTime() + 23 * 3600_000)})
    ON CONFLICT (idempotency_key) DO NOTHING`;
  await audit(sql, actor, { action: 'checkout.created', resourceType: 'checkout', resourceId: id, detail: { sku: offer.sku, priceVersionId: price.id, quantity: input.quantity, currency: price.currency } });
  return startStripeSession(sql, config, stripe, actor, id, now);
}

async function startStripeSession(sql: Sql, config: Config, stripe: StripeClient, actor: Actor, checkoutId: string, now: Date): Promise<CheckoutView> {
  const [c] = await sql<{ id: string; status: string; stripe_checkout_url: string | null; quantity: number; currency: string; expected_subtotal: number; snapshot: CheckoutSnapshot; email: string; mode: string; customer_id: string | null; expires_at: Date }[]>`
    SELECT * FROM checkouts WHERE id = ${checkoutId}`;
  if (!c) throw notFound('Checkout');
  const [offer] = await sql<{ allow_promotion_codes: boolean; automatic_tax: boolean; billing_address_collection: string; tax_id_collection: boolean }[]>`
    SELECT allow_promotion_codes, automatic_tax, billing_address_collection, tax_id_collection FROM offers WHERE id = ${c.snapshot.offer.id}`;
  const base = config.publicBaseUrl;
  const trialDays = Math.max(0, ...c.snapshot.components.map((x) => x.policy.term.trialDays ?? 0));
  // Our flat tax (if any) is attached to the line item as a Stripe Tax Rate: exclusive, so the
  // customer pays price + tax (e.g. 100 + 10% GST = 110), computed from database values.
  const p = c.snapshot.price;
  let taxRateId: string | null = null;
  let stripeCustomerId: string | null = null;
  let stripeProductId: string;
  try {
    stripeProductId = await ensureStripeProduct(sql, stripe, c.snapshot.offer.id);
    if (p.taxRateBps && p.taxLabel) taxRateId = await ensureStripeTaxRate(sql, stripe, p.taxLabel, p.taxRateBps);
    if (c.customer_id) stripeCustomerId = await ensureStripeCustomer(sql, stripe, c.customer_id);
  } catch (e) {
    await sql`UPDATE checkouts SET status = 'failed', failure_reason = ${(e as Error).message.slice(0, 500)} WHERE id = ${c.id} AND status IN ('creating', 'failed')`;
    if (e instanceof StripeError) throw new AppError('provider_unavailable', 'Payment provider is unavailable. Please try again shortly.');
    throw e;
  }
  const params: Record<string, unknown> = {
    mode: c.mode,
    client_reference_id: c.id,
    currency: c.currency,
    // The amount comes from the database price version the buyer was shown; no Stripe Price object.
    line_items: [{
      price_data: {
        currency: p.currency, unit_amount: p.unitAmount, product: stripeProductId,
        ...(p.recurringInterval ? { recurring: { interval: p.recurringInterval, interval_count: p.recurringIntervalCount ?? 1 } } : {}),
        ...(p.taxBehavior !== 'unspecified' ? { tax_behavior: p.taxBehavior } : {}),
      },
      quantity: c.quantity,
      ...(taxRateId ? { tax_rates: [taxRateId] } : {}),
    }],
    success_url: `${new URL(`/checkout/${c.id}/return`, base)}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: new URL(`/checkout/${c.id}/cancelled`, base).toString(),
    metadata: { repass_checkout_id: c.id },
    billing_address_collection: offer!.billing_address_collection,
    expires_at: Math.floor(Math.min(c.expires_at.getTime(), now.getTime() + 23.5 * 3600_000) / 1000),
  };
  if (offer!.allow_promotion_codes) params.allow_promotion_codes = true;
  if (offer!.automatic_tax) params.automatic_tax = { enabled: true };
  if (offer!.tax_id_collection) params.tax_id_collection = { enabled: true };
  // Checkout always opens on the customer's single Stripe customer: the (lowercase) email is
  // already filled in and cannot be changed, and Stripe never creates another customer.
  if (!stripeCustomerId) throw new AppError('precondition_failed', 'Checkout requires a customer');
  params.customer = stripeCustomerId;
  if (offer!.automatic_tax || offer!.tax_id_collection) params.customer_update = { address: 'auto', name: 'auto' };
  if (c.mode === 'subscription') {
    params.subscription_data = { metadata: { repass_checkout_id: c.id }, ...(trialDays ? { trial_period_days: trialDays } : {}) };
  } else {
    params.payment_intent_data = c.snapshot.price.unitAmount > 0 ? { metadata: { repass_checkout_id: c.id } } : undefined;
  }
  try {
    const session = await stripe.request<{ id: string; url: string }>('POST', '/v1/checkout/sessions', params as never, `repass-checkout-${c.id}`);
    const [u] = await sql<{ id: string; status: string; stripe_checkout_url: string | null; quantity: number; currency: string; expected_subtotal: number; snapshot: CheckoutSnapshot }[]>`
      UPDATE checkouts SET stripe_checkout_session_id = ${session.id}, stripe_checkout_url = ${session.url}, status = 'open', failure_reason = NULL
      WHERE id = ${c.id} AND status IN ('creating', 'failed') RETURNING id, status, stripe_checkout_url, quantity, currency, expected_subtotal, snapshot`;
    if (!u) {
      const [cur] = await sql<{ id: string; status: string; stripe_checkout_url: string | null; quantity: number; currency: string; expected_subtotal: number; snapshot: CheckoutSnapshot }[]>`SELECT id, status, stripe_checkout_url, quantity, currency, expected_subtotal, snapshot FROM checkouts WHERE id = ${c.id}`;
      return view(cur!);
    }
    await audit(sql, actor, { action: 'checkout.session_created', resourceType: 'checkout', resourceId: c.id, detail: { stripeSessionId: session.id } });
    return view(u);
  } catch (e) {
    await sql`UPDATE checkouts SET status = 'failed', failure_reason = ${(e as Error).message.slice(0, 500)} WHERE id = ${c.id} AND status IN ('creating', 'failed')`;
    if (e instanceof StripeError) throw new AppError('provider_unavailable', 'Payment provider is unavailable. Please try again shortly.');
    throw e;
  }
}

/** Customer-facing status. Never fulfils: fulfilment is webhook/reconciliation driven. */
export async function getCheckoutStatus(db: Db, checkoutId: string) {
  const [c] = await db<{ id: string; status: string; snapshot: CheckoutSnapshot; completed_at: Date | null; failure_reason: string | null }[]>`
    SELECT id, status, snapshot, completed_at, failure_reason FROM checkouts WHERE id = ${checkoutId}`;
  if (!c) throw notFound('Checkout');
  const [p] = await db<{ id: string }[]>`SELECT id FROM purchases WHERE checkout_id = ${checkoutId}`;
  return { id: c.id, status: c.status, offerName: c.snapshot.offer.name, purchaseId: p?.id ?? null, completedAt: c.completed_at };
}

export async function listCheckouts(db: Db, opts: { status?: string; limit?: number }) {
  return db<{ id: string; email: string; status: string; currency: string; expected_subtotal: number; quantity: number; created_at: Date; completed_at: Date | null; stripe_checkout_session_id: string | null; failure_reason: string | null; sku: string }[]>`
    SELECT c.id, c.email, c.status, c.currency, c.expected_subtotal, c.quantity, c.created_at, c.completed_at, c.stripe_checkout_session_id, c.failure_reason, c.snapshot->'offer'->>'sku' AS sku
    FROM checkouts c WHERE (${opts.status ?? null}::text IS NULL OR c.status = ${opts.status ?? null}) ORDER BY c.created_at DESC LIMIT ${Math.min(opts.limit ?? 50, 500)}`;
}
