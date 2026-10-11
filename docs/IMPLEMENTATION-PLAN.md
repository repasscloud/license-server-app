# Rewrite implementation checklist

Branch: `rewrite/cloudflare-workers`. Legacy .NET checkpoint: commit `a8e2602` (also `main`).
Requirements: `docs/requirements/REWRITE-MANDATE.md`. Binding wire contract:
`docs/requirements/upstream/LICENSING-SERVER-BRIEF.md`.

Status legend: `[x]` implemented and tested, `[~]` implemented with a documented limitation,
`[ ]` not done. The final status is in `docs/STATUS.md`.

1. [x] Read the repository, the brief and the architecture. Pin copies under `docs/requirements/upstream/`.
2. [x] ADR-0001 conflict resolution (generic policy vs v1).
3. [x] Remove the legacy .NET/Blazor/Docker/Caddy tree from the active app. Archive its rationale
   docs under `docs/archive/legacy-dotnet/`.
4. [ ] Foundation: package, tsconfig, wrangler, lint, vitest, real-PostgreSQL test harness.
5. [ ] SQL migrations: catalogue, policy, billing, licensing, keys, auth, mail, jobs, audit. Add a migration runner.
6. [ ] Crypto: base64url, v1 envelope, Ed25519 / ECDSA-P256 (P1363) / ML-DSA-65 (pure, empty context),
   official vectors, AES-256-GCM KEK wrapping, KEK rotation.
7. [ ] Signing-key registry: generate, list, publish, compatibility/eligibility, retire, compromise, rewrap.
8. [ ] Policy engine, protocol registry (repass-v1), offer validation, policy snapshots.
9. [ ] Licensing: entitlement issuance, licence signing/re-signing, activation keys, revocation.
10. [ ] Machine API `/v1/*` with transactional seat/transfer enforcement and rate limiting.
11. [ ] Auth: customer magic link, admin magic link + TOTP, sessions, CSRF, PATs, service accounts, scopes.
12. [ ] Catalogue services: products, majors, releases, edition policies, offers, components, bundles, price versions.
13. [ ] Stripe: REST adapter, catalogue sync/drift, server-created Checkout, webhook verify/inbox,
    lifecycle processing, reconciliation.
14. [ ] MailerSend: adapter, DB templates, outbox, retry/backoff, webhook.
15. [ ] Jobs: cron drain, bounded batches, dead letters.
16. [ ] Admin REST API `/api/admin/v1` and OpenAPI 3.1.
17. [ ] Customer portal `/portal` and admin portal `/admin` (server-rendered).
18. [ ] Tests: unit, contract (vectors, conformance tool), integration, concurrency, security, e2e,
    workerd runtime, performance.
19. [ ] Docs: README, CLAUDE.md, runbooks, onboarding, terminal/Keychain workflow, CI.
20. [ ] Final verification and truthful report.
