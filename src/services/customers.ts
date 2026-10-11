// Customers (individuals or organisations), portal users and memberships. A customer's email
// is for access and recovery only; it never appears in licence files (brief §9).

import { z } from 'zod';
import type { Db, Sql, Tx } from '../db/client.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { requirePermission, type Actor } from './actor.ts';
import { audit } from './audit.ts';

export const normaliseEmail = (e: string) => e.trim().toLowerCase();
const email = z.email().max(254).transform(normaliseEmail);

export const CreateCustomerInput = z.object({
  kind: z.enum(['individual', 'organisation']),
  displayName: z.string().trim().min(1).max(200),
  organisationName: z.string().trim().min(1).max(200).nullable().optional(),
  billingEmail: email,
  taxId: z.string().trim().max(64).nullable().optional(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  marketingConsent: z.boolean().default(false),
}).strict();

export const UpdateCustomerInput = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  organisationName: z.string().trim().min(1).max(200).nullable().optional(),
  billingEmail: email.optional(),
  taxId: z.string().trim().max(64).nullable().optional(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  status: z.enum(['active', 'disabled']).optional(),
}).strict();

export async function insertCustomer(tx: Tx, actor: Actor, input: z.infer<typeof CreateCustomerInput> & { stripeCustomerId?: string | null }): Promise<string> {
  const id = newId('cus');
  await tx`INSERT INTO customers (id, kind, display_name, organisation_name, billing_email, tax_id, country, stripe_customer_id, marketing_consent, marketing_consent_at)
           VALUES (${id}, ${input.kind}, ${input.displayName}, ${input.organisationName ?? null}, ${input.billingEmail}, ${input.taxId ?? null},
                   ${input.country ?? null}, ${input.stripeCustomerId ?? null}, ${input.marketingConsent}, ${input.marketingConsent ? new Date() : null})`;
  // The billing contact becomes the owning portal user (passwordless; verified on first login).
  const userId = await ensurePortalUser(tx, input.billingEmail);
  await tx`INSERT INTO customer_members (customer_id, portal_user_id, role) VALUES (${id}, ${userId}, 'owner') ON CONFLICT DO NOTHING`;
  await audit(tx, actor, { action: 'customer.created', resourceType: 'customer', resourceId: id, detail: { kind: input.kind } });
  return id;
}

export async function createCustomer(sql: Sql, actor: Actor, raw: unknown) {
  requirePermission(actor, 'customers:write');
  const input = CreateCustomerInput.parse(raw);
  return sql.begin(async (tx) => getCustomer(tx, await insertCustomer(tx, actor, input)));
}

export async function updateCustomer(sql: Sql, actor: Actor, id: string, raw: unknown) {
  requirePermission(actor, 'customers:write');
  const input = UpdateCustomerInput.parse(raw);
  return sql.begin(async (tx) => {
    const [c] = await tx`SELECT 1 FROM customers WHERE id = ${id} FOR UPDATE`;
    if (!c) throw notFound('Customer');
    await tx`UPDATE customers SET
      display_name = coalesce(${input.displayName ?? null}, display_name),
      organisation_name = CASE WHEN ${input.organisationName !== undefined} THEN ${input.organisationName ?? null} ELSE organisation_name END,
      billing_email = coalesce(${input.billingEmail ?? null}, billing_email),
      tax_id = CASE WHEN ${input.taxId !== undefined} THEN ${input.taxId ?? null} ELSE tax_id END,
      country = CASE WHEN ${input.country !== undefined} THEN ${input.country ?? null} ELSE country END,
      status = coalesce(${input.status ?? null}, status)
      WHERE id = ${id}`;
    await audit(tx, actor, { action: 'customer.updated', resourceType: 'customer', resourceId: id, detail: { fields: Object.keys(input) } });
    return getCustomer(tx, id);
  });
}

export async function ensurePortalUser(db: Db, rawEmail: string): Promise<string> {
  const e = normaliseEmail(rawEmail);
  const [u] = await db<{ id: string }[]>`
    INSERT INTO portal_users (id, email) VALUES (${newId('usr')}, ${e})
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id`;
  return u!.id;
}

export async function addMember(sql: Sql, actor: Actor, customerId: string, rawEmail: string, role: 'admin' | 'billing' | 'member') {
  if (actor.type !== 'customer') requirePermission(actor, 'customers:write');
  return sql.begin(async (tx) => {
    const [c] = await tx`SELECT 1 FROM customers WHERE id = ${customerId}`;
    if (!c) throw notFound('Customer');
    const userId = await ensurePortalUser(tx, rawEmail);
    const r = await tx`INSERT INTO customer_members (customer_id, portal_user_id, role) VALUES (${customerId}, ${userId}, ${role}) ON CONFLICT DO NOTHING RETURNING 1`;
    if (!r.length) throw conflict('That person is already a member');
    await audit(tx, actor, { action: 'customer.member_added', resourceType: 'customer', resourceId: customerId, detail: { portalUserId: userId, role } });
    return { customerId, portalUserId: userId, role };
  });
}

