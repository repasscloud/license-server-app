# Implementation status (2026-10-11)

This document is **evidence-based**. "Done" means implemented **and** exercised by the tests listed. "Not verified" means implemented, but it cannot be proven without the owner's accounts. Nothing has been deployed, charged or emailed for real.

## Verification run (this commit)

| Check | Result |
| --- | --- |
| `npm run secrets:scan` | clean (119 tracked files) |
| `npm run lint` | clean |
| `npm run typecheck` (Worker program + Node program) | clean |
| Unit + contract (`tests/unit/core`, `tests/contract/v1-vectors`) | **24 + 10 passed** |
| Integration on **real PostgreSQL 18** | machine API **14**, commerce E2E **27**, admin UI **8**, key portability **6**: all passed (includes the 12-way concurrent seat race) |
| **CurseDelete real client verifier** (`cursedelete-2@3ce9526`, `cargo … --example conformance`) | **10/10 passed**: every edition accepted (triple-signed and single-algorithm); wrong product, wrong major, tampered payload, non-perpetual Enterprise, seatless Business, unknown field and wrong-device certificate all rejected |
| **workerd** (`wrangler dev`, real bundle, Hyperdrive local binding, least-privilege DB role) | **6/6 passed**, including native ML-DSA-65 + Ed25519 signatures verified |
| Total | **105 passed, 1 skipped** (the "blocked" placeholder that runs only when the conformance binary is absent) |
| Worker packaging (`wrangler deploy --dry-run`) | 1.53 MB / **273 KiB gzip** |
| Terminal docs (`docs/runbooks/terminal-admin-api.md`) | Run verbatim with zsh against the Worker in workerd. Found and fixed two zsh bugs in the docs and one API inconsistency. |
| Operator scripts (`db:migrate` ×2, `db:seed:dev`, `admin:bootstrap` ×2) | Work against a fresh PostgreSQL. Migrations are idempotent and bootstrap refuses a second super admin. |

Reproduce with `npm run secrets:scan && npm run lint && npm run typecheck && npm test && CURSEDELETE_CONFORMANCE_BIN=… npm run test:contract && npm run test:workers && npm run build`.

## Workers Free viability (measured, not assumed)

`docs/perf/cpu-latest.json` (Apple M2 Pro, Node 26, the same request code path, CPU via `process.cpuUsage`; database wait excluded, as on Workers):

| Path | Warm p50 | Warm p95 | First request in a fresh isolate |
| --- | --- | --- | --- |
| `POST /v1/activations` Business, new device (licence + certificate; Ed25519 + ML-DSA-65; seat transaction) | 0.84 ms | 4.3 ms | **~21 ms** |
| `POST /v1/activations` Enterprise provisioning | 0.63 ms | 1.8 ms | 0.6 ms |
| `POST /v1/licenses/{id}/renew` | 1.1 ms | 4.8 ms | 3.4 ms |
| Admin API `GET /products` | 1.0 ms | 1.9 ms | ~23 ms (lazy-loads the full app) |
| ML-DSA-65 sign / Ed25519 sign / P-256 sign | 0.43 / 0.04 / 0.03 ms | | |

