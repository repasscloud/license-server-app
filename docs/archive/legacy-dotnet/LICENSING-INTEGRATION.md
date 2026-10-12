# Licensing.Core Integration Guide

**Audience:** this file is written for two readers at once — you (the human), who
should skim the numbered sections for the business/product picture, and a Claude
Code session working in a *separate* CLI-application repo, which should treat
sections 3–10 as an implementation spec and section 10 as its task list.

**Source of truth:** everything below was verified against the actual code in
`repasscloud/license-server-app` (this repo) on 2026-08-16, not guessed from
the package name. File/line references let you re-verify anything.

---

## 1. What this system is

Three pieces, one repo (this one), one shared library:

| Component | What it does | Where |
| --- | --- | --- |
| **LicenseServer** | ASP.NET Core app: Stripe billing → license issuance, online activation API, admin UI, transactional email | `src/LicenseServer` |
| **LicenseGenerator** | Offline CLI an *admin* runs to hand-sign a license file without the server (key management, manual/offline issuance) | `src/LicenseGenerator` |
| **Licensing.Core** | The NuGet package. Offline, no-network license *verification*. This is what your CLI app references. | `src/Licensing.Core` |

Your CLI app never talks to `LicenseGenerator` or the server's database — it only
does two things: (a) optionally call the server's public HTTP activation API, and
(b) verify the signed license file it ends up with, using `Licensing.Core`. Both
paths converge on the same artifact: a signed JSON "license envelope" file sitting
on disk next to (or near) your app.

---

## 2. The end-to-end human flow

### 2.1 Purchase → license issuance → email

1. Customer buys a plan in your shop; Stripe Checkout runs.
2. Stripe fires a webhook at the license server
   (`POST /api/v1/integrations/stripe/webhook`).
3. The server maps the Stripe price to a product/edition/license-type
   (`BillingPolicies.cs`), creates a `BillingContract` + `LicenseOrder`, and
   **issues a license record**: a `licenseId` and a random **activation code**
   (the activation code is hashed server-side with HMAC-SHA256 + a pepper —
   the plaintext only ever exists in this one email).
4. The server queues a transactional email, template `purchase-activation`
   (`TransactionalEmail.cs:19`), containing exactly:
   - `licenseId`
   - `activationCode`

   This is the **only** email template allowed to carry a plaintext activation
   code — it's enforced in code (`TransactionalEmail.cs:83-85`).

The customer now has two strings: a **License ID** and an **Activation Code**.
That's all they need to activate.

### 2.2 Online activation (app has network access to the license server)

This is the common case. Your app:

1. Computes a local **device identity** (see §4.6).
2. Generates a `requestId` (GUID) and a random `activationToken` (32 bytes,
   Base64) — both client-side, both kept locally afterward.
3. `POST {licenseServerBaseUrl}/api/v1/licenses/{licenseId}/activate` with the
   license ID, activation code, request id, activation token, device info,
   `mode: "online"`.
4. Server returns a **signed license envelope** (`SignedLicense`) plus
   `refreshAfter` / `leaseExpiresAt` timestamps. Your app writes the envelope
   to disk and verifies it locally with `Licensing.Core`.
5. Your app must call the **refresh** endpoint again before `leaseExpiresAt`
   (ideally around `refreshAfter`) to get a renewed envelope. If it doesn't,
   `LicenseVerifier.ValidateActivation` will start rejecting the stored file
   once the lease expires — this is a deliberate "phone home periodically"
   mechanic, not a bug to work around.

Full request/response contracts are in §6.

### 2.3 Offline activation (air-gapped machine, no network)

This is the flow you described — request JSON out, signed license file back,
by email, manually. It is a real, already-scripted flow
(`scripts/new-offline-activation-request.sh`), not something to invent:

1. Your app builds the **exact same JSON shape** as the online request, except
   `mode: "offline"`, and instead of POSTing it, **writes it to a file** (e.g.
   `offline-activation-request.json`) because the machine has no network path
   to the license server.
2. The user emails that file to **hello@repasscloud.com** (or wherever you
   route support intake).
3. A human admin (who *does* have network access) takes that JSON and calls
   the same `POST /api/v1/licenses/{licenseId}/activate` endpoint on the
   customer's behalf, with `mode: "offline"` — this produces an activation
   with **no lease** (`refreshAfter`/`leaseExpiresAt` are both null for
   offline mode; see `LicenseStore.cs:349-350`), so it never needs to phone
   home again.
