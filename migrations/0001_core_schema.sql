-- RePassCloud licensing platform — core schema.
-- Plain, portable PostgreSQL (>= 15). No Supabase-specific features or extensions.
-- All timestamps are timestamptz (stored UTC). Money is bigint minor units. Never floats.

-- ---------------------------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Raises when any of the listed columns changed. Used to make identifiers and
-- financial/price facts immutable once written.
CREATE FUNCTION forbid_column_changes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  col text;
  old_v text;
  new_v text;
BEGIN
  FOREACH col IN ARRAY TG_ARGV LOOP
    EXECUTE format('SELECT ($1).%I::text, ($2).%I::text', col, col) INTO old_v, new_v USING OLD, NEW;
    IF old_v IS DISTINCT FROM new_v THEN
      RAISE EXCEPTION 'column %.% is immutable', TG_TABLE_NAME, col USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

-- Wire identifier alphabet from the v1 brief: [A-Za-z0-9_.-], 1–128 chars.
CREATE DOMAIN wire_id AS text CHECK (VALUE ~ '^[A-Za-z0-9_.-]{1,128}$');
CREATE DOMAIN currency_code AS text CHECK (VALUE ~ '^[a-z]{3}$');

-- ---------------------------------------------------------------------------------------------
-- Catalogue: protocols, products, majors, releases, editions, policies
-- ---------------------------------------------------------------------------------------------

-- Wire protocols. Rows describe protocols; behaviour exists only for protocol IDs implemented
-- in code (src/domain/protocols.ts). See ADR-0001.
CREATE TABLE license_protocols (
  id               text PRIMARY KEY CHECK (id ~ '^[a-z0-9-]{1,64}$'),
  name             text NOT NULL,
  license_format   text NOT NULL,
  activation_format text,
  schema_version   integer NOT NULL CHECK (schema_version >= 1),
  max_signatures   integer NOT NULL CHECK (max_signatures BETWEEN 1 AND 64),
  description      text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id           text PRIMARY KEY,                        -- internal id prd_…
  slug         wire_id NOT NULL UNIQUE,                 -- wire productId, immutable
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description  text NOT NULL DEFAULT '',
  vendor       text NOT NULL DEFAULT 'RePassCloud',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  visibility   text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  support_url  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER products_immutable BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION forbid_column_changes('id', 'slug');
CREATE TRIGGER products_touch BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE product_majors (
  id                         text PRIMARY KEY,           -- pmj_…
  product_id                 text NOT NULL REFERENCES products(id),
  major_version              integer NOT NULL CHECK (major_version BETWEEN 0 AND 1000000),
  protocol_id                text NOT NULL REFERENCES license_protocols(id),
  status                     text NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft', 'active', 'sales_closed', 'retired')),
  -- Default rolling-365-day transfer allowance for device-seat editions (overridable per
  -- edition policy and per entitlement).
  default_transfer_allowance integer NOT NULL DEFAULT 3 CHECK (default_transfer_allowance >= 0),
  -- Whether purchase email may include the plaintext activation key (ADR-0001 §5).
  activation_key_email       boolean NOT NULL DEFAULT true,
  licence_file_name_template text NOT NULL DEFAULT '{product}-v{major}-{edition}-{licenseId}.license',
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, major_version)
);
CREATE TRIGGER product_majors_immutable BEFORE UPDATE ON product_majors
  FOR EACH ROW EXECUTE FUNCTION forbid_column_changes('id', 'product_id', 'major_version');
CREATE TRIGGER product_majors_touch BEFORE UPDATE ON product_majors FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Application releases that exist (or are planned) for a product major. Key trust is per release.
CREATE TABLE product_releases (
  id               text PRIMARY KEY,                    -- rel_…
  product_major_id text NOT NULL REFERENCES product_majors(id),
  version          text NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$'),
  status           text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'shipped', 'withdrawn')),
  -- The oldest release still supported for this major. Exactly one shipped release may be the
  -- minimum; key eligibility requires that the minimum supported release trusts the key.
  is_minimum_supported boolean NOT NULL DEFAULT false,
  shipped_at       timestamptz,
  notes            text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_major_id, version),
  CHECK (NOT is_minimum_supported OR status = 'shipped')
);
CREATE UNIQUE INDEX product_releases_one_minimum ON product_releases (product_major_id) WHERE is_minimum_supported;

