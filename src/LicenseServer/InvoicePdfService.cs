using LicenseServer.Data;
using Microsoft.Extensions.Options;

namespace LicenseServer;

internal sealed class InvoiceIssuerOptions
{
    public string? BusinessName { get; set; }
    public string? BusinessAddress { get; set; }
    public string? BusinessAbn { get; set; }
    public string? BusinessEmail { get; set; }
    public string TaxLabel { get; set; } = "GST";
}

// AmountMinor fields are the same minor-unit money the document's formatted strings already
// display - kept alongside the display strings so LicenseOrderInvoice can store queryable
// amounts without re-parsing InvoiceMoneyFormatter's output.
internal sealed record InvoicePdfRequest(
    Guid LicenseOrderId,
    InvoiceDocumentData Document,
    string Currency,
    long SubtotalMinor,
    long DiscountMinor,
    long TaxMinor,
    long TotalMinor,
    string? StripePaymentIntentId,
    string? StripeChargeId);

internal interface IInvoicePdfService
{
    Task<string> GenerateAndStoreAsync(InvoicePdfRequest request, CancellationToken cancellationToken = default);
}

// Orchestrates: render InvoiceDocumentData -> store to R2 -> persist the LicenseOrderInvoice
// row (the queryable order<->Stripe-payment link, for refund lookup). Callers build the
// InvoiceDocumentData themselves from whichever Stripe object actually has the data (a real
// Stripe Invoice for renewals, a Checkout Session for one-time purchases - see
// StripeInvoiceDataProvider / PurchaseInvoiceStripeDataProvider). Returns the R2 object key on
// success. Throws on any failure - call sites catch this so a PDF failure never blocks the
// license issuance/renewal or its email.
internal sealed class InvoicePdfService(
    IInvoicePdfRenderer renderer,
    IInvoiceStorage storage,
    ApplicationDbContext db,
    TimeProvider clock) : IInvoicePdfService
{
    public async Task<string> GenerateAndStoreAsync(InvoicePdfRequest request, CancellationToken cancellationToken = default)
    {
        var pdfBytes = renderer.Render(request.Document);
        var key = InvoiceObjectKey.For(request.LicenseOrderId);
        await storage.StoreAsync(key, pdfBytes, cancellationToken);
        db.LicenseOrderInvoices.Add(new LicenseOrderInvoice
        {
            Id = Guid.NewGuid(),
            LicenseOrderId = request.LicenseOrderId,
            InvoiceNumber = request.Document.InvoiceId,
            StripePaymentIntentId = request.StripePaymentIntentId,
            StripeChargeId = request.StripeChargeId,
            Currency = request.Currency,
            SubtotalMinor = request.SubtotalMinor,
            DiscountMinor = request.DiscountMinor,
            TaxMinor = request.TaxMinor,
            TotalMinor = request.TotalMinor,
            PaymentMethodLabel = request.Document.PaymentMethodLabel,
            CreatedAt = clock.GetUtcNow()
        });
        await db.SaveChangesAsync(cancellationToken);
        return key;
    }
}
