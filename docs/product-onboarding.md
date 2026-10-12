# Onboarding a product, major version, edition, offer or price

Everything here is **data**, created through the admin portal or the admin API, with **no redeploy**. Code changes are needed only for a new *wire protocol* (see "Protocol capabilities" below).

## Concepts

| Object | What it is | Example |
| --- | --- | --- |
| Product | Immutable wire `productId` (slug) plus a display name | `cursedelete` |
| Major | One major version, bound to **one wire protocol** | `cursedelete` v2 → `repass-v1` |
| Release | An application release of the major. One shipped release is the **minimum supported** | `2.1.0` (minimum) |
| Edition label | `community`, `education`, `business`, `enterprise` (labels only) | — |
| Edition policy | How an edition behaves for *this major*: activation model, ownership, transfers, certificate lifetime, offline policy | Business: device seats, organisation, 3 transfers/365 days |
| Offer (SKU) | What is sold: single or bundle, billing one-time / recurring / free, availability, quantity rules, tax flags | `cd2-business-annual` |
| Component | One entitlement per component: term (perpetual / subscription / fixed term), seats per unit, quantity scaling, trial, grace, refund and dispute actions | Business subscription, 1 seat per unit, quantity scales seats |
| Price version | Immutable amount (minor units), currency, interval and tax behaviour; database only (sent inline at Checkout) | AUD 4900 / year, exclusive |

When a purchase is made, the **effective policy** (major + edition policy + component + quantity) is frozen into an append-only snapshot on the entitlement. Later catalogue edits never change existing customers. Support can make explicit, audited amendments.

## Steps

1. **Product:** create it (draft), then set it to *active*.
2. **Major:** create it with protocol `repass-v1`, then set it to *active*. Set the default transfer allowance and whether purchase emails include activation keys.
3. **Release:** add the first release the customer will run, set it to *shipped*, and tick **minimum supported**.
4. **Edition policies:** add the editions this major offers. Combinations the protocol cannot express are rejected with an explanation.
5. **Signing keys:** record that the release trusts the published keys, then mark them **eligible** (see [runbooks/signing-keys.md](runbooks/signing-keys.md)). Issuance fails closed until this is done.
6. **Offer:** create it with its components. It starts as a draft.
7. **Stripe product:** normally create the product in Stripe first, with the name, description and image Checkout should show (`stripe-catalogue/` with the CSV, or the Stripe dashboard). Then link it on the offer page (**Link Stripe product**), with `PUT /offers/{id-or-sku}/stripe-product {"stripeProductId":"prod_…"}`, or with the CSV import. The server checks that the product exists in this Stripe account (test or live, matching the key) and is active, and that no other offer uses it. It adds only `repass_offer_id`/`repass_sku` metadata and **never renames, re-describes or archives Stripe products**: renaming the offer does not touch Stripe, and **Verify Stripe product** (`POST /stripe/sync`) only re-checks the link. Relinking is audited; checkouts already open keep the product they were opened with. If you skip this step, the server creates the product from the offer at its **first checkout** (once, safely under concurrent purchases and retries) and links it.
8. **Prices:** on the offer page, **Set prices (all currencies)**, or `POST /offers/{id}/prices`. Every store currency (AUD, USD, EUR, GBP, CAD, NZD, SGD, HKD, JPY, CNY, CHF) needs an amount, in minor units (cents; whole yen for JPY). Prices live only in the database: nothing is created in Stripe, and Checkout sends the amount inline. An offer missing any currency is not shown and cannot be bought. Optional **flat tax** per currency: a rate and label (for example 10 and `GST`), added on top at checkout as a Stripe Tax Rate (not Stripe Tax): 100 + GST 10% = 110.
9. **Activate the offer.** This is refused unless the protocol combination is valid, the product and major are active, every store currency has an active price, and a linked Stripe product (if any) is verified. Checkout sends the database price inline against the offer's Stripe product.

