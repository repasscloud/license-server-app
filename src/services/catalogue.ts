// Catalogue: the PostgreSQL master for products, majors, releases, edition policies, offers
// (SKUs and bundles) and immutable price versions. Used identically by the admin UI and the
// admin REST API. Stripe objects are downstream mappings (see stripe-sync.ts).

import { z } from 'zod';
import type { Db, Sql, Tx } from '../db/client.ts';
import { computeEffectivePolicy, validateOfferShape, validatePolicy, validatePrice, type EffectivePolicy, type PolicyProblem, type PolicyRows } from '../domain/policy.ts';
import { getProtocol, implementedProtocolIds } from '../domain/protocols.ts';
import { AppError, conflict, invalid, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { compareSemver } from '../lib/semver.ts';
import { requirePermission, type Actor } from './actor.ts';
import { audit } from './audit.ts';

const slug = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, 'lower-case letters, digits, _ . - (max 64)');
const text = (max: number) => z.string().trim().max(max);

function problemsError(problems: PolicyProblem[]): AppError {
  return new AppError('protocol_incompatible', problems.map((p) => p.message).join('; '), { problems });
}

// ---------------------------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------------------------

export const CreateProductInput = z.object({
  slug,
  name: text(200).min(1),
  description: text(4000).default(''),
  vendor: text(200).default('RePassCloud'),
  visibility: z.enum(['public', 'private']).default('public'),
  supportUrl: z.url().nullable().optional(),
}).strict();

export const UpdateProductInput = z.object({
  name: text(200).min(1).optional(),
  description: text(4000).optional(),
  status: z.enum(['draft', 'active', 'retired']).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  supportUrl: z.url().nullable().optional(),
}).strict();

export async function createProduct(sql: Sql, actor: Actor, raw: unknown) {
  requirePermission(actor, 'products:write');
  const input = CreateProductInput.parse(raw);
  return sql.begin(async (tx) => {
    const exists = await tx`SELECT 1 FROM products WHERE slug = ${input.slug}`;
    if (exists.length) throw conflict(`Product id ${input.slug} already exists (product ids are immutable and never reused)`);
    const id = newId('prd');
    await tx`INSERT INTO products (id, slug, name, description, vendor, visibility, support_url)
             VALUES (${id}, ${input.slug}, ${input.name}, ${input.description}, ${input.vendor}, ${input.visibility}, ${input.supportUrl ?? null})`;
    await audit(tx, actor, { action: 'product.created', resourceType: 'product', resourceId: id, detail: { slug: input.slug } });
    return getProduct(tx, id);
  });
}

export async function updateProduct(sql: Sql, actor: Actor, idOrSlug: string, raw: unknown) {
  requirePermission(actor, 'products:write');
  const input = UpdateProductInput.parse(raw);
  return sql.begin(async (tx) => {
    // Accept the internal id or the immutable slug (wire productId), like getProduct.
    const [p] = await tx<{ id: string; status: string }[]>`SELECT id, status FROM products WHERE id = ${idOrSlug} OR slug = ${idOrSlug} FOR UPDATE`;
    if (!p) throw notFound('Product');
    const id = p.id;
    await tx`UPDATE products SET
      name = coalesce(${input.name ?? null}, name),
      description = coalesce(${input.description ?? null}, description),
      status = coalesce(${input.status ?? null}, status),
      visibility = coalesce(${input.visibility ?? null}, visibility),
      support_url = CASE WHEN ${input.supportUrl !== undefined} THEN ${input.supportUrl ?? null} ELSE support_url END
      WHERE id = ${id}`;
    await audit(tx, actor, { action: 'product.updated', resourceType: 'product', resourceId: id, detail: { changes: input } });
    return getProduct(tx, id);
  });
}

export async function listProducts(db: Db, opts: { status?: string; search?: string; limit?: number; offset?: number } = {}) {
  const limit = Math.min(opts.limit ?? 50, 200);
  return db<{ id: string; slug: string; name: string; status: string; visibility: string; majors: number }[]>`
    SELECT p.id, p.slug, p.name, p.status, p.visibility,
           (SELECT count(*)::int FROM product_majors m WHERE m.product_id = p.id) AS majors
    FROM products p
    WHERE (${opts.status ?? null}::text IS NULL OR p.status = ${opts.status ?? null})
      AND (${opts.search ?? null}::text IS NULL OR p.slug ILIKE '%' || ${opts.search ?? ''} || '%' OR p.name ILIKE '%' || ${opts.search ?? ''} || '%')
    ORDER BY p.slug LIMIT ${limit} OFFSET ${opts.offset ?? 0}`;
}

export async function getProduct(db: Db, idOrSlug: string) {
  const [p] = await db<{ id: string; slug: string; name: string; description: string; vendor: string; status: string; visibility: string; support_url: string | null; created_at: Date }[]>`
    SELECT * FROM products WHERE id = ${idOrSlug} OR slug = ${idOrSlug}`;
  if (!p) throw notFound('Product');
  const majors = await db<{ id: string; major_version: number; protocol_id: string; status: string; default_transfer_allowance: number; activation_key_email: boolean }[]>`
    SELECT id, major_version, protocol_id, status, default_transfer_allowance, activation_key_email FROM product_majors WHERE product_id = ${p.id} ORDER BY major_version`;
  return { ...p, majors };
}

// ---------------------------------------------------------------------------------------------
// Majors and releases
// ---------------------------------------------------------------------------------------------

export const CreateMajorInput = z.object({
  productId: z.string().min(1),
  majorVersion: z.number().int().min(0).max(1_000_000),
  protocolId: z.string().min(1),
  defaultTransferAllowance: z.number().int().min(0).max(1000).default(3),
  activationKeyEmail: z.boolean().default(true),
}).strict();

export const UpdateMajorInput = z.object({
  status: z.enum(['draft', 'active', 'sales_closed', 'retired']).optional(),
  defaultTransferAllowance: z.number().int().min(0).max(1000).optional(),
  activationKeyEmail: z.boolean().optional(),
  protocolId: z.string().optional(),
}).strict();