CREATE TABLE edition_definitions (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z0-9_-]{1,64}$'),   -- e.g. community
  wire_id     wire_id NOT NULL UNIQUE,                               -- edition claim value
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Which editions a product major offers, and how each behaves. Pure data; validated in code
-- against the major's protocol.
CREATE TABLE product_edition_policies (
  id                       text PRIMARY KEY,             -- pep_…
  product_major_id         text NOT NULL REFERENCES product_majors(id),
  edition_id               text NOT NULL REFERENCES edition_definitions(id),
  display_name             text NOT NULL,
  activation_model         text NOT NULL CHECK (activation_model IN ('none', 'device_seats')),
  ownership                text NOT NULL DEFAULT 'individual'
                             CHECK (ownership IN ('individual', 'organisation', 'institution')),
  transfer_allowance       integer CHECK (transfer_allowance >= 0),   -- null => major default
  certificate_lifetime_seconds integer CHECK (certificate_lifetime_seconds > 0),  -- null => no cert expiry
  offline_policy           text NOT NULL DEFAULT 'indefinite' CHECK (offline_policy IN ('indefinite', 'periodic_check')),
  status                   text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_major_id, edition_id)
);
CREATE TRIGGER pep_immutable BEFORE UPDATE ON product_edition_policies
  FOR EACH ROW EXECUTE FUNCTION forbid_column_changes('id', 'product_major_id', 'edition_id');
CREATE TRIGGER pep_touch BEFORE UPDATE ON product_edition_policies FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Sellable catalogue: offers (SKUs), components (single or bundle), immutable price versions
-- ---------------------------------------------------------------------------------------------

