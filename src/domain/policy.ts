// Data-driven policy engine.
//
// Effective policy = product major (+ protocol) + edition policy + offer component
//                    + quantity + explicit entitlement overrides.
// The result is validated against the wire protocol the product major declares, then frozen
// into an immutable entitlement_policy_snapshots row at purchase/grant time. Later catalogue
// edits never alter an existing customer's snapshot; amendments create a new audited snapshot.

import { z } from 'zod';
import { getProtocol } from './protocols.ts';

export const TermType = z.enum(['perpetual', 'subscription', 'fixed_term']);
export const IntervalUnit = z.enum(['day', 'week', 'month', 'year']);
export const ActivationModel = z.enum(['none', 'device_seats']);
export const RevocationAction = z.enum(['revoke', 'review', 'none']);

export const EffectivePolicySchema = z
  .object({
    policyVersion: z.literal(1),
    protocolId: z.string(),
    product: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
    major: z.object({ id: z.string(), majorVersion: z.number().int().nonnegative() }),
    edition: z.object({
      policyId: z.string(),
      editionId: z.string(),
      wireId: z.string(),
      displayName: z.string(),
    }),
    activationModel: ActivationModel,
    ownership: z.enum(['individual', 'organisation', 'institution']),
    offlinePolicy: z.enum(['indefinite', 'periodic_check']),
    term: z.object({
      type: TermType,
      interval: IntervalUnit.nullable(),
      intervalCount: z.number().int().positive().nullable(),
      trialDays: z.number().int().positive().nullable(),
      graceDays: z.number().int().min(0).max(90),
    }),
    seats: z.number().int().positive().nullable(),
    transferAllowance: z.number().int().min(0).nullable(),
    certificateLifetimeSeconds: z.number().int().positive().nullable(),
    activationKeyEmail: z.boolean(),
    refundAction: RevocationAction,
    disputeAction: RevocationAction,
    offer: z.object({ id: z.string(), sku: z.string(), componentId: z.string() }).nullable(),
  })
  .strict();

export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;

export interface PolicyRows {
  product: { id: string; slug: string; name: string };
  major: {
    id: string;
    major_version: number;
    protocol_id: string;
    default_transfer_allowance: number;
    activation_key_email: boolean;
  };
  editionPolicy: {
    id: string;
    edition_id: string;
    wire_id: string;
    display_name: string;
    activation_model: 'none' | 'device_seats';
    ownership: 'individual' | 'organisation' | 'institution';
    transfer_allowance: number | null;
    certificate_lifetime_seconds: number | null;
    offline_policy: 'indefinite' | 'periodic_check';
  };
  component: {
    id: string;
    term_type: 'perpetual' | 'subscription' | 'fixed_term';
    term_interval: 'day' | 'week' | 'month' | 'year' | null;
    term_interval_count: number | null;
    seats_per_unit: number | null;
    quantity_scales_seats: boolean;
    trial_days: number | null;
    grace_days: number;
    transfer_allowance: number | null;
    refund_action: 'revoke' | 'review' | 'none';
    dispute_action: 'revoke' | 'review' | 'none';
  };
  offer: { id: string; sku: string } | null;
}

export interface PolicyOverrides {
  seats?: number | null;
  transferAllowance?: number | null;
}

export function computeEffectivePolicy(rows: PolicyRows, quantity: number, overrides: PolicyOverrides = {}): EffectivePolicy {
  const { product, major, editionPolicy: ep, component: c } = rows;
  const deviceSeats = ep.activation_model === 'device_seats';
  let seats: number | null = null;
  if (deviceSeats) {
    const perUnit = c.seats_per_unit ?? 1;
    seats = c.quantity_scales_seats ? perUnit * quantity : perUnit;
  }
  if (overrides.seats !== undefined) seats = overrides.seats;
  let transferAllowance: number | null = null;
  if (deviceSeats) transferAllowance = c.transfer_allowance ?? ep.transfer_allowance ?? major.default_transfer_allowance;
  if (overrides.transferAllowance !== undefined) transferAllowance = overrides.transferAllowance;

  return EffectivePolicySchema.parse({
    policyVersion: 1,
    protocolId: major.protocol_id,
    product: { id: product.id, slug: product.slug, name: product.name },
    major: { id: major.id, majorVersion: major.major_version },
    edition: { policyId: ep.id, editionId: ep.edition_id, wireId: ep.wire_id, displayName: ep.display_name },
    activationModel: ep.activation_model,
    ownership: ep.ownership,
    offlinePolicy: ep.offline_policy,
    term: {
      type: c.term_type,
      interval: c.term_interval,
      intervalCount: c.term_interval_count,
      trialDays: c.trial_days,
      graceDays: c.grace_days,
    },
    seats,
    transferAllowance,
    certificateLifetimeSeconds: ep.certificate_lifetime_seconds,
    activationKeyEmail: major.activation_key_email,
    refundAction: c.refund_action,
    disputeAction: c.dispute_action,
    offer: rows.offer ? { id: rows.offer.id, sku: rows.offer.sku, componentId: c.id } : null,
  });
}

