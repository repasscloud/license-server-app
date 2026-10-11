# Licensing Server — Implementation Brief

**Audience:** the engineer (or Claude Code instance) building the
replacement RePassCloud licensing server in its own repository.

**Read with:** [`LICENSING-ARCHITECTURE.md`](LICENSING-ARCHITECTURE.md),
the cross-product licensing specification (business rules, editions,
rationale). If you were given only this file, it is self-contained for
everything the server must *do*. Where the two documents overlap:

- **This brief governs** wire formats, signing, the HTTP API, and error
  codes. The first client, CurseDelete 2.1, already implements these
  exactly. Changing them means changing the client too.
- **The architecture governs** business rules. Section numbers in
  brackets, e.g. [§4.4], point to it.

The old proof-of-concept server and its `software-license-v1` format are
retired. Nothing from it needs to be supported or migrated: every
previously issued licence was a test licence.

---

## 1. What you are building

A product-agnostic licensing service shared by every RePassCloud
application. It:

1. **Turns verified purchases into entitlements.** Stripe webhooks feed
   it, including $0 Community registrations and bundles.
2. **Issues signed licence files and Business activation certificates.**
   It has three signature algorithms and holds the private keys.
3. **Serves three application endpoints:** activate, renew, deactivate.
4. **Enforces Business seat limits and rolling transfer allowances.**
   Enforcement is transactional.
5. **Runs a customer portal:** licences, downloads, activation keys,
   device management, and subscriptions.
6. **Gives support staff tools**, records revocations, and keeps an
   audit log.

**Out of scope / must not do:**

- No device tracking for Community, Education, or Enterprise.
- No periodic phone-home requirement for perpetual offline licences.
- No automatic distribution of new keys to applications.
- No treating a major-version upgrade as an entitlement.
- No assumption that every product uses the same activation model.
  [§12]

