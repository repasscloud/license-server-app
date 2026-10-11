# Deployment runbook (Cloudflare Workers + Supabase PostgreSQL + Stripe + MailerSend)

All commands are for **macOS / zsh**. Nothing here was run against your real accounts by the implementer: every step needs the owner's credentials. Values in `<angle brackets>` are yours to supply. Never paste secrets into commands that end up in shell history. Use `security` (macOS Keychain) and stdin as shown.

## 0. Keychain conventions

```zsh
# Store a secret once (prompts; nothing lands in history):
security add-generic-password -a "$USER" -s repass-db-owner-url -w
# Read it into a pipe without echoing:
security find-generic-password -a "$USER" -s repass-db-owner-url -w
```

Suggested Keychain service names: `repass-db-owner-url`, `repass-db-runtime-password`, `repass-signing-kek-v1`, `repass-app-data-key-v1`, `repass-machine-pepper`, `repass-auth-pepper`, `repass-api-token-pepper`, `repass-stripe-secret`, `repass-stripe-whsec`, `repass-mailersend-token`, `repass-mailersend-whsec`, `repass-admin-pat`.

## 1. Supabase PostgreSQL

1. Create a Supabase project in the region closest to your customers. Supabase features beyond plain PostgreSQL (Auth, Realtime, Storage, Edge Functions, PostgREST business logic) are **not used**. Disable the Data API (PostgREST) for the `public` schema, or at least make sure `anon`/`authenticated` have no grants on our tables (step 1.4).
2. Copy the **Direct connection** string (Settings → Database). Cloudflare's Supabase guide recommends the direct connection for Hyperdrive, because Hyperdrive does the pooling. *Check at setup time:* Supabase's direct host may be IPv6-only unless the IPv4 add-on is enabled. If Hyperdrive cannot reach it, use the IPv4 add-on or the Supavisor **session** pooler (port 5432). Never use the transaction pooler (port 6543) for Hyperdrive.
3. Run the migrations as the owner (direct connection, from your machine or the approved deploy workflow):

   ```zsh
   DATABASE_URL="$(security find-generic-password -a "$USER" -s repass-db-owner-url -w)" npm run db:migrate
   ```

4. Create the least-privilege runtime role, and remove default Supabase API grants:

   ```zsh
   security add-generic-password -a "$USER" -s repass-db-runtime-password -w "$(openssl rand -base64 33 | tr -d '/+=')"
   psql "$(security find-generic-password -a "$USER" -s repass-db-owner-url -w)" \
     -v runtime_password="$(security find-generic-password -a "$USER" -s repass-db-runtime-password -w)" -f sql/roles.sql
   psql "$(security find-generic-password -a "$USER" -s repass-db-owner-url -w)" -c \
     "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated; REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;"
   ```

   Re-run `sql/roles.sql` after any migration that adds tables.

5. Turn on Supabase backups or PITR to match your plan, and also run the independent `pg_dump` backups in [backup-and-provider-migration.md](backup-and-provider-migration.md).

## 2. Cloudflare

```zsh
npx wrangler login                       # or set CLOUDFLARE_API_TOKEN in the shell for this session only
npx wrangler whoami
```

**Hyperdrive** (one configuration per environment, **caching disabled**):

```zsh
RUNTIME_URL="postgres://repass_runtime:$(security find-generic-password -a "$USER" -s repass-db-runtime-password -w)@<direct-host>:5432/postgres"
npx wrangler hyperdrive create repass-license-production --connection-string="$RUNTIME_URL" --caching-disabled
unset RUNTIME_URL
```

