# Importing the catalogue CSV into the license server

One CSV (`products.csv`) feeds two systems:

| System | What it holds | How the CSV reaches it |
| --- | --- | --- |
| **Stripe** | The product customers see at Checkout: name, description, image. | `sync-products.sh` (see [README.md](README.md)) creates or updates the Stripe product and writes its `prod_…` ID into `product_id`. |
| **License server** (PostgreSQL, the master) | The product, major version and edition policy; the offer that is sold (billing, term, seats, trial, grace, transfers, refund/dispute handling); **prices in every currency**; the link to the Stripe product. | **Import CSV** in the admin portal, the admin API, or `npm run catalogue:import`. Only rows marked `_ls:import = yes`. |

The CSV is how you feed the license server, not a second source of truth: after an import, PostgreSQL holds the
catalogue. Prices live only in PostgreSQL. Checkout sends the price inline against the offer's Stripe product, so the
Stripe script's `_price:*` and `price_id` columns are ignored by the license server (leave `_price:create = no` for
license-server products).

## The rule: conflicts are reported, never resolved

The import never overwrites Stripe and never silently overwrites settled license-server data. Whenever the CSV, the
license server and Stripe disagree on something the import is not allowed to change, the **row is rejected** with both
values (for example `Stripe product name "X" differs from the CSV name "Y"`). Review both sides, fix the wrong one (in
Stripe with the Stripe script, in the CSV, or in the admin portal) and import again. Other rows are not affected.

## Workflows

### Stripe first (normal)

1. Add or edit rows in `products.csv`: the Stripe columns plus the `_ls:` columns below, `_ls:import = yes`.
2. `./sync-products.sh products.csv`, then `--apply`. This creates or updates the Stripe products and fills `product_id`.
3. Admin portal → **Products** (or **Offers**) → **Import CSV** → choose `products.csv` → **Upload and preview**.
4. Review the preview. Nothing has changed yet. Each row is `create`, `link`, `update`, `unchanged`, `skipped` or
   `error`, with the exact changes, notes and errors. Products, majors and edition policies that will be created are listed
   separately.
5. **Confirm and apply.** The result shows what was done for every row.

Repeat whenever the CSV changes. An unchanged file previews as all `unchanged` and applying it changes nothing.

### PostgreSQL first (product not in Stripe yet)

Leave `product_id` empty. The row is imported normally (offer, prices, activation if requested) with the note *"not in
Stripe yet"*. The Stripe product is created **at the first checkout** for that offer (below). The next import reports the
ID the server created (*"linked to Stripe product prod_… in the licence server: copy it into product_id"*).
**Copy that ID into `product_id`** before you next run the Stripe script; otherwise the script would create a second
product for the row.

If Stripe already has a product carrying the row's SKU (`metadata.sku` or `metadata.repass_sku`) but the CSV has no
`product_id`, the row is rejected and the existing ID is shown, so neither tool creates a duplicate.

### Checkout-time Stripe product creation

When a customer buys an offer that has no linked Stripe product, the server, before opening Checkout:

1. locks that offer's Stripe mapping row (concurrent first purchases wait, then reuse the result);
2. searches Stripe for a product tagged `repass_offer_id` = this offer (recovers a product created earlier whose link was
   lost, for example a database failure after Stripe answered). Exactly one: it is linked. Two or more: the checkout is
   refused and an administrator links the right one;
3. otherwise creates the product from the database offer (name, description, metadata `repass_offer_id`, `repass_sku`,
   `sku`) with the idempotency key `repass-product-<offerId>`, so a retry returns the same product;
4. stores the ID and continues. Later purchases use the stored ID.

A Stripe failure fails that checkout with "Payment provider is unavailable"; nothing is half-linked, the error is shown on
the offer page, and the next attempt retries safely. Prices are never Stripe objects.

## Choosing which rows are imported

`_ls:import` = `yes` (or `y`, `true`, `1`) imports the row. Empty, `no`, `n`, `false`, `0` skip it (for example the book
products, which are sold elsewhere). Any other value is an error. The file must have an `_ls:import` column, and an
unrecognised `_ls:` column (a typo such as `_ls:edtion`) stops the whole preview.

License-server columns use the `_ls:` prefix, which the Stripe script ignores (it sends only `_meta:` columns to Stripe).

