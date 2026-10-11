# REPASSCLOUD LICENSE SERVER — COMPLETE REWRITE

> **Instruction to Claude Code:** Execute this inside the root of the locally cloned `repasscloud/license-server-app` repository. This is a working implementation mandate, **not** a request for architectural suggestions, a plan-only response, a cosmetic refactor, or a C# port.
>
> **COMPLETE REWRITE. COMPLETE REWRITE. COMPLETE REWRITE.**
>
> Date of brief: 11 October 2026. Verify rapidly changing third-party platform details against current official documentation rather than treating this date or particular numeric limits as timeless.

## 0. Outcome and authority

Replace the existing .NET/Blazor licensing proof of concept with a **production-oriented, multi-product, multi-version, data-driven licensing and commerce platform**, natively deployable as a **Cloudflare Worker on the Free plan**, backed by **Supabase-hosted PostgreSQL**, using **Stripe** for checkout/billing and **MailerSend** for transactional email.

Production entry point: **`https://license-server.repasscloud.com`**. `repasscloud.com` is already hosted in Cloudflare.

The system must serve: (1) public and machine-to-machine licensing APIs; (2) a customer portal; (3) a separate administration portal; (4) a secure, documented, scriptable **admin API that works from a terminal without a browser session**; (5) Stripe and optional MailerSend webhook receivers; and (6) operational jobs supported by the free platform.

**Non-negotiable conceptual model:** PostgreSQL holds all first-party product/catalogue/licensing configuration and business state. Stripe handles actual money movement, billing objects, and externally authoritative payment/subscription events; MailerSend delivers mail. Neither Stripe nor the Worker source code is the master product catalogue.

Do not assume CurseDelete is the only or primary future product. Do not bake any one application's pricing, feature mapping, licensing term, activation model, device policy, or signing-key selection into shared server code. Onboard future products and versions with database-backed configuration, not code changes.

### Authoritative sources — read FULLY before editing

1. Existing local repository (including `.claude`, `CLAUDE.md` if present, README, solution/source, migrations, tests, infra, GitHub Actions, existing admin/security/business functions): https://github.com/repasscloud/license-server-app/tree/main
2. Current *application/server wire contract and test vectors*: https://raw.githubusercontent.com/repasscloud/cursedelete-2/refs/heads/main/docs/LICENSING-SERVER-BRIEF.md
3. *Licensing architecture and domain concepts*: https://raw.githubusercontent.com/repasscloud/cursedelete-2/refs/heads/main/docs/LICENSING-ARCHITECTURE.md
4. Relevant CurseDelete conformance checker/ADR if useful for interoperability. Inspect but do not modify that application repository.
5. Current official Cloudflare Workers, Hyperdrive, Web Crypto, Stripe Checkout/Billing/Webhooks, MailerSend API, Supabase PostgreSQL and security documentation. Links under §22.

**Priority on conflicts:**

- **This prompt supersedes application-specific business-policy assumptions** from the CurseDelete documents **for the generic server**. Example: do not assume subscriptions exist only for Business or that Enterprise must be perpetual for every product. Those are *product policy decisions*.
- **The licensing-server brief remains binding for every existing client using its `repass-*-v1` protocol.** Do not issue a licence that CurseDelete's already-implemented v1 verifier will reject. Respect exact endpoints, wire IDs, JSON claims, byte-level signatures, error codes, and client expectations for such clients.
- If a future product configuration cannot be expressed safely in v1 (such as a subscription Enterprise edition when its v1 verifier rejects that), **design an explicitly versioned protocol/schema and advertised product capability**. Do not silently reinterpret v1 or change an old client's contract. Build a clean extensibility boundary; fully implement the specified v1 contract now, and only claim additional wire-protocol support once implemented and tested.
- Product-agnostic requirements here govern the platform; the existing .NET project is historical reference, not a compatibility obligation. The old `software-license-v1` proof-of-concept format and its test licences are retired. Do not carry it forward merely for legacy support.
- Record genuine specification conflicts in an ADR, including resolution and affected client versions. Do not use conflicts as an excuse to stop implementation.

## 1. Work approach: do the rewrite, not just plan it

Inspect source material, create a dedicated rewrite branch or safe checkpoint without overwriting unrelated changes, write a short implementation plan/checklist within the repo, and **then actually implement it**. Progress through domain model, database, Worker, security, cryptography, billing, portals, mail, tests, CI, docs, cleanup. Continue through feasible phases without asking for routine approval at every step. Do not terminate at a scaffold, a toy API, or an elaborate TODO list.

You have permission to replace obsolete local project files. Preserve Git history, licence/attribution, useful historical domain decisions, and user data. Never delete or change remote infrastructure or production data, and never deploy/perform a real charge without explicit authorisation and credentials. Use sandbox/test resources and mocks for unavailable external systems, **without representing a mocked integration as production-complete**.

Make deliberate architecture choices rather than reflexively importing the legacy classes. Choose a simple, coherent TypeScript modular monolith, not needless microservices. Keep business rules independent of Cloudflare, Stripe, MailerSend and Supabase adapters so they are unit-testable and portable.

## 2. Runtime, hosting, DNS, and cost ceiling

