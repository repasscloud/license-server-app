// Catalogue CSV import: upload -> preview -> confirmed apply (admin UI and admin API alike).
//
// The file is the stripe-catalogue products.csv. Rows with `_ls:import = yes` are imported; the
// rest (e.g. books sold elsewhere) are skipped. License-server columns use the `_ls:` prefix,
// which the Stripe script ignores. Each selected row is one offer (SKU) for one product major
// edition; the product, major and edition policy are created when missing (from explicit
// columns, never invented defaults) and otherwise verified against the CSV.
//
// Reconciliation rule: PostgreSQL is the catalogue master and the CSV is how it is fed. The
// importer never "fixes" Stripe or overwrites settled PostgreSQL facts: whenever the CSV, the
// database and Stripe disagree on something the import may not change (a Stripe product's name,
// status or SKU tag, an offer's existing Stripe link, what an offer grants, a product's name…)
// the row is rejected with both values so an administrator can decide which side is wrong.
//
// Preview (planImport) reads PostgreSQL and Stripe and writes nothing but the import record.
// Apply recomputes the plan, refuses if it differs from what the administrator reviewed, then
// performs each step through the normal audited catalogue services as that administrator. Steps
// are idempotent: after a partial failure, previewing the same CSV again shows only what is left.

import type { Db, Sql } from '../db/client.ts';
import { sha256Hex } from '../crypto/hashing.ts';
import { computeEffectivePolicy, validateOfferShape, validatePolicy, validatePrice, type PolicyRows } from '../domain/policy.ts';
import { getProtocol, implementedProtocolIds } from '../domain/protocols.ts';
import { StripeError, type StripeClient } from '../integrations/stripe.ts';
import { parseCsv } from '../lib/csv.ts';
import { AppError, conflict, invalid, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { requirePermission, type Actor } from './actor.ts';
import { audit } from './audit.ts';
import {
  ComponentInput, createMajor, createOffer, createPriceSet, createProduct, setOfferStatus, STORE_CURRENCIES, updateOffer, upsertEditionPolicy,
} from './catalogue.ts';
import { getStripeProduct, linkStripeProduct, PRODUCT_ID, searchStripeProducts, type StripeProduct } from './stripe-sync.ts';

const MAX_ROWS = 500;
const MAX_CSV_BYTES = 512 * 1024;
const WIRE_SLUG = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SKU = /^[A-Za-z0-9_.-]{1,100}$/;

/** Every `_ls:` column the importer understands (anything else with the prefix is a typo). */
export const LS_COLUMNS = new Set([
  'import', 'sku', 'name', 'description', 'stripe_product_id',
  'product', 'product_name', 'major', 'protocol', 'major_transfer_allowance', 'major_activation_key_email',
  'edition', 'edition_name', 'edition_activation_model', 'edition_ownership', 'edition_offline_policy', 'edition_certificate_lifetime_days', 'edition_transfer_allowance',
  'billing', 'term', 'interval', 'interval_count', 'seats_per_unit', 'quantity_scales_seats', 'min_quantity', 'max_quantity', 'trial_days', 'grace_days',
  'transfer_allowance', 'refund_action', 'dispute_action', 'visibility', 'customer_kind', 'activate',
  ...STORE_CURRENCIES.flatMap((c) => [`price:${c}`, `tax_percent:${c}`, `tax_label:${c}`]),
]);

// ---------------------------------------------------------------------------------------------
// Public plan/result shapes (stored in catalogue_imports and returned by the API)
// ---------------------------------------------------------------------------------------------

export type RowAction = 'create' | 'link' | 'update' | 'unchanged' | 'skipped' | 'error';

export interface PlanRow {
  line: number;
  sku: string;
  name: string;
  action: RowAction;
  offerId: string | null;
  stripeProductId: string | null;
  changes: string[];
  warnings: string[];
  errors: string[];
}

export interface PlanEntity {
  kind: 'product' | 'major' | 'edition_policy';
  key: string;
  label: string;
  action: 'create' | 'unchanged' | 'error';
  lines: number[];
  changes: string[];
  errors: string[];
}

export interface ImportSummary {
  rows: number; selected: number; skipped: number;
  create: number; link: number; update: number; unchanged: number; errors: number;
  entitiesToCreate: number; entityErrors: number;
}

export interface ImportPlan {
  stripeMode: 'test' | 'live';
  entities: PlanEntity[];
  rows: PlanRow[];
  summary: ImportSummary;
}

export interface ImportResult {
  entities: Array<{ key: string; label: string; outcome: 'created' | 'unchanged' | 'error' | 'not_attempted'; error?: string }>;
  rows: Array<{ line: number; sku: string; outcome: 'applied' | 'unchanged' | 'skipped' | 'error' | 'partial'; done: string[]; error?: string; offerId?: string }>;
  counts: { applied: number; unchanged: number; skipped: number; errors: number; partial: number; entitiesCreated: number };
}

export interface CatalogueImport {
  id: string;
  status: 'previewed' | 'applying' | 'applied' | 'failed';
  fileName: string | null;
  csvSha256: string;
  stripeMode: 'test' | 'live';
  summary: ImportSummary;
  plan: ImportPlan;
  result: ImportResult | null;
  createdBy: string;
  createdAt: Date;
  appliedBy: string | null;
  appliedAt: Date | null;
}

// ---------------------------------------------------------------------------------------------
// Row parsing
// ---------------------------------------------------------------------------------------------

type Ownership = 'individual' | 'organisation' | 'institution';
type ActivationModel = 'none' | 'device_seats';
type OfflinePolicy = 'indefinite' | 'periodic_check';
type Interval = 'day' | 'week' | 'month' | 'year';

interface PriceSpec { currency: string; unitAmount: number; taxRatePercent: number | null; taxLabel: string | null }

interface RowSpec {
  line: number;
  sku: string;
  name: string;
  description: string;
  stripe: { productId: string | null; name: string; description: string; active: boolean | null; metaSku: string };
  product: { slug: string; name: string | null };
  major: { version: number; protocol: string | null; transferAllowance: number | null; activationKeyEmail: boolean | null };
  edition: {
    id: string; displayName: string | null; activationModel: ActivationModel | null; ownership: Ownership | null; offlinePolicy: OfflinePolicy | null;
    /** undefined = column blank (not specified); null = explicitly none/default. */
    certificateLifetimeSeconds: number | null | undefined;
    transferAllowance: number | null | undefined;
  };
  billing: 'one_time' | 'recurring' | 'free';
  visibility: 'public' | 'private';
  customerKind: 'any' | 'individual' | 'organisation';
  minQuantity: number;
  maxQuantity: number;
  component: {
    termType: 'perpetual' | 'subscription' | 'fixed_term';
    termInterval: Interval | null;
    termIntervalCount: number | null;
    seatsPerUnit: number | null;
    quantityScalesSeats: boolean;
    trialDays: number | null;
    graceDays: number;
    transferAllowance: number | null;
    refundAction: 'revoke' | 'review' | 'none';
    disputeAction: 'revoke' | 'review' | 'none';
  };
  priceInterval: Interval | null;
  priceIntervalCount: number | null;
  prices: PriceSpec[];
  activate: boolean;
}

const YES = new Set(['yes', 'y', 'true', '1']);
const NO = new Set(['no', 'n', 'false', '0']);

/** Reads one CSV row, collecting every problem instead of stopping at the first. */
class RowReader {
  readonly errors: string[] = [];
  private readonly v: Record<string, string>;
  constructor(v: Record<string, string>) {
    this.v = v;
  }

  raw(col: string): string {
    return (this.v[col] ?? '').trim();
  }

  ls(k: string): string {
    return this.raw(`_ls:${k}`);
  }

  fail(msg: string): null {
    this.errors.push(msg);
    return null;
  }

  yesNo(col: string, blank: boolean | null): boolean | null {
    const s = this.raw(col).toLowerCase();
    if (s === '') return blank;
    if (YES.has(s)) return true;
    if (NO.has(s)) return false;
    return this.fail(`${col}: use yes or no (got "${this.raw(col)}")`);
  }

  int(col: string, opts: { min?: number; max?: number; required?: boolean } = {}): number | null {
    const s = this.raw(col);
    if (s === '') return opts.required ? this.fail(`${col} is required`) : null;
    if (!/^-?\d+$/.test(s)) return this.fail(`${col} must be a whole number (got "${s}")`);
    const n = Number(s);
    if (opts.min !== undefined && n < opts.min) return this.fail(`${col} must be at least ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) return this.fail(`${col} must be at most ${opts.max}`);
    return n;
  }

  oneOf<T extends string>(col: string, allowed: readonly T[], fallback?: T): T | null {
    const s = this.raw(col).toLowerCase();
    if (s === '') return fallback ?? null;
    if (!(allowed as readonly string[]).includes(s)) return this.fail(`${col} must be one of ${allowed.join(', ')} (got "${this.raw(col)}")`);
    return s as T;
  }
}

function parseRow(line: number, v: Record<string, string>): { spec: RowSpec | null; sku: string; name: string; errors: string[] } {
  const r = new RowReader(v);
  const sku = r.ls('sku') || r.raw('_meta:sku');
  const name = r.ls('name') || r.raw('name');
  if (!SKU.test(sku)) r.fail('SKU (_ls:sku, or _meta:sku) is required: letters, digits, _ . - (max 100)');
  if (!name) r.fail('Offer name (_ls:name, or name) is required');
  if (name.length > 200) r.fail('Offer name is longer than 200 characters');

  const productId = r.raw('product_id');
  const lsProductId = r.ls('stripe_product_id');
  if (productId && lsProductId && productId !== lsProductId) r.fail(`product_id ${productId} and _ls:stripe_product_id ${lsProductId} disagree`);
  const stripeProductId = lsProductId || productId || null;
  if (stripeProductId && !PRODUCT_ID.test(stripeProductId)) r.fail(`product_id must be a Stripe product id (prod_…), got "${stripeProductId}"`);
  if (stripeProductId && !r.raw('name')) r.fail('name (the Stripe product name) is required to verify the Stripe product');

  const slug = r.ls('product');
  if (!slug) r.fail('_ls:product (the product id, e.g. cursedelete) is required');
  else if (!WIRE_SLUG.test(slug)) r.fail(`_ls:product "${slug}" must be lower-case letters, digits, _ . - (max 64)`);
  const productName = r.ls('product_name') || null;
  if (productName && productName.length > 200) r.fail('_ls:product_name is longer than 200 characters');
  const major = r.int('_ls:major', { min: 0, max: 1_000_000, required: true });
  const editionId = r.ls('edition').toLowerCase();
  if (!editionId) r.fail('_ls:edition is required');

  const certText = r.ls('edition_certificate_lifetime_days').toLowerCase();
  let certificateLifetimeSeconds: number | null | undefined;
  if (certText === '') certificateLifetimeSeconds = undefined;
  else if (certText === 'none') certificateLifetimeSeconds = null;
  else {
    const d = r.int('_ls:edition_certificate_lifetime_days', { min: 1, max: 3650 });
    certificateLifetimeSeconds = d === null ? undefined : d * 86400;
  }
  const epTransferText = r.ls('edition_transfer_allowance').toLowerCase();
  const editionTransfer = epTransferText === '' ? undefined : epTransferText === 'default' ? null : (r.int('_ls:edition_transfer_allowance', { min: 0, max: 1000 }) ?? undefined);

  const billing = r.oneOf('_ls:billing', ['one_time', 'recurring', 'free'] as const);
  if (!billing) r.fail('_ls:billing is required (one_time, recurring or free)');
  const termType = r.oneOf('_ls:term', ['perpetual', 'subscription', 'fixed_term'] as const, billing === 'recurring' ? 'subscription' : 'perpetual');
  const needsInterval = billing === 'recurring' || termType === 'fixed_term';
  const interval = needsInterval ? r.oneOf('_ls:interval', ['day', 'week', 'month', 'year'] as const) : null;
  if (needsInterval && !interval && !r.ls('interval')) r.fail('_ls:interval is required for recurring billing or fixed_term terms');
  if (!needsInterval && r.ls('interval')) r.fail('_ls:interval only applies to recurring billing or fixed_term terms');
  const intervalCount = needsInterval ? (r.int('_ls:interval_count', { min: 1, max: 120 }) ?? 1) : null;

  const prices: PriceSpec[] = [];
  for (const c of STORE_CURRENCIES) {
    const amount = r.int(`_ls:price:${c}`, { min: 0, max: 99_999_999_999 });
    const taxText = r.ls(`tax_percent:${c}`);
    const taxLabel = r.ls(`tax_label:${c}`) || null;
    if (amount === null) {
      if (taxText || taxLabel) r.fail(`_ls:tax_percent:${c} / _ls:tax_label:${c} need _ls:price:${c}`);
      continue;
    }
    const taxRatePercent = taxText ? Number(taxText) : null;
    if (taxRatePercent !== null && (!Number.isFinite(taxRatePercent) || taxRatePercent <= 0 || taxRatePercent > 100)) r.fail(`_ls:tax_percent:${c} must be a number above 0 and at most 100 (got "${taxText}")`);
    if ((taxRatePercent === null) !== (taxLabel === null)) r.fail(`_ls:tax_percent:${c} and _ls:tax_label:${c} go together`);
    prices.push({ currency: c, unitAmount: amount, taxRatePercent, taxLabel });
  }

  const spec: RowSpec = {
    line, sku, name,
    description: r.ls('description') || r.raw('description'),
    stripe: { productId: stripeProductId, name: r.raw('name'), description: r.raw('description'), active: r.yesNo('active', null), metaSku: r.raw('_meta:sku') },
    product: { slug, name: productName },
    major: {
      version: major ?? 0,
      protocol: r.ls('protocol') || null,
      transferAllowance: r.int('_ls:major_transfer_allowance', { min: 0, max: 1000 }),
      activationKeyEmail: r.yesNo('_ls:major_activation_key_email', null),
    },
    edition: {
      id: editionId,
      displayName: r.ls('edition_name') || null,
      activationModel: r.oneOf('_ls:edition_activation_model', ['none', 'device_seats'] as const),
      ownership: r.oneOf('_ls:edition_ownership', ['individual', 'organisation', 'institution'] as const),
      offlinePolicy: r.oneOf('_ls:edition_offline_policy', ['indefinite', 'periodic_check'] as const),
      certificateLifetimeSeconds,
      transferAllowance: editionTransfer,
    },
    billing: billing ?? 'one_time',
    visibility: r.oneOf('_ls:visibility', ['public', 'private'] as const, 'public') ?? 'public',
    customerKind: r.oneOf('_ls:customer_kind', ['any', 'individual', 'organisation'] as const, 'any') ?? 'any',
    minQuantity: r.int('_ls:min_quantity', { min: 1, max: 10000 }) ?? 1,
    maxQuantity: r.int('_ls:max_quantity', { min: 1, max: 10000 }) ?? 1,
    component: {
      termType: termType ?? 'perpetual',
      termInterval: termType === 'fixed_term' ? interval : null,
      termIntervalCount: termType === 'fixed_term' ? intervalCount : null,
      seatsPerUnit: r.int('_ls:seats_per_unit', { min: 1, max: 100000 }),
      quantityScalesSeats: r.yesNo('_ls:quantity_scales_seats', false) ?? false,
      trialDays: r.int('_ls:trial_days', { min: 1, max: 730 }),
      graceDays: r.int('_ls:grace_days', { min: 0, max: 90 }) ?? 0,
      transferAllowance: r.int('_ls:transfer_allowance', { min: 0, max: 1000 }),
      refundAction: r.oneOf('_ls:refund_action', ['revoke', 'review', 'none'] as const, 'revoke') ?? 'revoke',
      disputeAction: r.oneOf('_ls:dispute_action', ['revoke', 'review', 'none'] as const, 'review') ?? 'review',
    },
    priceInterval: billing === 'recurring' ? interval : null,
    priceIntervalCount: billing === 'recurring' ? intervalCount : null,
    prices,
    activate: r.yesNo('_ls:activate', false) ?? false,
  };
  if (spec.maxQuantity < spec.minQuantity) r.fail('_ls:max_quantity must be >= _ls:min_quantity');
  if (!prices.length) r.fail('At least one _ls:price:<currency> is required');
  for (const p of prices) {
    for (const problem of validatePrice({ billing: spec.billing, unitAmount: p.unitAmount, recurringInterval: spec.priceInterval })) r.fail(`_ls:price:${p.currency}: ${problem.message}`);
  }
  const shape = ComponentInput.safeParse({ editionPolicyId: 'pep_planned', ...spec.component });
  if (!shape.success) for (const i of shape.error.issues) r.fail(`${i.path.join('.')}: ${i.message}`);
  return { spec: r.errors.length ? null : spec, sku, name, errors: r.errors };
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

interface ExecCtx { sql: Sql; stripe: StripeClient; actor: Actor; ids: Map<string, string> }
interface Step { label: string; run: (ctx: ExecCtx) => Promise<void> }
interface EntityWork { entity: PlanEntity; steps: Step[] }
interface RowWork { row: PlanRow; deps: string[]; steps: Step[] }
interface Work { plan: ImportPlan; entities: EntityWork[]; rows: RowWork[] }

interface ProductRow { id: string; slug: string; name: string; status: string }
interface MajorRow { id: string; protocol_id: string; status: string; default_transfer_allowance: number; activation_key_email: boolean }
interface EditionRow {
  id: string; display_name: string; activation_model: ActivationModel; ownership: Ownership; offline_policy: OfflinePolicy;
  certificate_lifetime_seconds: number | null; transfer_allowance: number | null; status: string; wire_id: string;
}
interface ExistingOffer {
  id: string; sku: string; status: string; name: string; description: string; kind: string; billing: string; visibility: string; customer_kind: string;
  min_quantity: number; max_quantity: number; stripe_product_id: string | null; sync_state: string | null;
}

const productKey = (s: RowSpec) => `product:${s.product.slug}`;
const majorKey = (s: RowSpec) => `major:${s.product.slug}:${s.major.version}`;
const editionKey = (s: RowSpec) => `edition:${s.product.slug}:${s.major.version}:${s.edition.id}`;
const offerKey = (line: number) => `offer:${line}`;

const show = (v: unknown) => (v === null || v === undefined ? 'none' : typeof v === 'string' ? `"${v}"` : String(v));
const money = (p: PriceSpec) => `${p.currency.toUpperCase()} ${p.unitAmount}${p.taxRatePercent !== null ? ` + ${p.taxRatePercent}% ${p.taxLabel}` : ''}`;

/** Group distinct non-empty values of a field across rows (for in-file contradiction checks). */
function disagreements<T>(specs: RowSpec[], pick: (s: RowSpec) => T | null | undefined, label: string): string[] {
  const byValue = new Map<string, number[]>();
  for (const s of specs) {
    const v = pick(s);
    if (v === null || v === undefined) continue;
    const k = JSON.stringify(v);
    byValue.set(k, [...(byValue.get(k) ?? []), s.line]);
  }
  if (byValue.size <= 1) return [];
  return [`Rows disagree on ${label}: ${[...byValue].map(([v, lines]) => `${v} (line ${lines.join(', ')})`).join(' vs ')}`];
}

async function planImport(sql: Sql, stripe: StripeClient, csvText: string): Promise<Work> {
  try {
    return await planImportUnchecked(sql, stripe, csvText);
  } catch (e) {
    if (e instanceof StripeError) throw new AppError('provider_unavailable', `Stripe could not be read (${e.message}); nothing was changed. Try again shortly.`);
    throw e;
  }
}

async function planImportUnchecked(sql: Sql, stripe: StripeClient, csvText: string): Promise<Work> {
  let table;
  try {
    table = parseCsv(csvText);
  } catch (e) {
    throw invalid(`CSV: ${(e as Error).message}`);
  }
  if (!table.headers.length) throw invalid('The CSV is empty');
  if (!table.headers.includes('_ls:import')) throw invalid('The CSV has no _ls:import column: mark the rows to import with _ls:import = yes');
  const unknown = table.headers.filter((h) => h.startsWith('_ls:') && !LS_COLUMNS.has(h.slice(4)));
  if (unknown.length) throw invalid(`Unknown license-server column(s): ${unknown.join(', ')}`);
  if (table.rows.length > MAX_ROWS) throw invalid(`At most ${MAX_ROWS} rows per import`);

  const stripeMode = stripe.livemode ? 'live' : 'test';
  const rows: RowWork[] = [];
  const specs: RowSpec[] = [];
  const byLine = new Map<number, RowWork>();

  // 1. Parse; select rows marked for import.
  for (const tr of table.rows) {
    const v = tr.values;
    const row: PlanRow = { line: tr.line, sku: v['_ls:sku'] || v['_meta:sku'] || '', name: v['_ls:name'] || v.name || '', action: 'skipped', offerId: null,
      stripeProductId: v['_ls:stripe_product_id'] || v.product_id || null, changes: [], warnings: [], errors: [] };
    const work: RowWork = { row, deps: [], steps: [] };
    rows.push(work);
    byLine.set(tr.line, work);
    const sel = (v['_ls:import'] ?? '').trim().toLowerCase();
    if (sel === '' || NO.has(sel)) continue;
    row.action = 'unchanged'; // selected; classified in step 5
    if (!YES.has(sel)) {
      row.errors.push(`_ls:import: use yes or no (got "${v['_ls:import']}")`);
      continue;
    }
    const parsed = parseRow(tr.line, v);
    row.sku = parsed.sku;
    row.name = parsed.name;
    row.errors.push(...parsed.errors);
    if (parsed.spec) specs.push(parsed.spec);
  }

  // 2. Identifiers that must be unique within the file.
  const dupCheck = (label: string, key: (s: RowSpec) => string | null) => {
    const seen = new Map<string, number[]>();
    for (const s of specs) {
      const k = key(s);
      if (k) seen.set(k, [...(seen.get(k) ?? []), s.line]);
    }
    for (const [k, lines] of seen) {
      if (lines.length < 2) continue;
      for (const l of lines) byLine.get(l)!.row.errors.push(`${label} ${k} appears on lines ${lines.join(', ')}`);
    }
  };
  dupCheck('SKU', (s) => s.sku);
  dupCheck('Stripe product', (s) => s.stripe.productId);
  dupCheck('Offer name', (s) => s.name.toLowerCase());
  const valid = () => specs.filter((s) => !byLine.get(s.line)!.row.errors.length);

  // 3. Products, majors and edition policies: verify existing ones, plan missing ones.
  const entities = new Map<string, EntityWork>();
  const editionDefs = new Map((await sql<{ id: string; wire_id: string }[]>`SELECT id, wire_id FROM edition_definitions`).map((e) => [e.id, e.wire_id]));
  const productRows = new Map<string, ProductRow | null>();
  const majorRows = new Map<string, MajorRow | null>();
  const editionRows = new Map<string, EditionRow | null>();
  const group = (key: (s: RowSpec) => string) => {
    const m = new Map<string, RowSpec[]>();
    for (const s of valid()) m.set(key(s), [...(m.get(key(s)) ?? []), s]);
    return m;
  };
  const entity = (kind: PlanEntity['kind'], key: string, label: string, ss: RowSpec[]): EntityWork => {
    const w: EntityWork = { entity: { kind, key, label, action: 'unchanged', lines: ss.map((s) => s.line), changes: [], errors: [] }, steps: [] };
    entities.set(key, w);
    return w;
  };

  for (const [key, ss] of group(productKey)) {
    const s0 = ss[0]!;
    const w = entity('product', key, `Product ${s0.product.slug}`, ss);
    const e = w.entity;
    e.errors.push(...disagreements(ss, (s) => s.product.name, '_ls:product_name'));
    const [p] = await sql<ProductRow[]>`SELECT id, slug, name, status FROM products WHERE slug = ${s0.product.slug}`;
    productRows.set(key, p ?? null);
    const wanted = ss.map((s) => s.product.name).find((n) => n) ?? null;
    if (p) {
      w.steps = [];
      if (p.status === 'retired') e.errors.push(`Product ${p.slug} is retired`);
      if (wanted && wanted !== p.name) e.errors.push(`_ls:product_name ${show(wanted)} differs from the licence server's product name ${show(p.name)} (rename it in the admin portal, or fix the CSV)`);
    } else if (!wanted) {
      e.errors.push(`Product ${s0.product.slug} does not exist: add _ls:product_name to create it`);
    } else {
      const [clash] = await sql<{ slug: string }[]>`SELECT slug FROM products WHERE lower(name) = lower(${wanted}) AND status <> 'retired'`;
      if (clash) e.errors.push(`Product name ${show(wanted)} is already used by product ${clash.slug}`);
      e.action = 'create';
      e.changes.push(`create product ${s0.product.slug} named ${show(wanted)} (draft)`);
      w.steps.push({ label: e.changes[0]!, run: async (ctx) => {
        const created = await createProduct(ctx.sql, ctx.actor, { slug: s0.product.slug, name: wanted });
        ctx.ids.set(key, created.id);
      } });
    }
  }

  for (const [key, ss] of group(majorKey)) {
    const s0 = ss[0]!;
    const w = entity('major', key, `${s0.product.slug} v${s0.major.version}`, ss);
    const e = w.entity;
    e.errors.push(...disagreements(ss, (s) => s.major.protocol, '_ls:protocol'), ...disagreements(ss, (s) => s.major.transferAllowance, '_ls:major_transfer_allowance'),
      ...disagreements(ss, (s) => s.major.activationKeyEmail, '_ls:major_activation_key_email'));
    const product = productRows.get(productKey(s0));
    const [m] = product ? await sql<MajorRow[]>`
      SELECT id, protocol_id, status, default_transfer_allowance, activation_key_email FROM product_majors WHERE product_id = ${product.id} AND major_version = ${s0.major.version}` : [];
    majorRows.set(key, m ?? null);
    const protocol = ss.map((s) => s.major.protocol).find((x) => x) ?? null;
    const transfer = ss.map((s) => s.major.transferAllowance).find((x) => x !== null) ?? null;
    const keyEmail = ss.map((s) => s.major.activationKeyEmail).find((x) => x !== null) ?? null;
    if (m) {
      if (m.status === 'retired') e.errors.push(`${e.label} is retired`);
      if (protocol && protocol !== m.protocol_id) e.errors.push(`_ls:protocol ${show(protocol)} differs from the licence server's ${show(m.protocol_id)}`);
      if (transfer !== null && transfer !== m.default_transfer_allowance) e.errors.push(`_ls:major_transfer_allowance ${transfer} differs from the licence server's ${m.default_transfer_allowance}`);
      if (keyEmail !== null && keyEmail !== m.activation_key_email) e.errors.push(`_ls:major_activation_key_email ${keyEmail ? 'yes' : 'no'} differs from the licence server's ${m.activation_key_email ? 'yes' : 'no'}`);
    } else if (!protocol) {
      e.errors.push(`${e.label} does not exist: add _ls:protocol (${implementedProtocolIds().join(', ')}) to create it`);
    } else if (!getProtocol(protocol)) {
      e.errors.push(`_ls:protocol ${show(protocol)} is not implemented (implemented: ${implementedProtocolIds().join(', ')})`);
    } else {
      e.action = 'create';
      e.changes.push(`create major ${e.label} on protocol ${protocol} (draft; transfer allowance ${transfer ?? '3 (default)'}, activation key in email ${keyEmail === false ? 'no' : 'yes'}${keyEmail === null ? ' (default)' : ''})`);
      w.steps.push({ label: e.changes[0]!, run: async (ctx) => {
        const created = await createMajor(ctx.sql, ctx.actor, {
          productId: ctx.ids.get(productKey(s0)) ?? s0.product.slug, majorVersion: s0.major.version, protocolId: protocol,
          ...(transfer !== null ? { defaultTransferAllowance: transfer } : {}), ...(keyEmail !== null ? { activationKeyEmail: keyEmail } : {}),
        });
        ctx.ids.set(key, created.id);
      } });
    }
  }

  for (const [key, ss] of group(editionKey)) {
    const s0 = ss[0]!;
    const w = entity('edition_policy', key, `${s0.product.slug} v${s0.major.version} ${s0.edition.id} edition`, ss);
    const e = w.entity;
    const fields: Array<[string, (s: RowSpec) => unknown]> = [
      ['_ls:edition_name', (s) => s.edition.displayName], ['_ls:edition_activation_model', (s) => s.edition.activationModel],
      ['_ls:edition_ownership', (s) => s.edition.ownership], ['_ls:edition_offline_policy', (s) => s.edition.offlinePolicy],
      ['_ls:edition_certificate_lifetime_days', (s) => s.edition.certificateLifetimeSeconds], ['_ls:edition_transfer_allowance', (s) => s.edition.transferAllowance],
    ];
    for (const [label, pick] of fields) e.errors.push(...disagreements(ss, pick, label));
    const wireId = editionDefs.get(s0.edition.id);
    if (!wireId) {
      e.errors.push(`Unknown edition ${show(s0.edition.id)} (known: ${[...editionDefs.keys()].join(', ')})`);
      continue;
    }
    const first = <T>(pick: (s: RowSpec) => T | null | undefined): T | null | undefined => {
      for (const s of ss) if (pick(s) !== undefined && pick(s) !== null) return pick(s);
      return ss.some((s) => pick(s) === null) ? null : undefined;
    };
    const want = {
      displayName: first((s) => s.edition.displayName) ?? null, activationModel: first((s) => s.edition.activationModel) ?? null,
      ownership: first((s) => s.edition.ownership) ?? null, offlinePolicy: first((s) => s.edition.offlinePolicy) ?? null,
      certificateLifetimeSeconds: first((s) => s.edition.certificateLifetimeSeconds), transferAllowance: first((s) => s.edition.transferAllowance),
    };
    const major = majorRows.get(majorKey(s0));
    const [ep] = major ? await sql<EditionRow[]>`
      SELECT ep.id, ep.display_name, ep.activation_model, ep.ownership, ep.offline_policy, ep.certificate_lifetime_seconds, ep.transfer_allowance, ep.status, e.wire_id
      FROM product_edition_policies ep JOIN edition_definitions e ON e.id = ep.edition_id WHERE ep.product_major_id = ${major.id} AND ep.edition_id = ${s0.edition.id}` : [];
    editionRows.set(key, ep ?? null);
    if (ep) {
      if (ep.status !== 'active') e.errors.push(`${e.label} is ${ep.status}`);
      const cmp: Array<[string, unknown, unknown]> = [
        ['_ls:edition_name', want.displayName, ep.display_name], ['_ls:edition_activation_model', want.activationModel, ep.activation_model],
        ['_ls:edition_ownership', want.ownership, ep.ownership], ['_ls:edition_offline_policy', want.offlinePolicy, ep.offline_policy],
      ];
      for (const [label, csv, db] of cmp) if (csv !== null && csv !== db) e.errors.push(`${label} ${show(csv)} differs from the licence server's ${show(db)}`);
      if (want.certificateLifetimeSeconds !== undefined && want.certificateLifetimeSeconds !== ep.certificate_lifetime_seconds) {
        e.errors.push(`_ls:edition_certificate_lifetime_days ${want.certificateLifetimeSeconds === null ? 'none' : want.certificateLifetimeSeconds / 86400} differs from the licence server's ${ep.certificate_lifetime_seconds === null ? 'none' : ep.certificate_lifetime_seconds / 86400}`);
      }
      if (want.transferAllowance !== undefined && want.transferAllowance !== ep.transfer_allowance) {
        e.errors.push(`_ls:edition_transfer_allowance ${want.transferAllowance ?? 'default'} differs from the licence server's ${ep.transfer_allowance ?? 'default'}`);
      }
      continue;
    }
    const missing = (['displayName', 'activationModel', 'ownership', 'offlinePolicy'] as const).filter((k) => !want[k]);
    const colOf = { displayName: '_ls:edition_name', activationModel: '_ls:edition_activation_model', ownership: '_ls:edition_ownership', offlinePolicy: '_ls:edition_offline_policy' };
    if (missing.length) {
      e.errors.push(`${e.label} does not exist: ${missing.map((k) => colOf[k]).join(', ')} ${missing.length > 1 ? 'are' : 'is'} required to create it`);
      continue;
    }
    // Validate against the protocol now, with a perpetual probe (as upsertEditionPolicy does).
    const protocolId = major?.protocol_id ?? s0.major.protocol;
    if (protocolId && getProtocol(protocolId)) {
      const probe = policyRows(s0, protocolId, major ?? null, { activation_model: want.activationModel!, ownership: want.ownership!, display_name: want.displayName!,
        offline_policy: want.offlinePolicy!, certificate_lifetime_seconds: want.certificateLifetimeSeconds ?? null, transfer_allowance: want.transferAllowance ?? null, wire_id: wireId }, null);
      for (const p of validatePolicy(computeEffectivePolicy(probe, 1))) e.errors.push(p.message);
    }
    e.action = 'create';
    e.changes.push(`create edition policy ${e.label}: ${show(want.displayName)}, ${want.activationModel}, ${want.ownership}, offline ${want.offlinePolicy}, `
      + `certificate lifetime ${want.certificateLifetimeSeconds ? `${want.certificateLifetimeSeconds / 86400} days` : 'none'}, transfer allowance ${want.transferAllowance ?? 'major default'}`);
    w.steps.push({ label: e.changes[0]!, run: async (ctx) => {
      const created = await upsertEditionPolicy(ctx.sql, ctx.actor, {
        productMajorId: ctx.ids.get(majorKey(s0)) ?? major!.id, editionId: s0.edition.id, displayName: want.displayName!, activationModel: want.activationModel!,
        ownership: want.ownership!, offlinePolicy: want.offlinePolicy!, certificateLifetimeSeconds: want.certificateLifetimeSeconds ?? null, transferAllowance: want.transferAllowance ?? null,
      });
      ctx.ids.set(key, created.id);
    } });
  }
  // An entity with errors fails everything that depends on it.
  const failed = (k: string) => (entities.get(k)?.entity.errors.length ?? 0) > 0;

  // 4. Offers: reconcile each row with PostgreSQL and Stripe.
  const stripeCache = new Map<string, StripeProduct | null>();
  for (const s of valid()) {
    const w = byLine.get(s.line)!;
    w.deps = [productKey(s), majorKey(s), editionKey(s)];
    const bad = w.deps.filter(failed);
    if (bad.length) {
      w.row.errors.push(`Not imported until ${bad.map((k) => entities.get(k)!.entity.label).join(', ')} ${bad.length > 1 ? 'are' : 'is'} fixed (see above)`);
      continue;
    }
    await planOffer(sql, stripe, s, w, {
      major: majorRows.get(majorKey(s)) ?? null, product: productRows.get(productKey(s)) ?? null, edition: editionRows.get(editionKey(s)) ?? null,
      plannedMajorProtocol: s.major.protocol, wireId: editionDefs.get(s.edition.id)!, plannedEdition: entities.get(editionKey(s))!,
    }, stripeCache);
  }

  // 5. Classify and summarise.
  for (const w of rows) {
    const r = w.row;
    if (r.errors.length) {
      r.action = 'error';
      w.steps = [];
    } else if (r.action !== 'skipped') {
      if (!r.offerId) r.action = 'create';
      else if (w.steps.some((x) => x.label.startsWith('link Stripe product'))) r.action = 'link';
      else r.action = w.steps.length ? 'update' : 'unchanged';
    }
  }
  const ents = [...entities.values()];
  for (const e of ents) if (e.entity.errors.length) {
    e.entity.action = 'error';
    e.steps = [];
  }
  const count = (a: RowAction) => rows.filter((w) => w.row.action === a).length;
  const plan: ImportPlan = {
    stripeMode,
    entities: ents.map((e) => e.entity),
    rows: rows.map((w) => w.row),
    summary: {
      rows: rows.length, selected: rows.length - count('skipped'), skipped: count('skipped'),
      create: count('create'), link: count('link'), update: count('update'), unchanged: count('unchanged'), errors: count('error'),
      entitiesToCreate: ents.filter((e) => e.entity.action === 'create').length, entityErrors: ents.filter((e) => e.entity.action === 'error').length,
    },
  };
  return { plan, entities: ents, rows };
}

/** Synthetic policy rows for validating a planned (not yet stored) edition or offer. */
function policyRows(s: RowSpec, protocolId: string, major: MajorRow | null, ep: Omit<PolicyRows['editionPolicy'], 'id' | 'edition_id'>, component: RowSpec['component'] | null): PolicyRows {
  return {
    product: { id: 'planned', slug: s.product.slug, name: s.product.name ?? s.product.slug },
    major: { id: major?.id ?? `planned:${s.product.slug}:${s.major.version}`, major_version: s.major.version, protocol_id: protocolId,
      default_transfer_allowance: major?.default_transfer_allowance ?? s.major.transferAllowance ?? 3, activation_key_email: major?.activation_key_email ?? s.major.activationKeyEmail ?? true },
    editionPolicy: { id: 'planned', edition_id: s.edition.id, ...ep },
    component: component ? {
      id: 'planned', term_type: component.termType, term_interval: component.termInterval, term_interval_count: component.termIntervalCount, seats_per_unit: component.seatsPerUnit,
      quantity_scales_seats: component.quantityScalesSeats, trial_days: component.trialDays, grace_days: component.graceDays, transfer_allowance: component.transferAllowance,
      refund_action: component.refundAction, dispute_action: component.disputeAction,
    } : {
      id: 'probe', term_type: 'perpetual', term_interval: null, term_interval_count: null, seats_per_unit: ep.activation_model === 'device_seats' ? 1 : null,
      quantity_scales_seats: false, trial_days: null, grace_days: 0, transfer_allowance: null, refund_action: 'revoke', dispute_action: 'review',
    },
    offer: null,
  };
}

interface OfferContext {
  product: ProductRow | null;
  major: MajorRow | null;
  edition: EditionRow | null;
  plannedMajorProtocol: string | null;
  wireId: string;
  plannedEdition: EntityWork;
}

async function planOffer(sql: Sql, stripe: StripeClient, s: RowSpec, w: RowWork, ctx: OfferContext, stripeCache: Map<string, StripeProduct | null>): Promise<void> {
  const r = w.row;
  const errors = r.errors;
  const [existing] = await sql<ExistingOffer[]>`
    SELECT o.id, o.sku, o.status, o.name, o.description, o.kind, o.billing, o.visibility, o.customer_kind, o.min_quantity, o.max_quantity, pm.stripe_product_id, pm.sync_state
    FROM offers o LEFT JOIN stripe_product_mappings pm ON pm.offer_id = o.id WHERE o.sku = ${s.sku}`;
  r.offerId = existing?.id ?? null;
  if (existing?.status === 'archived') {
    errors.push(`Offer ${s.sku} is archived; use a new SKU`);
    return;
  }

  // What the offer grants: validated against the protocol now (new offers) or compared (existing).
  const protocolId = ctx.major?.protocol_id ?? ctx.plannedMajorProtocol;
  const ep = ctx.edition ?? null;
  const planned = ctx.plannedEdition.entity.action === 'create';
  if (protocolId && getProtocol(protocolId) && (ep || planned)) {
    const want = (k: keyof RowSpec['edition']) => s.edition[k];
    const epRow: Omit<PolicyRows['editionPolicy'], 'id' | 'edition_id'> = ep ? {
      display_name: ep.display_name, activation_model: ep.activation_model, ownership: ep.ownership, offline_policy: ep.offline_policy,
      certificate_lifetime_seconds: ep.certificate_lifetime_seconds, transfer_allowance: ep.transfer_allowance, wire_id: ep.wire_id,
    } : {
      display_name: want('displayName') as string, activation_model: want('activationModel') as ActivationModel, ownership: want('ownership') as Ownership,
      offline_policy: want('offlinePolicy') as OfflinePolicy, certificate_lifetime_seconds: (want('certificateLifetimeSeconds') as number | null | undefined) ?? null,
      transfer_allowance: (want('transferAllowance') as number | null | undefined) ?? null, wire_id: ctx.wireId,
    };
    const rows = policyRows(s, protocolId, ctx.major, epRow, s.component);
    const policy = computeEffectivePolicy(rows, 1);
    for (const p of [...validatePolicy(policy), ...validateOfferShape({ kind: 'single', billing: s.billing, maxQuantity: s.maxQuantity, components: [{ productMajorId: rows.major.id, policy, quantityScalesSeats: s.component.quantityScalesSeats }] })]) {
      errors.push(p.message);
    }
  }
  if (existing) errors.push(...(await immutableDifferences(sql, existing, s, ep?.id ?? null)));

  // Names are unique (case-insensitive) among offers that are not archived.
  const [clash] = await sql<{ sku: string }[]>`SELECT sku FROM offers WHERE lower(name) = lower(${s.name}) AND status <> 'archived' AND sku <> ${s.sku}`;
  if (clash) errors.push(`Offer name ${show(s.name)} is already used by offer ${clash.sku}`);

  // Stripe: identity and agreement. Never relinked, renamed or re-described by the import.
  const linkTo = await reconcileStripe(sql, stripe, s, existing ?? null, r, stripeCache);

  // Prices (database only).
  const prices = existing ? await priceChanges(sql, existing, s, r) : { create: s.prices, activate: true };

  if (errors.length) return;

  // Steps, in order.
  const termText = [s.component.termType + (s.component.termInterval ? ` ${s.component.termIntervalCount}×${s.component.termInterval}` : ''),
    s.component.seatsPerUnit ? `${s.component.seatsPerUnit} seat(s) per unit${s.component.quantityScalesSeats ? ' × quantity' : ''}` : null,
    s.component.trialDays ? `${s.component.trialDays}-day trial` : null, `${s.component.graceDays}-day grace`,
    `transfers ${s.component.transferAllowance ?? 'edition default'}`, `refund ${s.component.refundAction}`, `dispute ${s.component.disputeAction}`].filter(Boolean).join(', ');
  if (!existing) {
    w.steps.push({ label: `create offer ${s.sku} (${s.product.slug} v${s.major.version} ${s.edition.id}; ${s.billing}${s.priceInterval ? ` every ${s.priceIntervalCount} ${s.priceInterval}` : ''}; ${termText}; quantity ${s.minQuantity}–${s.maxQuantity}; ${s.visibility}; customers ${s.customerKind})`,
      run: async (c) => {
        const created = await createOffer(c.sql, c.actor, {
          sku: s.sku, name: s.name, description: s.description, kind: 'single', billing: s.billing, visibility: s.visibility, customerKind: s.customerKind,
          minQuantity: s.minQuantity, maxQuantity: s.maxQuantity, components: [{ editionPolicyId: c.ids.get(editionKey(s)) ?? ep!.id, ...s.component }],
        }) as unknown as { id: string };
        c.ids.set(offerKey(s.line), created.id);
      } });
  } else {
    const updates: Record<string, string> = {};
    const labels: string[] = [];
    if (existing.name !== s.name) { updates.name = s.name; labels.push(`name ${show(existing.name)} → ${show(s.name)}`); }
    if (existing.description !== s.description) { updates.description = s.description; labels.push('description'); }
    if (existing.visibility !== s.visibility) { updates.visibility = s.visibility; labels.push(`visibility ${existing.visibility} → ${s.visibility}`); }
    if (labels.length) w.steps.push({ label: `update ${labels.join(', ')}`, run: async (c) => void (await updateOffer(c.sql, c.actor, existing.id, updates)) });
  }
  const offerId = (c: ExecCtx) => c.ids.get(offerKey(s.line)) ?? existing!.id;
  if (prices.create.length) {
    const label = prices.activate ? `set prices ${prices.create.map(money).join(', ')}` : `add draft prices ${prices.create.map(money).join(', ')} (the offer is on sale: activate them in the admin portal)`;
    w.steps.push({ label, run: async (c) => void (await createPriceSet(c.sql, c.actor, offerId(c), {
      recurringInterval: s.priceInterval, recurringIntervalCount: s.priceIntervalCount, activate: prices.activate,
      prices: prices.create.map((p) => ({ currency: p.currency, unitAmount: p.unitAmount, taxRatePercent: p.taxRatePercent, taxLabel: p.taxLabel })),
    })) });
  }
  if (linkTo) {
    w.steps.push({ label: linkTo.relabel ?? `link Stripe product ${linkTo.id}`,
      run: async (c) => void (await linkStripeProduct(c.sql, c.stripe, c.actor, offerId(c), { stripeProductId: linkTo.id })) });
  }
  const priced = new Set(s.prices.map((p) => p.currency));
  const activePriced = existing ? new Set((await sql<{ currency: string }[]>`SELECT DISTINCT currency FROM price_versions WHERE offer_id = ${existing.id} AND status = 'active'`).map((x) => x.currency)) : new Set<string>();
  const missing = STORE_CURRENCIES.filter((c) => !activePriced.has(c) && !(prices.activate && priced.has(c)));
  if (missing.length && existing?.status !== 'active') r.warnings.push(`no active price for ${missing.join(', ').toUpperCase()}: the offer cannot be activated until every store currency has one`);
  if (s.activate && existing?.status !== 'active') {
    if (missing.length) errors.push(`_ls:activate = yes needs a price in every store currency; missing ${missing.join(', ').toUpperCase()}`);
    if (!ctx.product || ctx.product.status !== 'active' || !ctx.major || ctx.major.status !== 'active') {
      errors.push(`_ls:activate = yes needs ${s.product.slug} v${s.major.version} to be active (product ${ctx.product?.status ?? 'not created yet'}, major ${ctx.major?.status ?? 'not created yet'}): activate them in the admin portal once releases and signing keys are set up, or set _ls:activate = no`);
    }
    if (!errors.length) w.steps.push({ label: 'activate offer', run: async (c) => void (await setOfferStatus(c.sql, c.actor, offerId(c), 'active')) });
  }
  if (errors.length) w.steps = [];
  r.changes = w.steps.map((x) => x.label);
}

/** Differences in what an existing offer grants or how it bills: these never change in place. */
async function immutableDifferences(db: Db, o: ExistingOffer, s: RowSpec, editionPolicyId: string | null): Promise<string[]> {
  if (o.kind !== 'single') return [`Offer ${o.sku} is a bundle; bundles are managed in the admin portal, not imported`];
  const [c] = await db<{ edition_policy_id: string; term_type: string; term_interval: string | null; term_interval_count: number | null; seats_per_unit: number | null;
    quantity_scales_seats: boolean; trial_days: number | null; grace_days: number; transfer_allowance: number | null; refund_action: string; dispute_action: string }[]>`
    SELECT * FROM offer_entitlement_components WHERE offer_id = ${o.id} ORDER BY position`;
  if (!c) return [`Offer ${o.sku} has no entitlement component`];
  const diffs: Array<[string, unknown, unknown]> = [
    ['billing', o.billing, s.billing], ['customer kind', o.customer_kind, s.customerKind], ['min quantity', o.min_quantity, s.minQuantity], ['max quantity', o.max_quantity, s.maxQuantity],
    ['product/major/edition', c.edition_policy_id, editionPolicyId], ['term', c.term_type, s.component.termType], ['term interval', c.term_interval, s.component.termInterval],
    ['term interval count', c.term_interval_count, s.component.termIntervalCount], ['seats per unit', c.seats_per_unit, s.component.seatsPerUnit],
    ['quantity scales seats', c.quantity_scales_seats, s.component.quantityScalesSeats], ['trial days', c.trial_days, s.component.trialDays], ['grace days', c.grace_days, s.component.graceDays],
    ['transfer allowance', c.transfer_allowance, s.component.transferAllowance], ['refund action', c.refund_action, s.component.refundAction], ['dispute action', c.dispute_action, s.component.disputeAction],
  ];
  const changed = diffs.filter(([, a, b]) => a !== b);
  if (!changed.length) return [];
  return [`Offer ${o.sku} exists and what it grants or how it bills cannot change (${changed.map(([k, a, b]) => `${k}: licence server ${show(a)}, CSV ${show(b)}`).join('; ')}); use a new SKU for different terms`];
}

/**
 * Currencies whose sellable price differs from the CSV. Draft offers get new active versions;
 * offers on sale get draft versions for an administrator to activate (never a silent price
 * change at checkout). A matching draft already waiting is not duplicated.
 */
async function priceChanges(db: Db, o: ExistingOffer, s: RowSpec, r: PlanRow): Promise<{ create: PriceSpec[]; activate: boolean }> {
  const rows = await db<{ currency: string; unit_amount: number; tax_rate_bps: number | null; tax_label: string | null; recurring_interval: string | null; recurring_interval_count: number | null; status: string }[]>`
    SELECT currency, unit_amount, tax_rate_bps, tax_label, recurring_interval, recurring_interval_count, status
    FROM price_versions WHERE offer_id = ${o.id} AND status IN ('active', 'draft') ORDER BY created_at DESC`;
  const same = (p: PriceSpec, v: (typeof rows)[number]) => Number(v.unit_amount) === p.unitAmount
    && v.tax_rate_bps === (p.taxRatePercent === null ? null : Math.round(p.taxRatePercent * 100)) && v.tax_label === p.taxLabel
    && v.recurring_interval === s.priceInterval && (v.recurring_interval_count ?? null) === s.priceIntervalCount;
  const otherInterval = rows.find((v) => v.status === 'active' && (v.recurring_interval !== s.priceInterval || (v.recurring_interval_count ?? null) !== s.priceIntervalCount));
  if (otherInterval) {
    r.errors.push(`Offer ${o.sku} is priced every ${otherInterval.recurring_interval_count ?? ''} ${otherInterval.recurring_interval ?? '(one-time)'}; the CSV says ${s.priceInterval ? `every ${s.priceIntervalCount} ${s.priceInterval}` : 'one-time'}: use a new SKU`);
    return { create: [], activate: false };
  }
  const activate = o.status !== 'active';
  const create: PriceSpec[] = [];
  for (const p of s.prices) {
    const active = rows.find((v) => v.currency === p.currency && v.status === 'active');
    if (active && same(p, active)) continue;
    if (!activate && rows.some((v) => v.currency === p.currency && v.status === 'draft' && same(p, v))) {
      r.warnings.push(`${money(p)} is already waiting as a draft price: activate it in the admin portal`);
      continue;
    }
    create.push(p);
  }
  for (const c of STORE_CURRENCIES) {
    if (!s.prices.some((p) => p.currency === c) && rows.some((v) => v.currency === c && v.status === 'active')) {
      r.warnings.push(`${c.toUpperCase()} has an active price but no _ls:price:${c} in the CSV; it is left unchanged (prices are archived in the admin portal, never by an import)`);
    }
  }
  return { create, activate };
}

/**
 * Stripe reconciliation for one row. Returns the product to link (or re-verify), if any. Adds
 * an error whenever the CSV, the database and Stripe disagree; never changes Stripe here.
 */
async function reconcileStripe(sql: Sql, stripe: StripeClient, s: RowSpec, existing: ExistingOffer | null, r: PlanRow, cache: Map<string, StripeProduct | null>): Promise<{ id: string; relabel?: string } | null> {
  const mode = stripe.livemode ? 'live' : 'test';
  const pid = s.stripe.productId;
  if (!pid) {
    // PostgreSQL-first (or not yet run through the Stripe script). Look for a product that
    // already carries this SKU, so the Stripe script cannot be led into creating a duplicate.
    let found: StripeProduct[] = [];
    try {
      found = (await searchStripeProducts(stripe, [['sku', s.stripe.metaSku || s.sku], ['repass_sku', s.sku]]))
        .filter((p) => p.metadata?.sku === (s.stripe.metaSku || s.sku) || p.metadata?.repass_sku === s.sku);
    } catch (e) {
      if (!(e instanceof StripeError) || e.status >= 500 || e.status === 429) throw e;
      r.warnings.push(`could not search Stripe for existing products with this SKU (${e.message})`);
    }
    const others = found.filter((p) => p.id !== existing?.stripe_product_id);
    if (others.length) {
      r.errors.push(`No product_id in the CSV, but Stripe (${mode} mode) already has ${others.map((p) => `${p.id} "${p.name}"`).join(', ')} for SKU ${s.sku}: put the right one in product_id (otherwise the Stripe script would create a duplicate)`);
    } else if (existing?.stripe_product_id) {
      r.warnings.push(`linked to Stripe product ${existing.stripe_product_id} in the licence server: copy it into product_id so the Stripe script updates that product instead of creating a duplicate`);
      r.stripeProductId = existing.stripe_product_id;
    } else {
      r.warnings.push('not in Stripe yet: the Stripe product is created and linked automatically at the first checkout (or run the Stripe script first and re-import)');
    }
    return null;
  }

  // Stripe-first: the product named in the CSV must exist and agree with the CSV.
  const [linkedElsewhere] = await sql<{ sku: string }[]>`
    SELECT o.sku FROM stripe_product_mappings pm JOIN offers o ON o.id = pm.offer_id WHERE pm.stripe_product_id = ${pid} AND o.sku <> ${s.sku}`;
  if (linkedElsewhere) r.errors.push(`Stripe product ${pid} is linked to offer ${linkedElsewhere.sku} in the licence server, but this CSV row is SKU ${s.sku}`);
  if (existing?.stripe_product_id && existing.stripe_product_id !== pid) {
    r.errors.push(`Offer ${s.sku} is linked to Stripe product ${existing.stripe_product_id} in the licence server, but the CSV says ${pid}: decide which is right (relink in the admin portal, or fix the CSV)`);
  }
  if (!cache.has(pid)) cache.set(pid, await getStripeProduct(stripe, pid));
  const p = cache.get(pid)!;
  if (!p) {
    r.errors.push(`Stripe product ${pid} does not exist in this Stripe account (${mode} mode)`);
    return null;
  }
  if (!p.active) r.errors.push(`Stripe product ${pid} is archived in Stripe`);
  if (s.stripe.active === false && p.active) r.errors.push(`CSV active = no, but Stripe product ${pid} is active`);
  if (p.name.trim() !== s.stripe.name) r.errors.push(`Stripe product name ${show(p.name)} differs from the CSV name ${show(s.stripe.name)} (run the Stripe script, or fix the CSV)`);
  if (s.stripe.description && (p.description ?? '').trim() !== s.stripe.description) r.errors.push(`Stripe product description differs from the CSV description (run the Stripe script, or fix the CSV)`);
  const md = p.metadata ?? {};
  if (md.sku && s.stripe.metaSku && md.sku !== s.stripe.metaSku) r.errors.push(`Stripe product ${pid} has metadata sku ${show(md.sku)}, the CSV _meta:sku is ${show(s.stripe.metaSku)}`);
  if (md.repass_sku && md.repass_sku !== s.sku) r.errors.push(`Stripe product ${pid} is tagged for licence-server SKU ${show(md.repass_sku)}, but this CSV row is SKU ${s.sku}`);
  if (md.repass_offer_id && md.repass_offer_id !== existing?.id) {
    r.warnings.push(`Stripe product ${pid} is tagged with offer id ${md.repass_offer_id} from another licence-server database (same SKU); linking re-tags it for this one`);
  }
  if (existing?.stripe_product_id === pid) {
    if (existing.sync_state !== 'synced') return { id: pid, relabel: `re-verify Stripe product ${pid} (currently ${existing.sync_state})` };
    return null;
  }
  return { id: pid };
}

// ---------------------------------------------------------------------------------------------
// Import records: preview, apply, read
// ---------------------------------------------------------------------------------------------

async function fingerprint(plan: ImportPlan): Promise<string> {
  return sha256Hex(JSON.stringify({ m: plan.stripeMode, e: plan.entities, r: plan.rows }));
}

function actorFields(a: Actor) {
  return { type: a.type, id: a.id ?? null, label: a.label };
}

interface ImportRow {
  id: string; status: CatalogueImport['status']; file_name: string | null; csv_sha256: string; csv_text: string; stripe_mode: 'test' | 'live'; plan: ImportPlan;
  plan_fingerprint: string; summary: ImportSummary; result: ImportResult | null; created_by_label: string; created_at: Date; applied_by_label: string | null; applied_at: Date | null;
}

function toImport(r: ImportRow): CatalogueImport {
  return {
    id: r.id, status: r.status, fileName: r.file_name, csvSha256: r.csv_sha256, stripeMode: r.stripe_mode, summary: r.summary, plan: r.plan, result: r.result,
    createdBy: r.created_by_label, createdAt: r.created_at, appliedBy: r.applied_by_label, appliedAt: r.applied_at,
  };
}

/**
 * Upload a CSV and compute its preview. Writes only the import record (and an audit event):
 * nothing in the catalogue or in Stripe changes.
 */
export async function previewImport(sql: Sql, stripe: StripeClient, actor: Actor, raw: unknown): Promise<CatalogueImport> {
  requirePermission(actor, 'products:write');
  requirePermission(actor, 'prices:write');
  const input = typeof raw === 'object' && raw !== null ? (raw as { csv?: unknown; fileName?: unknown }) : {};
  if (typeof input.csv !== 'string' || !input.csv.trim()) throw invalid('csv (the CSV file contents) is required');
  if (new TextEncoder().encode(input.csv).length > MAX_CSV_BYTES) throw invalid(`The CSV is larger than ${MAX_CSV_BYTES / 1024} KB`);
  const fileName = typeof input.fileName === 'string' && input.fileName.trim() ? input.fileName.trim().replace(/[^\w .()-]/g, '_').slice(0, 255) : null;
  const work = await planImport(sql, stripe, input.csv);
  const id = newId('imp');
  const by = actorFields(actor);
  const csvSha = await sha256Hex(input.csv);
  await sql`INSERT INTO catalogue_imports (id, file_name, csv_sha256, csv_text, stripe_mode, plan, plan_fingerprint, summary, created_by_type, created_by_id, created_by_label)
            VALUES (${id}, ${fileName}, ${csvSha}, ${input.csv}, ${work.plan.stripeMode}, ${sql.json(work.plan as never)}, ${await fingerprint(work.plan)},
                    ${sql.json(work.plan.summary as never)}, ${by.type}, ${by.id}, ${by.label})`;
  await audit(sql, actor, { action: 'catalogue.import_previewed', resourceType: 'catalogue_import', resourceId: id, detail: { fileName, csvSha256: csvSha, ...work.plan.summary } });
  return getImport(sql, id);
}

export async function getImport(db: Db, id: string): Promise<CatalogueImport> {
  const [r] = await db<ImportRow[]>`SELECT * FROM catalogue_imports WHERE id = ${id}`;
  if (!r) throw notFound('Catalogue import');
  return toImport(r);
}

export async function listImports(db: Db, opts: { limit?: number; offset?: number } = {}) {
  const rows = await db<ImportRow[]>`
    SELECT id, status, file_name, csv_sha256, '' AS csv_text, stripe_mode, '{}'::jsonb AS plan, plan_fingerprint, summary, NULL::jsonb AS result,
           created_by_label, created_at, applied_by_label, applied_at
    FROM catalogue_imports ORDER BY created_at DESC LIMIT ${Math.min(opts.limit ?? 50, 200)} OFFSET ${opts.offset ?? 0}`;
  return rows.map((r) => {
    const { plan: _plan, result: _result, ...rest } = toImport(r);
    void _plan;
    void _result;
    return rest;
  });
}

/**
 * Apply a previewed import as `actor`. The plan is recomputed first: if the CSV, the catalogue
 * or Stripe changed since the preview, nothing is applied and the import shows the new preview
 * for review (409). Rows with errors are not applied; every other row is applied step by step
 * through the audited catalogue services. One import applies at a time.
 */
export async function applyImport(sql: Sql, stripe: StripeClient, actor: Actor, id: string): Promise<CatalogueImport> {
  requirePermission(actor, 'products:write');
  requirePermission(actor, 'prices:write');
  const [imp] = await sql<ImportRow[]>`SELECT * FROM catalogue_imports WHERE id = ${id}`;
  if (!imp) throw notFound('Catalogue import');
  if (imp.status === 'applied') throw conflict('This import has already been applied; upload the CSV again to import later changes');
  if (imp.status === 'failed') throw conflict('This import failed while applying; upload the CSV again to see what is left to do');
  if (imp.stripe_mode !== (stripe.livemode ? 'live' : 'test')) throw conflict(`This import was previewed against Stripe ${imp.stripe_mode} mode; the server now uses ${stripe.livemode ? 'live' : 'test'} mode`);
  const by = actorFields(actor);
  let claimed: Array<{ id: string }>;
  try {
    claimed = await sql<{ id: string }[]>`
      UPDATE catalogue_imports SET status = 'applying', apply_started_at = now(), applied_by_type = ${by.type}, applied_by_id = ${by.id}, applied_by_label = ${by.label}
      WHERE id = ${id} AND (status = 'previewed' OR (status = 'applying' AND apply_started_at < now() - interval '10 minutes')) RETURNING id`;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw conflict('Another catalogue import is being applied; try again when it has finished');
    throw e;
  }
  if (!claimed.length) throw conflict('This import is already being applied');

  let work: Work;
  try {
    work = await planImport(sql, stripe, imp.csv_text);
  } catch (e) {
    await sql`UPDATE catalogue_imports SET status = 'previewed', apply_started_at = NULL WHERE id = ${id}`;
    throw e;
  }
  const fp = await fingerprint(work.plan);
  if (fp !== imp.plan_fingerprint) {
    await sql`UPDATE catalogue_imports SET status = 'previewed', apply_started_at = NULL, plan = ${sql.json(work.plan as never)}, plan_fingerprint = ${fp},
              summary = ${sql.json(work.plan.summary as never)} WHERE id = ${id}`;
    await audit(sql, actor, { action: 'catalogue.import_replanned', resourceType: 'catalogue_import', resourceId: id, outcome: 'failure', detail: { ...work.plan.summary } });
    throw conflict('The catalogue or Stripe changed since this preview. Nothing was applied: review the updated preview and confirm again.', { importId: id });
  }

  let result: ImportResult;
  try {
    result = await execute(sql, stripe, actor, work);
  } catch (e) {
    await sql`UPDATE catalogue_imports SET status = 'failed', result = ${sql.json({ error: (e as Error).message } as never)} WHERE id = ${id}`;
    await audit(sql, actor, { action: 'catalogue.import_failed', resourceType: 'catalogue_import', resourceId: id, outcome: 'failure', detail: { error: (e as Error).message.slice(0, 500) } });
    throw e;
  }
  await sql`UPDATE catalogue_imports SET status = 'applied', applied_at = now(), result = ${sql.json(result as never)} WHERE id = ${id}`;
  await audit(sql, actor, { action: 'catalogue.import_applied', resourceType: 'catalogue_import', resourceId: id,
    outcome: result.counts.errors || result.counts.partial ? 'failure' : 'success',
    detail: { ...result.counts, rows: result.rows.filter((x) => x.outcome !== 'skipped').map((x) => `${x.sku}:${x.outcome}`) } });
  return getImport(sql, id);
}

async function execute(sql: Sql, stripe: StripeClient, actor: Actor, work: Work): Promise<ImportResult> {
  const ctx: ExecCtx = { sql, stripe, actor, ids: new Map() };
  const failedEntities = new Set<string>();
  const result: ImportResult = { entities: [], rows: [], counts: { applied: 0, unchanged: 0, skipped: 0, errors: 0, partial: 0, entitiesCreated: 0 } };
  // Products, then majors, then edition policies (planImport built them in that order).
  for (const e of work.entities) {
    if (e.entity.action === 'error') {
      failedEntities.add(e.entity.key);
      result.entities.push({ key: e.entity.key, label: e.entity.label, outcome: 'not_attempted', error: e.entity.errors.join('; ') });
      continue;
    }
    if (!e.steps.length) {
      result.entities.push({ key: e.entity.key, label: e.entity.label, outcome: 'unchanged' });
      continue;
    }
    try {
      for (const st of e.steps) await st.run(ctx);
      result.entities.push({ key: e.entity.key, label: e.entity.label, outcome: 'created' });
      result.counts.entitiesCreated++;
    } catch (err) {
      failedEntities.add(e.entity.key);
      result.entities.push({ key: e.entity.key, label: e.entity.label, outcome: 'error', error: messageOf(err) });
    }
  }
  for (const w of work.rows) {
    const r = w.row;
    const out: ImportResult['rows'][number] = { line: r.line, sku: r.sku, outcome: 'unchanged', done: [], ...(r.offerId ? { offerId: r.offerId } : {}) };
    result.rows.push(out);
    if (r.action === 'skipped') {
      out.outcome = 'skipped';
      result.counts.skipped++;
      continue;
    }
    if (r.action === 'error') {
      out.outcome = 'error';
      out.error = r.errors.join('; ');
      result.counts.errors++;
      continue;
    }
    const blocked = w.deps.filter((k) => failedEntities.has(k));
    if (blocked.length) {
      out.outcome = 'error';
      out.error = `Not applied: ${blocked.join(', ')} could not be created`;
      result.counts.errors++;
      continue;
    }
    if (!w.steps.length) {
      result.counts.unchanged++;
      continue;
    }
    try {
      for (const st of w.steps) {
        await st.run(ctx);
        out.done.push(st.label);
      }
      out.outcome = 'applied';
      result.counts.applied++;
    } catch (err) {
      out.outcome = out.done.length ? 'partial' : 'error';
      out.error = `${messageOf(err)}${out.done.length ? ' (the completed steps are listed; upload the CSV again to see and apply what is left)' : ''}`;
      if (out.done.length) result.counts.partial++;
      else result.counts.errors++;
    }
    const created = ctx.ids.get(offerKey(r.line));
    if (created) out.offerId = created;
  }
  return result;
}

function messageOf(e: unknown): string {
  if (e instanceof AppError) {
    const details = Array.isArray(e.details) ? (e.details as Array<{ path?: string; message: string }>).map((d) => `${d.path ? `${d.path}: ` : ''}${d.message}`).join('; ') : '';
    return details && !e.message.includes(details) ? `${e.message} (${details})` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
