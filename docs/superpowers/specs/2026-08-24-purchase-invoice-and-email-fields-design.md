# Purchase invoice generation + purchase-confirmation email fields

Date: 2026-08-24

## Problem

The purchase-confirmation email (`purchase-activation.html`) is missing Edition,
Seats, Expiry, and a working "Request machine-wide code" link, because the model
dictionary built in `BillingPolicies.cs` only supplies `licenseId` and
`activationCode`. Separately, no invoice PDF is ever generated for one-time
purchases: PDF generation only runs on the subscription-renewal path, and even
there it depends on a Stripe Invoice object, which one-time purchases don't
have (no `invoice_creation` on the Payment Link). The business also wants the
Stripe payment reference (PaymentIntent/Charge ID) captured against the order
so a refund can be looked up later, and wants this relationship (license order
→ Stripe payment) queryable in the database, not just embedded in a PDF.

## Decisions already made with the user

- Invoice PDF links point at the existing `/invoices/{orderId}/pdf` presigned-redirect
  endpoint (already built, already used by renewals) — no public R2 URL, no new env var.
- `expiryDate` renders as the literal string `"Perpetual"` for non-expiring licenses.
- `editionName` uses the raw edition value already resolved elsewhere in `BillingPolicies` —
  no new display-name mapping.
- `machineWideUrl` points at the existing `/support/contact` Razor page, which already
  accepts `Reason` and `LicenseId` query params for prefilling: `/support/contact?Reason=machine-wide-activation&LicenseId={licenseId}`.
- One-time purchases don't get a Stripe Invoice — the business generates its own invoice
  PDF/number, not Stripe's.
- The renderer (`InvoicePdfRenderer`/`InvoiceDocumentData`) is data-source-agnostic and
  is being kept as-is (plain QuestPDF layout) for this piece of work; visual restyling is
  out of scope here.

## Scope of this change

1. Populate the purchase-confirmation email model (bug fix).
2. Generate an invoice PDF for one-time purchases, sourced from the Stripe Checkout
   Session (not a Stripe Invoice), store it in R2 under the existing
   `invoices/{orderId:N}.pdf` key convention, and link it from the purchase email.
3. Persist a `LicenseOrderInvoice` DB row per order (purchase or renewal) recording our
   own invoice number, the Stripe PaymentIntent ID and Charge ID (for refund lookup),
   currency, and amounts — the queryable link between a license order and its Stripe
   payment, independent of the PDF file itself.

## Data model change

New entity `LicenseOrderInvoice` (1:1 with `LicenseOrder`, keyed by `LicenseOrderId`):

```
Id                        Guid
LicenseOrderId            Guid (unique FK -> LicenseOrder)
InvoiceNumber             string (unique)
StripePaymentIntentId     string?
StripeChargeId            string?
Currency                  string
SubtotalMinor             long
DiscountMinor             long
TaxMinor                  long
TotalMinor                long
PaymentMethodLabel        string?
CreatedAt                 DateTimeOffset
```

New counter table `InvoiceNumberCounter` (`BusinessDate`, `LastValue`), same
upsert-with-`RETURNING` pattern as `LicenseIdCounter`/`LicenseIdAllocator`, driving a new
`InvoiceNumberAllocator` that must run inside the ambient DB transaction (same constraint
as `LicenseIdAllocator`). Format: `INV-{yyyy}-{MMdd}{value:X6}`. Only the purchase path
uses this allocator — renewals keep using Stripe's own invoice `Number`, since a real
Stripe Invoice exists there.

## Purchase invoice data source

New `IPurchaseInvoiceStripeDataProvider` fetches the Checkout Session (not an Invoice) via
`Stripe.Checkout.SessionService`, expanding `payment_intent.payment_method` and
`payment_intent.latest_charge`. Checkout Sessions in `payment` mode carry `AmountSubtotal`,
`AmountTotal`, `Currency`, and `TotalDetails.{AmountDiscount,AmountTax}` directly — no
separate PaymentIntent amount lookup is needed. Card brand/last4 come from
`session.PaymentIntent.PaymentMethod.Card`; the refund-lookup IDs come from
`session.PaymentIntentId` and `session.PaymentIntent.LatestChargeId`.

