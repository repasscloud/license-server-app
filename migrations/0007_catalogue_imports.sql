-- Catalogue CSV imports (upload -> preview -> confirmed apply) and catalogue name uniqueness.
--
-- Names are unique case-insensitively among offers that are not archived and products that are
-- not retired: an import (or an administrator) can never create two sellable things with the
-- same name. Names are not identities: offers are identified by SKU, products by slug, and
-- Stripe products by their prod_ id (stripe_product_mappings.stripe_product_id is UNIQUE).

DO $$
DECLARE dups text;
BEGIN
  SELECT string_agg(format('"%s" (%s)', n, skus), '; ') INTO dups FROM (
    SELECT lower(name) AS n, string_agg(sku, ', ' ORDER BY sku) AS skus FROM offers WHERE status <> 'archived'
    GROUP BY lower(name) HAVING count(*) > 1) d;
  IF dups IS NOT NULL THEN
    RAISE EXCEPTION 'Offers share a name (case-insensitive): %. Rename or archive the duplicates, then re-run the migration.', dups;
  END IF;
  SELECT string_agg(format('"%s" (%s)', n, slugs), '; ') INTO dups FROM (
    SELECT lower(name) AS n, string_agg(slug, ', ' ORDER BY slug) AS slugs FROM products WHERE status <> 'retired'
    GROUP BY lower(name) HAVING count(*) > 1) d;
  IF dups IS NOT NULL THEN
    RAISE EXCEPTION 'Products share a name (case-insensitive): %. Rename or retire the duplicates, then re-run the migration.', dups;
  END IF;
END $$;

CREATE UNIQUE INDEX offers_name_unique ON offers (lower(name)) WHERE status <> 'archived';
CREATE UNIQUE INDEX products_name_unique ON products (lower(name)) WHERE status <> 'retired';

-- One row per uploaded CSV. The preview (plan) is computed without writing to the catalogue or
-- Stripe; apply recomputes it and refuses if anything changed since the administrator reviewed
-- it (plan_fingerprint). The CSV holds catalogue data only (no credentials).
CREATE TABLE catalogue_imports (
  id               text PRIMARY KEY,                                    -- imp_…
  status           text NOT NULL DEFAULT 'previewed'
                     CHECK (status IN ('previewed', 'applying', 'applied', 'failed')),
  file_name        text CHECK (file_name IS NULL OR length(file_name) <= 255),
  csv_sha256       text NOT NULL CHECK (csv_sha256 ~ '^[0-9a-f]{64}$'),
  csv_text         text NOT NULL CHECK (octet_length(csv_text) <= 1048576),
  stripe_mode      text NOT NULL CHECK (stripe_mode IN ('test', 'live')),
  plan             jsonb NOT NULL,
  plan_fingerprint text NOT NULL,
  summary          jsonb NOT NULL,
  result           jsonb,
  created_by_type  text NOT NULL,
  created_by_id    text,
  created_by_label text NOT NULL,
  applied_by_type  text,
  applied_by_id    text,
  applied_by_label text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  apply_started_at timestamptz,
  applied_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX catalogue_imports_created ON catalogue_imports (created_at DESC);
-- At most one import applies at a time (a stale claim is taken over after 10 minutes).
CREATE UNIQUE INDEX catalogue_imports_one_applying ON catalogue_imports ((true)) WHERE status = 'applying';
CREATE TRIGGER catalogue_imports_touch BEFORE UPDATE ON catalogue_imports FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
