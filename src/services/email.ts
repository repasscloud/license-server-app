// Transactional email through a durable PostgreSQL outbox. Purchases and licences never depend
// on mail delivery: business transactions only INSERT outbox rows (idempotent by business key),
// and the dispatcher sends them later with retries/backoff. The recipient and variables are
// AES-GCM encrypted at rest (APP_DATA_KEY) and purged when the message reaches a terminal state.

import type { Config } from '../config.ts';
import { appDataAad, openCompact, sealCompact } from '../crypto/aead.ts';
import { hmac } from '../crypto/hashing.ts';
import { toBytes, type Db, type Sql } from '../db/client.ts';
import { base64Encode, decodeUtf8, encodeUtf8, hexEncode } from '../lib/encoding.ts';
import { invalid, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { requirePermission, type Actor } from './actor.ts';
import { audit } from './audit.ts';
import { backoffSeconds } from './jobs.ts';
import { MailError, type MailTransport, type OutgoingMail } from '../integrations/mail.ts';
import { getInvoice, invoiceNumber, renderInvoicePdf } from './invoices.ts';

export type EmailCategory = 'transactional' | 'security' | 'marketing';

export interface EmailRequest {
  businessKey: string;
  templateKey: string;
  to: string;
  toName?: string | null;
  vars: Record<string, string>;
  /** Pre-rendered HTML fragments built by the server from escaped data (never user input). */
  rawHtml?: Record<string, string>;
  category?: EmailCategory;
  /** Attach this paid invoice as a PDF (rendered at send time from its immutable snapshot). */
  invoiceId?: string | null;
}

export async function recipientHash(config: Config, email: string): Promise<string> {
  return hexEncode(await hmac(config.secret('AUTH_PEPPER'), 'email-recipient/v1', email.trim().toLowerCase())).slice(0, 32);
}

/** Queue an email inside the caller's transaction. Duplicate business keys are no-ops. */
export async function enqueueEmail(db: Db, config: Config, req: EmailRequest): Promise<{ queued: boolean; id: string | null }> {
  const category = req.category ?? 'transactional';
  if (category === 'marketing') throw invalid('Marketing email is not sent through the transactional outbox');
  const id = newId('eml');
  const rh = await recipientHash(config, req.to);
  const sealed = await sealCompact(config.appDataKeys, encodeUtf8(JSON.stringify({ to: req.to, toName: req.toName ?? null, vars: req.vars, rawHtml: req.rawHtml ?? {}, invoiceId: req.invoiceId ?? null })), appDataAad('email-outbox', id));
  const rows = await db<{ id: string }[]>`
    INSERT INTO email_outbox (id, business_key, template_key, category, recipient_hash, payload_ciphertext, payload_key_version)
    VALUES (${id}, ${req.businessKey}, ${req.templateKey}, ${category}, ${rh}, ${sealed.blob}, ${sealed.keyVersion})
    ON CONFLICT (business_key) DO NOTHING RETURNING id`;
  return { queued: rows.length === 1, id: rows[0]?.id ?? null };
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** {{var}} is HTML-escaped (in HTML) / verbatim (in text); {{{var}}} inserts server-built raw HTML. */
export function renderTemplate(tpl: string, vars: Record<string, string>, rawHtml: Record<string, string>, html: boolean): string {
  return tpl
    .replace(/\{\{\{\s*([a-zA-Z0-9_]+)\s*\}\}\}/g, (_, k: string) => (html ? (rawHtml[k] ?? '') : (vars[k] ?? '')))
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k: string) => {
      const v = vars[k] ?? '';
      return html ? escapeHtml(v) : v;
    });
}

interface OutboxRow {
  id: string;
  template_key: string;
  category: string;
  recipient_hash: string;
  payload_ciphertext: Uint8Array | null;
  payload_key_version: number | null;
  attempts: number;
}

const MAX_ATTEMPTS = 10;