export async function createMajor(sql: Sql, actor: Actor, raw: unknown) {
  requirePermission(actor, 'products:write');
  const input = CreateMajorInput.parse(raw);
  if (!getProtocol(input.protocolId)) throw invalid(`Protocol ${input.protocolId} is not implemented (implemented: ${implementedProtocolIds().join(', ')})`);
  return sql.begin(async (tx) => {
    const [p] = await tx<{ id: string }[]>`SELECT id FROM products WHERE id = ${input.productId} OR slug = ${input.productId}`;
    if (!p) throw notFound('Product');
    const dup = await tx`SELECT 1 FROM product_majors WHERE product_id = ${p.id} AND major_version = ${input.majorVersion}`;
    if (dup.length) throw conflict(`Major ${input.majorVersion} already exists`);
    const id = newId('pmj');
    await tx`INSERT INTO product_majors (id, product_id, major_version, protocol_id, default_transfer_allowance, activation_key_email)
             VALUES (${id}, ${p.id}, ${input.majorVersion}, ${input.protocolId}, ${input.defaultTransferAllowance}, ${input.activationKeyEmail})`;
    await audit(tx, actor, { action: 'product_major.created', resourceType: 'product_major', resourceId: id, detail: { productId: p.id, majorVersion: input.majorVersion, protocolId: input.protocolId } });
    return getMajor(tx, id);
  });
}

export async function updateMajor(sql: Sql, actor: Actor, id: string, raw: unknown) {
  requirePermission(actor, 'products:write');
  const input = UpdateMajorInput.parse(raw);
  return sql.begin(async (tx) => {
    const [m] = await tx<{ status: string; protocol_id: string }[]>`SELECT status, protocol_id FROM product_majors WHERE id = ${id} FOR UPDATE`;
    if (!m) throw notFound('Product major');
    if (input.protocolId && input.protocolId !== m.protocol_id) {
      if (m.status !== 'draft') throw conflict('The wire protocol of a major cannot change after it is activated; create a new major');
      if (!getProtocol(input.protocolId)) throw invalid(`Protocol ${input.protocolId} is not implemented`);
    }
    await tx`UPDATE product_majors SET
      status = coalesce(${input.status ?? null}, status),
      default_transfer_allowance = coalesce(${input.defaultTransferAllowance ?? null}, default_transfer_allowance),
      activation_key_email = coalesce(${input.activationKeyEmail ?? null}, activation_key_email),
      protocol_id = coalesce(${input.protocolId ?? null}, protocol_id)
      WHERE id = ${id}`;
    await audit(tx, actor, { action: 'product_major.updated', resourceType: 'product_major', resourceId: id, detail: { changes: input } });
    return getMajor(tx, id);
  });
}

export async function getMajor(db: Db, id: string) {
  const [m] = await db<{ id: string; product_id: string; slug: string; product_name: string; major_version: number; protocol_id: string; status: string; default_transfer_allowance: number; activation_key_email: boolean }[]>`
    SELECT m.*, p.slug, p.name AS product_name FROM product_majors m JOIN products p ON p.id = m.product_id WHERE m.id = ${id}`;
  if (!m) throw notFound('Product major');
  const releases = await db<{ id: string; version: string; status: string; is_minimum_supported: boolean; shipped_at: Date | null; notes: string }[]>`
    SELECT id, version, status, is_minimum_supported, shipped_at, notes FROM product_releases WHERE product_major_id = ${id}`;
  releases.sort((a, b) => compareSemver(a.version, b.version));
  const editions = await listEditionPolicies(db, id);
  return { ...m, releases, editions };
}

export const ReleaseInput = z.object({
  productMajorId: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$/),
  status: z.enum(['planned', 'shipped', 'withdrawn']).default('planned'),
  isMinimumSupported: z.boolean().default(false),
  notes: text(2000).default(''),
}).strict();

export async function upsertRelease(sql: Sql, actor: Actor, raw: unknown) {
  requirePermission(actor, 'products:write');
  const input = ReleaseInput.parse(raw);
  return sql.begin(async (tx) => {
    const [m] = await tx<{ major_version: number }[]>`SELECT major_version FROM product_majors WHERE id = ${input.productMajorId} FOR UPDATE`;
    if (!m) throw notFound('Product major');
    if (Number(input.version.split('.')[0]) !== m.major_version) throw invalid(`Release ${input.version} does not belong to major ${m.major_version}`);
    if (input.isMinimumSupported && input.status !== 'shipped') throw invalid('Only a shipped release can be the minimum supported release');
    if (input.isMinimumSupported) await tx`UPDATE product_releases SET is_minimum_supported = false WHERE product_major_id = ${input.productMajorId}`;
    const id = newId('rel');
    await tx`INSERT INTO product_releases (id, product_major_id, version, status, is_minimum_supported, shipped_at, notes)
             VALUES (${id}, ${input.productMajorId}, ${input.version}, ${input.status}, ${input.isMinimumSupported}, ${input.status === 'shipped' ? new Date() : null}, ${input.notes})
             ON CONFLICT (product_major_id, version) DO UPDATE SET
               status = EXCLUDED.status, is_minimum_supported = EXCLUDED.is_minimum_supported, notes = EXCLUDED.notes,
               shipped_at = coalesce(product_releases.shipped_at, EXCLUDED.shipped_at)`;
    await audit(tx, actor, { action: 'product_release.upserted', resourceType: 'product_major', resourceId: input.productMajorId, detail: { version: input.version, status: input.status, isMinimumSupported: input.isMinimumSupported } });
    return getMajor(tx, input.productMajorId);
  });
}

// ---------------------------------------------------------------------------------------------
// Edition policies
// ---------------------------------------------------------------------------------------------

