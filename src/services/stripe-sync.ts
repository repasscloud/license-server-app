// PostgreSQL <-> Stripe catalogue mapping. Either the server creates Stripe Products/Prices from
// our offers/price versions, or the owner registers a Price already made in Stripe, which is
// verified against the database version before it can be sold. Either way we never treat
// changes made directly in Stripe as authorised catalogue edits — they are reported as drift
// and repaired only by explicit administrator action.

import type { Db, Sql } from '../db/client.ts';
import { StripeClient, StripeError } from '../integrations/stripe.ts';
import { AppError, conflict, notFound } from '../lib/errors.ts';
import { requirePermission, systemActor, type Actor } from './actor.ts';
import { audit } from './audit.ts';
import { enqueueJob } from './jobs.ts';

interface StripeProduct { id: string; name: string; active: boolean; metadata?: Record<string, string> }
interface StripePrice {
  id: string; active: boolean; currency: string; unit_amount: number | null; product: string;
  recurring: { interval: string; interval_count: number } | null; tax_behavior: string | null; metadata?: Record<string, string>;
  currency_options?: Record<string, { unit_amount: number | null; tax_behavior?: string | null }> | null;
}

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

/** Create (or verify) the immutable Stripe Price for one price version. Idempotent. */
export async function syncPrice(sql: Sql, stripe: StripeClient, priceVersionId: string, actor: Actor = systemActor('stripe-sync')): Promise<string> {
  const [p] = await sql<{ id: string; offer_id: string; currency: string; unit_amount: number; recurring_interval: string | null; recurring_interval_count: number | null; tax_behavior: string;
    stripe_price_id: string | null; idempotency_key: string; stripe_product_id: string | null }[]>`
    SELECT pv.id, pv.offer_id, pv.currency, pv.unit_amount, pv.recurring_interval, pv.recurring_interval_count, pv.tax_behavior,
           sm.stripe_price_id, sm.idempotency_key, pm.stripe_product_id
    FROM price_versions pv JOIN stripe_price_mappings sm ON sm.price_version_id = pv.id JOIN stripe_product_mappings pm ON pm.offer_id = pv.offer_id
    WHERE pv.id = ${priceVersionId}`;
  if (!p) throw notFound('Price version');
  try {
    if (p.stripe_price_id) {
      // Existing mapping: either created by us earlier, or a price the owner made in Stripe and
      // registered. An offer with no product mapping adopts the registered price's product.
      const remote = await stripe.request<StripePrice>('GET', `/v1/prices/${p.stripe_price_id}`, { expand: ['currency_options'] });
      let productId = p.stripe_product_id;
      if (!productId) {
        await sql`UPDATE stripe_product_mappings SET stripe_product_id = ${remote.product}, sync_state = 'synced', last_error = NULL, last_synced_at = now(), updated_at = now()
                  WHERE offer_id = ${p.offer_id} AND stripe_product_id IS NULL`;
        const [pm] = await sql<{ stripe_product_id: string }[]>`SELECT stripe_product_id FROM stripe_product_mappings WHERE offer_id = ${p.offer_id}`;
        productId = pm!.stripe_product_id;
        await audit(sql, actor, { action: 'stripe.product_adopted', resourceType: 'offer', resourceId: p.offer_id, detail: { stripeProductId: productId, fromPrice: remote.id } });
      }
      const drift = compare(p, productId, remote);
      const wasPending = await recordPriceCheck(sql, priceVersionId, remote, drift);
      if (wasPending && !drift.length) await audit(sql, actor, { action: 'stripe.price_registered', resourceType: 'price_version', resourceId: priceVersionId, detail: { stripePriceId: remote.id } });
      return p.stripe_price_id;
    }
    const productId = p.stripe_product_id ?? (await syncOffer(sql, stripe, p.offer_id, actor));
    const params: Record<string, string | number | Record<string, string | number>> = {
      product: productId,
      currency: p.currency,
      unit_amount: p.unit_amount,
      metadata: { repass_price_version_id: p.id, repass_offer_id: p.offer_id },
    };
    if (p.tax_behavior !== 'unspecified') params.tax_behavior = p.tax_behavior;
    if (p.recurring_interval) params.recurring = { interval: p.recurring_interval, interval_count: p.recurring_interval_count ?? 1 };
    const price = await stripe.request<StripePrice>('POST', '/v1/prices', params, p.idempotency_key);
    const drift = compare(p, productId, price);
    if (drift.length) throw new AppError('conflict', `Stripe returned a price that does not match the database: ${drift.join('; ')}`);
    await sql`UPDATE stripe_price_mappings SET stripe_price_id = ${price.id}, sync_state = 'synced', stripe_active = ${price.active}, last_error = NULL,
              attempts = attempts + 1, last_synced_at = now(), last_checked_at = now(), drift_detail = NULL, updated_at = now() WHERE price_version_id = ${priceVersionId}`;
    await audit(sql, actor, { action: 'stripe.price_synced', resourceType: 'price_version', resourceId: priceVersionId, detail: { stripePriceId: price.id, stripeProductId: productId } });
    return price.id;
  } catch (e) {
    await sql`UPDATE stripe_price_mappings SET sync_state = CASE WHEN stripe_price_id IS NULL THEN 'failed' ELSE sync_state END,
              last_error = ${errorText(e)}, attempts = attempts + 1, updated_at = now() WHERE price_version_id = ${priceVersionId}`;
    throw e;
  }
}

