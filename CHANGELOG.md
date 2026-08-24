# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.5] - 2026-08-25

### Added

- New anonymous `POST /api/v1/deployment-keys/force-deactivate` endpoint lets a deployment-key
  holder release the seat held by an activation matching a caller-supplied `deviceId`, without the
  `activationToken` issued at enrollment (#88). Authenticated by the deployment key itself and a
  recomputed `deviceId` (same `os-machine-id-sha256-v1` scheme used at enrollment), scoped to that
  key's parent license, so a machine that lost its local credentials (e.g. because it enrolled with
  a build shipping a mismatched primary/secondary key pair, so enrollment succeeded server-side but
  the client never persisted the token) can recover the seat itself instead of needing a manual
  admin `activations/{activationId}/deactivate` call. New `LicenseStore.ForceDeactivateWithinLockAsync`
  and `DeploymentKeyService.ForceDeactivateAsync`; the latter owns one Serializable transaction
  covering the activation change and every audit record for the call, so a later failure can never
  leave the seat released without its audit trail. `deviceId` is self-reported (identical to
  `enroll`'s handling of it), not a cryptographic proof of device possession, and the full hash is
  embedded in the signed license artifact, so this is rate-limited far more tightly than `enroll` —
  its own dedicated `deployment-key-force-deactivate` policy, defaulting to 5/minute per
  deployment-key prefix and 10/minute per IP — and every call, including a validation failure,
  writes an immutable `AuditRecord` (`deployment-key.force-deactivation-succeeded` /
  `deployment-key.force-deactivation-rejected`, plus `activation.force-deactivated` on the released
  activation). See the trust-model writeup in
  `docs/ai/deployment-key-machine-activation.md` for the full residual-risk discussion and the
  guidance to rotate the deployment key if abuse is suspected.

## [0.3.4] - 2026-08-25

### Added

- One-time (perpetual) purchases now generate their own invoice PDF and
  upload it to R2, linked back to the order (#84). Purchases don't have a
  Stripe Invoice object (no `invoice_creation` on the Payment Link), so a
  new `PurchaseInvoiceStripeDataProvider`
  (`src/LicenseServer/PurchaseInvoiceStripeData.cs`) sources amounts,
  currency, and payment method from the Stripe Checkout Session instead,
  and a new per-business-date `InvoiceNumberAllocator`
  (`src/LicenseServer/InvoiceNumberAllocation.cs`, mirroring
  `LicenseIdAllocator`) generates the business's own invoice number.
  `InvoicePdfService` is generalized so both the renewal and purchase paths
  build their own `InvoiceDocumentData` and hand it to a shared
  render/store/persist call, reusing the existing
  `/invoices/{orderId}/pdf` presigned-redirect endpoint rather than a new
  public URL.
- New `LicenseOrderInvoice` table records the Stripe PaymentIntent ID and
  Charge ID against every order (purchase or renewal), so a refund can be
  looked up against the right payment later without digging through Stripe
  by hand (#84).

### Fixed

- The purchase-confirmation email rendered Edition, Seats, and Expiry blank,
  and the "Request machine-wide code" button had an empty `href` (stripped
  of its styling by mail clients) because `BillingPolicies.cs` only ever
  populated `licenseId`/`activationCode` in the email model, even though the
  template expected several more fields (#83). The full model is now built
  from data already resolved during purchase processing; `expiryDate` reads
  `"Perpetual"` for non-expiring licenses, and `machineWideUrl` links to the
  existing `/support/contact` page, prefilled via its `Reason`/`LicenseId`
  query parameters.

## [0.3.3] - 2026-08-24

### Added

- Public "Contact support" page (`/support/contact`, #72) so customers have
  somewhere to reach `hello@repasscloud.com` - in particular, somewhere for
  the `purchase-activation` email's "Request machine-wide code" button to
  link to. The form (reason dropdown, reply email, optional license ID
  prefillable via `?licenseId=&reason=`, message) is handled by
  `ContactSupportService` (`src/LicenseServer/ContactSupport.cs`), which
  queues a plain-text email through the existing transactional email outbox
  (`ITransactionalEmailSender.QueueAsync`) under a new `contact-support`
  template entry in `EmailTemplates`
  (`src/LicenseServer/TransactionalEmail.cs`) rather than sending inline, so
  it gets the same retry/delivery tracking as other transactional email.
- Transactional emails now render the real `EmailTemplates/*.html` files
  (identity confirmation, password recovery, invoice, operator invitation,
  payment failure, purchase activation, renewal receipt, renewal reminder)
  instead of building ad hoc plain-text bodies (#76). `EmailTemplateRenderer`
  gained `{{#if}}` block-conditional support so templates can render
  optional sections (e.g. an invoice discount line) only when the relevant
  data is present.
- PDF invoices are now generated and stored in Cloudflare R2 (#73), and the
  renewal flow links each invoice to its generated PDF (#74). This spans a
  new QuestPDF-based invoice renderer, a Stripe invoice data provider, a
  private R2 storage backend, an `InvoicePdfService` orchestrator that wires
  it together, and a download endpoint. `RenewalAsync` now generates and
  links the invoice PDF as part of renewal processing, and the rendered PDF
  only shows a discount line when a discount was actually applied.

### Fixed

- Operators holding `users.manage` but without MFA enabled (e.g. the seeded
  default admin) had the "Add identity" form and row actions on
  `/settings/users` silently disappear with no explanation, reading as a
  recurrence of #64's stale-claims bug even though claims were fresh (#75).
  `users.manage` is a high-risk permission whose policy also requires an
  `amr: mfa` claim, only added at sign-in for accounts with two-factor
  enabled. The Users page now checks the permission claim separately from
  the full policy result and shows a banner explaining that MFA is required
  - and linking to where it can be enabled - instead of hiding the
  management UI without feedback.

## [0.3.2] - 2026-08-23

### Fixed

- One-time purchases of a fixed-seat product mapping issued licenses with
  `Seats = 1` instead of the seat count configured in `StripeProductMappings`
  (#68). `StripeBillingPolicyProcessor.PurchaseAsync`
  (`src/LicenseServer/BillingPolicies.cs`) preferred the Stripe checkout
  line item's `quantity` over the mapped seat count whenever it was
  non-zero, but for these SKUs the seat count is a fixed attribute of the
  product/edition, not something the buyer selects via quantity - a
  Payment Link checkout for a 500-seat enterprise SKU still reports
  `quantity = 1`. One-time purchases now always use the mapped `Seats`
  value; subscriptions, which genuinely use `quantity` as a seat
  multiplier, are unaffected.
- Permission-gated admin UI (e.g. "Rescan key directory" on
  `/settings/signing-keys`, the users page) stayed hidden for an existing
  session even after the account's role/permission grants changed, until
  the user logged out and back in (#64). The Blazor auth cookie's claims
  principal is only rebuilt at sign-in; a deploy that changes
  `BuiltInRoles.Matrix`, or maps a legacy `Administrator` onto
  `System Administrator`, only updates the affected role's/user's
  security stamp when *that specific user* is edited through the admin
  UI, not when the underlying permission matrix itself changes.
  `IdentityRevalidatingAuthenticationStateProvider`
  (`src/LicenseServer/Components/Account/IdentityRevalidatingAuthenticationStateProvider.cs`)
  now also compares the session's cached `permission` claims against a
  freshly generated set on every 30-minute revalidation pass, forcing
  sign-out (and a clean re-login) on a mismatch instead of silently
  keeping a stale principal.

## [0.3.1] - 2026-08-23

### Fixed

- Guest `checkout.session.completed` webhooks were silently quarantined and
  never issued a licence (#66). A one-time Payment Link checkout with
  `customer_creation: if_required` can complete without Stripe ever
  attaching a `Customer` object, leaving the webhook payload's `customer`
  field `null`. `StripeBillingPolicyProcessor.PurchaseAsync`
  (`src/LicenseServer/BillingPolicies.cs`) hard-required a non-null
  `CustomerId`, so the event landed in `WebhookInbox` as
  `Status = 'quarantined'` / `LastErrorCode = 'incomplete_purchase_state'`
  with no `Customer`/`LicenseOrder`/`License` ever created. One-time
  purchases now fall back to the verified checkout email
  (`customer_details.email`) to find/create the `Customer` record when
  Stripe didn't attach one — subscriptions still require a real
  `CustomerId`, since Stripe always provides one for those.

### Changed

- `temp/stripe-products/create-products.sh` / `.ps1` now create payment
  links with `customer_creation=always`, so new one-time Payment Links
  always get a real Stripe `Customer` regardless of guest checkout.
- The same scripts now update existing products and payment links in place
  on re-run instead of only creating missing ones — re-running after
  editing `products.csv` (new logo URL, description, tax settings, price)
  reflashes the product and, where the Stripe API allows it, the payment
  link's checkout config. Stripe does not allow changing a payment link's
  charged price or `custom_fields` after creation, so those still require
  issuing a new link; the script warns when that's the case.

## [0.3.0] - 2026-08-21

### Added

- Seat-aware multi-machine activations (#39, #43): a licence's seat count
  now actually gates activation, replacing the old single-live-activation
  behaviour. Active (non-deactivated) activations consume seats beneath one
  licence; a same-device retry is treated as recoverable rather than
  consuming a second seat; exhausting the seat count returns a clear conflict
  instead of the old blanket "already activated" rejection. Database changes:
  removed the effective one-live-activation-per-licence constraint, added a
  partial unique index on active `(LicenseRecordId, DeviceIdHash)` so one
  device can't hold two live activations, kept `(LicenseRecordId, RequestId)`
  unique for retry idempotency, and added an index to count active seats
  efficiently. Migration `SeatAwareMultiMachineActivations`. Admin license
  detail now shows seat usage (used/total), every active activation, and
  per-activation operator deactivation.
- Deployment Keys (#40, #41): a new seat-shared credential
  (`dpk_live_<publicId>_<secret>`, HMAC-SHA256 hashed via
  `DeploymentKeyHasher` with its own pepper, `DeploymentKeys__Pepper`) that
  lets a machine enroll under an existing licence — for unattended fleet
  deployment (Intune, RMM, golden images) — without distributing the
  licence's manual activation code. Full lifecycle (create / list-redacted /
  rename / rotate / revoke) via five new admin endpoints, gated by new
  `deploymentKeys.read` / `deploymentKeys.manage` permissions
  (`deploymentKeys.manage` is MFA-gated as high-risk, matching
  `licenses.revoke`/`signingKeys.manage`). New anonymous
  `POST /api/v1/deployment-keys/enroll` endpoint. Enrollment and manual
  activation-code activation now share one seat-authoritative code path
  (`LicenseStore.ActivateWithinLockAsync`, extracted from `ActivateAsync`) —
  a deployment key shares the licence's seat pool, it does not get its own.
  Revoking a key blocks new enrollment only; machines already enrolled
  through it keep their activation. New audit events:
  `deployment-key.created/renamed/rotated/revoked/enrollment-succeeded/enrollment-rejected`
  (payloads carry only `PublicId`/`LastFour`, never the secret). New
  `DeploymentKey` entity and `Activation.DeploymentKeyId` FK, migration
  `AddDeploymentKeys`.
- Deployment Key admin UI on the License Details page (#41, #53): create
  (with optional expiry, one-time secret reveal), list (name, key preview,
  created, last used, expiry, status), rename, rotate (one-time secret
  reveal), revoke. Each active-activation card now shows which deployment
  key (or "Manual activation") enrolled that device.
- Seat usage administration (#42, #48): admin license detail now exposes
  available seats, historical (deactivated) activation count, and an
  active-seat breakdown by source (manual activation vs. each deployment
  key). `AmendTermsAsync` now rejects lowering a licence's seat count below
  its current active-activation count, running inside the same
  `FOR UPDATE`-locked transaction as `ActivateAsync` so a concurrent
  amendment and activation can't race into an invalid `Active > Seats`
  state.
- Active seat count shown in the customer portal (#42, #48).
- Support for selecting multiple scopes at once when creating an API key,
  replacing the previous single-`<select>` scope field with a checkbox list
  (#54, #55).

### Fixed

- Every rate-limit policy in the app (`admin-api`, `device-api`, and the new
  deployment-key policy) was effectively non-functional from the client's
  perspective: the `OnRejected` handler wrote no response body, so the
  app's global `UseStatusCodePagesWithReExecute` silently re-executed the
  rejection into the Blazor SPA's 200 OK fallback (#44).
- Deployment-key enrollment rate limiting could be bypassed by generating a
  fresh public ID per request, since limiting partitioned solely on the
  caller-presented credential ID. Now enforces a standalone IP-keyed limiter
  ahead of any body reading, in addition to the credential-dimension limit
  (#45).
- The body-peek middleware ahead of deployment-key rate limiting read the
  entire request body before the limiter ran, and an earlier fix that gated
  the peek on a declared `Content-Length` silently skipped it for chunked
  requests — which is how every `HttpClient.PostAsJsonAsync` call in this
  repo (and any client following `LICENSING-INTEGRATION.md`) sends its body.
  Now bounded to at most 4096 bytes via `Stream.ReadAtLeastAsync` regardless
  of declared length (#45).
- Two concurrent `RotateAsync` calls on the same deployment key could both
  observe `RevokedAt == null` and both commit a live replacement key.
  `RotateAsync` now takes a `FOR UPDATE` row lock for the duration of the
  transaction (#45).
- The customer portal license view assumed at most one active activation per
  licence (`SingleOrDefault`), which stopped being safe once seats > 1 are
  actively used; fixed alongside adding `ActiveSeatCount` to the portal view
  (#48).
- Fixed a crash-on-malformed-body bug in the deployment-key rate-limit
  middleware (`JsonElement.TryGetProperty` throws on a non-object JSON
  root), reachable by any anonymous client (#44).
- Fixed a missing expiry guard in deployment-key `RotateAsync` that would
  500 instead of 409 when rotating an already-expired key (#44).
- Fixed a transaction-commit-boundary regression in the seat-checking
  refactor that would have let concurrent-load edge cases spuriously 409 on
  paths that previously always succeeded, by gating commit on
  `db.ChangeTracker.HasChanges()` (#44).
- Fixed a missing `DeploymentKeys__Pepper` entry in `compose.yaml`,
  `.env.example`, the operator runbook, and the README, which would have
  hard-failed container startup outside Development (#44).
- Fixed checkbox alignment on the API key scopes list (#55).
- CI: the activation-flow test's server-readiness poll (10s) was too short
  once the new seat-aware and deployment-key migrations plus seeding started
  running synchronously before Kestrel starts listening; bumped to 60s
  (#50). Also fixed a broken `packages.lock.json` restore step and disabled
  PDB generation for all projects.

### Known limitations

- Deployment-key enrollment rate limiting enforces the IP dimension and the
  credential dimension as two independent checks rather than one combined
  policy — ASP.NET Core's `RateLimiterOptions.AddPolicy` has no overload for
  a pre-combined `PartitionedRateLimiter` (#45).

## [0.2.1] - 2026-08-16

### Changed

- Rotated the `primary-2026` and `secondary-2026` signing keys. The prior
  key pairs' private keys were lost, so all licences previously signed with
  them (test licences only) can no longer be verified. New key pairs were
  generated with `LicenseGenerator keygen` and `Licensing.Core.TrustedPublicKeys`
  now embeds the new public keys under the same key IDs. Any product built
  against a `Licensing.Core` older than this version will not trust licences
  signed after this rotation and must be rebuilt against the updated package.

## [0.2.0] - 2026-08-16

### Added

- Design specification for a multi-key **key-ring signing and rotation**
  architecture (`docs/superpowers/specs/2026-08-14-key-ring-signing-design.md`).
  It replaces the single configured signing key with hot-reloadable, directory-
  scanned keys, an authoritative Postgres-backed default, distinct
  rotate/retire/revoke operations, and a supported path for importing licenses
  produced offline by `LicenseGenerator`. Implemented since as a reduced core
  slice; the license-import feature now has both a working API and an admin
  UI page (see below).
  `LicenseValidator`'s embedded trust model is explicitly out of scope and
  unchanged.
- `Licensing.Core.LicenseEnvelope` — the single envelope-construction and
  signing implementation, now called by both `LicenseServer`'s online signing
  path and the offline `LicenseGenerator` CLI, so canonicalization and
  signature rules cannot drift between them.
- `Licensing.Core.SigningKeyFiles` — the `<keyId>.private.pem` /
  `<keyId>.public.pem` naming convention and key-ID rules in one place, shared
  by the server's key directory scanner and the CLI.
- `LicenseGenerator keygen --id <keyId> --output <dir>`, writing exactly the
  filenames the server's key directory scanner discovers. Generated private
  keys are mode `600` on POSIX platforms, requested at file-creation time;
  Windows has no POSIX mode and the command says so.
- `LicenseGenerator sign --public-key <path>`, overriding the public key the
  private-key/key-ID pair check runs against.
- `LicenseGenerator sign` now hard-fails before signing if the resolved key ID
  is present in `TrustedPublicKeys.ByKeyId` and the on-disk public key doesn't
  match the compiled entry. This restores the guarantee moving the pair check
  off `TrustedPublicKeys` gave up: a locally regenerated pair reusing an
  existing key ID (e.g. `keygen --id primary-2026 --force`) is rejected before
  anything is signed, instead of quietly producing licences every released
  validator rejects. A key ID absent from `TrustedPublicKeys` — the normal
  key-ring case — still signs exactly as before, with no warning; the map is
  consulted only as a negative check, never as an allowlist for which key IDs
  may sign.
- Recorded decisions for the four open license-import design questions —
  catalog handling for unknown products, the email source for metadata-free
  imports, activation credentials on pre-activated imports, and verbatim
  artifact storage — and then implemented all four (see below).
- `POST /api/v1/admin/licenses/import` (permission `licenses.import`,
  multipart, 256 KB limit): verifies an offline `LicenseGenerator`-signed
  artifact against the live signing-key ring, then stores it byte-for-byte in
  new `bytea` columns (`LicenseRecord.ImportedSignedEnvelope` /
  `ImportedSignedEnvelopeSha256`) alongside a relational `Entitlement` index
  built from it — the stored bytes remain the source of truth, never
  regenerated or resigned. `contactEmail` is a required form field and the
  source of truth for the resolved customer, validated to match the
  artifact's own `metadata.contactEmail` when present rather than silently
  preferring either one. A product absent from the catalog is auto-created
  with `IsActive = false`, so an import can never silently add a sellable
  catalog entry. A pre-activated import gets an `Activation` row with a
  random, discarded-preimage token, so device-facing refresh and
  deactivation both fail closed by construction; admin-side license revoke
  is the supported lifecycle action for it. Writes a `license.imported`
  audit record, plus one `product.auto-created` record per auto-created
  product. New migration `LicenseImport` also replaces
  `Entitlement`'s one-per-license unique index with a composite
  `(LicenseRecordId, Product)` index, since an imported multi-product
  license legitimately has more than one `Entitlement` row per
  `LicenseRecord`; the admin license-terms edit panels and the customer
  portal's license view are guarded against that case rather than crashing
  on the entitlement list's now-possible multiple rows. Term amendments are
  also blocked for every imported license, including the common
  single-product case that has exactly one entitlement: the signed
  artifact, not this relational index, remains the source of truth, and
  amending here would silently diverge from it.
- Admin UI page for license import, `/licenses/import` (gated on
  `Permissions.LicensesImport`, linked next to "Offline issuance" in the nav
  and on the Licenses list): a Blazor `InputFile` form with a required
  contact-email field, calling `LicenseImportService.ImportAsync` directly —
  the same service the HTTP endpoint uses, so there is exactly one import
  implementation. `IBrowserFile.OpenReadStream` is capped at the same
  256 KB the backend already enforces; no Blazor Server SignalR limit change
  was needed since `InputFile` streams file bytes in chunks that respect the
  default limit regardless of the file's own size. Shows the resulting
  license ID, its products, and any auto-created products still needing
  catalog review (linked to the filtered product list), or the specific
  validation error otherwise. `LicenseRecord.Provenance` is now also surfaced
  in the admin license list (an "Imported" badge) and detail view (a
  Provenance/Imported-at field), so operators can tell an imported license
  apart from a server-issued one at a glance. (#35)
- `POST /api/v1/admin/signing-keys/rescan` (and the Blazor "Rescan key
  directory" button, which now goes through the same `RescanAsync` method)
  write an `AuditRecord` (`signingKey.rescan`), matching `set-default` and
  `revoke`. Written unconditionally, on every invocation, not only when the
  rescan changes the published key-ring snapshot.
- CI now runs on pull requests and pushes to `dev`, not only `main`.
- A `test-bash-license-flow` CI job runs `scripts/test-license-flow.sh` on
  `ubuntu-latest`, covering the bash port of the license-flow scripts that
  CI previously never exercised.
- Bash equivalents of the PowerShell scripts in `scripts/`
  (`new-demo-licenses.sh`, `new-offline-activation-request.sh`,
  `test-database-and-auth.sh`, `test-activation-flow.sh`,
  `test-license-flow.sh`) for running the demo-licensing, offline-activation,
  and integration-test flows from macOS/Linux shells.

### Changed

- `LicenseGenerator sign` checks the selected private key against the
  `<keyId>.public.pem` PEM pair on disk instead of the hardcoded
  `TrustedPublicKeys` map. A signing key created the key-ring way — dropping
  two PEM files into the key directory — can now be used by the offline
  generator immediately, with no `TrustedPublicKeys.cs` edit or CLI rebuild.
  The public half is located by key ID rather than by rewriting the private
  key's filename, so the check still catches a private-key/key-ID mismatch.
  One consequence: signing a private key stored outside the
  `<keyId>.private.pem` convention, with no public half beside it, now requires
  the new `--public-key`. A second consequence — the check no longer proving
  the key ID is one shipped products trust — is addressed below.
- `LicenseGenerator sign --key-id` is optional, derived from a
  `<keyId>.private.pem` filename and still overridable.
- The key-ring contracts (`ILicenseKeyRing`, `ILicenseSigner`,
  `ILicenseVerifier`, `SigningKeyInfo`, `SigningKeyStatus`,
  `LicenseSigningResult`) moved from `LicenseServer` into `Licensing.Core` as
  pure contracts, making them reachable from `LicenseGenerator`.
  `Licensing.Core` still has no ASP.NET Core or EF Core dependency.
- The key-ring design spec now records the absence of a `FileSystemWatcher` as
  a settled rejected alternative with its reasoning, rather than leaving the
  shipped periodic-reload behavior contradicting the written design.
- Repository-local `.claude/settings.json` now ships a minimal, schema-valid
  permission set (`dotnet build`/`test`/`restore`, read-only `git` commands)
  in place of an earlier overly broad, non-schema-valid draft.

### Fixed

- README's production-hardening guidance referenced `LicenseEnvelopeSigner`,
  a class deleted when the signing key ring landed. It now names the current
  signing component (`SigningKeyRingService` behind `ILicenseSigner`).
- CI's "Database and authentication" test leg filtered on `Suite=Baseline`, an
  allowlist matching only 4 of 152 tests. Every other suite — including the
  entire signing-key-ring test suite and several test classes with no `Suite`
  trait at all — silently never ran in CI. Switched to excluding
  `Suite=Phase0Roadmap` (the intentional-red executable specification)
  instead, so everything meant to pass runs: 106 of 152 tests, all green.
- The `/licenses/import` page injected `LicenseImportService` (and its
  `ApplicationDbContext`) directly, so using "Import another" repeatedly
  reused the same circuit-scoped `DbContext` for as long as the tab stayed
  open: every import's tracked entity graph accumulated, and a failed save
  could leave stranded tracked entities colliding with later imports in the
  same tab. Each submission now resolves `LicenseImportService` from a
  fresh `IServiceScopeFactory` scope, disposed right after — the same
  scope-per-operation pattern `SigningKeyRingService` already uses.
- `POST /api/v1/admin/licenses/import`'s pre-parse size guard rejected some
  legitimately-sized files: it bounded `request.ContentLength` (the whole
  multipart body, including boundaries, per-part headers, and the
  `contactEmail` field) against the 256 KB artifact limit itself, so a file
  right at that limit could be rejected before the accurate post-parse
  `file.Length` check ever ran. The pre-check now allows headroom for
  multipart framing overhead; the artifact limit is still enforced exactly
  against `file.Length`.
- `EcdsaKeyPairs.TryValidatePair`, `TryValidatePublicKey`, and
  `PublicKeysMatch` never checked that imported key material was actually on
  the NIST P-256 curve. A self-consistent key pair generated on another curve
  (e.g. P-384) passed `TryValidatePair` cleanly, while `LicenseEnvelope.Sign`
  still hardcoded the envelope's `algorithm` field to `ECDSA-P256-SHA256`
  regardless of the curve actually used, producing a mislabeled artifact. All
  three methods now reject any key not on P-256; the two `Try*` methods
  return `false` with an explanatory error, and `PublicKeysMatch` throws
  `CryptographicException`, consistent with its existing exception-based
  contract for malformed input. Purely additive: every key in `keys/` and
  every key `LicenseGenerator keygen` produces is already P-256. (#32)
- That same P-256 curve check compared only the named-curve OID, so a PEM
  encoding genuinely P-256 domain parameters explicitly instead of by name
  (e.g. `openssl ecparam -param_enc explicit`) was wrongly rejected as an
  "unrecognized curve" — the opposite of the check's intent. Falls back to
  comparing the field prime, curve coefficients, generator point, and order
  against P-256's published domain parameters when the curve has no named
  OID. Also catches `PlatformNotSupportedException` in the two `Try*`
  methods: platforms whose ECDsa backend cannot import explicit-curve PEMs
  at all (confirmed on macOS) now fail validation cleanly instead of
  crashing with an unhandled exception.
- `SigningKeyFiles.IsValidKeyId` anchored its pattern with `$`, which .NET
  regex matches immediately before a trailing newline as well as at the true
  end of the string. A key ID such as `"primary-2026\n"` passed validation,
  which would have let `keygen --id` write a PEM filename containing a
  newline. Anchored with `\z` instead, which admits no exception.
- `POST /api/v1/admin/signing-keys/rescan` wrote a `Result = "success"` audit
  record even when the underlying reload failed and silently kept the old
  key-ring snapshot (`ReloadAsync` catches and logs reload failures rather
  than throwing). `ReloadAsync` now reports whether it actually published a
  new snapshot; a failed rescan throws instead of writing a misleading
  success record, matching how every other signing-key mutation here already
  fails before auditing.
- Upgrading an existing database straight into the key-ring feature never
  elected a default signing key. The pre-key-ring `DatabaseInitializer` had
  already unconditionally seeded a `primary-2026` `SigningKeys` row on every
  startup, so by the time `SigningKeyRingService.ReloadAsync`'s bootstrap-seed
  check ran against an upgraded database, `SigningKeys` was no longer empty
  and the check never fired — every activation/refresh signing request then
  failed with `no_default_key` until an administrator picked a default by
  hand. New migration `SeedDefaultSigningKeyForUpgrade` backfills
  `IsDefault = true` onto that lone pre-existing row. A brand-new install has
  zero `SigningKeys` rows at migration time and is unaffected, still relying
  on the runtime bootstrap seed; a database with more than one pre-existing
  row never went through the old single-key initializer, so it is left for an
  administrator to pick a default explicitly rather than guessed at here.
- `appsettings.Container.json` set `RequireMfaForHighRiskPermissions: false`,
  and the published container image bakes in `ASPNETCORE_ENVIRONMENT=Container`
  by default, so a production deployment run as shipped — with no explicit
  override — silently disabled the MFA requirement for `users.manage`,
  `apiKeys.manageAll`, `licenses.revoke`, and `signingKeys.manage`. Reverted to
  `true`. The local-only reason it had been flipped (the seeded Compose admin
  has no MFA enrolled, which hid the Users page's "Add identity" panel) is now
  an explicit `Security__RequireMfaForHighRiskPermissions=false` override in
  `compose.yaml` instead of the shared container default.
- `/activate` and `/refresh` (and their Blazor admin equivalents on the
  license-details and offline-issuance pages) committed the activation or
  lease refresh before attempting to sign the returned license artifact. When
  the key ring had no usable signing key at that moment — no default
  configured, or the selected/default key had just been retired or revoked —
  the caller received a failure with no artifact, and activation's own
  request-ID idempotency check then reported the license as already active on
  any retry with a fresh request ID, leaving it permanently stuck. `ILicenseSigner`
  gained `CanSign(requestedKeyId)`, a cheap pre-flight version of `Sign`'s
  key-resolution logic with no private-key import or signature; `LicenseStore
  .ActivateAsync`/`RefreshAsync` now call it before mutating any state and
  return `503` instead of committing when no key can currently sign.

## [0.1.0] - 2026-08-14

Initial tracked release. Brings together the signed-license toolchain and the
PostgreSQL-backed `LicenseServer` administration/licensing service built out
over the project's first development cycle.

### Added

**Signing and validation toolchain**

- `Licensing.Core`: shared license contract, canonical JSON, and schema
  validation used by every signer and verifier so their interpretation of a
  license cannot drift independently.
- `LicenseGenerator`: ECDSA P-256 key generation and offline license signing
  CLI, with private-key/key-ID sanity checks against the trusted key map.
- `LicenseValidator`: signature, schema, product, and expiry validation CLI
  with embedded public keys and device-ID display, for fully offline
  end-product verification.
- Device-binding model (`DeviceIdentity`) hashing an OS installation ID with a
  product namespace, plus documented transfer/invalidation state machine
  (`available → active → deactivated → active`, with `revoked` as terminal).

**LicenseServer core lifecycle**

- Server-generated, immutable `LIC-{yyyy}-{MMdd}{value:X6}` license IDs,
  allocated atomically through a PostgreSQL counter upsert with per-day
  rollover protection.
- Full lifecycle coverage: issue, online/offline activate, refresh, deactivate
  and transfer, cancel, and revoke — enforced with serializable/read-committed
  transactions and a partial unique index limiting one live activation per
  license.
- Secure, cryptographically random activation codes and bearer tokens, shown
  once and stored only as SHA-256/HMAC hashes at rest.
- Authoritative, signature-covered `metadata.contactEmail` snapshot on every
  issued license, enforced as a database invariant independent of the
  customer's current email.
- Administratively managed product and edition catalogs, replacing free-text
  product entry, with archival that preserves historical references.

**Administration, identity, and access**

- Permission-based RBAC with seven built-in roles (System Administrator,
  License Manager, License Issuer, Support Agent, Product Administrator,
  Auditor, Billing Automation) enforced at the action level on both UI and API.
- ASP.NET Core Identity with MFA (TOTP + one-time recovery codes) and WebAuthn
  passkeys; production requires an MFA-authenticated principal for high-risk
  permissions.
- Operator and service-account administration, including invitation, forced
  password setup, role changes, and safe disable/demotion that always leaves
  one enabled System Administrator.
- Scoped bearer API credentials (`lic_live_<public-id>_<secret>`) with
  versioned HMAC digests at rest, mandatory expiry for human-owned keys, and
  atomic rotation/revocation.

**API surface**

- Versioned `/api/v1/admin` REST API mirroring UI authorization policies, with
  bounded DTOs, ETag/`If-Match` concurrency on terms updates,
  `Idempotency-Key` support on issuance, `X-Correlation-ID` on every response,
  and a generated OpenAPI 3.1 document at `/openapi/v1.json`.
- Public device APIs for activation, validation, refresh, and deactivation.

**Notifications and customer access**

- Durable transactional email outbox (MailerSend-backed) covering purchase,
  renewal, payment failure, invoice, operator invitation, Identity, and
  magic-link templates, with `FOR UPDATE SKIP LOCKED` batch claiming, bounded
  retries, and signature-verified inbound webhooks.
- Passwordless customer portal: email-challenge magic links, a scoped,
  short-lived customer session distinct from operator Identity, and read-only,
  redacted license/device projections.

**Billing**

- Verified, idempotent Stripe webhook ingestion (raw-body signature check
  before any parsing or side effects) with a `WebhookInbox` and
  `FOR UPDATE SKIP LOCKED` billing worker.
- Idempotent licensing policy engine: monotonic renewals, configurable payment
  grace, paid-through cancellation, refund/dispute review actions, and
  provider-ID mapping tables kept separate from provider-neutral billing
  models.
- Operator billing tooling: redacted event listing and safe reprocessing at
  `/api/v1/admin/billing/events`.

**Operations and delivery**

- Append-only audit trail for every sensitive mutation, with actor, action,
  target, and correlation context.
- Hardened Docker Compose deployment: non-root app user, read-only root
  filesystem, dropped capabilities, `no-new-privileges`, and explicit volumes
  for PostgreSQL and Data Protection keys.
- CI workflow for build/test on the .NET solution.
- PowerShell test suites covering license/activation flows, database and auth
  invariants, and container smoke testing; offline issuance/import scripts.
- Operator runbook (`docs/operator-runbook.md`) and full acceptance
  traceability matrix (`docs/roadmap-traceability.md`).

### Fixed

- Gated Stripe purchase fulfillment on `payment_status` and handled the
  `async_payment_succeeded` follow-up event for delayed payment methods.
- Ignored `invoice.payment_failed` once an invoice is already recorded paid,
  preventing reordered webhooks from pushing a paid contract back into grace.
- Fetched canonical subscription state for `subscription.created`/`updated`
  events instead of trusting a potentially stale webhook payload.
- Bound `Billing:WorkerEnabled` config to the background billing worker so
  disabling it actually stops processing.
- Sanitized legacy `Entitlements.Product` values into unique, constraint-safe
  product codes during catalog backfill migration, instead of failing on real
  historical data.
- Revoked a user's API credentials whenever their roles are reduced, not only
  when the account is disabled.
- Let failed Stripe current-state reconciliation retry with backoff instead of
  being marked terminal and silently dropped.
- Scoped the customer portal's license listing to every `Customer` record
  sharing the session's normalized email, since each issuance creates its own
  `Customer` row.
- Aligned the container SDK image with the `global.json` pin.

### Security

- Activation codes and bearer tokens are never stored in plaintext — only
  SHA-256 or versioned HMAC-SHA-256 digests.
- Stripe and MailerSend webhooks are verified against the raw request body
  with fixed-time signature comparison before any parsing or database writes.
- Rotated the 2026 primary/secondary license signing keys and their embedded
  public-key trust map.
- Removed the legacy `local-poc-admin-key` header-based admin bypass.

[Unreleased]: https://github.com/repasscloud/license-server-app/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/repasscloud/license-server-app/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/repasscloud/license-server-app/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/repasscloud/license-server-app/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/repasscloud/license-server-app/releases/tag/v0.1.0