export const EditionPolicyInput = z.object({
  productMajorId: z.string().min(1),
  editionId: z.string().min(1),
  displayName: text(100).min(1),
  activationModel: z.enum(['none', 'device_seats']),
  ownership: z.enum(['individual', 'organisation', 'institution']).default('individual'),
  transferAllowance: z.number().int().min(0).max(1000).nullable().default(null),
  certificateLifetimeSeconds: z.number().int().min(3600).max(10 * 365 * 86400).nullable().default(null),
  offlinePolicy: z.enum(['indefinite', 'periodic_check']).default('indefinite'),
  status: z.enum(['active', 'retired']).default('active'),
}).strict();

export async function listEditionPolicies(db: Db, productMajorId: string) {
  return db<{ id: string; edition_id: string; wire_id: string; display_name: string; activation_model: string; ownership: string; transfer_allowance: number | null; certificate_lifetime_seconds: number | null; offline_policy: string; status: string }[]>`
    SELECT ep.*, e.wire_id FROM product_edition_policies ep JOIN edition_definitions e ON e.id = ep.edition_id
    WHERE ep.product_major_id = ${productMajorId} ORDER BY ep.created_at`;
}

export async function upsertEditionPolicy(sql: Sql, actor: Actor, raw: unknown) {
  requirePermission(actor, 'products:write');
  const input = EditionPolicyInput.parse(raw);
  return sql.begin(async (tx) => {
    const [ed] = await tx<{ wire_id: string }[]>`SELECT wire_id FROM edition_definitions WHERE id = ${input.editionId}`;
    if (!ed) throw notFound('Edition definition');
    const [existing] = await tx<{ id: string }[]>`SELECT id FROM product_edition_policies WHERE product_major_id = ${input.productMajorId} AND edition_id = ${input.editionId} FOR UPDATE`;
    const id = existing?.id ?? newId('pep');
    if (existing) {
      await tx`UPDATE product_edition_policies SET display_name = ${input.displayName}, activation_model = ${input.activationModel}, ownership = ${input.ownership},
                 transfer_allowance = ${input.transferAllowance}, certificate_lifetime_seconds = ${input.certificateLifetimeSeconds},
                 offline_policy = ${input.offlinePolicy}, status = ${input.status} WHERE id = ${id}`;
    } else {
      await tx`INSERT INTO product_edition_policies (id, product_major_id, edition_id, display_name, activation_model, ownership, transfer_allowance, certificate_lifetime_seconds, offline_policy, status)
               VALUES (${id}, ${input.productMajorId}, ${input.editionId}, ${input.displayName}, ${input.activationModel}, ${input.ownership}, ${input.transferAllowance}, ${input.certificateLifetimeSeconds}, ${input.offlinePolicy}, ${input.status})`;
    }
    // Validate the edition against its protocol with a perpetual probe component, then
    // re-validate every offer component that uses it. Existing entitlements are unaffected
    // (they carry immutable snapshots).
    const probe = await loadPolicyRows(tx, id, null);
    const probeProblems = validatePolicy(computeEffectivePolicy({ ...probe, component: { ...probe.component, term_type: 'perpetual' } }, 1));
    if (probeProblems.length) throw problemsError(probeProblems);
    const comps = await tx<{ id: string; offer_id: string; sku: string; status: string }[]>`
      SELECT c.id, c.offer_id, o.sku, o.status FROM offer_entitlement_components c JOIN offers o ON o.id = c.offer_id
      WHERE c.edition_policy_id = ${id} AND o.status <> 'archived'`;
    for (const c of comps) {
      const rows = await loadPolicyRows(tx, id, c.id);
      const problems = validatePolicy(computeEffectivePolicy(rows, 1));
      if (problems.length) throw new AppError('protocol_incompatible', `Change would make offer ${c.sku} invalid: ${problems.map((p) => p.message).join('; ')}`, { problems });
    }
    await audit(tx, actor, { action: existing ? 'edition_policy.updated' : 'edition_policy.created', resourceType: 'edition_policy', resourceId: id, detail: { ...input } });
    const [out] = (await listEditionPolicies(tx, input.productMajorId)).filter((p) => p.id === id);
    return out!;
  });
}

/** Load the rows needed to compute an effective policy. componentId=null => perpetual probe. */
export async function loadPolicyRows(db: Db, editionPolicyId: string, componentId: string | null): Promise<PolicyRows> {
  const [r] = await db<Record<string, unknown>[]>`
    SELECT p.id AS product_id, p.slug, p.name AS product_name,
           m.id AS major_id, m.major_version, m.protocol_id, m.default_transfer_allowance, m.activation_key_email,
           ep.id AS ep_id, ep.edition_id, e.wire_id, ep.display_name, ep.activation_model, ep.ownership,
           ep.transfer_allowance AS ep_transfer, ep.certificate_lifetime_seconds, ep.offline_policy
    FROM product_edition_policies ep
    JOIN edition_definitions e ON e.id = ep.edition_id
    JOIN product_majors m ON m.id = ep.product_major_id
    JOIN products p ON p.id = m.product_id
    WHERE ep.id = ${editionPolicyId}`;
  if (!r) throw notFound('Edition policy');
  let component: PolicyRows['component'] = {
    id: 'probe', term_type: 'perpetual', term_interval: null, term_interval_count: null,
    seats_per_unit: r.activation_model === 'device_seats' ? 1 : null, quantity_scales_seats: false,
    trial_days: null, grace_days: 0, transfer_allowance: null, refund_action: 'revoke', dispute_action: 'review',
  };
  let offer: PolicyRows['offer'] = null;
  if (componentId) {
    const [c] = await db<(PolicyRows['component'] & { offer_id: string; sku: string })[]>`
      SELECT c.*, o.sku FROM offer_entitlement_components c JOIN offers o ON o.id = c.offer_id WHERE c.id = ${componentId}`;
    if (!c) throw notFound('Offer component');
    component = c;
    offer = { id: c.offer_id, sku: c.sku };
  }
  return {
    product: { id: r.product_id as string, slug: r.slug as string, name: r.product_name as string },
    major: {
      id: r.major_id as string, major_version: r.major_version as number, protocol_id: r.protocol_id as string,
      default_transfer_allowance: r.default_transfer_allowance as number, activation_key_email: r.activation_key_email as boolean,
    },
    editionPolicy: {
      id: r.ep_id as string, edition_id: r.edition_id as string, wire_id: r.wire_id as string, display_name: r.display_name as string,
      activation_model: r.activation_model as 'none' | 'device_seats', ownership: r.ownership as 'individual' | 'organisation' | 'institution',
      transfer_allowance: r.ep_transfer as number | null, certificate_lifetime_seconds: r.certificate_lifetime_seconds as number | null,
      offline_policy: r.offline_policy as 'indefinite' | 'periodic_check',
    },
    component,
    offer,
  };
}

