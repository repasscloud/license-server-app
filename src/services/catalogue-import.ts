// Catalogue import from the stripe-catalogue CSV. Only rows marked `_ls:import = yes` are
// imported; every license-server column uses the `_ls:` prefix, which the Stripe script ignores
// (its `_meta:` columns become Stripe metadata). Each selected row becomes one single-component
// offer: it is created or updated, its changed prices get new immutable versions, its Stripe
// product (`product_id`, filled by the Stripe script) is linked, and it is optionally activated.
// Every write goes through the normal audited services; dry run (the default) writes nothing.
// Products, majors, releases, edition policies and signing keys are prerequisites, not imported.

import type { Db, Sql } from '../db/client.ts';
import type { StripeClient } from '../integrations/stripe.ts';
import { parseCsv } from '../lib/csv.ts';
import { AppError, invalid } from '../lib/errors.ts';
import { requirePermission, type Actor } from './actor.ts';
import { audit } from './audit.ts';
import { createOffer, createPriceSet, missingCurrencies, setOfferStatus, STORE_CURRENCIES, updateOffer } from './catalogue.ts';
import { checkStripeProductLinkable, linkStripeProduct } from './stripe-sync.ts';

const MAX_ROWS = 500;

/** Every `_ls:` column the importer understands (anything else with the prefix is a typo). */
const LS_COLUMNS = new Set([
  'import', 'sku', 'name', 'description', 'product', 'major', 'edition', 'billing', 'term', 'interval', 'interval_count',
  'seats_per_unit', 'quantity_scales_seats', 'min_quantity', 'max_quantity', 'trial_days', 'grace_days', 'transfer_allowance',
  'refund_action', 'dispute_action', 'visibility', 'customer_kind', 'activate', 'stripe_product_id',
  ...STORE_CURRENCIES.flatMap((c) => [`price:${c}`, `tax_percent:${c}`, `tax_label:${c}`]),
]);

export interface ImportRowResult {
  line: number;
  sku: string;
  name: string;
  action: 'create' | 'update' | 'unchanged' | 'skipped' | 'error';
  changes: string[];
  warnings: string[];
  error?: string;
  offerId?: string;
}

export interface ImportResult {
  dryRun: boolean;
  selected: number;
  skipped: number;
  created: number;
  updated: number;
  unchanged: number;
  errors: number;
  rows: ImportRowResult[];
}

interface Desired {
  sku: string;
  name: string;
  description: string;
  product: string;
  major: number;
  edition: string;
  billing: 'one_time' | 'recurring' | 'free';
  visibility: 'public' | 'private';
  customerKind: 'any' | 'individual' | 'organisation';
  minQuantity: number;
  maxQuantity: number;
  component: {
    termType: 'perpetual' | 'subscription' | 'fixed_term';
    termInterval: string | null;
    termIntervalCount: number | null;
    seatsPerUnit: number | null;
    quantityScalesSeats: boolean;
    trialDays: number | null;
    graceDays: number;
    transferAllowance: number | null;
    refundAction: 'revoke' | 'review' | 'none';
    disputeAction: 'revoke' | 'review' | 'none';
  };
  priceInterval: string | null;
  priceIntervalCount: number | null;
  prices: Array<{ currency: string; unitAmount: number; taxRatePercent: number | null; taxLabel: string | null }>;
  stripeProductId: string | null;
  activate: boolean;
}

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0', '']);

function yesNo(v: string, column: string): boolean {
  const s = v.trim().toLowerCase();
  if (YES.has(s)) return true;
  if (NO.has(s)) return false;
  throw invalid(`${column}: use yes or no (got "${v}")`);
}

function int(v: string, column: string, opts: { min?: number; required?: boolean } = {}): number | null {
  if (v.trim() === '') {
    if (opts.required) throw invalid(`${column} is required`);
    return null;
  }
  if (!/^-?\d+$/.test(v.trim())) throw invalid(`${column} must be a whole number (got "${v}")`);
  const n = Number(v.trim());
  if (opts.min !== undefined && n < opts.min) throw invalid(`${column} must be at least ${opts.min}`);
  return n;
}

function oneOf<T extends string>(v: string, column: string, allowed: readonly T[], fallback?: T): T {
  const s = v.trim().toLowerCase();
  if (s === '' && fallback !== undefined) return fallback;
  if (!(allowed as readonly string[]).includes(s)) throw invalid(`${column} must be one of ${allowed.join(', ')} (got "${v}")`);
  return s as T;
}

