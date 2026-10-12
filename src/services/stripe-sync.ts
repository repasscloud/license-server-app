// Stripe objects the store needs. Prices are NOT Stripe objects: they live only in PostgreSQL and
// Checkout sends the amount inline (price_data). Each offer is linked to one Stripe Product that
// is created and managed in Stripe (name, description and images shown at Checkout): the server
// never creates or renames products, it only verifies them and tags them with repass_* metadata.
// Stripe also holds one Customer per email and one Tax Rate per flat rate/label.

import type { Db, Sql } from '../db/client.ts';
import { StripeClient, StripeError } from '../integrations/stripe.ts';
import { AppError, conflict, invalid, notFound } from '../lib/errors.ts';
import { requirePermission, systemActor, type Actor } from './actor.ts';
import { audit } from './audit.ts';
import { enqueueJob } from './jobs.ts';

interface StripeProduct { id: string; name: string; active: boolean; metadata?: Record<string, string> }

const PRODUCT_ID = /^prod_[A-Za-z0-9]{1,250}$/;

/** A product checkouts may reference: it exists in this Stripe account and is active. */
async function fetchSellableProduct(stripe: StripeClient, productId: string): Promise<StripeProduct> {
  let product: StripeProduct;
  try {
    product = await stripe.request<StripeProduct>('GET', `/v1/products/${productId}`);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) {
      throw invalid(`Stripe product ${productId} does not exist in this Stripe account (${stripe.livemode ? 'live' : 'test'} mode)`);
    }
    throw e;
  }
  if (!product.active) throw invalid(`Stripe product ${productId} is archived in Stripe; reactivate it or link another product`);
  return product;
}

/** Tag the product for Stripe reporting. Never writes its name, description, images or status. */
async function tagProduct(stripe: StripeClient, product: StripeProduct, offer: { id: string; sku: string }): Promise<void> {
  if (product.metadata?.repass_offer_id === offer.id && product.metadata?.repass_sku === offer.sku) return;
  await stripe.request('POST', `/v1/products/${product.id}`, { metadata: { repass_offer_id: offer.id, repass_sku: offer.sku } },
    `repass-product-tag-${offer.id}-${product.id}-${Date.now()}`);
}

/**
 * Read-only check that a product can be linked to the offer (null = an offer not created yet):
 * a well-formed id, not linked to a different offer, existing in this Stripe account and active.
 */
export async function checkStripeProductLinkable(db: Db, stripe: StripeClient, offerId: string | null, given: unknown): Promise<StripeProduct> {
  const productId = typeof given === 'string' ? given.trim() : '';
  if (!PRODUCT_ID.test(productId)) throw invalid('stripeProductId must be a Stripe product id (prod_…)');
  const [other] = await db<{ sku: string }[]>`
    SELECT o.sku FROM stripe_product_mappings m JOIN offers o ON o.id = m.offer_id
    WHERE m.stripe_product_id = ${productId} AND (${offerId}::text IS NULL OR m.offer_id <> ${offerId})`;
  if (other) throw conflict(`Stripe product ${productId} is already linked to offer ${other.sku}`);
  return fetchSellableProduct(stripe, productId);
}

/**
 * Link an offer to an existing Stripe Product (prod_…). The product must exist in this Stripe
 * account and be active, and belongs to one offer only. Relinking is allowed and audited:
 * checkouts already open keep the product they were created with.
 */
