// TEST DOUBLES for Stripe and MailerSend. They implement only the endpoints this server calls,
// with the request/response shapes of the pinned Stripe API version (2026-09-30.endive) and the
// MailerSend v1 email API. They exist so the full commerce flow can be exercised without real
// accounts; they are NOT evidence that the real providers accept these requests (see
// docs/STATUS.md for what still needs a live test-mode run).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signStripePayload } from '../../src/integrations/stripe.ts';

export function parseForm(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of body.split('&').filter(Boolean)) {
    const [rawK, rawV = ''] = pair.split('=');
    const key = decodeURIComponent(rawK!);
    const value = decodeURIComponent(rawV.replace(/\+/g, ' '));
    const parts = key.replace(/\]/g, '').split('[');
    let cur: Record<string, unknown> = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) cur[p] = value;
      else cur = (cur[p] ??= /^\d+$/.test(parts[i + 1]!) ? {} : {}) as Record<string, unknown>;
    });
  }
  return out;
}

function listify(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) return keys.sort((a, b) => Number(a) - Number(b)).map((k) => listify((v as Record<string, unknown>)[k]));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, listify(x)]));
  }
  return v;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

let seq = 0;
const sid = (p: string) => `${p}_${Date.now().toString(36)}${(++seq).toString(36)}fake`;

export interface RecordedRequest {
  method: string;
  path: string;
  params: Record<string, unknown>;
  idempotencyKey: string | null;
  stripeVersion: string | null;
}

export class FakeStripe {
  server!: Server;
  url = '';
  requests: RecordedRequest[] = [];
  products = new Map<string, Record<string, unknown>>();
  prices = new Map<string, Record<string, unknown>>();
  sessions = new Map<string, Record<string, any>>();
  customers = new Map<string, Record<string, any>>();
  taxRates = new Map<string, Record<string, any>>();
  subscriptions = new Map<string, Record<string, any>>();
  invoices = new Map<string, Record<string, any>>();
  charges = new Map<string, Record<string, any>>();
  disputes = new Map<string, Record<string, any>>();
  idem = new Map<string, unknown>();
  failures: Array<{ match: RegExp; status: number; times: number }> = [];

