# Prompts 09-13 Administration and Customer Access Design

## Scope

This design implements roadmap stages 09 through 13 in the existing .NET 10
Blazor/Minimal API monolith. It extends the current ASP.NET Core Identity,
permission policies, PostgreSQL model, audit trail, and shared licensing services.
It does not introduce a second operator store, expose secrets after their one-time
response, or add the Stripe work reserved for later stages.

## Architectural decisions

- Keep browser operators on the existing Identity cookie and add a separate
  `LicenseServer.ApiKey` bearer scheme selected only when `Authorization: Bearer`
  is present. Both principals receive the existing `permission` claims and use the
  same authorization policies.
- Represent service accounts as disabled-for-interactive-login `ApplicationUser`
  records. This keeps ownership, roles, audit actors, and API-key revocation in one
  model without allowing service accounts to obtain browser sessions.
- Put high-risk invariants in scoped services and PostgreSQL transactions. The
  final enabled System Administrator is protected by a transaction-scoped advisory
  lock so concurrent disable/demotion requests serialize before recounting admins.
- Hash one-time secrets with versioned HMAC-SHA-256 and independently configured
  peppers. Public lookup identifiers remain non-secret. Compare digests with
  `CryptographicOperations.FixedTimeEquals`.
- Keep administrative HTTP DTOs separate from EF entities. UI and API handlers call
  the same user, credential, license, product, customer, audit, and email services.
- Use ASP.NET Core 10 first-party OpenAPI generation. The document describes cookie
  and bearer schemes, permissions, pagination, concurrency, idempotency, and
  one-time-secret behavior.
- Persist encrypted email payloads in PostgreSQL. Business work and its email row use
  the same `ApplicationDbContext` transaction; a hosted worker leases committed rows,
  releases the database transaction, calls the provider, and then records the result.
- Use MailerSend's HTTP Email API directly. A successful `202` must include
  `x-message-id`. Delivery webhooks are authenticated by fixed-time comparison of the
  documented hex HMAC-SHA-256 `Signature` over the untouched request body.
- Customer access has its own cookie scheme and claim namespace. A customer session
  can read only the customer ID embedded by successful challenge consumption and is
  never evaluated against operator permission policies.

## Stage 09: operator and service-account administration

`ApplicationUser` gains account type, enabled/disabled state, and disabled audit
fields. `UserAdministrationService` returns explicit projections containing only ID,
email, account type, enabled state, roles, derived permissions, MFA status, and API-key
count. It creates human invitations without an administrator-selected password and
creates non-interactive service accounts without password credentials.

Human invitation and forced-reset links use Identity password-reset tokens with a
15-minute Data Protection token lifespan. Successful reset changes the security stamp,
making the token single-use. Until stage 12 is committed, Development may return the
new link once in the mutation response; Production never reveals it and requires an
email sender. Stage 12 removes this temporary reveal.

Disable, enable, role replacement, invite, and reset initiation require
`users.manage`. Disable and role replacement acquire the PostgreSQL advisory lock and
reject any change that would leave no enabled System Administrator. Disable updates
the Identity security stamp and calls `IOwnedCredentialRevoker`, which stage 10
implements. Service accounts cannot receive passwords, MFA, passkeys, or interactive
sessions. Every mutation writes a redacted audit row.

## Stage 10: scoped bearer credentials

`ApiCredential` stores a random public ID, name, owner, normalized JSON scope list,
HMAC version/digest, last four secret characters, and lifecycle timestamps. Full keys
use `lic_live_<public-id>_<base64url-secret>` with 32 random secret bytes. Create and
rotate return the full value once. Human-owned credentials require an expiry;
service-account expiry remains optional.

The bearer handler parses only `Authorization`, looks up by public ID, rejects missing,
expired, revoked, or disabled-owner records, verifies the HMAC in fixed time, and emits
owner plus existing permission claims constrained to the stored scopes. Last-used
updates are coalesced so ordinary concurrent use does not write on every request.
Rotation inserts a successor and revokes the prior credential in one transaction.
Expired and revoked credentials never return to active state. Disabling an owner
revokes all owned credentials through the stage 09 hook.

Cookie mutations continue to validate antiforgery. API-key-authenticated mutations do
not, because their credential is explicitly supplied in an authorization header.
Administrative API traffic uses a principal-and-IP partitioned limiter, and device
credential routes use a stricter IP limiter.

