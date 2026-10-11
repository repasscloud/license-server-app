# RePassCloud License Server

RePassCloud's licensing and commerce platform. It is a multi-product, multi-version, data-driven system that runs as **one Cloudflare Worker** (Workers Free plan). Production URL: `https://license-server.repasscloud.com`.

- **PostgreSQL (Supabase-hosted, provider-portable)** is the source of truth. It holds every product, major version, edition policy, offer, price, entitlement, licence, activation, the signing-key registry, the job outbox and the audit log.
- **Stripe** handles checkout, billing, and payment and subscription events. Stripe Products and Prices are *mappings* created from the database. Stripe is never the catalogue.
- **MailerSend** delivers transactional email through a durable, encrypted outbox.
- **Wire compatibility:** the binding `repass-license-v1` / `repass-activation-v1` contract is implemented exactly (`docs/requirements/upstream/LICENSING-SERVER-BRIEF.md`). It is verified against the official test vectors and against **CurseDelete's real client verifier**.

> **Current status, blockers and test evidence:** [`docs/STATUS.md`](docs/STATUS.md). Read it before deploying.

## What it serves

| Path | What | Authentication |
| --- | --- | --- |
| `POST /v1/activations`, `POST /v1/licenses/{id}/renew`, `POST /v1/activations/{id}/deactivate` | Binding machine API (brief §5) | Activation key / per-activation client secret |
| `/api/admin/v1/*` | Scriptable admin REST API ([OpenAPI 3.1](docs/api/openapi.json)) | Bearer PAT `rpl_pat_…` or service token `rpl_svc_…` only. No cookies, no browser |
| `/admin/*` | Administrator portal | Email link + mandatory TOTP; step-up for high-risk actions |
| `/portal/*` | Customer portal | Passwordless email link |
| `/store`, `/checkout/*` | Storefront and DB-priced Stripe Checkout | Public |
| `POST /webhooks/stripe`, `POST /webhooks/mailersend` | Provider webhooks | Signature verified on the raw body |
| Cron `*/2 * * * *`, `17 3 * * *` | Jobs, email, reconciliation, drift checks, retention | — |

## Quick start (macOS, zsh)

Prerequisites: Node 24+, PostgreSQL 15+ (`brew install postgresql@18`). Rust (`cargo`) is optional, for the conformance checker.

```zsh
npm ci

# 1. A local database plus the least-privilege runtime role.
createdb repass_dev
export DATABASE_URL=postgres://$USER@127.0.0.1:5432/repass_dev          # owner/migration role
npm run db:migrate
psql "$DATABASE_URL" -v runtime_password=devonly -f sql/roles.sql

# 2. Local secrets (gitignored). Each one is 32 random bytes.
cp .dev.vars.example .dev.vars
for k in SIGNING_KEK_V1 APP_DATA_KEY_V1 MACHINE_PEPPER AUTH_PEPPER API_TOKEN_PEPPER; do
  sed -i '' "s|^$k=.*|$k=$(openssl rand -base64 32)|" .dev.vars
done

# 3. Development fixtures (PUBLIC test-vector keys) and the first admin (prints a TOTP URI once).
set -a; source .dev.vars; set +a
npm run db:seed:dev
npm run admin:bootstrap -- --email you@example.com --name "You"

# 4. Run the Worker locally (workerd) against the database through the Hyperdrive binding.
export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgres://repass_runtime:devonly@127.0.0.1:5432/repass_dev
npm run dev        # http://localhost:8787  (/admin, /portal, /store)
```

Locally, mail is **captured and printed to the dev console, not delivered** (`MAIL_TRANSPORT=capture`). Staging and production refuse capture mode. For a full Stripe test-mode loop, run `stripe listen --forward-to localhost:8787/webhooks/stripe` and put the printed `whsec_…` in `.dev.vars`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Worker in workerd (`wrangler dev`; `.env` auto-loading disabled) |
| `npm run typecheck` | Generate runtime types, then typecheck the Worker and Node programs |
| `npm run lint` | ESLint |
| `npm test` | Unit, contract and integration tests on a **real** throwaway PostgreSQL |
| `npm run test:contract` | v1 vectors plus the CurseDelete conformance checker (`CURSEDELETE_CONFORMANCE_BIN`) |
| `npm run test:workers` | The real bundle in workerd via `wrangler dev`, with PostgreSQL over the Hyperdrive binding |
| `npm run bench` | CPU-time evidence for the Free 10 ms budget → `docs/perf/cpu-latest.json` |
| `npm run build` | Package the Worker (`wrangler deploy --dry-run`) |
| `npm run db:migrate` | Apply SQL migrations (direct connection, owner role; never at Worker startup) |
| `npm run admin:bootstrap` | One-time first super administrator with offline TOTP enrolment |
| `npm run keys:import` | Restricted import of an existing private signing key (reads stdin) |
| `npm run openapi` | Regenerate `docs/api/openapi.json` |
| `npm run secrets:scan` | Secret scan over tracked files (CI) |
| `npm run deploy` | `wrangler deploy --env production` (use the manual GitHub workflow instead) |

Tests create their own PostgreSQL cluster with `initdb`, or use `TEST_DATABASE_URL`. They never call real Stripe or MailerSend: the commerce suite uses clearly labelled test doubles.

## Documentation

- Architecture: [`docs/architecture.md`](docs/architecture.md) · decisions: [`docs/adr/`](docs/adr/)
- Onboarding a product, major, edition, offer or price: [`docs/product-onboarding.md`](docs/product-onboarding.md)
- Deployment (Cloudflare, Supabase, Hyperdrive, Stripe, MailerSend, DNS, secrets, CI): [`docs/runbooks/deployment.md`](docs/runbooks/deployment.md)
- Terminal admin API with curl + jq + macOS Keychain: [`docs/runbooks/terminal-admin-api.md`](docs/runbooks/terminal-admin-api.md)
- Signing keys, KEK backup and rotation, compromise: [`docs/runbooks/signing-keys.md`](docs/runbooks/signing-keys.md)
- Backups, restore drills, moving PostgreSQL provider: [`docs/runbooks/backup-and-provider-migration.md`](docs/runbooks/backup-and-provider-migration.md)
- Day-2 operations (webhooks, reconciliation, email, tokens, incidents, retention, limits): [`docs/runbooks/operations.md`](docs/runbooks/operations.md)
- Requirements: [`docs/requirements/`](docs/requirements/). The legacy .NET proof of concept is archived in git history (`a8e2602`), with its rationale in [`docs/archive/legacy-dotnet/`](docs/archive/legacy-dotnet/).

## Licence

[Apache-2.0](LICENSE).