**Already done (client side, don't redo):** CurseDelete 2.1 validates
everything offline. It falls back to Community on any problem, never
trusts a server response it can't verify, and calls only the three
endpoints in §5.

## 2. Fixed facts

| Item | Value |
|---|---|
| Editions (exact wire ids) | `community`, `education`, `business`, `enterprise` |
| Signature algorithms (exact wire ids) | `Ed25519` (default), `ECDSA-P256-SHA256`, `ML-DSA-65` |
| First product | `productId` = `cursedelete`, major version `2` (application releases 2.1.x onwards) |
| Licence envelope format | `repass-license-v1` |
| Activation certificate format | `repass-activation-v1` |
| Claims schema version | `1` |
| Transport | HTTPS only. Clients refuse plain `http://` except to loopback. |
| Encoding | JSON (UTF-8); base64url **without padding** everywhere; RFC 3339 timestamps (emit UTC with `Z`, whole seconds) |
| Identifier alphabet | `[A-Za-z0-9_.-]`, 1–128 chars. Suggested prefixes: `lic_`, `act_`, `cus_`, `ent_`, `key_`. Identifiers appear in URL paths. |

## 3. Domain rules the server enforces

### 3.1 Keep these distinct [§13]

| Concept | Meaning |
|---|---|
| **Purchase** | A Stripe transaction (checkout, invoice, subscription). |
| **Entitlement** | What a customer is owed: product + major version + edition + term + seats. Created from a verified purchase. |
| **Licence** | A signed artifact for an entitlement. Re-issued (re-signed) on renewal while keeping its `licenseId`. |
| **Activation** | One Business device holding one seat. Proved to the client by a signed **activation certificate**. |
| **Activation key** | The secret string a customer types into `cursdel license activate <KEY>`. It belongs to one licence (§6.1). |

A customer can own many entitlements across products, majors, and
editions [§8.4]. A bundle produces one entitlement and one licence *per
component product* [§8.3]. There are never multi-product licences.

### 3.2 Per edition

| | Community | Education | Business | Enterprise |
|---|---|---|---|---|
| Price | $0 registration (unregistered Community needs no licence at all) | Paid by default; free per product | Paid | Paid |
| Term | perpetual | perpetual | **perpetual or subscription** | perpetual |
| `maxActivations` claim | absent | absent | **required, ≥ 1** | absent |
| Device activation | never | never | **required, one seat per device** | never |
| Transfers | n/a | n/a | rolling 12-month allowance | n/a |
| Online provisioning via activation key | yes | yes | yes (activates a device) | yes |
| Offline file download from portal | yes | yes | yes (still needs online activation once per device) | yes |
| Ownership | individual | institution (volume) | organisation | organisation + subsidiaries, unlimited installs |

Clients **reject** a licence that breaks these rules, for example a
non-perpetual Enterprise licence or a Business licence without
`maxActivations`. Never issue one.

### 3.3 Major versions [§1.2, §1.3]

An entitlement is for exactly one `(productId, majorVersion)`. A
perpetual v2 licence covers every 2.x.y release and never v3. Selling
v3 creates new entitlements. Upgrade pricing is a Stripe/commercial
concern; the result is still a separate v3 entitlement.

## 4. Wire formats (binding)

### 4.1 Envelope

Licences and activation certificates use the same envelope:

```json
{
  "format": "repass-license-v1",
  "payload": "<base64url(claims JSON bytes)>",
  "signatures": [
    { "signatureAlgorithm": "Ed25519",   "keyId": "repass-ed25519-2026", "signature": "<base64url>" },
    { "signatureAlgorithm": "ML-DSA-65", "keyId": "repass-mldsa65-2026", "signature": "<base64url>" }
  ]
}
```

- **`format`:** `repass-license-v1` for licences, `repass-activation-v1`
  for activation certificates.
- **`payload`:** the exact claims bytes you serialised, base64url-encoded.
  Serialise once, sign those bytes, and embed those bytes. Never
  re-serialise. Formatting and key order are irrelevant because the bytes
  are what count.
- **`signatures`:** 1–8 entries, each `keyId` at most once. No other
  envelope fields are allowed, and clients reject unknown fields.
- The whole envelope must be ≤ 64 KiB, which is plenty, even with
  ML-DSA.

### 4.2 Signed bytes

Every signature is computed over:

```
UTF8(format) || 0x0A || payload_bytes
```

For example: `repass-license-v1\n{"schemaVersion":1,...}`. The prefix
stops a licence signature from being replayed as an activation
certificate.

### 4.3 Algorithms

| Algorithm | Signing | Signature bytes | Public key as published to apps |
|---|---|---|---|
| `Ed25519` | RFC 8032 **pure** Ed25519 (not Ed25519ph/ctx) | 64 | 32-byte raw key |
| `ECDSA-P256-SHA256` | ECDSA over P-256, SHA-256 of the signed bytes | 64, **IEEE P1363 `r‖s` (not DER)**, each half left-padded to 32 bytes | SEC1 point, compressed (33) or uncompressed (65) |
| `ML-DSA-65` | FIPS 204 **pure** ML-DSA (not HashML-DSA), **empty context string** | 3309 | 1952-byte encoded key |

Library notes: most ECDSA APIs default to DER and must be told to
produce P1363 (e.g. Node `dsaEncoding: 'ieee-p1363'`, .NET
`DSASignatureFormat.IeeeP1363FixedFieldConcatenation`; Go/Java: convert
`r`, `s`). Randomised or hedged ECDSA and ML-DSA signing is fine, since
clients only verify. Choosing ECDSA or ML-DSA does not make a system
FIPS-compliant by itself: that requires a validated module and
environment. If you advertise FIPS, use one [§15.3].

### 4.4 Licence claims (`schemaVersion: 1`)

```json
{
  "schemaVersion": 1,
  "licenseId": "lic_01JABCDEF",
  "customerId": "cus_01JABCDEF",
  "productId": "cursedelete",
  "majorVersion": 2,
  "edition": "business",
  "organisation": "Example Business Pty Ltd",
  "customerName": "Jane Citizen",
  "issuedAt": "2026-10-11T00:00:00Z",
  "perpetual": false,
  "expiresAt": "2027-10-11T00:00:00Z",
  "maxActivations": 3
}
```

| Field | Required | Rule |
|---|---|---|
| `schemaVersion` | yes | `1`. Clients report any other number as unsupported. |
| `licenseId` | yes | Stable for the life of the entitlement: renewals keep it. Activation certificates reference it. |
| `customerId` | yes | Your stable customer reference. Not the Stripe id, not an email address. |
| `productId`, `majorVersion` | yes | Must match the application exactly. |
| `edition` | yes | Exact wire id. |
| `organisation` | optional | Education/Business/Enterprise owner name. Non-empty if present. |
| `customerName` | optional | Registered person (e.g. Community). Non-empty if present. **No email addresses in licences** [§7.5]. |
| `issuedAt` | yes | When this artifact was signed. |
| `perpetual` | yes | `true` requires `expiresAt` absent or `null`. `false` requires `expiresAt` later than `issuedAt`. Only Business may be `false`. |
| `expiresAt` | see above | Subscription end. Clients disable Business features at this instant. |
| `maxActivations` | Business only | Seats, ≥ 1. Must be absent for other editions. |

**Unknown fields are rejected.** Adding a field requires
`schemaVersion: 2`, and old clients will refuse such licences, so plan
schema changes per product major.

### 4.5 Activation certificate claims (`schemaVersion: 1`)

```json
{
  "schemaVersion": 1,
  "activationId": "act_01JABCDEF",
  "licenseId": "lic_01JABCDEF",
  "productId": "cursedelete",
  "majorVersion": 2,
  "deviceId": "0123…CDEF",
  "issuedAt": "2026-10-11T00:05:00Z",
  "expiresAt": null
}
```

- `deviceId` is echoed exactly as the client sent it. CurseDelete sends
  64 uppercase hex characters (a namespaced SHA-256 of the OS machine
  id); treat it as opaque.
- `expiresAt` is optional. Use it only for products whose policy wants
  periodic online re-validation. **CurseDelete wants `null`**: activate
  once, then offline indefinitely [§4.7].
- A certificate never extends a licence: clients always check the
  licence's own `expiresAt` too.
- Unknown fields are rejected, as for licences.

## 5. HTTP API (binding)

Base URL is configured per application build: CurseDelete reads
`CURSDEL_LICENSE_SERVER_URL`. All requests are `POST` with a JSON body.
The client timeout is 30 s. There is no bearer/API-key header: requests
are authenticated by the activation key or by the activation's client
secret. **Rate-limit by IP and by key/licence** to stop activation-key
guessing.

### 5.1 `POST /v1/activations`: activate or provision

Request:

```json
{
  "productId": "cursedelete",
  "majorVersion": 2,
  "activationKey": "<as typed by the customer>",
  "deviceId": "<64 hex>",
  "clientSecret": "<base64url of 32 random bytes>"
}
```

Behaviour:

1. Look up the activation key. If it's unknown, return `invalid_key`. If
   it belongs to a different product, return `product_mismatch`; if to a
   different major version, `version_mismatch`.
2. If the entitlement is revoked, return `revoked`.
3. **Community / Education / Enterprise:** return the current licence
   with `activation: null`. Ignore `deviceId` and `clientSecret`, and
   store neither [§3.3, §5.5].
4. **Business:** inside a transaction that serialises per licence (for
   example `SELECT … FOR UPDATE` on the licence row):
   - **Active activation for the same `(licenseId, deviceId)`:** re-use it.
     Keep the same `activationId`, replace the stored client-secret hash
     with the new one (the client just generated it), and issue a fresh
     certificate. No seat is consumed [§4.3].
   - **Otherwise, and active activations < `maxActivations`:** apply the
     transfer rule (§6.2), then create an activation, store the hash, and
     issue a certificate.
   - **Otherwise:** return `seat_limit`.
5. A subscription past `expiresAt` still activates (step 3/4), but the
   client will not use it until renewal. Prefer returning
   `subscription_expired` so the customer gets a clear message.

Response `200`:

```json
{ "license": { /* licence envelope */ }, "activation": { /* certificate envelope */ } }
```

`activation` is `null` for non-Business editions.

### 5.2 `POST /v1/licenses/{licenseId}/renew`: current entitlement

Request:

```json
{
  "productId": "cursedelete",
  "majorVersion": 2,
  "activation": { "activationId": "act_…", "deviceId": "…", "clientSecret": "…" }
}
```

`activation` is omitted when the client has no Business activation
(other editions, or a Business licence installed but not activated).

Behaviour:

- If the licence is unknown, return `not_found`. If the product or major
  doesn't match, return `product_mismatch` / `version_mismatch`. If the
  entitlement is revoked, return `revoked`.
- If `activation` is present: verify the secret against the stored hash
  (constant-time) and check `deviceId`. On a mismatch return
  `unauthorized`. If the activation has been released (via the app,
  portal or support), return **`activation_inactive`**: this is how a
  portal release reaches an offline device [§4.10].
- Otherwise return a freshly signed licence: same `licenseId`, new
  `issuedAt`, the current `expiresAt`. For a Business request with a
  valid `activation`, also return a fresh certificate, keeping the same
  `activationId`.

Response `200`: same shape as §5.1. `activation` is `null` when the
request carried none.

### 5.3 `POST /v1/activations/{activationId}/deactivate`: release a seat

Request:

```json
{ "productId": "cursedelete", "majorVersion": 2, "deviceId": "…", "clientSecret": "…" }
```

Behaviour:

- Verify as in §5.2, returning `unauthorized` on a mismatch.
- Mark the activation inactive, set its deactivation timestamp, and free
  the seat.
- Return `204`. If it was already inactive, return `activation_inactive`,
  which the client treats as success and cleans up.
- Deactivating on a revoked licence: release the seat and return `204`.

### 5.4 Errors

Every non-2xx response has this body:

```json
{ "error": "<code>", "message": "<human-readable sentence, shown to the user>" }
```

| HTTP | `error` | When | CurseDelete client does |
|---|---|---|---|
| 400 | `invalid_request` | Malformed body / ids | Reports; changes nothing |
| 401 | `unauthorized` | Client secret or device mismatch | Reports; keeps local activation |
| 403 | `revoked` | Entitlement revoked | **Records the licence as revoked locally** (on renew) and stops using it |
| 404 | `invalid_key` | Unknown activation key | Reports; changes nothing |
| 404 | `not_found` | Unknown licence/activation | Reports; changes nothing |
| 409 | `seat_limit` | All seats in use | Reports; changes nothing |
| 409 | `transfer_limit` | Transfer allowance exhausted | Reports; changes nothing |
| 409 | `activation_inactive` | Activation released | Removes local activation (renew/deactivate) |
| 409 | `subscription_expired` | Expired subscription can't be activated | Reports; changes nothing |
| 422 | `product_mismatch` / `version_mismatch` | Key or licence is for another product/major | Reports; changes nothing |
| 429 | `rate_limited` | Throttled | Treated as "server unavailable" |
| 5xx | any | Server fault | Treated as "server unavailable"; never invalidates anything locally |

The client matches on `error`, never on `message`. Add new codes freely:
unknown codes are reported and change nothing.

### 5.5 Responses are verified, never trusted

The client validates every returned envelope. It checks the signature
against keys compiled into that build, an allowed algorithm,
product/major, claims rules, and for certificates the
`licenseId`/`deviceId` match. Only then does it write anything. A
licence signed with a key the build doesn't trust is discarded. **So
§7 (key compatibility) is not optional:** issue with the wrong key and
activation "succeeds" server-side but fails on the device, consuming a
seat. Make sure that never happens.

## 6. Activation keys, seats, transfers

### 6.1 Activation keys

- One per licence (entitlement). Shown in the purchase email and the
  portal, and rotatable by the customer or support (rotation invalidates
  the old key, not existing activations).
- High entropy: ≥ 128 bits, human-typable, e.g. base32 groups
  `XXXXX-XXXXX-…`. ≤ 256 printable ASCII characters, no whitespace.
- Store only a hash, and look keys up by hash. Accept case-insensitive
  input if your alphabet allows it.
- A Business key activates up to `maxActivations` devices. Other
  editions' keys provision the licence.

### 6.2 Seats and transfers [§4.2, §4.4]

- A seat is held by each *active* activation. Seat checks must be
  race-free: concurrent activations must never exceed `maxActivations`.
- **Transfer rule.** Activating a *new* device onto a seat that a
  released activation previously held counts as one transfer. Filling a
  never-used seat does not. Before allocating such a seat, count the
  licence's transfers in the trailing 365 days. If the count is ≥ the
  allowance, return `transfer_limit`.
- The allowance is configurable per product/major and overridable per
  entitlement (e.g. 3 per rolling 12 months). Support can grant extra
  transfers or reset the counter.
- Releases come from the app (§5.3), the portal, or support. All are
  equivalent and audited.
- Record each activation's `activatedAt`, `lastValidatedAt` (updated by
  renew), `deactivatedAt`, status, and `deviceId`. Collect nothing else
  about the device [§4.2].

