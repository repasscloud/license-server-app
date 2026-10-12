// Administrative entitlement grants (complimentary licences, support replacements, migrations).
// They use the same offer/component/policy machinery as paid purchases and are recorded as a
// zero-value 'admin_grant' purchase so every entitlement traces back to a purchase line.

import { z } from 'zod';
import type { Config } from '../config.ts';
import type { Db, Sql } from '../db/client.ts';
import { computeEffectivePolicy, validatePolicy } from '../domain/policy.ts';
import { AppError, invalid, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { requirePermission, type Actor } from './actor.ts';
import { audit } from './audit.ts';
import { loadPolicyRows } from './catalogue.ts';
import { createEntitlement, signLicense, loadLicenseContext, type CreatedEntitlement } from './licensing.ts';

export const GrantInput = z.object({
  customerId: z.string().min(1),
  offerSku: z.string().min(1),
  quantity: z.number().int().min(1).max(10000).default(1),
  /** Required when the offer has subscription components (no Stripe subscription backs a grant). */
  expiresAt: z.coerce.date().nullable().default(null),
  reason: z.string().trim().min(3).max(500),
}).strict();

export async function grantEntitlements(sql: Sql, config: Config, actor: Actor, raw: unknown, now = new Date()): Promise<{ purchaseId: string; entitlements: CreatedEntitlement[] }> {
  requirePermission(actor, 'entitlements:issue');
  const input = GrantInput.parse(raw);
  return sql.begin(async (tx) => {
    const [customer] = await tx`SELECT 1 FROM customers WHERE id = ${input.customerId} AND status = 'active'`;
    if (!customer) throw notFound('Active customer');
    const [offer] = await tx<{ id: string; sku: string; status: string; max_quantity: number }[]>`SELECT id, sku, status, max_quantity FROM offers WHERE sku = ${input.offerSku}`;
    if (!offer || offer.status === 'archived') throw notFound('Offer');
    if (input.quantity > offer.max_quantity) throw invalid(`Quantity exceeds the offer maximum of ${offer.max_quantity}`);
    const comps = await tx<{ id: string; edition_policy_id: string }[]>`SELECT id, edition_policy_id FROM offer_entitlement_components WHERE offer_id = ${offer.id} ORDER BY position`;
    const policies = [];
    for (const c of comps) {
      const policy = computeEffectivePolicy(await loadPolicyRows(tx, c.edition_policy_id, c.id), input.quantity);
      const problems = validatePolicy(policy);
      if (problems.length) throw new AppError('protocol_incompatible', problems.map((p) => p.message).join('; '), { problems });
      if (policy.term.type === 'subscription' && !input.expiresAt) throw invalid('expiresAt is required to grant a subscription-term entitlement');
      if (input.expiresAt && input.expiresAt <= now) throw invalid('expiresAt must be in the future');
      policies.push({ componentId: c.id, policy });
    }
    const purchaseId = newId('pur');
    await tx`INSERT INTO purchases (id, customer_id, source, currency, amount_subtotal, amount_total, created_by)
             VALUES (${purchaseId}, ${input.customerId}, 'admin_grant', 'xxx', 0, 0, ${actor.label})`;
    const lineId = newId('pul');
    await tx`INSERT INTO purchase_lines (id, purchase_id, position, offer_id, quantity, currency, unit_amount, snapshot)
             VALUES (${lineId}, ${purchaseId}, 0, ${offer.id}, ${input.quantity}, 'xxx', 0, ${tx.json({ offerSku: offer.sku, reason: input.reason, components: policies } as never)})`;
    const created: CreatedEntitlement[] = [];
    for (const p of policies) {
      const ent = await createEntitlement(tx, config, actor, {
        customerId: input.customerId,
        policy: p.policy,
        startsAt: now,
        periodEnd: input.expiresAt,
        purchaseLineId: lineId,
        componentId: p.componentId,
        snapshotReason: `admin grant: ${input.reason}`,
      });
      const ctx = await loadLicenseContext(tx, ent.licenseId, true);
      await signLicense(tx, config, ctx!, actor, 'initial', now);
      created.push(ent);
    }
    await audit(tx, actor, { action: 'entitlement.granted', resourceType: 'purchase', resourceId: purchaseId, detail: { customerId: input.customerId, offerSku: offer.sku, quantity: input.quantity, reason: input.reason, licenseIds: created.map((c) => c.licenseId) } });
    return { purchaseId, entitlements: created };
  });
}

export async function getLicenseDetail(db: Db, licenseId: string) {
  const [l] = await db<Record<string, unknown>[]>`
    SELECT l.id AS license_id, l.current_envelope, l.current_issued_at, l.current_key_ids, l.issue_count, e.*, p.slug AS product_slug, p.name AS product_name,
           m.major_version, m.licence_file_name_template, ed.wire_id AS edition, ep.display_name AS edition_name, ep.activation_model, s.snapshot,
           c.display_name AS customer_display_name, c.kind AS customer_kind
    FROM licenses l JOIN entitlements e ON e.id = l.entitlement_id JOIN product_majors m ON m.id = e.product_major_id JOIN products p ON p.id = m.product_id
    JOIN product_edition_policies ep ON ep.id = e.edition_policy_id JOIN edition_definitions ed ON ed.id = ep.edition_id
    JOIN entitlement_policy_snapshots s ON s.id = e.policy_snapshot_id JOIN customers c ON c.id = e.customer_id
    WHERE l.id = ${licenseId}`;
  if (!l) throw notFound('Licence');
  const activations = await db<{ id: string; device_id: string; status: string; activated_at: Date; last_validated_at: Date | null; deactivated_at: Date | null; deactivated_by: string | null; counted_as_transfer: boolean }[]>`
    SELECT id, device_id, status, activated_at, last_validated_at, deactivated_at, deactivated_by, counted_as_transfer FROM activations WHERE license_id = ${licenseId} ORDER BY activated_at DESC`;
  const issuances = await db`SELECT artifact, activation_id, issued_at, key_ids, reason, actor FROM license_issuances WHERE license_id = ${licenseId} ORDER BY id DESC LIMIT 50`;
  const revocations = await db`SELECT action, reason, source, source_ref, actor, created_at FROM revocations WHERE entitlement_id = ${l.id as string} ORDER BY id DESC`;
  const [key] = await db<{ key_hint: string; created_at: Date }[]>`SELECT key_hint, created_at FROM activation_keys WHERE license_id = ${licenseId} AND status = 'active'`;
  return {
    ...l,
    // Only the device-id suffix is shown (brief §11).
    activations: activations.map((a) => ({ ...a, device_suffix: a.device_id.slice(-8), device_id: undefined })),
    issuances,
    revocations,
    activationKeyHint: key?.key_hint ?? null,
  };
}

export async function searchLicenses(db: Db, opts: { q?: string; status?: string; productSlug?: string; limit?: number; offset?: number }) {
  const q = opts.q?.trim() || null;
  return db<{ license_id: string; entitlement_id: string; customer_id: string; customer_name: string; product_slug: string; major_version: number; edition: string; term_type: string; expires_at: Date | null; status: string; created_at: Date }[]>`
    SELECT l.id AS license_id, e.id AS entitlement_id, e.customer_id, c.display_name AS customer_name, p.slug AS product_slug, m.major_version,
           ed.wire_id AS edition, e.term_type, e.expires_at, e.status, e.created_at
    FROM licenses l JOIN entitlements e ON e.id = l.entitlement_id JOIN customers c ON c.id = e.customer_id
    JOIN product_majors m ON m.id = e.product_major_id JOIN products p ON p.id = m.product_id
    JOIN product_edition_policies ep ON ep.id = e.edition_policy_id JOIN edition_definitions ed ON ed.id = ep.edition_id
    WHERE (${q}::text IS NULL OR l.id = ${q} OR e.id = ${q} OR e.customer_id = ${q} OR c.billing_email = lower(${q ?? ''}) OR c.display_name ILIKE '%' || ${q ?? ''} || '%')
      AND (${opts.status ?? null}::text IS NULL OR e.status = ${opts.status ?? null})
      AND (${opts.productSlug ?? null}::text IS NULL OR p.slug = ${opts.productSlug ?? null})
    ORDER BY e.created_at DESC LIMIT ${Math.min(opts.limit ?? 50, 200)} OFFSET ${opts.offset ?? 0}`;
}