## Columns

### Shared with the Stripe script

| Column | Used by the license server as |
| --- | --- |
| `product_id` | The Stripe product to link and verify (filled by the Stripe script). Empty: PostgreSQL-first (see above). |
| `name` | The Stripe product name, which must match Stripe exactly. Also the offer name unless `_ls:name` is set. |
| `description` | Compared with the Stripe product description when not empty. Also the offer description unless `_ls:description` is set. |
| `active` | `yes`/`no`. `no` while the Stripe product is active is a conflict; an archived Stripe product cannot be linked. |
| `_meta:sku` | The offer SKU unless `_ls:sku` is set; must match the Stripe product's `metadata.sku` when that is present. |
| `price_id`, `_price:*`, `_image:*`, `tax_code`, `shippable`, `statement_descriptor`, `url`, other `_meta:*` | Not used by the license server. |

### Offer (one per row)

| Column | Required | Values | If blank | Notes |
| --- | --- | --- | --- | --- |
| `_ls:import` | yes | `yes` | skipped | |
| `_ls:sku` | | `A-Za-z0-9_.-`, ≤100 | `_meta:sku` | **The offer's permanent identity.** |
| `_ls:name`, `_ls:description` | | text (name ≤200) | `name`, `description` | Offer names are unique (case-insensitive) among offers that are not archived. |
| `_ls:stripe_product_id` | | `prod_…` | `product_id` | Only if it must differ from `product_id`; both set and different is an error. |
| `_ls:billing` | **yes** | `one_time` `recurring` `free` | | `free` = registration, every price `0`. |
| `_ls:term` | | `perpetual` `subscription` `fixed_term` | `subscription` if recurring, else `perpetual` | The protocol decides which editions allow which terms. |
| `_ls:interval` | recurring / fixed term | `day` `week` `month` `year` | | Billing period, or term length. |
| `_ls:interval_count` | | 1–120 | `1` | `3` + `month` = quarterly. |
| `_ls:seats_per_unit` | device-seat editions | 1–100000 | none | |
| `_ls:quantity_scales_seats` | | `yes`/`no` | `no` | Seats = seats per unit × quantity. |
| `_ls:min_quantity`, `_ls:max_quantity` | | 1–10000 | `1` | |
| `_ls:trial_days` | | 1–730 | no trial | Subscriptions only. |
| `_ls:grace_days` | | 0–90 | `0` | |
| `_ls:transfer_allowance` | | 0–1000 | edition default | Rolling 365-day device transfers. |
| `_ls:refund_action`, `_ls:dispute_action` | | `revoke` `review` `none` | `revoke`, `review` | |
| `_ls:visibility` | | `public` `private` | `public` | |
| `_ls:customer_kind` | | `any` `individual` `organisation` | `any` | |
| `_ls:activate` | | `yes`/`no` | `no` | `yes` publishes the offer (needs active product and major and a price in every currency). An import never deactivates. |
| `_ls:price:<cur>` | at least one | integer minor units | not priced | `<cur>`: `aud usd eur gbp cad nzd sgd hkd jpy cny chf`. An offer sells only when **all 11** have an active price. |
| `_ls:tax_percent:<cur>`, `_ls:tax_label:<cur>` | together | e.g. `10`, `GST` | no flat tax | Added on top at checkout. |

The "if blank" values are the license server's documented offer defaults (the same as the admin portal's). Every
create step in the preview spells out the resulting terms, so nothing is applied that you have not seen.

### Product, major and edition (created if missing, verified if present)

Rows that share a product, major or edition must agree on these columns (a blank cell does not count as disagreement).
When the record **exists**, every non-blank column is compared with it and a difference is an error (change it in the
admin portal, never through the CSV). When it **does not exist**, the columns marked "to create" are required: the
importer does not invent licensing policy.

