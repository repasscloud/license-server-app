// Stripe objects the store needs. Prices are NOT Stripe objects: they live only in PostgreSQL and
// Checkout sends the amount inline (price_data). Stripe holds one Product per offer (for
// reporting), one Customer per email, and one Tax Rate per flat rate/label.

import type { Db, Sql } from '../db/client.ts';
import { StripeClient, StripeError } from '../integrations/stripe.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { requirePermission, systemActor, type Actor } from './actor.ts';
import { audit } from './audit.ts';
import { enqueueJob } from './jobs.ts';

interface StripeProduct { id: string; name: string; active: boolean; metadata?: Record<string, string> }

export async function syncOffer(sql: Sql, stripe: StripeClient, offerId: string, actor: Actor = systemActor('stripe-sync')): Promise<string> {
  const [o] = await sql<{ id: string; sku: string; name: string; description: string; status: string; stripe_product_id: string | null; synced_name: string | null }[]>`
    SELECT o.id, o.sku, o.name, o.description, o.status, m.stripe_product_id, m.synced_name
    FROM offers o JOIN stripe_product_mappings m ON m.offer_id = o.id WHERE o.id = ${offerId}`;
  if (!o) throw notFound('Offer');
  try {
    let product: StripeProduct;
    const desired = { name: o.name, description: o.description || undefined, active: o.status !== 'archived', metadata: { repass_offer_id: o.id, repass_sku: o.sku } };
    if (o.stripe_product_id) {
      product = await stripe.request<StripeProduct>('POST', `/v1/products/${o.stripe_product_id}`, desired, `repass-product-update-${o.id}-${hashName(o.name, o.status)}`);
    } else {
      product = await stripe.request<StripeProduct>('POST', '/v1/products', desired, `repass-product-${o.id}`);
    }
    await sql`UPDATE stripe_product_mappings SET stripe_product_id = ${product.id}, sync_state = 'synced', synced_name = ${o.name}, last_error = NULL,
              attempts = attempts + 1, last_synced_at = now(), updated_at = now() WHERE offer_id = ${offerId}`;
    await audit(sql, actor, { action: 'stripe.product_synced', resourceType: 'offer', resourceId: offerId, detail: { stripeProductId: product.id } });
    return product.id;
  } catch (e) {
    await sql`UPDATE stripe_product_mappings SET sync_state = CASE WHEN stripe_product_id IS NULL THEN 'failed' ELSE sync_state END,
              last_error = ${errorText(e)}, attempts = attempts + 1, updated_at = now() WHERE offer_id = ${offerId}`;
    throw e;
  }
}

function hashName(name: string, status: string): string {
  let h = 2166136261;
  for (const ch of `${name}|${status}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h.toString(36);
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}

export async function requestSync(sql: Sql, actor: Actor, opts: { offerId: string }) {
  requirePermission(actor, 'stripe:sync');
  await enqueueJob(sql, 'stripe.sync_offer', `stripe.sync_offer:${opts.offerId}:${Date.now()}`, { offerId: opts.offerId });
  await audit(sql, actor, { action: 'stripe.sync_requested', detail: opts });
}

/** The offer's Stripe Product (created on first need). Checkout line items reference it. */
export async function ensureStripeProduct(sql: Sql, stripe: StripeClient, offerId: string): Promise<string> {
  const [m] = await sql<{ stripe_product_id: string | null }[]>`SELECT stripe_product_id FROM stripe_product_mappings WHERE offer_id = ${offerId}`;
  return m?.stripe_product_id ?? syncOffer(sql, stripe, offerId);
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