## 7. Signing keys and key compatibility [§6, §15]

- **One algorithm per keypair.** Name keys `<org>-<algorithm>-<year>[-n]`,
  e.g. `repass-ed25519-2026`, `repass-mldsa65-2026`, `repass-p256-2026`.
  A `keyId` is globally unique and never reused.
- **Private keys** never leave the signing infrastructure. Use a KMS/HSM
  where it supports the algorithm. Otherwise encrypt at rest with a
  KMS-held key and restrict signing to one service identity. Never put
  them in application repos, logs, or backups in clear.
- **Publishing a public key** means base64url of the raw encoding (§4.3).
  The application team adds it to that application's source.
  CurseDelete's list lives in `crates/cursdel-policy/src/lib.rs`
  (`TRUSTED_KEYS`), with entries of the form
  `("<keyId>", <algorithm>, "<base64url>")`.
- **Key compatibility is explicit.** Per `(productId, majorVersion)`,
  keep the set of keys **eligible for issuance**, plus which application
  releases trust each key. A key becomes eligible for a product only
  after a release of that product trusting it has shipped and is the
  minimum supported release for that major version. Until then, never
  sign that product's licences with it [§6.6, §6.8].
- **Issuing:** sign each licence and certificate with **every** eligible
  key for its product/major (at most 8). Dual signing (e.g. Ed25519 +
  ML-DSA-65) is how algorithms and keys migrate: clients accept the
  envelope if *any* trusted, allowed signature verifies, and skip
  signatures they don't know.
- **Rotation:** yearly per algorithm, as an admin action. Generating a
  key changes nothing until it is published, trusted by a release, and
  marked eligible. Retired keys stay stored for as long as any supported
  release trusts them and licences must be re-issuable for it.
- **CurseDelete v2 today trusts no keys.** First milestone: generate the
  initial keys, ideally `repass-ed25519-2026` plus `repass-mldsa65-2026`,
  and hand their public keys to the CurseDelete team. Mark them eligible
  for `cursedelete`/`2` once the 2.1 release that embeds them ships.

## 8. Renewals, subscriptions, revocation

- **Subscriptions (Business only).** Payment success (Stripe
  `invoice.paid`) extends the entitlement's `expiresAt`. The next renew
  call or portal download returns a licence with the new date. Clients
  never extend expiry themselves [§4.8]. Cancellation or non-payment:
  let it expire; do **not** revoke.
- **Revocation** (refund, chargeback, fraud, contract breach) sets the
  entitlement to revoked. Then activate and renew return `revoked`, the
  portal shows it, and support can reverse it. Offline installs keep
  working until their next renew. That is accepted and documented
  [§4.10, §5.7]; never describe revocation as remote removal.
  CurseDelete also honours an administrator-provided local list, which
  needs no server support.
- **Re-issue** (e.g. organisation rename) re-signs with the same
  `licenseId`. A new `licenseId` means a new entitlement, and Business
  devices would need re-activation.

## 9. Stripe [§8.2, §8.3]

- Verify every webhook signature and process idempotently by Stripe
  event id. Store processed ids; duplicates must be no-ops.
- Map Stripe Prices to entitlement templates in configuration (§10),
  never from client-supplied data. A template is (product, major,
  edition, term, seats, transfer allowance). A bundle Price maps to
  several templates.
- Events to handle at minimum:
  - `checkout.session.completed`: create the customer if new, create the
    entitlements, issue licences and activation keys, and email them.
    This includes $0 Community registration checkouts.
  - `invoice.paid`: extend the subscription's `expiresAt`.
  - `customer.subscription.updated`: seat changes, by updating
    `maxActivations` and re-issuing. If seats drop below the active
    count, don't deactivate devices; block new activations until under
    the limit.
  - `customer.subscription.deleted`: stop extending.
  - `charge.refunded` / `charge.dispute.created`: revoke, by policy.
- Ownership: an organisation's details come from Stripe (customer and
  business name, tax id). The email address is for access and recovery
  only and never goes into licence files [§3.2, §7.5].

## 10. Product configuration (data-driven)

A new application must not require server code changes [§8.1]. Example
for CurseDelete:

```json
{
  "productId": "cursedelete",
  "name": "CurseDelete",
  "majors": [
    {
      "majorVersion": 2,
      "editions": ["community", "education", "business", "enterprise"],
      "business": {
        "transfersPerRolling12Months": 3,
        "activationCertificateLifetime": null
      },
      "eligibleSigningKeys": ["repass-ed25519-2026", "repass-mldsa65-2026"],
      "trustedBy": [
        { "releases": ">=2.1.0", "keys": ["repass-ed25519-2026", "repass-mldsa65-2026"] }
      ]
    }
  ],
  "stripePrices": {
    "price_community_registration": [{ "majorVersion": 2, "edition": "community", "perpetual": true }],
    "price_business_annual_3":      [{ "majorVersion": 2, "edition": "business", "perpetual": false, "seats": 3 }],
    "price_enterprise_perpetual":   [{ "majorVersion": 2, "edition": "enterprise", "perpetual": true }]
  }
}
```

Shape and storage are up to you (database rows, config repository,
admin UI). The point is that products, majors, policies, keys and prices
are data.

## 11. Customer portal [§8.5]

- **Everyone:** profile, organisation details, products and
  entitlements (product, major, edition, term), licence-file download
  (suggested name `cursedelete-v2-<edition>-<licenseId>.license`),
  activation key view/rotate, subscription status, and support contact.
- **Business only:** active devices (activation id, activated/last-seen
  dates, a short device-id suffix), seats used/available, the transfer
  allowance remaining, "release device", and "request more transfers".
  The UI must say a release takes effect on an offline device only when
  it next renews [§4.6].
- **Education/Enterprise:** no device management UI.
- **Authorisation:** a user only ever sees their own customer's data.
  Organisation customers may have several portal users. Use
  passwordless email or SSO; your choice.

## 12. Support/admin tools and audit

- **Support actions** (all audited with the acting staff member):
  release an activation, grant or reset transfers, revoke or un-revoke,
  re-issue, rotate an activation key, change seats, correct a customer.
- **Audit log, append-only:** entitlement created/changed/revoked;
  licence issued (which key ids); activation created/re-used/released
  (by whom); renew calls; deactivate calls; failed authentication;
  webhook processed; key generated/published/eligible/retired.
- **Never log** client secrets, activation keys, or private keys. Log
  only a key's id or a hash prefix.

## 13. Suggested domain model [§8.7]

Product, ProductMajor (policies, eligible keys), Customer
(Stripe id, name, email, organisation), Entitlement (product, major,
edition, term, seats, transfer allowance, status), Licence (id, entitlement,
last issued payload, key ids, issuedAt), ActivationKey (hash, licence,
status), Activation (id, licence, deviceId, secret hash, timestamps,
status), TransferEvent, SigningKey (id, algorithm, public key, private-key
reference, status, created), KeyCompatibility, StripeEvent (processed ids),
AuditEvent, PortalUser. Adapt freely.

## 14. Security checklist [§10]

