# Key-Ring Signing and Rotation Design

## Scope

This design replaces the LicenseServer's single configured signing key with a
key-ring architecture supporting multiple ECDSA P-256 signing keys, a configured
default with per-request override, key rotation without downtime, hot reload of
key material, historical verification of licences signed by retired keys,
explicit revocation, and a supported path for importing licences generated
offline by the `LicenseGenerator` CLI. It touches `Licensing.Core`,
`LicenseServer`, and `LicenseGenerator`. `LicenseValidator` is explicitly out of
scope and unchanged.

## Current architecture

Today `LicenseServer` loads exactly one private key at startup
(`LicenseEnvelopeSigner`, reading `Licensing:PrivateKeyPath`) and hard-codes
`keyId = "primary-2026"` into every envelope it signs. Both the JSON API and the
Blazor admin UI inject the same singleton, so there has never been a "web UI key"
vs. "API key" split — the actual gap is that there is only ever one key, embedded
as a raw file path in configuration, requiring a restart to change.

Verification (`Licensing.Core.LicenseVerifier`) resolves `keyId` against a
compiled-in dictionary, `TrustedPublicKeys.ByKeyId`, which already contains two
keys (`primary-2026`, `secondary-2026`) — this dictionary is the trust store for
`LicenseValidator`, the standalone tool end products embed to verify licences
completely offline with no server, database, or filesystem key directory in
reach. `LicenseGenerator`'s `sign` command also currently checks a supplied
private key against this same dictionary as a sanity check.

A `SigningKeyRecord` entity and `SigningKeys` Postgres table already exist
(`KeyId`, `Algorithm`, `PublicKeyPem`, `Provider`, `CreatedAt`, `RetiredAt`) and
are seeded with a `primary-2026` row at startup, but nothing reads this table for
signing or verification decisions today — it is inert metadata. This design
activates it as the lifecycle-state store for the new key-ring.

## Goals

- Multiple ECDSA P-256 signing keys, installed by dropping two PEM files into a
  directory — no code change, no restart.
- One configured default signing key; authorized callers may name a different
  registered key explicitly. Unknown or non-signing key IDs fail the request;
  the server never silently substitutes the default.
- Key rotation, retirement (stop signing, keep verifying), and revocation
  (stop verifying) are distinct operations. Removing a private key file must
  never be treated as invalidating every licence that key ever signed.
- Adding/rotating/retiring/removing a key takes effect without restarting
  `LicenseServer`.
- `LicenseGenerator` continues to sign fully offline, using exactly the same
  canonicalization/signature code the server uses, with no server contact.
- A `.license` file produced by `LicenseGenerator` can be imported into the
  server's data model, verified against the server's trusted key ring, and
  preserves every product/entitlement it contains, including shapes the portal
  UI cannot itself produce (multi-product, per-entitlement expiry).
- No production private key ever ships inside the application container image.
- `LicenseValidator`'s embedded-trust design is untouched.

## Non-goals

- No HSM/KMS integration in this change (the operator runbook already flags
  this as a future production step; this design keeps that boundary intact and
  documents it).
- No change to the signed licence envelope format or version. `keyId` was
  already part of the signed payload before hashing, so it cannot be altered
  post-signature without invalidating the signature; no format/version bump is
  required for this work.
- No UI/API change to how `LicenseValidator` resolves trust.
- No attempt to make server-side online lease refresh work for a pre-activated
  device binding that arrived via import — that requires a real activation
  token hash, which an offline-generated licence cannot provide (documented
  limitation, not a defect).

## Component architecture

### `Licensing.Core` (unchanged dependency footprint: no ASP.NET Core, no EF Core)

- `EcdsaKeyPairs` — new static helper. Loads a PEM pair and cryptographically
  confirms they belong together by deriving the public key from the private key
  and comparing **decoded key material**, not PEM text: both the derived and
  the supplied public key are exported via `ECDsa.ExportSubjectPublicKeyInfo()`
  (DER bytes) and compared byte-for-byte at that level. Comparing raw PEM text
  instead would reject valid matching pairs whenever the supplied PEM differs
  only in line-wrap width, line endings (CRLF vs LF), or trailing whitespace —
  representational differences common between .NET's own PEM export and
  PEMs produced by OpenSSL or Windows tooling, even though both decode to the
  identical key. Used by both the server's key directory scanner and
  `LicenseGenerator`'s `sign`/`keygen` commands, so the "do these two files
  actually match" check exists exactly once.
- `LicenseEnvelope` — new static helper extracting the envelope construction
  and signing logic that is currently duplicated almost verbatim between
  `LicenseServer/LicenseEnvelopeSigner.cs` and
  `LicenseGenerator/LicenseSigner.cs`. Signature:
  `Sign(JsonObject license, string keyId, ECDsa privateKey) -> JsonObject`.
  Both the server and the CLI call this one implementation, so canonicalization
  and signature rules cannot drift between online and offline signing.
- `KeyDirectoryScanner` — new, pure filesystem/crypto code, no I/O beyond
  `System.IO`. Given a directory path, enumerates it, parses filenames by the
  convention below, cryptographically validates each pair via `EcdsaKeyPairs`,
  and returns an immutable list of `SigningKeyInfo` plus the raw PEM text for
  valid keys. Never throws for a single bad file — it records the problem
  against that key's `Status`/`StatusDetail` and continues scanning the rest of
  the directory.
