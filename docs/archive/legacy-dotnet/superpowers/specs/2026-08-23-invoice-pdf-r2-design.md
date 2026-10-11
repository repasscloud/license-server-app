# PDF invoices on Cloudflare R2 (#73, #74) + #72 verification

## Context

`dev` has `TransactionalEmail.cs` with `EmailTemplateRenderer`, which renders
`EmailTemplates/*.html` by substituting `{{token}}` placeholders from a
`TransactionalEmail.Model` dictionary. A missing token currently renders as
empty text, not a removed element (see `Substitute()`'s doc comment).

`invoice.html` and `renewal-receipt.html` both reference a not-yet-generated
invoice PDF URL (`{{actionUrl}}` and `{{invoicePdfUrl}}` respectively; the
latter's comment already says the download button should render only when
the token is present). This spec covers generating and storing that PDF
(#73), wiring the renewal-receipt email to it (#74), and verifying #72
(`ContactSupport`) is fully implemented as specced.

`BillingPolicies.RenewalAsync` (~line 375) currently queues `RenewalReceipt`
with only `licenseId` in the model — no `productName`, `amount`, etc. are
populated yet. That gap is pre-existing and out of scope here; this spec adds
exactly one new key, `invoicePdfUrl`.

## Decisions

1. **PDF generation:** QuestPDF, building a small `InvoiceDocumentData`
   record (mirrors `invoice.html`'s documented tokens) in code — no headless
   browser/Chromium dependency.
2. **Storage & link:** Cloudflare R2 via `AWSSDK.S3` (S3-compatible
   endpoint), bucket kept **private**. The R2 object key is derived
   deterministically from `LicenseOrder.Id`: `invoices/{orderId:N}.pdf`. No
   new DB table/column is needed to track "does a PDF exist" — the download
   endpoint asks R2 directly.
3. **Download endpoint:** `GET /invoices/{orderId:guid}/pdf` — HEAD-checks
   the R2 object (404 if absent, e.g. legacy orders with no PDF), else mints
   a short-lived presigned GET URL and issues a redirect. The order GUID is
   the bearer token, matching the trust model of the existing customer
   magic-link. `{{actionUrl}}` (invoice.html) and `{{invoicePdfUrl}}`
   (renewal-receipt.html) are both
   `{CUSTOMER_PORTAL_PUBLIC_BASE_URL}/invoices/{orderId}/pdf` — one PDF backs
   both templates.
4. **Invoice data source:** fetched live from Stripe at generation time via a
   new `IInvoiceStripeDataProvider` (line items, totals, payment method),
   following the existing `IStripeCurrentStateFetcher` pattern in
   `BillingPolicies.cs` (interface + concrete wrapper around `StripeClient`,
   fake-able in tests without a mocking library — this repo has none).
   Issuer/business details (name, address, ABN, email) are new static config
   since Stripe doesn't know them.
5. **Retention:** no R2 lifecycle rule. Invoices are financial records and
   must outlive `EmailOutbox`'s 30-day `RetainUntil`, which governs only the
   outbox delivery-log row, not the PDF.
6. **Template conditional:** `EmailTemplateRenderer` gains a
   `{{#if key}}...{{/if}}` block pass run before `Substitute()`. A block's
   content is kept only when the model has a non-empty value for `key`,
   dropped (markers included) otherwise. Documented with a comment the same
   way `Substitute()`'s missing-placeholder behavior is documented today.
   `renewal-receipt.html`'s download-button `<td>` is wrapped in it.
7. **Failure isolation:** PDF generation is wrapped in try/catch at the
   `RenewalAsync` call site. Failure must not block the renewal or the
   receipt email — it's logged and `invoicePdfUrl` is simply omitted from
   the model, so the new conditional hides the button instead of shipping a
   dead link.

## Components

- `src/LicenseServer/InvoicePdf.cs` (new):
  - `InvoiceDocumentData` — record with the fields `invoice.html` documents:
    invoice id/dates, business details, billed-to, product/edition/seats/
    period, line items, subtotal/tax/total, payment method label.
  - `InvoiceIssuerOptions` — `BusinessName`, `BusinessAddress`,
    `BusinessAbn`, `BusinessEmail`, bound from config.
  - `R2Options` — `AccountId`, `AccessKeyId`, `SecretAccessKey`,
    `BucketName`.
  - `IInvoicePdfRenderer` / `InvoicePdfRenderer` — `byte[] Render(InvoiceDocumentData)` via QuestPDF.
  - `IInvoiceStorage` / `R2InvoiceStorage` — `StoreAsync(key, bytes)`,
    `ExistsAsync(key)`, `GetPresignedDownloadUrlAsync(key, validFor)`, built
    on `IAmazonS3` configured with R2's endpoint
    (`https://{accountId}.r2.cloudflarestorage.com`, path-style addressing).
  - `IInvoiceStripeDataProvider` / `StripeInvoiceDataProvider` —
    fetches/expands the Stripe invoice and maps it to line items + totals +
    payment method label.
  - `IInvoicePdfService` / `InvoicePdfService` — orchestrates: fetch Stripe
    data → build `InvoiceDocumentData` → render → store. Returns the R2
    object key (or throws; caller handles failure isolation per decision 7).
- `src/LicenseServer/BillingPolicies.cs`: `RenewalAsync` calls
  `InvoicePdfService.GenerateAndStoreAsync(order.Id, snapshot.InvoiceId, ...)`
  after the `LicenseOrder` is built, wrapped per decision 7; adds
  `invoicePdfUrl` to the `RenewalReceipt` model dict on success.
- New minimal-API endpoint (near existing customer-portal/magic-link
  endpoints) for `GET /invoices/{orderId:guid}/pdf`.
- `src/LicenseServer/TransactionalEmail.cs`:
  `EmailTemplateRenderer` gets the `{{#if}}` block pass.
- `src/LicenseServer/EmailTemplates/renewal-receipt.html`: wrap the download
  button's `<td>` in `{{#if invoicePdfUrl}}...{{/if}}`.
- `.env.prod`, `.env.prod.example`: add R2 + invoice-issuer config.

## Testing

- `EmailTemplateRenderingTests`: `{{#if}}` block present/absent cases
  (including nested placeholder substitution still working inside a kept
  block).
- New `InvoicePdfRendererTests`: non-empty output starting with the `%PDF`
  magic bytes, across normal data and data with optional fields omitted.
- New `InvoicePdfServiceTests`: hand-written fakes for
  `IInvoiceStripeDataProvider` and `IInvoiceStorage` (no mocking library, per
  repo convention) verify the orchestration and that the returned key
  matches `invoices/{orderId:N}.pdf`.
- `BillingPolicies`-area test: `RenewalAsync` queues `invoicePdfUrl` in the
  `RenewalReceipt` model when PDF generation succeeds, and omits it (without
  failing the renewal) when it throws.
- Full Postgres-backed suite (`TEST_POSTGRES_CONNECTION`) run before PR.

## #72 verification (no implementation)

Check `ContactSupportService`, `Components/Pages/ContactSupport.razor`, the
`contact-support` template entry (`HasHtmlTemplate: false`), and the
plain-text-only send path in `MailerSendEmailTransport.RenderPlainTextOnly`
against issue #72's requirements. If they hold up, close #72 on GitHub with a
comment pointing at the commits that satisfy it — no code changes.

## Out of scope

- Customer-facing invoice history/listing UI (explicitly excluded by #73).
- Backfilling the other missing `RenewalReceipt` model tokens
  (`productName`, `amount`, `periodEnd`, `paymentMethodLabel`, `actionUrl`) —
  pre-existing gap, not requested by #74.
- `R2_PUBLIC_BASE_URL` — not needed; presigned URLs are computed from the R2
  account endpoint, not a public base URL.
