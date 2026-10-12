# Curated storefront implementation plan

Goal: deliver the approved RePass Cloud storefront and shared portal redesign as a PR to main.
Architecture: Hono server-rendered views consume the PostgreSQL catalogue. External app.js enhances GET selection and persists theme; checkout remains service-authoritative.
Tech stack: TypeScript, Hono JSX, PostgreSQL, Cloudflare Workers.
Spec: ../specs/2026-10-13-curated-storefront-design.md
Execution: native implementation in this session under the user's instruction to complete and create a PR.

## Constraints and review focus
Preserve repass-v1, integer money, service permissions/audit and CSP. Reject unsafe image schemes. Hide unavailable/private components. Handle bundles, unavailable currency, invalid edition selection and JavaScript-disabled requests. Theme control must not hide forms or change validation.

## Tasks
- [x] Add failing catalogue and storefront tests for artwork, requirements and public visibility.
- [x] Add migration 0008, validated imageUrl and organisationDetails to catalogue services, and shared requirement resolution for checkout.
- [x] Extend admin create/edit forms and regenerate OpenAPI.
- [x] Add curated catalogue/product views with server selection, country names, price/quantity limits and Stripe attribution.
- [x] Apply canonical branding and responsive shared layout, improve signing-key action disclosure and add theme persistence.
- [x] Add public metadata, robots and sitemap with private route exclusions.
- [x] Run focused and full verification, inspect rendered pages and review the diff.
Delivery: the user selected a pushed branch and review PR to main.