/** Turn one CSV row into the offer it describes (defaults match the offer API). */
function desiredFromRow(v: Record<string, string>): Desired {
  const ls = (k: string) => v[`_ls:${k}`] ?? '';
  const sku = ls('sku') || v['_meta:sku'] || '';
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(sku)) throw invalid('SKU (_ls:sku, or _meta:sku) is required: letters, digits, _ . - (max 100)');
  const name = ls('name') || v.name || '';
  if (!name) throw invalid('Offer name (_ls:name, or name) is required');
  const billing = oneOf(ls('billing'), '_ls:billing', ['one_time', 'recurring', 'free'] as const);
  const termType = oneOf(ls('term'), '_ls:term', ['perpetual', 'subscription', 'fixed_term'] as const, billing === 'recurring' ? 'subscription' : 'perpetual');
  const needsInterval = billing === 'recurring' || termType === 'fixed_term';
  const interval = needsInterval ? oneOf(ls('interval'), '_ls:interval', ['day', 'week', 'month', 'year'] as const) : null;
  const intervalCount = needsInterval ? (int(ls('interval_count'), '_ls:interval_count', { min: 1 }) ?? 1) : null;
  if (!needsInterval && ls('interval')) throw invalid('_ls:interval only applies to recurring billing or fixed_term terms');
  const prices: Desired['prices'] = [];
  for (const c of STORE_CURRENCIES) {
    const amount = int(ls(`price:${c}`), `_ls:price:${c}`, { min: 0 });
    const taxText = ls(`tax_percent:${c}`);
    const taxLabel = ls(`tax_label:${c}`) || null;
    if (amount === null) {
      if (taxText || taxLabel) throw invalid(`_ls:tax_percent:${c} / _ls:tax_label:${c} need _ls:price:${c}`);
      continue;
    }
    const taxRatePercent = taxText ? Number(taxText) : null;
    if (taxRatePercent !== null && !Number.isFinite(taxRatePercent)) throw invalid(`_ls:tax_percent:${c} must be a number (got "${taxText}")`);
    if ((taxRatePercent === null) !== (taxLabel === null)) throw invalid(`_ls:tax_percent:${c} and _ls:tax_label:${c} go together`);
    prices.push({ currency: c, unitAmount: amount, taxRatePercent, taxLabel });
  }
  const stripeProductId = ls('stripe_product_id') || v.product_id || null;
  return {
    sku,
    name,
    description: ls('description') || v.description || '',
    product: ls('product') || (() => { throw invalid('_ls:product (the product id, e.g. cursedelete) is required'); })(),
    major: int(ls('major'), '_ls:major', { min: 1, required: true })!,
    edition: oneOf(ls('edition'), '_ls:edition', ['community', 'education', 'business', 'enterprise'] as const),
    billing,
    visibility: oneOf(ls('visibility'), '_ls:visibility', ['public', 'private'] as const, 'public'),
    customerKind: oneOf(ls('customer_kind'), '_ls:customer_kind', ['any', 'individual', 'organisation'] as const, 'any'),
    minQuantity: int(ls('min_quantity'), '_ls:min_quantity', { min: 1 }) ?? 1,
    maxQuantity: int(ls('max_quantity'), '_ls:max_quantity', { min: 1 }) ?? 1,
    component: {
      termType,
      termInterval: termType === 'fixed_term' ? interval : null,
      termIntervalCount: termType === 'fixed_term' ? intervalCount : null,
      seatsPerUnit: int(ls('seats_per_unit'), '_ls:seats_per_unit', { min: 1 }),
      quantityScalesSeats: yesNo(ls('quantity_scales_seats'), '_ls:quantity_scales_seats'),
      trialDays: int(ls('trial_days'), '_ls:trial_days', { min: 1 }),
      graceDays: int(ls('grace_days'), '_ls:grace_days', { min: 0 }) ?? 0,
      transferAllowance: int(ls('transfer_allowance'), '_ls:transfer_allowance', { min: 0 }),
      refundAction: oneOf(ls('refund_action'), '_ls:refund_action', ['revoke', 'review', 'none'] as const, 'revoke'),
      disputeAction: oneOf(ls('dispute_action'), '_ls:dispute_action', ['revoke', 'review', 'none'] as const, 'review'),
    },
    priceInterval: billing === 'recurring' ? interval : null,
    priceIntervalCount: billing === 'recurring' ? intervalCount : null,
    prices,
    stripeProductId,
    activate: yesNo(ls('activate'), '_ls:activate'),
  };
}

