// Mail transports. MailerSend is the only production provider (HTTPS API, scoped token in
// Workers Secrets). The capture transport exists for local development only: it records the
// message in memory and logs that it was CAPTURED, never delivered; config refuses it in
// staging/production.

export class MailError extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  /** The provider may have accepted the message (e.g. timeout after sending). */
  readonly uncertain: boolean;
  constructor(message: string, retryable: boolean, retryAfterSeconds?: number, uncertain = false) {
    super(message);
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    this.uncertain = uncertain;
  }
}

export interface OutgoingMail {
  from: { email: string; name: string };
  to: { email: string; name: string | null };
  subject: string;
  html: string;
  text: string;
  templateId: string | null;
  personalization: Record<string, string>;
  tags: string[];
  /** Our outbox id; MailerSend has no idempotency header, so this is for correlation only. */
  idempotencyKey: string;
  /** Base64 file attachments (e.g. the paid invoice PDF). */
  attachments?: Array<{ filename: string; content: string }>;
}

export interface MailTransport {
  readonly kind: string;
  send(m: OutgoingMail): Promise<{ messageId: string }>;
}

export class MailerSendTransport implements MailTransport {
  readonly kind = 'mailersend';
  private readonly token: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(token: string, base = 'https://api.mailersend.com', fetchImpl: typeof fetch = (...a) => fetch(...a)) {
    this.token = token;
    this.base = base;
    this.fetchImpl = fetchImpl;
  }

  async send(m: OutgoingMail): Promise<{ messageId: string }> {
    const body: Record<string, unknown> = {
      from: { email: m.from.email, name: m.from.name },
      to: [{ email: m.to.email, ...(m.to.name ? { name: m.to.name } : {}) }],
      tags: m.tags.slice(0, 5),
      settings: { track_clicks: false, track_opens: false, track_content: false },
    };
    if (m.attachments?.length) body.attachments = m.attachments.map((a) => ({ filename: a.filename, content: a.content, disposition: 'attachment' }));
    if (m.templateId) {
      body.template_id = m.templateId;
      body.subject = m.subject;
      body.personalization = [{ email: m.to.email, data: m.personalization }];
    } else {
      body.subject = m.subject;
      body.html = m.html;
      body.text = m.text;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/v1/email`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      const name = (e as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new MailError('MailerSend request timed out; delivery state unknown', false, undefined, true);
      throw new MailError(`MailerSend network error: ${(e as Error)?.message ?? e}`, true);
    }
    if (res.status === 202) {
      const id = res.headers.get('x-message-id');
      if (!id) throw new MailError('MailerSend accepted the request but sent nothing (all recipients suppressed)', false);
      return { messageId: id };
    }
    const text = (await res.text().catch(() => '')).slice(0, 500);
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      throw new MailError(`MailerSend rate limited (429)`, true, Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) : 60);
    }
    if (res.status >= 500) throw new MailError(`MailerSend ${res.status}: ${text}`, true);
    throw new MailError(`MailerSend rejected the message (${res.status}): ${text}`, false);
  }
}

export interface CapturedMail extends OutgoingMail {
  capturedAt: string;
}

export class CaptureTransport implements MailTransport {
  readonly kind = 'capture';
  static readonly captured: CapturedMail[] = [];
  async send(m: OutgoingMail): Promise<{ messageId: string }> {
    CaptureTransport.captured.push({ ...m, capturedAt: new Date().toISOString() });
    if (CaptureTransport.captured.length > 200) CaptureTransport.captured.shift();
    console.log(`[mail:capture] NOT DELIVERED (development capture) template=${m.tags[0]} subject=${JSON.stringify(m.subject)}${m.attachments?.length ? ` attachments=${m.attachments.map((a) => a.filename).join(',')}` : ''}\n${m.text}`);
    return { messageId: `capture:${m.idempotencyKey}` };
  }
}

export class DisabledTransport implements MailTransport {
  readonly kind = 'disabled';
  async send(): Promise<{ messageId: string }> {
    throw new MailError('Mail transport is disabled in this environment', true, 3600);
  }
}
