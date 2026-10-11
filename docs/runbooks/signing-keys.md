# Signing keys, KEK custody, rotation and compromise

See [ADR-0003](../adr/0003-signing-keys-and-trust-boundary.md) for the design and the honest trust boundary.

## What lives where

| Item | Location | Backed up by |
|---|---|---|
| Public keys and metadata | `signing_keys` (PostgreSQL) | Database backups |
| Encrypted private keys (AES-256-GCM: ciphertext, nonce, tag, KEK version) | `signing_key_secrets` (PostgreSQL) | Database backups |
| KEK `SIGNING_KEK_V<n>` (32 bytes) | Cloudflare Workers Secret (+ your offline escrow) | **Separately**, offline. Never with database dumps |

A database backup without the KEK cannot sign. A KEK without the database is useless. **Keep them apart.**

## KEK escrow (do this once per KEK version)

1. Generate the KEK in the Keychain: `security add-generic-password -a "$USER" -s repass-signing-kek-v1 -w "$(openssl rand -base64 32)"`.
2. Escrow it offline, for example a sealed printout or an encrypted USB drive in a safe, split between two custodians if possible (or use a password manager vault with recovery). Record the version number and creation date, never the value, in your asset register.
3. Load it into each environment: `security find-generic-password -a "$USER" -s repass-signing-kek-v1 -w | npx wrangler secret put SIGNING_KEK_V1 --env production`.
4. **Recovery drill** (quarterly): restore the latest dump into a scratch database, set the escrowed KEK, and run `npm test -- tests/integration/key-portability.test.ts` against it (or call `/readyz` and perform a test issuance in staging).

## Annual key rotation (per algorithm)

1. **Generate:** Admin → Signing keys → Generate (`repass-ed25519-2027`, `repass-mldsa65-2027`). This needs `signing_keys:manage` plus a TOTP step-up. Nothing changes for issuance yet.
2. **Publish:** mark the key published and export the public keys (`/admin/keys/export`, or `GET /api/admin/v1/signing-keys/trusted-export`). Hand them to each application team, who add them to the application's trusted-key list (CurseDelete: `crates/cursdel-policy/src/lib.rs` `TRUSTED_KEYS`).
3. **Record trust:** for each product major, set `trustedSinceVersion` to the first release embedding the key.
4. **Raise the minimum supported release** for the major once that release (or later) is the oldest one supported. Eligibility requires the minimum supported release to trust the key. This stops the server issuing licences that older, still-supported builds would reject.
5. **Mark eligible.** From then on, every licence is signed with all eligible keys (≤ 8), for example the 2026 and 2027 keys together during migration.
6. **Retire the old key** when no supported release *only* trusts the old one. Retiring is refused if it would leave a major with no eligible key, unless you force it. Retired keys stay stored, so historical licences keep verifying in clients.

## KEK rotation (re-encrypt; key IDs unchanged)

```zsh
security add-generic-password -a "$USER" -s repass-signing-kek-v2 -w "$(openssl rand -base64 32)"
security find-generic-password -a "$USER" -s repass-signing-kek-v2 -w | npx wrangler secret put SIGNING_KEK_V2 --env production
# set SIGNING_KEK_ACTIVE_VERSION = "2" in wrangler.jsonc (env.production.vars) and deploy
rp POST /signing-keys/rewrap '{"toVersion":2}' | jq .     # repeat until "remaining": 0 (batches of 20)
# once remaining is 0 and a test issuance succeeds:
npx wrangler secret delete SIGNING_KEK_V1 --env production
```

Escrow V2 before deleting V1. Each rewrap is audited (`key_lifecycle_events`, `audit_events`).

## Importing existing keys (restricted)

Only through the operator CLI. The 32-byte private encoding is read from stdin and the public key is derived from it:

```zsh
security find-generic-password -a "$USER" -s repass-key-import -w | \
  DATABASE_URL="$(security find-generic-password -a "$USER" -s repass-db-owner-url -w)" \
  SIGNING_KEK_V1="$(security find-generic-password -a "$USER" -s repass-signing-kek-v1 -w)" \
  npm run keys:import -- --key-id repass-ed25519-2026 --algorithm Ed25519
security delete-generic-password -a "$USER" -s repass-key-import
```

## Incident: signing key suspected compromised

1. **Contain:** Admin → Signing keys → *Retire / compromise* → tick **COMPROMISED**, enter the reason, and confirm with the key ID. The key becomes ineligible for every product immediately and the action is audited. If it was the only eligible key for a major, issuance for that major fails closed (503) until a replacement is eligible. This is intended.
2. **Replace:** generate a new key per affected algorithm and fast-track a client release that trusts it (and, where possible, *drops* the compromised key). Mark the new key eligible once that release is the minimum supported.
3. **Assess:** licences signed with the compromised key can now be forged by the attacker for any client that still trusts it. Clients cannot be told remotely. Communicate with application teams and customers as needed. Review `license_issuances` and `audit_events` for unexpected issuance.
4. **Root cause:** if the KEK may have leaked too, rotate the KEK (above) and the peppers (operations runbook). Review Cloudflare account access and Workers Secrets audit logs.

## Incident: KEK lost (all copies)

Existing licences keep verifying, since clients only need public keys. But the server can no longer sign with those keys. Generate new keys, ship client releases that trust them, and mark them eligible. Until then, issuance and renewal for the affected majors returns 503. Prevent this by escrowing the KEK offline.
