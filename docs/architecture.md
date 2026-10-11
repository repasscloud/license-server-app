# Architecture

## Shape

A TypeScript **modular monolith** deployed as **one Cloudflare Worker**. Route groups are isolated logically, each with its own authentication, error format and middleware:

```text
                         ┌────────────────────────── Cloudflare Worker (workerd) ──────────────────────────┐
 apps (CurseDelete …) ──▶│ router.ts ─ /v1/*  minimal machine app (3 routes)       activation key / client secret │
 terminal / CI ─────────▶│           ─ /api/admin/v1/*  bearer PAT / service token  (no cookies)                 │
 admins (browser) ──────▶│           ─ /admin/*  admin realm cookie + TOTP + CSRF                                │
 customers (browser) ───▶│           ─ /portal/*, /store, /checkout/*  customer realm cookie + CSRF              │
 Stripe / MailerSend ───▶│           ─ /webhooks/*  raw-body signature verification                              │
 Cron Triggers ─────────▶│ scheduled() ─ bounded job drain, email dispatch, reconciliation, retention            │
                         │                                                                                        │
                         │ services/  (all business rules; framework-free; same calls from UI, API, jobs)         │
                         │ domain/    (policy engine, protocol registry, v1 claims)                               │
                         │ crypto/    (Web Crypto: Ed25519, ECDSA-P256 P1363, ML-DSA-65; AES-256-GCM; HMAC)       │
                         │ integrations/ (Stripe REST adapter, MailerSend adapter)                                │
                         └───────────────┬─────────────────────────────────────┬───────────────────────────────────┘
                                         │ Hyperdrive (pooling, caching OFF)   │ HTTPS
                                  PostgreSQL (Supabase → any PG)        Stripe API · MailerSend API
```

The admin UI and the admin API call the **same service functions**. Those functions perform the permission checks (`requirePermission` / `requireHighRisk`) and write the audit records, so the UI and API cannot drift apart.

## Why these choices

See the ADRs. In short:

- [ADR-0001](adr/0001-generic-policy-vs-v1-contract.md): generic per-product policy vs the strict `repass-*-v1` contract.
- [ADR-0002](adr/0002-runtime-and-stack.md): Workers Free, Hono, postgres.js over Hyperdrive with caching disabled, zod off the hot path, server-rendered HTML with no client JS.
- [ADR-0003](adr/0003-signing-keys-and-trust-boundary.md): signing keys in PostgreSQL, encrypted with an application KEK, and the honest trust boundary.
- [ADR-0004](adr/0004-identity-realms-and-api-tokens.md): two human realms, no passwords, TOTP, and PAT/service tokens.
- [ADR-0005](adr/0005-stripe-and-mailersend.md): the DB is the catalogue master; Stripe adapter, API version pin, webhook inbox, MailerSend outbox.

## Data model (migrations/0001–0003)

| Area | Tables |
|---|---|
| Protocol and catalogue | `license_protocols`, `products`, `product_majors`, `product_releases`, `edition_definitions`, `product_edition_policies` |
| Sellable catalogue | `offers` (single/bundle), `offer_entitlement_components`, `price_versions` (immutable amounts), `stripe_product_mappings`, `stripe_price_mappings` |
| Parties | `customers` (individual/organisation), `portal_users`, `customer_members` (owner/admin/billing/member) |
| Administration | `admin_users` (encrypted TOTP), `roles`, `role_permissions`, `admin_user_roles`, `service_accounts`, `admin_api_tokens` (HMAC digests) |
| Human auth | `auth_challenges` (hashed one-time links), `auth_sessions` (hashed tokens, realm, MFA state) |
| Commerce | `checkouts` (immutable snapshot), `purchases`, `purchase_lines`, `subscriptions`, `invoices` |
| Licensing | `entitlement_policy_snapshots` (append-only), `entitlements`, `licenses` (stable id + last envelope), `license_issuances`, `activation_keys` (HMAC), `activations` (HMAC client secret), `transfer_events`, `revocations` |
| Keys | `signing_keys` (public), `signing_key_secrets` (AES-GCM ciphertext/nonce/tag/KEK version), `key_compatibilities`, `key_lifecycle_events` |
| Integration and durability | `stripe_events` (inbox), `email_templates`, `email_outbox` (encrypted payload), `mail_events`, `email_suppressions`, `outbox_jobs`, `idempotency_records`, `rate_limit_buckets` |
| Audit | `audit_events` (append-only; retention purge only via the owner role) |

The distinctions required by brief §3.1 are kept as separate objects: **purchase ≠ entitlement ≠ licence ≠ activation ≠ activation key ≠ subscription ≠ offer ≠ price**. A bundle purchase produces one entitlement and one licence *per component product*.

Invariants live in the database: unique and partial-unique indexes (one live activation per device per licence, one active key per licence, one active price per offer/currency/interval), immutability triggers (IDs, slugs, price amounts, purchase totals, key material identity), and append-only triggers for history tables. The runtime role (`sql/roles.sql`) cannot update or delete history.

## Key flows

**Purchase.** `/checkout` (sku, currency, quantity, email, idempotency key) → resolve an active, synced DB price → store a checkout with an immutable snapshot of the quantity-adjusted effective policies → Stripe Checkout Session using the *mapped* Stripe Price → redirect. Returning to the success URL only shows status. A verified `checkout.session.completed` webhook is stored in `stripe_events` together with a job. The job re-fetches the session from Stripe, matches it against the snapshot (price, quantity, currency, subtotal), and then, in one transaction, creates the customer, purchase, lines, subscription, entitlements, licences and activation keys, signs the licences, and queues the confirmation email. `purchases.checkout_id UNIQUE` makes this exactly-once.

**Renewal.** A verified `invoice.paid` webhook → upsert `invoices` → `extension_applied_at` guard → `expires_at = max(current, period_end + grace)` (monotonic) → the next `/renew` or portal download re-signs the *same* licence ID.

**Machine activation (Business).** Look up the activation key by HMAC → `SELECT … FOR UPDATE` on the licence and entitlement → same device: reuse the activation and rotate its secret hash; otherwise check seats, then the transfer rule (a released seat reused within 365 days counts against the allowance, net of grants and since the last reset) → insert the activation → sign the licence and certificate with every eligible key **inside the same transaction**. If signing fails (for example, no eligible key), the seat is rolled back.

**Durable work.** Business transactions insert `outbox_jobs` and `email_outbox` rows. Cron (every 2 minutes) drains bounded batches with `FOR UPDATE SKIP LOCKED` leases, exponential backoff and dead-lettering. After a webhook is stored, `waitUntil` triggers one immediate drain to reduce latency. It is never relied on for durability.

## Free-plan resource posture

- **CPU.** Measured warm request CPU is about 1 ms at p50 and ≤ 5 ms at p95 (`docs/perf/cpu-latest.json`). The first request in a fresh isolate is about 20 ms, which relies on Cloudflare's documented per-isolate tolerance for infrequent overruns. See [`STATUS.md`](STATUS.md).
- **Subrequests.** Each request uses at most a few database connections plus 0–3 Stripe or MailerSend calls. Batches are sized to stay under 50.
- **Queries.** Hyperdrive Free allows 100k queries/day. A business activation is about 10 queries and an admin API call about 6. The every-2-minute cron is about 15 queries per tick (about 11k/day). See [`runbooks/operations.md`](runbooks/operations.md#free-plan-limits).
- **No paid products.** No Queues, Durable Objects, KV, R2, D1, or Workers Paid features are required.
