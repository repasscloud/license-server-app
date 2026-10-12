// Paid invoices issued by the licence server for every successful purchase and renewal
// (modelled on the how-to-use-ai.com store). The immutable snapshot records seller, buyer,
// lines, discount, tax and payment exactly as issued; the PDF is rendered from it on demand and
// attached to the receipt email. Numbers come from a database sequence (gap-free is not
// promised: a rolled-back purchase may consume a number).

import type { Config } from '../config.ts';
import type { Db, Tx } from '../db/client.ts';
import { notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { money } from '../lib/money.ts';
import { PdfDocument, type Rgb } from '../lib/pdf.ts';

export interface InvoiceAddress { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; postal_code?: string | null; country?: string | null }

export interface InvoiceSnapshot {
  version: 1;
  seller: { name: string; abn: string | null; email: string; website: string };
  buyer: { businessName: string | null; name: string | null; email: string; address: InvoiceAddress | null; taxId: string | null };
  lines: Array<{ description: string; detail: string | null; quantity: number; unitAmount: number; amount: number }>;
  currency: string;
  subtotal: number;
  discount: number;
  tax: number;
  /** e.g. "GST 10%"; null when no tax was charged. */
  taxLabel: string | null;
  total: number;
  paidAt: string;
  paymentReference: string;
  /** What was bought, for the email subject ("CurseDelete 2 Business"). */
  summary: string;
}

export function invoiceNumber(config: Config, number: number, livemode: boolean): string {
  return `${livemode ? '' : 'TEST-'}${config.invoice.prefix}-${String(number).padStart(7, '0')}`;
}

export function sellerFor(config: Config): InvoiceSnapshot['seller'] {
  return { name: config.invoice.sellerName, abn: config.invoice.sellerAbn, email: config.supportEmail, website: config.publicBaseUrl.host };
}

export async function buyerFor(db: Db, customerId: string, address: InvoiceAddress | null, name: string | null): Promise<InvoiceSnapshot['buyer']> {
  const [c] = await db<{ kind: string; display_name: string; organisation_name: string | null; billing_email: string; country: string | null; tax_id: string | null }[]>`
    SELECT kind, display_name, organisation_name, billing_email, country, tax_id FROM customers WHERE id = ${customerId}`;
  if (!c) throw notFound('Customer');
  return {
    businessName: c.organisation_name,
    name: name ?? c.display_name,
    email: c.billing_email,
    address: address && Object.values(address).some(Boolean) ? address : c.country ? { country: c.country } : null,
    taxId: c.tax_id,
  };
}

export async function issueInvoice(tx: Tx, input: {
  kind: 'purchase' | 'renewal'; livemode: boolean; customerId: string; purchaseId?: string | null; stripeInvoiceId?: string | null; snapshot: InvoiceSnapshot;
}): Promise<{ id: string; number: number; created: boolean }> {
  const s = input.snapshot;
  const id = newId('cin');
  const rows = await tx<{ id: string; number: number }[]>`
    INSERT INTO customer_invoices (id, livemode, kind, customer_id, purchase_id, stripe_invoice_id, currency, subtotal, discount, tax, total, snapshot, issued_at)
    VALUES (${id}, ${input.livemode}, ${input.kind}, ${input.customerId}, ${input.purchaseId ?? null}, ${input.stripeInvoiceId ?? null}, ${s.currency},
            ${s.subtotal}, ${s.discount}, ${s.tax}, ${s.total}, ${tx.json(s as never)}, ${new Date(s.paidAt)})
    ON CONFLICT DO NOTHING RETURNING id, number`;
  if (rows[0]) return { ...rows[0], created: true };
  const [existing] = await tx<{ id: string; number: number }[]>`
    SELECT id, number FROM customer_invoices WHERE purchase_id = ${input.purchaseId ?? null} OR stripe_invoice_id = ${input.stripeInvoiceId ?? null}`;
  return { ...existing!, created: false };
}

export interface InvoiceRow { id: string; number: number; livemode: boolean; kind: string; customer_id: string; currency: string; total: number; issued_at: Date; snapshot: InvoiceSnapshot }

export async function getInvoice(db: Db, id: string): Promise<InvoiceRow> {
  const [r] = await db<InvoiceRow[]>`SELECT id, number, livemode, kind, customer_id, currency, total, issued_at, snapshot FROM customer_invoices WHERE id = ${id}`;
  if (!r) throw notFound('Invoice');
  return r;
}

export async function listInvoices(db: Db, customerId: string) {
  return db<Omit<InvoiceRow, 'snapshot'>[]>`
    SELECT id, number, livemode, kind, customer_id, currency, total, issued_at FROM customer_invoices WHERE customer_id = ${customerId} ORDER BY issued_at DESC, number DESC`;
}

// ---------------------------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------------------------

const NAVY: Rgb = [0.025, 0.075, 0.17];
const GREY: Rgb = [0.36, 0.41, 0.48];
const RULE: Rgb = [0.86, 0.89, 0.92];
const PALE: Rgb = [0.95, 0.97, 0.99];
const WHITE: Rgb = [1, 1, 1];
const SKY: Rgb = [0.65, 0.84, 0.96];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// UTC calendar date, formatted by hand: Intl time-zone data costs ~15 ms of CPU on first use in
// an isolate, which the Workers Free 10 ms budget cannot afford.
const date = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} (UTC)`;
};

export function renderInvoicePdf(config: Config, inv: { number: number; livemode: boolean; snapshot: InvoiceSnapshot }): Uint8Array<ArrayBuffer> {
  const s = inv.snapshot;
  const no = invoiceNumber(config, inv.number, inv.livemode);
  const m = (n: number) => money(n, s.currency);
  const doc = new PdfDocument();
  const [W] = PdfDocument.A4;
  const L = 50;
  const R = W - 50;
  const title = s.tax > 0 ? 'Tax Invoice' : 'Invoice';

  // Header band
  doc.rect(0, 716, W, 126, NAVY);
  doc.text('RePassCloud', L, 772, { size: 24, bold: true, color: WHITE });
  doc.text('Licensing', L, 752, { size: 12, color: SKY });
  doc.textRight(title, R, 772, { size: 26, bold: true, color: WHITE });
  doc.textRight('PAID', R, 750, { size: 12, bold: true, color: SKY });
  if (!inv.livemode) doc.textRight('TEST MODE - NOT A REAL TRANSACTION', R, 732, { size: 9, color: SKY });

  doc.text(no, L, 690, { size: 13, bold: true, color: NAVY });
  doc.textRight(`Issued ${date(s.paidAt)}`, R, 690, { color: NAVY });
  doc.line(L, 678, R, 678, RULE);

  // Bill to / From
  const sellerLines = [s.seller.name, s.seller.abn ? `ABN ${s.seller.abn}` : null, s.seller.email, s.seller.website].filter((v): v is string => !!v);
  const a = s.buyer.address;
  const buyerLines = [s.buyer.businessName, s.buyer.name, s.buyer.email, a?.line1, a?.line2, a ? [a.city, a.state, a.postal_code].filter(Boolean).join(' ') : null, a?.country,
    s.buyer.taxId ? `Business ID: ${s.buyer.taxId}` : null].filter((v): v is string => !!v && v.trim() !== '');
  doc.text('Bill to', L, 655, { size: 10, color: GREY });
  doc.textRight('From', R, 655, { size: 10, color: GREY });
  let yb = 637;
  for (const l of buyerLines) for (const w of PdfDocument.wrap(l, 11, 240)) { doc.text(w, L, yb, { color: NAVY }); yb -= 15; }
  let ys = 637;
  for (const l of sellerLines) { doc.textRight(l, R, ys, { color: NAVY }); ys -= 15; }
  let y = Math.min(yb, ys) - 25;

  // Lines
  doc.rect(L, y - 10, R - L, 28, PALE);
  doc.text('Description', L + 10, y, { size: 10, color: GREY });
  doc.textRight('Qty', 360, y, { size: 10, color: GREY });
  doc.textRight('Unit price', 450, y, { size: 10, color: GREY });
  doc.textRight('Amount', R - 10, y, { size: 10, color: GREY });
  y -= 36;
  for (const line of s.lines) {
    if (y < 220) { doc.addPage(); y = 780; }
    const desc = PdfDocument.wrap(line.description, 12, 250, true);
    desc.forEach((d, i) => doc.text(d, L + 10, y - i * 15, { size: 12, bold: true, color: NAVY }));
    doc.textRight(String(line.quantity), 360, y, { color: NAVY });
    doc.textRight(m(line.unitAmount), 450, y, { color: NAVY });
    doc.textRight(m(line.amount), R - 10, y, { color: NAVY });
    y -= desc.length * 15;
    if (line.detail) for (const d of PdfDocument.wrap(line.detail, 10, 260)) { doc.text(d, L + 10, y, { size: 10, color: GREY }); y -= 13; }
    y -= 12;
  }
  doc.line(L, y, R, y, RULE);
  y -= 24;

  // Totals
  const row = (label: string, value: string, bold = false, size = 11) => {
    doc.text(label, 330, y, { size, bold, color: NAVY });
    doc.textRight(value, R - 10, y, { size, bold, color: NAVY });
    y -= size + 11;
  };
  row('Subtotal', m(s.subtotal));
  if (s.discount) row('Discount', `-${m(s.discount)}`);
  if (s.tax) row(s.taxLabel ?? 'Tax', m(s.tax));
  doc.line(330, y + 8, R, y + 8, RULE);
  y -= 6;
  row('Total paid', m(s.total), true, 14);
  doc.text('Balance due', 330, y, { size: 10, color: GREY });
  doc.textRight(m(0), R - 10, y, { size: 10, color: GREY });
  y -= 30;
  if (s.tax) for (const t of PdfDocument.wrap(`Total includes ${s.taxLabel ?? 'tax'} of ${m(s.tax)}.`, 10, R - L)) { doc.text(t, L, y, { size: 10, color: GREY }); y -= 13; }
  for (const t of PdfDocument.wrap(`Paid in full on ${date(s.paidAt)}. Payment reference: ${s.paymentReference}.`, 10, R - L)) { doc.text(t, L, y, { size: 10, color: GREY }); y -= 13; }

  // Footer
  doc.line(L, 104, R, 104, RULE);
  doc.text('Thank you for your purchase.', L, 82, { size: 12, color: NAVY });
  doc.text(`Support: ${s.seller.email}`, L, 62, { size: 10, color: GREY });
  doc.textRight(s.seller.website, R, 62, { size: 10, color: NAVY });
  doc.setInfo(`${no} - ${s.seller.name}`, s.seller.name);
  return doc.save();
}