export interface PolicyProblem {
  rule: string;
  message: string;
}

/** Validate an effective policy against its declared wire protocol. Empty => issuable. */
export function validatePolicy(p: EffectivePolicy): PolicyProblem[] {
  const protocol = getProtocol(p.protocolId);
  if (!protocol) {
    return [{ rule: 'protocol.unimplemented', message: `Protocol ${p.protocolId} is not implemented by this server version` }];
  }
  const problems = protocol.validatePolicy(p);
  if (p.activationModel === 'device_seats' && (p.seats === null || p.seats < 1)) {
    problems.push({ rule: 'seats.required', message: 'Device-seat policies require at least one seat' });
  }
  if (p.activationModel === 'none' && p.seats !== null) {
    problems.push({ rule: 'seats.forbidden', message: 'Seats are only meaningful with device-seat activation' });
  }
  return problems;
}

/** Offer-level validation that spans components and prices. */
export function validateOfferShape(input: {
  kind: 'single' | 'bundle';
  billing: 'one_time' | 'recurring' | 'free';
  maxQuantity: number;
  components: Array<{ productMajorId: string; policy: EffectivePolicy; quantityScalesSeats: boolean }>;
}): PolicyProblem[] {
  const out: PolicyProblem[] = [];
  const { components } = input;
  if (components.length === 0) out.push({ rule: 'offer.components', message: 'An offer needs at least one entitlement component' });
  if (input.kind === 'single' && components.length > 1) out.push({ rule: 'offer.single', message: 'A single offer has exactly one component' });
  if (input.kind === 'bundle' && components.length < 2) out.push({ rule: 'offer.bundle', message: 'A bundle needs at least two components' });
  const majors = new Set(components.map((c) => c.productMajorId));
  if (majors.size !== components.length) out.push({ rule: 'offer.bundle.duplicate', message: 'A bundle cannot contain the same product major twice (there are never multi-product or duplicate licences)' });
  const hasSubscription = components.some((c) => c.policy.term.type === 'subscription');
  if (input.billing === 'recurring' && !hasSubscription) out.push({ rule: 'offer.billing.recurring', message: 'Recurring billing requires at least one subscription component' });
  if (input.billing !== 'recurring' && hasSubscription) out.push({ rule: 'offer.billing.subscription', message: 'Subscription components require recurring billing' });
  if (input.maxQuantity > 1 && components.some((c) => !c.quantityScalesSeats)) {
    out.push({ rule: 'offer.quantity', message: 'Quantities above 1 are only allowed when every component scales seats by quantity' });
  }
  for (const c of components) for (const p of validatePolicy(c.policy)) out.push({ rule: p.rule, message: `${c.policy.product.slug} v${c.policy.major.majorVersion} ${c.policy.edition.wireId}: ${p.message}` });
  return out;
}

export function validatePrice(input: {
  billing: 'one_time' | 'recurring' | 'free';
  unitAmount: number;
  recurringInterval: string | null;
}): PolicyProblem[] {
  const out: PolicyProblem[] = [];
  if (!Number.isSafeInteger(input.unitAmount) || input.unitAmount < 0) out.push({ rule: 'price.amount', message: 'Amount must be a non-negative integer in minor units' });
  if (input.billing === 'free' && input.unitAmount !== 0) out.push({ rule: 'price.free', message: 'Free offers must have a zero price' });
  if (input.billing !== 'free' && input.unitAmount === 0) out.push({ rule: 'price.zero', message: 'Zero prices are only allowed for free (registration) offers' });
  if (input.billing === 'recurring' && !input.recurringInterval) out.push({ rule: 'price.interval', message: 'Recurring offers need a recurring interval' });
  if (input.billing !== 'recurring' && input.recurringInterval) out.push({ rule: 'price.interval', message: 'Only recurring offers may have an interval' });
  return out;
}
