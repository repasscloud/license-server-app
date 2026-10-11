// PostgreSQL -> Stripe catalogue synchronisation. The database is the master: we create Stripe
// Products/Prices from our offers/price versions, store the returned IDs, and never treat
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
    const productId = p.stripe_product_id ?? (await syncOffer(sql, stripe, p.offer_id, actor));
    if (p.stripe_price_id) {
      const remote = await stripe.request<StripePrice>('GET', `/v1/prices/${p.stripe_price_id}`);
      const drift = compare(p, productId, remote);
      await recordPriceCheck(sql, priceVersionId, remote, drift);
      return p.stripe_price_id;
    }
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
  if (r.currency !== p.currency) d.push(`currency ${r.currency} != ${p.currency}`);
  if (r.unit_amount !== p.unit_amount) d.push(`unit_amount ${r.unit_amount} != ${p.unit_amount}`);
  if (r.product !== productId) d.push(`product ${r.product} != ${productId}`);
  if ((r.recurring?.interval ?? null) !== p.recurring_interval) d.push(`interval ${r.recurring?.interval ?? 'none'} != ${p.recurring_interval ?? 'none'}`);
  if (p.recurring_interval && (r.recurring?.interval_count ?? 1) !== (p.recurring_interval_count ?? 1)) d.push('interval_count differs');
  if (p.tax_behavior !== 'unspecified' && r.tax_behavior !== p.tax_behavior) d.push(`tax_behavior ${r.tax_behavior} != ${p.tax_behavior}`);
  return d;
}

async function recordPriceCheck(sql: Sql, priceVersionId: string, remote: StripePrice, drift: string[]) {
  const [local] = await sql<{ status: string }[]>`SELECT status FROM price_versions WHERE id = ${priceVersionId}`;
  if (local?.status === 'active' && !remote.active) drift.push('price is archived in Stripe but active in the database');
  if (drift.length) {
    await sql`UPDATE stripe_price_mappings SET sync_state = 'drifted', drift_detail = ${sql.json({ problems: drift, checkedAt: new Date().toISOString() } as never)},
              stripe_active = ${remote.active}, last_checked_at = now(), updated_at = now() WHERE price_version_id = ${priceVersionId}`;
    await audit(sql, systemActor('stripe-drift'), { action: 'stripe.price_drift', resourceType: 'price_version', resourceId: priceVersionId, outcome: 'failure', detail: { problems: drift } });
  } else {
    await sql`UPDATE stripe_price_mappings SET sync_state = CASE WHEN sync_state = 'archived' THEN 'archived' ELSE 'synced' END, drift_detail = NULL,
              stripe_active = ${remote.active}, last_checked_at = now(), updated_at = now() WHERE price_version_id = ${priceVersionId}`;
  }
}

export async function archiveStripePrice(sql: Sql, stripe: StripeClient, priceVersionId: string): Promise<void> {
  const [m] = await sql<{ stripe_price_id: string | null }[]>`SELECT stripe_price_id FROM stripe_price_mappings WHERE price_version_id = ${priceVersionId}`;
  if (!m?.stripe_price_id) {
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

export { StripeError };