- [ ] TLS everywhere (clients reject plain HTTP).
- [ ] Private keys in KMS/HSM or KMS-encrypted; signing service isolated.
- [ ] Stripe webhook signatures verified; idempotent processing.
- [ ] Seat allocation transactional under concurrency (test it).
- [ ] Activation keys and client secrets stored hashed, compared in constant time.
- [ ] Rate limiting on all three app endpoints.
- [ ] Per-customer authorisation on every portal and API action.
- [ ] Never issue with a key not eligible for that product/major.
- [ ] No email or personal data in licence payloads.
- [ ] Audit log for every security-relevant operation.

## 15. Testing and acceptance

### 15.1 Verify against the real client: conformance tool

The CurseDelete repository ships the client's validation code as a
command-line checker. Run it against your output, using your **test**
key's public key:

```bash
git clone https://github.com/repasscloud/cursedelete-2 && cd cursedelete-2
cargo run -q -p cursdel-license --example conformance -- \
  --key repass-test-ed25519:Ed25519:<base64url-public-key> \
  --key repass-test-mldsa65:ML-DSA-65:<base64url-public-key> \
  --product cursedelete --major 2 \
  --license issued.license \
  --activation issued-activation.json --device 0123…CDEF
```

It prints a JSON report and exits 0 only if the licence (and
certificate, if given) validate exactly as CurseDelete would validate
them. Put it in your CI.

### 15.2 Acceptance checklist

- [ ] All five test vectors (§15.3) verify in your verifier. Your
      Ed25519 signer reproduces the Ed25519 vectors byte-for-byte from
      the published seed. Your ECDSA and ML-DSA signers produce
      signatures the conformance tool accepts.
- [ ] Every edition's licence passes the conformance tool, and a
      deliberately broken one fails: wrong product, wrong major,
      non-perpetual Enterprise, Business without `maxActivations`,
      tampered payload.
- [ ] Business: activate N devices; the N+1th returns `seat_limit`.
      Re-activating an existing device re-uses its seat. Concurrent
      activations never exceed N.
- [ ] Transfers: release then activate a new device counts once; the
      allowance + 1th returns `transfer_limit`; a support reset clears it.
- [ ] Portal release makes the next renew return `activation_inactive`.
- [ ] Renew after `invoice.paid` returns the extended `expiresAt` and the
      same `licenseId`.
- [ ] Revoke makes activate and renew return `revoked`. Deactivation
      still releases the seat.
- [ ] A duplicate webhook delivery creates nothing new.
- [ ] Education/Enterprise/Community never create device records.
- [ ] Error bodies always have `error` + `message`; 5xx is never used
      for definitive refusals.

### 15.3 Test vectors

Generated by and verified against CurseDelete's client code: a unit test
there fails if this block drifts. **The private seeds are public test
material. Never use them, or keys derived from them, outside tests.**

- ML-DSA-65 keys come from the 32-byte seed ξ (FIPS 204 `KeyGen_internal`).
- The ECDSA private scalar is the seed bytes.
- Ed25519 uses the seed as the RFC 8032 private key.

All vectors here were signed deterministically: RFC 6979 for ECDSA and
the deterministic variant for ML-DSA. Validate as
`validateAs.productId`/`majorVersion` at time `validateAs.now`, with
`validateAs.deviceId` for the certificate. The certificate activates the
`business-subscription-ecdsa-p256` licence.