interface ExistingOffer {
  id: string; status: string; name: string; description: string; billing: string; visibility: string; customer_kind: string; min_quantity: number; max_quantity: number;
  stripe_product_id: string | null;
}

/** Differences in what an existing offer grants or how it bills: these are immutable. */
async function immutableDifferences(db: Db, o: ExistingOffer, d: Desired, editionPolicyId: string): Promise<string[]> {
  const comps = await db<{ edition_policy_id: string; term_type: string; term_interval: string | null; term_interval_count: number | null; seats_per_unit: number | null;
    quantity_scales_seats: boolean; trial_days: number | null; grace_days: number; transfer_allowance: number | null; refund_action: string; dispute_action: string }[]>`
    SELECT * FROM offer_entitlement_components WHERE offer_id = ${o.id} ORDER BY position`;
  if (comps.length !== 1) return ['it is a bundle (bundles are not imported)'];
  const c = comps[0]!;
  const diffs: Array<[string, unknown, unknown]> = [
    ['billing', o.billing, d.billing], ['customer_kind', o.customer_kind, d.customerKind], ['min_quantity', o.min_quantity, d.minQuantity], ['max_quantity', o.max_quantity, d.maxQuantity],
    ['edition', c.edition_policy_id, editionPolicyId], ['term', c.term_type, d.component.termType], ['term interval', c.term_interval, d.component.termInterval],
    ['term interval count', c.term_interval_count, d.component.termIntervalCount], ['seats_per_unit', c.seats_per_unit, d.component.seatsPerUnit],
    ['quantity_scales_seats', c.quantity_scales_seats, d.component.quantityScalesSeats], ['trial_days', c.trial_days, d.component.trialDays], ['grace_days', c.grace_days, d.component.graceDays],
    ['transfer_allowance', c.transfer_allowance, d.component.transferAllowance], ['refund_action', c.refund_action, d.component.refundAction], ['dispute_action', c.dispute_action, d.component.disputeAction],
  ];
  return diffs.filter(([, a, b]) => a !== b).map(([k, a, b]) => `${k} ${String(a)} → ${String(b)}`);
}

/** Currencies whose active price differs from the CSV (amount, tax or billing interval). */
async function changedPrices(db: Db, offerId: string | null, d: Desired): Promise<Desired['prices']> {
  if (!offerId) return d.prices;
  const active = await db<{ currency: string; unit_amount: number; tax_rate_bps: number | null; tax_label: string | null; recurring_interval: string | null; recurring_interval_count: number | null }[]>`
    SELECT DISTINCT ON (currency) currency, unit_amount, tax_rate_bps, tax_label, recurring_interval, recurring_interval_count
    FROM price_versions WHERE offer_id = ${offerId} AND status = 'active' ORDER BY currency, created_at DESC`;
  const byCurrency = new Map(active.map((p) => [p.currency, p]));
  return d.prices.filter((p) => {
    const cur = byCurrency.get(p.currency);
    if (!cur) return true;
    const bps = p.taxRatePercent === null ? null : Math.round(p.taxRatePercent * 100);
    return Number(cur.unit_amount) !== p.unitAmount || cur.tax_rate_bps !== bps || cur.tax_label !== p.taxLabel
      || cur.recurring_interval !== d.priceInterval || (cur.recurring_interval_count ?? (cur.recurring_interval ? 1 : null)) !== d.priceIntervalCount;
  });
}

const money = (p: { currency: string; unitAmount: number }) => `${p.currency.toUpperCase()} ${p.unitAmount}`;