- Cloudflare Workers **Free** is the *initial* required runtime and budget. TypeScript strict mode, Workers-native runtime/V8, Fetch API, Web Crypto, small bundle, short-lived requests.
- No production .NET, ASP.NET, Blazor, EF Core, Docker server, IIS, Caddy, VPS, persistent process, filesystem database, or Node-only server assumptions. Node may be used in development tooling/build/test only.
- Hono is a reasonable lightweight candidate. Evaluate Worker-compatible routing, request validation, authentication and server-rendered UI choices; document why selected. Prefer server-rendered accessible HTML and modest client JS rather than a heavy SPA unless justified.
- One deployable Worker is preferred unless a concrete platform limitation makes separation necessary. Logical isolation between sensitive admin and public licensing paths is mandatory regardless.
- Configure the Worker with Wrangler (`wrangler.jsonc` or TOML), Cloudflare custom domain `license-server.repasscloud.com`, SSL/HTTPS, secure headers/cookies, and route-specific access controls. Disable production `workers.dev` access (`workers_dev: false`). Check and restrict **preview/version/deployment URLs separately**, since disabling `workers.dev` is not sufficient to disable them all. Never rely on obscurity of the hostname for security.
- Use Cloudflare Secrets for credentials and encryption secrets. Local `.dev.vars` or equivalent is gitignored; commit example variable names only.
- Confirm **actual current** Free-plan limits (HTTP request CPU, request counts, memory, subrequests, Cron CPU, etc.), Hyperdrive Free quotas, and any cost of additional Cloudflare products. Recent official guidance lists 10 ms Worker HTTP CPU, 100,000 requests/day, 10 ms Cron CPU, Hyperdrive on Free with its own daily query limit. Treat this as a required feasibility test, not an unsupported assertion of success.
- Benchmark real Worker-compatible signing, authentication, webhook, checkout, and UI paths; database waiting time is not CPU time. Measure ML-DSA-65 especially. Prefer native Worker Web Crypto where interoperable. Investigate `webcrypto_modern_algorithms` (ML-DSA support). Do not change required algorithms or hide performance failures. If Free cannot reliably satisfy a critical operation, show evidence, isolate the limitation, recommend the least invasive paid/architectural option **without unapproved spending**, and distinguish tested features from blocked ones.
- Configure fail-closed behaviour for sensitive routes/limits where applicable; never bypass licensing security because the Worker is unavailable.

## 3. PostgreSQL is the product/licensing source of truth

Initial provider: **Supabase PostgreSQL**, not D1. The system must later move to another PostgreSQL host by exporting/migrating the database and changing connection/secrets, without rewriting business code or losing licensing identities/keys/history.

Use plain, portable PostgreSQL, SQL migrations checked into Git, explicit indexes/constraints/foreign keys, transactions, row locks and JSONB only when justified. Do not make Supabase Auth, Realtime, Edge Functions, Storage, proprietary extensions, or PostgREST business logic prerequisites. Investigate Hyperdrive + PostgreSQL-compatible driver (e.g. postgres.js or `pg`) using the correct direct origin endpoint; account for connection and prepared statement/pooling behaviour, transaction connection affinity, schema migrations, and Free quotas. Keep migrations outside normal Worker request startup.

**Store ALL first-party product and commercial configuration in PostgreSQL**, not constants, env vars, Stripe-only metadata, JSON files published with the Worker, or hardcoded screens. This includes:

- Product identity: stable immutable `productId`/slug, display name, description, vendor, active/retired status, release identity, public and private catalogue visibility.
- Product major versions and supported app/client releases; sales availability and separately maintained historical entitlement compatibility.
- Edition definitions and **product-version-specific edition offerings**, including which editions exist for a particular product/version.
- Allowed licence duration and business models **per product + major + edition + offer**: perpetual, subscription (monthly/annual/other intervals), fixed-duration/time-limited, free registration, optional trial, etc., only when supported by that product's declared protocol capabilities. The four known edition names (`community`, `education`, `business`, `enterprise`) are common labels, **not four globally fixed behaviour bundles**.
- Activation style by offering: signed-file-only, online provisioning, device-bound seat activation, volume/site/unlimited, recurring validation, no activation, and per-product choices where supported by the client wire protocol.
- Seat counts, transfer rules, transfer windows/limits, offline policy, grace/renewal/expiry policy, registered benefits and other relevant configurable rules.
- Licensing capability/contract schema versions and product-release trust compatibility. Never issue incompatible combinations.
- Sellable catalogue offers/SKUs, external/public IDs, variants, bundles, upgrades, add-ons, quantities, discounts eligibility, locales, currencies, availability windows, and relevant purchase restrictions.
- **Prices in smallest currency units**, currency, recurring interval, tax behaviour, version/effective dates, public status, price history, price-to-offer mappings, and immutable purchase-time price snapshots. Never use floating point for financial amounts.
- Stripe Product IDs, Stripe Price IDs, optional coupon/promotion mappings, Stripe Customer/Subscription/Invoice/Checkout/Payment IDs and reconciliation metadata. Stripe IDs are **external mappings stored in PostgreSQL**; they are not your canonical product IDs.
- Customers, organisations, portal identities, ownership/member permissions, billing contacts, entitlements, issued licences, activations, transfer history, subscriptions, audit, signing keys, outbox and webhook processing state.
- MailerSend template mappings, email type settings and delivery metadata (but not the MailerSend API secret).

A new product or major version must be onboardable through administrator UI/API + database configuration, including pricing and Stripe mapping, with **no Worker redeployment** unless new software protocol functionality genuinely needs implementing.

### Policy evaluation architecture

Build a typed, validated, **data-driven policy engine**. Effective policy = product + major version + edition + chosen offer + explicit entitlement/customer override + client protocol capability. Store validated/immutable policy snapshots with purchased entitlements, while allowing explicitly audited policy amendments. Do not silently change a paid customer's entitlement because an administrator edits the current product catalogue.

Illustrative possible products, NOT hardcoded fixtures or obligatory offers:

- Product A: Community free/perpetual, Education annual subscription, Business monthly subscription with device seats, Enterprise perpetual unlimited.
- Product B: subscriptions for all four editions, with protocol support where needed.
- Product C: perpetual options for all four editions.
- Product D: no perpetual offerings at all, or a single paid edition.

