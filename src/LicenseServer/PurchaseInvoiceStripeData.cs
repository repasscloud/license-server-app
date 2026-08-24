using Microsoft.Extensions.Options;
using Stripe;
using Stripe.Checkout;

namespace LicenseServer;

internal sealed record PurchaseInvoiceStripeData(
    string Currency,
    long SubtotalMinor,
    long DiscountMinor,
    long TaxMinor,
    long TotalMinor,
    string PaymentMethodLabel,
    string? PaymentIntentId,
    string? ChargeId);

internal interface IPurchaseInvoiceStripeDataProvider
{
    Task<PurchaseInvoiceStripeData?> FetchAsync(string checkoutSessionId, CancellationToken cancellationToken = default);
}

// One-time purchases don't have a Stripe Invoice (invoice_creation isn't enabled on the
// Payment Link), so unlike StripeInvoiceDataProvider this reads amounts and the payment
// reference straight off the Checkout Session and its expanded PaymentIntent, rather than a
// Stripe Invoice. Follows the same nullable-client-guard pattern as StripeInvoiceDataProvider.
internal sealed class PurchaseInvoiceStripeDataProvider : IPurchaseInvoiceStripeDataProvider
{
    private readonly StripeClient? client;

    public PurchaseInvoiceStripeDataProvider(IOptions<StripeOptions> options)
    {
        if (!string.IsNullOrWhiteSpace(options.Value.ApiKey))
            client = new StripeClient(options.Value.ApiKey);
    }

    public async Task<PurchaseInvoiceStripeData?> FetchAsync(string checkoutSessionId, CancellationToken cancellationToken = default)
    {
        if (client is null) return null;
        var service = new SessionService(client);
        var session = await service.GetAsync(checkoutSessionId,
            new SessionGetOptions { Expand = ["payment_intent.payment_method", "payment_intent.latest_charge"] },
            cancellationToken: cancellationToken);
        var currency = session.Currency ?? "usd";
        var card = session.PaymentIntent?.PaymentMethod?.Card;
        var totals = session.TotalDetails;
        return new PurchaseInvoiceStripeData(
            Currency: currency,
            SubtotalMinor: session.AmountSubtotal ?? session.AmountTotal ?? 0,
            DiscountMinor: totals?.AmountDiscount ?? 0,
            TaxMinor: totals?.AmountTax ?? 0,
            TotalMinor: session.AmountTotal ?? 0,
            PaymentMethodLabel: card is not null
                ? $"{CapitalizeBrand(card.Brand)} •••• {card.Last4}"
                : "Payment on file",
            PaymentIntentId: session.PaymentIntentId,
            ChargeId: session.PaymentIntent?.LatestChargeId);
    }

    private static string CapitalizeBrand(string brand) =>
        string.IsNullOrEmpty(brand) ? "Card" : char.ToUpperInvariant(brand[0]) + brand[1..];
}