async function importRow(sql: Sql, stripe: StripeClient, actor: Actor, d: Desired, result: ImportRowResult, dryRun: boolean): Promise<void> {
  const [ep] = await sql<{ id: string }[]>`
    SELECT ep.id FROM product_edition_policies ep JOIN product_majors m ON m.id = ep.product_major_id JOIN products p ON p.id = m.product_id
    WHERE p.slug = ${d.product} AND m.major_version = ${d.major} AND ep.edition_id = ${d.edition} AND ep.status = 'active'`;
  if (!ep) throw invalid(`No active ${d.edition} edition policy for ${d.product} v${d.major}: create the product, major and edition policy first`);
  const [existing] = await sql<ExistingOffer[]>`
    SELECT o.id, o.status, o.name, o.description, o.billing, o.visibility, o.customer_kind, o.min_quantity, o.max_quantity, m.stripe_product_id
    FROM offers o LEFT JOIN stripe_product_mappings m ON m.offer_id = o.id WHERE o.sku = ${d.sku}`;
  if (existing?.status === 'archived') throw invalid(`Offer ${d.sku} is archived; use a new SKU`);
  if (existing) {
    const diffs = await immutableDifferences(sql, existing, d, ep.id);
    if (diffs.length) throw invalid(`Offer ${d.sku} exists and what it grants or how it bills cannot change (${diffs.join('; ')}); use a new SKU`);
  }
  if (d.maxQuantity < d.minQuantity) throw invalid('_ls:max_quantity must be >= _ls:min_quantity');

  // Each step is recorded once it has happened (or, in a dry run, once it has been checked).
  const step = async (label: string, run: () => Promise<unknown>) => {
    if (!dryRun) await run();
    result.changes.push(label);
  };

  // 1. Offer (create, or update the mutable fields).
  let offerId = existing?.id ?? null;
  const updates: Record<string, string> = {};
  if (!existing) {
    result.action = 'create';
    await step(`create offer (${d.product} v${d.major} ${d.edition}, ${d.billing}, ${d.component.termType})`, async () => {
      const created = (await createOffer(sql, actor, {
        sku: d.sku, name: d.name, description: d.description, kind: 'single', billing: d.billing, visibility: d.visibility, customerKind: d.customerKind,
        minQuantity: d.minQuantity, maxQuantity: d.maxQuantity, components: [{ editionPolicyId: ep.id, ...d.component }],
      })) as unknown as { id: string };
      offerId = created.id;
    });
  } else {
    if (existing.name !== d.name) updates.name = d.name;
    if (existing.description !== d.description) updates.description = d.description;
    if (existing.visibility !== d.visibility) updates.visibility = d.visibility;
    if (Object.keys(updates).length) await step(`update ${Object.keys(updates).join(', ')}`, () => updateOffer(sql, actor, existing.id, updates));
  }
  if (offerId) result.offerId = offerId;

  // 2. Prices: a new immutable version only for currencies that changed.
  const changed = await changedPrices(sql, existing?.id ?? null, d);
  if (changed.length) {
    await step(`set prices ${changed.map(money).join(', ')}`, () => createPriceSet(sql, actor, offerId!, {
      recurringInterval: d.priceInterval, recurringIntervalCount: d.priceIntervalCount,
      prices: changed.map((p) => ({ currency: p.currency, unitAmount: p.unitAmount, taxRatePercent: p.taxRatePercent, taxLabel: p.taxLabel })),
    }));
  }
  const priced = new Set(d.prices.map((p) => p.currency));
  const missing = STORE_CURRENCIES.filter((c) => !priced.has(c));
  if (missing.length) result.warnings.push(`no price for ${missing.join(', ').toUpperCase()} in the CSV`);

  // 3. Stripe product (filled into product_id by the stripe-catalogue script).
  if (!d.stripeProductId) {
    if (!existing?.stripe_product_id) result.warnings.push('no product_id yet: run the Stripe script first; the offer cannot be activated until it is linked');
  } else if (d.stripeProductId !== existing?.stripe_product_id) {
    const productId = d.stripeProductId;
    if (dryRun) await checkStripeProductLinkable(sql, stripe, existing?.id ?? null, productId);
    await step(`link Stripe product ${productId}${existing?.stripe_product_id ? ` (was ${existing.stripe_product_id})` : ''}`,
      () => linkStripeProduct(sql, stripe, actor, offerId!, { stripeProductId: productId }));
  }

  // 4. Activation (never deactivates: archiving is a deliberate admin action). In a dry run
  // the activation checks run after the import, so a missing link or price surfaces on apply.
  if (d.activate && existing?.status !== 'active') {
    if (dryRun && !d.stripeProductId && !existing?.stripe_product_id) throw invalid('_ls:activate = yes needs a linked Stripe product (product_id)');
    const stillMissing = existing ? (await missingCurrencies(sql, existing.id)).filter((c) => !priced.has(c)) : missing;
    if (dryRun && stillMissing.length) throw invalid(`_ls:activate = yes needs a price in every store currency; missing ${stillMissing.join(', ').toUpperCase()}`);
    await step('activate', () => setOfferStatus(sql, actor, offerId!, 'active'));
  }
  if (result.action !== 'create') result.action = result.changes.length ? 'update' : 'unchanged';
}