// ---------------------------------------------------------------------------------------------
// Offers (SKUs, bundles) and components
// ---------------------------------------------------------------------------------------------

export const ComponentInput = z.object({
  editionPolicyId: z.string().min(1),
  termType: z.enum(['perpetual', 'subscription', 'fixed_term']),
  termInterval: z.enum(['day', 'week', 'month', 'year']).nullable().default(null),
  termIntervalCount: z.number().int().min(1).max(120).nullable().default(null),
  seatsPerUnit: z.number().int().min(1).max(100000).nullable().default(null),
  quantityScalesSeats: z.boolean().default(false),
  trialDays: z.number().int().min(1).max(730).nullable().default(null),
  graceDays: z.number().int().min(0).max(90).default(0),
  transferAllowance: z.number().int().min(0).max(1000).nullable().default(null),
  refundAction: z.enum(['revoke', 'review', 'none']).default('revoke'),
  disputeAction: z.enum(['revoke', 'review', 'none']).default('review'),
}).strict();

export const CreateOfferInput = z.object({
  sku: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
  name: text(200).min(1),
  description: text(4000).default(''),
  kind: z.enum(['single', 'bundle']),
  billing: z.enum(['one_time', 'recurring', 'free']),
  visibility: z.enum(['public', 'private']).default('public'),
  availableFrom: z.coerce.date().nullable().default(null),
  availableUntil: z.coerce.date().nullable().default(null),
  minQuantity: z.number().int().min(1).default(1),
  maxQuantity: z.number().int().min(1).max(10000).default(1),
  allowPromotionCodes: z.boolean().default(true),
  automaticTax: z.boolean().default(false),
  billingAddressCollection: z.enum(['auto', 'required']).default('auto'),
  taxIdCollection: z.boolean().default(false),
  customerKind: z.enum(['any', 'individual', 'organisation']).default('any'),
  components: z.array(ComponentInput).min(1).max(20),
}).strict();

export const UpdateOfferInput = z.object({
  name: text(200).min(1).optional(),
  description: text(4000).optional(),
  visibility: z.enum(['public', 'private']).optional(),
  availableFrom: z.coerce.date().nullable().optional(),
  availableUntil: z.coerce.date().nullable().optional(),
  allowPromotionCodes: z.boolean().optional(),
  automaticTax: z.boolean().optional(),
  billingAddressCollection: z.enum(['auto', 'required']).optional(),
  taxIdCollection: z.boolean().optional(),
}).strict();

async function validateOfferComponents(tx: Tx, offerId: string, input: { kind: 'single' | 'bundle'; billing: 'one_time' | 'recurring' | 'free'; maxQuantity: number }): Promise<PolicyProblem[]> {
  const comps = await tx<{ id: string; edition_policy_id: string; quantity_scales_seats: boolean }[]>`SELECT id, edition_policy_id, quantity_scales_seats FROM offer_entitlement_components WHERE offer_id = ${offerId} ORDER BY position`;
  const evaluated: Array<{ productMajorId: string; policy: EffectivePolicy; quantityScalesSeats: boolean }> = [];
  for (const c of comps) {
    const rows = await loadPolicyRows(tx, c.edition_policy_id, c.id);
    evaluated.push({ productMajorId: rows.major.id, policy: computeEffectivePolicy(rows, 1), quantityScalesSeats: c.quantity_scales_seats });
  }
  return validateOfferShape({ ...input, components: evaluated });
}

export async function createOffer(sql: Sql, actor: Actor, raw: unknown) {
  requirePermission(actor, 'products:write');
  const input = CreateOfferInput.parse(raw);
  if (input.maxQuantity < input.minQuantity) throw invalid('maxQuantity must be >= minQuantity');
  return sql.begin(async (tx) => {
    const dup = await tx`SELECT 1 FROM offers WHERE sku = ${input.sku}`;
    if (dup.length) throw conflict(`SKU ${input.sku} already exists`);
    const id = newId('off');
    await tx`INSERT INTO offers (id, sku, name, description, kind, billing, visibility, available_from, available_until, min_quantity, max_quantity,
                                 allow_promotion_codes, automatic_tax, billing_address_collection, tax_id_collection, customer_kind)
             VALUES (${id}, ${input.sku}, ${input.name}, ${input.description}, ${input.kind}, ${input.billing}, ${input.visibility},
                     ${input.availableFrom}, ${input.availableUntil}, ${input.minQuantity}, ${input.maxQuantity},
                     ${input.allowPromotionCodes}, ${input.automaticTax}, ${input.billingAddressCollection}, ${input.taxIdCollection}, ${input.customerKind})`;
    let pos = 0;
    for (const c of input.components) {
      const ep = await tx`SELECT 1 FROM product_edition_policies WHERE id = ${c.editionPolicyId} AND status = 'active'`;
      if (!ep.length) throw notFound(`Active edition policy ${c.editionPolicyId}`);
      await tx`INSERT INTO offer_entitlement_components (id, offer_id, edition_policy_id, position, term_type, term_interval, term_interval_count, seats_per_unit,
                         quantity_scales_seats, trial_days, grace_days, transfer_allowance, refund_action, dispute_action)
               VALUES (${newId('ocp')}, ${id}, ${c.editionPolicyId}, ${pos++}, ${c.termType}, ${c.termInterval}, ${c.termIntervalCount}, ${c.seatsPerUnit},
                       ${c.quantityScalesSeats}, ${c.trialDays}, ${c.graceDays}, ${c.transferAllowance}, ${c.refundAction}, ${c.disputeAction})`;
    }
    const problems = await validateOfferComponents(tx, id, input);
    if (problems.length) throw problemsError(problems);
    await tx`INSERT INTO stripe_product_mappings (offer_id) VALUES (${id})`;
    await audit(tx, actor, { action: 'offer.created', resourceType: 'offer', resourceId: id, detail: { sku: input.sku, kind: input.kind, billing: input.billing, components: input.components.length } });
    return getOffer(tx, id);
  });
}

