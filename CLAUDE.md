# CLAUDE.md: working on the RePassCloud license server

TypeScript Cloudflare Worker (Hono) + PostgreSQL (postgres.js via Hyperdrive) + Stripe + MailerSend.
Start with `README.md`, `docs/architecture.md`, `docs/STATUS.md` and the ADRs in `docs/adr/`.

## Non-negotiables

- **The `repass-*-v1` wire contract is binding** (`docs/requirements/upstream/LICENSING-SERVER-BRIEF.md`). Never change claims,
  envelope fields, signed bytes, error codes or the three `/v1/*` endpoints. New behaviour needs a new protocol in
  `src/domain/protocols.ts`, plus tests and a client conformance run (ADR-0001).
- **PostgreSQL is the master** for catalogue, prices, policies, keys and state. Stripe IDs are mappings. No D1.
- **Never** return, log or audit private keys, activation keys, client secrets, API tokens, session or link tokens, raw IPs
  or email addresses in licences. Private keys stay encrypted (AES-GCM under `SIGNING_KEK_V<n>`) except inside `loadSigners()`.
- Every mutation goes through a service function that takes an `Actor`, checks permissions and writes `audit_events`. The admin UI and
  the admin API must call the same services. Do not add SQL shortcuts in route handlers.
- Money is integer minor units. Price versions are immutable (DB trigger). Entitlements carry frozen policy snapshots.
- Stripe products: linked by `prod_…` (CSV import / admin link) or created once by `ensureStripeProduct` at first checkout;
  never renamed or archived by the server. The CSV import (`catalogue-import.ts`) reports CSV/DB/Stripe conflicts and never
  resolves them; keep preview side-effect free and apply going through the catalogue services.
- Keep `/v1/*` cheap: no zod and no full-app imports on that path (Workers Free 10 ms CPU). Measure with `npm run bench`.
- `src/` must run under Node's type stripping: no TS parameter properties or enums; imports use `.ts` extensions.

## Commands

`npm run typecheck` · `npm run lint` · `npm test` (real PostgreSQL via initdb or `TEST_DATABASE_URL`) ·
`npm run test:workers` (workerd) · `CURSEDELETE_CONFORMANCE_BIN=… npm run test:contract` · `npm run build` · `npm run openapi`
(commit the regenerated `docs/api/openapi.json`) · `npm run secrets:scan`.

## Database changes

Add a new `migrations/NNNN_name.sql`. Never edit an applied migration (the runner verifies checksums). Re-check `sql/roles.sql` grants for
new tables. Arrays: pass JSON and expand with `jsonb_array_elements_text` (see `textArray()`), because `fetch_types:false` disables array typing.

## Local secrets

`.dev.vars` (gitignored) per `.dev.vars.example`. The legacy root `.env` / `.env.prod` contain old real credentials: never read,
print or commit them. `npm run dev` disables wrangler's `.env` auto-loading on purpose.