| Column | To create | Values | Notes |
| --- | --- | --- | --- |
| `_ls:product` | always required | product id, e.g. `cursedelete` | The immutable wire `productId`. |
| `_ls:product_name` | product | text | Unique (case-insensitive) among products that are not retired. Products are created as **draft**. |
| `_ls:major` | always required | e.g. `2` | |
| `_ls:protocol` | major | `repass-v1` | The binding wire protocol. Majors are created as **draft**. |
| `_ls:major_transfer_allowance` | | 0–1000 | Blank when creating: `3` (system default, shown in the preview). |
| `_ls:major_activation_key_email` | | `yes`/`no` | Blank when creating: `yes` (system default, shown in the preview). |
| `_ls:edition` | always required | `community` `education` `business` `enterprise` | |
| `_ls:edition_name` | edition | `community` `education` `business` `enterprise` `corporate` (lower case only) | Display name, shown to customers (store, invoices). `corporate` is a name, not a wire edition: `repass-v1` licences carry only community, education, business or enterprise, so a corporate-named edition is one of those (usually `_ls:edition = enterprise`). A major has at most one policy per wire edition. |
| `_ls:edition_activation_model` | edition | `none` `device_seats` | Validated against the protocol in the preview. |
| `_ls:edition_ownership` | edition | `individual` `organisation` `institution` | |
| `_ls:edition_offline_policy` | edition | `indefinite` `periodic_check` | `indefinite`: the licence works offline forever once activated. `periodic_check`: the client must renew online; under `repass-v1` that is expressed by an activation-certificate lifetime, so it needs `_ls:edition_certificate_lifetime_days` and is only valid for `device_seats` editions (business). |
| `_ls:edition_certificate_lifetime_days` | | days, or `none` | Blank when creating: none. |
| `_ls:edition_transfer_allowance` | | number, or `default` | Blank when creating: the major's default. |

**Never imported:** releases and signing keys (trust and eligibility). Set those up in the admin portal
(`docs/product-onboarding.md`), then activate the product and major. Until then `_ls:activate = yes` on their offers is
an error.

## Identity and duplicate prevention

| Thing | Identified by | Enforced by |
| --- | --- | --- |
| Offer | SKU (`_ls:sku` / `_meta:sku`) | `offers.sku UNIQUE`; a SKU appearing twice in the file is an error. |
| Stripe product ↔ offer | `prod_…` ID | `stripe_product_mappings.stripe_product_id UNIQUE`; a `prod_…` used twice in the file, linked to another SKU, or different from the offer's existing link is an error. Stripe `metadata.sku` / `metadata.repass_sku` must agree with the row. |
| Product | slug (`_ls:product`) | `products.slug UNIQUE` (immutable). |
| Major, edition policy | product + major; major + edition | unique constraints. |
| Names | offer name; product name | Unique case-insensitively (migration 0007) among offers not archived and products not retired; duplicates in the file or against the database are errors. **Names are never used to match records.** |

Re-importing an unchanged file is a no-op. A renamed product keeps its SKU, its offer and its Stripe link: rename it in
Stripe (Stripe script) and in the CSV, and the import updates the offer name.

## What an import can change

| Can change on an existing offer (same SKU) | Cannot change (use a new SKU) |
| --- | --- |
| name, description, visibility | product, major, edition, billing, term and interval, seats, quantity scaling, min/max quantity, trial, grace, transfers, refund/dispute actions, customer kind, the price interval |
| prices: a new immutable version only for currencies whose amount or tax differs | archiving the offer, archiving prices, deactivating |
| link a Stripe product when the offer has none | relinking to a different Stripe product (do it in the admin portal, deliberately) |
| draft → active (`_ls:activate = yes`) | |

**Prices of an offer on sale** are never changed silently: a changed price becomes a **draft** version (shown as *add draft
prices … activate them in the admin portal*) and checkout keeps the current price until an administrator activates it on
the offer page. Re-importing does not duplicate a waiting draft. Prices of draft offers are activated directly. A currency
missing from the CSV keeps its existing price (noted in the preview).

## Using it

### Admin portal

**Products** or **Offers** → **Import CSV** (`/admin/catalogue/imports`) → choose the file → **Upload and preview** →
**Confirm and apply**. The import history lists every upload with who uploaded and applied it. Requires `products:write`
and `prices:write` (viewing needs `products:read`).

### Terminal script

```zsh
export REPASS_API=https://license-server.repasscloud.com/api/admin/v1   # token: Keychain "repass-admin-pat" or $REPASS_ADMIN_TOKEN

npm run catalogue:import -- stripe-catalogue/products.csv                  # upload + preview (prints the import id)
npm run catalogue:import -- --apply-id imp_…                               # apply that reviewed preview
npm run catalogue:import -- stripe-catalogue/products.csv --apply          # preview then apply (refuses if any row is rejected)
npm run catalogue:import -- stripe-catalogue/products.csv --apply --skip-rejected
```