export async function updateOffer(sql: Sql, actor: Actor, id: string, raw: unknown) {
  requirePermission(actor, 'products:write');
  const input = UpdateOfferInput.parse(raw);
  return sql.begin(async (tx) => {
    const [o] = await tx`SELECT 1 FROM offers WHERE id = ${id} FOR UPDATE`;
    if (!o) throw notFound('Offer');
    await tx`UPDATE offers SET
      name = coalesce(${input.name ?? null}, name),
      description = coalesce(${input.description ?? null}, description),
      visibility = coalesce(${input.visibility ?? null}, visibility),
      available_from = CASE WHEN ${input.availableFrom !== undefined} THEN ${input.availableFrom ?? null}::timestamptz ELSE available_from END,
      available_until = CASE WHEN ${input.availableUntil !== undefined} THEN ${input.availableUntil ?? null}::timestamptz ELSE available_until END,
      allow_promotion_codes = coalesce(${input.allowPromotionCodes ?? null}, allow_promotion_codes),
      automatic_tax = coalesce(${input.automaticTax ?? null}, automatic_tax),
      billing_address_collection = coalesce(${input.billingAddressCollection ?? null}, billing_address_collection),
      tax_id_collection = coalesce(${input.taxIdCollection ?? null}, tax_id_collection)
      WHERE id = ${id}`;
    // The linked Stripe product is managed in Stripe: renaming the offer never renames it.
    await audit(tx, actor, { action: 'offer.updated', resourceType: 'offer', resourceId: id, detail: { changes: input } });
    return getOffer(tx, id);
  });
}

/**
 * Activate (publish) or archive an offer. Activation requires a valid protocol combination,
 * active product/majors, an active price in every store currency, and a linked, verified Stripe
 * product: an offer without one is never purchasable (the server never creates products).
 */
export async function setOfferStatus(sql: Sql, actor: Actor, id: string, status: 'active' | 'archived' | 'draft') {
  requirePermission(actor, 'products:write');
  return sql.begin(async (tx) => {
    const [o] = await tx<{ status: string; kind: 'single' | 'bundle'; billing: 'one_time' | 'recurring' | 'free'; max_quantity: number }[]>`
      SELECT status, kind, billing, max_quantity FROM offers WHERE id = ${id} FOR UPDATE`;
    if (!o) throw notFound('Offer');
    if (status === 'active') {
      const problems = await validateOfferComponents(tx, id, { kind: o.kind, billing: o.billing, maxQuantity: o.max_quantity });
      const inactive = await tx<{ slug: string; major_version: number; ps: string; ms: string }[]>`
        SELECT p.slug, m.major_version, p.status AS ps, m.status AS ms FROM offer_entitlement_components c
        JOIN product_edition_policies ep ON ep.id = c.edition_policy_id JOIN product_majors m ON m.id = ep.product_major_id JOIN products p ON p.id = m.product_id
        WHERE c.offer_id = ${id} AND (p.status <> 'active' OR m.status <> 'active')`;
      for (const i of inactive) problems.push({ rule: 'offer.product_inactive', message: `${i.slug} v${i.major_version} is not active (product ${i.ps}, major ${i.ms})` });
      const missing = await missingCurrencies(tx, id);
      if (missing.length) problems.push({ rule: 'offer.price', message: `Offer needs an active price in every store currency; missing ${missing.join(', ').toUpperCase()}` });
      const [pm] = await tx<{ stripe_product_id: string | null; sync_state: string; last_error: string | null }[]>`
        SELECT stripe_product_id, sync_state, last_error FROM stripe_product_mappings WHERE offer_id = ${id}`;
      if (!pm?.stripe_product_id) problems.push({ rule: 'offer.stripe_product', message: 'Link the offer to its Stripe product (prod_…) before activating' });
      else if (pm.sync_state !== 'synced') problems.push({ rule: 'offer.stripe_product', message: `Stripe product ${pm.stripe_product_id} is not verified (${pm.sync_state}${pm.last_error ? `: ${pm.last_error}` : ''}); verify or relink it` });
      if (problems.length) throw new AppError('precondition_failed', problems.map((p) => p.message).join('; '), { problems });
    }
    await tx`UPDATE offers SET status = ${status} WHERE id = ${id}`;
    await audit(tx, actor, { action: `offer.${status}`, resourceType: 'offer', resourceId: id });
    return getOffer(tx, id);
  });
}

export async function listOffers(db: Db, opts: { status?: string; productId?: string; limit?: number; offset?: number } = {}) {
  return db<{ id: string; sku: string; name: string; kind: string; billing: string; status: string; visibility: string; components: number; active_prices: number }[]>`
    SELECT o.id, o.sku, o.name, o.kind, o.billing, o.status, o.visibility,
      (SELECT count(*)::int FROM offer_entitlement_components c WHERE c.offer_id = o.id) AS components,
      (SELECT count(*)::int FROM price_versions pv WHERE pv.offer_id = o.id AND pv.status = 'active') AS active_prices
    FROM offers o
    WHERE (${opts.status ?? null}::text IS NULL OR o.status = ${opts.status ?? null})
      AND (${opts.productId ?? null}::text IS NULL OR EXISTS (
            SELECT 1 FROM offer_entitlement_components c JOIN product_edition_policies ep ON ep.id = c.edition_policy_id
            JOIN product_majors m ON m.id = ep.product_major_id WHERE c.offer_id = o.id AND m.product_id = ${opts.productId ?? null}))
    ORDER BY o.created_at DESC LIMIT ${Math.min(opts.limit ?? 50, 200)} OFFSET ${opts.offset ?? 0}`;
}