export async function removeMember(sql: Sql, actor: Actor, customerId: string, portalUserId: string) {
  if (actor.type !== 'customer') requirePermission(actor, 'customers:write');
  return sql.begin(async (tx) => {
    const owners = await tx<{ portal_user_id: string }[]>`SELECT portal_user_id FROM customer_members WHERE customer_id = ${customerId} AND role = 'owner' FOR UPDATE`;
    if (owners.length === 1 && owners[0]!.portal_user_id === portalUserId) throw conflict('Cannot remove the last owner');
    await tx`DELETE FROM customer_members WHERE customer_id = ${customerId} AND portal_user_id = ${portalUserId}`;
    await audit(tx, actor, { action: 'customer.member_removed', resourceType: 'customer', resourceId: customerId, detail: { portalUserId } });
  });
}

export async function getCustomer(db: Db, id: string) {
  const [c] = await db<{ id: string; kind: string; display_name: string; organisation_name: string | null; billing_email: string; tax_id: string | null; country: string | null; stripe_customer_id: string | null; marketing_consent: boolean; status: string; created_at: Date }[]>`SELECT * FROM customers WHERE id = ${id}`;
  if (!c) throw notFound('Customer');
  const members = await db<{ portal_user_id: string; email: string; role: string; email_verified_at: Date | null }[]>`
    SELECT m.portal_user_id, u.email, m.role, u.email_verified_at FROM customer_members m JOIN portal_users u ON u.id = m.portal_user_id
    WHERE m.customer_id = ${id} ORDER BY m.created_at`;
  return { ...c, members };
}

export async function listCustomers(db: Db, opts: { search?: string; limit?: number; offset?: number } = {}) {
  const q = opts.search?.trim() ? `%${opts.search.trim().toLowerCase()}%` : null;
  return db<{ id: string; kind: string; display_name: string; organisation_name: string | null; billing_email: string; status: string; created_at: Date; entitlements: number }[]>`
    SELECT c.id, c.kind, c.display_name, c.organisation_name, c.billing_email, c.status, c.created_at,
      (SELECT count(*)::int FROM entitlements e WHERE e.customer_id = c.id) AS entitlements
    FROM customers c
    WHERE ${q}::text IS NULL OR lower(c.display_name) LIKE ${q} OR lower(coalesce(c.organisation_name, '')) LIKE ${q} OR c.billing_email LIKE ${q} OR c.id = ${opts.search ?? ''}
    ORDER BY c.created_at DESC LIMIT ${Math.min(opts.limit ?? 50, 200)} OFFSET ${opts.offset ?? 0}`;
}

/** Entitlements with licence/activation summary for one customer. Used by portal and admin. */
export async function listCustomerEntitlements(db: Db, customerId: string) {
  return db<{
    entitlement_id: string; license_id: string; product_slug: string; product_name: string; major_version: number; edition: string; edition_name: string;
    activation_model: string; term_type: string; expires_at: Date | null; seats: number | null; status: string; review_required: boolean;
    active_activations: number; subscription_id: string | null; current_issued_at: Date | null; key_hint: string | null; key_revealable: boolean; created_at: Date;
  }[]>`
    SELECT e.id AS entitlement_id, l.id AS license_id, p.slug AS product_slug, p.name AS product_name, m.major_version, ed.wire_id AS edition, ep.display_name AS edition_name,
      ep.activation_model, e.term_type, e.expires_at, e.seats, e.status, e.review_required, e.subscription_id, l.current_issued_at, e.created_at,
      (SELECT count(*)::int FROM activations a WHERE a.license_id = l.id AND a.status = 'active') AS active_activations,
      (SELECT k.key_hint FROM activation_keys k WHERE k.license_id = l.id AND k.status = 'active') AS key_hint,
      coalesce((SELECT k.reveal_ciphertext IS NOT NULL AND (k.reveal_expires_at IS NULL OR k.reveal_expires_at > now()) FROM activation_keys k WHERE k.license_id = l.id AND k.status = 'active'), false) AS key_revealable
    FROM entitlements e JOIN licenses l ON l.entitlement_id = e.id
    JOIN product_majors m ON m.id = e.product_major_id JOIN products p ON p.id = m.product_id
    JOIN product_edition_policies ep ON ep.id = e.edition_policy_id JOIN edition_definitions ed ON ed.id = ep.edition_id
    WHERE e.customer_id = ${customerId} ORDER BY e.created_at DESC`;
}
