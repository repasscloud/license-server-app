// Provider webhooks. Raw body is read once and verified before parsing. Stripe events are
// stored durably and acknowledged; processing happens in jobs (a best-effort immediate kick is
// scheduled with waitUntil for latency, but cron is the durable path).

import { Hono } from 'hono';
import { WebhookSignatureError } from '../integrations/stripe.ts';
import { drainJobs } from '../jobs/runner.ts';
import { receiveStripeWebhook } from '../services/billing.ts';
import { MailWebhookError, receiveMailerSendWebhook } from '../services/mail-webhooks.ts';
import { type AppEnv, logError, readText } from './context.ts';

export const webhooks = new Hono<AppEnv>();

webhooks.post('/stripe', async (c) => {
  const deps = c.get('deps');
  if (!deps.config.has('STRIPE_WEBHOOK_SECRET')) return c.json({ error: 'not_configured' }, 503);
  let raw: string;
  try {
    raw = await readText(c, 512 * 1024);
  } catch {
    return c.json({ error: 'invalid_request' }, 413);
  }
  try {
    const r = await receiveStripeWebhook(deps.sql, deps.config, raw, c.req.header('stripe-signature') ?? null, deps.stripe.livemode);
    if (r.status === 'stored') {
      // Latency optimisation only; a separate connection because the request's pool closes.
      c.executionCtx.waitUntil((async () => {
        const { makeDeps } = await import('./context.ts');
        const d = makeDeps(c.env);
        try {
          await drainJobs({ ...d, log: () => {} }, 1, ['stripe.process_event']);
        } catch {
          /* cron will retry */
        } finally {
          await d.sql.end({ timeout: 5 });
        }
      })());
    }
    return c.json({ received: true, status: r.status });
  } catch (e) {
    if (e instanceof WebhookSignatureError) return c.json({ error: 'invalid_signature' }, 400);
    logError(c, e);
    // 5xx makes Stripe retry later; nothing was stored.
    return c.json({ error: 'server_error' }, 500);
  }
});

webhooks.post('/mailersend', async (c) => {
  const deps = c.get('deps');
  if (!deps.config.has('MAILERSEND_WEBHOOK_SECRET')) return c.json({ error: 'not_found' }, 404);
  try {
    const raw = await readText(c, 256 * 1024);
    const outcome = await receiveMailerSendWebhook(deps.sql, deps.config, raw, c.req.header('signature') ?? null);
    return c.json({ received: true, outcome });
  } catch (e) {
    if (e instanceof MailWebhookError || e instanceof SyntaxError) return c.json({ error: 'invalid_signature' }, 400);
    logError(c, e);
    return c.json({ error: 'server_error' }, 500);
  }
});
