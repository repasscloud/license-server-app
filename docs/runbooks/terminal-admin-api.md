# Terminal admin API: curl + jq + macOS Keychain

The admin API (`/api/admin/v1`, OpenAPI at `/api/admin/v1/openapi.json`) uses **bearer tokens only**. It needs no browser session, cookies or CSRF tokens. Tokens look like `rpl_pat_<16>_<43>` (personal, owned by an admin) or `rpl_svc_<16>_<43>` (service account).

Rules: the token is shown **once**. Keep it in the Keychain. Never put it in `.zshrc`, dotfiles, repository files, command arguments that persist in history, CI logs or commit messages.

## 1. Create a token

In the admin portal, go to **Access** → **Create an API token**. Choose the minimum scopes, an expiry (≤ 30 days for high-risk scopes) and, optionally, allowed source CIDRs. Copy the token straight into the Keychain. The `-w` prompt keeps it out of history:

```zsh
security add-generic-password -a "$USER" -s repass-admin-pat -w
# paste the token at the prompt
```

## 2. Use it without exposing it

Define a small shell function **in the current session only**, not in `.zshrc`. The token goes to curl through a here-string config on stdin, so it never appears in the process list:

```zsh
export REPASS_API=https://license-server.repasscloud.com/api/admin/v1

rp() {   # usage: rp METHOD ROUTE [JSON] [extra curl args...]
  # (never name a zsh variable "path": it is tied to $PATH)
  local method=$1 route=$2 body=${3:-}
  local -a data=()
  [[ -n $body ]] && data=(--data "$body")
  shift 3 2>/dev/null || shift $#
  curl --silent --show-error --fail-with-body -X "$method" "$REPASS_API$route" \
    -K - <<<"header = \"Authorization: Bearer $(security find-generic-password -a "$USER" -s repass-admin-pat -w)\"" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" \
    "${data[@]}" "$@"
}
```

(`-K -` reads the Authorization header from stdin; the token never appears in `ps` output or shell history.)

## 3. Examples

