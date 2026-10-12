# ADR-0003: Signing keys in PostgreSQL and the trust boundary

- **Status:** Accepted · 2026-10-11

## Decision

- `signing_keys` holds the key ID (globally unique, immutable, never reused), algorithm, raw public key, fingerprint, status and origin.
  `signing_key_secrets` holds only `ciphertext`, `nonce` (12 bytes), `tag` (16 bytes), `kek_version` and `private_format`. The two tables are separate so grants can restrict them separately.
- Private keys are stored in **portable 32-byte encodings** (Ed25519 seed, P-256 scalar d, ML-DSA-65 seed ξ). Any conforming library can re-import them, so a `pg_dump` taken anywhere can be restored anywhere.
- The private key is encrypted **in the Worker before storage** with AES-256-GCM under `SIGNING_KEK_V<n>`, a 32-byte Workers Secret. The associated data binds each ciphertext to `keyId|algorithm|format|kekVersion`, so a ciphertext copied to another row fails to decrypt.
- Decryption happens only in `loadSigners()`, into **non-extractable** `CryptoKey`s cached per isolate. The cache is bound to the KEK material fingerprint and the ciphertext digest. A test found and fixed a bug where a wrong KEK could reuse a cached key.
- There is no API, UI or scope that returns private material. Import of existing keys is an operator CLI that reads stdin only. Generation is an admin action (`signing_keys:manage`, step-up MFA) and changes nothing about issuance until the key is published, trusted by the **minimum supported shipped release**, and marked eligible.
- Issuance signs with **every** effectively eligible key, up to the protocol limit (8 for v1). If no key is eligible, the operation fails closed (503) and the seat is rolled back.
- KEK rotation rewraps the secrets under `SIGNING_KEK_V<n+1>` in bounded batches without changing key IDs. The old KEK version can then be removed (tested).

## Trust boundary (honest statement)

This is **application-level envelope encryption, not an HSM or KMS.** Anyone who holds both a database dump and the KEK can recover the signing keys. Anyone who can execute code in the Worker can sign. Workers have no KMS that supports Ed25519 or ML-DSA-65 signing today. If such a service becomes available, `loadSigners()`/`sign()` is the single seam to replace. Database-level encryption and TLS are not substitutes and are not relied on.

## Consequences

- The KEK must be backed up **separately** from database backups (see `docs/runbooks/signing-keys.md`). Losing every copy of the KEK means losing the ability to sign with those keys. Existing licences still verify, but the affected product majors need new keys shipped in new client releases.
- Compromise response: mark the key `compromised`, which makes it ineligible everywhere immediately; generate and ship a replacement; and treat licences signed by it as forgeable by the attacker.