export async function getOffer(db: Db, idOrSku: string) {
  const [o] = await db<Record<string, unknown>[]>`SELECT * FROM offers WHERE id = ${idOrSku} OR sku = ${idOrSku}`;
  if (!o) throw notFound('Offer');
  const components = await db<Record<string, unknown>[]>`
    SELECT c.*, p.slug AS product_slug, p.name AS product_name, m.major_version, m.protocol_id, e.wire_id AS edition_wire_id, ep.display_name AS edition_name, ep.activation_model
    FROM offer_entitlement_components c
    JOIN product_edition_policies ep ON ep.id = c.edition_policy_id JOIN edition_definitions e ON e.id = ep.edition_id
    JOIN product_majors m ON m.id = ep.product_major_id JOIN products p ON p.id = m.product_id
    WHERE c.offer_id = ${o.id as string} ORDER BY c.position`;
  const prices = await db<Record<string, unknown>[]>`
    SELECT pv.* FROM price_versions pv WHERE pv.offer_id = ${o.id as string} ORDER BY pv.created_at DESC`;
  const [stripeProduct] = await db<Record<string, unknown>[]>`SELECT * FROM stripe_product_mappings WHERE offer_id = ${o.id as string}`;
  return { ...o, components, prices, stripeProduct: stripeProduct ?? null };
}

// ---------------------------------------------------------------------------------------------
// Prices: immutable versions
// ---------------------------------------------------------------------------------------------

/** Currencies the store sells in (owner decision 2026-10-12), in display order. */
export const STORE_CURRENCIES = ['aud', 'usd', 'eur', 'gbp', 'cad', 'nzd', 'sgd', 'hkd', 'jpy', 'cny', 'chf'] as const;

export const CreatePriceInput = z.object({
  offerId: z.string().min(1),
  currency: z.string().regex(/^[A-Za-z]{3}$/).transform((s) => s.toLowerCase())
    .refine((c) => (STORE_CURRENCIES as readonly string[]).includes(c), { message: `Currency must be one of ${STORE_CURRENCIES.join(', ').toUpperCase()}` }),
  unitAmount: z.number().int().min(0).max(99_999_999_999),
  recurringInterval: z.enum(['day', 'week', 'month', 'year']).nullable().default(null),
  recurringIntervalCount: z.number().int().min(1).max(365).nullable().default(null),
  taxBehavior: z.enum(['inclusive', 'exclusive', 'unspecified']).default('unspecified'),
  effectiveFrom: z.coerce.date().nullable().default(null),
  effectiveUntil: z.coerce.date().nullable().default(null),
  /** Flat tax added on top of the price at checkout, e.g. 10 (%) with label "GST". */
  taxRatePercent: z.number().gt(0).max(100).refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, 'At most two decimal places').nullable().default(null),
  taxLabel: z.string().trim().regex(/^[A-Za-z0-9 .()%/-]{1,50}$/).nullable().default(null),
}).strict().refine((v) => (v.taxRatePercent === null) === (v.taxLabel === null), { message: 'taxRatePercent and taxLabel go together' });

/**
 * Create a draft price version. Prices live only in the database: Checkout sends the amount to
 * Stripe inline (price_data) from the version the buyer was shown. Never mutates history.
 */
export async function createPriceVersion(sql: Sql, actor: Actor, raw: unknown) {
  requirePermission(actor, 'prices:write');
  const input = CreatePriceInput.parse(raw);
  return sql.begin(async (tx) => getPriceVersion(tx, await insertPriceVersion(tx, actor, input)));
}

async function insertPriceVersion(tx: Tx, actor: Actor, input: z.infer<typeof CreatePriceInput>): Promise<string> {
  const interval = input.recurringInterval;
  const intervalCount = interval ? (input.recurringIntervalCount ?? 1) : null;
  const [o] = await tx<{ billing: 'one_time' | 'recurring' | 'free'; status: string; automatic_tax: boolean }[]>`SELECT billing, status, automatic_tax FROM offers WHERE id = ${input.offerId} FOR UPDATE`;
  if (!o) throw notFound('Offer');
  if (o.status === 'archived') throw conflict('Cannot add prices to an archived offer');
  if (input.taxRatePercent !== null && o.automatic_tax) throw invalid('This offer uses Stripe automatic tax; a flat tax rate cannot also be set');
  const problems = validatePrice({ billing: o.billing, unitAmount: input.unitAmount, recurringInterval: interval });
  if (problems.length) throw problemsError(problems);
  const id = newId('prc');
  const taxBps = input.taxRatePercent === null ? null : Math.round(input.taxRatePercent * 100);
  await tx`INSERT INTO price_versions (id, offer_id, currency, unit_amount, recurring_interval, recurring_interval_count, tax_behavior, effective_from, effective_until, created_by, tax_rate_bps, tax_label)
           VALUES (${id}, ${input.offerId}, ${input.currency}, ${input.unitAmount}, ${interval}, ${intervalCount}, ${input.taxBehavior}, ${input.effectiveFrom}, ${input.effectiveUntil}, ${actor.label},
                   ${taxBps}, ${input.taxLabel})`;
  await audit(tx, actor, { action: 'price.created', resourceType: 'price_version', resourceId: id, detail: { offerId: input.offerId, currency: input.currency, unitAmount: input.unitAmount, interval, intervalCount, taxBps, taxLabel: input.taxLabel } });
  return id;
}