4. The admin relays the resulting signed license JSON back to the customer
   by email as a file (e.g. `customer.license`).
5. The customer drops that file into the directory your app expects (see
   §4.6/§10 for where). Your app calls `LicenseVerifier.VerifyFile(path)` —
   zero network calls from here on.

Note what does **not** change between online and offline: the activation code,
the request/response JSON shape, and the verification code. Only the transport
(HTTP call vs. email round-trip) and the lease behavior differ.

*(There's a second offline path admins use for hand-issued licenses — e.g. an
education or enterprise deal signed with no Stripe purchase at all, via the
`LicenseGenerator` CLI and `POST /api/v1/admin/licenses/import`. That's purely
an admin/ops concern; your CLI app's job is identical either way — verify
whatever signed file lands on disk.)*

### 2.4 Renewal, deactivation, transfer

- **Subscription** licenses renew automatically via Stripe webhooks
  (`invoice.payment_*`), which extend `expiresAt` server-side — no customer
  action needed, but the *activation lease* (online mode) still needs its own
  periodic refresh call, independent of billing.
- **Deactivating** (e.g. before uninstalling, or moving to a new machine) calls
  `POST /api/v1/activations/{activationId}/deactivate`. A license may have up to
  its entitlement seat count in concurrent active machine activations, but each
  machine may hold at most one active activation. Once all seats are occupied,
  activating on a new device is rejected until another activation is
  deactivated.

---

## 3. Getting the Licensing.Core package

**It is not on nuget.org.** `NuGet.Config` in this repo only lists nuget.org as
a source, but `Licensing.Core` itself is published as a **GitHub Release
artifact**, built by `.github/workflows/release-image.yml`:

- Latest tagged release: **v0.2.1** (`Licensing.Core.0.2.1.nupkg`).
- Release page: `https://github.com/repasscloud/license-server-app/releases/tag/v0.2.1`
- Assets per release: the `.nupkg`, a plain-DLL `.zip` and `.tar.gz`, and
  `SHA256SUMS.txt` covering all of them — verify against it before trusting
  the download.

Two ways to consume it in the other repo:

**A. Local NuGet feed pointed at the downloaded `.nupkg` (recommended):**

```bash
mkdir -p ./nuget-local
curl -L -o ./nuget-local/Licensing.Core.0.2.1.nupkg \
  https://github.com/repasscloud/license-server-app/releases/download/v0.2.1/Licensing.Core.0.2.1.nupkg
# verify against SHA256SUMS.txt from the same release before using it
```

Add a `<packageSources>` entry for `./nuget-local` in the new repo's
`NuGet.Config`, then:

```bash
dotnet add package Licensing.Core --version 0.2.1
```

**B. Plain DLL reference:** download/verify the `.zip`/`.tar.gz`, drop
`Licensing.Core.dll` somewhere in the repo, and add a `<Reference>` to it in
the `.csproj`. Works, but loses NuGet version tracking — prefer A.

Target framework is **net10.0**; your CLI app needs to target net10.0 (or a
TFM the DLL is compatible with) to reference it.

**Key-rotation implication:** `TrustedPublicKeys` is compiled into the package
(`src/Licensing.Core/TrustedPublicKeys.cs`) — currently trusts key IDs
`primary-2026` and `secondary-2026`. If this repo rotates signing keys again,
licenses signed after that rotation won't verify against an older
`Licensing.Core` build. Pin the version deliberately and bump it when told a
rotation happened — don't silently float to "latest."

---

## 4. Core concepts & data model

### 4.1 Signed license envelope (the actual file on disk)

```json
{
  "format": "software-license-v1",
  "algorithm": "ECDSA-P256-SHA256",
  "keyId": "primary-2026",
  "license": {
    "licenseId": "LIC-ABC123",
    "customer": "Acme Pty Ltd",
    "issuedAt": "2026-08-12T06:30:00Z",
    "metadata": {
      "contactEmail": "buyer@example.com",
      "purchaseOrder": "PO-001"
    },
    "deviceBinding": {
      "scheme": "os-machine-id-sha256-v1",
      "deviceId": "<64-hex SHA-256>",
      "deviceName": "buyers-laptop"
    },
    "activation": {
      "activationId": "b3f1...-guid",
      "mode": "online",
      "activatedAt": "2026-08-12T06:31:00Z",
      "refreshAfter": "2026-08-13T06:31:00Z",
      "leaseExpiresAt": "2026-08-19T06:31:00Z"
    },
    "entitlements": [
      {
        "product": "your-app-code",
        "edition": "business",
        "licenseType": "subscription",
        "seats": 5,
        "expiresAt": "2027-08-12T06:30:00Z",
        "updatesUntil": "2028-12-31"
      }
    ]
  },
  "signature": "base64..."
}
```

