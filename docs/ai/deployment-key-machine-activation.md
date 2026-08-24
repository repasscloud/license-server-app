# Machine Activation via Deployment Key — AI Agent Reference

This document is written for an AI/LLM agent (e.g. a GPT-based automation, RMM script generator,
or golden-image provisioning assistant) that needs to activate a machine against the license
server using a **Deployment Key**, without needing to read any other file in this repository.
Everything required to construct a valid request and handle every response is below.

## What a Deployment Key is

A Deployment Key is a long-lived, revocable credential that lets unattended tooling (Intune, an
RMM, a golden VM image, a container entrypoint script) enroll a machine against a license without
a human typing an activation code. It is **not** the license's activation code. It is created
ahead of time by a human operator (or an authenticated admin API call) against a specific license,
and looks like:

```
dpk_live_<16-hex-char publicId>_<43-char base64url secret>
```

Example (not a real key): `dpk_live_A1B2C3D4E5F60789_9f2h3JlN0pQxYzT1uVwR8sD7eGkLmC4bXaHi6Y0oPqI`

- The full value is shown **only once**, at creation or rotation time, by the admin who created it.
- If you are an agent receiving this key from a human or from a secrets store, treat it exactly
  like a password/API key: never log it, never print it to shared output, never persist it in
  plaintext outside of a proper secret store.
