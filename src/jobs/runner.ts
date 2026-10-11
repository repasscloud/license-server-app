// Background work, driven by Cron Triggers (durable) and best-effort waitUntil kicks after a
// webhook is stored (latency only — never relied upon). Every unit of work is a bounded batch
// sized for the Workers Free CPU (10 ms/invocation) and subrequest (50) limits; anything not
// finished is picked up by the next tick.

import type { Config } from '../config.ts';
import type { Sql } from '../db/client.ts';
import type { MailTransport } from '../integrations/mail.ts';
import type { StripeClient } from '../integrations/stripe.ts';
import { processStripeEvent, reconcileCheckouts, reconcileSubscriptions, RetryLater } from '../services/billing.ts';
import { dispatchEmails, enqueueEmail } from '../services/email.ts';
import { claimJobs, completeJob, failJob, type Job } from '../services/jobs.ts';
import { purgeRateLimitBuckets } from '../services/rate-limit.ts';
import { archiveStripePrice, checkDrift, syncOffer, syncPrice } from '../services/stripe-sync.ts';

export interface JobDeps {
  sql: Sql;
  config: Config;
  stripe: StripeClient;
  mail: MailTransport;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

export async function runJob(d: JobDeps, job: Job): Promise<void> {
  switch (job.kind) {
    case 'stripe.process_event':
      await processStripeEvent(d.sql, d.config, d.stripe, String(job.payload.eventId));
      return;
    case 'stripe.sync_price':
      await syncPrice(d.sql, d.stripe, String(job.payload.priceVersionId));
      return;
    case 'stripe.sync_offer':
      await syncOffer(d.sql, d.stripe, String(job.payload.offerId));
      return;
    case 'stripe.archive_price':
      await archiveStripePrice(d.sql, d.stripe, String(job.payload.priceVersionId));
      return;
    default:
      throw new Error(`unknown job kind ${job.kind}`);
  }
}

export async function drainJobs(d: JobDeps, limit = 3, kinds?: string[]): Promise<{ done: number; retried: number; dead: number }> {
  const stats = { done: 0, retried: 0, dead: 0 };
  const jobs = await claimJobs(d.sql, limit, kinds);
  for (const job of jobs) {
    try {
      await runJob(d, job);
      await completeJob(d.sql, job.id);
      stats.done++;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      const retryAfter = e instanceof RetryLater ? 60 : undefined;
      const r = await failJob(d.sql, job, msg, retryAfter);
      if (r === 'dead') {
        stats.dead++;
        if (job.kind === 'stripe.process_event') await d.sql`UPDATE stripe_events SET status = 'dead' WHERE id = ${String(job.payload.eventId)}`;
      } else stats.retried++;
      d.log('job_failed', { jobId: job.id, kind: job.kind, attempts: job.attempts, outcome: r, error: msg.slice(0, 300) });
    }
  }
  return stats;
}

/** Frequent tick: jobs, email, overdue checkouts. */
export async function frequentTick(d: JobDeps): Promise<Record<string, unknown>> {
  const jobs = await drainJobs(d, 3);
  const mail = await dispatchEmails(d.sql, d.config, d.mail, 3);
  const checkouts = d.config.has('STRIPE_SECRET_KEY') ? await reconcileCheckouts(d.sql, d.config, d.stripe, 1) : [];
  return { jobs, mail, checkouts: checkouts.length };
}

/** Daily tick: reconciliation, drift checks and retention housekeeping. */
export async function dailyTick(d: JobDeps): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (d.config.has('STRIPE_SECRET_KEY')) {
    out.subscriptions = (await reconcileSubscriptions(d.sql, d.config, d.stripe, 3)).length;
    out.drift = await checkDrift(d.sql, d.stripe, 5);
  }
  out.expiringReminders = await queueExpiringReminders(d);
  out.rateBuckets = await purgeRateLimitBuckets(d.sql);
  const challenges = await d.sql`DELETE FROM auth_challenges WHERE expires_at < now() - interval '7 days'`;
  const sessions = await d.sql`DELETE FROM auth_sessions WHERE expires_at < now() - interval '30 days'`;
  const idem = await d.sql`DELETE FROM idempotency_records WHERE expires_at < now()`;
  const jobs = await d.sql`DELETE FROM outbox_jobs WHERE status = 'done' AND updated_at < now() - interval '30 days'`;
  // Purge raw Stripe payloads (may contain personal data) after 90 days; keep the event record.
  const events = await d.sql`UPDATE stripe_events SET payload = jsonb_build_object('purged', true) WHERE received_at < now() - interval '90 days' AND NOT (payload ? 'purged')`;
  const mail = await d.sql`DELETE FROM email_outbox WHERE status IN ('sent', 'delivered', 'suppressed', 'bounced') AND created_at < now() - interval '180 days'`;
  Object.assign(out, { challenges: challenges.count, sessions: sessions.count, idempotency: idem.count, jobs: jobs.count, stripePayloadsPurged: events.count, mail: mail.count });
  return out;
}

/**
 * Seven-day expiry notice for terms that will NOT renew automatically (fixed terms, cancelled or
 * unpaid subscriptions). One email per licence per expiry date (business-key idempotency).
 */
async function queueExpiringReminders(d: JobDeps): Promise<number> {
  const rows = await d.sql<{ license_id: string; expires_at: Date; billing_email: string; product: string }[]>`
    SELECT l.id AS license_id, e.expires_at, c.billing_email, p.name || ' ' || m.major_version AS product
    FROM entitlements e JOIN licenses l ON l.entitlement_id = e.id JOIN customers c ON c.id = e.customer_id
    JOIN product_majors m ON m.id = e.product_major_id JOIN products p ON p.id = m.product_id
    LEFT JOIN subscriptions s ON s.id = e.subscription_id
    WHERE e.status = 'active' AND e.expires_at BETWEEN now() + interval '6 days' AND now() + interval '7 days'
      AND (s.id IS NULL OR s.cancel_at_period_end OR s.status NOT IN ('active', 'trialing'))
    LIMIT 50`;
  for (const r of rows) {
    const date = r.expires_at.toISOString().slice(0, 10);
    await enqueueEmail(d.sql, d.config, { businessKey: `expiring:${r.license_id}:${date}`, templateKey: 'subscription_expiring', to: r.billing_email, vars: { licenseId: r.license_id, productSummary: r.product, expiresAt: date } });
  }
  return rows.length;
}
