using System.Globalization;
using Microsoft.Extensions.Options;
using Stripe;

namespace LicenseServer;

internal sealed record StripeInvoiceData(
    string Number,
    string InvoiceDate,
    string DueDate,
    string BillingPeriod,
    string Subtotal,
    string DiscountAmount,
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
            new InvoiceGetOptions
            {
                Expand = ["default_payment_method", "payments.data.payment.payment_intent.payment_method"]
            },
            cancellationToken: cancellationToken);
        var currency = invoice.Currency;
        var card = ResolvePaymentMethodCard(invoice);
        var lineItems = invoice.Lines.Data
            .Select(line => new InvoiceLineItemDisplay(
                line.Description ?? string.Empty,
                (line.Quantity ?? 1).ToString(CultureInfo.InvariantCulture),
                InvoiceMoneyFormatter.Format(line.Amount, currency)))
            .ToList();
        return new StripeInvoiceData(
            Number: invoice.Number ?? invoice.Id,
            InvoiceDate: FormatDate(invoice.Created),
            DueDate: FormatDate(invoice.DueDate ?? invoice.Created),
            BillingPeriod: $"{invoice.PeriodStart:d MMM yyyy} - {invoice.PeriodEnd:d MMM yyyy}",
            Subtotal: InvoiceMoneyFormatter.Format(invoice.Subtotal, currency),
            DiscountAmount: FormatDiscount(invoice.TotalDiscountAmounts, currency),
            TaxAmount: InvoiceMoneyFormatter.Format(SumTaxAmount(invoice.TotalTaxes), currency),
            Total: InvoiceMoneyFormatter.Format(invoice.Total, currency),
            PaymentMethodLabel: card is not null
                ? $"{CapitalizeBrand(card.Brand)} •••• {card.Last4}"
                : "Payment on file",
            LineItems: lineItems);
    }

    // A paid invoice's actual charged card usually lives on its Payments collection, not
    // DefaultPaymentMethod (which is only set when explicitly overridden on the invoice - renewals
    // normally leave it null and inherit from the subscription/customer instead).
    private static PaymentMethodCard? ResolvePaymentMethodCard(Invoice invoice) =>
        invoice.Payments?.Data?
            .Select(payment => payment.Payment?.PaymentIntent?.PaymentMethod?.Card)
            .FirstOrDefault(card => card is not null)
        ?? invoice.DefaultPaymentMethod?.Card;

    // Extracted so the summation logic is unit-testable without a live Stripe call: Total - Subtotal
    // is wrong whenever a discount/coupon is applied (can go negative), so the real per-tax-rate
    // amounts from Stripe's own totals are summed instead.
    internal static long SumTaxAmount(IEnumerable<InvoiceTotalTax>? totalTaxes) =>
        totalTaxes?.Sum(tax => tax.Amount) ?? 0;

    // Purchases here are single-product, not multi-line-item, so there is nothing to itemize per
    // discount - only a total. Extracted (like SumTaxAmount) so it's unit-testable without a live
    // Stripe call.
    internal static long SumDiscountAmount(IEnumerable<InvoiceDiscountAmount>? totalDiscountAmounts) =>
        totalDiscountAmounts?.Sum(discount => discount.Amount) ?? 0;

    // Renders as empty (not "$0.00") when no discount was applied, so InvoicePdfRenderer can omit
    // the whole discount line rather than always showing a zero row on every invoice.
    private static string FormatDiscount(IEnumerable<InvoiceDiscountAmount>? totalDiscountAmounts, string currency)
    {
        var amount = SumDiscountAmount(totalDiscountAmounts);
        return amount > 0 ? $"-{InvoiceMoneyFormatter.Format(amount, currency)}" : string.Empty;
    }

    private static string FormatDate(DateTime value) => value.ToString("d MMM yyyy", CultureInfo.InvariantCulture);

    private static string CapitalizeBrand(string brand) =>
        string.IsNullOrEmpty(brand) ? "Card" : char.ToUpperInvariant(brand[0]) + brand[1..];
}
