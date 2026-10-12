# Using the catalogue CSV with the license server

One CSV drives two systems:

| System | What it holds | How the CSV reaches it |
| --- | --- | --- |
| **Stripe** | The product customers see at Checkout: name, description, image. | `sync-products.sh` (see [README.md](README.md)) creates or updates the Stripe product and writes its `prod_…` ID into `product_id`. |
| **License server** | The offer that is sold: product, major version, edition, billing, seats, **prices in every currency**, and the link to the Stripe product. | The importer (web UI, admin API or `npm run catalogue:import`). It reads only rows marked `_ls:import = yes`. |

Prices live only in the license server database. Checkout sends the price inline against the linked Stripe product, so the
Stripe script's `_price:*` columns stay `no`/empty for license-server products. The license server never creates, renames
or archives Stripe products. It only links them and adds `repass_offer_id`/`repass_sku` metadata.

An example file is in [`license-server.example.csv`](license-server.example.csv).

## Workflow

1. **Prerequisites on the license server** (once per product major, in the admin portal or API; see
   `docs/product-onboarding.md`): the product (for example `cursedelete`), its major (`2`, protocol `repass-v1`), a shipped
   minimum release, the edition policies you sell (`community`, `education`, `business`, `enterprise`), and signing keys
   marked trusted and eligible. The importer does not create these. A row that refers to a missing one is reported as an error.
2. **Add rows to the CSV** with the Stripe columns (name, description, image) and the `_ls:` columns below. Set
   `_ls:import = yes` on every row the license server should import. Rows from other projects, such as the book products,
   leave it empty and are skipped.
3. **Create the Stripe products:** `./sync-products.sh products.csv`, then `--apply`. This fills `product_id`. The Stripe
   script processes **every** row, regardless of `_ls:import`. Rows that already have a `product_id` are only updated.
4. **Import into the license server**, using the web UI, the script or the API (below). Always look at the dry run first, then apply.
5. **Test a purchase** in Stripe test mode.

Re-running steps 3 and 4 is safe. An unchanged row is reported as `unchanged` and nothing is written.

Use one CSV per Stripe mode. Test-mode `prod_…` IDs do not exist in live mode, and the importer checks the product against the
server's Stripe key (the error says `test mode` or `live mode`).

## Choosing which rows are imported

Only rows with **`_ls:import`** set to `yes` (also `y`, `true` or `1`) are imported. Empty, `no`, `n`, `false` and `0` skip
the row. The file must have an `_ls:import` column.

License-server columns use their own **`_ls:`** prefix rather than `_meta:`. The Stripe script sends every `_meta:` column to
Stripe as product metadata, and ignores any other prefix, so `_ls:` columns never reach Stripe. An `_ls:` column the importer
does not recognise (for example a typo such as `_ls:edtion`) stops the whole import before anything is written.

## Columns

### Shared with the Stripe script

| Column | Used by the importer as |
| --- | --- |
| `product_id` | The Stripe product to link (filled by the Stripe script). Empty: the offer is created as a draft and cannot be activated yet. |
| `name` | Offer name, unless `_ls:name` is set. |
| `description` | Offer description, unless `_ls:description` is set. |
| `_meta:sku` | Offer SKU, unless `_ls:sku` is set. Letters, digits, `_ . -`, at most 100 characters. **SKUs are permanent.** |
| `_image:url` | Not used by the license server. Stripe shows this image at Checkout. |

### License server (`_ls:`)

| Column | Required | Values | Default | Notes |
| --- | --- | --- | --- | --- |
| `_ls:import` | yes | `yes` / empty | — | Selects the row. |
| `_ls:sku` | | SKU | `_meta:sku` | Use it if the license-server SKU must differ from the Stripe script's SKU. |
| `_ls:name`, `_ls:description` | | text | `name`, `description` | |
| `_ls:product` | yes | product id, e.g. `cursedelete` | — | Must exist. |
| `_ls:major` | yes | e.g. `2` | — | Must exist (CurseDelete 2 = `cursedelete` + `2`). |
| `_ls:edition` | yes | `community` `education` `business` `enterprise` | — | The edition policy must exist for that major. |
| `_ls:billing` | yes | `one_time` `recurring` `free` | — | `free` = $0 registration (all prices `0`). |
| `_ls:term` | | `perpetual` `subscription` `fixed_term` | `subscription` if recurring, else `perpetual` | `repass-v1` allows non-perpetual terms for `business` only. |
| `_ls:interval` | for recurring / fixed term | `day` `week` `month` `year` | — | The billing period (recurring) or the term length (fixed term). |
| `_ls:interval_count` | | number | `1` | For example `3` + `month` = quarterly. |
| `_ls:seats_per_unit` | business | number | — | Device seats per unit bought. |
| `_ls:quantity_scales_seats` | | `yes` / `no` | `no` | `yes`: buying 5 gives 5 × seats. |
| `_ls:min_quantity`, `_ls:max_quantity` | | number | `1`, `1` | |
| `_ls:trial_days` | | number | — | Subscriptions only. |
| `_ls:grace_days` | | 0–90 | `0` | |
| `_ls:transfer_allowance` | | number | edition default | |
| `_ls:refund_action`, `_ls:dispute_action` | | `revoke` `review` `none` | `revoke`, `review` | |
| `_ls:visibility` | | `public` `private` | `public` | Private offers do not appear in `/store`. |
| `_ls:customer_kind` | | `any` `individual` `organisation` | `any` | |
| `_ls:price:<cur>` | to sell | integer **minor units** | — | One column per store currency: `aud usd eur gbp cad nzd sgd hkd jpy cny chf`. `4900` = 49.00; JPY in whole yen. An offer sells only when **all 11** have a price. |
| `_ls:tax_percent:<cur>`, `_ls:tax_label:<cur>` | | e.g. `10` + `GST` | — | Flat tax added on top at checkout (100 + GST 10% = 110). Set both or neither. |
| `_ls:stripe_product_id` | | `prod_…` | `product_id` | Only if the link should differ from the Stripe script's product. |
| `_ls:activate` | | `yes` / `no` | `no` | `yes` publishes the offer after import. This needs a linked product and all 11 prices. The importer never deactivates or archives. |