/**
 * Import the CSV. `apply: false` (the default) validates every selected row, checks Stripe
 * products (read-only) and reports what would change; `apply: true` performs it. Rows are
 * independent: one failing row does not stop the others, and re-running is safe.
 */
export async function importCatalogue(sql: Sql, stripe: StripeClient, actor: Actor, raw: unknown): Promise<ImportResult> {
  requirePermission(actor, 'products:write');
  requirePermission(actor, 'prices:write');
  const input = typeof raw === 'object' && raw !== null ? (raw as { csv?: unknown; apply?: unknown }) : {};
  if (typeof input.csv !== 'string' || !input.csv.trim()) throw invalid('csv (the CSV file contents) is required');
  if (input.apply !== undefined && typeof input.apply !== 'boolean') throw invalid('apply must be true or false');
  const dryRun = input.apply !== true;
  let table;
  try {
    table = parseCsv(input.csv);
  } catch (e) {
    throw invalid(`CSV: ${(e as Error).message}`);
  }
  if (!table.headers.includes('_ls:import')) throw invalid('The CSV has no _ls:import column: mark the rows to import with _ls:import = yes');
  const unknown = table.headers.filter((h) => h.startsWith('_ls:') && !LS_COLUMNS.has(h.slice(4)));
  if (unknown.length) throw invalid(`Unknown license-server column(s): ${unknown.join(', ')}`);
  if (table.rows.length > MAX_ROWS) throw invalid(`At most ${MAX_ROWS} rows per import`);

  const out: ImportResult = { dryRun, selected: 0, skipped: 0, created: 0, updated: 0, unchanged: 0, errors: 0, rows: [] };
  const seenSku = new Map<string, number>();
  const seenProduct = new Map<string, number>();
  for (const row of table.rows) {
    const v = row.values;
    const r: ImportRowResult = { line: row.line, sku: v['_ls:sku'] || v['_meta:sku'] || '', name: v['_ls:name'] || v.name || '', action: 'skipped', changes: [], warnings: [] };
    out.rows.push(r);
    try {
      if (!yesNo(v['_ls:import'] ?? '', '_ls:import')) {
        out.skipped++;
        continue;
      }
    } catch (e) {
      r.action = 'error';
      r.error = (e as Error).message;
      out.errors++;
      continue;
    }
    out.selected++;
    try {
      const d = desiredFromRow(v);
      r.sku = d.sku;
      r.name = d.name;
      if (seenSku.has(d.sku)) throw invalid(`SKU ${d.sku} is also on line ${seenSku.get(d.sku)}`);
      seenSku.set(d.sku, row.line);
      if (d.stripeProductId) {
        if (seenProduct.has(d.stripeProductId)) throw invalid(`Stripe product ${d.stripeProductId} is also on line ${seenProduct.get(d.stripeProductId)} (one product per offer)`);
        seenProduct.set(d.stripeProductId, row.line);
      }
      await importRow(sql, stripe, actor, d, r, dryRun);
      if (r.action === 'create') out.created++;
      else if (r.action === 'update') out.updated++;
      else out.unchanged++;
    } catch (e) {
      const partial = !dryRun && r.changes.length ? ` (already applied: ${r.changes.join('; ')}; re-run after fixing, completed steps are not repeated)` : '';
      r.action = 'error';
      r.error = (e instanceof AppError || e instanceof Error ? e.message : String(e)) + partial;
      out.errors++;
    }
  }
  if (!dryRun) {
    await audit(sql, actor, { action: 'catalogue.imported', resourceType: 'catalogue', detail: {
      selected: out.selected, skipped: out.skipped, created: out.created, updated: out.updated, unchanged: out.unchanged, errors: out.errors,
      skus: out.rows.filter((x) => x.action !== 'skipped').map((x) => `${x.sku}:${x.action}`),
    } });
  }
  return out;
}