- A Deployment Key grants **only** access to the one enrollment endpoint below — nothing else
  (no admin access, no license listing, no billing, no other machine's activation data).

## Endpoint

```
POST {baseUrl}/api/v1/deployment-keys/enroll
Content-Type: application/json
```

`{baseUrl}` is wherever this license server is deployed. There is no fixed public value — it is
an operator-supplied configuration value (local/dev default is `http://localhost:8080`). Do not
guess or hardcode a production URL; ask for it if it has not been supplied to you.

This endpoint is **anonymous** (no bearer token / cookie / API key auth) — the Deployment Key
itself, inside the JSON body, is the credential. Do not send any `Authorization` header for this
call.

### Rate limiting

This endpoint is rate-limited on two dimensions simultaneously: by source IP, and by the
Deployment Key's public ID prefix. Both defaults are on the order of 20–30 requests/minute. A
`429 Too Many Requests` response means back off and retry later — it is not a sign the request is
malformed.

## Request body

```json
{
  "deploymentKey": "dpk_live_<publicId>_<secret>",
  "requestId": "<new GUID, string, one per attempt>",
  "activationToken": "<32 random bytes, Base64-encoded>",
  "mode": "online",
  "device": {
    "scheme": "os-machine-id-sha256-v1",
    "deviceId": "<64-character hex SHA-256 string>",
    "deviceName": "optional, human-readable, max 100 chars"
  }
}
```

Field-by-field requirements (the server validates all of these and returns `400 Bad Request` with
a specific message if any is wrong):

| Field | Requirement |
|---|---|
| `deploymentKey` | Must match the exact format `dpk_live_<16 hex chars>_<43-char base64url secret>`. Anything else is rejected before the credential is even looked up. |
| `requestId` | Must parse as a GUID. Generate a fresh one per activation *attempt*. This is used for idempotency/tracing, not as a credential. |
| `activationToken` | Must be exactly 32 random bytes, Base64-encoded (so a 44-character string ending in `=`, decoding to exactly 32 bytes). Generate with a CSPRNG — e.g. Python `base64.b64encode(secrets.token_bytes(32)).decode()`, or .NET `Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))`. **This is a bearer credential you must persist** — see "What to do with the response" below. The server never returns it to you; it only ever echoes back what you already hold for future calls. |
| `mode` | Must be the literal string `"online"` or `"offline"`. Use `"online"` for any machine with network access to `{baseUrl}` (the normal unattended-enrollment case). `"offline"` is for air-gapped machines and produces an activation with no refresh lease — you generally do not want this for a Deployment Key flow unless the target machine truly has no network path to the license server. |
| `device.scheme` | Must be exactly the literal string `"os-machine-id-sha256-v1"`. There is no other supported scheme value. |
| `device.deviceId` | Must be exactly 64 hexadecimal characters (a SHA-256 hash, case-insensitive hex digits `0-9a-f`/`0-9A-F`). This should be a stable, privacy-preserving hash of something that identifies the physical/virtual machine (e.g. a hash of the Windows `MachineGuid`, `/etc/machine-id` on Linux, or a machine-name fallback). If you are generating this yourself rather than calling an existing device-identity library, compute `SHA256(some-namespace-string + "\n" + source-tag + "\n" + normalized-stable-value)` and hex-encode the digest (uppercase or lowercase both work) — the only server-side check is "64 hex characters," not how you derived it. |
| `device.deviceName` | Optional. Free text, trimmed and truncated to 100 characters server-side. Use the machine's hostname or similar for operator readability in audit logs. Omit or send `null` if you have nothing useful. |

## Successful response — `200 OK`

```json
{
  "licenseId": "LIC-ABC123",
  "activationId": "3f2a9c1e-...-guid",
  "status": "active",
  "signedLicense": "<full signed license envelope, as a JSON string>",
  "refreshAfter": "2026-08-13T06:31:00Z",
  "leaseExpiresAt": "2026-08-19T06:31:00Z"
}
```

`refreshAfter` / `leaseExpiresAt` are only populated for `mode: "online"`; both are `null` for
`mode: "offline"`.

**What you must persist locally on the machine, durably (e.g. a protected local file, OS keychain,
or equivalent — not a plaintext world-readable config file):**

1. `activationId` — needed for all future validate/refresh/deactivate calls.
2. The `activationToken` you generated for this request (the server never gives it back to you).
3. `signedLicense` — write this to whatever path your application expects its license file at.

## Using the resulting activation afterward

The activation created by enrollment is a normal license activation — manage it exactly like one
created through the manual activation-code flow, using the `activationId` and `activationToken`
you just persisted:

- **Validate** (cheap liveness check, no new license file):
  `POST {baseUrl}/api/v1/activations/{activationId}/validate`
  Body: `{ "activationToken": "<stored>", "deviceId": "<recomputed each call, not stored>" }`

- **Refresh** (for `mode: "online"` only — get a renewed `signedLicense` before `leaseExpiresAt`):
  `POST {baseUrl}/api/v1/activations/{activationId}/refresh`
  Same request body as validate. Response has the same shape as enrollment's success response, with
  a new `signedLicense` and pushed-out `refreshAfter`/`leaseExpiresAt`. **Overwrite** the on-disk
  license file with the new value. Do this on a schedule well before `leaseExpiresAt` — treat the
  lease window as slack for temporary offline periods, not a hard deadline to race.

- **Deactivate** (frees the seat, e.g. for decommissioning a machine/VM image):
  `POST {baseUrl}/api/v1/activations/{activationId}/deactivate`
  Same request body as validate.

Calling `refresh` on an activation that was enrolled with `mode: "offline"` returns a conflict —
this is expected behavior, not a bug.

## Recovering a seat when the local `activationToken` is lost

The normal deactivate flow above requires the `activationToken` you persisted at enrollment. If
that persistence step failed — for example a build shipped with a mismatched deployment-key pair,
so enrollment succeeded server-side but the client crashed before writing the token to disk — you
have no local credential to deactivate with, and a retried enrollment fails with a `409 Conflict`
("License is already active on device ..."). Use force-deactivate instead:

`POST {baseUrl}/api/v1/deployment-keys/force-deactivate`

```json
{
  "deploymentKey": "dpk_live_...",
  "device": {
    "scheme": "os-machine-id-sha256-v1",
    "deviceId": "<recomputed on this machine, same as enrollment>"
  }
}
```

This is authenticated by the deployment key (anonymous endpoint, same trust model as `enroll`) and
the caller's own recomputed `deviceId` — **not** by `activationId`/`activationToken`, since those
are exactly what's missing. It releases whichever activation currently holds that `deviceId` under
the deployment key's parent license.

**Trust model — read before relying on this for isolation.** `deviceId` is a deterministic,
self-reported identifier (the same `os-machine-id-sha256-v1` hash used at enrollment), **not** a
cryptographic proof that the call originates on that specific device — the server has no way to
verify hardware possession, exactly as `enroll` itself never verifies it either. The full `deviceId`
hash is also not secret: it's embedded in every signed license artifact (`deviceBinding.deviceId`
in the response body), so anyone who can read another machine's license file — a support bundle,
a backup, a cloned VM image before individualization — and who also holds the shared deployment
key can force-release *that* machine's seat, not just their own. This mirrors how `enroll` already
trusts the deployment key holder to claim any `deviceId` they present; force-deactivate is more
dangerous only because it can interrupt an already-running machine instead of merely contesting a
free seat. Two things bound (not eliminate) that risk:

- A dedicated rate limit, deliberately much stricter than `enroll`'s: 5/minute per deployment-key
  prefix (`RateLimits:DeploymentKeyForceDeactivatePermitLimit`) and 10/minute per IP
  (`RateLimits:DeploymentKeyForceDeactivateIpPermitLimit`), enforced the same two-dimensional way
  `enroll`'s rate limiting is (see "Rate limiting" above) but as its own independent budget.