### What an import can change on an existing offer

| Can change (same SKU) | Cannot change (use a new SKU) |
| --- | --- |
| name, description, visibility | product, major, edition, billing, term and interval, seats, quantity scaling, min/max quantity, trial, grace, transfers, refund/dispute actions, customer kind |
| prices: only currencies whose amount, tax or interval changed get a new immutable price version; existing buyers keep what they paid | |
| the linked Stripe product (relinking is audited; open checkouts keep their product) | |
| draft → active (`_ls:activate = yes`) | |

A row that tries to change something fixed is reported as an error, for example `seats_per_unit 1 → 5; use a new SKU`.
The other rows still import.

## Option A: web UI

1. Admin portal → **Offers** → **Import offers from the catalogue CSV** (`/admin/catalogue/import`).
2. Choose the CSV file (or paste it) and click **Check (dry run)**. Nothing changes. The table shows each row as `create`,
   `update`, `unchanged`, `skipped` or `error`, with the exact changes and any notes (for example a missing `product_id` or currency).
3. Click **Apply import** to perform exactly that import.

You need the `products:write` and `prices:write` permissions. Everything is written through the same audited services as the
rest of the admin portal, and each apply adds a `catalogue.imported` audit entry.

## Option B: terminal script (admin API token)

The script sends the CSV to the admin API. It needs an API token with **`products:write` and `prices:write`** (admin portal →
Access → Create an API token). By default it reads the token from the macOS Keychain item `repass-admin-pat`, as in
`docs/runbooks/terminal-admin-api.md`, or from `REPASS_ADMIN_TOKEN`.

```zsh
export REPASS_API=https://license-server.repasscloud.com/api/admin/v1

npm run catalogue:import -- stripe-catalogue/products.csv            # dry run
npm run catalogue:import -- stripe-catalogue/products.csv --apply    # perform it
npm run catalogue:import -- stripe-catalogue/products.csv --show-skipped
```

Output (dry run):

```text
Line 7: CREATE    cd2-enterprise  (CurseDelete 2 Enterprise)
    would: create offer (cursedelete v2 enterprise, one_time, perpetual)
    would: set prices AUD 49900, USD 32900, …
    would: link Stripe product prod_…
DRY RUN: 3 selected (5 skipped) · 3 create, 0 update, 0 unchanged, 0 error(s)
Re-run with --apply to perform these changes.
```

The script exits with status 1 if any row has an error.

## Option C: the admin API directly

`POST /api/admin/v1/catalogue/import` with JSON `{"csv": "<file contents>", "apply": false}`. `apply` defaults to `false`
(a dry run). The response lists every row:

```zsh
# with the rp helper from docs/runbooks/terminal-admin-api.md
rp POST /catalogue/import "$(jq -Rs '{csv: ., apply: false}' stripe-catalogue/products.csv)" \
  | jq '{selected, created, updated, unchanged, errors, rows: [.rows[] | select(.action != "skipped") | {line, sku, action, changes, error}]}'
```

The request body limit is 256 KB and the row limit is 500. Supported CSV features are quoted fields, embedded commas and
newlines, and the UTF-8 BOM the Stripe script writes.

## Images

The license server does not store images. Checkout shows the image held by the **Stripe product**, which the Stripe script
sets from `_image:url`. Stripe needs a **public HTTPS URL**. A GitHub raw URL works when the repository is public:

- In this repository (`repasscloud/license-server-app` is public), put the file in [`assets/products/`](../assets/products/)
  and use `https://raw.githubusercontent.com/repasscloud/license-server-app/main/assets/products/cursedelete-2.png`
  (the file must be on `main`).
- Or use the image in the product's own public repository, for example the CurseDelete repository.

Use a URL that will not move. If the image changes, update `_image:url` and re-run the Stripe script. The license server needs nothing.

## Troubleshooting

| Message | Fix |
| --- | --- |
| `The CSV has no _ls:import column` | Add the column and set `yes` on the rows to import. |
| `Unknown license-server column(s): …` | Fix the column name (see the table above). |
| `No active <edition> edition policy for <product> v<major>` | Create the product, major and edition policy first (prerequisites). |
| `… does not exist in this Stripe account (test mode)` | The `product_id` belongs to the other Stripe mode or account. Use that mode's CSV. |
| `Stripe product … is already linked to offer …` | One Stripe product per offer. Create another Stripe product for this row. |
| `… cannot change (…); use a new SKU` | That field is fixed once the offer exists. Add a new row with a new SKU and archive the old offer. |
| `_ls:activate = yes needs a price in every store currency` | Fill all 11 `_ls:price:<cur>` columns. |
| `no product_id yet` (note) | Run the Stripe script with `--apply` first, then import again. |
