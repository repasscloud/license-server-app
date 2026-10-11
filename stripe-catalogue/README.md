# Stripe product catalogue synchroniser

Five initial products for **AI for Normal People** are in `products.csv`. The CSV is the editable source of truth. This utility uses Python 3's standard library, called through `sync-products.sh` (macOS/Linux). Stripe credentials stay outside the CSV.

## Run

```bash
# Preview and validate; no Stripe requests or image uploads
./sync-products.sh products.csv

# Set a Stripe TEST MODE key first (do not commit it to source control)
export STRIPE_SECRET_KEY='sk_test_...'
./sync-products.sh products.csv --apply
```

For production, use the appropriate live secret or restricted API key (with product/price write permissions). Check that you're using the correct Stripe account and key. **Start in test mode.** If the CSV was already populated by test-mode IDs, use a separate clean CSV for live mode; test IDs cannot be updated with live credentials.

Once `--apply` creates a product, its Stripe `prod_...` ID is written to `product_id` immediately. On later runs, the script updates the referenced Stripe product. A backup `products.csv.bak` is created before each apply. Writes are atomic and preserve the CSV's columns. An error on one row does not stop the remaining rows; the tool exits nonzero if any row fails.

> **Existing Stripe products:** Your products may already exist. If so, paste their real IDs into the CSV **before running `--apply`**. Otherwise Stripe creates duplicates. The tool does not guess an existing product by name.

## Column behaviour

| Column | Meaning |
|---|---|
| `product_id` | Empty creates; populated updates this exact Stripe product. Automatically filled after creation. |
| `price_id` | Automatically filled when a new price is created. |
| `name` | Required. Product display name. |
| `description` | Customer-facing description. |
| `tax_code` | Stripe Tax code, subject to separate review. |
| `active` | `yes` / `no`. |
| `shippable` | `yes` for a shipped paperback, `no` for downloads. |
| `statement_descriptor` | Optional; Stripe currently uses the **product-level** statement descriptor for **subscriptions**, not one-time book purchases. Leave blank for these products. |
| `url` | Public landing page for product. |
| `_meta:<key>` | Product metadata (e.g. `_meta:edition`, `_meta:sku`, `_meta:store_format`). Add as many new CSV columns as needed **within Stripe metadata limits**. Nonempty values are sent as strings. |
| `_price:create` | `no` by default. `yes` creates/verifies a one-time price and makes it default. |
| `_price:amount` | Integer minor units, e.g. `1999` = AUD 19.99. |
| `_price:currency` | `AUD` (sent as lowercase to Stripe). |
| `_image:url` | Public HTTPS URL for a product image. |
| `_image:path` | Path relative to the CSV (or absolute), uploaded to R2 **only if R2 options are configured**. |

All columns beginning `_meta:` are treated as metadata; the `_price:` and `_image:` prefixes are separate special namespaces. **Avoid treating every underscore-prefixed column as metadata**, so functionality can expand later without collisions. `_meta:sku` is required and unique in the file; it also anchors stable idempotency keys.

Blank metadata entries are *not sent* and do *not* erase existing remote metadata. Omitted image paths do not clear existing remote images. Remove obsolete metadata manually in Stripe if needed. The script only manages the first product image (`images[0]`), not an arbitrary image gallery.

For a later second edition, create **new CSV rows** with distinct `_meta:sku` values, edition `2`, and new ISBNs as applicable. Don't overwrite first-edition product IDs with second-edition products.

## Adding prices later

1. Change `_price:create` to `yes`.
2. Set `_price:amount` to an integer count of cents, e.g. `1999`.
3. Set `_price:currency` to `AUD`.
4. Apply. The new price is assigned to the product as `default_price`, and its `price_id` is recorded.

**Prices are immutable in important ways.** If a stored `price_id` has a different amount/currency from the CSV, the tool refuses the mismatch. It will **not** silently create a replacement or alter old prices. Decide deliberately when you want to introduce a new price, and check existing Checkout/Payment Links that reference an older price. Do not clear `price_id` and rerun accidentally.

## Images

Stripe Products API accepts publicly accessible image **URLs**, not local image bytes. Two supported paths:

**A. Existing public image URL (simplest)**: put the full `https://.../book-cover.jpg` in `_image:url`, leaving `_image:path` empty.

**B. Upload local images to Cloudflare R2 via AWS CLI**: put `images/cover.jpg` in `_image:path`, leave `_image:url` empty, and set the following configuration before `--apply`:

```bash
# AWS CLI must be installed and authenticated for R2 (e.g. AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY)
export STRIPE_IMAGE_R2_BUCKET='your-public-image-bucket'
export STRIPE_IMAGE_R2_ENDPOINT='https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com'
export STRIPE_IMAGE_PUBLIC_BASE='https://static.example.com'
./sync-products.sh products.csv --apply
```

The tool uploads the image with `aws s3 cp`, using a filename prefixed by a SHA-256 content digest, and constructs its public URL from `STRIPE_IMAGE_PUBLIC_BASE`. **You must configure the R2 bucket's public domain and credentials first.** The script cannot automatically grant public access or confirm that your domain serves the object. The image must resolve publicly for Stripe to use it. Repeated `--apply` runs may re-upload the same object, but use the same object key when content is unchanged. The optional R2 feature is not required to create products.

When dry-running a local image, the tool validates that the file exists and the R2 options are present, but does not upload it.

## Operational cautions

- `products.csv` is a mutable output file. Back it up and keep it under version control, excluding secrets. Prefer one operator at a time; parallel runs could overwrite IDs.
- If Stripe returns an error while creating an object, retries use stable idempotency keys keyed to the CSV path and SKU. Stripe's idempotency retention is limited; reconcile uncertain outcomes before retrying after a long interruption.
- Do not rename or relocate an uncommitted CSV between an uncertain request and a retry, since that affects the idempotency key.
- The script does not delete products or prices, and never automatically removes metadata, images or old prices.
- Product `statement_descriptor` is not a general-purpose one-off purchase bank descriptor. For one-off Checkout payments, Stripe/account/payment-intent settings govern statement descriptions.
- Confirm Australian and international Stripe tax codes and treatment separately before accepting orders. The CSV retains the codes you provided.

API references: [Create Product](https://docs.stripe.com/api/products/create), [Update Product](https://docs.stripe.com/api/products/update), [Create Price](https://docs.stripe.com/api/prices/create).