## Stage 11: complete administrative API

`/api/v1/admin` exposes bounded, stable license pagination; issuance; detail; terms
patch; cancellation; revocation; activation-code rotation; operator deactivation;
product list/create/update/archive; customer search/update; user list/create/update;
API-key management; and filtered audit. Each route declares its roadmap permission.
Missing/invalid authentication returns 401; an authenticated principal lacking the
permission receives 403.

Updates accept `If-Match` with a quoted numeric version or the existing explicit
version field. Detail responses emit `ETag`. A correlation middleware accepts a valid
incoming `X-Correlation-ID` or creates one and echoes it in the response. Validation
uses RFC 9457-style `application/problem+json` responses with field error maps.

Durable idempotency binds the key digest to principal, route, and a canonical JSON
fingerprint for create/integration mutations. Replays within 10 minutes return the
stored status and protected response body; reusing the key for different input returns
409. License issuance retains its existing transactionally stored one-time activation
code replay. Activation-code rotation is itself transactionally idempotent and retains
the protected plaintext only for the retry window.

The OpenAPI document is served at `/openapi/v1.json` and is generated by
`Microsoft.AspNetCore.OpenApi`. It documents both security schemes and the operational
contracts above. Device-facing anonymous endpoints remain outside the admin group.

## Stage 12: transactional email and MailerSend

`EmailOutbox` stores template name/version, protected recipient and model JSON,
idempotency key digest, state, attempt/lease timestamps, provider message ID, and
retention timestamp. The unique idempotency digest suppresses duplicate business
enqueue attempts. `ITransactionalEmailSender` queues approved templates including
purchase/activation, renewal, payment failure, invoice, operator invitation, Identity
confirmation/recovery, and customer magic link.

The worker claims rows with PostgreSQL `FOR UPDATE SKIP LOCKED`, commits the lease,
sends outside a transaction, and records success or bounded exponential-backoff retry.
Permanent validation/authentication failures stop retrying. Provider calls carry an
outbox correlation header when the MailerSend plan supports custom headers; the
database remains the source of send eligibility. An ambiguous provider timeout is
marked for operator reconciliation instead of blindly resending, preventing silent
duplicates at the cost of possible manual recovery because MailerSend documents no
Email API idempotency key.

Production requires `Email:Transport=MailerSend`, `MailerSend:ApiToken`,
`MailerSend:FromEmail`, `MailerSend:FromName`, template IDs, and
`MailerSend:WebhookSigningSecret` from secret configuration. Development defaults to
an in-memory capture transport and never calls the network. Identity email operations
queue through the same abstraction. The stage 09 development link reveal is removed.

The webhook reads raw bytes, verifies `Signature`, parses only after verification,
deduplicates provider activity IDs, and updates delivery/bounce/complaint status by
provider message ID. It never changes license state.

## Stage 13: passwordless customer access

The request form accepts email and optional license ID but always returns the same
message and status. Email, license, and IP identifiers are normalized then HMAC-hashed
for challenge storage and rate limiting. A valid customer match enqueues one magic-link
message with a 32-byte random token; only its HMAC is stored. The link expires after
12 minutes and is consumed under a row lock so concurrent requests can create only one
session.

The customer cookie is HttpOnly, SameSite Strict, secure outside Development,
non-sliding, and short-lived. Successful challenge consumption signs out any prior
customer session before issuing a new one. Request and logout POSTs use antiforgery.
The portal query is rooted in the authenticated customer ID and returns approved
license/product/edition/seats/expiry/status fields, activation state, and only the
stored redacted device suffix. Perpetual expiry renders as `Never`.

Activation codes and hashes, full device identifiers/tokens, audit records, signed
metadata, operator controls, and other customers are absent. Deactivation, contact
change, and renewal mutations are explicitly unavailable and require a new design with
a fresh challenge.

## Verification and delivery

Each stage starts with failing integration/unit tests, implements the minimum behavior,
runs its targeted filter plus the full PostgreSQL suite, generates its migration, and
ends in a dedicated commit. Final verification includes Release build, the complete
database suite, clean migration/seed replay, OpenAPI inspection, fake-email smoke flow,
customer browser-route smoke checks, and Docker image build. The feature branch is then
pushed and opened as a pull request into `dev`.