```zsh
# Who am I and what can this token do?
rp GET /me | jq .

# Read-only queries
rp GET '/products?limit=20' | jq '.data[] | {slug, status, majors}'
rp GET '/customers?q=example.com' | jq '.data[] | {id, display_name, entitlements}'
rp GET '/customers/cus_…/entitlements' | jq '.data[] | {license_id, product_slug, edition, term_type, expires_at, status}'

# Create a product, a major bound to the v1 protocol, a shipped minimum release and edition policies
rp POST /products '{"slug":"newapp","name":"NewApp"}' | jq '{id, slug}'
rp PATCH /products/newapp '{"status":"active"}' >/dev/null
MAJOR=$(rp POST /majors '{"productId":"newapp","majorVersion":1,"protocolId":"repass-v1"}' | jq -r .id)
rp PATCH /majors/$MAJOR '{"status":"active"}' >/dev/null
rp POST /majors/$MAJOR/releases '{"version":"1.0.0","status":"shipped","isMinimumSupported":true}' >/dev/null
EP=$(rp PUT /majors/$MAJOR/edition-policies/enterprise '{"displayName":"Enterprise","activationModel":"none","ownership":"organisation"}' | jq -r .id)

# Create an offer and its prices in EVERY store currency (minor units; JPY in whole yen).
# Prices live only in the database; GST is added on top of the AUD price at checkout.
OFFER=$(rp POST /offers "{\"sku\":\"newapp1-ent\",\"name\":\"NewApp 1 Enterprise\",\"kind\":\"single\",\"billing\":\"one_time\",\"components\":[{\"editionPolicyId\":\"$EP\",\"termType\":\"perpetual\"}]}" | jq -r .id)
rp POST /offers/$OFFER/prices '{"prices":[
  {"currency":"AUD","unitAmount":49900,"taxRatePercent":10,"taxLabel":"GST"},
  {"currency":"USD","unitAmount":32900},{"currency":"EUR","unitAmount":30900},{"currency":"GBP","unitAmount":26900},
  {"currency":"CAD","unitAmount":44900},{"currency":"NZD","unitAmount":54900},{"currency":"SGD","unitAmount":43900},
  {"currency":"HKD","unitAmount":256900},{"currency":"JPY","unitAmount":49800},{"currency":"CNY","unitAmount":236900},
  {"currency":"CHF","unitAmount":28900}]}' | jq '.missingCurrencies'
# Link the Stripe product you created in Stripe (name, description, image). Unlinked offers get one at first checkout.
rp PUT /offers/$OFFER/stripe-product '{"stripeProductId":"prod_…"}' | jq '{sku, stripeProductId, stripeProductName}'
# Or import many offers from the catalogue CSV (only _ls:import = yes rows): upload + preview, review, then apply.
#   npm run catalogue:import -- stripe-catalogue/products.csv        # prints the import id
#   npm run catalogue:import -- --apply-id imp_…
# (see stripe-catalogue/README-LICENSE-SERVER.md)
rp POST /offers/$OFFER/status '{"status":"active"}' | jq '{sku, status}'

# Issue (grant) an entitlement — the activation key is returned ONCE
rp POST /entitlements/grants '{"customerId":"cus_…","offerSku":"newapp1-ent","reason":"partner licence"}' | jq '.entitlements[] | {licenseId, activationKey}'

# Revoke / un-revoke (destructive: repeat the id in "confirm"), re-issue with the same licence id
rp POST /licenses/lic_…/revoke '{"reason":"chargeback","confirm":"lic_…"}' | jq .
rp POST /licenses/lic_…/unrevoke '{"reason":"dispute won","confirm":"lic_…"}' | jq .
rp POST /licenses/lic_…/reissue '{"reason":"organisation renamed","organisationName":"New Name Pty Ltd"}' | jq '.envelope.signatures[].keyId'

# Paid invoices of a customer, and one as PDF
rp GET /customers/cus_…/invoices | jq '.data[] | {id, number, total, currency, issued_at}'
rp GET /invoices/cin_….pdf '' -o invoice.pdf   # '' = no JSON body; extra args go to curl

# Failed webhooks, dead jobs, email outbox
rp GET '/webhooks/stripe/events?status=failed' | jq '.data[] | {id, type, attempts, last_error}'
rp POST /webhooks/stripe/events/evt_…/replay | jq .
rp GET '/jobs?status=dead' | jq '.data[] | {id, kind, attempts, last_error}'
rp GET '/email/outbox?status=dead' | jq '.data[] | {id, template_key, last_error}'
rp POST /email/retry '{"id":"eml_…"}' | jq .
rp GET /system/health | jq .
```

## 4. Rotate or revoke your token

```zsh
OLD_ID=$(rp GET /tokens | jq -r '.data[] | select(.revoked_at==null and .name=="laptop") | .id')
# Rotation of a personal token is done in the UI (Access → Rotate). For a service token (tokens:manage):
NEW=$(rp POST /tokens/$OLD_ID/rotate '{}' | jq -r .token)
security add-generic-password -U -a "$USER" -s repass-admin-pat -w "$NEW"; unset NEW
# Revoke (own token, or any with tokens:manage):
rp POST /tokens/$OLD_ID/revoke '{"reason":"laptop retired"}' | jq .
```

## 5. Service accounts for automation

A super administrator (`admins:manage`) creates a service account with a **scope ceiling**. A holder of `tokens:manage` mints tokens for it, inside that ceiling, with an expiry and optionally a CIDR allowlist. Store the token in your CI's secret store, never in the repository. Every call is audited with the token ID and owner; review it with `rp GET '/audit?actorId=tok_…'`.

## 6. Errors

Errors take the form `{"error":{"code","message","details?"},"requestId"}`, with standard HTTP status codes (401 invalid/expired/revoked token, 403 missing scope/CIDR, 409 conflict or reused idempotency key, 412 precondition such as a missing `confirm`, 422 validation or protocol incompatibility, 429 per-token rate limit with `Retry-After`). If you retry with the same `Idempotency-Key`, you get the original response, with the header `Idempotent-Replayed: true`.