Rules worth knowing (all enforced by `LicenseSchema.Parse`,
`src/Licensing.Core/LicenseSchema.cs`):

- `deviceBinding` and `activation` are both present or both absent — never one
  without the other.
- `entitlements` is a non-empty array, at most one entry per `product`.
- `metadata` values must be string/number/boolean only (no nesting), keys must
  be lowerCamelCase.
- All timestamps must carry an explicit timezone offset (`Z` or `+HH:MM`).
- Unknown top-level fields are rejected outright — this schema is strict, not
  extensible by convention. If you need to carry app-specific data, put it in
  `metadata`.

### 4.2 C# types Licensing.Core exposes (namespace `SoftwareLicensing`)

```csharp
LicenseVerifier.VerifyFile(path)              // -> VerifiedLicense
LicenseVerifier.Verify(json)                  // -> VerifiedLicense
LicenseVerifier.ValidateProduct(verified, product, releaseDate?, currentTimeUtc?, currentDevice?)
                                               // -> ProductEntitlement (throws if not entitled/expired)
LicenseVerifier.ValidateActivation(verified, currentDevice?, currentTimeUtc?)
                                               // called automatically by ValidateProduct

record VerifiedLicense(string KeyId, LicenseData Data);
record LicenseData(string LicenseId, string Customer, DateTimeOffset IssuedAt,
    JsonObject? Metadata, DeviceBinding? DeviceBinding, ActivationData? Activation,
    IReadOnlyList<ProductEntitlement> Entitlements, JsonObject Json);
record ProductEntitlement(string Product, string Edition, string LicenseType,
    int Seats, DateTimeOffset? ExpiresAt, DateOnly? UpdatesUntil, JsonObject Json);
record DeviceBinding(string Scheme, string DeviceId, string? DeviceName, JsonObject Json);
record ActivationData(string ActivationId, string Mode, DateTimeOffset ActivatedAt,
    DateTimeOffset? RefreshAfter, DateTimeOffset? LeaseExpiresAt, JsonObject Json);

DeviceIdentity.GetCurrent()                   // -> LocalDeviceIdentity
DeviceIdentity.IsValidDeviceId(value)

class LicenseValidationException : Exception  // signature/expiry/entitlement/activation failures
class LicenseSchemaException : Exception      // malformed license JSON
```

### 4.3 Terminology mapping — read this carefully

Your message used "license type" for what the code calls **`edition`**, and
"perpetual vs time-expiring" for what the code calls **`licenseType`**. Two
genuinely different fields, both on every entitlement:

| Field | Values | Meaning |
| --- | --- | --- |
| `edition` | `community`, `project`, `education`, `consumer`, `business`, `smb`, `enterprise`, `corporate` (`ProductCatalog.cs:11-15`) | **Which feature tier** — drives feature gating |
| `licenseType` | `perpetual`, `subscription`, `evaluation` (`LicenseTerms.cs:5-8`) | **Time model** — drives expiry behavior |

Use `edition` for "what can this customer do." Use `licenseType` (via
`expiresAt`) for "is this license still valid right now."

### 4.4 Perpetual vs time-expiring

- `perpetual`: server sets `expiresAt` to a sentinel far-future timestamp
  (`9999-12-31T23:59:59.9999999Z`, `LicenseTerms.cs:10-11`) — a real value, not
  null, so your expiry check is uniform: just compare `entitlement.ExpiresAt`
  against now. Don't special-case "perpetual == no expiry field" in your app;
  the field is always populated.
- `subscription` / `evaluation`: `expiresAt` is a real, meaningful deadline.
  `subscription` gets pushed forward automatically by Stripe renewal webhooks;
  `evaluation` does not.