/**
 * Make a price version the sellable price. Atomically archives the previously active price for
 * the same offer/currency/interval (it stays referenced by historical purchases/subscriptions;
 * existing Stripe subscriptions keep the amount they were bought at).
 */
export async function activatePriceVersion(sql: Sql, actor: Actor, id: string) {
  requirePermission(actor, 'prices:write');
  return sql.begin((tx) => activateInTx(tx, actor, id));
}

async function activateInTx(tx: Tx, actor: Actor, id: string) {
  const [pv] = await tx<{ offer_id: string; currency: string; recurring_interval: string | null; recurring_interval_count: number | null; status: string }[]>`
    SELECT pv.offer_id, pv.currency, pv.recurring_interval, pv.recurring_interval_count, pv.status FROM price_versions pv WHERE pv.id = ${id} FOR UPDATE`;
  if (!pv) throw notFound('Price version');
  if (pv.status === 'active') return getPriceVersion(tx, id);
  if (pv.status === 'archived') throw conflict('Archived prices cannot be reactivated; create a new price version');
  const previous = await tx<{ id: string }[]>`
    SELECT id FROM price_versions WHERE offer_id = ${pv.offer_id} AND currency = ${pv.currency} AND status = 'active'
      AND coalesce(recurring_interval, '') = ${pv.recurring_interval ?? ''} AND coalesce(recurring_interval_count, 0) = ${pv.recurring_interval_count ?? 0}
    FOR UPDATE`;
  for (const p of previous) {
    await tx`UPDATE price_versions SET status = 'archived', effective_until = coalesce(effective_until, now()) WHERE id = ${p.id}`;
    await audit(tx, actor, { action: 'price.archived', resourceType: 'price_version', resourceId: p.id, detail: { supersededBy: id } });
  }
  await tx`UPDATE price_versions SET status = 'active', supersedes_id = ${previous[0]?.id ?? null}, effective_from = coalesce(effective_from, now()) WHERE id = ${id}`;
  await audit(tx, actor, { action: 'price.activated', resourceType: 'price_version', resourceId: id, detail: { supersedes: previous.map((p) => p.id) } });
  return getPriceVersion(tx, id);
}

export async function archivePriceVersion(sql: Sql, actor: Actor, id: string) {
  requirePermission(actor, 'prices:write');
  return sql.begin(async (tx) => {
    const [pv] = await tx<{ status: string }[]>`SELECT status FROM price_versions WHERE id = ${id} FOR UPDATE`;
    if (!pv) throw notFound('Price version');
    if (pv.status !== 'archived') {
      await tx`UPDATE price_versions SET status = 'archived', effective_until = coalesce(effective_until, now()) WHERE id = ${id}`;
      await audit(tx, actor, { action: 'price.archived', resourceType: 'price_version', resourceId: id });
    }
    return getPriceVersion(tx, id);
  });
}

export async function getPriceVersion(db: Db, id: string) {
  const [p] = await db<Record<string, unknown>[]>`
    SELECT pv.* FROM price_versions pv WHERE pv.id = ${id}`;
  if (!p) throw notFound('Price version');
  return p;
}

/** Store currencies without an active price for this offer (all must be set before it sells). */
export async function missingCurrencies(db: Db, offerId: string, now = new Date()): Promise<string[]> {
  const rows = await db<{ currency: string }[]>`
    SELECT DISTINCT currency FROM price_versions WHERE offer_id = ${offerId} AND status = 'active'
      AND (effective_from IS NULL OR effective_from <= ${now}) AND (effective_until IS NULL OR effective_until > ${now})`;
  const have = new Set(rows.map((r) => r.currency));
  return STORE_CURRENCIES.filter((c) => !have.has(c));
}

export const PriceSetInput = z.object({
  recurringInterval: z.enum(['day', 'week', 'month', 'year']).nullable().default(null),
  recurringIntervalCount: z.number().int().min(1).max(365).nullable().default(null),
  prices: z.array(z.object({
    currency: z.string(),
    unitAmount: z.number().int().min(0).max(99_999_999_999),
    taxRatePercent: z.number().nullable().default(null),
    taxLabel: z.string().nullable().default(null),
  })).min(1).max(STORE_CURRENCIES.length),
  activate: z.boolean().default(true),
}).strict();

/** Create (and by default activate) one price version per currency in a single transaction. */
export async function createPriceSet(sql: Sql, actor: Actor, offerId: string, raw: unknown) {
  requirePermission(actor, 'prices:write');
  const input = PriceSetInput.parse(raw);
  const seen = new Set<string>();
  for (const p of input.prices) {
    const c = p.currency.toLowerCase();
    if (seen.has(c)) throw invalid(`Currency ${c.toUpperCase()} appears twice`);
    seen.add(c);
  }
  return sql.begin(async (tx) => {
    const created: Array<Record<string, unknown>> = [];
    for (const p of input.prices) {
      const id = await insertPriceVersion(tx, actor, CreatePriceInput.parse({ offerId, currency: p.currency, unitAmount: p.unitAmount, recurringInterval: input.recurringInterval,
        recurringIntervalCount: input.recurringIntervalCount, taxRatePercent: p.taxRatePercent, taxLabel: p.taxLabel }));
      created.push(input.activate ? await activateInTx(tx, actor, id) : await getPriceVersion(tx, id));
    }
    return { offerId, prices: created, missingCurrencies: await missingCurrencies(tx, offerId) };
  });
}

export async function listPriceHistory(db: Db, offerId: string) {
  return db<Record<string, unknown>[]>`
    SELECT pv.* FROM price_versions pv WHERE pv.offer_id = ${offerId} ORDER BY pv.created_at`;
}

// ---------------------------------------------------------------------------------------------
// Purchasability (used by checkout and the public storefront)
// ---------------------------------------------------------------------------------------------

