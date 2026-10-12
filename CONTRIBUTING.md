# Contributing

1. Read `CLAUDE.md` (it applies to humans too), `docs/architecture.md` and the ADRs.
2. Run `npm run typecheck && npm run lint && npm test` before opening a PR. CI also runs the CurseDelete conformance
   checker and the workerd runtime test.
3. Database changes go in new numbered files under `migrations/`; never edit an applied migration.
4. Changes to the `/v1` wire behaviour require an ADR and a client conformance run.
5. Update `CHANGELOG.md` under `[Unreleased]`.
