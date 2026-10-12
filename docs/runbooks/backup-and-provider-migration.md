# Backups, restore drills, and moving PostgreSQL providers

The schema is plain PostgreSQL (≥ 15). It needs no extensions and no Supabase features, so moving providers means **dump → restore → re-point Hyperdrive**. Business code does not change.

## Backups

1. **Provider backups:** enable Supabase daily backups or PITR to match your plan.
2. **Independent logical backups** (recommended daily, encrypted, stored off-provider):

   ```zsh
   OWNER_URL="$(security find-generic-password -a "$USER" -s repass-db-owner-url -w)"
   pg_dump --format=custom --no-owner --no-privileges --file "repass-$(date -u +%Y%m%dT%H%M%SZ).dump" "$OWNER_URL"
   unset OWNER_URL
   # encrypt before it leaves the machine, e.g. age/gpg; never store it next to the KEK escrow
   ```

   Use a `pg_dump` at least as new as the server's major version (PostgreSQL 18 client for a PostgreSQL 18 server). The dump contains customer personal data and encrypted (not plaintext) signing keys, so treat it as confidential.

## Restore drill (quarterly)

```zsh
createdb repass_restore_drill
pg_restore --no-owner --dbname repass_restore_drill repass-<timestamp>.dump
psql repass_restore_drill -v runtime_password=drill -f sql/roles.sql
psql repass_restore_drill -c "SELECT version, checksum FROM schema_migrations ORDER BY version"
psql repass_restore_drill -c "SELECT id, algorithm, status, fingerprint FROM signing_keys ORDER BY id"
```

Then confirm signing works with the escrowed KEK. The automated version of this drill is `tests/integration/key-portability.test.ts`: dump, restore, sign, wrong KEK, rewrap.

## Moving to another PostgreSQL host

1. **Prepare the target:** PostgreSQL ≥ 15, TLS required, an owner role, and network reachability from Hyperdrive (IPv4 or IPv6, port 5432).
2. **Freeze writes** (maintenance window): either deploy a build that returns 503 for mutations, or accept that the final dump defines the cutover point. Stripe keeps retrying webhooks for up to 3 days, so events queued in Stripe are not lost while the server is unavailable.
3. **Dump the source** with `pg_dump --format=custom --no-owner --no-privileges` (as above).
4. **Restore to the target:** `pg_restore --no-owner --dbname <target-owner-url> <dump>`, then run `sql/roles.sql` with a **new** runtime password.
5. **Verify:**

   ```zsh
   for t in products product_majors offers price_versions customers entitlements licenses activations signing_keys signing_key_secrets audit_events stripe_events; do
     printf '%-24s src=%s dst=%s\n' $t \
       "$(psql -Atc "select count(*) from $t" "$SRC")" "$(psql -Atc "select count(*) from $t" "$DST")"
   done
   psql -Atc "select md5(string_agg(id||fingerprint||encode(public_key,'hex'), ',' order by id)) from signing_keys" "$SRC"
   psql -Atc "select md5(string_agg(id||fingerprint||encode(public_key,'hex'), ',' order by id)) from signing_keys" "$DST"
   psql -Atc "select md5(string_agg(signing_key_id||encode(ciphertext,'hex')||kek_version, ',' order by signing_key_id)) from signing_key_secrets" "$SRC"   # compare with DST
   ```

6. **Re-point Hyperdrive** (the KEK is unchanged and must be the same Workers Secret):

   ```zsh
   npx wrangler hyperdrive update <hyperdrive-id> --connection-string="postgres://repass_runtime:<new-pw>@<new-host>:5432/<db>" --caching-disabled
   ```

7. **Smoke test:** `/readyz`; a staging or test issuance; `POST /v1/licenses/<known lic>/renew` from a test client; an admin API `GET /me`.
8. **Unfreeze**, then watch Stripe webhook deliveries and `GET /api/admin/v1/system/health`. Run `POST /webhooks/reconcile {"kind":"backfill"}` for the window.

**Rollback:** point Hyperdrive back at the source (which is still intact, since nothing was written to it after the freeze) and redeploy the previous Worker if needed.
