// Optional MailerSend delivery webhooks. Verified (HMAC-SHA256 hex of the raw body, header
// `Signature`) before parsing, deduplicated by body digest, and used only to update delivery
// state and suppress hard-bouncing / complaining recipients. Never mutates licensing data.
// If MAILERSEND_WEBHOOK_SECRET is not configured the endpoint returns 404 and no delivery
// tracking is claimed.

import type { Config } from '../config.ts';
import { sha256Hex } from '../crypto/hashing.ts';
import type { Sql } from '../db/client.ts';
import { encodeUtf8, hexDecode, timingSafeEqual } from '../lib/encoding.ts';
import { audit } from './audit.ts';
import { recipientHash } from './email.ts';

export class MailWebhookError extends Error {}

export async function verifyMailerSendSignature(rawBody: string, signature: string | null, secret: string): Promise<void> {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) throw new MailWebhookError('missing or malformed signature');
  const key = await crypto.subtle.importKey('raw', encodeUtf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encodeUtf8(rawBody)));
  if (!timingSafeEqual(mac, hexDecode(signature.toLowerCase()))) throw new MailWebhookError('signature mismatch');
}

interface MailerSendEvent {
  type: string;
  created_at?: string;
  data?: { message_id?: string; email?: { message?: { id?: string }; recipient?: { email?: string } }; recipient?: { email?: string } };
}

export async function receiveMailerSendWebhook(sql: Sql, config: Config, rawBody: string, signature: string | null): Promise<string> {
  await verifyMailerSendSignature(rawBody, signature, config.secret('MAILERSEND_WEBHOOK_SECRET'));
  const ev = JSON.parse(rawBody) as MailerSendEvent;
  const id = await sha256Hex(rawBody);
  // The MailerSend docs disagree on the message-id location; accept both documented paths.
  const messageId = ev.data?.email?.message?.id ?? ev.data?.message_id ?? null;
  const recipient = ev.data?.email?.recipient?.email ?? ev.data?.recipient?.email ?? null;
  const rh = recipient ? await recipientHash(config, recipient) : null;
  const ins = await sql`INSERT INTO mail_events (id, type, provider_message_id, recipient_hash) VALUES (${id}, ${ev.type}, ${messageId}, ${rh}) ON CONFLICT DO NOTHING RETURNING id`;
  if (!ins.length) return 'duplicate';
  const actor = { type: 'mailersend' as const, id: null, label: 'mailersend' };
  switch (ev.type) {
    case 'activity.delivered':
      if (messageId) await sql`UPDATE email_outbox SET status = 'delivered', delivered_at = now() WHERE provider_message_id = ${messageId} AND status IN ('sent', 'uncertain')`;
      return 'delivered';
    case 'activity.hard_bounced':
    case 'activity.spam_complaint':
      if (messageId) await sql`UPDATE email_outbox SET status = 'bounced', last_error = ${ev.type} WHERE provider_message_id = ${messageId}`;
      if (rh) await sql`INSERT INTO email_suppressions (recipient_hash, reason) VALUES (${rh}, ${ev.type}) ON CONFLICT DO NOTHING`;
      await audit(sql, actor, { action: 'email.suppressed', resourceType: 'email', resourceId: messageId, detail: { type: ev.type } });
      return 'suppressed';
    case 'activity.soft_bounced':
      if (messageId) await sql`UPDATE email_outbox SET last_error = 'soft bounce reported by provider' WHERE provider_message_id = ${messageId}`;
      return 'soft bounce noted';
    default:
      return 'ignored';
  }
}