Define safe restrictions and compatibility validation in the database/service layer. Some combinations require a new client protocol, and such offers must not be activated for a client declaring only an incompatible v1 schema. Support policy diversity **without breaking older verifiers**.

### Data model

Derive final normalized schema from requirements; candidate entities: `products`, `product_majors`, `product_releases`, `license_protocols`, `edition_definitions`, `product_edition_policies`, `offers`, `offer_prices`, `price_versions`, `offer_entitlement_components`, `bundles`, `bundle_items`, `stripe_product_mappings`, `stripe_price_mappings`, `customers`, `organisations`, `organisation_members`, `portal_users`, `admin_users`, `roles`, `permissions`, `service_accounts`, `admin_api_tokens`, `purchases`, `purchase_lines`, `checkouts`, `subscriptions`, `subscription_periods`, `invoices`, `entitlements`, `entitlement_policy_snapshots`, `licenses`, `license_issuances`, `activation_keys`, `activations`, `transfer_events`, `revocations`, `signing_keys`, `key_compatibilities`, `key_lifecycle_events`, `stripe_events`, `mail_events`, `outbox_jobs`, `auth_sessions`, `audit_events`.

Adapt entity names thoughtfully. Keep **purchase ≠ entitlement ≠ signed licence ≠ activation ≠ activation key ≠ subscription ≠ product offer ≠ price**. A bundle purchase produces component entitlements/licences, not one multi-product licence. A customer can own many products/majors/entitlements. Do not duplicate sensitive personal data without need. Enforce uniqueness, idempotency, history, immutable identifiers, auditability, and UTC timestamps. PostgreSQL migrations and seed *development fixtures only* must be repeatable. Backups/restore and provider-portability procedure are required.

## 4. Database-controlled Stripe catalogue and Checkout

Stripe should be a payment processor/billing ledger and webhook event source, **not the place where the authoritative catalogue or entitlement policies live**.

### Admin catalogue lifecycle

Administrators create/edit the product, major, edition policy, offer/SKU, sellable bundle, price/currency/term, etc. **in PostgreSQL through admin UI or admin API**. Implement an explicit, reliable Stripe synchronisation/reconciliation service:

1. Validate and persist first-party catalogue/offer/price changes in DB (or in a staged/pending state until external prerequisites are satisfied).
2. Create or map the corresponding Stripe Product and **immutable Stripe Price** objects using Stripe's server-side API as needed. Do not fabricate Stripe IDs.
3. Store external IDs, sync state, version, idempotency key, error detail, reconciliation timestamps in PostgreSQL.
4. Editing a charge amount, currency, recurring interval or other immutable Stripe Price property creates a **new offer price/Stripe Price mapping**; do not mutate historical pricing. Archive/deactivate old sellable prices appropriately while retaining historical purchases/subscriptions and legal billing history.
5. Handle provider outages, failed syncs, retries, drift and manual repair/reconciliation from admin UI/API. Never mark an offer purchasable when the required Stripe mapping is broken.
6. Never automatically assume that arbitrary changes made directly in Stripe are authorised modifications to your product catalogue. Inspect/report drift and require explicit reconciliation policy.

### Server-created checkout

Implement server-side Checkout Session creation using ONLY DB-resolved, active, publishable offers, prices, quantities, currencies and policies. Do not accept a browser-supplied monetary amount, entitlement claims, seat limit or arbitrary Stripe Price ID as authoritative.

- Validate requested product + major + edition + offer, term, quantity, currency, customer eligibility and published pricing.
- Resolve Stripe Price ID mapped to the selected **database price version**; send the matching trusted values to Stripe.
- Store pending checkout and its price/entitlement snapshot + idempotency correlation in PostgreSQL.
- Use secure server-generated success/cancel URLs and strictly validated redirects.
- Support relevant one-time payments, subscriptions and $0 registration, bundles and quantities.
- Specify supported coupons/promotion codes, regional taxes (including GST when applicable), discounts and billing address collection. Do not invent tax handling; document Stripe Tax/tax configuration prerequisites.
- Avoid duplicate Checkout Sessions for idempotent requests. Enforce customer ownership and protect against price switches while a checkout is in flight.
- The **success redirect is not proof of payment**. A successful purchase is confirmed by verified Stripe state/events, using appropriate events for synchronous vs asynchronous payment methods and zero-value/free checkouts. No licence issuance just because the user visited the success page.
- Show clean customer-facing checkout status, including pending payment, success, duplicate completion and failure/retry.

### Stripe webhooks, renewals and lifecycle

Implement a dedicated endpoint such as `POST /webhooks/stripe` with raw-body signature verification and replay/idempotency protection. Persist Stripe event IDs and reception/processing states. Acknowledge safely, then use a durable transactional PostgreSQL outbox/inbox or equivalent Workers-Free-compatible approach for side effects; reconcile interrupted operations.

Handle the lifecycle specified in the server brief, including relevant verified events such as:

- `checkout.session.completed` **and asynchronous payment completion/failure events where relevant**.
- `invoice.paid` and suitable failed-payment events.
- `customer.subscription.created`, `.updated`, `.deleted` and relevant subscription schedule/period changes.
- Refunds, disputes/chargebacks, reversals and policy-dependent revocations.
- Trial, grace, proration, quantity/seat upgrades/downgrades, cancellations-at-period-end, and effective-period boundaries as applicable to configured offers.

Do not assume that webhook events are delivered once or in order. Do not derive effective entitlement dates solely from receipt time. Fetch/reconcile current Stripe objects where necessary and securely bind them to internal orders/subscriptions. Use Stripe object IDs, event IDs, invoice/period identifiers and DB constraints to prevent double grants, double extensions, duplicate emails and repeated revocation.

Stripe-originated renewal changes the DB entitlement/expiry and permits **re-signing the same licence ID**; it must not silently create another independent entitlement or issue a new device seat. Preserve entitlements correctly through subscription interruptions, failed payments and recovery. Define configurable product-level policy on refunds/disputes and do not confuse cancellation/non-payment with explicit revocation.

