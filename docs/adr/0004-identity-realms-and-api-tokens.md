# ADR-0004: Identity realms and API tokens

- **Status:** Accepted · 2026-10-11

## Decision

There are four credential families, which never cross trust domains:

| Credential | Realm | Storage | Peppers |
| --- | --- | --- | --- |
| Customer session cookie `__Host-rp_cus` (Lax) | `/portal`, `/store` | `auth_sessions` HMAC, realm=customer | `AUTH_PEPPER` |
| Admin session cookie `__Host-rp_adm` (Strict) | `/admin` | `auth_sessions` HMAC, realm=admin, `pending_mfa` → `active` | `AUTH_PEPPER` |
| Admin API token `rpl_pat_…` / `rpl_svc_…` | `/api/admin/v1` only (bearer) | `admin_api_tokens.secret_hash` HMAC, lookup ID public | `API_TOKEN_PEPPER` |
| Activation key / device client secret | `/v1/*` only | `activation_keys.key_hash`, `activations.client_secret_hash` HMAC | `MACHINE_PEPPER` |

- **No passwords.** Customers sign in with single-use, 15-minute email links. The `GET` request only shows a confirm button and the `POST` consumes the link, so email-scanner prefetches cannot use it up. Login responses are the same whether or not the email exists. Admins use an email link (first factor) and then TOTP (RFC 6238, ±1 step, replay-protected, secret AES-GCM-encrypted under `APP_DATA_KEY`). Admin sessions last 8 hours absolute with a 30-minute idle timeout. Customer sessions last 12 hours absolute with a 2-hour idle timeout.
- **High-risk actions** (`signing_keys:manage`, `admins:manage`, `tokens:manage`, `entitlements:revoke`) require an MFA check within the last 15 minutes in the UI (step-up). Destructive API calls require `confirm` equal to the resource ID.
- **CSRF.** A session-bound synchroniser token (HMAC of the session) protects every cookie-realm POST, together with Origin / Sec-Fetch-Site checks. The admin API reads no cookies, so it has no CSRF surface. No route sends CORS headers.
- **Tokens.** Each token is a 256-bit secret shown once, with a 16-character public lookup ID. Mandatory expiry (≤ 365 days; ≤ 30 days if it carries a high-risk scope), optional `not_before` and CIDR allowlist, and a per-token rate limit. Rotation revokes the old token atomically. **Effective permissions = token scopes ∩ the owner's current role permissions** (or the service-account ceiling), so revoking a role or disabling an account takes effect on the next request. A token never carries more than its creator holds. There is no master key.
- **Bootstrap.** `scripts/bootstrap-admin.ts` (operator CLI with direct database access) creates the first super administrator with TOTP already enrolled. There is no unauthenticated setup endpoint. The last enrolled super administrator cannot be disabled or demoted.

## Not implemented (explicit)

- **WebAuthn passkeys** for admins. TOTP satisfies the MFA requirement. Passkeys are a candidate enhancement; consider putting **Cloudflare Access** (free for small teams) in front of `/admin/*` as defence in depth.
- **Dual approval** for key operations. The current controls are step-up MFA, a confirm string and audit. Dual control is recommended once there is more than one key custodian.