  readonly webhookSecret: string;
  readonly apiVersion: string;
  constructor(webhookSecret: string, apiVersion = '2026-09-30.endive') {
    this.webhookSecret = webhookSecret;
    this.apiVersion = apiVersion;
  }

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  failNext(match: RegExp, status: number, times = 1) {
    this.failures.push({ match, status, times });
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url!, this.url);
    const body = await readBody(req);
    const params = listify(parseForm(req.method === 'GET' ? u.search.slice(1) : body)) as Record<string, any>;
    const key = (req.headers['idempotency-key'] as string) ?? null;
    this.requests.push({ method: req.method!, path: u.pathname, params, idempotencyKey: key, stripeVersion: (req.headers['stripe-version'] as string) ?? null });
    if (req.headers.authorization !== 'Bearer sk_test_fake') return this.send(res, 401, { error: { type: 'invalid_request_error', message: 'Invalid API Key' } });
    const f = this.failures.find((x) => x.times > 0 && x.match.test(`${req.method} ${u.pathname}`));
    if (f) {
      f.times--;
      return this.send(res, f.status, { error: { type: 'api_error', message: 'injected failure' } });
    }
    if (req.method === 'POST' && key && this.idem.has(`${u.pathname}|${key}`)) return this.send(res, 200, this.idem.get(`${u.pathname}|${key}`));
    const result = this.route(req.method!, u.pathname, params);
    if (!result) return this.send(res, 404, { error: { type: 'invalid_request_error', message: `No such route ${req.method} ${u.pathname}` } });
    if (req.method === 'POST' && key) this.idem.set(`${u.pathname}|${key}`, result);
    return this.send(res, 200, result);
  }

  private route(method: string, path: string, p: Record<string, any>): unknown {
    let m: RegExpMatchArray | null;
    if (method === 'POST' && path === '/v1/products') {
      const id = sid('prod');
      const o = { id, object: 'product', name: p.name, active: p.active !== 'false', metadata: p.metadata ?? {} };
      this.products.set(id, o);
      return o;
    }
    if (method === 'POST' && (m = path.match(/^\/v1\/products\/([^/]+)$/))) {
      const o = this.products.get(m[1]!);
      if (!o) return null;
      Object.assign(o, { name: p.name ?? o.name, description: p.description ?? o.description, active: p.active === undefined ? o.active : p.active !== 'false',
        metadata: { ...(o.metadata as Record<string, string>), ...(p.metadata ?? {}) } });
      return o;
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/products\/([^/]+)$/))) return this.products.get(m[1]!) ?? null;
    if (method === 'POST' && path === '/v1/prices') {
      const id = sid('price');
      const o = { id, object: 'price', active: true, currency: p.currency, unit_amount: Number(p.unit_amount), product: p.product, tax_behavior: p.tax_behavior ?? 'unspecified',
        recurring: p.recurring ? { interval: p.recurring.interval, interval_count: Number(p.recurring.interval_count ?? 1) } : null, metadata: p.metadata ?? {} };
      this.prices.set(id, o);
      return o;
    }
    if ((m = path.match(/^\/v1\/prices\/([^/]+)$/))) {
      const o = this.prices.get(m[1]!);
      if (!o) return null;
      if (method === 'POST' && p.active !== undefined) o.active = p.active === 'true';
      return o;
    }
    if (method === 'GET' && path === '/v1/customers') {
      return { object: 'list', data: [...this.customers.values()].filter((c) => !p.email || c.email === p.email).sort((a, b) => b.created - a.created) };
    }
    if (method === 'POST' && path === '/v1/customers') {
      const id = sid('cus');
      const o = { id, object: 'customer', email: p.email ?? null, name: p.name ?? null, address: p.address ?? null, metadata: p.metadata ?? {}, created: Math.floor(Date.now() / 1000) + this.customers.size };
      this.customers.set(id, o);
      return o;
    }
    if (method === 'POST' && path === '/v1/tax_rates') {
      const id = sid('txr');
      const o = { id, object: 'tax_rate', display_name: p.display_name, percentage: Number(p.percentage), inclusive: p.inclusive === 'true', active: true, metadata: p.metadata ?? {} };
      this.taxRates.set(id, o);
      return o;
    }
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      const id = sid('cs_test');
      const li = (p.line_items as Array<{ price?: string; price_data?: Record<string, any>; quantity: string; tax_rates?: string[] }>)[0]!;
      let price = li.price ? (this.prices.get(li.price) as Record<string, any> | undefined) : undefined;
      if (li.price_data) {
        // Inline price (Checkout creates a one-off Price object for the session).
        const d = li.price_data;
        if (!this.products.has(d.product)) return null;
        const pid = sid('price');
        price = { id: pid, object: 'price', active: false, currency: d.currency, unit_amount: Number(d.unit_amount), product: d.product, tax_behavior: d.tax_behavior ?? 'unspecified',
          recurring: d.recurring ? { interval: d.recurring.interval, interval_count: Number(d.recurring.interval_count ?? 1) } : null, metadata: {} };
        this.prices.set(pid, price);
      }
      if (!price) return null;
      if (p.customer && !this.customers.has(p.customer)) return null;
      const currency = p.currency ?? price.currency;
      const unit = currency === price.currency ? price.unit_amount : price.currency_options?.[currency]?.unit_amount;
      if (unit === undefined) return null;
      const qty = Number(li.quantity);
      const rate = li.tax_rates?.[0] ? this.taxRates.get(li.tax_rates[0]) : undefined;
      if (li.tax_rates?.[0] && !rate) return null;
      const subtotal = unit * qty;
      const tax = rate && !rate.inclusive ? Math.round((subtotal * rate.percentage) / 100) : 0;
      const o = {
        id, object: 'checkout.session', url: `https://checkout.stripe.com/c/pay/${id}`, status: 'open', payment_status: 'unpaid', mode: p.mode,
        client_reference_id: p.client_reference_id, metadata: p.metadata ?? {}, customer: p.customer ?? null,
        customer_email: p.customer ? this.customers.get(p.customer)!.email : p.customer_email ?? null,
        customer_details: null, currency, amount_subtotal: subtotal, amount_total: subtotal + tax,
        total_details: { amount_discount: 0, amount_tax: tax }, payment_intent: null, subscription: null, invoice: null,
        _line_items: [{ price: { id: price.id, unit_amount: unit, currency, product: price.product, recurring: price.recurring }, quantity: qty }], _params: p,
      };
      this.sessions.set(id, o);
      return o;
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/))) {
      const s = this.sessions.get(m[1]!);
      if (!s) return null;
      const { _line_items, _params, ...pub } = s;
      void _params;
      return { ...pub, line_items: { data: _line_items }, subscription: s.subscription ? this.subscriptions.get(s.subscription) ?? s.subscription : null };
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/subscriptions\/([^/]+)$/))) return this.subscriptions.get(m[1]!) ?? null;
    if (method === 'GET' && (m = path.match(/^\/v1\/invoices\/([^/]+)$/))) return this.invoices.get(m[1]!) ?? null;
    if (method === 'GET' && path === '/v1/invoices') return { object: 'list', data: [...this.invoices.values()].filter((i) => i.parent?.subscription_details?.subscription === p.subscription && (!p.status || i.status === p.status)) };
    if (method === 'GET' && (m = path.match(/^\/v1\/charges\/([^/]+)$/))) return this.charges.get(m[1]!) ?? null;
    if (method === 'GET' && (m = path.match(/^\/v1\/disputes\/([^/]+)$/))) return this.disputes.get(m[1]!) ?? null;
    if (method === 'GET' && path === '/v1/invoice_payments') {
      const pi = p.payment?.payment_intent;
      const inv = [...this.invoices.values()].find((i) => i._payment_intent === pi);
      return { object: 'list', data: inv ? [{ invoice: inv.id }] : [] };
    }
    if (method === 'POST' && path === '/v1/billing_portal/sessions') return { id: sid('bps'), url: `https://billing.stripe.com/p/session/${p.customer}` };
    if (method === 'GET' && path === '/v1/events') return { object: 'list', data: [] };
    return null;
  }

  /** A Product the owner created in Stripe (dashboard or catalogue script), with its image. */
  createProductDirect(name: string, opts: { active?: boolean; description?: string } = {}): string {
    const id = sid('prod');
    this.products.set(id, { id, object: 'product', name, description: opts.description ?? `${name} description`, active: opts.active ?? true,
      images: [`https://img.example.test/${id}.png`], metadata: {} });
    return id;
  }

  /** A Price the owner created directly in Stripe (optionally multi-currency). */
  createPriceDirect(o: { product?: string; currency: string; unitAmount: number; recurring?: { interval: string; interval_count?: number } | null; currencyOptions?: Record<string, number> }) {
    const product = o.product ?? sid('prod');
    if (!this.products.has(product)) this.products.set(product, { id: product, object: 'product', name: 'Made in Stripe', active: true, metadata: {} });
    const id = sid('price');
    this.prices.set(id, { id, object: 'price', active: true, currency: o.currency, unit_amount: o.unitAmount, product, tax_behavior: 'unspecified',
      recurring: o.recurring ? { interval: o.recurring.interval, interval_count: o.recurring.interval_count ?? 1 } : null, metadata: {},
      currency_options: o.currencyOptions ? Object.fromEntries(Object.entries(o.currencyOptions).map(([c, a]) => [c, { unit_amount: a, tax_behavior: 'unspecified' }])) : undefined });
    return { id, product };
  }

  // --- simulation helpers (what Stripe would do after the customer pays) -----------------------

  completeSession(id: string, opts: { paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required'; name?: string; businessName?: string | null; email?: string; periodDays?: number } = {}) {
    const s = this.sessions.get(id)!;
    const customer = s.customer ?? sid('cus');
    if (!this.customers.has(customer)) this.customers.set(customer, { id: customer, object: 'customer', email: opts.email ?? s.customer_email, created: Math.floor(Date.now() / 1000) });
    s.customer = customer;
    s.status = 'complete';
    s.payment_status = opts.paymentStatus ?? (s.amount_total === 0 ? 'no_payment_required' : 'paid');
    s.customer_details = { email: opts.email ?? s.customer_email, name: opts.name ?? 'Jane Citizen', business_name: opts.businessName ?? null, address: { country: 'AU' }, tax_ids: [] };
    if (s.mode === 'payment' && s.amount_total > 0) {
      s.payment_intent = sid('pi');
      this.charges.set(`ch_for_${s.payment_intent}`, { id: `ch_for_${s.payment_intent}`, payment_intent: s.payment_intent, amount: s.amount_total, amount_refunded: 0, refunded: false });
    }
    if (s.mode === 'subscription') {
      const now = Math.floor(Date.now() / 1000);
      const end = now + (opts.periodDays ?? 365) * 86400;
      const subId = sid('sub');
      this.subscriptions.set(subId, {
        id: subId, object: 'subscription', status: 'active', customer, cancel_at_period_end: false, canceled_at: null, ended_at: null, trial_end: null,
        metadata: s._params.subscription_data?.metadata ?? {}, items: { data: [{ quantity: s._line_items[0].quantity, current_period_start: now, current_period_end: end, price: { id: s._line_items[0].price.id } }] },
      });
      s.subscription = subId;
      const inv = this.addInvoice(subId, now, end, s.amount_total, 'paid', 'subscription_create');
      s.invoice = inv.id;
    }
    return s;
  }

  addInvoice(subId: string, start: number, end: number, amount: number, status = 'paid', billingReason = 'subscription_cycle') {
    const id = sid('in');
    const pi = sid('pi');
    const inv = { id, object: 'invoice', livemode: false, status, billing_reason: billingReason, currency: 'aud', subtotal: amount, total: amount, total_discount_amounts: [], customer: this.subscriptions.get(subId)?.customer, amount_due: amount, amount_paid: status === 'paid' ? amount : 0,
      total_taxes: [], hosted_invoice_url: `https://invoice.stripe.com/i/${id}`, parent: { subscription_details: { subscription: subId } }, status_transitions: { paid_at: status === 'paid' ? start : null },
      lines: { data: [{ period: { start, end }, description: '1 × renewal', quantity: 1, amount }] }, attempt_count: 1, _payment_intent: pi };
    this.invoices.set(id, inv);
    this.charges.set(`ch_for_${pi}`, { id: `ch_for_${pi}`, payment_intent: pi, amount, amount_refunded: 0, refunded: false });
    return inv;
  }

  renewSubscription(subId: string, days = 365) {
    const sub = this.subscriptions.get(subId)!;
    const item = sub.items.data[0];
    const start = item.current_period_end;
    item.current_period_start = start;
    item.current_period_end = start + days * 86400;
    return this.addInvoice(subId, start, item.current_period_end, 1000);
  }

  async event(type: string, object: Record<string, unknown>, opts: { livemode?: boolean; id?: string } = {}) {
    const ev = { id: opts.id ?? sid('evt'), object: 'event', type, created: Math.floor(Date.now() / 1000), livemode: opts.livemode ?? false, api_version: this.apiVersion, data: { object } };
    const body = JSON.stringify(ev);
    return { id: ev.id, body, signature: await signStripePayload(body, this.webhookSecret) };
  }

  publicSession(id: string) {
    const { _line_items, _params, ...pub } = this.sessions.get(id)!;
    void _line_items;
    void _params;
    return pub;
  }
}

export class FakeMailerSend {
  server!: Server;
  url = '';
  sent: Array<Record<string, any>> = [];
  queue: Array<{ status: number; retryAfter?: number }> = [];

  async start() {
    this.server = createServer(async (req, res) => {
      const body = await readBody(req);
      if (req.headers.authorization !== 'Bearer mlsn.test') {
        res.writeHead(401);
        return res.end('{"message":"Unauthenticated."}');
      }
      const next = this.queue.shift();
      if (next) {
        res.writeHead(next.status, next.retryAfter ? { 'Retry-After': String(next.retryAfter) } : {});
        return res.end('{"message":"injected"}');
      }
      const msg = JSON.parse(body);
      this.sent.push(msg);
      res.writeHead(202, { 'x-message-id': `ms_${this.sent.length}_${Date.now()}` });
      res.end();
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}
