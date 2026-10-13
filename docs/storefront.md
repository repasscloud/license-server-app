# Storefront and interface configuration

The public store groups single-product offers under one product page at `/store/products/<slug>`. Bundles have their own entries at `/store/bundles/<sku>`. Product name, description and artwork come from Products; option names and descriptions come from Offers. Major versions provide numeric version choices; enabled edition policies provide the separate edition selector. Licence type and currency sit in the header toolbar. Concise licence summaries come from billing and term data, including fixed-term durations. Active price versions define prices, tax and billing intervals.

## Admin setup

1. In Products, set the product description and optional **Product image or logo URL**. Accepts HTTP(S) or a site-relative path beginning with `/`; leaving it blank restores the monogram fallback. Relative paths must point to an asset served by this site. Images from an external host are fetched by the visitor's browser. HTTPS assets are recommended for the production HTTPS site.
2. In Offers, use **Storefront details** to set a readable licence option name and description. **Organisation details at checkout** defaults to edition ownership: individual editions ask for personal details; organisation and institution editions require business name and country. `required` can additionally require organisation details on an offer for any customer; `none` is restricted to individual ownership. Individual-only offers cannot require organisation details. The server independently validates these rules at checkout.
3. Activate a public product, its major version and edition policy, then publish its public offers with complete prices in all supported store currencies. Private or unavailable components exclude the entire offer from public pages and the sitemap. Historical licences and prices are unchanged.

The country dropdown uses ISO 3166-1 alpha-2 values with English country names; geolocation preselects a country when available. Fixed-quantity offers do not ask customers to enter a quantity. Stripe payment attribution links to https://stripe.com using the official wordmark.

## Search visibility and privacy

`/`, `/store`, product and bundle pages render catalogue content on the server with descriptions, canonical URLs and social metadata. The sitemap contains currently available public entries. Edition descriptions and comparison links are in the HTML without JavaScript. GET requests support version, SKU and currency selection; JavaScript updates selected and comparison prices, catalogue prices, links and checkout fields immediately, without reloading. CSS/JavaScript URLs include a content-derived version to avoid stale assets after deployment. Account, admin, sign-in and checkout status pages remain `noindex,nofollow`; robots excludes private route groups.

## Branding

The canonical RePass Cloud mark is copied from `repasscloud.github.io/public/brand/repasscloud-mark.svg`. Spectrum colours are used in the mark and the top rule; violet is the primary action colour. The application uses native system typography for form-heavy pages. The saved light/dark preference applies across the site and defaults to the system preference. The script and styles remain external under CSP.

Stripe wordmark source: https://stripe.com/newsroom/information, official logo kit downloaded 2026-10-13. The blurple asset remains on a white background in both themes.

## Release

Apply migration `0008_storefront_presentation.sql` before deploying this Worker. It adds two columns to existing tables; the table-level grants in `sql/roles.sql` already cover these columns. No new tables or database role changes are required.

This PR does not deploy, merge, alter the binding licensing protocol, or change Stripe products. Configured product artwork affects the storefront only.

## Admin detail views

Public keys open in a native dialog with a copy action, without changing table column widths. Each key also has an authenticated detail-page fallback. Signing-key forms use equal grid tracks and aligned actions. Customer IDs remain on the customer detail page; email event metadata has its own separated block.

Audit and recent activity tables show compact summaries with single-line UTC timestamps. **View event** opens complete safe event data with copy support; the authenticated detail page works without JavaScript. **Export this page (JSON)** downloads up to 100 events for the current filters and cursor, together with a next-page cursor when present. Audit viewing and export both require `audit:read`; internal IP hashes are excluded. This is a page export, not a whole-history export.

This interface refinement uses existing database columns and does not require an additional migration.

## Shared header and footer

The signed-in account email, sign-out action and theme control share an aligned header group. On small screens, the email occupies its own line above the two buttons. The billing action uses a filled **Manage billing** button with the Stripe wordmark, followed by a short payment-methods and invoices hint.

The shared footer groups product/account navigation, support, payment attribution and legal links. The RePass Cloud brand is the single company-home link. Payment and promotion-code text now lives in the footer instead of the product purchase panel. Component screenshots and browser checks are recorded in [the chrome review](ui-review/chrome/README.md). No additional migration is required.