Record historical monetary amount/currency/taxes/discounts/Stripe receipts and source events so administrators can trace exactly **why** an entitlement was issued, updated or revoked. Use a reconciliation procedure to discover and repair lost webhooks or out-of-sync subscriptions. Distinguish commercial pricing changes for *new sales* from existing subscribers' pricing/entitlements; never silently change existing subscription prices.

## 5. MailerSend transactional email — required, not placeholder

MailerSend is the sole initial transactional email provider. Use its HTTPS API with a scoped `MAILERSEND_API_TOKEN` (Workers Secret), verified sender/domain configured outside source control; do **not** introduce SendGrid, SMTP server or another provider as a hidden production dependency.

Implement a provider-neutral `EmailService` / MailerSend adapter with:

- Purchase confirmation and itemised licence/entitlement details.
- Licence/activation-key delivery **safely** (prefer authenticated secure retrieval link over casually emailing evergreen bearer secrets; if the specification explicitly requires activation keys in purchase email, implement that deliberately with risk controls and auditable policy).
- Customer account invitation/email verification/passwordless sign-in or password reset.
- Subscription created/renewed/failed/cancelled/expiring as appropriate.
- Device release, entitlement changes, revocation, security-sensitive account changes and admin notifications where appropriate.
- Template IDs/content mapping in PostgreSQL; provider API tokens remain in Secrets. Branded HTML and plain-text variants, safe escaping and substitution, and clear support/contact links.
- Durable `email_outbox`, attempt count, backoff, dead-letter/failure visibility, idempotent business event IDs, and MailerSend provider message IDs/status. Respect 429, `Retry-After`, API quotas and transient failures.
- Optional verified MailerSend webhook handling for delivery/bounce/complaint updates with deduplication; suppress/review undeliverable destinations. If optional webhooks are not implemented, do not falsely imply delivery tracking exists.
- Explicit separation of critical transactional mail and consent-based marketing updates. Never send marketing mail merely because a customer purchased unless appropriate consent/legal basis exists.
- No real emails in unit tests and no fake "sent" status. Provide sandbox/test approach and operational admin retry/reconciliation tools.

**Purchases and licence creation must succeed durably in PostgreSQL even when MailerSend is unavailable.** Email failure must not cause a paid entitlement to disappear or be re-issued multiple times. The customer must still be able to retrieve the licence in the portal.

## 6. Signing keys must live in PostgreSQL — encrypted

Implement a centrally managed PostgreSQL signing-key registry with **public AND encrypted private** key material, provider-portable binary/encoded formats, immutable globally unique key IDs, algorithm, metadata, status, key-encryption version and lifecycle history. Never use signing-key files as the runtime source of truth. This applies to Ed25519, ECDSA-P256-SHA256 and ML-DSA-65.

Private signing keys must be encrypted at the application/signing boundary **before PostgreSQL storage**, using a vetted AEAD mode such as AES-256-GCM and a versioned, independent key-encryption secret held in Cloudflare Workers Secrets (or an appropriate external KMS if actually available and compatible). Use unique random nonces and correct associated metadata. Store `ciphertext`, nonce, tag, encryption/key version, encoding/algorithm. Do not store the decryption secret alongside encrypted material or in Git. Restrict DB role permissions and isolate decrypt/sign operations from other code paths as far as the single-Worker architecture permits.

**Portability:** a PostgreSQL dump/restore to any suitable PostgreSQL provider preserves the public and encrypted private keys and their IDs. A protected backup/transfer of the separate KEK is also necessary to resume signing. Test restore and signing after migration. Support authenticated encryption-key rewrapping/re-encryption and KEK rotation without changing signing-key identities. Document backup disaster recovery and key-loss consequences.

Implement lifecycle and admin actions:

- Generate secure keypairs with verified Workers-compatible primitives.
- Register/import keys by a highly restricted explicit secure process (no ordinary UI/private export).
- List metadata, public keys, trusted-key exports, creation/retirement/compromise status.
- Generate annually **on demand** without automatic activation.
- Approve keys for product/version/client compatibility; prevent issuance to releases that do not trust them.
- Select **all eligible compatible signing keys** for the precise product/major and protocol, observing v1's maximum 8 signature entries.
- Sign and re-sign licences and certificates; safely retire keys and preserve historical verification.
- Audit generation, eligibility, use, retirement and re-encryption without logging secret material.

Never send private keys to customers, browsers, Git, logs, downloadable licence files or ordinary admin API responses. Do not rely on database-only encryption or TLS as an adequate replacement for application-side key encryption. Never hardcode signing seeds (except clearly isolated public test vectors). Do not claim to provide full HSM/KMS isolation if signing keys are necessarily decrypted inside the Worker; document the trust boundary honestly.

### Exact cryptographic contract for v1

Implement the existing server brief's byte-level rules exactly:

- `repass-license-v1`, `repass-activation-v1`, `schemaVersion: 1` and exact claims/optional fields/allowed values.
- UTF-8 JSON payload serialized **once**, unpadded base64url encoding, envelope with `format`, `payload`, `signatures` and no extra fields, up to 8 signatures.
- Signature input = `UTF8(format) || 0x0A || exact_payload_bytes`.
- Pure Ed25519 (RFC 8032), not ph/ctx.
- ECDSA-P256-SHA256 with **IEEE P1363 64-byte r||s**, not DER.
- Pure ML-DSA-65 (FIPS 204), empty context, correct 3309-byte signature and 1952-byte public key.
- Correct public key encodings, timestamps (UTC RFC 3339 whole seconds), stable identity, envelope size and error handling.
- Keys eligible for issuance *only* if target application releases trust them. Signing with an unsupported key is an operational licensing failure, not a benign warning.