- `LicenseVerifier` gains an overload:
  `Verify(string signedLicenseJson, IReadOnlyDictionary<string, string> trustedPublicKeysByKeyId)`.
  The existing parameterless `Verify(string)` is kept unchanged and continues to
  default to `TrustedPublicKeys.ByKeyId` — `LicenseValidator` keeps calling it
  exactly as today, with zero code change on its side.
- New contracts (interfaces/records only, no implementation):
  `ILicenseKeyRing`, `ILicenseSigner`, `ILicenseVerifier`, `SigningKeyInfo`,
  `SigningKeyStatus` (`Active`, `VerificationOnly`, `Revoked`, `Invalid`).

```csharp
public sealed record SigningKeyInfo(
    string KeyId,
    string Algorithm,
    bool HasPrivateKey,
    bool HasPublicKey,
    bool CanSign,
    bool CanVerify,
    SigningKeyStatus Status,
    string? StatusDetail,
    DateTimeOffset DiscoveredAt,
    DateTimeOffset LastSeenAt);

public interface ILicenseKeyRing
{
    string DefaultKeyId { get; }
    IReadOnlyList<SigningKeyInfo> Keys { get; }
    SigningKeyInfo? Find(string keyId);
}

public sealed record LicenseSigningResult(
    bool Success, JsonObject? Envelope, string? ErrorCode, string? ErrorMessage);

public interface ILicenseSigner
{
    LicenseSigningResult Sign(JsonObject license, string? requestedKeyId);
}

public interface ILicenseVerifier
{
    VerifiedLicense Verify(string signedLicenseJson);
}
```

`ILicenseSigner`/`ILicenseVerifier` implementations hold only PEM text
internally and never hand raw key material back to callers — private key
material stays encapsulated inside the signing implementation, satisfying the
"do not unnecessarily expose private key material" requirement structurally,
not just by convention.

### `LicenseServer`

- `SigningKeyRingService` — new hosted `BackgroundService` plus the concrete
  `ILicenseKeyRing`/`ILicenseSigner`/`ILicenseVerifier` implementation. Owns:
  - a `FileSystemWatcher` on the configured key directory (create/change/
    delete/rename), debounced 500ms;
  - an unconditional 60-second periodic reconciliation timer, because
    Docker/Linux bind-mount watcher events are not guaranteed reliable;
  - reconciliation against the `SigningKeys` table (see below);
  - atomic snapshot replacement via `Interlocked.Exchange` over an immutable
    `KeyRingSnapshot` record, so concurrent readers during a reload always see
    either the old or the new complete snapshot, never a partial one.
  - A reload that finds zero valid keys, or that fails to parse/validate a
    file, logs a warning/error for that specific key and **keeps the previous
    snapshot in place**; it never drops the server to an empty or crashed key
    ring because one file was replaced mid-write.
- Replaces `LicenseEnvelopeSigner` at all four current injection points
  (`Program.cs:500`, `Program.cs:519`, `Program.cs:862`,
  `Components/Pages/Offline.razor:5`, `Components/Pages/LicenseDetails.razor:6`)
  with `ILicenseSigner`/`ILicenseVerifier`.
- New admin endpoints under `/api/v1/admin`:
  - `GET /signing-keys` — list `SigningKeyInfo` (permission: `licenses.read`,
    since it is read-only operational status, not secret material).
  - `POST /signing-keys/{keyId}/revoke` — sets `RevokedAt`/`RevokedBy`/
    `RevocationReason` (new permission `signingKeys.manage`, System
    Administrator only; requires confirmation + reason, same pattern as
    licence revoke).
  - `POST /signing-keys/{keyId}/set-default` — requires the target key to
    currently have `CanSign == true`; sets `IsDefault = true` on that row and
    `false` on every other row in one transaction (permission
    `signingKeys.manage`).
  - `POST /licenses/import` — multipart upload, 256 KB body limit, new
    permission `licenses.import`.
- New UI: a signing-key status panel (read-only for most viewers; a
  "Set as default" action next to any Active key, gated by
  `signingKeys.manage`, following the existing API-key rotate/revoke button
  pattern), an "Import license" page, and a key-selector `<select>` added to
  the two existing operator-facing signing forms (Offline.razor,
  LicenseDetails.razor activate/refresh), all reusing existing
  permission-gated `<AuthorizeView>` patterns already used throughout this
  codebase.

### `LicenseGenerator`

- Keeps its existing flat `keygen`/`sign` verb structure.
- `sign`: `--key-id` becomes optional, derived from the `--private-key`
  filename when it matches `<keyId>.private.pem`; still overridable. Drops its
  dependency on `TrustedPublicKeys.ByKeyId` for the pair sanity-check, using
  `EcdsaKeyPairs` against the supplied (or derived) public key instead. Signs
  via the shared `LicenseEnvelope.Sign`.