Because a one-time purchase is single-product, the line-item list is a single synthesized
row: `"{ProductName} – {EditionName} ({SeatCount} seat(s), Perpetual)"`, qty 1, amount =
subtotal. This mirrors how `InvoicePdfRenderer` already documents purchases are
"single-product, not multi-line-item" (see `SumDiscountAmount` comment in
`InvoiceStripeData.cs`).

## Service shape change

`InvoicePdfService` currently: fetch Stripe Invoice → build `InvoiceDocumentData` → render
→ store to R2. It's being generalized so both call sites (renewal, purchase) build their
own `InvoiceDocumentData` (each from their own Stripe data provider) and hand it, plus the
Stripe payment reference IDs, to the service — which renders, stores to R2, and now also
persists the `LicenseOrderInvoice` row in the same DB transaction as the rest of the
webhook-processing work (so a PDF/DB failure rolls back together with nothing partially
committed, and the existing `catch` in the call sites — "a PDF failure never blocks the
receipt email" — still applies unchanged).

```csharp
internal sealed record InvoicePdfRequest(
    Guid LicenseOrderId,
    InvoiceDocumentData Document,
    string? StripePaymentIntentId,
    string? StripeChargeId);

internal interface IInvoicePdfService
{
    Task<string> GenerateAndStoreAsync(InvoicePdfRequest request, CancellationToken cancellationToken = default);
}
```

Renewal path (`RenewalAsync`/`TryGenerateInvoicePdfUrlAsync`): keeps calling
`StripeInvoiceDataProvider.FetchAsync(invoiceId)`, now also asked to return
`PaymentIntentId`/`ChargeId` (both already reachable off the expanded invoice payments
data), and builds the same `InvoicePdfRequest` shape.

Purchase path (`PurchaseAsync`): after the license/order is created (same place the
`PurchaseActivation` email is currently queued with an incomplete model), calls the new
`IPurchaseInvoiceStripeDataProvider`, allocates an invoice number, builds
`InvoiceDocumentData`, calls `IInvoicePdfService.GenerateAndStoreAsync`, then builds the
full email model including `invoicePdfUrl` pointed at `/invoices/{order.Id}/pdf` (same
presigned-redirect endpoint renewals already use). PDF generation failure is caught the
same way as the renewal path — it must never block issuing the license or sending the
activation email.

## Email template change

Add an "Invoice" link/button to `purchase-activation.html`, in the same style family as
the existing sections, pointing at `{{invoicePdfUrl}}`. Populate the full model dict:
`productName`, `editionName`, `seatCount`, `expiryDate` ("Perpetual" or formatted date),
`machineWideUrl`, `invoicePdfUrl`, plus the existing `licenseId`/`activationCode`.

## Testing

- Unit tests for `InvoiceNumberAllocator` (format, per-day increment) mirroring
  `LicenseIdAllocator` test conventions if present.
- Unit tests for the purchase-confirmation email model builder (Perpetual formatting,
  machine-wide URL construction).
- Unit test for `IPurchaseInvoiceStripeDataProvider` mapping (amounts, card label,
  payment intent/charge id extraction) using a faked Checkout Session shape, mirroring
  the existing `StripeInvoiceDataProvider` test style if present.
- Integration-style test (if the existing suite has one for `PurchaseAsync`) asserting a
  `LicenseOrderInvoice` row is created and the email model contains the new fields.

## Out of scope

- Restyling the invoice PDF (QuestPDF layout kept as-is).
- Enabling Stripe's own invoice generation on Payment Links.
- Any refund/dispute workflow UI — this only makes the PaymentIntent/Charge ID
  queryable for manual lookup when a refund is needed.
- A customer-facing portal page listing orders/invoices (explicitly not needed yet
  per the user).
