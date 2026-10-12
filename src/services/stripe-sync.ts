// Stripe objects the store needs. Prices are NOT Stripe objects: they live only in PostgreSQL and
// Checkout sends the amount inline (price_data). Each offer has one Stripe Product:
// - normally created in Stripe first (stripe-catalogue script) and linked by its prod_ id (CSV
//   import or the admin link form);
// - otherwise created by the server at the offer's first checkout (ensureStripeProduct).
// The server never renames, re-describes or archives an existing Stripe product; it verifies
// products and tags them with repass_* metadata. Differences are reported, never "fixed".
// Stripe also holds one Customer per email and one Tax Rate per flat rate/label.

import type { Db, Sql } from '../db/client.ts';
import { StripeClient, StripeError } from '../integrations/stripe.ts';
import { AppError, conflict, invalid, notFound } from '../lib/errors.ts';
import { requirePermission, systemActor, type Actor } from './actor.ts';
import { audit } from './audit.ts';
import { enqueueJob } from './jobs.ts';

export interface StripeProduct { id: string; name: string; description?: string | null; active: boolean; metadata?: Record<string, string> }

export const PRODUCT_ID = /^prod_[A-Za-z0-9]{1,250}$/;

/** Read-only: the product, or null when it does not exist in this Stripe account/mode. */
export async function getStripeProduct(stripe: StripeClient, productId: string): Promise<StripeProduct | null> {
  try {
    return await stripe.request<StripeProduct>('GET', `/v1/products/${encodeURIComponent(productId)}`);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Read-only: products whose metadata matches any of the given key/value pairs (Stripe Search,
 * which is eventually consistent: a product created in the last minute may be missing).
 * Values must be wire identifiers (no quotes).
 */
export async function searchStripeProducts(stripe: StripeClient, metadata: Array<[string, string]>): Promise<StripeProduct[]> {
  const clauses = metadata.filter(([, v]) => /^[A-Za-z0-9_.-]{1,250}$/.test(v)).map(([k, v]) => `metadata['${k}']:'${v}'`);
  if (!clauses.length) return [];
  const r = await stripe.request<{ data: StripeProduct[] }>('GET', '/v1/products/search', { query: clauses.join(' OR '), limit: 20 });
  return r.data ?? [];
}

/** A product checkouts may reference: it exists in this Stripe account and is active. */
async function fetchSellableProduct(stripe: StripeClient, productId: string): Promise<StripeProduct> {
  const product = await getStripeProduct(stripe, productId);
  if (!product) throw invalid(`Stripe product ${productId} does not exist in this Stripe account (${stripe.livemode ? 'live' : 'test'} mode)`);
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
  if (!o.stripe_product_id) throw new AppError('precondition_failed', `Offer ${o.sku} has no Stripe product yet: link one (prod_…), or one is created at its first checkout`);
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

/**
 * The offer's Stripe Product for a Checkout line item: the linked one, or (PostgreSQL-first
 * offers) one created now from the database offer and linked. Safe under concurrency and retries:
 * - the mapping row is locked for the whole operation, so concurrent checkouts of the same
 *   offer wait and then reuse the product the first one linked;
 * - creation uses the idempotency key repass-product-<offerId>, so a retry within Stripe's
 *   idempotency window gets the same product back;
 * - before creating, Stripe is searched for a product already tagged repass_offer_id = offer,
 *   which recovers a product whose link was lost (e.g. the database write failed) after the
 *   idempotency window. Two tagged products is a conflict for an administrator to resolve.
 */
export async function ensureStripeProduct(sql: Sql, stripe: StripeClient, offerId: string, actor: Actor = systemActor('stripe-product')): Promise<string> {
  const [m] = await sql<{ stripe_product_id: string | null }[]>`SELECT stripe_product_id FROM stripe_product_mappings WHERE offer_id = ${offerId}`;
  if (m?.stripe_product_id) return m.stripe_product_id;
  try {
    return await sql.begin(async (tx) => {
      const [o] = await tx<{ id: string; sku: string; name: string; description: string; stripe_product_id: string | null }[]>`
        SELECT o.id, o.sku, o.name, o.description, pm.stripe_product_id
        FROM stripe_product_mappings pm JOIN offers o ON o.id = pm.offer_id WHERE pm.offer_id = ${offerId} FOR UPDATE OF pm`;
      if (!o) throw notFound('Offer');
      if (o.stripe_product_id) return o.stripe_product_id;
      const tagged = (await searchStripeProducts(stripe, [['repass_offer_id', o.id]])).filter((p) => p.metadata?.repass_offer_id === o.id);
      if (tagged.length > 1) {
        throw new AppError('precondition_failed', `Stripe has ${tagged.length} products tagged for offer ${o.sku} (${tagged.map((p) => p.id).join(', ')}); link the right one in the admin portal`);
      }
      let product = tagged[0];
      const created = !product;
      if (product && !product.active) throw new AppError('precondition_failed', `Stripe product ${product.id} for offer ${o.sku} is archived in Stripe; reactivate it or link another product`);
      product ??= await stripe.request<StripeProduct>('POST', '/v1/products', {
        name: o.name, description: o.description || undefined, metadata: { repass_offer_id: o.id, repass_sku: o.sku, sku: o.sku },
      }, `repass-product-${o.id}`);
      await tx`UPDATE stripe_product_mappings SET stripe_product_id = ${product.id}, sync_state = 'synced', synced_name = ${product.name}, last_error = NULL,
               attempts = attempts + 1, last_synced_at = now(), last_checked_at = now(), updated_at = now() WHERE offer_id = ${o.id}`;
      await audit(tx, actor, { action: created ? 'stripe.product_created' : 'stripe.product_relinked', resourceType: 'offer', resourceId: o.id, detail: { stripeProductId: product.id } });
      return product.id;
    });
  } catch (e) {
    await sql`UPDATE stripe_product_mappings SET last_error = ${errorText(e)}, attempts = attempts + 1, last_checked_at = now(), updated_at = now()
              WHERE offer_id = ${offerId} AND stripe_product_id IS NULL`.catch(() => undefined);
    throw e;
  }
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