function compare(p: { currency: string; unit_amount: number; recurring_interval: string | null; recurring_interval_count: number | null; tax_behavior: string }, productId: string, r: StripePrice): string[] {
  const d: string[] = [];
  // The version's currency is either the price's main currency or one of its currency_options.
  const option = r.currency === p.currency ? { unit_amount: r.unit_amount, tax_behavior: r.tax_behavior } : r.currency_options?.[p.currency];
  if (!option) d.push(`Stripe price has no ${p.currency.toUpperCase()} amount (currency ${r.currency}${r.currency_options ? `, options ${Object.keys(r.currency_options).join('/')}` : ''})`);
  else if (option.unit_amount !== p.unit_amount) d.push(`unit_amount ${option.unit_amount} != ${p.unit_amount} (${p.currency.toUpperCase()})`);
  if (r.product !== productId) d.push(`product ${r.product} != ${productId}`);
  if ((r.recurring?.interval ?? null) !== p.recurring_interval) d.push(`interval ${r.recurring?.interval ?? 'none'} != ${p.recurring_interval ?? 'none'}`);
  if (p.recurring_interval && (r.recurring?.interval_count ?? 1) !== (p.recurring_interval_count ?? 1)) d.push('interval_count differs');
  const tb = option?.tax_behavior ?? r.tax_behavior;
  if (p.tax_behavior !== 'unspecified' && tb !== p.tax_behavior) d.push(`tax_behavior ${tb} != ${p.tax_behavior}`);
  return d;
}

/** Returns true when this was the first verification of a registered (pending) mapping. */
async function recordPriceCheck(sql: Sql, priceVersionId: string, remote: StripePrice, drift: string[]): Promise<boolean> {
  const [local] = await sql<{ status: string; sync_state: string }[]>`
    SELECT pv.status, sm.sync_state FROM price_versions pv JOIN stripe_price_mappings sm ON sm.price_version_id = pv.id WHERE pv.id = ${priceVersionId}`;
  if (local?.status === 'active' && !remote.active) drift.push('price is archived in Stripe but active in the database');
  if (drift.length) {
    await sql`UPDATE stripe_price_mappings SET sync_state = 'drifted', drift_detail = ${sql.json({ problems: drift, checkedAt: new Date().toISOString() } as never)},
              stripe_active = ${remote.active}, last_checked_at = now(), updated_at = now() WHERE price_version_id = ${priceVersionId}`;
    await audit(sql, systemActor('stripe-drift'), { action: 'stripe.price_drift', resourceType: 'price_version', resourceId: priceVersionId, outcome: 'failure', detail: { problems: drift } });
  } else {
    await sql`UPDATE stripe_price_mappings SET sync_state = CASE WHEN sync_state = 'archived' THEN 'archived' ELSE 'synced' END, drift_detail = NULL, last_error = NULL,
              stripe_active = ${remote.active}, last_checked_at = now(), last_synced_at = coalesce(last_synced_at, now()), updated_at = now() WHERE price_version_id = ${priceVersionId}`;
  }
  return local?.sync_state === 'pending';
}

export async function archiveStripePrice(sql: Sql, stripe: StripeClient, priceVersionId: string): Promise<void> {
  const [m] = await sql<{ stripe_price_id: string | null }[]>`SELECT stripe_price_id FROM stripe_price_mappings WHERE price_version_id = ${priceVersionId}`;
  if (!m?.stripe_price_id) {
    await sql`UPDATE stripe_price_mappings SET sync_state = 'archived', updated_at = now() WHERE price_version_id = ${priceVersionId}`;
    return;
  }
  // A multi-currency Stripe price still selling another currency must stay active in Stripe.
  const shared = await sql`SELECT 1 FROM stripe_price_mappings sm JOIN price_versions pv ON pv.id = sm.price_version_id
                           WHERE sm.stripe_price_id = ${m.stripe_price_id} AND pv.id <> ${priceVersionId} AND pv.status <> 'archived'`;
  if (shared.length) {
    await sql`UPDATE stripe_price_mappings SET sync_state = 'archived', updated_at = now() WHERE price_version_id = ${priceVersionId}`;
    return;
  }
  // Archiving a Stripe Price stops new purchases; existing subscriptions keep billing on it.
  await stripe.request('POST', `/v1/prices/${m.stripe_price_id}`, { active: false }, `repass-price-archive-${priceVersionId}`);
  await sql`UPDATE stripe_price_mappings SET sync_state = 'archived', stripe_active = false, updated_at = now() WHERE price_version_id = ${priceVersionId}`;
}

