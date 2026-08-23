using System.Globalization;
using Microsoft.Extensions.Options;
using Stripe;

namespace LicenseServer;

internal sealed record StripeInvoiceData(
    string Number,
    string BillingPeriod,
    string Subtotal,
    string TaxAmount,
    string Total,
    string PaymentMethodLabel,
    IReadOnlyList<InvoiceLineItemDisplay> LineItems);

// Single business scenario: minor-unit currencies only (cents-based), which covers every
// currency this business actually bills in. Zero-decimal currencies (e.g. JPY) are out of scope.
internal static class InvoiceMoneyFormatter
{
    public static string Format(long minorUnits, string currencyCode)
    {
        var amount = minorUnits / 100m;
        var symbol = currencyCode.ToUpperInvariant() switch
        {
            "AUD" or "USD" or "NZD" or "CAD" => "$",
            "EUR" => "€",
            "GBP" => "£",
            var code => code + " "
        };
        return $"{symbol}{amount.ToString("0.00", CultureInfo.InvariantCulture)}";
    }
}

internal interface IInvoiceStripeDataProvider
{
    Task<StripeInvoiceData?> FetchAsync(string stripeInvoiceId, CancellationToken cancellationToken = default);
}

// Follows the same nullable-client-guard pattern as StripeCurrentStateFetcher (BillingPolicies.cs):
// with no Stripe:ApiKey configured, FetchAsync returns null rather than throwing at construction.
internal sealed class StripeInvoiceDataProvider : IInvoiceStripeDataProvider
{
    private readonly StripeClient? client;

    public StripeInvoiceDataProvider(IOptions<StripeOptions> options)
    {
        if (!string.IsNullOrWhiteSpace(options.Value.ApiKey))
            client = new StripeClient(options.Value.ApiKey);
    }

    public async Task<StripeInvoiceData?> FetchAsync(string stripeInvoiceId, CancellationToken cancellationToken = default)
    {
        if (client is null) return null;
        var service = new InvoiceService(client);
        var invoice = await service.GetAsync(stripeInvoiceId,
            new InvoiceGetOptions { Expand = ["default_payment_method"] },
            cancellationToken: cancellationToken);
        var currency = invoice.Currency;
        var card = invoice.DefaultPaymentMethod?.Card;
        var lineItems = invoice.Lines.Data
            .Select(line => new InvoiceLineItemDisplay(
                line.Description ?? string.Empty,
                (line.Quantity ?? 1).ToString(CultureInfo.InvariantCulture),
                InvoiceMoneyFormatter.Format(line.Amount, currency)))
            .ToList();
        return new StripeInvoiceData(
            Number: invoice.Number ?? invoice.Id,
            BillingPeriod: $"{invoice.PeriodStart:d MMM yyyy} - {invoice.PeriodEnd:d MMM yyyy}",
            Subtotal: InvoiceMoneyFormatter.Format(invoice.Subtotal, currency),
            TaxAmount: InvoiceMoneyFormatter.Format(invoice.Total - invoice.Subtotal, currency),
            Total: InvoiceMoneyFormatter.Format(invoice.Total, currency),
            PaymentMethodLabel: card is not null
                ? $"{CapitalizeBrand(card.Brand)} •••• {card.Last4}"
                : "Payment on file",
            LineItems: lineItems);
    }

    private static string CapitalizeBrand(string brand) =>
        string.IsNullOrEmpty(brand) ? "Card" : char.ToUpperInvariant(brand[0]) + brand[1..];
}
