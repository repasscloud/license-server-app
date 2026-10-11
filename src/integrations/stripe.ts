// Minimal Stripe REST adapter for Workers (fetch + Web Crypto). Pinned API version, form
// encoding, idempotency keys on every POST, bounded timeouts, and webhook signature
// verification. Only the endpoints this application needs are used.

import { encodeUtf8, hexDecode, timingSafeEqual } from '../lib/encoding.ts';

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly code?: string,
    readonly type?: string,
  ) {
    super(message);
  }
}

type Param = string | number | boolean | null | undefined | Param[] | { [k: string]: Param };

export function formEncode(params: Record<string, Param>, prefix = ''): string {
  const out: string[] = [];
  const walk = (v: Param, key: string) => {
    if (v === undefined) return;
    if (v === null) {
      out.push(`${encodeURIComponent(key)}=`);
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${key}[${i}]`));
    } else if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) walk(x, `${key}[${k}]`);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(v, prefix ? `${prefix}[${k}]` : k);
  return out.join('&');
}

export interface StripeClientOptions {
  secretKey: string;
  apiVersion: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class StripeClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: StripeClientOptions) {
    this.base = opts.baseUrl ?? 'https://api.stripe.com';
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  get livemode(): boolean {
    return this.opts.secretKey.startsWith('sk_live_') || this.opts.secretKey.startsWith('rk_live_');
  }

  async request<T = Record<string, unknown>>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, Param> = {}, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.secretKey}`,
      'Stripe-Version': this.opts.apiVersion,
    };
    let url = `${this.base}${path}`;
    let body: string | undefined;
    const encoded = formEncode(params);
    if (method === 'GET') {
      if (encoded) url += `?${encoded}`;
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = encoded;
      if (method === 'POST') {
        if (!idempotencyKey) throw new Error('Stripe POST requires an idempotency key');
        headers['Idempotency-Key'] = idempotencyKey;
      }
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000) });
    } catch (e) {
      // Network errors and timeouts are retryable: every POST carries an idempotency key, so a
      // retry after an unknown outcome returns the original result instead of duplicating.
      throw new StripeError(`Stripe network error: ${(e as Error)?.name ?? ''} ${(e as Error)?.message ?? e}`, 0, true);
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new StripeError(`Stripe returned non-JSON (${res.status})`, res.status, res.status >= 500);
    }
    if (!res.ok) {
      const err = (json.error ?? {}) as { message?: string; code?: string; type?: string };
      const retryable = res.status === 429 || res.status >= 500 || res.status === 409; // 409: idempotency key in use concurrently
      throw new StripeError(`Stripe ${res.status}: ${err.message ?? 'error'}`, res.status, retryable, err.code, err.type);
    }
    return json as T;
  }
}

export interface VerifiedStripeEvent {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  api_version: string | null;
  data: { object: Record<string, unknown> & { id?: string } };
}

export class WebhookSignatureError extends Error {}

/**
 * Verify `Stripe-Signature: t=<ts>,v1=<hex>[,v1=...]` = HMAC-SHA256(secret, `${t}.${rawBody}`),
 * constant-time, with a replay window. Must run on the untouched raw body before parsing.
 */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = 300): Promise<VerifiedStripeEvent> {
  if (!header) throw new WebhookSignatureError('missing Stripe-Signature');
  let t: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2);
    if (k === 't' && v && /^\d+$/.test(v)) t = Number(v);
    else if (k === 'v1' && v && /^[0-9a-f]{64}$/.test(v)) v1.push(v);
  }
  if (t === null || v1.length === 0) throw new WebhookSignatureError('malformed Stripe-Signature');
  if (Math.abs(nowSeconds - t) > toleranceSeconds) throw new WebhookSignatureError('timestamp outside tolerance');
  const key = await crypto.subtle.importKey('raw', encodeUtf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encodeUtf8(`${t}.${rawBody}`)));
  if (!v1.some((s) => timingSafeEqual(mac, hexDecode(s)))) throw new WebhookSignatureError('signature mismatch');
  let ev: VerifiedStripeEvent;
  try {
    ev = JSON.parse(rawBody);
  } catch {
    throw new WebhookSignatureError('invalid JSON');
  }
  if (typeof ev?.id !== 'string' || typeof ev?.type !== 'string' || typeof ev?.data?.object !== 'object') throw new WebhookSignatureError('not a Stripe event');
  return ev;
}

/** Test/tooling helper: produce a valid signature header for a payload. */
export async function signStripePayload(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encodeUtf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encodeUtf8(`${t}.${rawBody}`)));
  return `t=${t},v1=${[...mac].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