export async function linkStripeProduct(sql: Sql, stripe: StripeClient, actor: Actor, offerIdOrSku: string, raw: unknown) {
  requirePermission(actor, 'products:write');
  const given = typeof raw === 'object' && raw !== null ? (raw as { stripeProductId?: unknown }).stripeProductId : undefined;
  const [o] = await sql<{ id: string; sku: string; stripe_product_id: string | null }[]>`
    SELECT o.id, o.sku, m.stripe_product_id FROM offers o JOIN stripe_product_mappings m ON m.offer_id = o.id
    WHERE o.id = ${offerIdOrSku} OR o.sku = ${offerIdOrSku}`;
  if (!o) throw notFound('Offer');
  const product = await checkStripeProductLinkable(sql, stripe, o.id, given);
  const productId = product.id;
  await tagProduct(stripe, product, o);
  await sql`UPDATE stripe_product_mappings SET stripe_product_id = ${productId}, sync_state = 'synced', synced_name = ${product.name}, last_error = NULL,
            attempts = attempts + 1, last_synced_at = now(), last_checked_at = now(), updated_at = now() WHERE offer_id = ${o.id}`
    .catch((e) => {
      throw conflict(`Stripe product ${productId} is already linked to another offer: ${errorText(e)}`);
    });
  await audit(sql, actor, { action: 'stripe.product_linked', resourceType: 'offer', resourceId: o.id, detail: { stripeProductId: productId, previousStripeProductId: o.stripe_product_id } });
  return { offerId: o.id, sku: o.sku, stripeProductId: productId, stripeProductName: product.name };
}

/**
 * Verify the offer's linked Stripe Product still exists and is active, and re-apply the repass_*
 * metadata. Never creates a product. A missing or archived product marks the mapping failed,
 * which blocks activation until it is fixed or relinked.
 */
export async function syncOffer(sql: Sql, stripe: StripeClient, offerId: string, actor: Actor = systemActor('stripe-sync')): Promise<string> {
  const [o] = await sql<{ id: string; sku: string; stripe_product_id: string | null }[]>`
    SELECT o.id, o.sku, m.stripe_product_id FROM offers o JOIN stripe_product_mappings m ON m.offer_id = o.id WHERE o.id = ${offerId} OR o.sku = ${offerId}`;
  if (!o) throw notFound('Offer');
  if (!o.stripe_product_id) throw new AppError('precondition_failed', `Offer ${o.sku} has no linked Stripe product; link one (prod_…) first`);
  try {
    const product = await fetchSellableProduct(stripe, o.stripe_product_id);
    await tagProduct(stripe, product, o);
    await sql`UPDATE stripe_product_mappings SET sync_state = 'synced', synced_name = ${product.name}, last_error = NULL,
              attempts = attempts + 1, last_synced_at = now(), last_checked_at = now(), updated_at = now() WHERE offer_id = ${o.id}`;
    await audit(sql, actor, { action: 'stripe.product_verified', resourceType: 'offer', resourceId: o.id, detail: { stripeProductId: product.id } });
    return product.id;
  } catch (e) {
    // Missing/archived product: failed. Transient provider errors keep the current state.
    await sql`UPDATE stripe_product_mappings SET sync_state = CASE WHEN ${e instanceof AppError}::boolean THEN 'failed' ELSE sync_state END,
              last_error = ${errorText(e)}, attempts = attempts + 1, last_checked_at = now(), updated_at = now() WHERE offer_id = ${o.id}`;
    throw e;
  }
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}

export async function requestSync(sql: Sql, actor: Actor, opts: { offerId: string }) {
  requirePermission(actor, 'stripe:sync');
  await enqueueJob(sql, 'stripe.sync_offer', `stripe.sync_offer:${opts.offerId}:${Date.now()}`, { offerId: opts.offerId });
  await audit(sql, actor, { action: 'stripe.sync_requested', detail: opts });
}

/** The offer's linked Stripe Product for a Checkout line item. Never creates one. */
export async function linkedStripeProduct(db: Db, offerId: string): Promise<string> {
  const [m] = await db<{ stripe_product_id: string | null }[]>`SELECT stripe_product_id FROM stripe_product_mappings WHERE offer_id = ${offerId}`;
  if (!m?.stripe_product_id) throw new AppError('precondition_failed', 'This offer is not linked to a Stripe product and cannot be sold');
  return m.stripe_product_id;
}

export async function listMappings(db: Db) {
  return db<{ sku: string; offer_name: string; offer_status: string; stripe_product_id: string | null; sync_state: string; last_error: string | null; last_synced_at: Date | null }[]>`
    SELECT o.sku, o.name AS offer_name, o.status AS offer_status, pm.stripe_product_id, pm.sync_state, pm.last_error, pm.last_synced_at
    FROM offers o JOIN stripe_product_mappings pm ON pm.offer_id = o.id ORDER BY o.sku`;
}

