using System.Globalization;
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

internal sealed record InvoicePdfRequest(
    Guid LicenseOrderId,
    string StripeInvoiceId,
    string CustomerName,
    string CustomerEmail,
    string ProductName,
    string EditionName,
    int SeatCount);

internal interface IInvoicePdfService
{
    Task<string> GenerateAndStoreAsync(InvoicePdfRequest request, CancellationToken cancellationToken = default);
}

// Orchestrates: fetch Stripe invoice data -> build InvoiceDocumentData -> render -> store.
// Returns the R2 object key on success. Throws on any failure - the RenewalAsync call site
// (Task 7) catches this so a PDF failure never blocks the renewal or its receipt email.
internal sealed class InvoicePdfService(
    IInvoiceStripeDataProvider stripeData,
    IInvoicePdfRenderer renderer,
    IInvoiceStorage storage,
    IOptions<InvoiceIssuerOptions> issuerOptions,
    TimeProvider clock) : IInvoicePdfService
{
    public async Task<string> GenerateAndStoreAsync(InvoicePdfRequest request, CancellationToken cancellationToken = default)
    {
        var stripeInvoice = await stripeData.FetchAsync(request.StripeInvoiceId, cancellationToken)
            ?? throw new InvalidOperationException(
                $"Stripe invoice '{request.StripeInvoiceId}' could not be retrieved for PDF generation.");
        var issuer = issuerOptions.Value;
        var now = clock.GetUtcNow();
        var document = new InvoiceDocumentData(
            InvoiceId: stripeInvoice.Number,
            InvoiceDate: now.ToString("d MMM yyyy", CultureInfo.InvariantCulture),
            DueDate: now.ToString("d MMM yyyy", CultureInfo.InvariantCulture),
            BusinessName: issuer.BusinessName ?? string.Empty,
            BusinessAddress: issuer.BusinessAddress ?? string.Empty,
            BusinessAbn: issuer.BusinessAbn ?? string.Empty,
            BusinessEmail: issuer.BusinessEmail ?? string.Empty,
            CustomerName: request.CustomerName,
            CustomerEmail: request.CustomerEmail,
            BillingAddress: string.Empty,
            ProductName: request.ProductName,
            EditionName: request.EditionName,
            SeatCount: request.SeatCount,
            BillingPeriod: stripeInvoice.BillingPeriod,
            LineItems: stripeInvoice.LineItems,
            Subtotal: stripeInvoice.Subtotal,
            TaxLabel: issuer.TaxLabel,
            TaxAmount: stripeInvoice.TaxAmount,
            TotalDue: stripeInvoice.Total,
            PaymentMethodLabel: stripeInvoice.PaymentMethodLabel);
        var pdfBytes = renderer.Render(document);
        var key = InvoiceObjectKey.For(request.LicenseOrderId);
        await storage.StoreAsync(key, pdfBytes, cancellationToken);
        return key;
    }
}