- `updatesUntil` (optional, date-only) is separate from `expiresAt` — it gates
  whether a specific *release* is covered, not whether the license itself is
  valid. Only relevant if you ship dated releases and want to enforce "your
  license covers updates through 2028-12-31." Pass your build's release date
  into `ValidateProduct(..., releaseDate: ...)` if you use this; omit it if
  you don't need per-release gating.

`ValidateProduct` throws `LicenseValidationException` automatically if
`expiresAt` has passed — you don't check it yourself.

### 4.5 How your app identifies itself in the license

There is **no separate "app name" field**. Identity is the `product` string on
each entitlement — a stable, lowercase code (regex `^[a-z0-9][a-z0-9-]{0,99}$`,
enforced server-side in `LicenseImport.cs` and `ProductCatalog.cs`), e.g.
`"gcexp"` in this repo's demo data. A single license file can hold
entitlements for multiple products; your app finds *its own* by matching this
code.

**Action for the CLI app:** pick one stable product code for it (e.g.
`"my-cli-tool"`), hardcode it as a constant, and always call:

```csharp
var entitlement = LicenseVerifier.ValidateProduct(verified, product: "my-cli-tool");
```

That same string must be registered as a `ProductDefinition.Code` on the
license server (admin creates it via `POST /api/v1/admin/products`) and used
consistently in every license-data JSON an admin hand-signs, and in the Stripe
price → product mapping for purchases. Get this string agreed between you and
whoever administers the license server before writing code against it — a
mismatch here means every license silently fails `ValidateProduct` with "no
entitlement for X," which reads like a broken license rather than a config
typo.

### 4.6 Device binding — and its real limitation

`DeviceIdentity.GetCurrent()` (`src/Licensing.Core/DeviceIdentity.cs`) hashes a
per-OS "stable" identifier:

- Windows: registry `MachineGuid`
- Linux: `/etc/machine-id` or `/var/lib/dbus/machine-id`
- Fallback (macOS, or anything else): `Environment.MachineName` — noticeably
  weaker and explicitly flagged as such in `Source` (`"machine-name-fallback"`)

The doc comment is explicit: *"a useful PoC binding, not an unspoofable
hardware root of trust."* Tell whoever's evaluating security posture that
device binding here is a deterrent against casual license sharing, not a
DRM-grade guarantee — especially since the fallback path (relevant if this CLI
ships for macOS) binds to a trivially-changeable machine name.

---

## 5. Verifying a license file (do this every time the app starts)

```csharp
using SoftwareLicensing;

try
{
    var verified = LicenseVerifier.VerifyFile(licensePath);           // signature + schema
    var entitlement = LicenseVerifier.ValidateProduct(                // entitlement + expiry + device/lease
        verified,
        product: "my-cli-tool");

    // Trusted from here on:
    UnlockFeaturesFor(entitlement.Edition);   // see §8
    // entitlement.Seats, entitlement.ExpiresAt, entitlement.UpdatesUntil also available
}
catch (LicenseValidationException ex)
{
    // Signature bad, wrong device, expired, no entitlement, lease expired, etc.
    // Do not unlock. Show ex.Message — it's already written to be user-facing.
}
```

No public key handling, no network call, no server dependency in this path —
that's the entire point of shipping `Licensing.Core` as a package instead of
hand-rolling verification in every consuming app.

---

## 6. Online activation — HTTP contracts

Licensing.Core does **not** ship these DTOs (they live in the server's own
`ApiContracts.cs`, internal to that project). Define matching POCOs in the CLI
repo — shapes below are copied verbatim from the server's actual contracts.

Base URL is whatever the license server is deployed at — dev default is
`http://localhost:8080` (`appsettings.json:35`); production URL is a config
value your app needs, not something to hardcode.

### 6.1 Activate — `POST {baseUrl}/api/v1/licenses/{licenseId}/activate`

Request:

```json
{
  "requestId": "<new GUID, string>",
  "activationCode": "<from the purchase email>",
  "activationToken": "<32 random bytes, Base64>",
  "mode": "online",
  "device": {
    "scheme": "os-machine-id-sha256-v1",
    "deviceId": "<DeviceIdentity.GetCurrent().DeviceId>",
    "deviceName": "<optional, e.g. Environment.MachineName>"
  }
}
```