export interface PurchasableOffer {
  offer: { id: string; sku: string; name: string; description: string; kind: 'single' | 'bundle'; billing: 'one_time' | 'recurring' | 'free'; min_quantity: number; max_quantity: number; allow_promotion_codes: boolean; automatic_tax: boolean; billing_address_collection: 'auto' | 'required'; tax_id_collection: boolean; customer_kind: string; visibility: string };
  price: { id: string; currency: string; unit_amount: number; recurring_interval: string | null; recurring_interval_count: number | null; tax_behavior: string; tax_rate_bps: number | null; tax_label: string | null };
  components: Array<{ componentId: string; policy: EffectivePolicy }>;
}

/** Resolve an offer and price that may be sold right now, or explain why not. */
export async function resolvePurchasable(db: Db, sku: string, currency: string, now: Date): Promise<PurchasableOffer> {
  const [offer] = await db<PurchasableOffer['offer'][]>`
    SELECT * FROM offers WHERE sku = ${sku} AND status = 'active'
      AND (available_from IS NULL OR available_from <= ${now}) AND (available_until IS NULL OR available_until > ${now})`;
  if (!offer) throw notFound('Offer');
  const [price] = await db<PurchasableOffer['price'][]>`
    SELECT pv.id, pv.currency, pv.unit_amount, pv.recurring_interval, pv.recurring_interval_count, pv.tax_behavior, pv.tax_rate_bps, pv.tax_label
    FROM price_versions pv
    WHERE pv.offer_id = ${offer.id} AND pv.currency = ${currency.toLowerCase()} AND pv.status = 'active'
      AND (pv.effective_from IS NULL OR pv.effective_from <= ${now}) AND (pv.effective_until IS NULL OR pv.effective_until > ${now})
    ORDER BY pv.created_at DESC LIMIT 1`;
  if (!price) throw new AppError('precondition_failed', `Offer ${sku} is not currently purchasable in ${currency.toUpperCase()}`);
  if ((await missingCurrencies(db, offer.id, now)).length) throw new AppError('precondition_failed', `Offer ${sku} is not on sale: prices are incomplete`);
  const comps = await db<{ id: string; edition_policy_id: string }[]>`SELECT id, edition_policy_id FROM offer_entitlement_components WHERE offer_id = ${offer.id} ORDER BY position`;
  const components: PurchasableOffer['components'] = [];
  for (const c of comps) {
    const rows = await loadPolicyRows(db, c.edition_policy_id, c.id);
    const m = await db<{ ps: string; ms: string }[]>`SELECT p.status AS ps, m.status AS ms FROM product_majors m JOIN products p ON p.id = m.product_id WHERE m.id = ${rows.major.id}`;
    if (m[0]!.ps !== 'active' || m[0]!.ms !== 'active') throw new AppError('precondition_failed', `${rows.product.slug} v${rows.major.major_version} is not on sale`);
    components.push({ componentId: c.id, policy: computeEffectivePolicy(rows, 1) });
  }
  return { offer, price, components };
}

export interface StoreOffer {
  sku: string; name: string; description: string; billing: string; kind: string; products: string;
  /** Business / Enterprise / Education (or organisation-only): the store asks for business details. */
  needsOrganisation: boolean;
  prices: Array<{ currency: string; unitAmount: number; recurringInterval: string | null; recurringIntervalCount: number | null; taxRateBps: number | null; taxLabel: string | null }>;
}

/** Public offers priced in every store currency (an offer missing any currency is not shown). */
export async function listPublicCatalogue(db: Db, now: Date): Promise<StoreOffer[]> {
  const rows = await db<{ sku: string; name: string; description: string; billing: string; kind: string; currency: string; unit_amount: number; recurring_interval: string | null;
    recurring_interval_count: number | null; tax_rate_bps: number | null; tax_label: string | null; products: string; needs_org: boolean }[]>`
    SELECT o.sku, o.name, o.description, o.billing, o.kind, pv.currency, pv.unit_amount, pv.recurring_interval, pv.recurring_interval_count, pv.tax_rate_bps, pv.tax_label,
      (SELECT string_agg(p.name || ' ' || m.major_version || ' ' || ep.display_name, ' + ' ORDER BY c.position)
         FROM offer_entitlement_components c JOIN product_edition_policies ep ON ep.id = c.edition_policy_id
         JOIN product_majors m ON m.id = ep.product_major_id JOIN products p ON p.id = m.product_id WHERE c.offer_id = o.id) AS products,
      (o.customer_kind = 'organisation' OR EXISTS (SELECT 1 FROM offer_entitlement_components c JOIN product_edition_policies ep ON ep.id = c.edition_policy_id
         WHERE c.offer_id = o.id AND ep.edition_id IN ('business', 'enterprise', 'education'))) AS needs_org
    FROM offers o JOIN price_versions pv ON pv.offer_id = o.id AND pv.status = 'active'
      AND (pv.effective_from IS NULL OR pv.effective_from <= ${now}) AND (pv.effective_until IS NULL OR pv.effective_until > ${now})
    WHERE o.status = 'active' AND o.visibility = 'public'
      AND (o.available_from IS NULL OR o.available_from <= ${now}) AND (o.available_until IS NULL OR o.available_until > ${now})
    ORDER BY o.name, pv.currency`;
  const bySku = new Map<string, StoreOffer>();
  for (const r of rows) {
    let o = bySku.get(r.sku);
    if (!o) {
      o = { sku: r.sku, name: r.name, description: r.description, billing: r.billing, kind: r.kind, products: r.products, needsOrganisation: r.needs_org, prices: [] };
      bySku.set(r.sku, o);
    }
    o.prices.push({ currency: r.currency, unitAmount: r.unit_amount, recurringInterval: r.recurring_interval, recurringIntervalCount: r.recurring_interval_count, taxRateBps: r.tax_rate_bps, taxLabel: r.tax_label });
  }
  return [...bySku.values()].filter((o) => STORE_CURRENCIES.every((c) => o.prices.some((p) => p.currency === c)));
}