Use official implementation brief test vectors and independent client conformance tool. Cloudflare's `webcrypto_modern_algorithms` may support native ML-DSA-65; verify **algorithm mode, encodings, import/export compatibility and Free CPU usage** rather than just checking that an API exists.

## 7. General licensing engine: truly product-specific

The four familiar edition IDs are `community`, `education`, `business`, `enterprise`, but they are **not** globally hardcoded price/term/device behaviour classes. Different products may expose different subsets, activation strategies, sale terms, pricing and verification requirements. A perpetual offer may be available for none, some or all four editions **when a compatible client understands it**. Likewise subscriptions, seats, device rules, offline operation, and feature mappings are configurable per product/major/offer. Do not infer server-side product features solely from the edition name; the application controls feature enablement using validated entitlements and its own policy.

The v1 client contract, however, has specific constraints (e.g. an existing v1 Business activation certificate and `maxActivations`, existing v1 non-Business handling). Enforce those for products/releases using v1. Do not change the v1 on-wire meaning to implement generality. Model future protocol capabilities/versioning explicitly and add separately tested protocol implementations as required.

Implement entitlement issuance, revocation, reissue and renewal with independent concepts:

- Product/major-version entitlement (v2 never silently grants v3).
- Perpetual vs expiring/recurring term.
- Payment/subscription state.
- Offline grace/check-in policy.
- Device seat allocation and transfers where configured *and expressible in the client's protocol*.
- Activation-key provisioning vs authenticated human portal access.
- Trusted signing-key compatibility and issued licence schema.
- Customer/organisation ownership and associated member permissions.

**Offline reality:** licences deliberately permitted to remain offline indefinitely cannot be forcibly revoked in real time. Portal/server revocation affects future server interactions; explain delayed revocation and do not imply remote erasure. Never introduce a mandatory phone-home for existing perpetual offline licences without the product's explicit contract.

### Implement the exact v1 machine endpoints

- `POST /v1/activations`
- `POST /v1/licenses/{licenseId}/renew`
- `POST /v1/activations/{activationId}/deactivate`

Use the complete authoritative request/response/error table. Existing device protocol authenticates with activation keys/device client secrets, **not a customer browser session or admin API token**. Do not force headless installed applications to perform UI login. Respect re-activation idempotency, client-secret rotation on same-device reactivation, product/major mismatch, subscription expiry, inactive activation, revoke/deactivate semantics, and signed response verification.

A Business seat is held by an active activation; serialize race-sensitive work in PostgreSQL transactions/row locks. Repeated same-device activate must not consume a new seat; releasing and replacing a device counts against rolling transfer allowance as specified. Record minimal device identification. Enforce configured overrides, and avoid data races with simultaneous requests. Use parameterized SQL. Tests must run against **real PostgreSQL**, not mocks, for concurrency.

For non-device licences, do not store arbitrary device tracking data. For clients whose policy disallows device registration, preserve privacy. Maintain separate server access audit and security metrics without pretending they are device inventory.

## 8. Separate human customer login, admin login, and machine/admin APIs

Build **two separate human identity/authorisation realms**:

1. **Customer** login and portal: account/organisation/profile, licences/downloads, available entitlements, subscriptions, billing links, applicable device management and activation-key rotation.
2. **Administrator** login and admin portal: global catalogue management, customer/support operations, checkout mappings, licences, subscriptions, signing keys, integrations, audit and policies.

These must have different route/middleware/roles and explicit server-side access checks. A customer cannot elevate themselves by modifying paths, IDs, cookies, JWT claims or request bodies. Prefer passwordless email or another established Worker-compatible customer auth pattern; admins should use strong authentication and MFA/passkeys if supported securely. Do not recreate an amateur password/session implementation. Persist sessions/challenges in PostgreSQL, secure HTTP-only SameSite cookies, CSRF protection, login rate limiting, short/revocable admin sessions, secure recovery and no default production admin password. Include safe one-time initial bootstrap through operator-controlled CLI/SQL or explicit setup process; no permanently available unauthenticated setup endpoint.

### NEW, MANDATORY: secure terminal/automation admin API

Provide a genuine **non-interactive REST admin API** for terminal users, scripts, automation, CI integrations or future internal applications. It must **NOT** require visiting the UI or logging into a browser each time.

Use dedicated **personal access tokens (PATs) and/or service-account credentials**, independent of cookie sessions and entirely separate from customer activation keys and Stripe/MailerSend secrets. Implement high-entropy random bearer tokens, distinct prefixes, **one-time reveal at creation**, cryptographic hash/HMAC storage (not plaintext), token ID/short prefix for lookup, expiration, optional not-before/last-used, revocation and rotation, account/service identity, scopes, configurable rate limits and optional source IP/CIDR restrictions. Validate tokens securely and use least privilege. No admin JWT signed with a hardcoded secret; do not build an unrevocable master key. Use TLS only.

Examples of granular scopes (adapt to actual service methods):

- `products:read`, `products:write`
- `prices:read`, `prices:write`, `stripe:sync`
- `customers:read`, `customers:write`
- `entitlements:read`, `entitlements:issue`, `entitlements:revoke`
- `licenses:read`, `licenses:issue`, `licenses:renew`
- `activations:read`, `activations:release`, `transfers:write`
- `subscriptions:read`, `subscriptions:manage`
- `signing_keys:read_public`, `signing_keys:manage`
- `email:read`, `email:retry`
- `audit:read`, `tokens:manage`

Never create a scope that grants ordinary API access to decrypted signing private keys. Key generation/rotation and destructive billing/licensing actions deserve especially narrow scope, enhanced audit and where justified dual approval/step-up authentication. Enforce resource-level scope/customer/role permissions, not just scope string presence. Distinguish API token access from higher-risk user admin access when required.

