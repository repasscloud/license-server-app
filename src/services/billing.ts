// Stripe webhook inbox, lifecycle processing and reconciliation.
//
// Receive: verify signature on the raw body -> INSERT stripe_events (unique event id) + job, in
// one transaction -> 200. Duplicates are no-ops. Nothing else happens in the HTTP request.
// Process (job/cron): re-fetch authoritative objects from Stripe, then apply idempotent changes
// guarded by database constraints:
//   purchases.checkout_id UNIQUE           -> one fulfilment per checkout
//   invoices.stripe_invoice_id UNIQUE +
//   invoices.extension_applied_at          -> one extension per invoice, monotonic expiry
//   revocations UNIQUE(entitlement, source, source_ref, action) -> one revocation per refund/dispute
//   email_outbox.business_key UNIQUE       -> one email per business event
// Webhooks may arrive late, twice or out of order; dates come from Stripe objects, never from
// receipt time.

import type { Config } from '../config.ts';
import type { Db, Sql, Tx } from '../db/client.ts';
import { EffectivePolicySchema, type EffectivePolicy } from '../domain/policy.ts';
import { StripeClient, StripeError, verifyStripeSignature, WebhookSignatureError, type VerifiedStripeEvent } from '../integrations/stripe.ts';
import { AppError, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { money } from '../lib/money.ts';
import { fromUnixSeconds, rfc3339 } from '../lib/time.ts';
import { requirePermission, type Actor } from './actor.ts';
import { audit } from './audit.ts';
import type { CheckoutSnapshot } from './checkout.ts';
import { insertCustomer } from './customers.ts';
import { enqueueEmail, escapeHtml } from './email.ts';
import { buyerFor, invoiceNumber, issueInvoice, sellerFor, type InvoiceAddress } from './invoices.ts';
import { enqueueJob } from './jobs.ts';
import { computeExpiry, createEntitlement, loadLicenseContext, revokeInTx, signLicense } from './licensing.ts';

export const stripeActor = (eventId?: string): Actor => ({ type: 'stripe', id: eventId ?? null, label: eventId ? `stripe:${eventId}` : 'stripe' });

export class RetryLater extends Error {}

const HANDLED = new Set([
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired',
  'invoice.paid', 'invoice.payment_failed',
  'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted',
  'customer.subscription.trial_will_end',
  'charge.refunded', 'charge.dispute.created', 'charge.dispute.closed',
]);

// ---------------------------------------------------------------------------------------------
// Receive
// ---------------------------------------------------------------------------------------------

export async function receiveStripeWebhook(sql: Sql, config: Config, rawBody: string, signature: string | null, stripeLivemode: boolean): Promise<{ status: 'stored' | 'duplicate' | 'ignored'; eventId: string }> {
  const ev = await verifyStripeSignature(rawBody, signature, config.secret('STRIPE_WEBHOOK_SECRET'));
  if (ev.livemode !== stripeLivemode) {
    // Test-mode events must never affect a live deployment and vice versa.
    throw new WebhookSignatureError('event livemode does not match configured key');
  }
  return storeEvent(sql, ev);
}

async function storeEvent(sql: Sql, ev: VerifiedStripeEvent): Promise<{ status: 'stored' | 'duplicate' | 'ignored'; eventId: string }> {
  const handled = HANDLED.has(ev.type);
  return sql.begin(async (tx) => {
    const ins = await tx`
      INSERT INTO stripe_events (id, type, livemode, api_version, stripe_created, object_id, payload, status)
      VALUES (${ev.id}, ${ev.type}, ${ev.livemode}, ${ev.api_version ?? null}, ${new Date(ev.created * 1000)}, ${(ev.data.object.id as string) ?? null},
              ${tx.json(ev as never)}, ${handled ? 'received' : 'ignored'})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    if (!ins.length) return { status: 'duplicate' as const, eventId: ev.id };
    if (handled) await enqueueJob(tx, 'stripe.process_event', `stripe.event:${ev.id}`, { eventId: ev.id });
    return { status: handled ? ('stored' as const) : ('ignored' as const), eventId: ev.id };
  });
}

// ---------------------------------------------------------------------------------------------
// Process
// ---------------------------------------------------------------------------------------------

export async function processStripeEvent(sql: Sql, config: Config, stripe: StripeClient, eventId: string, now = new Date()): Promise<string> {
  const [row] = await sql<{ id: string; type: string; status: string; payload: VerifiedStripeEvent }[]>`SELECT id, type, status, payload FROM stripe_events WHERE id = ${eventId}`;
  if (!row) throw notFound('Stripe event');
  if (row.status === 'processed' || row.status === 'ignored') return row.status;
  const obj = row.payload.data.object;
  const actor = stripeActor(eventId);
  let outcome: string;
  try {
    switch (row.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired':
        outcome = await handleCheckoutSession(sql, config, stripe, actor, obj.id as string, now);
        break;
      case 'invoice.paid':
      case 'invoice.payment_failed':
        outcome = await handleInvoice(sql, config, stripe, actor, obj.id as string);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.trial_will_end':
        outcome = await syncSubscription(sql, config, stripe, actor, obj.id as string);
        break;
      case 'charge.refunded':
        outcome = await handleRefund(sql, config, stripe, actor, obj as unknown as StripeCharge);
        break;
      case 'charge.dispute.created':
      case 'charge.dispute.closed':
        outcome = await handleDispute(sql, config, stripe, actor, obj as unknown as StripeDispute, row.type);
        break;
      default:
        outcome = 'ignored';
    }
    await sql`UPDATE stripe_events SET status = 'processed', processed_at = now(), attempts = attempts + 1, outcome = ${outcome}, last_error = NULL WHERE id = ${eventId}`;
    await audit(sql, actor, { action: 'stripe.event_processed', resourceType: 'stripe_event', resourceId: eventId, detail: { type: row.type, outcome } });
    return outcome;
  } catch (e) {
    await sql`UPDATE stripe_events SET status = 'failed', attempts = attempts + 1, last_error = ${String((e as Error)?.message ?? e).slice(0, 1000)} WHERE id = ${eventId}`;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Checkout fulfilment
// ---------------------------------------------------------------------------------------------

interface StripeSession {
  id: string;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  client_reference_id: string | null;
  metadata: Record<string, string> | null;
  mode: 'payment' | 'subscription';
  customer: string | { id: string } | null;
  customer_details: { email: string | null; name: string | null; business_name?: string | null; individual_name?: string | null; address?: InvoiceAddress | null; tax_ids?: Array<{ value: string }> | null } | null;
  livemode?: boolean;
  amount_subtotal: number | null;
  amount_total: number | null;
  total_details: { amount_discount: number; amount_tax: number } | null;
  currency: string;
  payment_intent: string | { id: string } | null;
  subscription: string | StripeSubscription | null;
  invoice: string | { id: string } | null;
  line_items?: { data: Array<{ price: { id: string; unit_amount?: number | null; currency?: string; product?: string | { id: string } | null; recurring?: { interval: string } | null }; quantity: number }> };
}

const idOf = (v: string | { id: string } | null | undefined): string | null => (v === null || v === undefined ? null : typeof v === 'string' ? v : v.id);

export async function handleCheckoutSession(sql: Sql, config: Config, stripe: StripeClient, actor: Actor, sessionId: string, now = new Date()): Promise<string> {
  // Authoritative current state, never the (possibly stale) webhook copy.
  const session = await stripe.request<StripeSession>('GET', `/v1/checkout/sessions/${sessionId}`, { expand: ['line_items', 'subscription'] });
  const checkoutId = session.metadata?.repass_checkout_id ?? session.client_reference_id;
  if (!checkoutId) return 'ignored: not a server-created checkout';
  const [chk] = await sql<{ id: string; stripe_checkout_session_id: string | null; status: string }[]>`SELECT id, stripe_checkout_session_id, status FROM checkouts WHERE id = ${checkoutId}`;
  if (!chk) return 'ignored: unknown checkout';
  if (chk.stripe_checkout_session_id !== session.id) {
    await audit(sql, actor, { action: 'checkout.session_mismatch', outcome: 'failure', resourceType: 'checkout', resourceId: checkoutId, detail: { sessionId } });
    return 'rejected: session does not belong to checkout';
  }
  if (session.status === 'expired') {
    await sql`UPDATE checkouts SET status = 'expired' WHERE id = ${checkoutId} AND status IN ('open', 'awaiting_payment', 'creating')`;
    return 'checkout expired';
  }
  if (session.status !== 'complete') return 'checkout still open';
  if (session.payment_status === 'unpaid') {
    // Asynchronous payment method (e.g. bank debit): wait for async_payment_succeeded.
    await sql`UPDATE checkouts SET status = 'awaiting_payment' WHERE id = ${checkoutId} AND status = 'open'`;
    const failed = await sql`SELECT 1 FROM stripe_events WHERE object_id = ${sessionId} AND type = 'checkout.session.async_payment_failed'`;
    if (failed.length) {
      await sql`UPDATE checkouts SET status = 'failed', failure_reason = 'asynchronous payment failed' WHERE id = ${checkoutId} AND status <> 'completed'`;
      return 'async payment failed';
    }
    return 'awaiting asynchronous payment';
  }
  return fulfilCheckout(sql, config, actor, checkoutId, session, now);
}

async function fulfilCheckout(sql: Sql, config: Config, actor: Actor, checkoutId: string, session: StripeSession, now: Date): Promise<string> {
  return sql.begin(async (tx) => {
    const [chk] = await tx<{ id: string; status: string; customer_id: string | null; email: string; quantity: number; currency: string; expected_subtotal: number; snapshot: CheckoutSnapshot; stripe_price_id: string; stripe_product_id: string | null }[]>`
      SELECT * FROM checkouts WHERE id = ${checkoutId} FOR UPDATE`;
    if (!chk) throw notFound('Checkout');
    if (chk.status === 'completed') return 'duplicate: already fulfilled';
    // Bind Stripe's view to our snapshot: price, quantity, currency and undiscounted subtotal
    // must match what we priced. A mismatch is quarantined for review, never granted.
    const line = session.line_items?.data?.[0];
    const problems: string[] = [];
    const sp = chk.snapshot.price;
    if (!line) problems.push('line item missing');
    else if (sp.stripePriceId) {
      if (line.price.id !== sp.stripePriceId) problems.push('line item price differs from snapshot');
    } else {
      // Inline price_data: Stripe must have charged our amount, in our currency, for the product the
      // session was opened against (recorded on the checkout; older rows use the current link).
      const [pm] = await tx<{ stripe_product_id: string | null }[]>`SELECT stripe_product_id FROM stripe_product_mappings WHERE offer_id = ${chk.snapshot.offer.id}`;
      if (line.price.unit_amount !== sp.unitAmount) problems.push(`unit amount ${line.price.unit_amount} != ${sp.unitAmount}`);
      if (line.price.currency !== undefined && line.price.currency !== sp.currency) problems.push('line currency differs');
      const expectedProduct = chk.stripe_product_id ?? pm?.stripe_product_id ?? null;
      if (!expectedProduct || idOf(line.price.product ?? null) !== expectedProduct) problems.push('line item product differs');
      if ((line.price.recurring?.interval ?? null) !== sp.recurringInterval) problems.push('billing interval differs');
    }
    if (line && line.quantity !== chk.quantity) problems.push('quantity differs');
    if (session.currency !== chk.currency) problems.push('currency differs');
    if (session.amount_subtotal !== null && session.amount_subtotal !== chk.expected_subtotal && chk.snapshot.price.taxBehavior !== 'inclusive') problems.push(`subtotal ${session.amount_subtotal} != expected ${chk.expected_subtotal}`);
    if (problems.length) {
      await tx`UPDATE checkouts SET status = 'failed', failure_reason = ${'quarantined: ' + problems.join('; ')} WHERE id = ${checkoutId}`;
      await audit(tx, actor, { action: 'checkout.quarantined', outcome: 'failure', resourceType: 'checkout', resourceId: checkoutId, detail: { problems } });
      return `quarantined: ${problems.join('; ')}`;
    }

    // Customer: the checkout's customer (store checkouts always have one), else the Stripe
    // customer we already know, else the customer with this email (one per email), else new.
    const stripeCustomerId = idOf(session.customer);
    let customerId = chk.customer_id;
    if (!customerId && stripeCustomerId) customerId = (await tx<{ id: string }[]>`SELECT id FROM customers WHERE stripe_customer_id = ${stripeCustomerId}`)[0]?.id ?? null;
    if (!customerId) customerId = (await tx<{ id: string }[]>`SELECT id FROM customers WHERE billing_email = ${(session.customer_details?.email ?? chk.email).toLowerCase()}`)[0]?.id ?? null;
    const details = session.customer_details ?? { email: null, name: null };
    const businessName = details.business_name?.trim() || null;
    if (!customerId) {
      const kind = businessName || chk.snapshot.components.some((c) => c.policy.ownership !== 'individual') ? 'organisation' : 'individual';
      const display = (details.individual_name || details.name || businessName || 'Customer').trim();
      customerId = await insertCustomer(tx, actor, {
        kind, displayName: display, organisationName: kind === 'organisation' ? (businessName ?? display) : null,
        billingEmail: (details.email ?? chk.email).toLowerCase(), taxId: details.tax_ids?.[0]?.value ?? null,
        country: details.address?.country ?? null, marketingConsent: false, stripeCustomerId,
      });
    } else if (stripeCustomerId) {
      await tx`UPDATE customers SET stripe_customer_id = coalesce(stripe_customer_id, ${stripeCustomerId}) WHERE id = ${customerId}`;
    }

    const purchaseId = newId('pur');
    await tx`INSERT INTO purchases (id, customer_id, checkout_id, source, stripe_payment_intent_id, stripe_invoice_id, currency, amount_subtotal, amount_discount, amount_tax, amount_total)
             VALUES (${purchaseId}, ${customerId}, ${checkoutId}, 'stripe_checkout', ${idOf(session.payment_intent)}, ${idOf(session.invoice)}, ${chk.currency},
                     ${session.amount_subtotal ?? chk.expected_subtotal}, ${session.total_details?.amount_discount ?? 0}, ${session.total_details?.amount_tax ?? 0},
                     ${session.amount_total ?? chk.expected_subtotal})`;
    const lineId = newId('pul');
    await tx`INSERT INTO purchase_lines (id, purchase_id, position, offer_id, price_version_id, quantity, currency, unit_amount, snapshot)
             VALUES (${lineId}, ${purchaseId}, 0, ${chk.snapshot.offer.id}, ${chk.snapshot.price.id}, ${chk.quantity}, ${chk.currency}, ${chk.snapshot.price.unitAmount}, ${tx.json(chk.snapshot as never)})`;

    let subscriptionId: string | null = null;
    let periodEnd: Date | null = null;
    if (session.mode === 'subscription') {
      const sub = session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
      if (!sub) throw new RetryLater('subscription not yet available on session');
      subscriptionId = await upsertSubscription(tx, customerId, checkoutId, sub);
      periodEnd = subscriptionPeriodEnd(sub);
      if (!periodEnd) throw new RetryLater('subscription has no current period');
    }

    const items: Array<{ policy: EffectivePolicy; licenseId: string; activationKey: string; expiresAt: Date | null }> = [];
    for (const comp of chk.snapshot.components) {
      const policy = EffectivePolicySchema.parse(comp.policy);
      const ent = await createEntitlement(tx, config, actor, {
        customerId, policy, startsAt: now, periodEnd: policy.term.type === 'subscription' ? periodEnd : null,
        purchaseLineId: lineId, componentId: comp.componentId, subscriptionId: policy.term.type === 'subscription' ? subscriptionId : null,
        snapshotReason: `purchase ${purchaseId}`,
      });
      const ctx = await loadLicenseContext(tx, ent.licenseId, true);
      await signLicense(tx, config, ctx!, actor, 'initial', now);
      items.push({ policy, licenseId: ent.licenseId, activationKey: ent.activationKey, expiresAt: computeExpiry(policy, now, periodEnd) });
    }
    await tx`UPDATE checkouts SET status = 'completed', completed_at = now(), customer_id = ${customerId} WHERE id = ${checkoutId}`;
    await audit(tx, actor, { action: 'purchase.completed', resourceType: 'purchase', resourceId: purchaseId, detail: { checkoutId, customerId, amountTotal: session.amount_total, currency: chk.currency, licenseIds: items.map((i) => i.licenseId) } });

    const name = (details.individual_name || details.name || businessName || 'customer').trim();
    // Paid invoice for anything actually charged ($0 registrations get none).
    let invoice: { id: string; number: number } | null = null;
    const total = session.amount_total ?? chk.expected_subtotal;
    if (total > 0) {
      const sp = chk.snapshot.price;
      const tax = session.total_details?.amount_tax ?? 0;
      invoice = await issueInvoice(tx, {
        kind: 'purchase', livemode: session.livemode ?? false, customerId, purchaseId,
        snapshot: {
          version: 1, seller: sellerFor(config), buyer: await buyerFor(tx, customerId, details.address ?? null, details.individual_name || details.name || null),
          lines: [{ description: chk.snapshot.offer.name, detail: items.map((i) => `${i.policy.product.name} ${i.policy.major.majorVersion} ${i.policy.edition.displayName} (${termText(i)}) · licence ${i.licenseId}`).join('; '),
            quantity: chk.quantity, unitAmount: sp.unitAmount, amount: sp.unitAmount * chk.quantity }],
          currency: chk.currency, subtotal: session.amount_subtotal ?? chk.expected_subtotal, discount: session.total_details?.amount_discount ?? 0, tax,
          taxLabel: tax > 0 ? (sp.taxLabel && sp.taxRateBps ? `${sp.taxLabel} ${sp.taxRateBps / 100}%` : 'Tax') : null,
          total, paidAt: now.toISOString(), paymentReference: idOf(session.payment_intent) ?? idOf(session.invoice) ?? session.id, summary: chk.snapshot.offer.name,
        },
      });
    }
    const invNo = invoice ? invoiceNumber(config, invoice.number, session.livemode ?? false) : null;
    await enqueueEmail(tx, config, {
      businessKey: `purchase:${purchaseId}`, templateKey: 'purchase_confirmation', to: details.email ?? chk.email, toName: details.name ?? null,
      vars: { customerName: name, purchaseId, productSummary: chk.snapshot.offer.name, itemsText: itemsText(items), invoiceText: invNo ? `Your paid invoice ${invNo} is attached (PDF).\n\n` : '' },
      rawHtml: { itemsHtml: itemsHtml(items), invoiceHtml: invNo ? `<p>Your paid invoice <strong>${invNo}</strong> is attached (PDF).</p>` : '' },
      invoiceId: invoice?.id ?? null,
    });
    return `fulfilled ${purchaseId} (${items.length} licence${items.length === 1 ? '' : 's'})`;
  });
}

function termText(i: { policy: EffectivePolicy; expiresAt: Date | null }) {
  return i.expiresAt ? `valid until ${rfc3339(i.expiresAt)}` : 'perpetual';
}

function itemsText(items: Array<{ policy: EffectivePolicy; licenseId: string; activationKey: string; expiresAt: Date | null }>): string {
  return items.map((i) => {
    const lines = [`- ${i.policy.product.name} ${i.policy.major.majorVersion} ${i.policy.edition.displayName} (${termText(i)})`, `  Licence ID: ${i.licenseId}`];
    if (i.policy.seats) lines.push(`  Device seats: ${i.policy.seats}`);
    lines.push(i.policy.activationKeyEmail ? `  Activation key: ${i.activationKey}` : '  Activation key: sign in to the customer portal to reveal it');
    return lines.join('\n');
  }).join('\n');
}

function itemsHtml(items: Array<{ policy: EffectivePolicy; licenseId: string; activationKey: string; expiresAt: Date | null }>): string {
  const rows = items.map((i) => `<tr><td>${escapeHtml(`${i.policy.product.name} ${i.policy.major.majorVersion} ${i.policy.edition.displayName}`)}</td><td>${escapeHtml(termText(i))}</td>
<td><code>${escapeHtml(i.licenseId)}</code></td><td>${i.policy.seats ?? '—'}</td>
<td>${i.policy.activationKeyEmail ? `<code>${escapeHtml(i.activationKey)}</code>` : 'Reveal in the customer portal'}</td></tr>`).join('');
  return `<table cellpadding="6" style="border-collapse:collapse"><thead><tr><th align="left">Product</th><th align="left">Term</th><th align="left">Licence</th><th>Seats</th><th align="left">Activation key</th></tr></thead><tbody>${rows}</tbody></table>
<p>Keep your activation key private. You can rotate it in the portal at any time.</p>`;
}

// ---------------------------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------------------------

interface StripeSubscription {
  id: string;
  status: string;
  customer: string | { id: string };
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  ended_at: number | null;
  trial_end: number | null;
  current_period_start?: number;
  current_period_end?: number;
  metadata: Record<string, string> | null;
  items: { data: Array<{ quantity: number; current_period_start?: number; current_period_end?: number; price: { id: string } }> };
}

/** Period end from items (API >= 2025-03-31.basil) with fallback to the legacy top-level field. */
function subscriptionPeriodEnd(sub: StripeSubscription): Date | null {
  const fromItems = sub.items?.data?.map((i) => i.current_period_end ?? 0).filter((x) => x > 0) ?? [];
  const end = fromItems.length ? Math.max(...fromItems) : (sub.current_period_end ?? null);
  return fromUnixSeconds(end);
}

function subscriptionPeriodStart(sub: StripeSubscription): Date | null {
  const fromItems = sub.items?.data?.map((i) => i.current_period_start ?? 0).filter((x) => x > 0) ?? [];
  return fromUnixSeconds(fromItems.length ? Math.min(...fromItems) : (sub.current_period_start ?? null));
}

async function upsertSubscription(tx: Tx, customerId: string, checkoutId: string | null, sub: StripeSubscription): Promise<string> {
  const quantity = sub.items?.data?.[0]?.quantity ?? 1;
  const [r] = await tx<{ id: string }[]>`
    INSERT INTO subscriptions (id, customer_id, checkout_id, stripe_subscription_id, status, quantity, current_period_start, current_period_end, cancel_at_period_end, canceled_at, ended_at, stripe_state_at)
    VALUES (${newId('sub')}, ${customerId}, ${checkoutId}, ${sub.id}, ${sub.status}, ${quantity}, ${subscriptionPeriodStart(sub)}, ${subscriptionPeriodEnd(sub)},
            ${sub.cancel_at_period_end}, ${fromUnixSeconds(sub.canceled_at)}, ${fromUnixSeconds(sub.ended_at)}, now())
    ON CONFLICT (stripe_subscription_id) DO UPDATE SET status = EXCLUDED.status, quantity = EXCLUDED.quantity,
      current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end,
      cancel_at_period_end = EXCLUDED.cancel_at_period_end, canceled_at = EXCLUDED.canceled_at, ended_at = EXCLUDED.ended_at, stripe_state_at = now()
    RETURNING id`;
  return r!.id;
}

/**
 * Bring our subscription row (and seat counts) in line with Stripe's CURRENT state. Expiry is
 * only ever extended by paid invoices (handleInvoice), never by subscription events, and is
 * never shortened on cancellation or non-payment (brief §8: let it expire, do not revoke).
 */
export async function syncSubscription(sql: Sql, config: Config, stripe: StripeClient, actor: Actor, stripeSubscriptionId: string): Promise<string> {
  const sub = await stripe.request<StripeSubscription>('GET', `/v1/subscriptions/${stripeSubscriptionId}`);
  return sql.begin(async (tx) => {
    const [existing] = await tx<{ id: string; customer_id: string; quantity: number; status: string }[]>`
      SELECT id, customer_id, quantity, status FROM subscriptions WHERE stripe_subscription_id = ${sub.id} FOR UPDATE`;
    if (!existing) {
      if (sub.metadata?.repass_checkout_id) throw new RetryLater('subscription event arrived before checkout fulfilment');
      return 'ignored: subscription not created by this server';
    }
    await upsertSubscription(tx, existing.customer_id, null, sub);
    const changes: string[] = [`status ${existing.status} -> ${sub.status}`];
    const quantity = sub.items?.data?.[0]?.quantity ?? 1;
    if (quantity !== existing.quantity) {
      // Seat changes: re-derive seats for quantity-scaled components and record an audited
      // policy amendment. Devices above the new limit stay active; new activations are blocked.
      const ents = await tx<{ id: string; snapshot: EffectivePolicy }[]>`
        SELECT e.id, s.snapshot FROM entitlements e JOIN entitlement_policy_snapshots s ON s.id = e.policy_snapshot_id
        WHERE e.subscription_id = ${existing.id} FOR UPDATE OF e`;
      for (const e of ents) {
        const comp = e.snapshot.offer ? (await tx<{ seats_per_unit: number | null; quantity_scales_seats: boolean }[]>`SELECT seats_per_unit, quantity_scales_seats FROM offer_entitlement_components WHERE id = ${e.snapshot.offer.componentId}`)[0] : undefined;
        if (!comp?.quantity_scales_seats || e.snapshot.activationModel !== 'device_seats') continue;
        const seats = (comp.seats_per_unit ?? 1) * quantity;
        const snap = EffectivePolicySchema.parse({ ...e.snapshot, seats });
        const snapId = newId('eps');
        await tx`INSERT INTO entitlement_policy_snapshots (id, snapshot, reason, created_by) VALUES (${snapId}, ${tx.json(snap as never)}, ${`subscription quantity ${existing.quantity} -> ${quantity}`}, ${actor.label})`;
        await tx`UPDATE entitlements SET seats = ${seats}, policy_snapshot_id = ${snapId} WHERE id = ${e.id}`;
        await audit(tx, actor, { action: 'entitlement.seats_changed', resourceType: 'entitlement', resourceId: e.id, detail: { from: e.snapshot.seats, to: seats, subscription: sub.id } });
      }
      changes.push(`quantity ${existing.quantity} -> ${quantity}`);
    }
    if (sub.status === 'canceled' && existing.status !== 'canceled') {
      const ents = await tx<{ license_id: string; expires_at: Date | null; product: string }[]>`
        SELECT l.id AS license_id, e.expires_at, p.name AS product FROM entitlements e JOIN licenses l ON l.entitlement_id = e.id
        JOIN product_majors m ON m.id = e.product_major_id JOIN products p ON p.id = m.product_id WHERE e.subscription_id = ${existing.id}`;
      const [c] = await tx<{ billing_email: string }[]>`SELECT billing_email FROM customers WHERE id = ${existing.customer_id}`;
      for (const e of ents) {
        await enqueueEmail(tx, config, { businessKey: `sub_cancelled:${sub.id}:${e.license_id}`, templateKey: 'subscription_cancelled', to: c!.billing_email,
          vars: { productSummary: e.product, licenseId: e.license_id, expiresAt: e.expires_at ? rfc3339(e.expires_at) : 'n/a' } });
      }
    }
    await audit(tx, actor, { action: 'subscription.synced', resourceType: 'subscription', resourceId: existing.id, detail: { stripeSubscriptionId: sub.id, changes } });
    return changes.join(', ');
  });
}

// ---------------------------------------------------------------------------------------------
// Invoices: renewal extension
// ---------------------------------------------------------------------------------------------

interface StripeInvoice {
  id: string;
  livemode?: boolean;
  subtotal?: number | null;
  total_discount_amounts?: Array<{ amount: number }> | null;
  customer_name?: string | null;
  customer_address?: InvoiceAddress | null;
  status: string;
  billing_reason: string | null;
  currency: string;
  customer: string | { id: string } | null;
  amount_due: number;
  amount_paid: number;
  attempt_count?: number;
  tax?: number | null;
  total_taxes?: Array<{ amount: number }> | null;
  hosted_invoice_url: string | null;
  subscription?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription: string | { id: string } } | null } | null;
  status_transitions?: { paid_at: number | null };
  lines: { data: Array<{ period: { start: number; end: number }; description?: string | null; quantity?: number | null; amount?: number | null }> };
}

function invoiceSubscriptionId(inv: StripeInvoice): string | null {
  return idOf(inv.parent?.subscription_details?.subscription ?? null) ?? idOf(inv.subscription ?? null);
}

export async function handleInvoice(sql: Sql, config: Config, stripe: StripeClient, actor: Actor, invoiceId: string): Promise<string> {
  const inv = await stripe.request<StripeInvoice>('GET', `/v1/invoices/${invoiceId}`, { expand: ['lines'] });
  const stripeSubId = invoiceSubscriptionId(inv);
  if (!stripeSubId) return 'ignored: invoice not for a subscription';
  const [known] = await sql`SELECT 1 FROM subscriptions WHERE stripe_subscription_id = ${stripeSubId}`;
  if (!known) {
    // Out of order: the first invoice can arrive before checkout.session.completed is processed.
    const sub = await stripe.request<StripeSubscription>('GET', `/v1/subscriptions/${stripeSubId}`);
    const checkoutId = sub.metadata?.repass_checkout_id;
    if (!checkoutId) return 'ignored: subscription not managed by this server';
    const [chk] = await sql<{ status: string }[]>`SELECT status FROM checkouts WHERE id = ${checkoutId}`;
    if (chk && chk.status !== 'completed' && chk.status !== 'failed' && chk.status !== 'expired') throw new RetryLater('invoice arrived before checkout fulfilment');
    return `ignored: subscription checkout ${checkoutId} is ${chk?.status ?? 'unknown'}`;
  }
  return sql.begin(async (tx) => {
    const [sub] = await tx<{ id: string; customer_id: string }[]>`SELECT id, customer_id FROM subscriptions WHERE stripe_subscription_id = ${stripeSubId} FOR UPDATE`;
    if (!sub) throw new RetryLater('subscription row disappeared');
    const periodEnd = fromUnixSeconds(Math.max(0, ...(inv.lines?.data ?? []).map((l) => l.period?.end ?? 0)));
    const tax = inv.total_taxes ? inv.total_taxes.reduce((n, t) => n + (t.amount ?? 0), 0) : (inv.tax ?? 0);
    await tx`
      INSERT INTO invoices (id, stripe_invoice_id, subscription_id, customer_id, status, billing_reason, currency, amount_due, amount_paid, amount_tax, period_end, hosted_invoice_url, paid_at)
      VALUES (${newId('inv')}, ${inv.id}, ${sub.id}, ${sub.customer_id}, ${inv.status}, ${inv.billing_reason}, ${inv.currency}, ${inv.amount_due}, ${inv.amount_paid},
              ${tax}, ${periodEnd}, ${inv.hosted_invoice_url}, ${fromUnixSeconds(inv.status_transitions?.paid_at ?? null)})
      ON CONFLICT (stripe_invoice_id) DO UPDATE SET status = EXCLUDED.status, amount_paid = EXCLUDED.amount_paid, amount_tax = EXCLUDED.amount_tax,
        paid_at = coalesce(invoices.paid_at, EXCLUDED.paid_at), hosted_invoice_url = EXCLUDED.hosted_invoice_url`;
    const [c] = await tx<{ billing_email: string }[]>`SELECT billing_email FROM customers WHERE id = ${sub.customer_id}`;
    const ents = await tx<{ id: string; license_id: string; expires_at: Date | null; grace: number; product: string }[]>`
      SELECT e.id, l.id AS license_id, e.expires_at, coalesce((s.snapshot->'term'->>'graceDays')::int, 0) AS grace, p.name AS product
      FROM entitlements e JOIN licenses l ON l.entitlement_id = e.id JOIN entitlement_policy_snapshots s ON s.id = e.policy_snapshot_id
      JOIN product_majors m ON m.id = e.product_major_id JOIN products p ON p.id = m.product_id
      WHERE e.subscription_id = ${sub.id} FOR UPDATE OF e`;
    if (inv.status !== 'paid') {
      for (const e of ents) {
        await enqueueEmail(tx, config, { businessKey: `invoice_failed:${inv.id}:${inv.attempt_count ?? 0}:${e.license_id}`, templateKey: 'subscription_payment_failed', to: c!.billing_email,
          vars: { productSummary: e.product, licenseId: e.license_id, expiresAt: e.expires_at ? rfc3339(e.expires_at) : 'n/a' } });
      }
      return `invoice ${inv.status}: no extension`;
    }
    const applied = await tx`UPDATE invoices SET extension_applied_at = now() WHERE stripe_invoice_id = ${inv.id} AND extension_applied_at IS NULL RETURNING id`;
    if (!applied.length) return 'duplicate: extension already applied';
    if (!periodEnd) return 'paid invoice without service period';
    let extended = 0;
    for (const e of ents) {
      const target = new Date(periodEnd.getTime() + e.grace * 86_400_000);
      // Monotonic: an older invoice processed late can never shorten the entitlement.
      if (e.expires_at && e.expires_at >= target) continue;
      await tx`UPDATE entitlements SET expires_at = ${target} WHERE id = ${e.id}`;
      await audit(tx, actor, { action: 'entitlement.extended', resourceType: 'entitlement', resourceId: e.id, detail: { invoice: inv.id, from: e.expires_at, to: target } });
      await enqueueEmail(tx, config, { businessKey: `renewed:${inv.id}:${e.license_id}`, templateKey: 'subscription_renewed', to: c!.billing_email,
        vars: { productSummary: e.product, licenseId: e.license_id, expiresAt: rfc3339(target) } });
      extended++;
    }
    // Paid invoice for each renewal charge (the first charge is covered by the purchase invoice).
    if (inv.billing_reason !== 'subscription_create' && inv.amount_paid > 0) {
      const [orig] = await tx<{ snapshot: CheckoutSnapshot | null }[]>`
        SELECT k.snapshot FROM subscriptions s LEFT JOIN checkouts k ON k.id = s.checkout_id WHERE s.id = ${sub.id}`;
      const sp = orig?.snapshot?.price;
      const summary = orig?.snapshot?.offer.name ?? [...new Set(ents.map((e) => e.product))].join(', ');
      const period = `Service period ${new Date((inv.lines?.data?.[0]?.period?.start ?? 0) * 1000).toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`;
      const lines = (inv.lines?.data ?? []).filter((l) => (l.amount ?? 0) > 0).map((l) => {
        const qty = Math.max(1, l.quantity ?? 1);
        return { description: summary || (l.description ?? 'Subscription renewal'), detail: period, quantity: qty, unitAmount: Math.round((l.amount ?? 0) / qty), amount: l.amount ?? 0 };
      });
      const discount = (inv.total_discount_amounts ?? []).reduce((n, d) => n + (d.amount ?? 0), 0);
      const paidAt = fromUnixSeconds(inv.status_transitions?.paid_at ?? null) ?? new Date();
      const livemode = inv.livemode ?? false;
      const issued = await issueInvoice(tx, {
        kind: 'renewal', livemode, customerId: sub.customer_id, stripeInvoiceId: inv.id,
        snapshot: {
          version: 1, seller: sellerFor(config), buyer: await buyerFor(tx, sub.customer_id, inv.customer_address ?? null, inv.customer_name ?? null),
          lines: lines.length ? lines : [{ description: summary || 'Subscription renewal', detail: period, quantity: 1, unitAmount: inv.amount_paid - tax, amount: inv.amount_paid - tax }],
          currency: inv.currency, subtotal: inv.subtotal ?? inv.amount_paid - tax + discount, discount, tax,
          taxLabel: tax > 0 ? (sp?.taxLabel && sp.taxRateBps ? `${sp.taxLabel} ${sp.taxRateBps / 100}%` : 'Tax') : null,
          total: inv.amount_paid, paidAt: paidAt.toISOString(), paymentReference: inv.id, summary,
        },
      });
      const [cust] = await tx<{ display_name: string; organisation_name: string | null }[]>`SELECT display_name, organisation_name FROM customers WHERE id = ${sub.customer_id}`;
      await enqueueEmail(tx, config, {
        businessKey: `receipt:${inv.id}`, templateKey: 'payment_receipt', to: c!.billing_email,
        vars: { customerName: cust?.organisation_name ?? cust?.display_name ?? 'customer', amount: money(inv.amount_paid, inv.currency), productSummary: summary, invoiceNumber: invoiceNumber(config, issued.number, livemode) },
        invoiceId: issued.id,
      });
    }
    return `extended ${extended} entitlement(s) to ${periodEnd.toISOString()}`;
  });
}

// ---------------------------------------------------------------------------------------------
// Refunds and disputes (product policy: revoke | review | none)
// ---------------------------------------------------------------------------------------------

interface StripeCharge { id: string; payment_intent: string | null; amount: number; amount_refunded: number; refunded: boolean }
interface StripeDispute { id: string; charge: string; payment_intent: string | null; status: string; reason: string }

async function entitlementsForPayment(tx: Tx, stripe: StripeClient, paymentIntentId: string | null): Promise<{ purchaseId: string | null; rows: Array<{ id: string; license_id: string; snapshot: EffectivePolicy }> }> {
  if (!paymentIntentId) return { purchaseId: null, rows: [] };
  const [p] = await tx<{ id: string }[]>`SELECT id FROM purchases WHERE stripe_payment_intent_id = ${paymentIntentId}`;
  if (p) {
    const rows = await tx<{ id: string; license_id: string; snapshot: EffectivePolicy }[]>`
      SELECT e.id, l.id AS license_id, s.snapshot FROM entitlements e JOIN licenses l ON l.entitlement_id = e.id JOIN purchase_lines pl ON pl.id = e.purchase_line_id
      JOIN entitlement_policy_snapshots s ON s.id = e.policy_snapshot_id WHERE pl.purchase_id = ${p.id}`;
    return { purchaseId: p.id, rows };
  }
  // Renewal payments: payment intent -> invoice -> subscription -> entitlements.
  const ip = await stripe.request<{ data: Array<{ invoice: string | { id: string } }> }>('GET', '/v1/invoice_payments', { payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 1 });
  const invId = idOf(ip.data?.[0]?.invoice ?? null);
  if (!invId) return { purchaseId: null, rows: [] };
  const rows = await tx<{ id: string; license_id: string; snapshot: EffectivePolicy }[]>`
    SELECT e.id, l.id AS license_id, s.snapshot FROM invoices i JOIN entitlements e ON e.subscription_id = i.subscription_id JOIN licenses l ON l.entitlement_id = e.id
    JOIN entitlement_policy_snapshots s ON s.id = e.policy_snapshot_id WHERE i.stripe_invoice_id = ${invId}`;
  return { purchaseId: null, rows };
}

async function applyPaymentReversal(tx: Tx, config: Config, actor: Actor, rows: Array<{ id: string; license_id: string; snapshot: EffectivePolicy }>, kind: 'refund' | 'dispute', ref: string, full: boolean): Promise<string[]> {
  const out: string[] = [];
  for (const r of rows) {
    const action = kind === 'refund' ? (full ? r.snapshot.refundAction : 'review') : r.snapshot.disputeAction;
    if (action === 'revoke') {
      const res = await revokeInTx(tx, actor, r.license_id, { reason: `${kind} ${ref}`, source: kind === 'refund' ? 'stripe_refund' : 'stripe_dispute', sourceRef: ref });
      out.push(`${r.license_id}: ${res.changed ? 'revoked' : 'already revoked'}`);
      if (res.changed) {
        const [c] = await tx<{ billing_email: string }[]>`SELECT c.billing_email FROM entitlements e JOIN customers c ON c.id = e.customer_id WHERE e.id = ${r.id}`;
        await enqueueEmail(tx, config, { businessKey: `revoked:${r.license_id}:${ref}`, templateKey: 'entitlement_revoked', category: 'security', to: c!.billing_email, vars: { licenseId: r.license_id, reason: kind === 'refund' ? 'refunded' : 'payment disputed' } });
      }
    } else if (action === 'review') {
      await tx`UPDATE entitlements SET review_required = true, review_reason = ${`${kind} ${ref}`} WHERE id = ${r.id}`;
      await audit(tx, actor, { action: 'entitlement.review_required', resourceType: 'entitlement', resourceId: r.id, detail: { kind, ref, full } });
      out.push(`${r.license_id}: flagged for review`);
    } else {
      out.push(`${r.license_id}: no action (policy)`);
    }
  }
  return out;
}

async function handleRefund(sql: Sql, config: Config, stripe: StripeClient, actor: Actor, charge: StripeCharge): Promise<string> {
  const current = await stripe.request<StripeCharge>('GET', `/v1/charges/${charge.id}`);
  return sql.begin(async (tx) => {
    const { purchaseId, rows } = await entitlementsForPayment(tx, stripe, current.payment_intent);
    if (!rows.length) {
      await audit(tx, actor, { action: 'stripe.refund_unmapped', outcome: 'failure', resourceType: 'charge', resourceId: charge.id });
      return 'unmapped refund: flagged in audit for review';
    }
    const full = current.refunded || current.amount_refunded >= current.amount;
    if (purchaseId) await tx`UPDATE purchases SET status = ${full ? 'refunded' : 'partially_refunded'}, amount_refunded = ${current.amount_refunded} WHERE id = ${purchaseId}`;
    return (await applyPaymentReversal(tx, config, actor, rows, 'refund', charge.id, full)).join('; ');
  });
}

async function handleDispute(sql: Sql, config: Config, stripe: StripeClient, actor: Actor, dispute: StripeDispute, type: string): Promise<string> {
  const current = await stripe.request<StripeDispute>('GET', `/v1/disputes/${dispute.id}`);
  return sql.begin(async (tx) => {
    const { purchaseId, rows } = await entitlementsForPayment(tx, stripe, current.payment_intent);
    if (!rows.length) return 'unmapped dispute';
    if (type === 'charge.dispute.closed') {
      // Never auto-unrevoke: a won dispute is flagged so support can reverse deliberately.
      for (const r of rows) await tx`UPDATE entitlements SET review_required = true, review_reason = ${`dispute ${current.id} closed: ${current.status}`} WHERE id = ${r.id}`;
      return `dispute closed (${current.status}); flagged for review`;
    }
    if (purchaseId) await tx`UPDATE purchases SET status = 'disputed' WHERE id = ${purchaseId}`;
    return (await applyPaymentReversal(tx, config, actor, rows, 'dispute', current.id, true)).join('; ');
  });
}

// ---------------------------------------------------------------------------------------------
// Reconciliation (lost/late webhooks) and operator tools
// ---------------------------------------------------------------------------------------------

/** Re-check checkouts that should have completed by now (covers lost checkout webhooks). */
export async function reconcileCheckouts(sql: Sql, config: Config, stripe: StripeClient, limit = 5, now = new Date()): Promise<string[]> {
  const rows = await sql<{ id: string; stripe_checkout_session_id: string }[]>`
    SELECT id, stripe_checkout_session_id FROM checkouts
    WHERE status IN ('open', 'awaiting_payment') AND stripe_checkout_session_id IS NOT NULL AND created_at < ${new Date(now.getTime() - 10 * 60_000)}
    ORDER BY updated_at LIMIT ${limit}`;
  const out: string[] = [];
  for (const r of rows) {
    await sql`UPDATE checkouts SET updated_at = now() WHERE id = ${r.id}`;
    out.push(`${r.id}: ${await handleCheckoutSession(sql, config, stripe, stripeActor('reconcile'), r.stripe_checkout_session_id, now)}`);
  }
  return out;
}

/** Re-sync live subscriptions and apply any paid-but-unapplied latest invoice. */
export async function reconcileSubscriptions(sql: Sql, config: Config, stripe: StripeClient, limit = 5): Promise<string[]> {
  const rows = await sql<{ stripe_subscription_id: string }[]>`
    SELECT stripe_subscription_id FROM subscriptions WHERE status NOT IN ('canceled', 'incomplete_expired')
    ORDER BY stripe_state_at NULLS FIRST LIMIT ${limit}`;
  const out: string[] = [];
  for (const r of rows) {
    const actor = stripeActor('reconcile');
    out.push(`${r.stripe_subscription_id}: ${await syncSubscription(sql, config, stripe, actor, r.stripe_subscription_id)}`);
    const list = await stripe.request<{ data: Array<{ id: string; status: string }> }>('GET', '/v1/invoices', { subscription: r.stripe_subscription_id, status: 'paid', limit: 3 });
    for (const inv of list.data ?? []) out.push(`  ${inv.id}: ${await handleInvoice(sql, config, stripe, actor, inv.id)}`);
  }
  return out;
}

/** Pull recent events from the Stripe Events API (authenticated by our key) to backfill gaps. */
export async function backfillEvents(sql: Sql, stripe: StripeClient, actor: Actor, sinceSeconds: number): Promise<{ fetched: number; stored: number }> {
  requirePermission(actor, 'webhooks:reconcile');
  const list = await stripe.request<{ data: VerifiedStripeEvent[] }>('GET', '/v1/events', { created: { gte: sinceSeconds }, limit: 100, types: [...HANDLED] });
  let stored = 0;
  for (const ev of list.data ?? []) if ((await storeEvent(sql, ev)).status === 'stored') stored++;
  await audit(sql, actor, { action: 'stripe.events_backfilled', detail: { since: sinceSeconds, fetched: list.data?.length ?? 0, stored } });
  return { fetched: list.data?.length ?? 0, stored };
}

export async function replayStripeEvent(sql: Sql, actor: Actor, eventId: string) {
  requirePermission(actor, 'webhooks:reconcile');
  const r = await sql`UPDATE stripe_events SET status = 'received', last_error = NULL WHERE id = ${eventId} AND status IN ('failed', 'dead', 'processed') RETURNING id`;
  if (!r.length) throw notFound('Replayable Stripe event');
  await enqueueJob(sql, 'stripe.process_event', `stripe.event:${eventId}:replay:${Date.now()}`, { eventId });
  await audit(sql, actor, { action: 'stripe.event_replayed', resourceType: 'stripe_event', resourceId: eventId });
  return { eventId, status: 'queued' };
}

export async function listStripeEvents(db: Db, opts: { status?: string; type?: string; limit?: number }) {
  return db<{ id: string; type: string; status: string; attempts: number; last_error: string | null; outcome: string | null; received_at: Date; processed_at: Date | null; object_id: string | null }[]>`
    SELECT id, type, status, attempts, last_error, outcome, received_at, processed_at, object_id FROM stripe_events
    WHERE (${opts.status ?? null}::text IS NULL OR status = ${opts.status ?? null}) AND (${opts.type ?? null}::text IS NULL OR type = ${opts.type ?? null})
    ORDER BY received_at DESC LIMIT ${Math.min(opts.limit ?? 50, 500)}`;
}

/** Customer Portal session for self-service billing (payment methods, cancel, invoices). */
export async function createBillingPortalSession(sql: Sql, config: Config, stripe: StripeClient, customerId: string): Promise<string> {
  const [c] = await sql<{ stripe_customer_id: string | null }[]>`SELECT stripe_customer_id FROM customers WHERE id = ${customerId}`;
  if (!c?.stripe_customer_id) throw new AppError('precondition_failed', 'No billing account exists for this customer yet');
  try {
    const s = await stripe.request<{ url: string }>('POST', '/v1/billing_portal/sessions', { customer: c.stripe_customer_id, return_url: new URL('/portal', config.publicBaseUrl).toString() }, `repass-portal-${customerId}-${Math.floor(Date.now() / 60_000)}`);
    return s.url;
  } catch (e) {
    if (e instanceof StripeError) throw new AppError('provider_unavailable', 'Billing portal is unavailable right now.');
    throw e;
  }
}
