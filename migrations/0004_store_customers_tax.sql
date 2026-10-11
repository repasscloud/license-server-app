-- Storefront changes (owner request 2026-10-12):
--  * one email = one customer (database and Stripe);
--  * per-price flat tax rates (e.g. GST 10%) added on top of the price via Stripe Tax Rates,
--    not Stripe Tax;
--  * promotion codes enabled on Checkout by default.

-- One customer per billing email.
DROP INDEX IF EXISTS customers_billing_email;
CREATE UNIQUE INDEX customers_billing_email ON customers (billing_email);

-- Flat tax per price version: basis points (1000 = 10%) and the label shown on invoices.
ALTER TABLE price_versions
  ADD COLUMN tax_rate_bps integer CHECK (tax_rate_bps > 0 AND tax_rate_bps <= 10000),
  ADD COLUMN tax_label    text CHECK (tax_label ~ '^[A-Za-z0-9 .()%/-]{1,50}$'),
  ADD CONSTRAINT price_versions_tax_pair CHECK ((tax_rate_bps IS NULL) = (tax_label IS NULL));

DROP TRIGGER price_versions_immutable ON price_versions;
CREATE TRIGGER price_versions_immutable BEFORE UPDATE ON price_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_column_changes(
    'id', 'offer_id', 'currency', 'unit_amount', 'recurring_interval', 'recurring_interval_count', 'tax_behavior',
    'tax_rate_bps', 'tax_label');

-- Stripe Tax Rate objects (exclusive: added on top of the price). Stripe tax rates are
-- immutable in percentage, so one row per (label, rate).
CREATE TABLE stripe_tax_rates (
  id                 text PRIMARY KEY,                   -- txr_… (ours)
  display_name       text NOT NULL,
  tax_rate_bps       integer NOT NULL CHECK (tax_rate_bps > 0 AND tax_rate_bps <= 10000),
  stripe_tax_rate_id text UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (display_name, tax_rate_bps)
);
CREATE TRIGGER stripe_tax_rates_immutable BEFORE UPDATE ON stripe_tax_rates
  FOR EACH ROW WHEN (OLD.stripe_tax_rate_id IS NOT NULL)
  EXECUTE FUNCTION forbid_column_changes('id', 'display_name', 'tax_rate_bps', 'stripe_tax_rate_id');

-- Promotion codes on by default (existing offers included).
ALTER TABLE offers ALTER COLUMN allow_promotion_codes SET DEFAULT true;
UPDATE offers SET allow_promotion_codes = true WHERE NOT allow_promotion_codes;

-- One Stripe Price may carry several currencies (currency_options), so several price versions
-- (one per currency) may map to the same Stripe price. Uniqueness per (Stripe price, currency)
-- is enforced by createPriceVersion; archiving only touches Stripe when no active version uses it.
ALTER TABLE stripe_price_mappings DROP CONSTRAINT stripe_price_mappings_stripe_price_id_key;
CREATE INDEX stripe_price_mappings_stripe_price ON stripe_price_mappings (stripe_price_id);