`activationToken` **must** be exactly 32 random bytes, Base64-encoded, or the
server rejects the request (`LicenseStore.cs:826-830`). Generate it with
`RandomNumberGenerator.GetBytes(32)` → `Convert.ToBase64String(...)`.

Response (`200 OK`):

```json
{
  "licenseId": "LIC-ABC123",
  "activationId": "guid",
  "status": "active",
  "signedLicense": "<the full signed envelope from §4.1, as a JSON string>",
  "refreshAfter": "2026-08-13T06:31:00Z",
  "leaseExpiresAt": "2026-08-19T06:31:00Z"
}
```

**Persist locally and durably:** `activationId`, `activationToken` (the one
*you* generated — the server never returns it, it only ever echoes back what
you already have), and the `signedLicense` written to your license file path.
The `activationToken` is a bearer credential for validate/refresh/deactivate —
treat it like a password (e.g. OS keychain / protected local storage), not a
plaintext config file, if the platform offers one.

Non-2xx responses are a `Problem`-shaped error (bad activation code, license
already active elsewhere, license canceled/revoked, no signing key available,
etc.) — surface `title`/`detail` to the user; don't retry blindly on 4xx.

### 6.2 Validate — `POST {baseUrl}/api/v1/activations/{activationId}/validate`

```json
{ "activationToken": "<stored>", "deviceId": "<recomputed each call, not stored>" }
```

Cheap liveness/status check; does not return a new signed license.

### 6.3 Refresh — `POST {baseUrl}/api/v1/activations/{activationId}/refresh`

Same request body as validate. Returns the same shape as Activate's response —
a **new** `signedLicense` and pushed-out `refreshAfter`/`leaseExpiresAt`.
**Overwrite the on-disk license file with this response.** Only valid for
`mode: "online"` activations — calling it for an offline-mode activation
returns a conflict (`LicenseStore.cs:418-419`), which is expected, not a bug.

Call this on a schedule (e.g. at app startup if past `refreshAfter`, or a
background timer) well before `leaseExpiresAt`, with retry/backoff for
transient network failure — the whole point of the lease window is slack for
"was offline for a few days," not a hard cliff at first missed check-in.

### 6.4 Deactivate — `POST {baseUrl}/api/v1/activations/{activationId}/deactivate`