The script exits 1 when a row is rejected or not applied.

### Admin API

| Call | Scope | Does |
| --- | --- | --- |
| `POST /catalogue/imports` `{"csv": "…", "fileName": "products.csv"}` | `products:write` + `prices:write` | Upload and preview. 201 with `id`, `summary`, `plan` (`entities`, `rows`). Writes nothing to the catalogue or Stripe. |
| `GET /catalogue/imports` | `products:read` | History (summaries). |
| `GET /catalogue/imports/{id}` | `products:read` | Status, preview and, once applied, `result` per row. |
| `POST /catalogue/imports/{id}/apply` | `products:write` + `prices:write` | Apply as the caller. 409 if it changed since the preview (see below). |

```zsh
ID=$(rp POST /catalogue/imports "$(jq -Rs '{csv: ., fileName: "products.csv"}' stripe-catalogue/products.csv)" | jq -r .id)
rp GET /catalogue/imports/$ID | jq '{summary, rows: [.plan.rows[] | select(.action != "skipped") | {line, sku, action, changes, errors}]}'
rp POST /catalogue/imports/$ID/apply '{}' | jq '.result.counts'
```

Limits: 500 rows; 512 KB per upload in the portal, 256 KB JSON body through the API. Supported CSV: quoted fields,
embedded commas and newlines, CRLF or LF, the UTF-8 BOM the Stripe script writes.

## Errors and recovery

| Situation | What happens | What to do |
| --- | --- | --- |
| A row is rejected | Nothing for that row is applied; other rows are. | Read both values in the message, fix the wrong side, upload again. |
| Catalogue or Stripe changed between preview and apply | **Nothing is applied** (409). The import now shows the updated preview. | Review it and confirm again. |
| A step fails while applying (for example Stripe unavailable while linking) | That row is `partial` (completed steps listed) or `error`; other rows continue. Every step is idempotent. | Upload the same CSV again: the preview shows only what is left. |
| Stripe unavailable during preview | 503, nothing recorded. | Try again. |
| Another import is applying | 409. A claim older than 10 minutes (a crashed worker) is taken over. | Wait and retry. |
| Import already applied | 409. | Upload the CSV again for later changes. |
| Checkout: "Stripe has 2 products tagged for offer …" | The offer cannot be sold until resolved. | Archive the wrong product in Stripe, link the right one on the offer page. |
| Checkout: provider unavailable while creating the product | Checkout fails; the offer page shows the last error. | Nothing; the next checkout retries with the same idempotency key. |

### Common messages

| Message | Fix |
| --- | --- |
| `Stripe product name "…" differs from the CSV name "…"` | Run the Stripe script (or correct the CSV), then import again. |
| `Stripe product … does not exist in this Stripe account (test mode)` | The ID belongs to the other Stripe mode or account. Use one CSV per mode. |
| `Stripe product … is linked to offer … in the licence server, but this CSV row is SKU …` | One Stripe product per offer. Fix the `product_id` or SKU in the CSV. |
| `Offer … is linked to Stripe product … but the CSV says …` | Decide which is right: relink on the offer page, or fix the CSV. |
| `No product_id in the CSV, but Stripe already has …` | Put that ID in `product_id`. |
| `… cannot change (…); use a new SKU` | Add a new row with a new SKU; archive the old offer in the portal. |
| `Product … does not exist: add _ls:product_name to create it` | Add the "to create" columns, or create it in the portal. |
| `_ls:activate = yes needs … to be active` | Set up releases and signing keys, activate the product and major, or set `_ls:activate = no`. |
| `Offer name "…" is already used by offer …` | Names are unique; rename one. |

## Images

The license server does not store images. Checkout shows the image held by the **Stripe product**, which the Stripe script
sets from `_image:url` (a public HTTPS URL, for example a `raw.githubusercontent.com` URL in a public repository). Products
created at checkout by the server have no image until you add one in Stripe.

An example of the license-server columns is in [`license-server.example.csv`](license-server.example.csv).
