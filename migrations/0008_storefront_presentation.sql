-- Presentation and checkout configuration remain PostgreSQL catalogue data.
ALTER TABLE products ADD COLUMN image_url text;
ALTER TABLE offers ADD COLUMN organisation_details text NOT NULL DEFAULT 'auto'
  CHECK (organisation_details IN ('auto', 'required', 'none'));