<!-- BEGIN TEST VECTORS -->
```json
{
  "validateAs": {
    "productId": "cursedelete",
    "majorVersion": 2,
    "now": "2026-10-12T00:00:00Z",
    "deviceId": "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF"
  },
  "keys": [
    {
      "keyId": "vector-ed25519",
      "algorithm": "Ed25519",
      "testOnlyPrivateSeedHex": "0101010101010101010101010101010101010101010101010101010101010101",
      "publicKey": "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w"
    },
    {
      "keyId": "vector-p256",
      "algorithm": "ECDSA-P256-SHA256",
      "testOnlyPrivateSeedHex": "0202020202020202020202020202020202020202020202020202020202020202",
      "publicKey": "AlUPRxAD89-Xw99QaseX9nIfsaH7e49vg9IkSYplyI4k"
    },
    {
      "keyId": "vector-mldsa65",
      "algorithm": "ML-DSA-65",
      "testOnlyPrivateSeedHex": "0303030303030303030303030303030303030303030303030303030303030303",
      "publicKey": "5hHaOD55xIfp9yi-z6sstRXdBVus7Z1qQAdVnQJd0Yd9Lbc2QS1GMYpGvJExgCoPsofTRLjHSgaHjxl0o0Y3pjWA_bfE2ig7xqJEGooTuHlpe0YXVV9BLz_1EgXVeSINJCN3PsneCZV5Ip8hffg3Ijkr5IRCKB_Iu8-cDx1CA1QCrQZ4J7kWn1qKRg-rkp-RgiL3obLpFvkNo8b-Vs8WgN-mhjjoQ9b6lUepbxx1clPeHHfuRNw8RrbXmsCBNvaZL4e7xol6IBZLqySDNSMYlbLT2RlF7qAfV_A9VX7LunqyL8MeLSOCPGhIDRcB1hb-Hh6oa7L7qrZUWDNilZnCvStnaqnTE8_wUkaQauJnpLsc_wvRMdusTzOXgAtTWk5etAEgFemkl1-76Qy07-keX84Eq5etkW4sEybOjHzCR9kUMWBWPfIf20OWM1kW0-H_nxsBpWxJjR0i0x7aqVspE9KcRKgvNsMXJ-feaJxOYFAct79LLxENOY-XgAof0Jm18Yg8a5q_Kxmy5qHEkPQ9lL9qpRyMyR2rHOqARnKJh_1f8Qojcyi6QvwDY8pQCdhNAUl7fhdlwlJK7sgUi4MPCQ2VFFASuxpYnGmDjICNjlIHuEOr1MXltxRoM9invFLjMTT-QZ6oMwacqtYkw6BtRc-_o3FzSBv9NUIvwrzBSiCQ-pS8eI8hUVwY8eKwYfhs2jz26lss_iZ6qonX3uL1Nja4ZtWmkfW1NxsV3wiTtC0jrivJqn5WvIfw11cLeYhMMF1o1ECLCTSqhhojiT3NMaDK3iBHL_bDuUSZmOliazqT52vKfhxn-c0086jCMUF2Zma8j3ZyEQqq-teZiAh2wMcZJuxP9c-GMF0veizP8rUObOdBw-3eJxN7Q6QULuTceTdkE4USVHTAYu_1vaQWCGfu9TvAzMDZ-mb3ohKadVyVRKQ2vaYEf42KCKDRGT9DDG-vucAY2lDFrmDzijviczV5WqTKRHBB-aK7l0m9CHlm1mLnSnxd7QblccnBxIzhmXnlG5gKpPv6qaEWT4Dr_Q2OzKjLgqFAw6d7Z2rNt9BRgFXK9PzSqcmJoD8CeEvU03_2lEwqRiwIIufIslaWvcLX2-d_QO5EZLPq6UsF4moONT6ZQWS5YFCmQz2EqSyftsxRJb473AMWC0P0zS9CT7w32uMbPHK5dQArLQd9weJJnGWGOPkdEqEptZ0gg14FcwHKHJE6Q8bWFJKurv5nnLQQ8jOiVegPNTb81fKNdl8SkfRICgLoz-3F8ta6MKdSt9r2mlFfQpKv4CArIz1ExVT73wLBWLTOE8en3Lp3daC7N3WZE1jcVbzvQfZ69mZGHHbjhyLMhlxpTXxu-_ZBgN7wC4ICi-R2Hdv2a7u-SXf1XlOc4mZcoU1f198J8VvRC4qgBL_gRf0RLQh5AL-jZJSn797-cWQo6_v1q1Ixk94ZNbJSmUHNrdx-2xYOMST87h2ylQilBj3b45SRQhdRWuWoAT65IZBGAnH6l3ZUSb52PeH4opxf3fqlNok9rTqrZBilvIyklRRf6N8mvOd5FQUBLjmE4HL1L-LdamOd9atqYql1P3Goq5y021J5lo88fD1KB1tjn0eBfS5LwXL53FGU6Ni0ZcHLEXweRn54IW4reVWD83lVWy-apn4PdN4n_MQkn-F4NKmZMWg8_LjelGM0wHrEZa3CZ6S_IMeDI1H6tuC0WV_O_QvhTk9zxjYO1i4muzRtGVrhrl9B7Gcdd_IV7FmCwMZxxF173IshcFlA14U4_dnIegNcGOeoR6_FhHUE152RYbnWbFwWgdjeLFWuukq3y4vQW8C8gAUuNVexCmzlOpDW37wr14DClKDymw7HVv6x22-eo-Z9nJlD3K0isGG9P2FRyDhGR40O5bGSZFHSletEDd7fQp9T2YxnRm9fYs2Fa7QQ9yPCyizpI6Mn0a219v3JiMwx3FINFqFaLtEF6K1M2NAkKNreIj26SxInmRu3T__BUMdqjIH4fZ5yVFYEFHOjxmzHF3pZdFCQHtsuyxYV2aZn5H9qwxLkhAve___9xL10AzGO86dokYMDCj5I1jdczRjn2l8NKCGplCjOAbXQ1xjzhEkJ4V91aO-E35uy905qis1dovPrzyrO-0ehPB4Cwa7YYQOy0yB4fcPylqrN6G4tDyLLOm0c5tIKyh7z_SoqL0Y02M3oJ7pls4Co5VMeMUN6sq7Ik60efCUHYFxFCe_d2-Z12tmqzrJ3ViFAZSY-UDlRDWRwTqjtmGqESj6C9XWkLkbMweeNM-YTfDkuuq_aapO1kYYHahnVMoiW3XZbF_-ehABEiuMIM5oI75ZAsxWFXalYci6RTs0hp0Ve_MonBFSnFfVDJpr9ZefUR50_awWojqMOG5OygrFpLuFc7R8fWkeYqI6hPS517d0ZIooBxiVWdKGVe15_LSHlFMeQVUgX4AbQ1Q64Nx_mtf6Rx3PsplwQqU2UE4k4nt1YxjQ7e483-ShNTsP8DSry0-inzfuUkuT-NiqCQq45Z_a9ZOMHcUxhhZ3Q31wnsWc1LnE8zFGDDUyIlbAdaXw3k12kmfhGCoRfVHT1CfKwaAnIWJX9sUmVYDU"
    }
  ],
  "vectors": [
    {
      "name": "enterprise-perpetual-ed25519",
      "claims": {
        "schemaVersion": 1,
        "licenseId": "lic_vector_enterprise",
        "customerId": "cus_vector_001",
        "productId": "cursedelete",
        "majorVersion": 2,
        "edition": "enterprise",
        "organisation": "Example Organisation Pty Ltd",
        "issuedAt": "2026-10-11T00:00:00Z",
        "perpetual": true,
        "expiresAt": null
      },
      "envelope": {
        "format": "repass-license-v1",
        "payload": "eyJzY2hlbWFWZXJzaW9uIjoxLCJsaWNlbnNlSWQiOiJsaWNfdmVjdG9yX2VudGVycHJpc2UiLCJjdXN0b21lcklkIjoiY3VzX3ZlY3Rvcl8wMDEiLCJwcm9kdWN0SWQiOiJjdXJzZWRlbGV0ZSIsIm1ham9yVmVyc2lvbiI6MiwiZWRpdGlvbiI6ImVudGVycHJpc2UiLCJvcmdhbmlzYXRpb24iOiJFeGFtcGxlIE9yZ2FuaXNhdGlvbiBQdHkgTHRkIiwiaXNzdWVkQXQiOiIyMDI2LTEwLTExVDAwOjAwOjAwWiIsInBlcnBldHVhbCI6dHJ1ZSwiZXhwaXJlc0F0IjpudWxsfQ",
        "signatures": [
          {
            "signatureAlgorithm": "Ed25519",
            "keyId": "vector-ed25519",
            "signature": "9NEFHIJehJAuPpTfvouFCxR5BWvdXNwG9F0CpyL-mhZ2ZWlfnEPqRIzwUtyW95ojVP8FHeL_JyDh18NCKf-MDg"
          }
        ]
      },
      "expect": "valid"
    },
    {
      "name": "business-subscription-ecdsa-p256",
      "claims": {
        "schemaVersion": 1,
        "licenseId": "lic_vector_business",
        "customerId": "cus_vector_002",
        "productId": "cursedelete",
        "majorVersion": 2,
        "edition": "business",
        "organisation": "Example Business Pty Ltd",
        "issuedAt": "2026-10-11T00:00:00Z",
        "perpetual": false,
        "expiresAt": "2027-10-11T00:00:00Z",
        "maxActivations": 3
      },
      "envelope": {
        "format": "repass-license-v1",
        "payload": "eyJzY2hlbWFWZXJzaW9uIjoxLCJsaWNlbnNlSWQiOiJsaWNfdmVjdG9yX2J1c2luZXNzIiwiY3VzdG9tZXJJZCI6ImN1c192ZWN0b3JfMDAyIiwicHJvZHVjdElkIjoiY3Vyc2VkZWxldGUiLCJtYWpvclZlcnNpb24iOjIsImVkaXRpb24iOiJidXNpbmVzcyIsIm9yZ2FuaXNhdGlvbiI6IkV4YW1wbGUgQnVzaW5lc3MgUHR5IEx0ZCIsImlzc3VlZEF0IjoiMjAyNi0xMC0xMVQwMDowMDowMFoiLCJwZXJwZXR1YWwiOmZhbHNlLCJleHBpcmVzQXQiOiIyMDI3LTEwLTExVDAwOjAwOjAwWiIsIm1heEFjdGl2YXRpb25zIjozfQ",
        "signatures": [
          {
            "signatureAlgorithm": "ECDSA-P256-SHA256",
            "keyId": "vector-p256",
            "signature": "k4UTQmYUbmH3QEu2tbZ0w4su2bRRbojIZpe0A0O2_FUY52GeMDt51p0eRXh5z0k_6hk0hEgXtvjfmGnz-tfL8g"
          }
        ]
      },
      "expect": "valid"
    },
    {
      "name": "business-activation-certificate-ml-dsa-65",
      "activates": "business-subscription-ecdsa-p256",
      "claims": {
        "schemaVersion": 1,
        "activationId": "act_vector_001",
        "licenseId": "lic_vector_business",
        "productId": "cursedelete",
        "majorVersion": 2,
        "deviceId": "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
        "issuedAt": "2026-10-11T00:05:00Z",
        "expiresAt": null
      },
      "envelope": {
        "format": "repass-activation-v1",
        "payload": "eyJzY2hlbWFWZXJzaW9uIjoxLCJhY3RpdmF0aW9uSWQiOiJhY3RfdmVjdG9yXzAwMSIsImxpY2Vuc2VJZCI6ImxpY192ZWN0b3JfYnVzaW5lc3MiLCJwcm9kdWN0SWQiOiJjdXJzZWRlbGV0ZSIsIm1ham9yVmVyc2lvbiI6MiwiZGV2aWNlSWQiOiIwMTIzNDU2Nzg5QUJDREVGMDEyMzQ1Njc4OUFCQ0RFRjAxMjM0NTY3ODlBQkNERUYwMTIzNDU2Nzg5QUJDREVGIiwiaXNzdWVkQXQiOiIyMDI2LTEwLTExVDAwOjA1OjAwWiIsImV4cGlyZXNBdCI6bnVsbH0",
        "signatures": [
          {
            "signatureAlgorithm": "ML-DSA-65",
            "keyId": "vector-mldsa65",
            "signature": "PLzEhMDbb0yEEiGjT4Remur3CNE7SvnMfhZ3FaY5GMa_LtZKEYEF4eus_ec7RR0dTlVU2KWVq57180tmGPukEUIODpZuU8KbP5RIUhcZalKmI7UMgGi0UbowS_i0-2fUMrfFMNhQjS280Lcg519muM_1M-9PGVl7EXyld4uL_RTvBjL82qgUfgwNm3WuD2NPyKsSQCrdg45x0ZTez9me3l5DpYfhOnzSoHB-HP2pzcfZSoSK7E7ePMuSSaNUwVk4Rdt6CvY5wCT3EO3deKNB7PYpIXQ7SbWBZfB9YahQ27ngdMp0Jby-vL2WlF2zdxO6SEXp1MOGN_BTqB2DRHSVPfRmeNDOgGDqR3GRFxihaPQLGUnqoYj1bvePUOeF1wEfBMXonmeypC7FljT5aKhUP6cuoleGbY108eqzez9n0mIUOQ0ol7kVDVeFGxT38jnbYK_FQ2qcU0U-kCw5I4EyTaPn4cCCIXGWDjjHdBIQ-nJt11e7tds-5tnMaIKYdiK7NNUO_ZUuvyGFfxpN0bMnLdTJePivBWpCxAzzB-WYlMcZlTwRf7ou-0G1MzfV9CGMzA3OZZBX-9X5oqDxVF841WIiIhioVMthNdfxqs8vvc9I1wM3PqIqfufXzMJ6UOh1IOd5E7546mvbVTerYQNnPtatdNzaPfmtoAzTFZiok0Rh8Q3v4FXoj2mygvKLGtxTtByb_o0aloBBza1FbqWg5oYfajS9GNegsU20euzoY2fx-3cyQ3IKyy_oQX2lggROB4ifRgid9w8SARN2oJ86MRSGz4U-FweEKdPwHyIFTgeNWqGoj0o2Un53dQJOA-6UnC-uOT3EfI0dPGAjE-O4XIgn2PHP1y5vcU86FbnzahTFfqBLnOgHXDgIkOKp1QtJZsSCSP1W1ajlNE8_roPSmypdsy7NBtD_9mZxJB2vesW2e5np_8JBfpjywf0P2parCErSZlkr5VMYAbHP9BFjj3ss_T_SGfTIiPRJTa-lDRETZejKmrFIHzsH98Dj_KU5_cT3j2gXgnpecXiNqli8ErvOyzloPd5bDh1E0P67GejBkbIdX7NSdF0WxE4FPAnCyjzMSpLZvH0s9MIa7CCMAIDJ5_hVJlO5v1NOk7oBY0PQaVPFN1BvfvaPDED9r1ABUE2FTnFWxGLggrA_K4v24UlgnkG20VE5nJvfzUtIpPAMu-h4kNTcxvfDBageyNTGEBsh1SB0d3awS7Zj0MpoJ-IYzmSK8hWM3grfLvkYYwTR-X_06C-gTycsdgP09IJF-hBKj8Fd2QtM4dcRFv-iqjGf-YKHpn8EyvaNsKF9qLcYaAwCe99J0JwCx38PhKEfxlmS9Y7NZPG39sOaiyvolO0o2QVSv-I78hfhPeDVDuNf2rt6rsKu3R-E8fsUAPHN5wpZxJKk5fcjfc8nrLjsFyYKY1pA0-kelKA3WQ7PxnYHEc_v5ZdFCOCKR7u3HA7nL8iLMTxP3TsNs62EcoLsLRbLedhfmqplWCE5NWxjyB8gLi9gaeL_p_vOSQLyYyDbzG8jmoy7hvmPXluruHDaaFRx_sVrK5rqW0WA12e64wFJx_INAnWu73JyGTW6zUbrd-EqUtNwwpJoJ03G0sG4ZAUF1gD06g86lR5R2zG7g2zNiAewi6KDomcgq4VVsSu9OS9ZN570gVz8RnAn8f1QE6EHgZOM98WIOaMfxa4qnoIaY6DR87-18619Ib2g2O49sCdGl0QeMrykzA1W90XM_SGEzoCEFUJfNPo1QqDiznxy-dZOYe6Od2Hrlgy4W3_p5u1e7GNCHHE0Xw6R8691BKyYkIuU4y3CkrzvX6qw23KTceO_xdQ1Q3zAasaQdtPQ8KmnnNCgN87Zac6RYA8HSxYeN1TrfGoLGXEmokzoaXhDC9DljB1LuRZxSN_nY0hZkvnx3uhAVShNR0ukcBYVzwxe9PqFYEFRuxD6YEuUagQZrPxVE7mxuE_UdWyG751hOTWWp6XJK2iPcbIqUBtFthm-OF-wCQ7L4rdK-GcVkQEbWq7gyC6wF7u-ldY0IJf7zuaAgUlfqgOzfbZza1rTPtwUDYl0lhqZ8a7S0plgOKnQzEegeVChKoIzRjMAyh0bEfG2ZFnpL6IkdXKhdJVJXJQRimNAKoFC1EJ4mnXjstpopJFqNZDV3TiBmSw32ESu8kJ5ieX-otVdSe-nlOriNFnEKTKCJ0VoHF0AkMcbnnFqWOjxHFqV5ra9fORztU8FQARL4GPeM2_NJcU8x5equAMSonvgTIu3P9Nhok4B5YpOKoTcvVP-EzY9shF2SC41mbEjIqNqsazOWnJOlSRkU9ZF-OfcInFbFhkUkcCEps2B-dU6RUeVhetGBqo8sUcr0XUDE-lruheIvDrP64MpEnW4Pi_p27JLI9jIX7z9H1R9Wv2b_MGgEEaB0aGV7EOj1D7YZUit349lm6QInelgxNJIzRhx7pEnr1LhsuudQ60PByGP_Ed0LcEVKyuXGDESQ7setGwR_dT2acdqovBv280ebWphBGgxqsBGC4Jz33X1pXIrAzeYNfeCGhGJKbLE0CBuRKddj8yGK_0tF1wasAL6b_BOV1HGxiRsp5zykeIZiIMH0530bsfNOP09Fseinaak3zoyKdlYgYvl3QNH-wVPdAzH1TV5jlTUoJ6Z13-jfhDGpAUQTpwR8qLlUf8Xkz5Sg3fvPO8xebu73rw7j2uXpo7Sj--EMfj6sZMsjkw1c29gD_qxRteFiD-GvNPkvyshGalc3cmzhC6zhyqlf0L5uzhrYbdkR0LSjV0qxPKqotZbmyLDAgtDb73U4E_yMpd01cunnisLXZDKvJARsjGATAy0q6fcXeHmO5MqLYARZE2GzMXmzlweGYoUMAPU3ixaB-0O6GdFsxsti7AeHzzQrvhzWEVMT4hx3ZOLQfuzjddAIydJeq4ChSm8Xho-Mh5J5TI4dwLBzU1NlKoQaw7SWa-qRWKoF0dt8BUNDkACScW4RzbgW_x3b0nrTofeDkNUGFOcsAfk3nycn1YNO-O9gdbBN3M8B2e5RyxVq_mZYfH84dI1v2BiloenTn2ynCrzD2UDb0l4Z3wXTi_bjhDbL4VxObk3vEuVDkeXfiBhwWE67tdOxAl-MgNsEH7iamD4Ozg17rg2TS9uEEiFm_l7M87RfY-DrnKMcPlmA7WeR-im10UCYp8qAfq53SGzYEDa3W1pXAQYTFenFVhv3p-x9u3vw4GKITkJW3W45gu506oPxLxs3hAhdu0gQwCxLpX9klAqmRgbkSNtv4dtrkMXe3bU-mgbxTcUZ2FA4D_5mMtVfO5228607ZRg5YU0u0IpkwswDpCMr1qkjSS94FqNZF7ig1b1TuV9deqo3ot4icL9G8oGi5emaUdFrXWgi9KKoopymGLUJshg8XrqG7KKMa7OYBlL0x06bVjVaj6k5Nit-SnD3s2q0YR5IoFXPKTkatphpvQYnFbT9nm1cCBhcIkMUNFDdPGjMXuKqnHtGBt8B8OnDiiuRk_IKpUJQNtBirT_OHoPO5Gnoe_ZyYOVxFjVpaf9Cczi8h5f7xXJfQ0ZdUTrpqgClL-cXem-tv5EEsouhyL_WQPok0WDsfLdTWyA-t9hFubgO9F9f7nAmFxbeQXBYZKrDf-QiBM_fZPLgbUZZVpjclirHqamuVXfRhZXojj_qsrLqQQ8OagxDADFEDR-X7Ifn50voCAANkO1jZ4IudkinzqAV6Jo4EaSMej6GvGdlytK4gJS4yICz5VD6BhI6v_XdCeuAeoFIIPu3WblvcNjGeDceHgAcv7hQa6d1-BSVQtLId_xUXfZqv_HmmRGi0HiEDZdh2MXRT76vdiu2LcIwVHPFLEuQNJPKgkWDpkkwirWf_gfVWWgALfVAcvzl-caZEbF3IAkR1GHKbOAm4YRmklGQXYT6GwP3L9_9WUjhZxX-dLGM-k102J2KF0w2G3-FwWvdnSAl8P02d9JeBSuiy8ErXWbbnama-3bUHRT9ssASUpgThoesKsYmxMPIzm4EfZrcZvqvOq-NrvyWgYmenKdjhRAmVsxji3VjW3azu5dPaKHDFaRmtOvexT3fvKW29fJl4dzQYyOq8C63u2xftv-iEZdotqCfI3EM2VmlnPc3fxwcMS3PiyYBLl3bwLPKw0IriD65yW7UcFYcFAn-ZaW0F2GLWuL6sXszBSeOiZQVUbxTyLN7G5OPx-mV9VKpxQg-nIHy7G_v0-tliG2Tq7PXAnyO_QHm_m02hsofw9zWrIOSgLtzdUCHrBwAizXYU3b2eR8OxZFUmw2HPIoW9zMMNREqkbmDWQHBXx7y3jNLalcz8MOHSB8h6m701hrisjRBjNZdfL-CSFsbaGw2eo5YXB8ncje5R5AXGqYrAAAAAAAAAAAAAAAAAAACA0TGyMp"
          }
        ]
      },
      "expect": "valid"
    },
    {
      "name": "community-dual-signed-ed25519-ml-dsa-65",
      "claims": {
        "schemaVersion": 1,
        "licenseId": "lic_vector_community",
        "customerId": "cus_vector_003",
        "productId": "cursedelete",
        "majorVersion": 2,
        "edition": "community",
        "customerName": "Jane Citizen",
        "issuedAt": "2026-10-11T00:00:00Z",
        "perpetual": true,
        "expiresAt": null
      },
      "envelope": {
        "format": "repass-license-v1",
        "payload": "eyJzY2hlbWFWZXJzaW9uIjoxLCJsaWNlbnNlSWQiOiJsaWNfdmVjdG9yX2NvbW11bml0eSIsImN1c3RvbWVySWQiOiJjdXNfdmVjdG9yXzAwMyIsInByb2R1Y3RJZCI6ImN1cnNlZGVsZXRlIiwibWFqb3JWZXJzaW9uIjoyLCJlZGl0aW9uIjoiY29tbXVuaXR5IiwiY3VzdG9tZXJOYW1lIjoiSmFuZSBDaXRpemVuIiwiaXNzdWVkQXQiOiIyMDI2LTEwLTExVDAwOjAwOjAwWiIsInBlcnBldHVhbCI6dHJ1ZSwiZXhwaXJlc0F0IjpudWxsfQ",
        "signatures": [
          {
            "signatureAlgorithm": "Ed25519",
            "keyId": "vector-ed25519",
            "signature": "DAQ-S1Dtqryhk_5IBrGgP4ue7XktdV7cOg2hgYViUgL32UMwjzfyXJz4HW9yFIeG2awyOV0QkoT-U3zFBDAQAA"
          },
          {
            "signatureAlgorithm": "ML-DSA-65",
            "keyId": "vector-mldsa65",
            "signature": "J_f8IGRZzvwS5tvKGMTr23jb2W6taROyGBm52mw_1h3Wh2Ur3XqbGF9-0032dmnS5wVxTx5j--iakgQuLraF53PZAkV-OJXQKFehgB7fav1kdQA8ZuR_2t8N2GOn_ij1Gv1wqRG-sQuFkbpyq6G3_j55IZBsYMDJjHaiyEd_FIpbZ89bopAgThB3u_q7V8HdFT6G4tiMJuxe7sMi6mSdN2o0SipVpkoxVotpzPecEM_K3OQSjH8VhieKKMQOnEitZPETiVB0se1Yk-P-RNzG2NTum4ToHsK0kNYCXNlkkAA_oHtQ7ChA0Oa67LnE-YEMcLXzlKQyaygcwFULRUkwFUZdxEwuFtEWL6zDPCvpUtObaGUawGMyAqOZt3UpYXXwXJG9Y56_pCnUJxckQ38_x9-Wvh__8kd3YzbdA9eRnWaPyAEy9RU0U8zraF4IXz_CDq_69ZvbUU5aZfO73jG8B0TGCEHDx4xClnjReO6dSsRK_rqqC4OaKuzZ__gzg-Ij4NaZ8ETUA_OMaSBqzNrUKODJtkbAENphdGEhvi7u0L2TafBjLnH1P8saAArSj7PurwbBdgu8X2_RSWgll0L0H9wATiUOqwlsCWUlOX0vFY-HcmlkXsffEHhikIyViOJig2Ehk4zPVXs_fTG-wIxmRZlr24U3Gu7qdboxPOWTls0W4XVTZlEV-KExEeBs9V3bwo_zwCHvGxetY6tYRsQWEhbSA-sLGExaYuKMjGdwP4BbZJFoQ-aBX7R4mXK_vTVGuYpVKxH48hXJXYzjmWM7PG_-JdHj0np-iC7mvngzPoIBiWv9rY2U1jzG2St40L5BvSZtpY2Q5QJHKNFUAsPFnE7CZM9nSfGhfcEnruDBgqclQV6tiDlTn83uaUJcD1C-7SqzyjI1dlA1qwRv1N-vp-lkhfNpkZyYFuqVRh1cP-54xZKJgtfQvllqYpnJGJed0TAa2Z-euF3jPdBAVWxThk88X9nKqFBL4vOYoGJoviL1GuveH63DoZXG0a2f4PcuPIZl8zudBU7p_meSxZ8gDfgirvS_9lIjnB4WN0Q8dpkFvNeSDilTxKJpWC7OTgfj-HP34A90u3P-qWGQ5uj_ZDjnZdkQrBmRZFGifYsb4Yjr0PMGgZ00mz1vrkpXIXB_iWRF7_g7f9bqC1_W4un3g-cBhk6zJLMM_0N4gbYPNJ8aX13SPqauB-Qtnq1mqIYGKdblgmm85dGeznA8GRHZlQuwB7RIy0KbOCQ-UUfTxezAf_O-YzyQmsO9DltdWJU2e1DIsE-F3UjIWA3PtN1Nzb5Cwl2G-S1dAszyh4Xooz4f4VOSXbI03fSc_c3LJ9ae2MH6AXsGwqcx1HiDLPJY9ooeDXszCLg5tld0tJxHrlwogmFfxkmRG_gdcEla_EMdns1pwMTEHG0Bl79KUFJdhu-tSdVPm_mVTuXAzznHeoxuEtBPSsKhE3_KidJuCAUfuN7-SpoJ4s-eP11Z-IJ1xc1g1mv1BeAsoURJbspdcOyajsWDD9sFSR31vLGdNvpxrB29U44T2oI7o4IQzHFVuI80vPdCW3isb9b0FN89NnXe689N9bBFcqBLYghpXhWlrOON0TM6eiCLDNlBmrmk18K2Q370a84V525mKlQ4s9fUC55fZg1DkZItAQGAy-uyYBOgNF0YFeZSHJvGOmHW-fkyLxL-wEqIlgM39nsy-PaHP_JoymS3r6HdQJHyeuy0zPak9M6AHDs84aNqmFiq7OHnE7xTTs_kqi7lxb3JDi35IVEJKTQcpTzl6VICqdxBB1fM42PJBi1cjAysNe0kGbRdoInKCHhd64ObF9M0bmNrzlYp5GdknV9UYC9Q7TuV3aa5oT5jYdMeiu-HyuqgarnMAlyoUGi9yvsALCqViW-V1fB0JMscpEItxiQBz3cSNg7JfmQe-qzZKkQg5cybAOKeRg7OZOE0L12XOPNWFllc_4_BO3zqsAnU4oFaWuE70fgxVJjAuiDO15DKqRkPBV5dYwQiq-Cp_qo4a0YKnlFz9rTU8tyqYrx2kOGlVcS0JFsnwSSG3O6VXH0I6NRtjLKlguSqtUCz7L8jYA9t0nXoU9eXzpV4dChvIy1BcRtJK_VXzccPuCGlClHXNphwqPsY-cBf1s8RTp9CQPpTebxwv-x8U2lGU25sJ40AK090tumbr0VgoFf8QFoGYY6UQP7qp8JeJcUphp5TLpH-wykR03Qnp9CR38_5EyotwCqwdQri_3cmCJRE9CfoDWk6aDdVStl5RFEjHsYIWu6ymQVHPzwtmaKJVYhMPK3iawKA3opfEV3buzPGJHET7_PAZF8x42ur9zHKlBGscynOb-DCZpH1y8XSV9totirfBaDY4Mmq02DmX2OVk97MqEFAKWk6fE7FLWkRY6b3XE9-pCUgxb4o79shM0Mbmf5EVUbrCDdlkpD-Vh0zquezKdBywy0xTu7IJ0wRlzFSEDRGIBu-WiUd1aVHzoFxsZrkS6YxnRoFweoh-mbfbLAh_lQH9o1P94AcOz8lTciyHQ1BH7LmwlbbbGkW6r3ZH6stbw_5wn0-AGBgnpw8Nn0AcBoCDm2ZvqaSyK8RcXzkOduyWEnNIju0t0ErEn6w615x9PYYYsIBMeE0HfIDE_ZFnu5cIFh2SjFWms0MOpc9ZseNK9_hHIvHSBsBORtLYiLJ6yP8qnk6_mBLdFjNOSkN3Lpd0iGDLhtJfXbCstw1qK2JDgGrNvZGBh3kv0JhRA_jAHrm4EjvXu5gI89iZKOO3P4-6iq-7RiyYbNXt5QhQoUbPXIinPJ9KKCQYmVyeZGVpERpi2fdxEkbLjt1VAPMFfstQU8OaAICxos-65QCnUomDLkfLLYWGswseNUImI3gWR0x93B9lGsTMwwj7krdTuRkpct7XZ9NUL0Dbbx59c_fLXesowpaChZWwQ8bSbZ6NX5H4GSQsLTErMoDYJ_gPi9Wgdfxa2wilo_Y1BjY-4a7sz8nLJMkqMgSrSHQHRvqQQHpg2HHE1SctJckLGvXtDH7ui3T1GhIWUqjN57EeidBBvnaECU4vKwUSDqN-l6YfywZ8oGvhazhC8MVRgaxFdMAHKAsp-XKPDTS5BnMv2bLiIfcjdhNc_Xv2Q2Ww0bjyL3XC7cCvyHaj7hHSifCz_zGoZ5IIgKuo6vK6KLK67M1oPnz1uECrgEV-spjU29zDVS-X_eM2yhB9Fco5mAFe0qCZ-uuUM4DPgIPDObk4cymix40HYowgr6Z6QslAKPsWalk-RCB3wOhdiLvYF10kGXsO-twUfPcpUylDQYfcSmfqHUJbhVZ_W96q1h5Zw1_E2Rz9v1zWQTGpVGlPakpEFzyo9Uvc_Q8N8k2JBCe0Z6Tj_ch1RAX85tEVRcPRWu7NRaoPr86xB-0Y4mNKMuosulkJLDDtlrsbQu31kKANsplmPfN8IJwALosEUqtBN5i7B1yiXfkSc1oKDgI7MhDQq7Mx5vZgfOZTpj0HZIZFPFSyU0LaPrn50k9ejW3XdWp2nc2UpHyXnjLNiwFfQhxTyC0_-Sl4RM8j5MNB8tFZ2pDPY5zlPMwk44BzSkCe0buB7FYDea2r3XzsZFDgZea2TYO8Fc2w_6kvhR1NT2OUMvFQIs0HpwYuR15Lgxj-ZwoCIycUzcoHtZqCgiiiB3MsgxPmVSdCgfQvB5RXa1m4FzfdIzCH9MH1cEkR9c8EefBCPkFwA7cECC6QFdmiRYaWcgcbyNag_pIzOgO_cO2igr5d9k4TbHiyT4DeI6bnYC7LAc0L1M9Sh1sYqYBM-NEglbwkxgJtzW9VBG4lkdb0eKTgaezJBfLSg_wTbK6JXJxTh3zn-QW2czN2DZpgyV-2VWniYKuk3r2RwYe8Jt_uR0v7QJxrx1IjOfyQJUfHQLB4w8WS_z-U5e0VwLM6h7FKUfOxauxA0JGBw0h8ArPTVz1aoCokERrZSJPZ1pJGoMfVBS-R5HvAQyCAjD_2R5e14XOkTiPC82dhZz7uo93Ky7Zok6rFa-hrUIBhhgYlqnzk6aFo1IkJb6Iq70P1Wnzip1GtTLJd6zAh7tcC6YAoBMOQjvrdk84zyWeU17o7rML_Ns-RdgGG6o4Ek-XtWY-Lut6Mztkm5g5wVM67FabOQbifu7A0Q_ETSIHWnMY3EPmhVfyTgGQVFeGRb2-pnpuymNhsLHp9VUiO4gUvrYv8qSWYPS3Jqy_HzdRks6VbZi8dnWC4rG_sgdI7jsugMIUUxpvmuCccI6qaIgWirQqwxZVJ6E8PPXV5s25Cm3VoU7Rt_Y4pxPb250zW-F21VpgfrkTLKs1BTdtNsmCm8expUxtl1dmnNjn9TFydneSm8HmAAwYa6DM6wMKMmCuDyI3RlVag-FwevQAAAAAAAAAAAAAAAAAAAAAAAAABQ0UGSEk"
          }
        ]
      },
      "expect": "valid"
    },
    {
      "name": "tampered-payload-must-be-rejected",
      "envelope": {
        "format": "repass-license-v1",
        "payload": "eyJzY2hlbWFWZXJzaW9uIjoxLCJsaWNlbnNlSWQiOiJsaWNfdmVjdG9yX2ZvcmdlZCIsImN1c3RvbWVySWQiOiJjdXNfdmVjdG9yXzAwMSIsInByb2R1Y3RJZCI6ImN1cnNlZGVsZXRlIiwibWFqb3JWZXJzaW9uIjoyLCJlZGl0aW9uIjoiZW50ZXJwcmlzZSIsIm9yZ2FuaXNhdGlvbiI6IkV4YW1wbGUgT3JnYW5pc2F0aW9uIFB0eSBMdGQiLCJpc3N1ZWRBdCI6IjIwMjYtMTAtMTFUMDA6MDA6MDBaIiwicGVycGV0dWFsIjp0cnVlLCJleHBpcmVzQXQiOm51bGx9",
        "signatures": [
          {
            "signatureAlgorithm": "Ed25519",
            "keyId": "vector-ed25519",
            "signature": "9NEFHIJehJAuPpTfvouFCxR5BWvdXNwG9F0CpyL-mhZ2ZWlfnEPqRIzwUtyW95ojVP8FHeL_JyDh18NCKf-MDg"
          }
        ]
      },
      "expect": "invalidSignature"
    }
  ]
}
```
<!-- END TEST VECTORS -->