/** Send due emails. Bounded batch for Workers Free CPU/subrequest limits. */
export async function dispatchEmails(sql: Sql, config: Config, transport: MailTransport, limit = 5): Promise<{ sent: number; failed: number; dead: number; suppressed: number }> {
  const stats = { sent: 0, failed: 0, dead: 0, suppressed: 0 };
  const rows = await sql<OutboxRow[]>`
    UPDATE email_outbox SET status = 'sending', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
    WHERE id IN (SELECT id FROM email_outbox
                 WHERE (status IN ('pending', 'failed') AND next_attempt_at <= now()) OR (status = 'sending' AND locked_until < now())
                 ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING id, template_key, category, recipient_hash, payload_ciphertext, payload_key_version, attempts`;
  for (const row of rows) {
    const suppressed = await sql`SELECT 1 FROM email_suppressions WHERE recipient_hash = ${row.recipient_hash}`;
    if (suppressed.length) {
      await sql`UPDATE email_outbox SET status = 'suppressed', payload_ciphertext = NULL, locked_until = NULL, last_error = 'recipient suppressed (bounce/complaint)' WHERE id = ${row.id}`;
      stats.suppressed++;
      continue;
    }
    try {
      if (!row.payload_ciphertext || !row.payload_key_version) throw new MailError('payload missing', false);
      const payload = JSON.parse(decodeUtf8(await openCompact(config.appDataKeys, toBytes(row.payload_ciphertext), row.payload_key_version, appDataAad('email-outbox', row.id)))) as {
        to: string; toName: string | null; vars: Record<string, string>; rawHtml: Record<string, string>; invoiceId?: string | null;
      };
      const [tpl] = await sql<{ subject: string; html_body: string; text_body: string; mailersend_template_id: string | null }[]>`
        SELECT subject, html_body, text_body, mailersend_template_id FROM email_templates WHERE template_key = ${row.template_key} AND locale = 'en' AND status = 'active'`;
      if (!tpl) throw new MailError(`template ${row.template_key} missing or disabled`, false);
      const vars = { supportEmail: config.supportEmail, portalUrl: new URL('/portal', config.publicBaseUrl).toString(), ...payload.vars };
      let attachments: OutgoingMail['attachments'];
      if (payload.invoiceId) {
        const inv = await getInvoice(sql, payload.invoiceId);
        attachments = [{ filename: `${invoiceNumber(config, inv.number, inv.livemode)}.pdf`, content: base64Encode(renderInvoicePdf(config, inv)) }];
      }
      const result = await transport.send({
        attachments,
        from: config.mailFrom,
        to: { email: payload.to, name: payload.toName },
        subject: renderTemplate(tpl.subject, vars, {}, false),
        html: renderTemplate(tpl.html_body, vars, payload.rawHtml, true),
        text: renderTemplate(tpl.text_body, vars, payload.rawHtml, false),
        templateId: tpl.mailersend_template_id,
        personalization: vars,
        tags: [row.template_key],
        idempotencyKey: row.id,
      });
      await sql`UPDATE email_outbox SET status = 'sent', sent_at = now(), provider_message_id = ${result.messageId}, payload_ciphertext = NULL,
                last_error = NULL, locked_until = NULL WHERE id = ${row.id}`;
      stats.sent++;
    } catch (e) {
      const err = e instanceof MailError ? e : new MailError(String((e as Error)?.message ?? e), true);
      if (err.uncertain) {
        // The provider may have accepted the message (timeout after send). Do not resend
        // automatically: that could duplicate mail. Operators reconcile from the admin UI.
        await sql`UPDATE email_outbox SET status = 'uncertain', last_error = ${err.message.slice(0, 1000)}, locked_until = NULL WHERE id = ${row.id}`;
        stats.failed++;
      } else if (!err.retryable || row.attempts >= MAX_ATTEMPTS) {
        await sql`UPDATE email_outbox SET status = 'dead', last_error = ${err.message.slice(0, 1000)}, locked_until = NULL WHERE id = ${row.id}`;
        stats.dead++;
      } else {
        const delay = err.retryAfterSeconds ?? backoffSeconds(row.attempts);
        await sql`UPDATE email_outbox SET status = 'failed', last_error = ${err.message.slice(0, 1000)}, locked_until = NULL,
                  next_attempt_at = now() + make_interval(secs => ${delay}) WHERE id = ${row.id}`;
        stats.failed++;
      }
    }
  }
  return stats;
}