- `keygen`: gains `--id <keyId> --output <dir>`, producing
  `<dir>/<keyId>.private.pem` and `<dir>/<keyId>.public.pem`, alongside the
  existing explicit `--private-key`/`--public-key` form. Still refuses
  overwrite without `--force`, still never prints key material. Applies
  `chmod 600` on the private key file when running on a platform that supports
  POSIX permissions (best-effort; documented as unavailable on Windows, where
  NTFS ACLs are the operator's responsibility).

### `LicenseValidator`

No code changes. It keeps calling `LicenseVerifier.VerifyFile`/`Verify` with no
arguments, resolving trust from the compiled `TrustedPublicKeys.ByKeyId`
exactly as today.

## Key filename convention and directory validation

Format: `<keyId>.private.pem` and `<keyId>.public.pem` in one flat directory
(no subdirectories are scanned).

`keyId` must match `^[a-z0-9]+(-[a-z0-9]+)*$`, 3–64 characters — lowercase
letters, digits, and single hyphens between segments only. This blocks path
traversal (no `/`, `..`, no leading/trailing hyphen), blocks case-collision
ambiguity across case-insensitive filesystems, and is restrictive enough that
`keyId` can safely be interpolated into a filename lookup with no further
escaping.

Scanning rules:

- A file whose name doesn't end in exactly `.private.pem` or `.public.pem`, or
  whose derived `keyId` fails the pattern above, is ignored (not an error) —
  operators may keep unrelated files (README, checksums) in the same directory.
- A `<id>.private.pem` with **no matching** `<id>.public.pem` is skipped with a
  warning log and does not appear in the ring at all: a private key with no
  known public counterpart can't be verified against, so it is never trusted
  for signing either.
- A `<id>.public.pem` with no matching private file is **never skipped**. This
  is the expected, normal shape of a verification-only/historical key (see
  lifecycle, below), and it always appears in the ring as `VerificationOnly`.
  Retiring a key by deleting only its private file — the primary retirement
  workflow this design specifies — depends on this asymmetry; treating the two
  "missing half" cases the same way would silently break retirement by
  dropping the retired key out of the ring entirely instead of demoting it to
  verification-only.
- Every complete pair is cryptographically validated via `EcdsaKeyPairs`; a
  mismatched pair is skipped with an error log, not fatal to the rest of the
  scan.

Existing development keys are renamed to fit the convention exactly:
`keys/license-primary-2026-private.pem` → `keys/primary-2026.private.pem`,
`keys/license-primary-2026-public.pem` → `keys/primary-2026.public.pem`, and
the same pattern for `secondary-2026`. The `keyId` values themselves are
unchanged, so no alias/migration logic is needed anywhere — `TrustedPublicKeys`,
existing tests, and existing demo scripts that reference `primary-2026` /
`secondary-2026` keep working unmodified. Only the two `*-public.pem` files are
currently tracked in git (confirmed via `git ls-files`); the private files are
already untracked/gitignored and must be regenerated locally (e.g. via the
enhanced `keygen --id`) after the rename. `.gitignore` changes from
`keys/*-private.pem` to `keys/*.private.pem` to match the new suffix exactly.

## Key lifecycle model

Four states, computed per key from the combination of live directory contents
and two new `SigningKeys` columns:

| Status | Disk state | DB state | CanSign | CanVerify |
| --- | --- | --- | --- | --- |
| Active | valid pair | not revoked | yes | yes |
| VerificationOnly | public only (no private file) | not revoked | no | yes |
| Revoked | any | `RevokedAt` set | no | no |
| Invalid | pair present but fails crypto validation, or malformed PEM | n/a | no | no (excluded from ring) |

Revocation always wins over whatever is physically mounted: if `RevokedAt` is
set, verification fails even though the public key file might still be present
and the signature would otherwise check out cryptographically. This is
deliberate — revocation must fail closed regardless of what an operator has or
hasn't removed from disk yet.

Operational actions map onto this model directly:

- **Rotate the default** — `POST /signing-keys/{keyId}/set-default` (see
  revised Database changes below). The default signing key is DB-backed, not
  purely config-driven: `IOptionsMonitor`'s reload-on-change only works for
  file-based configuration providers with `reloadOnChange` (the default for
  `appsettings.json`), and this project's own container deployment supplies
  `Licensing__*` values as Compose environment variables — Compose's
  environment-variable provider has no reload support at all, and changing it
  requires recreating the container. Making the default DB-backed instead
  means default-key rotation works identically and without a restart in both
  local development and the container deployment, and reuses the
  reconciliation loop `SigningKeyRingService` already runs for revocation —
  no second reload mechanism is needed. `Licensing:DefaultSigningKey` in
  config is retained only as the **bootstrap seed value**, applied once if no
  `SigningKeyRecord` is yet marked default.
- **Retire a key from signing, keep it trusted** — delete only the
  `<keyId>.private.pem` file from the mounted directory. The public key and its
  `SigningKeys` row are untouched, so historical licences keep validating.
  `RetiredAt` (already present on `SigningKeyRecord`, previously unused) is
  stamped automatically by the reconciler the first time it observes that key
  transition from signable to public-only — it is a record of *when retirement
  was first observed*, not a manually operator-toggled switch. `CanSign` is
  always computed from current disk state, not from `RetiredAt`, so restoring
  the private key file un-retires the key with no separate "un-retire" action
  needed.
- **Revoke a compromised key** — `POST /signing-keys/{keyId}/revoke` with a
  reason. This is explicit, audited, and intentionally destructive to every
  licence that key ever signed — but **only within `LicenseServer`'s own live
  verification** (its `ILicenseVerifier`, and the new import feature). It has
  no effect on the standalone `LicenseValidator` already embedded in shipped
  products: per Non-goals, that tool is unchanged and keeps resolving trust
  from the compiled `TrustedPublicKeys.ByKeyId`
  (`Licensing.Core/LicenseVerifier.cs:60`), which has no concept of
  revocation at all. A licence — or a forgery made with the compromised
  private key — still validates successfully inside any already-shipped
  product until that product is rebuilt with an updated
  `TrustedPublicKeys.cs` and customers upgrade to it. The runbook update must
  say this explicitly, so operators do not mistake this endpoint for in-field
  revocation: propagating a compromise to already-shipped products is a
  separate, out-of-scope release process, not a side effect of calling this
  endpoint.

### Database changes

New EF Core migration extending `SigningKeyRecord`:

- `RevokedAt DateTimeOffset?`, `RevokedBy string?`, `RevocationReason string?`
- `DiscoveredAt DateTimeOffset`, `LastSeenAt DateTimeOffset` — when the
  reconciler first/most recently observed this key present on disk, so "known
  but currently unmounted" is distinguishable from "never existed" in the
  admin status view.
- `RetiredAt` already exists on the entity and was previously written only at
  seed time with no ongoing meaning; this design activates it as described
  above (auto-stamped on first observed loss of the private key file).
- `IsDefault bool` (default `false`) — exactly one row may be `true` at a
  time, enforced with a Postgres partial unique index
  (`CREATE UNIQUE INDEX ... ON "SigningKeys" ("IsDefault") WHERE "IsDefault"`)
  so the constraint holds even though most rows are `false`. Seeded `true` for
  whichever key matches `Licensing:DefaultSigningKey` the first time the
  application starts against a database with no default set yet; every
  subsequent rotation goes through `set-default`, not configuration.

On each reload, `SigningKeyRingService` upserts a `SigningKeyRecord` for every
key found on disk (creating a row with `Provider = "file-directory"` for
previously-unseen keys, updating `LastSeenAt` for known ones, stamping
`RetiredAt` the first time a previously-signable key is seen without its
private file) and applies `RevokedAt` from existing rows onto the in-memory
snapshot.

The table is therefore both the audit trail of every key the server has ever
seen and the authority for revoked status — consistent with Approach 1 agreed
earlier, and consistent with the requirements' own suggestion of a
read-only key mount plus a separate writable metadata location: Postgres is
that separate location, and it already exists in this application.

### Long-lived vs. per-operation `ECDsa` instances

The snapshot holds PEM **text**, not long-lived `ECDsa` objects. Each
`Sign`/`Verify` call creates a short-lived `ECDsa` via `ECDsa.Create()` +
`ImportFromPem`, matching the existing code's pattern. `System.Security.Cryptography`
types are not documented as safe for concurrent use from multiple threads, and
this workload (interactive licence activation, not a hot loop) does not need
the marginal performance of caching parsed key objects across requests —
correctness under concurrency is worth more here than avoiding repeated PEM
parsing.

## Hot reload mechanism

> **Superseded in implementation.** Trigger 1 below (the `FileSystemWatcher`)
> was rejected on review and is not implemented — see
> [Explicitly rejected alternatives](#explicitly-rejected-alternatives) for the
> reasoning. What ships is trigger 2 (interval configurable via
> `Licensing:KeyRingReloadIntervalSeconds`, default 30s), an admin-triggered
> rescan endpoint, and a synchronous republish inside `set-default`/`revoke`.

`SigningKeyRingService.ReloadAsync()` is the single entry point, invoked by:

1. The debounced `FileSystemWatcher` handler (any create/change/delete/rename
   event in the key directory, coalesced over a 500ms window so a burst of
   filesystem events from an atomic multi-file key install triggers one
   reload, not several).
2. An unconditional periodic timer every 60 seconds, as a fallback for missed
   or unreliable watcher events on bind-mounted volumes.
3. Every admin mutation that changes key state (`set-default`, `revoke`) and
   the explicit admin rescan action, each awaiting the reload before returning
   so a successful admin response never reports state the ring has not yet
   published.

`ReloadAsync` is guarded so overlapping triggers coalesce into a single
in-flight reload rather than running concurrently. It always: scans the
directory (`KeyDirectoryScanner`), reconciles against `SigningKeys`, builds a
complete new `KeyRingSnapshot`, and only then atomically swaps it in. Any
failure during scan/build leaves the previously published snapshot in place,
with the specific problem logged (never at a level that includes PEM content).

## Signing and verification behavior

`ILicenseSigner.Sign(license, requestedKeyId)`:

- `requestedKeyId == null` → resolve `ILicenseKeyRing.DefaultKeyId`. If that
  key cannot currently sign (missing private key/retired/revoked), this is a
  server configuration problem: log at Error and return a failure result
  (surfaced as a `500`/problem response), never a silent fallback to some
  other key.
- `requestedKeyId` supplied → must resolve to a key with `CanSign == true`.
  Unknown ID, verification-only key, or revoked key are all client-facing
  validation errors (`400`), never a silent fallback to the default.

Where key selection is exposed, per the earlier agreed decision: **only** the
two authenticated admin Blazor flows (Offline.razor issuance, LicenseDetails
activate/refresh-and-issue), gated by the same permission the action already
requires (`licenses.issue` / `activations.manage`). The anonymous device-facing
`/api/v1/licenses/{licenseId}/activate` and
`/api/v1/activations/{activationId}/refresh` endpoints are not changed to
accept a key parameter and always sign with the default key — unauthenticated
callers get no influence over which server key material is used.

Verification: the server's internal post-sign sanity check
(`Program.cs:867`) and the new import feature both move from
`SoftwareLicensing.LicenseVerifier.Verify(json)` (static dictionary) to the
key-ring-backed `ILicenseVerifier`, so a licence signed with a newly rotated-in
key (never present in the compiled `TrustedPublicKeys`) verifies correctly, and
a revoked key's signature is rejected even though `TrustedPublicKeys` has no
concept of revocation at all.

## License import

`LicenseRecord` gains: `Provenance` (`"issued"` default, `"imported"`),
`ImportedSignedEnvelope` (nullable `bytea`, the verbatim uploaded bytes),
`ImportedSignedEnvelopeSha256` (nullable `bytea`), `ImportedAt`, `ImportedBy`.
See [Resolved design questions](#resolved-design-questions) below for why this
is `bytea` and not the `jsonb` an earlier draft specified.

Imported licences are stored as the exact signed bytes that were uploaded,
rather than being regenerated on demand from relational state the way
portal-issued licences are (`LicenseStore.CreateLicenseAsync` derives each
entitlement's `expiresAt` from a single `LicenseRecord.ExpiresAt` column today,
which cannot represent a CLI-authored licence with independently-expiring
multi-product entitlements without a much larger data-model change). Preserving
fidelity by storing the verbatim artifact and only building a relational
*index* of it is simpler and satisfies "avoid regenerating or resigning unless
there is an explicit reason to."

Building that index for a multi-product licence requires a schema change of
its own: `ApplicationDbContext.cs:186` currently defines
`HasIndex(x => x.LicenseRecordId).IsUnique()` on `Entitlement`, enforcing at
most one entitlement per license record — a real constraint today because
every existing issuance path (portal, API) creates exactly one. The same
migration that adds the `Provenance`/`Imported*` columns must replace that
index with a composite unique index on `(LicenseRecordId, Product)` (still
preventing two entitlements for the same product on one license, matching the
in-JSON duplicate-product check `LicenseSchema.Parse` already performs, while
allowing multiple distinct products). Every other path that assumed exactly
one entitlement — e.g. `LicenseDetails.razor`'s use of
`license.Entitlements.Single()` for the seats/updates-until edit panels —
must be reviewed as part of this migration and either guarded to the
single-entitlement case (portal-issued licences remain single-product) or
extended; imported multi-product licences are read/searched/revoked as a
whole but are not edited product-by-product through the portal's terms-editing
UI, which stays scoped to the one-entitlement-per-portal-license invariant
`docs/README.md` already documents.

Pipeline for `POST /api/v1/admin/licenses/import` (permission
`licenses.import`, multipart upload, 256 KB limit):

1. Read and parse the uploaded file as JSON; reject non-object/malformed input.
2. Validate envelope shape and `format`/`algorithm` via the existing
   `LicenseVerifier` envelope checks.
3. Read `keyId`; look it up in the live key ring. Unknown or revoked key →
   reject with a clear error. This is the same verifier used for the server's
   own internally generated licences — one code path, not a second one for
   imports.
4. Verify the cryptographic signature.
5. Run `LicenseSchema.Parse` on the licence payload (existing strict schema
   validation — rejects unknown fields, ambiguous casing, malformed
   dates/entitlements, exactly as it does for locally-generated licences).
6. Resolve/create the `Customer` row by normalized email — the operator-supplied
   one, see [Resolved design questions](#resolved-design-questions).
7. Create `LicenseRecord` (`Provenance = "imported"`) plus one `Entitlement`
   summary row per product in the licence (search/listing index only — not the
   signing source of truth for this record), auto-creating an inactive
   `ProductDefinition` for any product the catalog does not have.
8. If the licence already contains `deviceBinding` + `activation`, also create
   a matching `Activation` row so the license-detail page shows accurate status
   and admin-side revoke works normally. (An earlier draft of this step claimed
   deactivation also works normally; it does not — see
   [Resolved design questions](#resolved-design-questions).) If `activation.mode == "online"`, the
   import still succeeds but logs/flags that server-side lease refresh will not
   function for that activation, since no server-issued activation-token hash
   exists to authorize it — this is a documented limitation, not a rejection,
   because rejecting would silently drop entitlements the requirements say must
   be preserved.
9. Record an audit event (`license.imported`) with actor, source filename hash
   (not raw content), and resulting license ID.
10. Any failure at steps 1–5 leaves the database untouched and returns a
    `400`/`422` describing exactly which check failed, without ever revealing
    which specific byte differs (no signature/plaintext oracle).

A new admin UI page (adjacent to the existing Offline issuance page) exposes
this as a file upload form gated by `licenses.import`.

### Resolved design questions

Design review found four places where the import pipeline above could not be
built as written against the current schema. Each is resolved below. **None of
this is implemented** — `POST /api/v1/admin/licenses/import` does not exist in
the codebase. These are the decisions the implementation must follow when it is
built, recorded now so the implementation is not blocked on re-litigating them.

**Products absent from the catalog → auto-create an inactive placeholder.**
`Entitlement.ProductDefinitionId` is a required FK
(`Data/Entities.cs`, `Data/ApplicationDbContext.cs`), but a signature-verified
offline licence may legitimately name a product this server's catalog has never
heard of, because `LicenseGenerator` accepts any product string with no catalog
lookup. Rejecting such an import would contradict this design's own requirement
to preserve every entitlement the artifact contains; making the FK nullable
would fork every catalog join in the application for one feature's benefit.
So the importer creates a `ProductDefinition` for each unknown product with
`IsActive = false`, `DisplayName` set to the product code, and a description
marking it as import-created and needing operator review. `IsActive = false` is
the load-bearing part: `LicenseStore` will only issue against active products
and the active-product listing excludes it, so an import can never quietly add
a sellable catalog entry — an operator must deliberately name and activate it
first. Each auto-creation is audited alongside `license.imported`.
One hard limit applies: `CK_ProductDefinitions_Code` restricts catalog codes to
`^[a-z0-9][a-z0-9-]{0,99}$`, while `LicenseSchema` accepts any non-blank
product string. The importer must therefore validate every product code against
that pattern in step 5 and reject the whole upload with a clear message when one
cannot be a catalog code — never silently mangle a signed product name into a
conforming one.

**Email for a metadata-free licence → required operator-supplied field.**
A generator-issued licence may omit `metadata` entirely, and its signed
`customer` field is a display name, not an address — so the artifact alone
cannot satisfy `CK_Licenses_ContactEmail` or the issuance-time invariant that
`MetadataJson.contactEmail` equals the resolved customer's normalized email.
The import form therefore carries a **required** `contactEmail` field, supplied
by the authenticated operator, and that value is the single source of truth for
resolving the `Customer` row. If the uploaded artifact also carries
`metadata.contactEmail`, it must normalize-equal the operator's value or the
import is rejected: silently preferring either one would mean the stored record
disagrees with something a human or a signature asserted.
This is only coherent because of the decision below it: for an imported record,
`LicenseRecord.MetadataJson` is the server's *searchable index* of the licence,
not a copy of the signed artifact. Writing the operator's email there does not
alter, re-sign, or contradict the artifact, which is stored separately and
byte-for-byte. The import UI must say so plainly, or the field looks like
tampering with signed content.

**Pre-activated imports → an unforgeable activation token, not a nullable one.**
`Activation.TokenHash` is a required `byte[]` and an offline artifact carries no
server-issued token to hash into it. Rather than making the column nullable or
introducing a sentinel that every credential check must special-case — where a
single missed check is an authentication bypass on a security-relevant path —
the importer generates a cryptographically random 32-byte `TokenHash` for the
imported `Activation` row and discards the preimage. Nothing is ever issued to
any device.
The row then exists, so the licence-detail page shows accurate activation state
and admin-side licence revoke works normally, while device-facing refresh *and*
deactivation both fail closed automatically, by construction rather than by a
branch someone could forget: no caller can present a token matching a hash whose
preimage was never generated. This supersedes step 8's claim that "deactivate
work[s] normally" for imported activations, and extends the existing documented
online-refresh limitation to deactivation as well. Admin-side licence
revocation is the supported lifecycle action for an imported activation, and
the UI must present it that way.

**Verbatim artifact storage → `bytea`, not `jsonb`.**
PostgreSQL `jsonb` parses and re-normalizes on write: it does not preserve
whitespace, key order, or duplicate-key representation. A `jsonb` column
therefore cannot deliver the byte-for-byte fidelity that is the entire
justification for storing the uploaded artifact instead of regenerating it.
`ImportedSignedEnvelope` is `bytea`, holding exactly the bytes received, with no
decode/re-encode round trip on the way in (`text` would also lose the ability to
hold a NUL byte, forcing a validation rule that `bytea` simply does not need).
`ImportedSignedEnvelopeSha256` stores a digest of those bytes for integrity
checking and duplicate detection. No parsed `jsonb` projection of the artifact
is needed: the relational `LicenseRecord`/`Entitlement` rows the pipeline already
builds are the search index, and re-verification reads the stored bytes directly.

## Container and configuration changes

`Licensing` configuration becomes a strongly-typed, `IOptionsMonitor`-bound
`LicensingOptions { IdTimeZone, KeyDirectory, DefaultSigningKey }`.
`PrivateKeyPath`/`PublicKeyPath` are removed. `DefaultSigningKey` here is a
**bootstrap seed only** (see Database changes) — it is read once, at seed
time, to pick the initial `IsDefault` row, and is not consulted again at
runtime. Live rotation always goes through `set-default`, so it works the
same way locally and in the container regardless of which configuration
provider is in play.

- `appsettings.json` (dev): `"KeyDirectory": "../../keys"`,
  `"DefaultSigningKey": "primary-2026"`.
- `appsettings.Container.json`: `"KeyDirectory": "/var/lib/licsense/keys"`,
  `DefaultSigningKey` supplied via Compose environment variable, exactly like
  every other `Licensing__*` value already is — safe now that it is only ever
  read once at seed time, not watched for live changes.
- `Dockerfile`: the `COPY ... keys/license-primary-2026-public.pem ...` line is
  removed entirely — the built image contains zero key material, public or
  private.
- `compose.yaml`: the single-file secret mount
  (`${LICENSE_SIGNING_KEY_PATH}:/run/secrets/license-signing-key.pem:ro`) is
  replaced with a read-only directory mount:
  `${LICENSE_SIGNING_KEY_DIR:?Set LICENSE_SIGNING_KEY_DIR in .env}:/var/lib/licsense/keys:ro`.
  The mount stays read-only; lifecycle metadata lives in Postgres, not in the
  key directory, so the running container never needs write access there.
- `.env.example` updated to describe `LICENSE_SIGNING_KEY_DIR` instead of
  `LICENSE_SIGNING_KEY_PATH`.

## Security review

- Private key PEM content is never returned by any API response, never logged,
  and never sent to the Blazor client — it stays inside
  `SigningKeyRingService`'s in-memory snapshot, used only to construct
  short-lived `ECDsa` instances for signing.
- API clients select a registered `keyId`, never a filesystem path; `keyId`
  values accepted from clients are validated against the same
  `^[a-z0-9]+(-[a-z0-9]+)*$` pattern used for filenames before ever being used
  in a lookup, so there is no path-traversal surface through a client-supplied
  key identifier.
- Unknown, verification-only, and revoked key IDs all fail closed (signing
  refuses; verification refuses) with no distinguishing information leaked
  about *why* beyond what's necessary for an authorized operator to act on.
- Uploaded licences never control which public-key file gets opened — `keyId`
  is validated against the same pattern and resolved only through the key
  ring's own lookup, not through direct file access driven by upload content.
- Malformed key reloads are isolated per-key and never bring down the whole
  ring or the application.
- Signature algorithm remains ECDSA P-256 / SHA-256 /
  `IeeeP1363FixedFieldConcatenation`, unchanged from the current implementation
  — no new cryptography introduced, only new key-selection/lifecycle logic
  around the existing, already-reviewed signing primitives.
- Public/private pairs are cryptographically cross-validated before a key is
  ever accepted into the ring (`EcdsaKeyPairs`), preventing an accidentally
  mismatched pair from being silently trusted.
- File permissions: `keygen --id` applies `chmod 600` to generated private keys
  on POSIX platforms (best-effort; documented Windows ACL gap). Mounted
  production key directories should be `0700`/owned by the container's app
  user — documented in the operator runbook, enforced by deployment
  configuration rather than application code (the app cannot chmod a
  read-only bind mount it doesn't own).

## Backward compatibility

`primary-2026` and `secondary-2026` keep their exact key IDs across the rename;
no alias table or migration mapping is required. `LicenseValidator` and
`TrustedPublicKeys.cs` are untouched, so every already-issued licence file and
every already-built product embedding `LicenseValidator` keeps validating
exactly as before. The signed envelope format and version string
(`software-license-v1`) do not change.

## Testing plan

**`Licensing.Core` unit tests (new, no DB/web host required):**
`EcdsaKeyPairsTests` (matching pair accepted, mismatched pair rejected,
malformed PEM rejected safely); `KeyDirectoryScannerTests` (valid pairs
discovered, incomplete pairs skipped, invalid `keyId` characters/path
traversal rejected, public-only file accepted as verification-only, malformed
PEM does not throw out of the scan); `LicenseEnvelopeTests` (shared sign/verify
round-trip, tampering with `keyId` post-signature invalidates the signature).

**`LicenseServer.Tests` integration tests (existing `PostgresWebFixture`
pattern, updated to point at a temp key *directory* instead of single
`PrivateKeyPath`/`PublicKeyPath` settings, dropping the current
`TrustedPublicKeys` monkey-patch fallback):**
default signing key is used when no key is requested; explicitly selected key
is used; unknown selected key fails with a clear error; a verification-only
key cannot sign; a verification-only key can still verify; multiple keys
coexist in one ring; the signed licence contains the correct `keyId`; mutating
`keyId` post-signature invalidates the signature; a licence signed by key A
verifies with key A and fails with key B; adding a key to the directory is
usable without a server restart; calling `set-default` rotates the default
key and takes effect for the very next signing call with no restart, and
leaves exactly one row with `IsDefault = true`; removing a private key stops
new signing but leaves historical verification working; revoking a key fails
verification even though the public PEM is still present, while confirming
that revocation does **not** retroactively affect the separate, unchanged
`LicenseValidator`/`TrustedPublicKeys` path (an explicit test exercising both
verifiers against the same revoked-key licence, asserting opposite outcomes);
concurrent signing requests during a reload never observe a torn/partial key
ring; a multi-product import creates one `Entitlement` row per product
without violating a per-license uniqueness constraint; legacy
`primary-2026`/`secondary-2026` licences continue to verify unchanged; import
happy path, multi-product import, invalid-signature import, unknown-key
import, revoked-key import, and
path-traversal-flavored `keyId` in an uploaded licence all behave as specified.

**CLI/offline round-trip (extending `Test-LicenseFlow.ps1` and/or a small new
CLI test project):** an offline `LicenseGenerator`-signed licence verifies
against the server's live key ring; `keygen --id` produces correctly-named
files and refuses accidental overwrite; `sign` rejects a private/public
mismatch.

## Documentation updates

- `README.md`: rewrite the existing key-rotation section (currently describing
  editing `TrustedPublicKeys.cs` and rebuilding for *server* signing) to
  describe the new key-ring workflow for `LicenseServer`, while keeping the
  existing `TrustedPublicKeys.cs`/rebuild instructions correctly scoped to what
  they actually govern: releasing products that embed `LicenseValidator`.
- `docs/operator-runbook.md`: replace the single `Licensing__PrivateKeyPath`
  bullet with key-directory mount guidance; expand the existing "Signing-key
  compromise" incident cue into full rotate/retire/revoke procedures,
  including the explicit warning that revocation invalidates every licence
  that key ever signed, unlike retirement.
- No new ADR directory — this repository already uses
  `docs/superpowers/specs/*-design.md` as its architecture-decision record
  (see the `prompts-09-13` and `prompts-14-16` specs), and this document
  follows that same convention.

## Explicitly rejected alternatives

- **Sidecar JSON/YAML state file in the key directory** — rejected because it
  would require the key directory to be writable, undermining the read-only
  secret-mount goal, and it duplicates functionality (audit trail, backup,
  migration tooling) Postgres already provides for this application.
- **Storing PEM contents directly in Postgres, no filesystem keys** —
  rejected: contradicts the "drop two PEM files in a directory" requirement,
  pulls private key material into the application database (larger blast
  radius on DB compromise), and reintroduces the "complicated DB-backed HSM
  replacement" the requirements explicitly steer away from.
- **Exposing `signingKeyId` on anonymous device activate/refresh endpoints** —
  rejected: no legitimate use case for an unauthenticated device to choose
  server signing material, and it would expand attack surface for no benefit.
- **Long-lived shared `ECDsa` instances in the key-ring snapshot** — rejected
  in favor of short-lived per-operation instances, since .NET crypto types are
  not documented as thread-safe for concurrent use and this workload has no
  need for the marginal performance gain.
- **Rotating the default signing key purely through mounted configuration**
  (the original draft of this design) — rejected after review: ASP.NET Core's
  environment-variable configuration provider, which is how this project's
  own Compose deployment supplies every `Licensing__*` value, has no
  reload-on-change support, so a container deployment following this
  project's existing pattern could not actually rotate the default without a
  restart, contradicting the no-restart requirement. Moved to a DB-backed
  `IsDefault` flag reconciled by the same loop that already handles
  revocation, which works identically in both deployment shapes.
- **A debounced `FileSystemWatcher` alongside the periodic reload** (specified
  in "Hot reload mechanism" above) — rejected after implementation review; the
  shipped key ring reloads on a periodic timer plus an admin-triggered rescan
  only. The watcher was always specified as an optimization *on top of* an
  unconditional timer that has to exist anyway, precisely because bind-mounted
  volumes do not reliably deliver inotify events — which is exactly the
  deployment shape this project ships (`docker-compose` mounts the key
  directory read-only). So the watcher could never be the mechanism relied
  upon; it could only shorten the happy path.
  What it would shorten is at most one reload interval (default 30s,
  configurable via `Licensing:KeyRingReloadIntervalSeconds`), on a rare,
  deliberate, operator-driven action — and the operator performing that action
  already has a strictly better tool: `POST /signing-keys/rescan` and the
  "Rescan key directory" button, which pick the key up immediately and on
  demand, rather than at some point after an event the operator cannot observe.
  Rescan writes an `AuditRecord` (`signingKey.rescan`) unconditionally, the
  same as `set-default` and `revoke`, so the operator's faster path is exactly
  as traceable as the slower ones.
  Against that, `FileSystemWatcher` carries real cost: silent event loss on
  `InternalBufferOverflowException`, per-platform behavioral differences,
  duplicate/partial events during multi-file key installs requiring the
  debounce window to be tuned, and inotify handle limits. Testing it means
  timing-dependent tests around filesystem events, which is a poor trade for
  saving a bounded delay on an infrequent action.
  Revisit if a deployment shape appears where keys land in a directory the
  process watches natively, no operator is present to trigger a rescan, and
  sub-30-second pickup is a stated requirement. Note that this affects only
  *filesystem* pickup latency: admin mutations (`set-default`, `revoke`)
  republish the ring snapshot synchronously before returning and never wait for
  the timer at all.