Same request body as validate. Frees the seat so the license can be activated
on another device. Call this from an explicit "deactivate"/"sign out" command
in your CLI, and ideally from an uninstaller, though the latter is best-effort
(can't guarantee network access at uninstall time).

### 6.5 Deployment key enrollment (unattended fleet enrollment) — `POST {baseUrl}/api/v1/deployment-keys/enroll`

For Business/Enterprise/Education-style deployments (Intune, RMM, golden images), an operator
creates one or more **Deployment Keys** for a license from the admin API
(`POST /api/v1/admin/licenses/{licenseId}/deployment-keys`). A Deployment Key is not the license's
activation code — it is a separate, revocable credential in the form
`dpk_live_<publicId>_<secret>`, shown in full only once at creation or rotation.

Request body is identical to `Activate` except `activationCode` is replaced by `deploymentKey`:

```json
{
  "deploymentKey": "dpk_live_...",
  "requestId": "GUID",
  "activationToken": "base64(32 random bytes)",
  "mode": "online",
  "device": { "scheme": "os-machine-id-sha256-v1", "deviceId": "...", "deviceName": "..." }
}
```

The response is the same signed `ActivationResponse` as `Activate`. Enrollment consumes from the
same seat pool as manual activation, and the resulting activation is managed identically afterward
(`validate` / `refresh` / `deactivate`). Revoking a Deployment Key blocks *new* enrollment through
it; machines already enrolled keep working until deactivated through the normal activation
lifecycle. A Deployment Key grants no access beyond this one enrollment endpoint.

---

## 7. Offline activation request (air-gapped path)

Same fields as §6.1's request, `mode: "offline"` instead, written to a file
instead of POSTed:

```csharp
var device = DeviceIdentity.GetCurrent();
var request = new
{
    requestId = Guid.NewGuid().ToString(),
    activationCode,                          // user-entered
    activationToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
    mode = "offline",
    device = new { scheme = device.Scheme, deviceId = device.DeviceId, deviceName = device.DeviceName }
};
File.WriteAllText(outputPath, JsonSerializer.Serialize(request, new JsonSerializerOptions { WriteIndented = true }));
```

Tell the user, on-screen, after writing this file: email it to
**hello@repasscloud.com**, and once they receive a `.license` file back, save
it to the path your app expects (§10) and re-run the app.

**Persist the same `activationToken` locally** as in the online path — the
admin's relayed license won't include it, but you'll need it later if this
license is ever moved to online mode or you add a manual "check status"
command against the admin-run activation record.

---

## 8. Feature gating by edition

`Licensing.Core` deliberately does **not** enforce feature flags — it only
tells you the truth about the license (edition, seats, expiry). Your app owns
the feature matrix:

```csharp
static readonly IReadOnlyDictionary<string, FeatureSet> FeaturesByEdition = new Dictionary<string, FeatureSet>
{
    ["community"]  = FeatureSet.Basic,
    ["project"]    = FeatureSet.Basic | FeatureSet.Reporting,
    ["education"]  = FeatureSet.Basic | FeatureSet.Reporting,
    ["consumer"]   = FeatureSet.Basic,
    ["business"]   = FeatureSet.Basic | FeatureSet.Reporting | FeatureSet.MultiSeat,
    ["smb"]        = FeatureSet.Basic | FeatureSet.Reporting | FeatureSet.MultiSeat,
    ["enterprise"] = FeatureSet.All,
    ["corporate"]  = FeatureSet.All,
};
```

(Illustrative — define whatever the product actually needs.) Look this up with
`entitlement.Edition` after a successful `ValidateProduct` call. Treat an
edition string that isn't in your map as "no features" (fail closed), not as a
crash — new editions can be added server-side without a client release.

---

## 9. Error handling

- `LicenseSchemaException` — malformed license JSON. Should only happen with a
  corrupted/tampered file; treat as "reject the license," not a crash.
- `LicenseValidationException` — the catch-all for "this license is not
  currently valid to use": bad signature, unknown/revoked signing key, wrong
  device, expired entitlement, no entitlement for this product, expired
  activation lease. Message text is already written to be shown to a user.
- Network layer (online activation only): timeouts and non-2xx HTTP responses
  are yours to handle — this is ordinary HTTP client code, nothing
  license-specific about it except: don't treat a network failure as "license
  invalid," treat it as "couldn't check right now" and fall back to the
  last-verified local file until the lease actually expires.

---

## 10. Checklist for the Claude Code session implementing this

1. Add `Licensing.Core` 0.2.1 as a package reference (§3) — verify the
   `.nupkg` against `SHA256SUMS.txt` before adding it to the local feed.
2. Pick and hardcode this app's product code (agree it with the license-server
   admin first — see §4.5). Ask the user for it if not already decided; don't
   invent one.
3. Decide and hardcode/config the license server base URL (dev vs prod) and
   the license file's on-disk location (e.g.
   `%APPDATA%/<app>/license.json` / `~/.config/<app>/license.json` /
   next to the executable — platform-appropriate, not a fixed absolute path).
4. Implement license verification at startup per §5, gating features per §8.
5. Implement the online activation command: prompt for License ID + Activation
   Code, build and POST the §6.1 request, persist `activationId` +
   `activationToken` securely, write `signedLicense` to the license file.
6. Implement a refresh routine per §6.3 (startup check + background timer),
   only for `mode: "online"` activations.
7. Implement the offline path: same prompts, write the §7 request file
   instead of POSTing, tell the user to email it to hello@repasscloud.com and
   where to place the returned `.license` file.
8. Implement a deactivate command per §6.4.
9. Wire all of the above through `LicenseValidationException`/
   `LicenseSchemaException` handling per §9 — never let a license failure
   crash the app; always fail to "not activated" with a clear message.
10. Do not reimplement signature verification, schema parsing, or public-key
    handling — that's exactly what `Licensing.Core` exists to centralize.
    If something about a license file looks wrong, that's a
    `LicenseValidationException`, not a reason to hand-parse the JSON.

---

## 11. Decisions only a human can make (don't guess these)

- The CLI app's **product code** (§4.5) — must match server-side config.
- Where the **license file lives on disk** per OS.
- The **license server's production base URL**.
- The actual **feature-to-edition matrix** (§8) — this doc gives the shape,
  not the business decision of what each tier unlocks.
- Whether activation credentials (`activationToken`) need OS-keychain-grade
  protection for this product, or a protected local file is acceptable.