CREATE TABLE offers (
  id                        text PRIMARY KEY,            -- off_…
  sku                       text NOT NULL UNIQUE CHECK (sku ~ '^[A-Za-z0-9_.-]{1,100}$'),
  name                      text NOT NULL,
  description               text NOT NULL DEFAULT '',
  kind                      text NOT NULL CHECK (kind IN ('single', 'bundle')),
  billing                   text NOT NULL CHECK (billing IN ('one_time', 'recurring', 'free')),
  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  visibility                text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  available_from            timestamptz,
  available_until           timestamptz,
  min_quantity              integer NOT NULL DEFAULT 1 CHECK (min_quantity >= 1),
  max_quantity              integer NOT NULL DEFAULT 1 CHECK (max_quantity >= 1),
  allow_promotion_codes     boolean NOT NULL DEFAULT false,
  automatic_tax             boolean NOT NULL DEFAULT false,
  billing_address_collection text NOT NULL DEFAULT 'auto' CHECK (billing_address_collection IN ('auto', 'required')),
  tax_id_collection         boolean NOT NULL DEFAULT false,
  customer_kind             text NOT NULL DEFAULT 'any' CHECK (customer_kind IN ('any', 'individual', 'organisation')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK (max_quantity >= min_quantity),
  CHECK (available_until IS NULL OR available_from IS NULL OR available_until > available_from)
);
CREATE TRIGGER offers_immutable BEFORE UPDATE ON offers
  FOR EACH ROW EXECUTE FUNCTION forbid_column_changes('id', 'sku', 'kind', 'billing');
CREATE TRIGGER offers_touch BEFORE UPDATE ON offers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Each component yields one entitlement per purchase line. A bundle has several components
-- (one per product); a single offer has exactly one.
CREATE TABLE offer_entitlement_components (
  id                    text PRIMARY KEY,                -- ocp_…
  offer_id              text NOT NULL REFERENCES offers(id),
  edition_policy_id     text NOT NULL REFERENCES product_edition_policies(id),
  position              integer NOT NULL CHECK (position >= 0),
  term_type             text NOT NULL CHECK (term_type IN ('perpetual', 'subscription', 'fixed_term')),
  term_interval         text CHECK (term_interval IN ('day', 'week', 'month', 'year')),
  term_interval_count   integer CHECK (term_interval_count >= 1),
  seats_per_unit        integer CHECK (seats_per_unit >= 1),
  quantity_scales_seats boolean NOT NULL DEFAULT false,
  trial_days            integer CHECK (trial_days BETWEEN 1 AND 730),
  grace_days            integer NOT NULL DEFAULT 0 CHECK (grace_days BETWEEN 0 AND 90),
  transfer_allowance    integer CHECK (transfer_allowance >= 0),   -- null => edition/major default
  refund_action         text NOT NULL DEFAULT 'revoke' CHECK (refund_action IN ('revoke', 'review', 'none')),
  dispute_action        text NOT NULL DEFAULT 'review' CHECK (dispute_action IN ('revoke', 'review', 'none')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (offer_id, position),
  UNIQUE (offer_id, edition_policy_id),
  -- fixed_term carries its own length; subscription length comes from the recurring price;
  -- perpetual has none.
  CHECK (CASE term_type WHEN 'fixed_term' THEN term_interval IS NOT NULL AND term_interval_count IS NOT NULL
                        ELSE term_interval IS NULL AND term_interval_count IS NULL END),
  CHECK (trial_days IS NULL OR term_type = 'subscription'),
  CHECK (NOT quantity_scales_seats OR seats_per_unit IS NOT NULL)
);

-- Immutable price versions. Changing amount/currency/interval creates a NEW row.
CREATE TABLE price_versions (
  id                       text PRIMARY KEY,             -- prc_…
  offer_id                 text NOT NULL REFERENCES offers(id),
  currency                 currency_code NOT NULL,
  unit_amount              bigint NOT NULL CHECK (unit_amount >= 0 AND unit_amount <= 99999999999),
  recurring_interval       text CHECK (recurring_interval IN ('day', 'week', 'month', 'year')),
  recurring_interval_count integer CHECK (recurring_interval_count BETWEEN 1 AND 365),
  tax_behavior             text NOT NULL DEFAULT 'unspecified' CHECK (tax_behavior IN ('inclusive', 'exclusive', 'unspecified')),
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  effective_from           timestamptz,
  effective_until          timestamptz,
  supersedes_id            text REFERENCES price_versions(id),
  created_by               text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK ((recurring_interval IS NULL) = (recurring_interval_count IS NULL))
);
CREATE TRIGGER price_versions_immutable BEFORE UPDATE ON price_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_column_changes(
    'id', 'offer_id', 'currency', 'unit_amount', 'recurring_interval', 'recurring_interval_count', 'tax_behavior');
CREATE TRIGGER price_versions_touch BEFORE UPDATE ON price_versions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
-- At most one active price per offer/currency/interval: the sellable price.
CREATE UNIQUE INDEX price_versions_one_active
  ON price_versions (offer_id, currency, coalesce(recurring_interval, ''), coalesce(recurring_interval_count, 0))
  WHERE status = 'active';

-- External Stripe mappings. Stripe IDs are never our canonical identifiers.
CREATE TABLE stripe_product_mappings (
  offer_id          text PRIMARY KEY REFERENCES offers(id),
  stripe_product_id text UNIQUE,
  sync_state        text NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending', 'synced', 'failed', 'drifted')),
  synced_name       text,
  last_error        text,
  attempts          integer NOT NULL DEFAULT 0,
  last_synced_at    timestamptz,
  last_checked_at   timestamptz,
  drift_detail      jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stripe_price_mappings (
  price_version_id  text PRIMARY KEY REFERENCES price_versions(id),
  stripe_price_id   text UNIQUE,
  sync_state        text NOT NULL DEFAULT 'pending'
                      CHECK (sync_state IN ('pending', 'synced', 'failed', 'drifted', 'archived')),
  idempotency_key   text NOT NULL,
  stripe_active     boolean,
  last_error        text,
  attempts          integer NOT NULL DEFAULT 0,
  last_synced_at    timestamptz,
  last_checked_at   timestamptz,
  drift_detail      jsonb,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER stripe_price_mappings_immutable BEFORE UPDATE ON stripe_price_mappings
  FOR EACH ROW WHEN (OLD.stripe_price_id IS NOT NULL)
  EXECUTE FUNCTION forbid_column_changes('stripe_price_id');

-- ---------------------------------------------------------------------------------------------
-- Customers, organisations and portal identities
-- ---------------------------------------------------------------------------------------------

CREATE TABLE customers (
  id                  wire_id PRIMARY KEY,               -- cus_… (wire customerId)
  kind                text NOT NULL CHECK (kind IN ('individual', 'organisation')),
  display_name        text NOT NULL,
  organisation_name   text,
  billing_email       text NOT NULL CHECK (billing_email = lower(billing_email)),
  tax_id              text,
  country             text CHECK (country ~ '^[A-Z]{2}$'),
  stripe_customer_id  text UNIQUE,
  marketing_consent   boolean NOT NULL DEFAULT false,
  marketing_consent_at timestamptz,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_billing_email ON customers (billing_email);
CREATE TRIGGER customers_immutable BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION forbid_column_changes('id');
CREATE TRIGGER customers_touch BEFORE UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE portal_users (
  id                text PRIMARY KEY,                    -- usr_…
  email             text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name      text,
  email_verified_at timestamptz,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_login_at     timestamptz
);

-- Organisation / customer membership. A portal user may belong to several customers.
CREATE TABLE customer_members (
  customer_id    text NOT NULL REFERENCES customers(id),
  portal_user_id text NOT NULL REFERENCES portal_users(id),
  role           text NOT NULL CHECK (role IN ('owner', 'admin', 'billing', 'member')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, portal_user_id)
);
CREATE INDEX customer_members_user ON customer_members (portal_user_id);

-- ---------------------------------------------------------------------------------------------
-- Administration identities, roles, service accounts and API tokens
-- ---------------------------------------------------------------------------------------------

CREATE TABLE admin_users (
  id                     text PRIMARY KEY,               -- adm_…
  email                  text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name           text NOT NULL,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  totp_secret_ciphertext bytea,                          -- AES-GCM under APP_DATA_KEY
  totp_key_version       integer,
  totp_enrolled_at       timestamptz,
  totp_last_step         bigint,                         -- replay protection
  created_at             timestamptz NOT NULL DEFAULT now(),
  last_login_at          timestamptz
);

CREATE TABLE roles (
  id          text PRIMARY KEY CHECK (id ~ '^[a-z_]{1,64}$'),
  name        text NOT NULL,
  description text NOT NULL DEFAULT ''
);

CREATE TABLE role_permissions (
  role_id    text NOT NULL REFERENCES roles(id),
  permission text NOT NULL CHECK (permission ~ '^[a-z_]+:[a-z_]+$'),
  PRIMARY KEY (role_id, permission)
);

CREATE TABLE admin_user_roles (
  admin_user_id text NOT NULL REFERENCES admin_users(id),
  role_id       text NOT NULL REFERENCES roles(id),
  granted_by    text,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (admin_user_id, role_id)
);

CREATE TABLE service_accounts (
  id             text PRIMARY KEY,                       -- svc_…
  name           text NOT NULL UNIQUE,
  description    text NOT NULL DEFAULT '',
  -- Upper bound for scopes any token of this account may carry.
  allowed_scopes text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_api_tokens (
  id                    text PRIMARY KEY,                -- tok_…
  lookup_id             text NOT NULL UNIQUE,            -- public part embedded in the token
  secret_hash           bytea NOT NULL,                  -- HMAC-SHA-256(API_TOKEN_PEPPER, secret)
  name                  text NOT NULL,
  admin_user_id         text REFERENCES admin_users(id),
  service_account_id    text REFERENCES service_accounts(id),
  scopes                text[] NOT NULL,
  not_before            timestamptz,
  expires_at            timestamptz NOT NULL,
  allowed_cidrs         text[] NOT NULL DEFAULT '{}',
  rate_limit_per_minute integer NOT NULL DEFAULT 120 CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
  last_used_at          timestamptz,
  last_used_ip_hash     text,
  revoked_at            timestamptz,
  revoked_reason        text,
  rotated_from_id       text REFERENCES admin_api_tokens(id),
  created_by            text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((admin_user_id IS NULL) <> (service_account_id IS NULL)),
  CHECK (cardinality(scopes) >= 1)
);
CREATE TRIGGER admin_api_tokens_immutable BEFORE UPDATE ON admin_api_tokens
  FOR EACH ROW EXECUTE FUNCTION forbid_column_changes('id', 'lookup_id', 'secret_hash', 'scopes', 'admin_user_id', 'service_account_id');

-- ---------------------------------------------------------------------------------------------
-- Human authentication: one-time challenges (magic links) and sessions, per realm
-- ---------------------------------------------------------------------------------------------

CREATE TABLE auth_challenges (
  id             text PRIMARY KEY,
  realm          text NOT NULL CHECK (realm IN ('customer', 'admin')),
  purpose        text NOT NULL CHECK (purpose IN ('login', 'invite')),
  subject_id     text NOT NULL,                          -- portal_users.id or admin_users.id
  token_hash     bytea NOT NULL UNIQUE,
  redirect_path  text,
  created_ip_hash text,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_challenges_expiry ON auth_challenges (expires_at);

CREATE TABLE auth_sessions (
  id_hash       bytea PRIMARY KEY,                       -- HMAC of the cookie token
  realm         text NOT NULL CHECK (realm IN ('customer', 'admin')),
  subject_id    text NOT NULL,
  -- Admin sessions start as 'pending_mfa' after the email factor and become 'active' after TOTP.
  state         text NOT NULL DEFAULT 'active' CHECK (state IN ('pending_mfa', 'active')),
  mfa_at        timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  ip_hash       text
);
CREATE INDEX auth_sessions_subject ON auth_sessions (realm, subject_id);

-- ---------------------------------------------------------------------------------------------
-- Commerce: checkouts, purchases, subscriptions, invoices
-- ---------------------------------------------------------------------------------------------

CREATE TABLE checkouts (
  id                         text PRIMARY KEY,           -- chk_…
  idempotency_key            text NOT NULL UNIQUE,
  customer_id                text REFERENCES customers(id),
  portal_user_id             text REFERENCES portal_users(id),
  email                      text NOT NULL CHECK (email = lower(email)),
  offer_id                   text NOT NULL REFERENCES offers(id),
  price_version_id           text NOT NULL REFERENCES price_versions(id),
  stripe_price_id            text,
  quantity                   integer NOT NULL CHECK (quantity >= 1),
  currency                   currency_code NOT NULL,
  unit_amount                bigint NOT NULL CHECK (unit_amount >= 0),
  expected_subtotal          bigint NOT NULL CHECK (expected_subtotal >= 0),
  mode                       text NOT NULL CHECK (mode IN ('payment', 'subscription')),
  -- Immutable purchase-time snapshot of offer, components and effective policies.
  snapshot                   jsonb NOT NULL,
  stripe_checkout_session_id text UNIQUE,
  stripe_checkout_url        text,
  status                     text NOT NULL DEFAULT 'creating'
                               CHECK (status IN ('creating', 'open', 'awaiting_payment', 'completed', 'expired', 'failed')),
  failure_reason             text,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  expires_at                 timestamptz NOT NULL
);
CREATE TRIGGER checkouts_immutable BEFORE UPDATE ON checkouts
  FOR EACH ROW EXECUTE FUNCTION forbid_column_changes('id', 'offer_id', 'price_version_id', 'quantity', 'currency', 'unit_amount', 'snapshot');
CREATE TRIGGER checkouts_touch BEFORE UPDATE ON checkouts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE subscriptions (
  id                     text PRIMARY KEY,               -- sub_…
  customer_id            text NOT NULL REFERENCES customers(id),
  checkout_id            text REFERENCES checkouts(id),
  stripe_subscription_id text NOT NULL UNIQUE,
  status                 text NOT NULL,                  -- Stripe status verbatim
  quantity               integer NOT NULL CHECK (quantity >= 1),
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  canceled_at            timestamptz,
  ended_at               timestamptz,
  stripe_state_at        timestamptz,                    -- when we last read Stripe's state
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER subscriptions_touch BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE purchases (
  id                       text PRIMARY KEY,             -- pur_…
  customer_id              text NOT NULL REFERENCES customers(id),
  checkout_id              text UNIQUE REFERENCES checkouts(id),
  source                   text NOT NULL CHECK (source IN ('stripe_checkout', 'admin_grant')),
  stripe_payment_intent_id text,
  stripe_invoice_id        text,
  currency                 currency_code NOT NULL,
  amount_subtotal          bigint NOT NULL,
  amount_discount          bigint NOT NULL DEFAULT 0,
  amount_tax               bigint NOT NULL DEFAULT 0,
  amount_total             bigint NOT NULL,
  status                   text NOT NULL DEFAULT 'completed'
                             CHECK (status IN ('completed', 'refunded', 'partially_refunded', 'disputed')),
  amount_refunded          bigint NOT NULL DEFAULT 0,
  created_by               text,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchases_payment_intent ON purchases (stripe_payment_intent_id);
CREATE TRIGGER purchases_immutable BEFORE UPDATE ON purchases
  FOR EACH ROW EXECUTE FUNCTION forbid_column_changes('id', 'customer_id', 'currency', 'amount_subtotal', 'amount_discount', 'amount_tax', 'amount_total');

CREATE TABLE purchase_lines (
  id               text PRIMARY KEY,                     -- pul_…
  purchase_id      text NOT NULL REFERENCES purchases(id),
  position         integer NOT NULL,
  offer_id         text NOT NULL REFERENCES offers(id),
  price_version_id text REFERENCES price_versions(id),
  quantity         integer NOT NULL CHECK (quantity >= 1),
  currency         currency_code NOT NULL,
  unit_amount      bigint NOT NULL,
  snapshot         jsonb NOT NULL,
  UNIQUE (purchase_id, position)
);
CREATE TRIGGER purchase_lines_append_only BEFORE UPDATE OR DELETE ON purchase_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE invoices (
  id                 text PRIMARY KEY,                   -- inv_…
  stripe_invoice_id  text NOT NULL UNIQUE,
  subscription_id    text REFERENCES subscriptions(id),
  customer_id        text REFERENCES customers(id),
  status             text NOT NULL,
  billing_reason     text,
  currency           currency_code NOT NULL,
  amount_due         bigint NOT NULL,
  amount_paid        bigint NOT NULL,
  amount_tax         bigint NOT NULL DEFAULT 0,
  period_end         timestamptz,                        -- service period end from line items
  hosted_invoice_url text,
  paid_at            timestamptz,
  extension_applied_at timestamptz,                      -- entitlement extension idempotency
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER invoices_touch BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Licensing: entitlements, policy snapshots, licences, keys, activations, transfers, revocations
-- ---------------------------------------------------------------------------------------------

CREATE TABLE entitlement_policy_snapshots (
  id          text PRIMARY KEY,                          -- eps_…
  snapshot    jsonb NOT NULL,
  reason      text NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER eps_append_only BEFORE UPDATE OR DELETE ON entitlement_policy_snapshots
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE entitlements (
  id                     wire_id PRIMARY KEY,            -- ent_…
  customer_id            text NOT NULL REFERENCES customers(id),
  product_major_id       text NOT NULL REFERENCES product_majors(id),
  edition_policy_id      text NOT NULL REFERENCES product_edition_policies(id),
  purchase_line_id       text REFERENCES purchase_lines(id),
  component_id           text REFERENCES offer_entitlement_components(id),
  subscription_id        text REFERENCES subscriptions(id),
  policy_snapshot_id     text NOT NULL REFERENCES entitlement_policy_snapshots(id),
  term_type              text NOT NULL CHECK (term_type IN ('perpetual', 'subscription', 'fixed_term')),
  starts_at              timestamptz NOT NULL,
  expires_at             timestamptz,
  seats                  integer CHECK (seats >= 1),
  transfer_allowance     integer CHECK (transfer_allowance >= 0),
  transfer_bonus         integer NOT NULL DEFAULT 0 CHECK (transfer_bonus >= 0),
  transfer_window_reset_at timestamptz,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_at             timestamptz,
  revoked_reason         text,
  review_required        boolean NOT NULL DEFAULT false,
  review_reason          text,
  organisation_name      text,
  customer_name          text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_line_id, component_id),
  CHECK ((term_type = 'perpetual') = (expires_at IS NULL)),
  CHECK (organisation_name IS NULL OR length(organisation_name) > 0),
  CHECK (customer_name IS NULL OR length(customer_name) > 0)
);
CREATE INDEX entitlements_customer ON entitlements (customer_id);
CREATE INDEX entitlements_subscription ON entitlements (subscription_id);
CREATE TRIGGER entitlements_immutable BEFORE UPDATE ON entitlements
  FOR EACH ROW EXECUTE FUNCTION forbid_column_changes('id', 'customer_id', 'product_major_id', 'edition_policy_id', 'purchase_line_id', 'term_type');
CREATE TRIGGER entitlements_touch BEFORE UPDATE ON entitlements FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE licenses (
  id               wire_id PRIMARY KEY,                  -- lic_… (wire licenseId; stable)
  entitlement_id   text NOT NULL UNIQUE REFERENCES entitlements(id),
  current_envelope jsonb,                                -- last validly signed envelope
  current_issued_at timestamptz,
  current_key_ids  text[] NOT NULL DEFAULT '{}',
  issue_count      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER licenses_immutable BEFORE UPDATE ON licenses FOR EACH ROW EXECUTE FUNCTION forbid_column_changes('id', 'entitlement_id');
CREATE TRIGGER licenses_touch BEFORE UPDATE ON licenses FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE license_issuances (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  license_id     text NOT NULL REFERENCES licenses(id),
  artifact       text NOT NULL CHECK (artifact IN ('license', 'activation')),
  activation_id  text,
  issued_at      timestamptz NOT NULL,
  payload_sha256 text NOT NULL,
  key_ids        text[] NOT NULL,
  reason         text NOT NULL,
  actor          text NOT NULL
);
CREATE INDEX license_issuances_license ON license_issuances (license_id, issued_at);
CREATE TRIGGER license_issuances_append_only BEFORE UPDATE OR DELETE ON license_issuances
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE activation_keys (
  id                 text PRIMARY KEY,                   -- akey_…
  license_id         text NOT NULL REFERENCES licenses(id),
  key_hash           bytea NOT NULL UNIQUE,              -- HMAC(MACHINE_PEPPER, normalised key)
  key_hint           text NOT NULL,                      -- last 5 chars only
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotated', 'revoked')),
  reveal_ciphertext  bytea,                              -- one-time portal reveal (ADR-0001 §5)
  reveal_key_version integer,
  reveal_expires_at  timestamptz,
  created_by         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  rotated_at         timestamptz
);
CREATE UNIQUE INDEX activation_keys_one_active ON activation_keys (license_id) WHERE status = 'active';

CREATE TABLE activations (
  id                 wire_id PRIMARY KEY,                -- act_…
  license_id         text NOT NULL REFERENCES licenses(id),
  device_id          text NOT NULL CHECK (length(device_id) BETWEEN 1 AND 256),
  client_secret_hash bytea NOT NULL,
  status             text NOT NULL CHECK (status IN ('active', 'inactive')),
  counted_as_transfer boolean NOT NULL DEFAULT false,
  activated_at       timestamptz NOT NULL DEFAULT now(),
  last_validated_at  timestamptz,
  deactivated_at     timestamptz,
  deactivated_by     text CHECK (deactivated_by IN ('client', 'portal', 'support', 'system')),
  CHECK ((status = 'inactive') = (deactivated_at IS NOT NULL))
);
-- One live activation per device per licence.
CREATE UNIQUE INDEX activations_one_live_per_device ON activations (license_id, device_id) WHERE status = 'active';
CREATE INDEX activations_license ON activations (license_id, status);

CREATE TABLE transfer_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  license_id    text NOT NULL REFERENCES licenses(id),
  activation_id text REFERENCES activations(id),
  kind          text NOT NULL CHECK (kind IN ('transfer', 'grant', 'reset')),
  amount        integer NOT NULL DEFAULT 1,
  actor         text NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transfer_events_window ON transfer_events (license_id, occurred_at);
CREATE TRIGGER transfer_events_append_only BEFORE UPDATE OR DELETE ON transfer_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE revocations (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entitlement_id text NOT NULL REFERENCES entitlements(id),
  action         text NOT NULL CHECK (action IN ('revoke', 'unrevoke')),
  reason         text NOT NULL,
  source         text NOT NULL CHECK (source IN ('admin', 'stripe_refund', 'stripe_dispute', 'system')),
  source_ref     text,
  actor          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entitlement_id, source, source_ref, action)
);
CREATE TRIGGER revocations_append_only BEFORE UPDATE OR DELETE ON revocations
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Signing keys. Public metadata and encrypted private material live in separate tables so a
-- restricted role can be denied the secrets table (see sql/roles.sql).
-- ---------------------------------------------------------------------------------------------

CREATE TABLE signing_keys (
  id            wire_id PRIMARY KEY,                     -- keyId, globally unique, never reused
  algorithm     text NOT NULL CHECK (algorithm IN ('Ed25519', 'ECDSA-P256-SHA256', 'ML-DSA-65')),
  public_key    bytea NOT NULL,                          -- raw encoding as published to apps
  fingerprint   text NOT NULL UNIQUE,                    -- sha256(public_key) hex
  status        text NOT NULL DEFAULT 'generated'
                  CHECK (status IN ('generated', 'published', 'retired', 'compromised')),
  origin        text NOT NULL CHECK (origin IN ('generated', 'imported', 'test_vector')),
  notes         text NOT NULL DEFAULT '',
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  retired_at    timestamptz,
  compromised_at timestamptz
);
CREATE TRIGGER signing_keys_immutable BEFORE UPDATE ON signing_keys
  FOR EACH ROW EXECUTE FUNCTION forbid_column_changes('id', 'algorithm', 'public_key', 'fingerprint', 'origin');
CREATE TRIGGER signing_keys_no_delete BEFORE DELETE ON signing_keys FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE signing_key_secrets (
  signing_key_id  text PRIMARY KEY REFERENCES signing_keys(id),
  private_format  text NOT NULL CHECK (private_format IN ('ed25519-seed32', 'p256-scalar32', 'mldsa65-seed32')),
  ciphertext      bytea NOT NULL,
  nonce           bytea NOT NULL CHECK (octet_length(nonce) = 12),
  tag             bytea NOT NULL CHECK (octet_length(tag) = 16),
  kek_version     integer NOT NULL CHECK (kek_version >= 1),
  aad_version     integer NOT NULL DEFAULT 1,
  encrypted_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER signing_key_secrets_no_delete BEFORE DELETE ON signing_key_secrets FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE key_compatibilities (
  id                   text PRIMARY KEY,                 -- kcp_…
  signing_key_id       text NOT NULL REFERENCES signing_keys(id),
  product_major_id     text NOT NULL REFERENCES product_majors(id),
  trusted_since_version text NOT NULL,                   -- first release embedding the key
  trusted_until_version text,                            -- last release still embedding it
  eligible             boolean NOT NULL DEFAULT false,
  eligible_at          timestamptz,
  approved_by          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signing_key_id, product_major_id)
);
CREATE TRIGGER key_compat_touch BEFORE UPDATE ON key_compatibilities FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE key_lifecycle_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signing_key_id text NOT NULL REFERENCES signing_keys(id),
  event          text NOT NULL,
  actor          text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}',
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER key_lifecycle_append_only BEFORE UPDATE OR DELETE ON key_lifecycle_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------
-- Integrations: Stripe inbox, mail, outbox jobs
-- ---------------------------------------------------------------------------------------------

CREATE TABLE stripe_events (
  id            text PRIMARY KEY,                        -- Stripe event id evt_…
  type          text NOT NULL,
  livemode      boolean NOT NULL,
  api_version   text,
  stripe_created timestamptz NOT NULL,
  object_id     text,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'processed', 'ignored', 'failed', 'dead')),
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  outcome       text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);
CREATE INDEX stripe_events_status ON stripe_events (status, received_at);
CREATE INDEX stripe_events_object ON stripe_events (object_id);

CREATE TABLE email_templates (
  id                     text PRIMARY KEY,               -- etp_…
  template_key           text NOT NULL CHECK (template_key ~ '^[a-z_.]{1,64}$'),
  locale                 text NOT NULL DEFAULT 'en',
  category               text NOT NULL CHECK (category IN ('transactional', 'security', 'marketing')),
  subject                text NOT NULL,
  html_body              text NOT NULL,
  text_body              text NOT NULL,
  mailersend_template_id text,
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  updated_by             text,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_key, locale)
);

CREATE TABLE email_outbox (
  id                  text PRIMARY KEY,                  -- eml_…
  business_key        text NOT NULL UNIQUE,              -- idempotency: one email per business event
  template_key        text NOT NULL,
  category            text NOT NULL,
  recipient_hash      text NOT NULL,                     -- for logs/suppression; plaintext is in payload
  payload_ciphertext  bytea,                             -- AES-GCM(APP_DATA_KEY): {to,name,vars}
  payload_key_version integer,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sending', 'sent', 'delivered', 'failed', 'dead', 'uncertain', 'suppressed', 'bounced')),
  attempts            integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  locked_until        timestamptz,
  last_error          text,
  provider_message_id text UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_due ON email_outbox (status, next_attempt_at);
CREATE TRIGGER email_outbox_touch BEFORE UPDATE ON email_outbox FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE mail_events (
  id                  text PRIMARY KEY,                  -- sha256 of signed raw body
  type                text NOT NULL,
  provider_message_id text,
  recipient_hash      text,
  received_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_suppressions (
  recipient_hash text PRIMARY KEY,
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox_jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         text NOT NULL,
  dedupe_key   text NOT NULL UNIQUE,
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'dead')),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 12,
  run_after    timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_jobs_due ON outbox_jobs (status, run_after);
CREATE TRIGGER outbox_jobs_touch BEFORE UPDATE ON outbox_jobs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Cross-cutting: API idempotency, rate limiting, audit
-- ---------------------------------------------------------------------------------------------

CREATE TABLE idempotency_records (
  actor_id        text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  method          text NOT NULL,
  path            text NOT NULL,
  request_hash    text NOT NULL,
  status_code     integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key)
);

CREATE TABLE rate_limit_buckets (
  bucket_key   text NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);

CREATE TABLE audit_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_type    text NOT NULL CHECK (actor_type IN ('admin', 'api_token', 'customer', 'device', 'stripe', 'mailersend', 'system')),
  actor_id      text,
  action        text NOT NULL,
  resource_type text,
  resource_id   text,
  outcome       text NOT NULL CHECK (outcome IN ('success', 'denied', 'failure')),
  request_id    text,
  ip_hash       text,
  detail        jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_resource ON audit_events (resource_type, resource_id, occurred_at);
CREATE INDEX audit_events_time ON audit_events (occurred_at);
CREATE INDEX audit_events_actor ON audit_events (actor_type, actor_id, occurred_at);
-- Append-only. The runtime role has no UPDATE/DELETE grant (sql/roles.sql); this trigger is
-- defence in depth. The only permitted delete is the documented retention purge
-- (docs/runbooks/privacy-retention.md), run by the owner role with app.audit_purge = 'on'
-- and only for rows older than 400 days.
CREATE FUNCTION audit_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.audit_purge', true) = 'on'
     AND OLD.occurred_at < now() - interval '400 days' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_guard();
