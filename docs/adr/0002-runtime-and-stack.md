# ADR-0002: Runtime and stack

- **Status:** Accepted · 2026-10-11

## Decision

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | One Cloudflare Worker, Free plan, `compatibility_date 2026-10-01`, flags `nodejs_compat` (postgres.js sockets) and `webcrypto_modern_algorithms` (native ML-DSA-65, available since 2026-09-28) | Mandated budget and runtime. One deployable unit; route groups are isolated logically. |
| Router / UI | Hono and server-rendered `hono/jsx`, no client JavaScript, strict CSP (`script-src 'self'` with no scripts) | Small, Workers-native, typed. Accessible HTML forms using the PRG pattern; no SPA attack surface. |
| Machine path | `/v1/*` dispatched to a minimal 3-route app; hand-written body validators | Avoids paying cold-isolate CPU for the full router and zod on the licensing hot path (measured). |
| Validation | zod v4 for admin, catalogue and checkout inputs | Typed parsing with clear errors where cold CPU is irrelevant. |
| PostgreSQL driver | postgres.js 3.4.9 with `prepare: true`, `fetch_types: false`, `max: 5`; arrays passed as JSON and expanded in SQL; a custom `text[]` parser | Supported by Hyperdrive (`prepare:false` can hang). `fetch_types:false` saves a round trip but disables array typing, so arrays avoid driver typing entirely. |
| Hyperdrive | **Query caching disabled** (`--caching-disabled`) | Licensing reads (revocation, sessions, rate limits, seat counts) must never be served stale. Hyperdrive does not invalidate its cache on writes. |
| Rate limiting | Fixed windows in PostgreSQL (one upsert per request covers every dimension) | Consistent across isolates and colos, portable, and needs no paid product. |
| Crypto | Native Web Crypto only (Ed25519 PKCS#8 from seed, P-256 PKCS#8 from scalar, ML-DSA-65 `raw-seed`; AES-256-GCM; HMAC-SHA-256) | Verified byte-for-byte against the official vectors in Node and in workerd. No pure-JS crypto dependency. |
| Tests | Vitest 4 projects: unit; integration on a real PostgreSQL 18 (`initdb` cluster or CI service); workers (`wrangler dev` / workerd with the local Hyperdrive binding); perf | Real-database concurrency tests, plus real-runtime compatibility. |
| TypeScript | 6.0 (`typescript-eslint` does not yet support 7); runtime types from `wrangler types`; no parameter properties | `src/` also runs under Node's built-in type stripping for operator scripts. |

## Rejected

- **D1.** Forbidden by the mandate; PostgreSQL is the portable system of record.
- **Durable Objects, Queues, KV.** Not needed; PostgreSQL row locks and the outbox provide serialisation and durability on Free.
- **The Stripe Node SDK.** Bundle size and cold CPU; a 100-line fetch adapter covers the endpoints we use.
- **Password authentication.** A safe KDF cost does not fit 10 ms of CPU, and weakening it is unacceptable (see ADR-0004).