/** Check all synced/drifted mappings against Stripe (bounded batch, oldest-checked first). */
export async function checkDrift(sql: Sql, stripe: StripeClient, limit = 10): Promise<{ checked: number; drifted: number }> {
  const rows = await sql<{ price_version_id: string }[]>`
    SELECT price_version_id FROM stripe_price_mappings WHERE stripe_price_id IS NOT NULL AND sync_state IN ('synced', 'drifted')
    ORDER BY last_checked_at NULLS FIRST LIMIT ${limit}`;
  let drifted = 0;
  for (const r of rows) {
    await syncPrice(sql, stripe, r.price_version_id);
    const [m] = await sql<{ sync_state: string }[]>`SELECT sync_state FROM stripe_price_mappings WHERE price_version_id = ${r.price_version_id}`;
    if (m?.sync_state === 'drifted') drifted++;
  }
  return { checked: rows.length, drifted };
}

/**
 * Explicit repair of a drifted/failed mapping:
 *  - 'retry'      re-run creation/verification (failed mappings)
 *  - 'reactivate' set the Stripe price active again (someone archived it in Stripe)
 *  - 'recreate'   abandon the mapped Stripe price and create a fresh one for this version
 */
export async function repairPriceMapping(sql: Sql, stripe: StripeClient, actor: Actor, priceVersionId: string, action: 'retry' | 'reactivate' | 'recreate') {
  requirePermission(actor, 'stripe:sync');
  const [m] = await sql<{ stripe_price_id: string | null; sync_state: string }[]>`SELECT stripe_price_id, sync_state FROM stripe_price_mappings WHERE price_version_id = ${priceVersionId}`;
  if (!m) throw notFound('Price mapping');
  if (action === 'reactivate') {
    if (!m.stripe_price_id) throw conflict('Nothing to reactivate');
    await stripe.request('POST', `/v1/prices/${m.stripe_price_id}`, { active: true }, `repass-price-reactivate-${priceVersionId}-${Date.now()}`);
  } else if (action === 'recreate') {
    await sql`UPDATE stripe_price_mappings SET stripe_price_id = NULL, sync_state = 'pending', idempotency_key = ${`repass-price-${priceVersionId}-r${Date.now()}`}, drift_detail = NULL
              WHERE price_version_id = ${priceVersionId}`.catch((e) => {
      throw new AppError('conflict', `Cannot recreate: ${errorText(e)}`);
    });
  }
  await audit(sql, actor, { action: `stripe.price_repair_${action}`, resourceType: 'price_version', resourceId: priceVersionId, detail: { previous: m } });
  return { stripePriceId: await syncPrice(sql, stripe, priceVersionId, actor) };
}

export async function requestSync(sql: Sql, actor: Actor, opts: { offerId?: string; priceVersionId?: string }) {
  requirePermission(actor, 'stripe:sync');
  if (opts.priceVersionId) await enqueueJob(sql, 'stripe.sync_price', `stripe.sync_price:${opts.priceVersionId}:${Date.now()}`, { priceVersionId: opts.priceVersionId });
  if (opts.offerId) await enqueueJob(sql, 'stripe.sync_offer', `stripe.sync_offer:${opts.offerId}:${Date.now()}`, { offerId: opts.offerId });
  await audit(sql, actor, { action: 'stripe.sync_requested', detail: opts });
}

export async function listMappings(db: Db) {
  return db<Record<string, unknown>[]>`
    SELECT o.sku, o.name AS offer_name, pv.id AS price_version_id, pv.currency, pv.unit_amount, pv.recurring_interval, pv.status AS price_status,
           sm.stripe_price_id, sm.sync_state, sm.last_error, sm.drift_detail, sm.last_checked_at, pm.stripe_product_id
    FROM price_versions pv JOIN offers o ON o.id = pv.offer_id JOIN stripe_price_mappings sm ON sm.price_version_id = pv.id
    JOIN stripe_product_mappings pm ON pm.offer_id = o.id ORDER BY o.sku, pv.created_at DESC`;
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