- Namespaced stable endpoints such as `/api/admin/v1/products`, `/api/admin/v1/offers`, `/api/admin/v1/prices`, `/api/admin/v1/stripe/sync`, `/api/admin/v1/customers`, `/api/admin/v1/licenses`, `/api/admin/v1/entitlements`, `/api/admin/v1/activations`, `/api/admin/v1/signing-keys`, `/api/admin/v1/webhooks/reconcile`, `/api/admin/v1/email/retry`, and `/api/admin/v1/tokens`. Precise routes are a design decision; **do not collide with the binding `/v1/...` machine API**.
- CRUD/filter/search/pagination, validated typed JSON, consistent error structure, request IDs, safe idempotent mutations (`Idempotency-Key`), explicit confirmation semantics for destructive operations, and a versioned OpenAPI 3.1 spec with example requests/responses.
- The administrator UI must use **the same underlying services, validation and permission rules** as this API; no independent logic forks or hidden direct SQL shortcuts.
- Audit every API operation with token/actor identity, scopes, outcome, resource, origin/request correlation and time; never log bearer token contents or activation/client secrets.
- Provide a documented **curl + jq + macOS Keychain** terminal workflow to create/store/use/revoke/rotate API tokens without placing secrets in `.zshrc`, command history, repo files or process arguments unnecessarily. A simple `repass-license` CLI wrapper is optional, but usable curl examples are mandatory.
- Tests: no token/expired/revoked/token wrong scope/wrong actor, token isolation, rate limits, replay/idempotency, high-risk operation permission checks, and customer vs admin separation.

## 9. Customer and admin portals — actual working functionality

Serve lightweight responsive, accessible, secure UIs through the Worker.

**Customer:** sign in/out, verified email/account, organisation membership, product/version entitlements, past orders and subscription state, retrieve signed licence files, retrieve or rotate activation keys under secure policies, renew/reissue where permitted, billing self-service/Stripe Customer Portal link when appropriate, manage only applicable device activations/transfers, and support/contact guidance. Show explicit privacy/offline-revocation limits. Do not show device management for policies without device tracking.

**Administrator:** overview, customer/organisation/user management, products/majors/client capabilities, edition/term/device policies, catalogue offers, pricing histories/currencies, bundle composition, Stripe ID mappings and sync/reconciliation, checkout/order/invoice event status, entitlements and issued licence inspection, signing-key metadata/lifecycle/trust, activation/transfer/support overrides, subscriptions, webhooks/dead letters, MailerSend outbox/template mapping and delivery outcomes, roles/PAT/service accounts, audit reporting.

Do not build decorative placeholder pages/buttons. Backend authorisation is mandatory on every read and mutation. High-risk UI actions need confirmation, clear descriptions and audit records. Render errors and external-provider outages truthfully.

## 10. Webhooks, durable work, and consistency

Cloudflare Workers are stateless. Stripe and optional MailerSend webhooks, as well as retrying emails/reconciliation, require **durable processing** compatible with Free limits.

Use PostgreSQL inbox/outbox/job records and transactional state changes; Cron Trigger(s) and/or safe opportunistic processing may drain bounded batches if Free limits permit. Do not assume `waitUntil()` is a durable queue or promise that a Worker executes indefinitely after responding. Never put unbounded processing in HTTP requests. Ensure at-least-once execution plus idempotent side effects produces the intended exactly-once *business outcome*. Investigate query-count/CPU implications of polling frequently. Document backoff, retry exhaustion, operator retry, dead-letter status, dedupe and outage recovery. Do not introduce Cloudflare Queues, Durable Objects or paid features without confirming Free eligibility and necessity.

Use PostgreSQL transactions for changes to purchase/entitlement/licence/inbox/outbox, and recover safely if Stripe or MailerSend calls time out after the provider may already have succeeded. Use documented provider idempotency keys and reconciliation to resolve uncertain outcomes. Preserve an append-only audit trail with privacy-safe retention.

## 11. Security, compliance, and operational standards

- All secrets in Workers Secrets/GitHub Actions secrets or appropriately secured local environment; never hardcode. `.dev.vars` etc. must be gitignored. Separate test and production keys/accounts/webhook secrets.
- Different token types: customer sessions, application activation keys, device client secrets, admin PATs, Stripe webhook signing secret, Stripe API secret, MailerSend API secret, signing private material encryption KEK. Never confuse or reuse their trust domains.
- Store high-entropy activation/client tokens as cryptographic digests keyed/hashed appropriately; constant-time comparisons where applicable; one-time display for secrets except any carefully designed recovery policy compatible with the authoritative client contract.
- Require proper HTTP validation, output escaping, CSRF/session protection, secure CORS (no wildcards on credentialed admin/portal routes), content security policy, anti-enumeration, controlled public error details, body limits, replay protection and request throttling by IP and key/identity.
- Least-privilege PostgreSQL runtime role; migration role separate; restricted access to encrypted key rows; no direct customer access to DB.
- Track all admin changes, webhooks, entitlements, key rotation, privileged authentication and sensitive support actions. Avoid storing emails/personal data inside signed licences where forbidden by the wire contract. Define retention, data deletion and Australian privacy/GST implications where relevant; do not claim legal compliance without review.
- Passwordless magic links/reset tokens: short life, one use, hashed at rest, origin-bound where appropriate, no redirect leakage. If passwords are implemented use an appropriate established KDF/implementation that works within Workers CPU budget; do not weaken password security to fit the Free tier.
- Provide backup/restore drills, webhook replay and reconciliation, key/KEK recovery runbook, incident/key compromise runbook, Stripe and MailerSend token rotation procedures, safe administration and audit review.
- Log structured request correlation and outcome but no private keys, password/reset tokens, admin PATs, full activation keys, device client secrets, raw webhook secrets or confidential card/customer data.

