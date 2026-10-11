# Prompts 14-16 Billing and Acceptance Convergence Design

## Scope

This design completes roadmap stages 14 through 16 in the existing .NET 10
Blazor/Minimal API monolith. It adds verified Stripe webhook ingestion,
provider-neutral billing policy, durable operational controls, final migration and
acceptance verification, and synchronized operator documentation. Stripe remains an
adapter: licensing, customer, catalog, audit, and email rules remain internal.

## Current official Stripe contract

- Use Stripe.net 52.2.0 and API version `2026-07-29.dahlia`.
- Verify the `Stripe-Signature` header against the untouched UTF-8 request body with
  `EventUtility.ConstructEvent` before parsing or persistence.
- Return a successful HTTP response immediately after durable inbox insertion;
  business work happens in a background worker because Stripe recommends responding
  before complex logic.
- Webhook delivery can be duplicated, delayed, retried, and unordered. Processing
  therefore keys side effects by provider event/object IDs and resolves current Stripe
  state through an injectable adapter whenever a snapshot is stale or incomplete.
- Instantiate `StripeClient`; do not use the deprecated global API-key configuration.
  Production should use a least-privilege restricted API key and secret storage.
- The billing integration models plans as Stripe Products with one or more Prices and
  does not assume that enabling Stripe Tax alone collects tax; registrations remain an
  operator responsibility outside this roadmap.

## Stage 14: verified ingestion and provider-neutral persistence

`BillingContract` and `LicenseOrder` hold internal commercial state. They reference
internal customer, product, and license IDs but contain no Stripe object. Separate
mapping tables bind Stripe customer, product, price, subscription, Checkout Session,
and invoice IDs to those internal records. Provider IDs never enter signed metadata.

`WebhookInbox` stores the verified event ID, event type, safe object ID, category,
timestamps, processing state, attempt/lease data, and a Data Protection-encrypted copy
of the raw payload. The event ID is unique. Valid duplicate delivery returns 200 and
does not add a second row. Invalid signatures or malformed signed JSON return 400 and
leave every database table unchanged.

The endpoint performs only signature verification, bounded classification, and an
atomic insert. A hosted worker claims due rows with PostgreSQL `FOR UPDATE SKIP
LOCKED`, commits a two-minute lease, and invokes `IBillingEventProcessor` outside the
claim transaction. Stage 14's processor categorizes supported candidate events and
leaves them ready for policy. Transient failures receive bounded exponential retry;
the eighth failure becomes `dead_letter`. Expired leases are recoverable after a
worker crash. Logs contain inbox ID, event type, safe provider event/object IDs, and
state only.

## Stage 15: explicit idempotent licensing policy

`IStripeBillingStateProvider` translates the stored Stripe event plus, when necessary,
current provider objects into a provider-neutral `BillingSnapshot`. Automated tests
replace it with a fake and never call Stripe. The production implementation uses an
injected `StripeClient` and only the object retrieval permissions it needs.

Policy processing locks the inbox row and serializes by the stable invoice or
subscription identifier. It resolves dedicated customer/product/price mappings before
acting. Missing or contradictory mappings become `quarantined`; they are terminal
until an operator repairs configuration and explicitly reprocesses the event.

Default policy is explicit configuration:

- `Billing:GracePeriodDays=7`.
- `Billing:RefundAction=review` and `Billing:DisputeAction=review`; accepted values are
  `review` and `suspend`.
- completed, paid Checkout creates or maps the customer, order, and contract and
  issues exactly one subscription license through `LicenseStore`;
- a paid invoice extends expiry only when the provider's current period end is later
  than the stored paid-through instant, and queues one renewal receipt;
- failed payment extends effective access to the configured grace deadline and queues
  one failure notice; recovery clears grace and applies the paid period;
- cancellation at period end preserves access through the current paid-through
  instant, and reversal clears the cancellation marker;
- subscription plan changes apply the mapped product, edition, seats, and period end
  as a new audited/versioned set of license terms;
- subscription deletion preserves paid-through access and allows natural expiry;
- refund/dispute defaults to a review flag. `suspend` is deliberately configurable and
  expires access immediately without placing Stripe data in the license.

Invoice, order, contract, audit, license, and email-outbox mutations commit in one
transaction. Unique mappings and monotonic period checks make duplicate, concurrent,
replayed, and reordered events no-ops. Activation plaintext appears only in the
approved encrypted purchase-email outbox payload and the existing short-lived
encrypted issuance replay record; it never appears in inbox, audit, logs, or later
responses.

`GET /api/v1/admin/billing/events` and
`POST /api/v1/admin/billing/events/{id}/reprocess` require `billing.manage` and the
existing cookie-antiforgery/bearer distinction. Reprocess resets only process state;
it cannot edit payload, identifiers, mappings, policy, or business records.

## Stage 16: acceptance and operations convergence

Keep the existing forward migration history unless exact Compose inspection proves a
re-baseline is both necessary and safe. The default strategy is a forward billing
migration because it preserves an upgrade path while still allowing clean PostgreSQL
creation and repeatable seeding to be proven.

Add a traceability matrix mapping every roadmap acceptance item to production code and
an automated test. Synchronize `README.md`, `.env.example`, Compose configuration,
OpenAPI descriptions, test documentation, recovery instructions, retention/backup
notes, Stripe/MailerSend setup, roles/scopes, KMS/HSM boundaries, and offline limits.
Mark the roadmap completed only after fresh Release build, full PostgreSQL tests,
license/activation scripts, Docker build, clean Compose creation/restart/seed, signed
webhook smoke, and final secret/stale-path scans.

## Security and failure boundaries

- Stripe API and endpoint secrets are configuration names only; source and committed
  examples contain placeholders.
- Raw webhook bodies are read once, never logged, and persisted only as protected
  ciphertext after verification.
- Provider payment data is absent from signed licenses, audit context, exceptions,
  analytics, and operational projections.
- Unknown mappings and malformed business state fail closed without license/email
  side effects.
- Cookie mutations validate antiforgery; explicit bearer requests authenticate solely
  through `Authorization`.
- Offline signed files cannot be recalled, immediate suspension depends on online
  validation/refresh, and this limitation remains prominent in operator documentation.

## Official sources

- Stripe webhooks: <https://docs.stripe.com/webhooks>
- Stripe signature verification: <https://docs.stripe.com/webhooks/signature>
- Subscription webhooks: <https://docs.stripe.com/billing/subscriptions/webhooks>
- Checkout fulfillment: <https://docs.stripe.com/checkout/fulfillment>
- Secret key management: <https://docs.stripe.com/keys-best-practices>
- Restricted API keys: <https://docs.stripe.com/keys/restricted-api-keys>
- Product and Price modeling: <https://docs.stripe.com/products-prices/how-products-and-prices-work>
- Stripe Tax for recurring payments: <https://docs.stripe.com/billing/taxes/collect-taxes>
