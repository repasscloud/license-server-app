# Interface refinements

Implement the user's review feedback on the merged storefront design in a follow-up PR to main.

- Public keys open in a native dialog with copy/close controls and a no-JavaScript detail fallback; table widths remain unchanged.
- Align the three signing-key forms with equal grid tracks and aligned actions.
- Remove customer IDs from the customer list; place email identifiers in separated metadata blocks.
- Render a compact audit table with one-line UTC timestamps, clean actor labels and a full-event detail link/dialog. Add permission-checked JSON export of the current filtered page, including its next cursor. Full details and raw actor/resource IDs stay in the detail view.
- Split product version (numeric), edition (enabled policy), and licence type (offer term/billing) selection. Put licence type and currency in the header toolbar. Derive concise summaries from these choices rather than long offer names. Preserve GET/no-JavaScript operation and authoritative checkout validation.
- Update every visible price and product/comparison link in place on currency changes. Version CSS/JS URLs by their content to prevent stale deployments loading mismatched scripts.
- Remove the redundant portal Stripe link and add the Stripe wordmark to the billing button.
- Validate with HTTP regressions, browser interaction/geometry/copy checks, full repository checks and an independent code review. No deployment or merge.

Completed validation: HTTP regression tests; geometry/clipboard/browser checks on synthetic data; no-JavaScript fallbacks; full unit/integration/real-client suite; Workers runtime; lint/typecheck; staging/production dry-run builds; independent review. Fixed-term duration was added to labels and structured selection keys during review. See docs/ui-review/refinements/README.md for rendered evidence.
