# Stripe Integration Overview

How Stripe communicates with the app, and what the app expects when it does.

## Entry point

`POST /api/v1/integrations/stripe/webhook` ([Program.cs:596](../src/LicenseServer/Program.cs)).

Stripe POSTs raw event JSON here with a `Stripe-Signature` header on every configured event.

## 1. Verify, don't trust

The handler reads the raw body plus the signature header and calls:

```csharp
Stripe.EventUtility.ConstructEvent(rawBody, signature, WebhookSecret, tolerance: 300, throwOnApiVersionMismatch: false)
```

([StripeWebhook.cs:59-64](../src/LicenseServer/StripeWebhook.cs))

A missing or invalid signature is rejected immediately with `invalid_signature`. The webhook secret comes from the `STRIPE_WEBHOOK_SECRET` env var (`Stripe:WebhookSecret` config), required outside Development.

## 2. Inbox, not inline processing

The HTTP handler does no business logic. It:

1. Encrypts the raw payload via DataProtection (`ProtectedPayload = protector.Protect(rawBody)`)
2. Inserts it into a `WebhookInbox` table with status `pending`
3. Dedupes on `ProviderEventId` via a unique-constraint catch ([StripeWebhook.cs:104-116](../src/LicenseServer/StripeWebhook.cs))

This makes the endpoint fast and idempotent — Stripe's automatic retries are safe, and nothing is processed twice.

## 3. Async processing

A background `BillingInboxWorker` ([StripeWebhook.cs:225-253](../src/LicenseServer/StripeWebhook.cs)) polls the inbox:

- `FOR UPDATE SKIP LOCKED` row leasing
- Exponential backoff retry
- Dead-letters rows after a configurable max attempt count

Each leased row flows through:

`StripeBillingEventProcessor` → normalizes payload into a `BillingSnapshot` (refetching current Stripe state via `StripeCurrentStateFetcher` if the webhook payload is incomplete) → `StripeBillingPolicyProcessor.ApplyAsync` ([BillingPolicies.cs:53](../src/LicenseServer/BillingPolicies.cs)), executed under a Postgres advisory lock.

## Events the app expects

| Event(s) | Category | Effect |
|---|---|---|
| `checkout.session.completed`, `checkout.session.async_payment_succeeded` | Checkout | Creates/reuses `Customer`, `BillingContract`, `LicenseOrder`, and Stripe customer/checkout-session mappings; **issues a new license** via `LicenseStore.IssueForBillingAsync`; queues an activation email. Two paths, branched on whether the session has a `subscription`: subscription checkouts resolve edition/license type/seats from `StripePriceMapping` (keyed on Stripe price ID) and use `current_period_end` as the expiry, also creating a `StripeSubscriptionMapping`; one-time (`mode: "payment"`) checkouts resolve terms from the extended `StripeProductMapping` row (keyed on Stripe product ID — edition/license type/seats/updates-until/expires-at, manageable at **Settings → Stripe product mappings**) with no subscription mapping created. A Stripe custom field with key `poref` (if present) is read from `custom_fields[].text.value` and stored as `metadata.purchaseOrder` on the issued license. |
| `invoice.paid` | Renewal | Extends license terms via `LicenseStore.ApplyBillingTermsAsync`; records a renewal order; queues a receipt email |
| `invoice.payment_failed` | Payment failure | Puts the contract into a grace period (`BillingPolicyOptions.GracePeriodDays`, default 7); shortens license terms accordingly; queues a payment-failure email |
| `customer.subscription.created/updated/deleted` | Subscription | Updates seats/edition/period end/cancel-at-period-end on the contract and license, or marks the contract `ended` on delete |
| `charge.refunded` | Refund | Configurable `review` or `suspend` action (`BillingPolicyOptions.RefundAction`); can revoke license terms immediately |
| `charge.dispute.created/closed` | Dispute | Same as refund, via `BillingPolicyOptions.DisputeAction` |
| anything else | Unsupported | Ignored |
| Incomplete/unmappable payloads | — | Marked `quarantined` rather than applied blindly |

## Config / env vars

| Setting | Source | Notes |
|---|---|---|
| `Stripe:ApiKey` | `STRIPE_API_KEY` | |
| `Stripe:WebhookSecret` | `STRIPE_WEBHOOK_SECRET` | Used for signature verification |
| `Stripe:ApiVersion` | `appsettings.json` | Pinned to `2026-07-29.dahlia`, enforced at startup ([Program.cs:227-228](../src/LicenseServer/Program.cs)) |
| `BillingWorkerOptions` | `appsettings.json` | Worker enabled flag, batch size, max attempts, lease seconds |
| `BillingPolicyOptions` | `appsettings.json` | Grace period days, refund/dispute action |

## Where the code lives

- `src/LicenseServer/StripeWebhook.cs` — webhook receiver, inbox model, background processor
- `src/LicenseServer/BillingPolicies.cs` — event parsing (`BillingSnapshot`), Stripe state fetcher, policy engine
- `src/LicenseServer/Program.cs` — DI wiring (lines 183, 204-208, 222-228), webhook endpoint (line 596), admin read endpoint (line 784)
- `src/LicenseServer/Data/Entities.cs`, `Data/ApplicationDbContext.cs` — `WebhookInbox`, `BillingContract`, `LicenseOrder`, `Stripe*Mapping` entities
- `src/LicenseServer/Data/Migrations/20260813230126_StripeBilling.cs` — schema for the above
- `src/LicenseServer/Data/Migrations/20260821162258_ExtendStripeProductMappingForOneTimePurchases.cs` — adds `Edition`/`LicenseType`/`Seats`/`UpdatesUntil`/`ExpiresAt` to `StripeProductMapping` for the one-time-purchase path
- `src/LicenseServer/StripeProductMappings.cs`, `Components/Pages/StripeProductMappings.razor` — admin CRUD service and UI for the Stripe product ID → license terms matrix
- `src/LicenseServer/LicenseServer.csproj` — `Stripe.net` package reference
- `src/LicenseServer/appsettings.json` — `Stripe` config section
- `.env.example`, `compose.yaml` — env var wiring
- `tests/LicenseServer.Tests/StripeWebhookTests.cs`, `BillingPolicyTests.cs` — test coverage

See also [`LICENSING-INTEGRATION.md`](../LICENSING-INTEGRATION.md) and [`docs/operator-runbook.md`](operator-runbook.md) for the operator-facing narrative.