export async function retryEmail(sql: Sql, actor: Actor, id: string) {
  requirePermission(actor, 'email:retry');
  const r = await sql<{ status: string; payload: boolean }[]>`SELECT status, payload_ciphertext IS NOT NULL AS payload FROM email_outbox WHERE id = ${id}`;
  if (!r[0]) throw notFound('Email');
  if (!['dead', 'failed', 'uncertain'].includes(r[0].status)) throw invalid(`Email is ${r[0].status}; only failed, dead or uncertain emails can be retried`);
  if (!r[0].payload) throw invalid('Email payload has been purged; it cannot be resent');
  await sql`UPDATE email_outbox SET status = 'pending', next_attempt_at = now(), attempts = 0, last_error = NULL WHERE id = ${id}`;
  await audit(sql, actor, { action: 'email.retried', resourceType: 'email', resourceId: id, detail: { previousStatus: r[0].status } });
  return { id, status: 'pending' };
}

export async function markEmailResolved(sql: Sql, actor: Actor, id: string, outcome: 'sent' | 'dead') {
  requirePermission(actor, 'email:retry');
  const r = await sql`UPDATE email_outbox SET status = ${outcome}, payload_ciphertext = NULL WHERE id = ${id} AND status = 'uncertain' RETURNING id`;
  if (!r.length) throw notFound('Uncertain email');
  await audit(sql, actor, { action: 'email.resolved', resourceType: 'email', resourceId: id, detail: { outcome } });
  return { id, status: outcome };
}

export async function listEmails(db: Db, opts: { status?: string; limit?: number }) {
  return db<{ id: string; business_key: string; template_key: string; category: string; status: string; attempts: number; next_attempt_at: Date; last_error: string | null; provider_message_id: string | null; created_at: Date; sent_at: Date | null; delivered_at: Date | null }[]>`
    SELECT id, business_key, template_key, category, status, attempts, next_attempt_at, last_error, provider_message_id, created_at, sent_at, delivered_at
    FROM email_outbox WHERE (${opts.status ?? null}::text IS NULL OR status = ${opts.status ?? null}) ORDER BY created_at DESC LIMIT ${Math.min(opts.limit ?? 50, 500)}`;
}

export async function listTemplates(db: Db) {
  return db<{ id: string; template_key: string; locale: string; category: string; subject: string; html_body: string; text_body: string; mailersend_template_id: string | null; status: string; updated_at: Date }[]>`
    SELECT * FROM email_templates ORDER BY template_key, locale`;
}

export async function updateTemplate(sql: Sql, actor: Actor, id: string, input: { subject?: string; htmlBody?: string; textBody?: string; mailersendTemplateId?: string | null; status?: 'active' | 'disabled' }) {
  requirePermission(actor, 'email:templates');
  const r = await sql`UPDATE email_templates SET subject = coalesce(${input.subject ?? null}, subject), html_body = coalesce(${input.htmlBody ?? null}, html_body),
            text_body = coalesce(${input.textBody ?? null}, text_body),
            mailersend_template_id = CASE WHEN ${input.mailersendTemplateId !== undefined} THEN ${input.mailersendTemplateId ?? null} ELSE mailersend_template_id END,
            status = coalesce(${input.status ?? null}, status), updated_by = ${actor.label}, updated_at = now() WHERE id = ${id} RETURNING id`;
  if (!r.length) throw notFound('Template');
  await audit(sql, actor, { action: 'email_template.updated', resourceType: 'email_template', resourceId: id, detail: { fields: Object.keys(input) } });
}
