# Curated storefront and portal design

Approved direction: one product entry leads to a server-rendered product page with version and edition/billing selection. Changing the selected offer updates the price, description, quantity limits and required customer details. Currency and edition selections also work through GET requests without JavaScript.

Use the canonical RePass Cloud mark and Spectrum palette from repasscloud.github.io: paper #ffffff, mist #f4f3f7, ink #18141f, violet #6a1fc4, gold #ffbe16, pink #e35f9a and purple #ab2df3. Use the spectrum for the top rule and brand mark only. Shared navigation, forms, tables, disclosures and notifications apply to public, admin and customer pages. A persisted theme control defaults to the system preference.

Products gain an optional imageUrl (HTTP(S) or site-relative path). Offers gain organisationDetails (auto, required, none), managed by the existing audited catalogue services and admin API. Auto retains organisation requirements based on customer kind and edition ownership. Explicit none is allowed only for non-organisation ownership. Country selection uses ISO country names and stored two-letter values. Never trust browser price or requirements.

Public catalogue pages receive descriptions, canonical URLs and social metadata. Sitemap and robots expose only public active catalogue entries. Private products, inactive majors, inactive policies and unavailable offers never enter public data. Authenticated portal, admin, checkout status and login pages remain noindex. Product descriptions and edition links are present in HTML without JavaScript. Bundles receive separate curated entries rather than being assigned arbitrarily to a component product.

Preserve repass-v1 wire contracts, immutable prices, frozen entitlement policies, service-level permissions, audit events, CSRF and CSP. Do not deploy or merge; deliver a reviewed local change and PR to main.

Validation: regression tests for catalogue exposure, artwork validation and service persistence, configured organisation requirements, public metadata and country selection; full lint/typecheck/test/build/Workers checks and rendered browser inspection where possible.