/**
 * The one Stripe customer for a database customer. Reuses an existing Stripe customer with the
 * same email (the Stripe account is shared with other RePassCloud projects), else creates one.
 * Idempotent: the creation key is per database customer, and the link is write-once.
 */
export async function ensureStripeCustomer(sql: Sql, stripe: StripeClient, customerId: string, actor: Actor = systemActor('stripe-customer')): Promise<string> {
  const [c] = await sql<{ billing_email: string; display_name: string; organisation_name: string | null; country: string | null; tax_id: string | null; stripe_customer_id: string | null }[]>`
    SELECT billing_email, display_name, organisation_name, country, tax_id, stripe_customer_id FROM customers WHERE id = ${customerId}`;
  if (!c) throw notFound('Customer');
  if (c.stripe_customer_id) return c.stripe_customer_id;
  const found = await stripe.request<{ data: Array<{ id: string; created: number; deleted?: boolean }> }>('GET', '/v1/customers', { email: c.billing_email, limit: 100 });
  const existing = found.data.filter((x) => !x.deleted).sort((a, b) => a.created - b.created)[0];
  let stripeId: string;
  let reused = false;
  if (existing) {
    stripeId = existing.id;
    reused = true;
  } else {
    const params: Record<string, string | Record<string, string>> = {
      email: c.billing_email,
      name: c.organisation_name ?? c.display_name,
      metadata: { repass_customer_id: customerId, ...(c.tax_id ? { business_identifier: c.tax_id } : {}) },
    };
    if (c.country) params.address = { country: c.country };
    stripeId = (await stripe.request<{ id: string }>('POST', '/v1/customers', params, `repass-customer-${customerId}`)).id;
  }
  const [linked] = await sql<{ stripe_customer_id: string }[]>`
    UPDATE customers SET stripe_customer_id = coalesce(stripe_customer_id, ${stripeId}) WHERE id = ${customerId} RETURNING stripe_customer_id`
    .catch((e) => {
      throw new AppError('conflict', `Stripe customer ${stripeId} is already linked to another customer record: ${errorText(e)}`);
    });
  await audit(sql, actor, { action: reused ? 'stripe.customer_linked' : 'stripe.customer_created', resourceType: 'customer', resourceId: customerId, detail: { stripeCustomerId: linked!.stripe_customer_id } });
  return linked!.stripe_customer_id;
}

/** The Stripe Tax Rate for a flat, exclusive rate (e.g. GST 10% added on top). Created once. */
export async function ensureStripeTaxRate(sql: Sql, stripe: StripeClient, label: string, bps: number): Promise<string> {
  await sql`INSERT INTO stripe_tax_rates (id, display_name, tax_rate_bps) VALUES (${`txr_${label.replace(/[^A-Za-z0-9]/g, '').toLowerCase()}_${bps}`}, ${label}, ${bps})
            ON CONFLICT (display_name, tax_rate_bps) DO NOTHING`;
  const [r] = await sql<{ id: string; stripe_tax_rate_id: string | null }[]>`SELECT id, stripe_tax_rate_id FROM stripe_tax_rates WHERE display_name = ${label} AND tax_rate_bps = ${bps}`;
  if (r!.stripe_tax_rate_id) return r!.stripe_tax_rate_id;
  const created = await stripe.request<{ id: string }>('POST', '/v1/tax_rates', {
    display_name: label, percentage: (bps / 100).toFixed(2), inclusive: 'false', active: 'true',
    description: `${label} ${bps / 100}% (RePassCloud licensing)`, metadata: { repass_tax_rate_id: r!.id },
  }, `repass-taxrate-${r!.id}`);
  await sql`UPDATE stripe_tax_rates SET stripe_tax_rate_id = ${created.id} WHERE id = ${r!.id} AND stripe_tax_rate_id IS NULL`;
  const [after] = await sql<{ stripe_tax_rate_id: string }[]>`SELECT stripe_tax_rate_id FROM stripe_tax_rates WHERE id = ${r!.id}`;
  return after!.stripe_tax_rate_id;
}

export { StripeError };
