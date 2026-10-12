# Software licensing POC

Current version: **v0.3.2** — see [CHANGELOG.md](CHANGELOG.md) for release notes.

Licensed under [Apache-2.0](LICENSE).

This repository is a proof-of-concept foundation for issuing one signed licence that can cover multiple commercial products. It has four projects:

- `Licensing.Core` is the shared licence contract, schema validation, and canonical JSON implementation.
- `LicenseGenerator` generates ECDSA P-256 keys and signs schema-valid licence data.
- `LicenseValidator` verifies signatures using public keys compiled into the application, validates the schema, and enforces product rules.
- `LicenseServer` is a .NET 10 Blazor Web App and PostgreSQL-backed licensing service with ASP.NET Core Identity, MFA, passkeys, administration, activation, leases, transfer, and revocation.

The signer and validator deliberately share `Licensing.Core`, so their interpretation of a licence cannot drift independently.

## LicenseServer architecture and administration

`LicenseServer` combines static server-rendered Blazor pages with narrowly scoped interactive support for Identity passkeys. EF Core and Npgsql persist customers, licenses, entitlements, activation history, signing-key metadata, ASP.NET Core Identity users/roles/passkeys, revocations, and append-only audit events in PostgreSQL. API request contracts remain separate from database entities.

The public device APIs preserve the `/api/v1/licenses/{licenseId}/activate` and `/api/v1/activations/{activationId}/{validate|refresh|deactivate}` routes. Administrative pages and `/api/v1/admin/*` use named action-level permission policies. The legacy `Administrator` role is mapped to `System Administrator` during initialization, and the old `local-poc-admin-key` header has been removed.

Activation and deactivation use serializable database transactions. Issuance uses a read-committed transaction containing one atomic PostgreSQL counter upsert, the customer, license, entitlement, and audit insert; rollback therefore returns the counter value as well. Counter-row locking makes concurrent allocation safe without retrying serializable transactions, and the unique license-ID index remains the final integrity boundary. `Licensing:IdTimeZone` controls only the business date embedded in the ID and defaults to `Australia/Adelaide`; every real timestamp remains UTC.

Generated IDs have the exact form `LIC-{yyyy}-{MMdd}{value:X6}`. The first daily value is `000001`, the last is `FFFFFF`, and a further issuance receives a clear conflict rather than wrapping or falling back to random data. PostgreSQL and the EF change tracker both reject changes to a persisted ID.

PostgreSQL enforces activation integrity with a partial unique index over `(LicenseRecordId, DeviceIdHash) WHERE DeactivatedAt IS NULL`, so one machine cannot hold multiple live activations for the same license, while `(LicenseRecordId, RequestId)` remains unique for retry idempotency. A license may have up to its entitlement seat count in concurrent active machine activations. Activation codes and bearer tokens are SHA-256 hashes at rest. Only an eight-character device-ID suffix is rendered in the UI. Every timestamp is stored in UTC.

### Local development without Docker

Install .NET 10 and PostgreSQL 18 (PostgreSQL 16 or newer is also suitable), then create a development database and role using your normal PostgreSQL administration tool. One exact `psql` example is:

```powershell
psql -U postgres -c "CREATE ROLE license_app LOGIN PASSWORD 'replace-this-local-password';"
psql -U postgres -c "CREATE DATABASE license_server OWNER license_app;"
```

Restore the repository-local tools and packages, provide secrets through the process environment, and run the server:

```powershell
dotnet tool restore --configfile NuGet.Config
dotnet restore SoftwareLicensing.slnx --configfile NuGet.Config

$env:ConnectionStrings__DefaultConnection = 'Host=localhost;Port=5432;Database=license_server;Username=license_app;Password=replace-this-local-password'
$env:SEED_DEFAULT_ADMIN = 'true'
$env:DEFAULT_ADMIN_EMAIL = 'admin@localhost.com'
$env:DEFAULT_ADMIN_PASSWORD = 'LocalAdmin!7Kp9-Vx3-Rm8-Qz2'
$env:SEED_DEMO_LICENSE = 'true'
$env:Licensing__IdTimeZone = 'Australia/Adelaide'
$env:Licensing__KeyDirectory = (Resolve-Path './keys')
$env:Licensing__DefaultSigningKey = 'primary-2026'

dotnet run --project src/LicenseServer/LicenseServer.csproj --urls http://localhost:5080
```

Migrations run safely and idempotently during startup under a PostgreSQL advisory lock. To manage them explicitly:

```powershell
dotnet ef migrations add DescriptiveMigrationName --project src/LicenseServer --startup-project src/LicenseServer
dotnet ef database update --project src/LicenseServer --startup-project src/LicenseServer
dotnet ef migrations list --project src/LicenseServer --startup-project src/LicenseServer
```