- Every call — successful or rejected, including a malformed/missing-field request — writes an
  immutable audit record (`activation.force-deactivated` on the released activation plus
  `deployment-key.force-deactivation-succeeded`/`-rejected` on the key), all committed atomically
  with the deactivation itself, so a single leaked `deviceId` cannot silently or repeatedly grief a
  seat without leaving a visible trail. If you see unexpected `deployment-key.force-deactivation-*`
  audit entries, rotate the deployment key immediately (`POST
  /api/v1/admin/deployment-keys/{id}/rotate`) — that invalidates the old key's ability to call
  either `enroll` or `force-deactivate` going forward.

An administrator force-releasing an arbitrary `deviceId` they've merely observed (e.g. in the
license admin UI's activation history, which only ever shows the 8-character suffix, not the full
hash) rather than one their own machine computed is a materially different, higher-trust operation;
that still goes through the internal `POST /api/v1/admin/activations/{activationId}/deactivate`
route, which requires authenticated admin permission rather than only a deployment key.

Response shape mirrors the normal deactivate response:

```json
{ "licenseId": "LIC-...", "activationId": "act_...", "status": "deactivated", "deactivatedAt": "..." }
```

Rate-limited far more tightly than `enroll` (see the trust-model note above; IP dimension +
deployment-key-prefix dimension, same two-dimensional shape as `enroll`'s limiting, but its own
lower budget). Every call, successful or rejected, writes an immutable audit record, so
this is not an unaudited way to grief someone else's seat. Once the seat is released, retry
`enroll` normally to re-activate this machine and get a fresh `activationToken` to persist.

Use the normal `activations/{activationId}/deactivate` flow whenever you still hold the
`activationToken` — force-deactivate exists specifically for the "local credentials are gone"
recovery case.

## Error responses

All non-2xx responses are [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457)
(`application/problem+json`), with `title`, `detail`, and `status`. Do not blindly retry on 4xx.

| Status | Meaning | Typical cause / agent action |
|---|---|---|
| `400 Bad Request` | Request shape/field validation failed. | `detail` names the exact problem (e.g. bad device scheme, malformed activation token). Fix the request; do not retry unchanged. |
| `401 Unauthorized` | `"Deployment key is invalid."` / `"Deployment key has been revoked."` / `"Deployment key has expired."` | The key is wrong, was revoked by an operator, or passed its expiry. Do not retry — get a valid key from an operator. |
| `409 Conflict` | License-state conflict — e.g. seat pool exhausted, this device already has an active activation elsewhere on this license, or a concurrent activation race was detected. | `detail` explains the specific conflict. A "retry to see the active device" conflict message means a concurrent request won the race; a fresh attempt with a new `requestId` may succeed or may confirm the existing activation, depending on the message. Seat-pool-exhausted is not retryable without operator action (e.g. deactivating another machine or raising the seat count). |
| `429 Too Many Requests` | Rate limit hit (IP or key-derived partition). | Back off and retry later; not a request-correctness problem. |
| `503 Service Unavailable` | No signing key is currently able to sign envelopes server-side. | Transient operational issue on the server side, not something the calling machine can fix. Retry later. |

## Minimal worked example (Python)

```python
import base64
import secrets
import uuid
import hashlib
import platform
import requests

BASE_URL = "http://localhost:8080"  # replace with the real deployment URL
DEPLOYMENT_KEY = "dpk_live_..."      # supplied by the operator; treat as a secret

def stable_device_id() -> str:
    # Any stable, privacy-preserving 64-hex-char hash works; this is a simple example.
    raw = f"SoftwareLicensing.Poc.DeviceIdentity.v1\nmachine-name-fallback\n{platform.node().upper()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

def enroll():
    payload = {
        "deploymentKey": DEPLOYMENT_KEY,
        "requestId": str(uuid.uuid4()),
        "activationToken": base64.b64encode(secrets.token_bytes(32)).decode(),
        "mode": "online",
        "device": {
            "scheme": "os-machine-id-sha256-v1",
            "deviceId": stable_device_id(),
            "deviceName": platform.node(),
        },
    }
    response = requests.post(f"{BASE_URL}/api/v1/deployment-keys/enroll", json=payload, timeout=30)
    response.raise_for_status()  # non-2xx -> inspect the Problem Details body before retrying
    data = response.json()
    # Persist payload["activationToken"], data["activationId"], and data["signedLicense"] now.
    return data
```

## Things this endpoint will never do

- It will never return the Deployment Key's secret back to you (it only accepts it as input).
- It will never grant access to any other API on this server — no admin routes, no other license's
  data, no ability to list or enumerate other machines' activations.
- It will never succeed twice into "two different activations" for the same `(license, deviceId)`
  pair beyond what the license's seat pool and existing-activation rules allow — recovering an
  existing activation for the same device is expected/idempotent behavior, not a bug to work around.