## 12. APIs and interoperability

Maintain the exact existing client API. Build a separate, versioned admin API and stable customer portal HTTP interface. If you also expose customer APIs, scope them separately and never accept machine activation keys as customer-session authentication.

Provide:

- OpenAPI 3.1 for all documented REST endpoints, including auth and stable errors.
- Clear exact JSON and signature schemas with runtime validators and typed TypeScript counterparts.
- Documentation for product onboarding and which licences can be issued under which client schema/protocol.
- No false assumption that all apps use the same trusted public keys, entitlement variants or release lifecycle.
- Compatible key registry and deterministic contract test vectors.

## 13. Project organization and quality

Suggested structure (adjust to fit actual design):

```text
src/
  index.ts
  api/{licensing,admin,customer,webhooks}/
  domain/{catalogue,policy,entitlements,activations,billing}/
  services/
  repositories/
  database/
  auth/
  crypto/
  integrations/{stripe,mailersend}/
  portal/{customer,admin}/
  middleware/
  schemas/
  jobs/
  config/
migrations/
tests/{unit,integration,contract,security,performance}/
scripts/
docs/{architecture,adr,runbooks,api}/
.github/workflows/
wrangler.jsonc
package.json
tsconfig.json
README.md
CLAUDE.md
CHANGELOG.md
```

Use named small modules and dependency injection at composition boundaries when useful. No excessive enterprise ceremony. Keep schema migrations, API docs and generated types in sync. Include `npm run dev`, `build`, `typecheck`, `lint`, `test`, `test:integration`, `test:contract`, `db:migrate`, `deploy` as applicable. Use pnpm if compelling but don't introduce both package managers. CI must compile/test/lint/scan secrets/verify Worker deploy packaging. Separate test, staging and production configs; never auto-deploy on any PR or automatically run destructive production schema changes.

Remove superseded .NET/Blazor/Caddy/Docker production components, EF migrations, legacy code/contracts/tools and misleading documentation from the active app once the replacement is safely established. Keep legal notices, attribution, history and useful archived design rationale. Do not maintain two competing active servers.

## 14. Mandatory testing/acceptance matrix

Make tests meaningful, repeatable, and run all practical checks; record exact pass/fail/blocked results. Required tests include:

1. **Catalogue + pricing:** DB-created products/majors/editions/offers/prices; supported and unsupported policy combinations; perpetual enabled for 0/1/all editions; multiple currencies/intervals, immutable price history, tax/discount calculation boundaries, inactive offering refusal, no trusting client-supplied money or Stripe IDs.
2. **Stripe:** sync new Product/Price mappings, handle external failures and drift; create server-authorised checkout with correct DB price/Stripe mapping; success redirects alone never issue; free registration; one-time and recurring purchases; bundles; duplicate/out-of-order verified webhooks; async payment; invoice renewal; plan/quantity changes; cancellation, refund and dispute; reconciliation; no duplicate entitlement or extension.
3. **MailerSend:** correct types/templates/personalisation, real provider adapter API shape, outbox retry, 429/backoff, unique message business ID, no paid entitlement loss during mail outage, no duplicate purchase email on retried webhook, email verification and optional webhook signature validation.
4. **Licensing:** all 4 edition labels as configured; per-product policies, major isolation, fixed/perpetual/recurring terms; signed payload rules, expiry/reissue and stable licence IDs; offline revocation limitations; non-device privacy.
5. **Crypto:** official v1 golden vectors, all 3 signature algorithms, multi-signature envelopes, ECDSA P1363 encoding, pure Ed25519/ML-DSA, tampering, wrong algorithm/key/product/major, key eligibility, wrong KEK, KEK rotation and PostgreSQL key restore, actual Worker crypto performance.
6. **Real client:** run the published CurseDelete conformance checker for compatible v1 fixtures. Confirm both valid and intentionally invalid examples. CurseDelete is an **interop fixture**, not a server architecture assumption.
7. **Concurrency:** real PostgreSQL test under simultaneous Business activations, same-device reactivation, seat limit, transfer allowance, deactivation, subscription quantity reduction, idempotent mutations and transactional rollback.
8. **Auth:** customer cannot see another customer/organisation; customer cannot access admin; admin UI login and MFA/session tests; PAT create/reveal once/hash/revoke/rotate/expire/scope test; service identity, no UI login needed for curl, denial of dangerous operations without scope, CSRF/CORS/rate-limits.
9. **Infrastructure:** Miniflare/Workers runtime-compatible tests, Hyperdrive integration assumptions, database connectivity failures, missing secrets, Stripe/MailerSend timeout handling, Free CPU/query/subrequest budget evidence, no Node-only runtime dependency.
10. **End to end:** admin creates a product/major/edition/offer/price in PostgreSQL → Stripe mappings sync → customer opens DB-priced Checkout → verified successful Stripe event → entitlement/licence/activation key issued → MailerSend email attempted/delivered → portal shows licence → API activates/renews/deactivates as configured → admin can query/modify securely via terminal PAT → audit trail explains every action.

Use test-only secrets and test payment/webhook fixtures. Never charge real cards or send real emails during automated tests.

## 15. CI, secrets, provisioning and operations docs

Deliver exact **macOS/zsh** commands for setup and local test; list required Supabase database/user/connection values, Hyperdrive config, Wrangler secrets, Stripe test/live API and webhook settings, MailerSend verified sending domain/API token, and initial admin bootstrap. Set up the Cloudflare custom domain, disable `workers.dev`/lock preview and version URLs, and explain DNS/SSL behaviours without inventing IDs. Include Stripe webhook URLs/events, MailerSend optional webhook URL, GitHub deployment secrets, CI, production migration approval and release/rollback procedure.