Open [http://localhost:5080](http://localhost:5080). The development-only initial account is `admin@localhost.com` with password `LocalAdmin!7Kp9-Vx3-Rm8-Qz2`. The first successful login is forced directly to password replacement before any administrative page or API can be used. Never use these credentials outside a disposable local environment.

Seeding happens only when `SEED_DEFAULT_ADMIN=true` and no matching email exists. Override `DEFAULT_ADMIN_EMAIL` and `DEFAULT_ADMIN_PASSWORD` before the first start. Passwords are processed only through ASP.NET Core Identity and are never logged. For local-PoC forgotten-password recovery, set `RESET_ADMIN_PASSWORD=true` and `DEFAULT_ADMIN_PASSWORD` to a new temporary value for exactly one restart, immediately return `RESET_ADMIN_PASSWORD=false`, and replace that temporary password at the forced login screen. Production must use a real verified email delivery implementation or an operator-controlled account-recovery process.

### Docker Compose

The app image is multi-stage and runs as the .NET image's non-root user. PostgreSQL runs as `postgres`; its port is not published. The app root filesystem is read-only, capabilities are dropped, `no-new-privileges` is set, only port 8080 is published, and explicit volumes hold PostgreSQL and Data Protection keys. The signing key directory is mounted read-only and contains zero key material in the built image — see [Signing-key ring](#signing-key-ring) below.

```powershell
Copy-Item .env.example .env
# Edit .env: replace POSTGRES_PASSWORD and DEFAULT_ADMIN_PASSWORD.
# LICENSE_SIGNING_KEY_DIR must resolve to a directory containing "<keyId>.private.pem" /
# "<keyId>.public.pem" pairs (the repo's keys/ directory works for local development).

docker compose config
docker compose build
docker compose up --detach --wait
docker compose ps
```

Convenience scripts perform the same startup with daemon checks, Compose validation,
health waiting, and clearer Docker Desktop/WSL diagnostics. They build directly through
the Docker engine and then start Compose with `--no-build`, avoiding the Compose Bake
context-metadata locking race seen on some Docker Desktop installations:

```powershell
./docker-up.ps1
```

```bash
sh ./docker-up.sh
```

If WSL reports that `/var/run/docker.sock` does not exist, start Docker Desktop and
enable **Settings → Resources → WSL integration** for that distribution. Apply the
change, run `wsl --shutdown` from Windows PowerShell, then reopen WSL. Until integration
is enabled, the shell scripts can use Docker Desktop's `docker.exe` automatically when
Windows interoperability is available.

Open [http://localhost:8080](http://localhost:8080), or the `APP_PORT` selected in `.env`. `depends_on` waits for PostgreSQL health, and application readiness includes a database connectivity check. Startup has no arbitrary sleeps.

Stop containers without deleting persistent data:

```powershell
docker compose down
# or: ./docker-down.ps1
# Linux/WSL: sh ./docker-down.sh
```

Reset only this development stack (destructive to its database, users, audit data, and cookies):

```powershell
docker compose down
docker volume rm license-server_license-postgres license-server_license-data-protection
# equivalent scripted reset: ./docker-down.ps1 -RemoveVolumes
```

On Linux/WSL, the equivalent scripted reset is
`REMOVE_VOLUMES=true sh ./docker-down.sh`. Normal down-script runs preserve both volumes.

Do not add `--volumes` to routine shutdown commands. The exact volume prefix can be confirmed with `docker volume ls` if Compose was started under a different project name.

### MFA and passkeys

After login, open **Security**:

- **Two-factor authentication** → **Add authenticator app** displays a local QR code and manual setup key, verifies the first TOTP, and then shows ten one-time recovery codes. The same area regenerates recovery codes; disabling 2FA or resetting the authenticator requires password reauthentication. Store recovery codes offline.
- **Passkeys** registers, names, lists, renames, and removes WebAuthn credentials. .NET 10 Identity performs challenge creation, attestation, assertion validation, counter handling, and PostgreSQL public-credential storage. The server never receives private passkey material.
- The login screen supports password, TOTP challenge, recovery-code challenge, and passkey authentication. Five failed password attempts trigger a 15-minute lockout.

Production requires an MFA-authenticated Identity principal for `users.manage`, `apiKeys.manageAll`, and `licenses.revoke`. Development bypasses this high-risk gate unless `Security:RequireMfaForHighRiskPermissions=true` is set explicitly; the PostgreSQL authorization tests set it to `true`. A user with Identity two-factor enabled receives the `amr=mfa` session claim used by these policies. The built-in role matrix is:

| Role | Access summary |
| --- | --- |
| System Administrator | All 16 roadmap permissions |
| License Manager | Full license/customer/activation lifecycle, product read, self API-key management, and audit read |
| License Issuer | License read/issue, customer read, product read, and self API-key management |
| Support Agent | License/customer/product read, activation management, and self API-key management |
| Product Administrator | Product read/manage and self API-key management |
| Auditor | Read-only licenses, customers, products, users, and audit plus self API-key management |
| Billing Automation | License read/issue/update, customer read/manage, product read, and billing management |

WebAuthn requires a secure browser context. `http://localhost` is the browser-defined local-development exception. Deploy behind HTTPS everywhere else, preserve the public host and scheme through trusted forwarded headers, persist Data Protection keys, and set cookie secure policy to `Always` at the TLS boundary.

### Operator and service-account administration

`/settings/users` requires `users.read`; invitations, enable/disable, role changes,
and forced password setup require `users.manage` plus the configured high-risk MFA
gate. Human operators receive a 15-minute Identity password-setup token and an
administrator never selects their password. Service accounts have no password, MFA,
passkey, or browser-login credentials and exist only to own scoped automation keys.

PostgreSQL serializes System Administrator disable/demotion operations so concurrent
requests cannot remove the final enabled administrator. Disabling an identity changes
its security stamp, rejects subsequent requests, calls the owned-credential revocation
hook, writes a secret-free audit event, and queues invitation/reset delivery through
the transactional email outbox. Setup links are never returned by production APIs.

### Scoped API credentials

`/settings/api-keys` creates bearer credentials in the form
`lic_live_<public-id>_<secret>`. The 32-byte secret is displayed once; PostgreSQL keeps
only its versioned HMAC-SHA-256 digest, public ID, last four characters, owner, scopes,
and lifecycle timestamps. Human-owned keys require an expiry. Rotation creates a new
secret and revokes the old key atomically; revocation and owner disablement take effect
on the next request.

Bearer authentication is selected only by `Authorization: Bearer` and maps key scopes
to the existing permission policies. It never reads cookies and does not use
antiforgery; cookie-authenticated mutations still require a valid antiforgery token.
Bearer admin traffic is rate-limited by owner and IP, while anonymous device routes use
a stricter IP partition. Configure `ApiCredentials__Pepper` outside source control with
an independent Base64 value containing at least 32 random bytes. Development can use an
ephemeral pepper, but its keys intentionally stop working after restart. Deployment Keys
follow the identical pattern with their own independent `DeploymentKeys__Pepper`.

### Versioned administration API

The `/api/v1/admin` surface exposes the same authorization policies and domain services
as the operator UI. Its route inventory covers bounded license search and detail,
one-product issuance, terms updates, cancellation, revocation, activation-code rotation,
operator deactivation, products, customers, users, API credentials, and filtered audit.
Mutation responses never serialize EF entities; generated activation codes are returned
only by issuance or rotation and PostgreSQL retains only their versioned HMAC digest.

License detail returns a quoted numeric `ETag`. `PATCH` terms requests must send that
value in `If-Match` and in the versioned request DTO. Cookie sessions require
`X-CSRF-TOKEN`; scoped bearer credentials do not use cookie antiforgery. Issuance accepts
`Idempotency-Key` and binds its encrypted, expiring replay result to the authenticated
principal and canonical request fingerprint. All API responses carry `X-Correlation-ID`.
The generated OpenAPI 3.1 document is available at `/openapi/v1.json` and describes both
Identity-cookie and API-key bearer authentication, concurrency, pagination, one-time
secrets, and the offline recall limitation.

### Durable transactional email

Transactional messages are inserted into PostgreSQL `EmailOutbox` through the
provider-neutral sender and encrypted with ASP.NET Core Data Protection. The template
registry covers purchase/activation, renewal reminder and receipt, payment failure,
invoice, operator invitation, Identity confirmation/recovery, and customer magic-link
messages. An idempotency digest uniquely suppresses duplicate queue requests; recipient
addresses and template models exist only inside the protected payload.

The hosted worker claims bounded batches with `FOR UPDATE SKIP LOCKED`, commits its
short lease before calling MailerSend, and records the provider message ID, attempts,
next attempt, and final status. Explicit throttling/server failures use bounded
exponential retries. Ambiguous timeouts or network failures enter `uncertain` for
operator reconciliation because the provider send API does not define an idempotency
contract. Development without a token uses a redacted capture transport; non-Development
startup requires `MailerSend__ApiToken`, `MailerSend__FromEmail`, and
`MailerSend__WebhookSecret`. `MailerSend__FromName` is optional and
`Email__WorkerEnabled` controls processing.

`POST /api/v1/webhooks/mailersend` verifies the hexadecimal `Signature` as a fixed-time
HMAC-SHA-256 over the raw request body before parsing. Provider event IDs are unique,
delivery/bounce/complaint updates are operational only, and webhooks never mutate a
license. The worker deletes terminal outbox rows and delivery events after the 30-day
retention deadline; logs contain only outbox IDs, template names, and recipient hashes.

### Passwordless customer access

`/customer/access` always gives the same response whether or not a normalized email and
optional license ID match. Valid matches queue a 32-byte random magic-link token through
the transactional email outbox; PostgreSQL stores only its SHA-256 hash, hashed email/IP
rate-limit identifiers, a 12-minute expiry, and its atomic consumption timestamp. The
token is never an activation code and cannot be used twice.
`CustomerPortal__PublicBaseUrl` supplies the public HTTPS origin for emailed links.

Successful consumption clears any prior customer cookie before issuing a non-sliding,
30-minute `LicenseServer.Customer` session. This scheme is separate from operator
Identity and API credentials and contains only a customer ID plus a customer-session
marker. The read-only portal and `/api/v1/customer` queries always include that customer
ID in the database predicate, return 404 for another customer's license, and expose only
status, product, edition, seats, expiry (`Never` for perpetual), activation state, and a
redacted device suffix. Activation credentials/hashes, full device identifiers, signed
metadata, audits, and operator controls are never projected.

Customer logout requires antiforgery and clears only the customer session. Device
deactivation, contact-email changes, and renewal mutations are deliberately unavailable;
future sensitive operations must begin with a fresh email challenge.

### Stripe billing and licensing policy

`POST /api/v1/integrations/stripe/webhook` is anonymous transport only. It reads the
untouched body, verifies `Stripe-Signature` with Stripe.net before parsing or writing,
encrypts verified payloads with Data Protection, and inserts a unique provider event ID
into `WebhookInbox`. Duplicate delivery returns success. Invalid signatures and
malformed payloads create no inbox, customer, order, license, audit, or email rows.

The billing worker leases rows with `FOR UPDATE SKIP LOCKED`. Stripe customer, Product,
Price, subscription, Checkout Session, and invoice IDs live only in dedicated mapping
tables. `BillingContract` and `LicenseOrder` remain provider-neutral, while license
issuance and terms changes use `LicenseStore`. Provider IDs and payment data never enter
signed metadata.

Default policy is seven days of payment grace, paid-through cancellation, and review
for refunds/disputes. `Billing__RefundAction` and `Billing__DisputeAction` can be set to
`suspend` deliberately. Purchases issue one license and queue its one-time activation
email transactionally; renewals are monotonic and idempotent by invoice; payment
recovery clears grace; cancellation reversal and plan changes follow current provider
state. Unknown/conflicting mappings quarantine without business side effects.

Operators with `billing.manage` can list redacted status at
`GET /api/v1/admin/billing/events` and reset eligible processing state at
`POST /api/v1/admin/billing/events/{id}/reprocess`. Raw payloads and arbitrary mutation
are not exposed. See [`docs/operator-runbook.md`](docs/operator-runbook.md) for exact
configuration and recovery, and [`docs/roadmap-traceability.md`](docs/roadmap-traceability.md)
for final acceptance evidence.

### Visual licensing workflows

Use the left navigation after replacing the seed password:

1. **Licenses** supports case-insensitive search by ID, customer, or normalized customer email, plus status filters, sort, pagination, and details. The demo seed receives a generated ID shown in this list; its activation code is `POC-DEMO-ACTIVATION-CODE` for development only.
2. **Issue license** selects one active product UUID from the catalog and creates a customer, one entitlement, an authoritative signed `metadata.contactEmail` snapshot, and a hashed activation credential. The normalized email is plaintext to anyone holding the signed file. Deliver the original activation code through a separate secure channel because it cannot be recovered.
3. A license detail page accepts a client-generated 32-byte Base64 activation token and the device's 64-character SHA-256 ID. It issues a downloadable signed response without rendering either secret back to the page.
4. For an online activation, enter its token and full device ID to refresh the lease and download the refreshed signed file.
5. A license detail page shows active seat usage and each current machine activation. Up to the entitlement seat count may be active concurrently; once all seats are occupied, another device receives HTTP 409 until one activation is deactivated.
6. **Revoke license** requires a reason and confirmation. Revocation prevents online validation and lease refresh. It cannot recall an offline file already in the field.
7. **Offline issuance** imports JSON created by `scripts/New-OfflineActivationRequest.ps1`, validates it, and downloads the signed `.license` response. The imported token and full device ID are cleared and never displayed.
8. **Products** supports search, add, display-name/description edit, activation, and archival while retaining stable immutable codes and historical reference counts.
9. **Audit trail** shows actor, action, target, UTC timestamp, result, and non-secret context. **System status** and `/health/ready` show aggregate readiness without secrets.

### Tests

Run the complete suite from PowerShell with Docker available:

```powershell
dotnet restore SoftwareLicensing.slnx --configfile NuGet.Config
dotnet build SoftwareLicensing.slnx --configuration Release
./scripts/Test-LicenseFlow.ps1
./scripts/Test-ActivationFlow.ps1
./scripts/Test-DatabaseAndAuth.ps1
docker build --tag license-server:test .
```

`Test-DatabaseAndAuth.ps1` creates a uniquely named PostgreSQL test container and runs
clean migration/repeated seed, authorization, one-time-secret, concurrency, email,
customer-access, Stripe webhook/policy, activation, revocation, and offline-boundary
tests. `Test-ActivationFlow.ps1` starts its own isolated PostgreSQL database and
LicenseServer process; it does **not** need a manually launched server. The scripts
remove their temporary resources unless an explicit keep switch is used.

For the final container smoke test:

```powershell
docker compose up --detach --build --wait
Invoke-WebRequest http://localhost:8080/health/ready
# Sign in through the UI, replace the seed password, then activate the generated demo license visually.
docker compose down
```

### Security boundaries and production work

The development private keys are intentionally mounted as files for this PoC. Production must replace the file-backed `SigningKeyRingService` behind `ILicenseSigner` with a KMS/HSM or isolated signing service so the public web process never loads exportable private-key bytes. Store database, MailerSend, Stripe, webhook, and TLS secrets in a secret manager, terminate HTTPS at a hardened reverse proxy, set `Security__ForwardedHeaders__KnownProxies__0` or `Security__ForwardedHeaders__KnownNetworks__0` to only that proxy hop, enable secure cookies unconditionally, add monitoring, and back up PostgreSQL, Data Protection keys, and signing-key metadata as one recovery set.

Signed license JSON provides authenticity, not confidentiality. Do not put secrets or unnecessary personal information in it. Device IDs remain spoofable software identifiers rather than hardware proof. Offline files cannot receive immediate revocation, and system-clock rollback remains a concern unless the client periodically obtains trusted server time. Passkey credentials in PostgreSQL are public keys and counters; private credentials remain in the user's authenticator.

## Recommended device and transfer model

There is no C# value that proves *absolutely* that untrusted software is running on one physical computer. A machine owner can patch the client, clone a VM, or spoof ordinary hardware identifiers. MAC addresses, CPU IDs, disk serials, host names, and ad-hoc combinations of them are especially poor primary identities: they can be missing, replaced, duplicated, virtualised, or changed by normal repairs.

Use these layers instead:

1. Give each installation a stable, privacy-preserving device ID. This PoC hashes an OS installation ID with a product namespace in [`DeviceIdentity.cs`](src/Licensing.Core/DeviceIdentity.cs). On Windows it hashes `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`; on Linux it hashes `/etc/machine-id`. Only the hash is sent to the server or placed in the signed licence.
2. Put that device ID in the signed `deviceBinding` object. A copied licence then fails validation on another installation.
3. Make the service authoritative for activation state. It permits up to the entitlement seat count in concurrent active device activations, enforces at most one active activation per device, and releases a consumed seat only after authenticated deactivation.
4. For a production Windows product, replace the PoC identifier with a per-device non-exportable key held by the TPM and make online validation a challenge/response proof of key possession. The [.NET CNG provider API](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.cngprovider?view=net-10.0) exposes the Microsoft Platform Crypto Provider, and Microsoft documents that provider as TPM-backed in [CNG Key Storage Providers](https://learn.microsoft.com/en-us/windows/win32/seccertenroll/cng-key-storage-providers). Another Windows option is publisher-scoped [`SystemIdentification.GetSystemIdForPublisher`](https://learn.microsoft.com/en-us/uwp/api/windows.system.profile.systemidentification.getsystemidforpublisher), which prefers TPM, then UEFI, then a registry fallback and reports which source it used.

Windows also defines SMBIOS-based Computer Hardware IDs, but Microsoft describes them as hashes of combinations of SMBIOS fields and notes that a value exists only when all fields in that combination are populated. They are useful signals, not a secret or proof of possession. See [Computer Hardware IDs](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/computer-hardware-ids).

Display the identifier used by this PoC:

```powershell
dotnet run --project src/LicenseValidator -- --device-id
```

The signed server-issued payload adds:

```json
{
  "deviceBinding": {
    "scheme": "os-machine-id-sha256-v1",
    "deviceId": "64-HEX-CHARACTERS...",
    "deviceName": "ACCOUNTS-PC"
  },
  "activation": {
    "activationId": "b780692f-1d21-4218-b973-2f87a0daf016",
    "mode": "online",
    "activatedAt": "2026-08-12T08:00:00Z",
    "refreshAfter": "2026-08-13T08:00:00Z",
    "leaseExpiresAt": "2026-08-19T08:00:00Z"
  }
}
```

`LicenseVerifier.ValidateActivation` compares the signed ID with the current machine using a fixed-time comparison and enforces the signed lease cutoff. `ValidateProduct` calls it automatically, so normal product validation cannot accidentally skip device binding.

### Transfer and invalidation rules

The intended state transition is:

```text
available -> active on device A -> deactivated -> active on device B
                    |
                    +-> revoked (terminal)
```

- Activation requires the customer activation code plus a random client-generated activation token. The service stores SHA-256 hashes of both, not their plaintext values.
- A retry with the same request ID, device, and token is idempotent. A licence may have up to its entitlement seat count in concurrent active machine activations, and each device may hold at most one active activation for that licence.
- Deactivation requires the activation ID, device ID, and activation token. After it succeeds, that activation stops consuming a seat immediately.
- Revocation is server state. Online validation and refresh reject a revoked licence immediately.
- Online clients receive a seven-day signed lease and should refresh after one day. If they stay disconnected, the local lease eventually expires, bounding how long a revocation can be ignored.
- A perpetual offline file cannot learn that it was revoked. The service can refuse a transfer until an offline deactivation receipt is imported, but it cannot prove that a customer deleted every copy. Strong enforcement requires periodic connectivity, a short lease, or external hardware such as a dongle. This is a fundamental boundary, not a C# implementation detail.

For a real product, offer separate policies rather than claiming identical guarantees: `online` (short renewable lease and prompt revocation), `offline` (long or no lease with weaker revocation), and possibly a customer-specific air-gapped lease duration.

## Activation API

Run the local service:

```powershell
dotnet run --project src/LicenseServer --urls http://127.0.0.1:5187
```

That command is for manually exercising the API. `Test-ActivationFlow.ps1` is self-contained: it builds the solution, starts a separate temporary server on a random local port, runs the flow, stops that server, and removes its temporary files. Stop the manually started server with `Ctrl+C` when finished; it does not need to be running for the test.

The seeded PoC license receives a generated `LIC-YYYY-MMDDXXXXXX` ID; find it on the **Licenses** page. Its activation code is `POC-DEMO-ACTIVATION-CODE`. This is an intentionally public development credential and must never become a production default.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/licenses/{licenseId}/activate` | Online activation or operator-mediated offline issuance. |
| `POST /api/v1/activations/{activationId}/validate` | Check current server state. |
| `POST /api/v1/activations/{activationId}/refresh` | Issue a fresh signed online lease. |
| `POST /api/v1/activations/{activationId}/deactivate` | Authenticate deactivation and release that activation's consumed seat. |
| `GET /api/v1/admin/licenses/{licenseId}` | Inspect state; requires `licenses.read`. |
| `POST /api/v1/admin/licenses` | Issue one catalog product by UUID; requires `licenses.issue`. |
| `POST /api/v1/admin/licenses/{licenseId}/revoke` | Permanently revoke; requires `licenses.revoke`, MFA in production, and an antiforgery token for cookie requests. |
| `GET /api/v1/admin/products` | Search the readable product catalog; requires `products.read`. |
| `POST/PATCH /api/v1/admin/products` | Add, edit, activate, or archive products; requires `products.manage`. |
| `POST /api/v1/admin/licenses/import` | Import an offline-signed `.license` artifact (multipart, 256 KB limit); requires `licenses.import`. See [License import](#license-import). |

The service uses PostgreSQL transactions, database uniqueness constraints, ASP.NET Core Identity, and immutable audit records. The web process loads a mounted development PEM only for this PoC; move signing behind a KMS/HSM boundary before production.

### Offline issuance

On the offline target machine, create a request file:

```powershell
./scripts/New-OfflineActivationRequest.ps1 -LicenseId '<generated-demo-id>'
```

Move `artifacts/offline-activation-request.json` to an operator-connected machine. The file contains an activation code and bearer token, so transport it securely. The operator posts the unchanged JSON to:

```text
POST /api/v1/licenses/<generated-demo-id>/activate
```

The response contains `signedLicense` as a JSON string; save that string unchanged as a `.license` file and carry it back to the target. Keeping the signed document opaque avoids date/string normalization by intermediary JSON tooling. Signature, product, expiry, and device checks then work with no server connection. Keep the request credentials in OS-protected storage because they are needed to submit a future deactivation. In production, an offline deactivation command should disable local state and create a signed/request-authenticated receipt for the operator to import before transfer. It still cannot force deletion of copied offline files.

### License import

`POST /api/v1/admin/licenses/import` brings a `LicenseGenerator`-signed artifact — one built entirely outside the online issuance flow — into this server's admin tracking, for cases such as migrating a customer's pre-existing offline license into central visibility. It requires `licenses.import` and a `multipart/form-data` body:

- `file` — the signed `.license` JSON, unmodified, up to 256 KB.
- `contactEmail` — required. The operator-supplied source of truth for the resolved customer; if the artifact also carries `metadata.contactEmail`, it must normalize-equal this value or the import is rejected. See ["Resolved design questions"](docs/superpowers/specs/2026-08-14-key-ring-signing-design.md#resolved-design-questions) for why the field isn't optional and doesn't silently prefer either source.

The pipeline verifies the artifact against this server's own live key ring (the same verifier the online paths use), then stores it byte-for-byte in `bytea` columns (`ImportedSignedEnvelope`/`ImportedSignedEnvelopeSha256`) alongside a relational `LicenseRecord`/`Entitlement` index built from it — the stored bytes remain the source of truth, not the index. A product the catalog doesn't recognize is auto-created as `IsActive = false`, so an import can never silently add a sellable catalog entry. A pre-activated import (the artifact carries `deviceBinding`/`activation`) gets an `Activation` row with a random, discarded-preimage token, so device-facing refresh and deactivation both fail closed; admin-side license revoke is the supported lifecycle action for it. Every import writes a `license.imported` audit record, and every auto-created product writes its own `product.auto-created` record.

There is currently no admin UI page for this endpoint — only the API. A UI page adjacent to the Offline issuance page above is tracked as a follow-up.

## Licence design

A licence contains customer-level identity once and a separate entitlement for every product:

```json
{
  "licenseId": "LIC-4F81CDA2",
  "customer": "Example Pty Ltd",
  "issuedAt": "2026-08-12T06:30:00Z",
  "metadata": {
    "purchaseOrder": "PO-88429",
    "contactEmail": "licensing@example.com",
    "contactPerson": "Jane Smith",
    "addressLine1": "100 Example Street"
  },
  "entitlements": [
    {
      "product": "gcexp",
      "edition": "professional",
      "licenseType": "perpetual",
      "seats": 5,
      "updatesUntil": "2027-08-12"
    },
    {
      "product": "winupd",
      "edition": "professional",
      "licenseType": "subscription",
      "seats": 10,
      "expiresAt": "2028-12-31T23:59:59Z",
      "updatesUntil": "2028-12-31"
    }
  ]
}
```

The signed file wraps this data with the format, algorithm, signing key ID, and signature:

```json
{
  "format": "software-license-v1",
  "algorithm": "ECDSA-P256-SHA256",
  "keyId": "primary-2026",
  "license": { },
  "signature": "..."
}
```

### How an application chooses the correct public key

The `.license` file contains the signed key identifier, such as:

```json
"keyId": "primary-2026"
```

It intentionally does **not** contain the public key. Each application ships `Licensing.Core`, which contains the trusted public-key dictionary in [`src/Licensing.Core/TrustedPublicKeys.cs`](src/Licensing.Core/TrustedPublicKeys.cs):

```text
signed keyId "primary-2026"
        ↓
TrustedPublicKeys.ByKeyId["primary-2026"]
        ↓
embedded primary public PEM
        ↓
verify the signature over format + algorithm + keyId + licence data
```

The `keyId` is itself covered by the signature. Changing it invalidates the signature. An unknown ID is rejected. A public key is never accepted from the licence file, command line, or customer, because accepting it would allow an attacker to provide their own key and signature.

Public keys do not update themselves through licence files. To add a signing key, add its public PEM to `TrustedPublicKeys.cs`, rebuild/release each product, and only then issue licences with the new key ID. Keep old public keys in later product releases while old licences must remain valid.

### Calling validation directly from an application

A product should reference `Licensing.Core` and call the same verifier used by the CLI:

```csharp
using SoftwareLicensing;

try
{
    var verified = LicenseVerifier.VerifyFile(licensePath);

    var entitlement = LicenseVerifier.ValidateProduct(
        verified,
        product: "gcexp",
        releaseDate: new DateOnly(2028, 12, 31));

    // Use entitlement.Edition, entitlement.Seats, and other trusted values.
}
catch (LicenseValidationException ex)
{
    // Do not unlock the product. Log or display ex.Message as appropriate.
}
```

`LicenseVerifier.VerifyFile` chooses the embedded public key automatically. The application does not receive or request a public-key path.

### Licence-level fields

| Field | Required | Meaning |
| --- | --- | --- |
| `licenseId` | Yes | Globally unique, immutable licence identity. The production server should enforce uniqueness. |
| `customer` | Yes | Display/legal customer name. Use a separate internal customer ID in the production database. |
| `issuedAt` | Yes | Exact signed issuance instant, including timezone. UTC with `Z` is recommended. |
| `metadata` | No | Customer-selected custom scalar fields in a controlled namespace. |
| `deviceBinding` | No | Signed device scheme, hashed device ID, and optional display name. Must appear with `activation`. |
| `activation` | No | Signed activation identity/mode and optional online lease times. Must appear with `deviceBinding`. |
| `entitlements` | Yes | Non-empty collection with no duplicate product names. |

### Product entitlement fields

| Field | Required | Meaning |
| --- | --- | --- |
| `product` | Yes | Stable product code used by the application, such as `gcexp`. Do not use a display name. |
| `edition` | Yes | Product-specific feature tier, such as `standard`, `professional`, or `enterprise`. |
| `licenseType` | Yes | Commercial model, such as `perpetual`, `subscription`, or `trial`. |
| `seats` | Yes | Positive integer capacity for this product. A later server must define what consumes a seat. |
| `expiresAt` | No | Exact UTC runtime cutoff. At or after this instant, that product is invalid. Missing means no runtime expiry. |
| `updatesUntil` | No | Last covered product release date, inclusive. Missing means update eligibility is not date-limited. |

No other fields are allowed at licence or entitlement level. This prevents misspellings from being silently signed and protects the contract from accidental collisions with future standard fields.

### Custom metadata

Customer-selected fields must be placed directly inside the optional `metadata` object:

```json
"metadata": {
  "purchaseOrder": "PO-88429",
  "contactEmail": "licensing@example.com",
  "contactPerson": "Jane Smith",
  "addressLine1": "100 Example Street",
  "priorityCustomer": true,
  "accountNumber": 4812
}
```

Metadata names must use lower camel case: the first character is `a`–`z`, followed only by ASCII letters or digits. Examples such as `purchaseOrder`, `contactEmail`, and `addressLine1` are valid; `PurchaseOrder`, `purchase_order`, spaces, dots, and hyphens are rejected.

Metadata values may be strings, numbers, or booleans. Null, nested objects, and arrays are rejected so the custom-data contract remains flat and predictable. Metadata is covered by the licence signature, but it is visible plaintext—not encrypted—so avoid secrets and unnecessary personal information.

`expiresAt` and `updatesUntil` are intentionally different. A perpetual licence can keep running after `updatesUntil`, but cannot use a product release dated after it. A subscription can use `expiresAt` to stop runtime access entirely.

## Product integration rules

Every product build should contain two immutable values:

1. Its stable product code, for example `gcexp`.
2. Its release date in `yyyy-MM-dd`, generated by the release pipeline rather than taken from the user's clock.

At startup or before unlocking licensed functionality, the product should validate both:

```powershell
dotnet run `
    --project src/LicenseValidator `
    -- `
    --license licenses/customer.license `
    --product gcexp `
    --release-date 2027-04-18
```

Validation succeeds only when:

- the envelope signature is valid;
- the `keyId` maps to a trusted embedded public key;
- the required licence schema is valid;
- the requested product exists;
- the product has not reached `expiresAt`; and
- the build release date is not after `updatesUntil`.

The `updatesUntil` date is inclusive. An entitlement through `2027-08-12` covers a release dated `2027-08-12`, but not `2027-08-13`.

## Build and test

The solution targets .NET 10:

```powershell
dotnet build SoftwareLicensing.slnx --configuration Release
./scripts/Test-LicenseFlow.ps1
./scripts/Test-ActivationFlow.ps1
```

The first test signs with both trusted keys and covers required fields, strict metadata placement and naming, nested metadata reads, case-insensitive reads, per-product editions/types/seats, active and expired products, update cutoffs, malformed dates, tampering, unknown keys, and public-key substitution. The activation test starts the local API and proves correct-device validation, blocked transfer, authenticated deactivation, successful transfer, wrong-device rejection, offline issuance, and the online/offline revocation boundary.

Use `-KeepArtifacts` to retain its temporary licences:

```powershell
./scripts/Test-LicenseFlow.ps1 -KeepArtifacts
```

## Generate and validate both key demos

Two visible demo inputs are included:

- [`input/demo-primary-license-data.json`](input/demo-primary-license-data.json)
- [`input/demo-secondary-license-data.json`](input/demo-secondary-license-data.json)

Run the demo script:

```powershell
./scripts/New-DemoLicenses.ps1
```

It performs the complete flow:

1. Signs `demo-primary.license` with the primary private development key and `keyId: primary-2026`.
2. Validates it using the embedded primary public key without a `--public-key` argument.
3. Signs `demo-secondary.license` with the secondary private development key and `keyId: secondary-2026`.
4. Validates it using the embedded secondary public key.

The larger `Test-LicenseFlow.ps1` also proves that a private key/key ID mismatch is rejected, caller-supplied public keys are rejected, unknown key IDs fail, and tampered signed data fails.

## Signing-key ring (LicenseServer)

`LicenseServer` signs licences using a live key ring, not a single hardcoded key. `SigningKeyRingService` scans the directory named by `Licensing:KeyDirectory` (`Licensing__KeyDirectory` in Compose) for `<keyId>.private.pem` / `<keyId>.public.pem` pairs every `Licensing:KeyRingReloadIntervalSeconds` (default 30s), and also whenever an admin action requests an immediate rescan. The `SigningKeys` Postgres table is the durable record of every key the server has ever seen and the sole authority for revocation:

- A complete, cryptographically valid pair (private + public) is **Active**: it can sign and verify.
- A public-only file (its private key removed, or never present) is **VerificationOnly**: it can still verify historical licences but never signs new ones. This is how you **retire** a key — delete only `<keyId>.private.pem` from the mounted directory and rescan. The public key and its `SigningKeys` row are untouched, so already-issued licences keep validating.
- **Revoking** a key (`/settings/signing-keys` in the admin UI, System Administrator only) is a separate, destructive, audited action: it fails verification for every licence that key ever signed, inside this server only — it has no effect on `LicenseValidator`/`TrustedPublicKeys.cs` embedded in already-shipped products (see below).
- Exactly one key is the **default** signing key at a time (`SigningKeys.IsDefault`, enforced by a partial unique index). `Licensing:DefaultSigningKey` is only a bootstrap seed, applied once if the database has no default yet — rotate the live default through the admin UI's "Set as default" action, not by editing configuration, since Compose environment variables don't reload without a container restart.
- Issuance forms (`/offline`, and `/licenses/{id}` activate/refresh) let an authorized operator override the signing key per request; anonymous device-facing endpoints (`/api/v1/licenses/{id}/activate`, `/api/v1/activations/{id}/refresh`) always sign with the default and accept no key parameter.

This is a deliberately reduced slice of a fuller key-ring design — see [`docs/superpowers/specs/2026-08-14-key-ring-signing-design.md`](docs/superpowers/specs/2026-08-14-key-ring-signing-design.md) for the complete design. Two earlier gaps are now closed: `LicenseGenerator` shares the server's signing implementation via `Licensing.Core.LicenseEnvelope`, and the periodic reload is a settled decision rather than a deferral — see [Explicitly rejected alternatives](docs/superpowers/specs/2026-08-14-key-ring-signing-design.md#explicitly-rejected-alternatives) for why there is no `FileSystemWatcher`. [License import](#license-import) now has a working API; only its admin UI page remains deferred.

## Keys and trust

`LicenseValidator` — the component embedded in shipped products, described in [How an application chooses the correct public key](#how-an-application-chooses-the-correct-public-key) above — is unrelated to `LicenseServer`'s live key ring and unaffected by it. It initially trusts:

| Key ID | Intended use | Public-key file |
| --- | --- | --- |
| `primary-2026` | Normal production issuance | `keys/primary-2026.public.pem` |
| `secondary-2026` | Backup/manual issuance | `keys/secondary-2026.public.pem` |

Both complete public PEM values are already compiled into `TrustedPublicKeys.cs`. The PEM files in `keys/` are convenient development copies; validation uses the source-code values, not those files.

Generate a pair by key ID, which writes the exact filenames `LicenseServer`'s key directory scanner discovers:

```powershell
dotnet run `
    --project src/LicenseGenerator `
    -- `
    keygen `
    --id primary-2028 `
    --output keys
```

That produces `keys/primary-2028.private.pem` and `keys/primary-2028.public.pem`. The explicit form is still available when you need paths that don't follow the convention:

```powershell
dotnet run `
    --project src/LicenseGenerator `
    -- `
    keygen `
    --private-key keys/primary-2028.private.pem `
    --public-key keys/primary-2028.public.pem
```

Key generation refuses to overwrite existing files by default. `--force` exists for deliberate replacement of an unused development key, but replacing a key already used for issuance will invalidate its licences. On Linux and macOS the private key file is written mode `600`; Windows has no POSIX mode, so restrict it with NTFS ACLs yourself.

Add only the public PEM to [`src/Licensing.Core/TrustedPublicKeys.cs`](src/Licensing.Core/TrustedPublicKeys.cs), mapped to its exact key ID. Release applications containing the new public key before issuing with it. Keep older public keys while their licences must validate. Never distribute private keys or accept a public key supplied beside the licence.

Before signing, the generator confirms that the selected private key really is the one `--key-id` names, by cryptographically pairing it against `<key-id>.public.pem` beside it (override with `--public-key`). This catches the common mistake of issuing a licence with the correct key ID but the wrong private key. It checks the PEM pair on disk rather than the compiled trust map above, so a key that exists only by having been dropped into the server's key directory can be signed with immediately, with no `TrustedPublicKeys.cs` edit or CLI rebuild.

The generator also checks the resolved public key against `TrustedPublicKeys.ByKeyId`, but only as a negative check, never as an allowlist: a key ID absent from that map (the normal key-ring case) signs exactly as described above, with no warning. If the key ID *is* present there and the public key about to sign with doesn't match the compiled entry, signing fails before anything is written. That is what catches a locally regenerated pair reusing an existing key ID — `keygen --id primary-2026 --force` followed by signing with the new pair now fails loudly, instead of quietly producing licences every released validator rejects. The same check catches `--public-key` pointed at some other key's counterpart under a trusted `--key-id`, since it compares the resolved key's bytes, not the path used to find them. `--force` over a key ID already used for issuance still invalidates that key ID's licences going forward — this check only prevents *signing* with a mismatched pair, it doesn't undo a bad `--force`.

Production private keys should be held in a managed KMS/HSM or isolated signing service. Replace the current signer so it asks that service to sign and never loads PEM private keys into a public web process.

## Sign a licence

Edit [`input/license-data.json`](input/license-data.json), then run:

```powershell
dotnet run `
    --project src/LicenseGenerator `
    -- `
    sign `
    --input input/license-data.json `
    --output licenses/customer.license `
    --private-key keys/primary-2026.private.pem `
    --key-id primary-2026
```

`--key-id` is optional when the private key follows the `<key-id>.private.pem` convention, as it does here — it is derived from the filename and remains overridable for keys stored under other names.

The generator rejects incomplete or ambiguous data rather than signing it. Required strings cannot be blank; seats must be positive integers; products cannot be duplicated case-insensitively; instants require a timezone; update dates must be exact `yyyy-MM-dd` values; and custom fields must follow the metadata rules above.

## Inspect signed data

All reads verify the signature and schema first. Field and product names are case-insensitive:

```powershell
# Licence-level data
dotnet run --project src/LicenseValidator -- --license licenses/customer.license --field licenseId
dotnet run --project src/LicenseValidator -- --license licenses/customer.license --field customer
dotnet run --project src/LicenseValidator -- --license licenses/customer.license --field issuedAt

# Customer-selected metadata
dotnet run --project src/LicenseValidator -- --license licenses/customer.license --field metadata.purchaseOrder
dotnet run --project src/LicenseValidator -- --license licenses/customer.license --field metadata.contactEmail

# Product-level data (also enforces expiresAt)
dotnet run --project src/LicenseValidator -- --license licenses/customer.license --product gcexp --field edition
dotnet run --project src/LicenseValidator -- --license licenses/customer.license --product gcexp --field licenseType
dotnet run --project src/LicenseValidator -- --license licenses/customer.license --product gcexp --field seats
dotnet run --project src/LicenseValidator -- --license licenses/customer.license --product gcexp --field updatesUntil
```

Exit codes are `0` for success, `1` for an invalid/expired/not-covered licence request, and `2` for arguments or runtime errors.

## Further production hardening

This format is a good offline signed entitlement, but a commercial licensing service needs additional controls:

- Generate `licenseId` server-side and make administrative issuance requests idempotent so retries cannot create accidental duplicates.
- Export immutable audit records to retention-locked security storage and alert on suspicious authentication or issuance activity.
- Define controlled vocabularies for product codes, editions, and licence types in server data rather than trusting arbitrary operator input.
- Model renewals and upgrades as new signed licence versions. Never mutate an already issued signed file.
- Publish signed revocation lists or require periodic online lease renewal where prompt revocation matters.
- Use short-lived signed leases or signed server-time responses for subscriptions. This offline POC uses the client UTC clock, which a machine owner may roll backwards.
- Define seat semantics explicitly: named user, activated device, concurrent process, or concurrent server lease. A signed seat number alone cannot enforce concurrency.
- Decide whether licences are transferable and whether optional organisation, device, or deployment binding is needed.
- Rate-limit issuance/download endpoints, authenticate operators and customers, and separate signing authority from normal administration.
- Back up signing keys and document rotation, compromise, disaster recovery, and key-revocation procedures before production issuance.

ECDSA signatures provide authenticity and tamper detection, not secrecy. Anyone holding a licence file can read its JSON, so do not put secrets or unnecessary personal data in it.
