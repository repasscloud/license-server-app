-- Paid invoices issued by the licence server (owner request 2026-10-12), modelled on the
-- how-to-use-ai.com store: a numbered "Paid" invoice for every successful purchase and renewal,
-- emailed as a PDF and downloadable from the portal. The snapshot is immutable; the PDF is
-- rendered from it on demand, so a document can always be reproduced exactly.

CREATE SEQUENCE customer_invoice_number_seq;

CREATE TABLE customer_invoices (
  id                 text PRIMARY KEY,                    -- cin_…
  number             bigint NOT NULL UNIQUE DEFAULT nextval('customer_invoice_number_seq'),
  livemode           boolean NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('purchase', 'renewal')),
  customer_id        text NOT NULL REFERENCES customers(id),
  purchase_id        text UNIQUE REFERENCES purchases(id),
  stripe_invoice_id  text UNIQUE,                         -- renewals: the Stripe invoice paid
  currency           currency_code NOT NULL,
  subtotal           bigint NOT NULL CHECK (subtotal >= 0),
  discount           bigint NOT NULL DEFAULT 0 CHECK (discount >= 0),
  tax                bigint NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total              bigint NOT NULL CHECK (total >= 0),
  -- Seller, buyer, lines, tax label/rate and payment reference exactly as issued.
  snapshot           jsonb NOT NULL,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (purchase_id IS NOT NULL OR stripe_invoice_id IS NOT NULL)
);
CREATE INDEX customer_invoices_customer ON customer_invoices (customer_id, issued_at DESC);
CREATE TRIGGER customer_invoices_append_only BEFORE UPDATE OR DELETE ON customer_invoices
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Purchase email mentions the attached invoice.
UPDATE email_templates
   SET html_body = replace(html_body, '<p>Download licence files', '{{{invoiceHtml}}}<p>Download licence files'),
       text_body = replace(text_body, E'\n\nCustomer portal:', E'\n\n{{invoiceText}}Customer portal:')
 WHERE template_key = 'purchase_confirmation' AND html_body NOT LIKE '%invoiceHtml%';

-- Renewal receipt with the paid invoice attached.
INSERT INTO email_templates (id, template_key, locale, category, subject, html_body, text_body) VALUES
('etp_payment_receipt', 'payment_receipt', 'en', 'transactional',
 'Receipt {{invoiceNumber}}: {{productSummary}}',
 '<p>Hello {{customerName}},</p><p>Thank you. We received your payment of <strong>{{amount}}</strong> for {{productSummary}}.</p><p>Your paid invoice <strong>{{invoiceNumber}}</strong> is attached, and is also available in the <a href="{{portalUrl}}">customer portal</a>.</p><p>Support: <a href="mailto:{{supportEmail}}">{{supportEmail}}</a></p>',
 E'Hello {{customerName}},\n\nThank you. We received your payment of {{amount}} for {{productSummary}}.\n\nYour paid invoice {{invoiceNumber}} is attached, and is also available in the customer portal: {{portalUrl}}\n\nSupport: {{supportEmail}}\n')
ON CONFLICT DO NOTHING;