Provide clear `curl` + `jq` API examples using a token kept in macOS Keychain; show read-only query, creating a product, creating an offer and DB price, syncing to Stripe test mode, issuing/revoking/reissuing where properly authorised, listing customers/entitlements, rotating a token, and checking failed webhooks/outbox. Avoid echoing tokens in terminal, history, commit messages or logs.

Use PostgreSQL vendor migration runbook: portable schema migrations, export/import, verify encrypted key records, securely reconfigure Hyperdrive origin, preserve signing KEK separately, compare record counts/checksums, test issuance/validation, switch cutover safely and document rollback.

## 16. Definition of DONE

Only describe this as fully implemented when the actual code, docs and tests support it:

- [ ] Old active .NET implementation replaced by native TypeScript Worker application.
- [ ] Runs under current Cloudflare Workers Free constraints **or documented, measured blocker explicitly disclosed**.
- [ ] Only public production app domain is `license-server.repasscloud.com`; preview/version exposure addressed.
- [ ] PostgreSQL/Supabase is the actual first-party catalogue, licensing and key store; **no D1**.
- [ ] Product, price, offer, currency, term, policies, Stripe IDs and mappings are in PostgreSQL; admin-editable without redeploy.
- [ ] Product/edition terms and activation policies are configurable, not CurseDelete-specific global behaviour.
- [ ] Existing `repass-*-v1` clients remain protocol-compatible; incompatible future options are gated behind versioned capabilities.
- [ ] Server-created, DB-priced Stripe Checkout works; verified, replay-safe webhook-driven issuance and subscription extension work.
- [ ] MailerSend transactional email works with durable retry/failure visibility.
- [ ] All three signing algorithms supported and tested as required; private keys encrypted in PostgreSQL; signing KEK separately managed; key/DB migration tested.
- [ ] Customer login/portal works and isolates customer data.
- [ ] Administrator login/portal works with robust permissions.
- [ ] **Separate scoped administrator REST API works with PAT/service-account authentication and no browser login**, including documented terminal usage.
- [ ] Relevant licensing, activation, seat/transfer, renewal, revocation, bundle and Stripe business cases are implemented.
- [ ] PostgreSQL migrations, tests, OpenAPI, CI, Cloudflare configuration, operations docs, admin onboarding and security runbooks exist.
- [ ] No mock routes, inert buttons, hardcoded production secrets, retired licence formats or hidden paid dependencies masquerade as done.

### Final report format

Report: architecture; deleted legacy components; implementation inventory; database schema; catalogue/pricing-to-Stripe workflow; product policy extensibility and v1 compatibility; encryption/signing key lifecycle; customer/admin auth and PAT API; MailerSend; Stripe events, idempotency and reconciliation; docs and migration/deployment commands; tests **actually run** with results; measured Workers Free viability; unknowns/blockers; precisely what account secrets/actions remain for the human owner.

If a real external account, valid test keys, provider setup, production approval or Free-plan limitation blocks a specific check, **implement and test the rest**. Mark blocked/untested items prominently. Do not falsely claim completion, do not hide blockers in TODOs, and do not substitute a design document for code.

## 17. Execution sequence

1. Examine the repository fully and read both referenced licensing documents completely.
2. Record the conflict-resolution ADR: **generic per-product licensing policy vs strict existing v1 CurseDelete contract**.
3. Create a safe rewrite branch/checkpoint and an implementation checklist.
4. Build the Worker/TypeScript and DB migration foundation, domain/policy/catalogue model.
5. Implement PostgreSQL-backed encrypted signing keys and exact v1 crypto/signatures.
6. Implement machine-facing licensing API and actual PostgreSQL transactional seat enforcement.
7. Implement customer/admin identity realms and secure scoped PAT admin API.
8. Implement complete DB-driven catalogues, price history, Stripe synchronisation and checkout.
9. Implement verified Stripe webhooks, entitlement lifecycles and durable reconciliation.
10. Implement MailerSend adapter, templates, outbox/retries and account security emails.
11. Implement functional customer/admin portals using the same services/API rules.
12. Add contract/real-client/concurrency/security/e2e tests, measure Free limits and fix defects.
13. Replace docs and workflows, prune obsolete .NET components, verify no secrets.
14. Run final quality checks and provide truthful, detailed deliverable/report.

**DO THE WORK IN THIS REPOSITORY. THIS IS A COMPLETE REWRITE.**

## 18. Official documentation starting points (verify latest)

- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Cloudflare Hyperdrive pricing: https://developers.cloudflare.com/hyperdrive/platform/pricing/
- Cloudflare Hyperdrive limits: https://developers.cloudflare.com/hyperdrive/platform/limits/
- Cloudflare Web Crypto (including modern algorithms): https://developers.cloudflare.com/workers/runtime-apis/web-crypto/
- Cloudflare workers.dev routing/access: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Stripe Checkout Sessions: https://docs.stripe.com/api/checkout/sessions
- Stripe Webhooks: https://docs.stripe.com/webhooks
- Stripe subscriptions: https://docs.stripe.com/billing/subscriptions/overview
- MailerSend email send: https://developers.mailersend.com/api/v1/email
- MailerSend API authentication/limits: https://developers.mailersend.com/general
- MailerSend templates: https://developers.mailersend.com/api/v1/email/templates
- MailerSend webhooks: https://developers.mailersend.com/api/v1/account/webhooks
- Supabase database documentation: https://supabase.com/docs/guides/database

---

**Repeat: COMPLETE REWRITE. PRODUCT-AGNOSTIC. POSTGRESQL-SOURCED PRODUCTS AND PRICES. STRIPE CHECKOUT + WEBHOOKS. MAILERSEND. TWO HUMAN LOGIN REALMS. SECURE TERMINAL ADMIN API. CLOUDFLARE WORKERS FREE.**