Steps 1, 2, 4 and 6–9 can be done in bulk from the catalogue CSV (products, majors and editions are created when missing, from explicit columns; releases and signing keys never are): **Products → Import CSV** (upload, preview, confirm), `POST /catalogue/imports`, or `npm run catalogue:import`. Conflicts between the CSV, the database and Stripe are reported per row, never resolved automatically. See [stripe-catalogue/README-LICENSE-SERVER.md](../stripe-catalogue/README-LICENSE-SERVER.md).

10. The offer appears in `/store` if it is public, with a currency switcher. Test a purchase in Stripe **test mode**.

## How the store sells

- **One email = one customer**, in the database and in Stripe. The first purchase creates the customer and its Stripe customer (or reuses an existing Stripe customer with that email, since the Stripe account is shared). Checkout always opens on that customer, so the email cannot be changed at checkout and nothing is duplicated. Signed-in portal users buy as their own email.
- **Business, Enterprise and Education** purchases require business name and country; the business identifier (ABN, VAT, EIN…) is optional. On an existing customer, details typed into the public store only fill empty fields; they never overwrite.
- **Already owned:** an email with an active licence for the same product, major version and edition cannot buy it again (an expired subscription or fixed term does not count). Upgrades are a different SKU; send the customer a promotion code.
- **Promotion codes** are enabled on Checkout by default (offer setting). Codes are Stripe *promotion codes* (customer-facing), created in your Stripe account.
- **Emails are lowercase** everywhere (forms lowercase as you type; the server normalises again), and Checkout always opens on the customer's Stripe customer with the email already filled in.
- **Invoices:** every successful purchase and every renewal charge gets a numbered **Paid** invoice (seller and ABN, buyer business/name/address/tax ID, lines, discount, tax, total paid, balance due). It is emailed as a PDF and downloadable from the portal (owners, admins and billing members) and the admin customer page. $0 registrations get none.
- **Billing portal:** "Manage billing" in the customer portal opens Stripe's portal for the customer's single Stripe customer. `STRIPE_CUSTOMER_PORTAL_LOGIN_URL` in `wrangler.jsonc` adds a fallback sign-in link.

Changing a price means creating a new price version and activating it (a CSV import creates it as a draft when the offer is on sale). The old version is archived but stays attached to historical purchases and existing subscriptions. Changing what an offer grants means creating a new offer (new SKU) and archiving the old one: components are immutable once the offer exists.

## Protocol capabilities (what `repass-v1` clients accept)

| Edition label | Terms allowed | Activation model | Seats | Certificate lifetime |
| --- | --- | --- | --- | --- |
| `community` | perpetual only | none (provisioning) | — | — |
| `education` | perpetual only | none | — | — |
| `enterprise` | perpetual only | none | — | — |
| `business` | perpetual, subscription, fixed term, trial | **device seats** (required) | ≥ 1 (`maxActivations`) | optional (periodic re-validation) |

Examples:

- **Possible today:** free Community registration; paid or free Education perpetual; Business perpetual or subscription with N seats, optional trial and grace; Enterprise perpetual; bundles of the above across products.
- **Not possible with `repass-v1`:** Education/Community/Enterprise subscriptions or fixed terms; seatless Business; device-tracked non-Business editions; custom edition labels. These need a new protocol (for example `repass-v2`, with new claims and a new client release). To add one: implement it in `src/domain/protocols.ts` (validation, claims, formats), add tests and a client conformance check, insert a `license_protocols` row in a migration, then create a **new major** bound to it. Existing v1 majors never change protocol.

## Bundles

A bundle offer has two or more components, each for a different product major. A purchase creates **one entitlement and one licence per component**. There are never multi-product licences. Price the bundle as a single price version.

## Free and $0 offers

Use `billing: free` with a price of `0`. Checkout still goes through Stripe (Stripe calls these "no-cost orders"; the session reports `payment_status = no_payment_required`), so registrations capture the customer's identity. Admin grants (`/admin/customers/{id}` → Grant, or `POST /entitlements/grants`) issue entitlements without Stripe, recorded as zero-value `admin_grant` purchases.