Put the returned `id` into `wrangler.jsonc`, replacing `env.production.hyperdrive[0].id` (and the staging equivalent). Hyperdrive Free gives 100,000 queries/day and about 20 origin connections. See [operations.md](operations.md#free-plan-limits).

**Secrets** (piped from Keychain; repeat with `--env staging` using **different** values):

```zsh
for pair in SIGNING_KEK_V1:repass-signing-kek-v1 APP_DATA_KEY_V1:repass-app-data-key-v1 MACHINE_PEPPER:repass-machine-pepper \
            AUTH_PEPPER:repass-auth-pepper API_TOKEN_PEPPER:repass-api-token-pepper STRIPE_SECRET_KEY:repass-stripe-secret \
            STRIPE_WEBHOOK_SECRET:repass-stripe-whsec MAILERSEND_API_TOKEN:repass-mailersend-token MAILERSEND_WEBHOOK_SECRET:repass-mailersend-whsec; do
  name=${pair%%:*}; svc=${pair#*:}
  security find-generic-password -a "$USER" -s "$svc" -w | npx wrangler secret put "$name" --env production
done
```

Generate the five 32-byte secrets once with `security add-generic-password -a "$USER" -s <svc> -w "$(openssl rand -base64 32)"`. Back up `SIGNING_KEK_V1` **offline and separately** (see [signing-keys.md](signing-keys.md)). Losing it means losing the ability to sign with existing keys.

**Domain and exposure.** `wrangler.jsonc` declares `routes: [{ pattern: "license-server.repasscloud.com", custom_domain: true }]` with `workers_dev: false` and `preview_urls: false` in every environment. On the first `wrangler deploy --env production`, Cloudflare creates the proxied DNS record and the edge certificate for the custom domain on the `repasscloud.com` zone. After deploying, confirm in the dashboard (Worker → Settings → Domains & Routes) that:

- `license-server.repasscloud.com` is listed as a Custom Domain;
- the `workers.dev` route is **Disabled**;
- **Preview URLs** are **Disabled**. This is a separate toggle, and disabling `workers.dev` does not disable it.

Also set SSL/TLS → Edge Certificates → **Always Use HTTPS** = on, and TLS minimum 1.2, for the zone. Optionally put **Cloudflare Access** in front of `license-server.repasscloud.com/admin*` for defence in depth (free for small teams). Do not put it in front of `/v1/*`, `/webhooks/*` or `/api/admin/*`.

**Deploy:**

```zsh
npm run typecheck && npm test && npx wrangler deploy --env production
curl -s https://license-server.repasscloud.com/healthz        # {"status":"ok"}
curl -s https://license-server.repasscloud.com/readyz         # {"status":"ok","database":"ok","configurationComplete":true}
```

**Cron Triggers.** Two are declared (`*/2 * * * *` work, `17 3 * * *` daily). Free accounts get 5 Cron Triggers per account in total.

## 3. First administrator

```zsh
DATABASE_URL="$(security find-generic-password -a "$USER" -s repass-db-owner-url -w)" \
APP_DATA_KEY_V1="$(security find-generic-password -a "$USER" -s repass-app-data-key-v1 -w)" \
  npm run admin:bootstrap -- --email you@repasscloud.com --name "Your Name"
```

Add the printed `otpauth://` URI to your authenticator. It is printed once. Then visit `/admin/login`. Invite further administrators from **Access** (they enrol TOTP on first login).

## 4. Signing keys for a product

In **Signing keys**: generate `repass-ed25519-<year>` and `repass-mldsa65-<year>`, then **Publish**. Hand the public keys (from the export) to the application team. Once the application release that embeds them ships, record **trust** for the product major (`trustedSinceVersion`), mark that release as shipped and **minimum supported** on the major page, and then mark the keys **eligible**. Until then, issuance for that major fails closed with 503, by design.

## 5. Stripe

1. Start in **test mode**. Use restricted keys if you prefer. The server needs write access to Products, Prices and Checkout Sessions, and read access to Customers, Subscriptions, Invoices, Charges, Disputes, Invoice Payments, Events and the Billing Portal.
2. Developers → Webhooks → add endpoint `https://license-server.repasscloud.com/webhooks/stripe`, API version **`2026-09-30.endive`** (must match `STRIPE_API_VERSION`), with these events:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.trial_will_end`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`.
   Store the signing secret in Keychain (`repass-stripe-whsec`) and run `wrangler secret put STRIPE_WEBHOOK_SECRET`.
3. Configure the **Customer Portal** (Settings → Billing → Customer portal) if customers should manage payment methods, cancel, or download invoices.
4. **Tax:** to use `automatic_tax` on an offer, enable **Stripe Tax** and add your registrations (for example, Australian GST). The server does not compute tax. Have a tax adviser review your setup.
5. Live mode: repeat with live keys and a separate webhook endpoint secret. Test and live events are rejected if their `livemode` doesn't match the configured key.

## 6. MailerSend

1. Add and verify the sending domain (DNS records SPF/DKIM/return-path on `repasscloud.com`) in MailerSend.
2. Create a **scoped API token** with *Email: full access* only. Store it in Keychain and run `wrangler secret put MAILERSEND_API_TOKEN`.
3. Set `MAIL_FROM_EMAIL` in `wrangler.jsonc` to an address on the verified domain.
4. Optional delivery tracking: create a webhook to `https://license-server.repasscloud.com/webhooks/mailersend` for `activity.delivered`, `activity.soft_bounced`, `activity.hard_bounced` and `activity.spam_complaint`. Put its signing secret in `MAILERSEND_WEBHOOK_SECRET`. Without it the endpoint returns 404 and no delivery tracking is claimed.

## 7. GitHub

- **Secrets** for the manual **Deploy** workflow: `CLOUDFLARE_API_TOKEN` (scoped: Workers Scripts:Edit and Workers Routes:Edit for the zone, and Hyperdrive:Read if you prefer), `CLOUDFLARE_ACCOUNT_ID`, and `DATABASE_URL_MIGRATOR` (owner URL, used only when *run_migrations* is ticked).
- **Environments** `staging` and `production`. Require reviewers on `production`.
- CI (`.github/workflows/ci.yml`) never deploys. Pin the `actions/setup-node` reference to a commit SHA (marked TODO).

## 8. Release and rollback

1. Merge to `main` after green CI.
2. If the release has migrations: **take a `pg_dump` first** (see backup runbook). Then run *Deploy* with `run_migrations=true` for staging, verify, and repeat for production. Migrations are forward-only. Write them to be backward-compatible with the previous Worker version (expand, then contract), so code can be rolled back without rolling back the schema.
3. Rollback the Worker with `npx wrangler rollback --env production` (or redeploy the previous tag). Database rollback means restoring the pre-migration dump, which is a last resort that loses writes made since.

## 9. Post-deploy checklist

- [ ] `/readyz` reports `configurationComplete: true`; the admin overview shows no missing secrets.
- [ ] `workers.dev` and Preview URLs are disabled; only the custom domain resolves.
- [ ] Hyperdrive caching is **disabled** (`npx wrangler hyperdrive get <id>`).
- [ ] A Stripe test-mode purchase completes end to end (store → checkout → webhook → portal → email).
- [ ] A real client (e.g. CurseDelete built with the published keys) activates, renews and deactivates against production.
- [ ] Workers Logs show `cpuTime` well under 10 ms and no `exceededCpu` outcomes (see operations runbook).