- Warm traffic fits comfortably within **10 ms of CPU**.
- **Cold first requests (~20 ms)** are dominated by V8's first-time compilation. They depend on Cloudflare's documented per-isolate flexibility for *infrequent* overruns. A risk remains: if production telemetry shows `exceededCpu` outcomes more than occasionally, the least invasive fix is **Workers Paid** (no code change). That spend needs the owner's approval. **Not verified in production.**
- Hyperdrive Free (100k queries/day): measured 12 / 11 / 9 SQL statements for activation / re-activation / renew, which budgets roughly 7–8k machine operations/day after cron overhead. See [`runbooks/operations.md`](runbooks/operations.md#free-plan-limits).
- No paid Cloudflare products are used.

## Definition of Done

| Item | Status |
| --- | --- |
| Old .NET implementation replaced by a native TypeScript Worker | **Done.** Legacy removed from the tree (history `a8e2602`); rationale archived. |
| Runs under Workers Free constraints, or a disclosed blocker | **Done with disclosed risk:** warm well under 10 ms; cold ~20 ms per new isolate (see above). |
| Only public domain `license-server.repasscloud.com`; preview/version exposure addressed | **Configured** (`custom_domain`, `workers_dev:false`, `preview_urls:false` in every environment). **Not verified:** requires the first real deploy and the dashboard checklist in the deployment runbook. |
| PostgreSQL is the catalogue, licensing and key store; no D1 | **Done** |
| Products, prices, offers, currencies, terms, policies and Stripe IDs in PostgreSQL, admin-editable without redeploy | **Done** (E2E onboards two products, offers, bundle and prices via the PAT API) |
| Catalogue CSV import (preview → confirm → apply; Stripe-first linking, PostgreSQL-first with checkout-time Stripe products; conflicts reported, never resolved) | **Implemented and tested against a Stripe test double** (`tests/integration/catalogue-import.test.ts`, including the real `stripe-catalogue/products.csv`). **Not verified** against real Stripe test mode. Stripe Search (used to prevent duplicates) must be available on the account. |
| Per-product configurable editions, terms and activation policies | **Done**, validated per protocol (ADR-0001; product A–D policy tests) |
| `repass-*-v1` compatibility; incompatible options gated | **Done**: official vectors, byte-exact Ed25519, real-client verifier; protocol registry refuses incompatible offers |
| Server-created, DB-priced Stripe Checkout; verified webhooks; subscription extension | **Implemented and tested against a Stripe test double.** **Not verified** against real Stripe test mode (no account access). |
| MailerSend email with durable retry and failure visibility | **Implemented and tested against a MailerSend test double** (429/5xx/timeout/suppression). **Not verified** against the real API. |
| Three algorithms; encrypted keys in PostgreSQL; separate KEK; key/DB migration tested | **Done** (pg_dump/pg_restore, wrong KEK, rewrap, transplant tests) |
| Customer login and portal, with isolation | **Done** (magic link; cross-customer 404; CSRF/Origin; realm separation tests) |
| Administrator login and portal with permissions | **Done** (email link + TOTP enrolment, step-up, all sections render, UI mutations audited) |
| Scoped admin REST API with PATs and service accounts, no browser | **Done** (scopes ∩ role, revoke/expire/CIDR/rotate/idempotency tests; documented curl+jq+Keychain flow executed) |
| Licensing, activation, seat/transfer, renewal, revocation, bundle and Stripe cases | **Done** (§15.2 acceptance list fully covered) |
| Migrations, tests, OpenAPI, CI, Cloudflare config, ops docs, onboarding, security runbooks | **Done.** CI has never run on GitHub (it is defined, not executed). |
| No mock routes, inert buttons, hardcoded production secrets, retired formats or hidden paid dependencies | **Done.** Test doubles live only under `tests/`; dev mail capture is labelled and refused in staging/production. |

## Known limitations and deliberate non-features

- **Signing keys are decrypted inside the Worker.** This is application-level envelope encryption, **not** an HSM/KMS (ADR-0003).
- **Admin MFA is TOTP.** Passkeys/WebAuthn and dual approval for key operations are not implemented (ADR-0004). Cloudflare Access in front of `/admin*` is recommended.
- **Prices exist only in PostgreSQL.** Checkout sends the amount inline (`price_data`) against the Stripe Product linked to the offer; no Stripe Price objects are created or synced. Products are normally created in Stripe first (stripe-catalogue script) and linked by `prod_…` ID through the CSV import or the admin portal; an offer never linked gets its product created once at its first checkout. The server never renames or archives Stripe products. An offer sells only when all 11 store currencies (AUD USD EUR GBP CAD NZD SGD HKD JPY CNY CHF) have an active price.
- **Invoices** are the server's own numbered "Paid" PDFs (purchase and each renewal charge), emailed and downloadable. They use the standard Helvetica font: characters outside Western European Latin (e.g. CJK names) print as "?". Dates are UTC. Numbers come from a sequence and are not guaranteed gap-free. Seller name/ABN come from `INVOICE_SELLER_*` in `wrangler.jsonc`; confirm them, and your GST registration, before live sales.
- **Stripe API version is pinned to `2026-09-30.endive`** (reviewed against the endive changelog; see ADR-0005). It is still unverified against real Stripe until the test-mode purchase.
- **The MailerSend message-ID location is ambiguous in their docs.** Both documented paths are accepted. Delivery tracking exists only if the webhook secret is configured.
- **Uncertain email sends** (timeouts) are not resent automatically; an operator resolves them.
- **Hyperdrive caching must be disabled** on the configuration (deployment runbook). The code cannot enforce this.
- **Renewing an expired subscription returns `subscription_expired`** rather than re-signing an invalid file (ADR-0001 §4).
- **Admin notifications** (email to operators about dead jobs and similar) are not implemented. Operational state is visible in the admin overview and `/system/health`.
- **Legal and tax:** no GST, privacy or consumer-law compliance is claimed. Stripe Tax configuration and legal review are owner actions.
- The CI action `actions/setup-node@v5` is referenced by tag; pin it to a SHA (marked TODO).

## Owner actions required (in order)

0. After pulling the store/invoice update: `npm run db:migrate` (migrations 0004 and 0005), then re-run `sql/roles.sql` (new tables and the invoice number sequence).

1. Create the Supabase project. Run migrations and `sql/roles.sql`. Revoke `anon`/`authenticated` grants.
2. Create Hyperdrive configurations **with `--caching-disabled`** and put their IDs in `wrangler.jsonc`.
3. Generate and escrow `SIGNING_KEK_V1` (offline, separately from backups). Load all secrets with `wrangler secret put` per environment.
4. Deploy to staging, then production via the manual workflow. Confirm custom domain only, `workers.dev` disabled, Preview URLs disabled.
5. Run `admin:bootstrap` for the first super administrator.
6. Generate, publish and hand over signing keys. Record trust and mark them eligible once the client release that trusts them is the minimum supported.
7. Stripe: test-mode webhook endpoint (events listed in the deployment runbook, API version `2026-09-30.endive`), Customer Portal, Stripe Tax if used. Run a **real test-mode purchase end to end** to close the "not verified" rows above.
8. MailerSend: verify the domain, create a scoped token, and optionally the delivery webhook. Send a real test email (portal login) to close the email row.
9. Watch Workers Logs `cpuTime` / `exceededCpu` for a week and decide on Workers Paid only if needed.
10. Pin the CI `setup-node` action to a SHA, enable branch protection, and add reviewers to the `production` environment.

The repository's untracked legacy `.env` / `.env.prod` files contain real legacy credentials. They are git-ignored and `wrangler dev` is configured not to load them. Rotate any credentials in them that are still live, and delete the files when convenient (owner decision).
