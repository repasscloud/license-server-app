using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LicenseServer.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Stripe;

namespace LicenseServer;

internal static class BillingEventKind
{
    public const string PurchaseCompleted = "purchase_completed";
    public const string RenewalPaid = "renewal_paid";
    public const string PaymentFailed = "payment_failed";
    public const string SubscriptionChanged = "subscription_changed";
    public const string SubscriptionDeleted = "subscription_deleted";
    public const string Refunded = "refunded";
    public const string DisputeOpened = "dispute_opened";
}

internal sealed record BillingSnapshot(
    string EventId,
    string Kind,
    string? CustomerId,
    string? CustomerName,
    string? CustomerEmail,
    string? ProductId,
    string? PriceId,
    string? SubscriptionId,
    string? CheckoutSessionId,
    string? InvoiceId,
    DateTimeOffset? CurrentPeriodEnd,
    bool CancelAtPeriodEnd,
    int Seats,
    string? PaymentStatus,
    string? PurchaseOrder = null);

internal sealed record OneTimePurchaseTerms(
    ProductDefinition Product,
    string Edition,
    string LicenseType,
    int Seats,
    DateOnly? UpdatesUntil,
    DateTimeOffset? ExpiresAt);

internal sealed class BillingPolicyOptions
{
    public int GracePeriodDays { get; set; } = 7;
    public string RefundAction { get; set; } = "review";
    public string DisputeAction { get; set; } = "review";
}

// Pure and DB/network-free on purpose: RenewalAsync's PDF-generation failure path is exercised
// via the Postgres-backed suite (no R2/Stripe configured there), but the model-shape logic
// itself - keep licenseId, add invoicePdfUrl only when present - is unit-tested directly.
internal static class RenewalReceiptModel
{
    public static Dictionary<string, string> Build(string licenseId, string? invoicePdfUrl)
    {
        var model = new Dictionary<string, string> { ["licenseId"] = licenseId };
        if (!string.IsNullOrEmpty(invoicePdfUrl))
            model["invoicePdfUrl"] = invoicePdfUrl;
        return model;
    }
}

// Pure and DB/network-free for the same reason as RenewalReceiptModel: the model-shape logic
// (Perpetual formatting, machine-wide URL construction, omitting invoicePdfUrl when PDF
// generation failed) is unit-tested directly rather than only through the webhook-processing suite.
internal static class PurchaseActivationEmailModel
{
    public static Dictionary<string, string> Build(
        string licenseId, string activationCode, string productName, string editionName, int seatCount,
        DateTimeOffset? expiresAt, string publicBaseUrl, string? invoicePdfUrl)
    {
        var model = new Dictionary<string, string>
        {
            ["licenseId"] = licenseId,
            ["activationCode"] = activationCode,
            ["productName"] = productName,
            ["editionName"] = editionName,
            ["seatCount"] = seatCount.ToString(CultureInfo.InvariantCulture),
            ["expiryDate"] = expiresAt is null
                ? "Perpetual"
                : expiresAt.Value.ToString("d MMM yyyy", CultureInfo.InvariantCulture),
            ["machineWideUrl"] = $"{publicBaseUrl}/support/contact" +
                $"?Reason={Uri.EscapeDataString(ContactSupportReasons.MachineWideActivation)}" +
                $"&LicenseId={Uri.EscapeDataString(licenseId)}"
        };
        if (!string.IsNullOrEmpty(invoicePdfUrl))
            model["invoicePdfUrl"] = invoicePdfUrl;
        return model;
    }
}

internal sealed class StripeBillingPolicyProcessor(
    ApplicationDbContext db,
    LicenseStore licenses,
    ITransactionalEmailSender emails,
    IInvoicePdfService invoicePdf,
    IInvoiceStripeDataProvider invoiceStripeData,
    IPurchaseInvoiceStripeDataProvider purchaseInvoiceStripeData,
    InvoiceNumberAllocator invoiceNumbers,
    IOptions<BillingPolicyOptions> options,
    IOptions<InvoiceIssuerOptions> invoiceIssuer,
    TimeProvider clock,
    IConfiguration configuration,
    IWebHostEnvironment environment,
    ILogger<StripeBillingPolicyProcessor> logger)
{
    private static readonly Action<ILogger, Guid, Exception> LogInvoicePdfGenerationFailed = LoggerMessage.Define<Guid>(
        LogLevel.Warning, new EventId(1501, "InvoicePdfGenerationFailed"),
        "Invoice PDF generation failed for license order {LicenseOrderId}; renewal receipt queued without invoicePdfUrl.");

    public async Task<BillingEventProcessResult> ApplyAsync(
        BillingSnapshot snapshot,
        CancellationToken cancellationToken = default)
    {
        var stableKey = snapshot.SubscriptionId ?? snapshot.InvoiceId ?? snapshot.CheckoutSessionId ?? snapshot.EventId;
        var lockKey = BitConverter.ToInt64(SHA256.HashData(Encoding.UTF8.GetBytes(stableKey)), 0);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await db.Database.ExecuteSqlInterpolatedAsync($"SELECT pg_advisory_xact_lock({lockKey})", cancellationToken);
        var result = snapshot.Kind switch
        {
            BillingEventKind.PurchaseCompleted => await PurchaseAsync(snapshot, cancellationToken),
            BillingEventKind.RenewalPaid => await RenewalAsync(snapshot, cancellationToken),
            BillingEventKind.PaymentFailed => await PaymentFailedAsync(snapshot, cancellationToken),
            BillingEventKind.SubscriptionChanged => await SubscriptionChangedAsync(snapshot, cancellationToken),
            BillingEventKind.SubscriptionDeleted => await SubscriptionDeletedAsync(snapshot, cancellationToken),
            BillingEventKind.Refunded => await ReviewOrSuspendAsync(snapshot, options.Value.RefundAction, "billing.refund", cancellationToken),
            BillingEventKind.DisputeOpened => await ReviewOrSuspendAsync(snapshot, options.Value.DisputeAction, "billing.dispute", cancellationToken),
            _ => BillingEventProcessResult.Ignored()
        };
        if (result.Status == BillingInboxStatus.Quarantined)
        {
            await transaction.RollbackAsync(cancellationToken);
            db.ChangeTracker.Clear();
            return result;
        }
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

    private async Task<BillingEventProcessResult> PurchaseAsync(BillingSnapshot snapshot, CancellationToken cancellationToken)
    {
        if (snapshot.CheckoutSessionId is null || snapshot.ProductId is null)
            return Quarantine("incomplete_purchase_state");
        var isSubscription = snapshot.SubscriptionId is not null;
        // Subscriptions always have a real Stripe customer; only guest/one-time checkouts
        // can legitimately have a null CustomerId (Stripe skipped creating a Customer object).
        if (isSubscription && (snapshot.CustomerId is null || snapshot.PriceId is null || snapshot.CurrentPeriodEnd is null))
            return Quarantine("incomplete_purchase_state");
        if (snapshot.PaymentStatus is not ("paid" or "no_payment_required"))
            return BillingEventProcessResult.Ignored();
        if (await db.StripeCheckoutSessionMappings.AnyAsync(
                item => item.StripeCheckoutSessionId == snapshot.CheckoutSessionId, cancellationToken))
            return Completed();

        ProductDefinition product;
        string edition;
        string licenseType;
        int mappedSeats;
        DateOnly? updatesUntil;
        DateTimeOffset? expiry;
        if (isSubscription)
        {
            var mapped = await ResolveProductAsync(snapshot, cancellationToken);
            if (mapped.Error is not null) return Quarantine(mapped.Error);
            product = mapped.Product!;
            edition = mapped.Price!.Edition;
            licenseType = mapped.Price.LicenseType;
            mappedSeats = mapped.Price.Seats;
            updatesUntil = null;
            expiry = snapshot.CurrentPeriodEnd!.Value;
        }
        else
        {
            var (terms, oneTimeError) = await ResolveOneTimeProductAsync(snapshot, cancellationToken);
            if (oneTimeError is not null) return Quarantine(oneTimeError);
            product = terms!.Product;
            edition = terms.Edition;
            licenseType = terms.LicenseType;
            mappedSeats = terms.Seats;
            updatesUntil = terms.UpdatesUntil;
            expiry = terms.ExpiresAt;
        }
        // For one-time purchases, "seats" is a fixed attribute of the mapped product/edition
        // (StripeProductMappings.Seats), not something the buyer selects via line-item
        // quantity - a checkout for one of these SKUs always has quantity 1 regardless of
        // the edition's seat count, so the Stripe-reported quantity must not override it.
        // Subscriptions genuinely use quantity as a seat multiplier (StripePriceMappings),
        // so that override still applies there. See issue #68.
        var seats = isSubscription && snapshot.Seats > 0 ? snapshot.Seats : mappedSeats;
        if (!CustomerEmails.TryNormalize(snapshot.CustomerEmail, out var normalizedEmail, out _)
            || string.IsNullOrWhiteSpace(snapshot.CustomerName))
            return Quarantine("invalid_customer_contact");

        LicenseServer.Data.Customer customer;
        if (snapshot.CustomerId is null)
        {
            // Guest checkout: Stripe never attached a Customer object (e.g. a payment link
            // configured with customer_creation=if_required). Key identity off the verified
            // checkout email instead of a Stripe customer id, so licensing doesn't depend on
            // how the link happens to be configured on Stripe's side.
            var existing = await db.Customers.SingleOrDefaultAsync(
                item => item.NormalizedEmail == normalizedEmail, cancellationToken);
            if (existing is null)
            {
                customer = new LicenseServer.Data.Customer
                {
                    Id = Guid.NewGuid(),
                    Name = snapshot.CustomerName.Trim(),
                    Email = normalizedEmail!,
                    NormalizedEmail = normalizedEmail!,
                    CreatedAt = clock.GetUtcNow()
                };
                db.Customers.Add(customer);
                await db.SaveChangesAsync(cancellationToken);
            }
            else
            {
                customer = existing;
            }
        }
        else
        {
            var customerMapping = await db.StripeCustomerMappings.Include(item => item.Customer)
                .SingleOrDefaultAsync(item => item.StripeCustomerId == snapshot.CustomerId, cancellationToken);
            if (customerMapping is null)
            {
                customer = new LicenseServer.Data.Customer
                {
                    Id = Guid.NewGuid(),
                    Name = snapshot.CustomerName.Trim(),
                    Email = normalizedEmail!,
                    NormalizedEmail = normalizedEmail!,
                    CreatedAt = clock.GetUtcNow()
                };
                db.Customers.Add(customer);
                db.StripeCustomerMappings.Add(new StripeCustomerMapping
                {
                    Id = Guid.NewGuid(),
                    StripeCustomerId = snapshot.CustomerId,
                    Customer = customer,
                    CustomerId = customer.Id,
                    CreatedAt = clock.GetUtcNow()
                });
                await db.SaveChangesAsync(cancellationToken);
            }
            else
            {
                customer = customerMapping.Customer;
                if (!string.Equals(customer.NormalizedEmail, normalizedEmail, StringComparison.Ordinal))
                    return Quarantine("conflicting_customer_mapping");
            }
        }

        var contract = new BillingContract
        {
            Id = Guid.NewGuid(),
            CustomerId = customer.Id,
            Customer = customer,
            ProductDefinitionId = product.Id,
            ProductDefinition = product,
            Status = "active",
            LicenseType = licenseType,
            Edition = edition,
            Seats = seats,
            CurrentPeriodEnd = expiry,
            CreatedAt = clock.GetUtcNow(),
            UpdatedAt = clock.GetUtcNow()
        };
        var order = new LicenseOrder
        {
            Id = Guid.NewGuid(),
            BillingContract = contract,
            BillingContractId = contract.Id,
            Customer = customer,
            CustomerId = customer.Id,
            ProductDefinition = product,
            ProductDefinitionId = product.Id,
            Kind = "purchase",
            Status = "paid",
            CreatedAt = clock.GetUtcNow(),
            UpdatedAt = clock.GetUtcNow()
        };
        db.BillingContracts.Add(contract);
        db.LicenseOrders.Add(order);
        if (isSubscription)
        {
            db.StripeSubscriptionMappings.Add(new StripeSubscriptionMapping
            {
                Id = Guid.NewGuid(),
                StripeSubscriptionId = snapshot.SubscriptionId!,
                BillingContract = contract,
                BillingContractId = contract.Id,
                CreatedAt = clock.GetUtcNow()
            });
        }
        db.StripeCheckoutSessionMappings.Add(new StripeCheckoutSessionMapping
        {
            Id = Guid.NewGuid(),
            StripeCheckoutSessionId = snapshot.CheckoutSessionId,
            LicenseOrder = order,
            LicenseOrderId = order.Id,
            CreatedAt = clock.GetUtcNow()
        });
        await db.SaveChangesAsync(cancellationToken);

        var issued = await licenses.IssueForBillingAsync(new IssueLicenseRequest(
                customer.Name, customer.Email, product.Id, edition, licenseType,
                expiry, seats, updatesUntil,
                snapshot.PurchaseOrder is null
                    ? null
                    : new Dictionary<string, object?> { ["purchaseOrder"] = snapshot.PurchaseOrder }),
            customer, new IssuanceContext("billing:stripe", snapshot.EventId, snapshot.EventId, null), cancellationToken);
        if (!issued.Success) return Quarantine("license_issuance_failed");
        var issuedValue = issued.Value!;
        var license = await db.Licenses.SingleAsync(item => item.LicenseId == issuedValue.LicenseId, cancellationToken);
        contract.License = license;
        contract.LicenseRecordId = license.Id;
        order.License = license;
        order.LicenseRecordId = license.Id;
        // Only one-time (perpetual) purchases generate their own invoice PDF here - subscriptions
        // get one per renewal via TryGenerateInvoicePdfUrlAsync, where a real Stripe Invoice exists.
        var invoicePdfUrl = isSubscription
            ? null
            : await TryGeneratePurchaseInvoicePdfUrlAsync(
                order, customer, product, edition, seats, snapshot.CheckoutSessionId, cancellationToken);
        await emails.QueueAsync(new TransactionalEmail(
                EmailTemplates.PurchaseActivation, customer.Email,
                PurchaseActivationEmailModel.Build(
                    issuedValue.LicenseId, issuedValue.ActivationCode, product.DisplayName, edition,
                    seats, expiry, ResolvePublicBaseUrl(), invoicePdfUrl)),
            $"billing:purchase:{snapshot.CheckoutSessionId}", cancellationToken);
        db.AuditRecords.Add(Audit(snapshot, "billing.purchase-completed", contract.Id, new
        {
            customerId = customer.Id,
            productId = product.Id,
            orderId = order.Id,
            licenseId = license.LicenseId,
            oneTime = !isSubscription,
            purchaseOrder = snapshot.PurchaseOrder
        }));
        await db.SaveChangesAsync(cancellationToken);
        return Completed();
    }

    private async Task<(OneTimePurchaseTerms? Terms, string? Error)> ResolveOneTimeProductAsync(
        BillingSnapshot snapshot, CancellationToken cancellationToken)
    {
        var mapping = await db.StripeProductMappings.Include(item => item.ProductDefinition)
            .SingleOrDefaultAsync(item => item.StripeProductId == snapshot.ProductId, cancellationToken);
        if (mapping is null) return (null, "unknown_product_mapping");
        if (mapping.Edition is null || mapping.LicenseType is null || mapping.Seats is null)
            return (null, "incomplete_one_time_product_mapping");
        return (new OneTimePurchaseTerms(
            mapping.ProductDefinition, mapping.Edition, mapping.LicenseType,
            mapping.Seats.Value, mapping.UpdatesUntil, mapping.ExpiresAt), null);
    }

    private async Task<BillingEventProcessResult> RenewalAsync(BillingSnapshot snapshot, CancellationToken cancellationToken)
    {
        if (snapshot.InvoiceId is null || snapshot.CurrentPeriodEnd is null)
            return Quarantine("incomplete_invoice_state");
        if (await db.StripeInvoiceMappings.AnyAsync(item => item.StripeInvoiceId == snapshot.InvoiceId, cancellationToken))
        {
            var existing = await ContractAsync(snapshot, cancellationToken);
            if (existing is not null && existing.GraceUntil is not null)
            {
                existing.GraceUntil = null;
                existing.Status = "active";
                existing.UpdatedAt = clock.GetUtcNow();
                await db.SaveChangesAsync(cancellationToken);
            }
            return Completed();
        }
        var contract = await ContractAsync(snapshot, cancellationToken);
        if (contract?.License is null || contract.ProductDefinition is null)
            return Quarantine("unknown_subscription_mapping");
        var mapped = await ResolveProductAsync(snapshot, cancellationToken, contract);
        if (mapped.Error is not null) return Quarantine(mapped.Error);
        var product = mapped.Product!;
        var price = mapped.Price!;
        var expiry = snapshot.CurrentPeriodEnd.Value;
        if (contract.CurrentPeriodEnd is null || expiry > contract.CurrentPeriodEnd)
        {
            var terms = await licenses.ApplyBillingTermsAsync(
                contract.License, product, price.Edition,
                snapshot.Seats > 0 ? snapshot.Seats : price.Seats,
                expiry, snapshot.EventId, "license.billing-renewed", cancellationToken);
            if (!terms.Success) return Quarantine("license_terms_failed");
            contract.CurrentPeriodEnd = expiry;
            contract.ProductDefinition = product;
            contract.ProductDefinitionId = product.Id;
            contract.Edition = price.Edition;
            contract.Seats = snapshot.Seats > 0 ? snapshot.Seats : price.Seats;
        }
        contract.GraceUntil = null;
        contract.Status = "active";
        contract.UpdatedAt = clock.GetUtcNow();
        var order = new LicenseOrder
        {
            Id = Guid.NewGuid(),
            BillingContractId = contract.Id,
            BillingContract = contract,
            CustomerId = contract.CustomerId,
            Customer = contract.Customer,
            ProductDefinitionId = contract.ProductDefinitionId,
            ProductDefinition = product,
            LicenseRecordId = contract.LicenseRecordId,
            License = contract.License,
            Kind = "renewal",
            Status = "paid",
            CreatedAt = clock.GetUtcNow(),
            UpdatedAt = clock.GetUtcNow()
        };
        db.LicenseOrders.Add(order);
        db.StripeInvoiceMappings.Add(new StripeInvoiceMapping
        {
            Id = Guid.NewGuid(),
            StripeInvoiceId = snapshot.InvoiceId,
            LicenseOrder = order,
            LicenseOrderId = order.Id,
            BillingContract = contract,
            BillingContractId = contract.Id,
            AppliedPeriodEnd = expiry,
            AppliedEventId = snapshot.EventId,
            CreatedAt = clock.GetUtcNow()
        });
        var invoicePdfUrl = await TryGenerateInvoicePdfUrlAsync(order, contract, product, snapshot, cancellationToken);
        await emails.QueueAsync(new TransactionalEmail(
                EmailTemplates.RenewalReceipt, contract.Customer!.Email,
                RenewalReceiptModel.Build(contract.License.LicenseId, invoicePdfUrl)),
            $"billing:renewal:{snapshot.InvoiceId}", cancellationToken);
        db.AuditRecords.Add(Audit(snapshot, "billing.renewal-paid", contract.Id, new
        {
            orderId = order.Id,
            licenseId = contract.License.LicenseId,
            periodEnd = expiry
        }));
        await db.SaveChangesAsync(cancellationToken);
        return Completed();
    }

    private string ResolvePublicBaseUrl() =>
        configuration["CustomerPortal:PublicBaseUrl"]?.TrimEnd('/')
            ?? (environment.IsDevelopment()
                ? "http://localhost:8080"
                : throw new InvalidOperationException("CustomerPortal:PublicBaseUrl is required outside Development."));

    private async Task<string?> TryGenerateInvoicePdfUrlAsync(
        LicenseOrder order, BillingContract contract, ProductDefinition product, BillingSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        try
        {
            var stripeInvoice = await invoiceStripeData.FetchAsync(snapshot.InvoiceId!, cancellationToken)
                ?? throw new InvalidOperationException(
                    $"Stripe invoice '{snapshot.InvoiceId}' could not be retrieved for PDF generation.");
            var issuer = invoiceIssuer.Value;
            var document = new InvoiceDocumentData(
                InvoiceId: stripeInvoice.Number,
                InvoiceDate: stripeInvoice.InvoiceDate,
                DueDate: stripeInvoice.DueDate,
                BusinessName: issuer.BusinessName ?? string.Empty,
                BusinessAddress: issuer.BusinessAddress ?? string.Empty,
                BusinessAbn: issuer.BusinessAbn ?? string.Empty,
                BusinessEmail: issuer.BusinessEmail ?? string.Empty,
                CustomerName: contract.Customer!.Name,
                CustomerEmail: contract.Customer!.Email,
                BillingAddress: string.Empty,
                ProductName: product.DisplayName,
                EditionName: contract.Edition,
                SeatCount: contract.Seats,
                BillingPeriod: stripeInvoice.BillingPeriod,
                LineItems: stripeInvoice.LineItems,
                Subtotal: stripeInvoice.Subtotal,
                DiscountAmount: stripeInvoice.DiscountAmount,
                TaxLabel: issuer.TaxLabel,
                TaxAmount: stripeInvoice.TaxAmount,
                TotalDue: stripeInvoice.Total,
                PaymentMethodLabel: stripeInvoice.PaymentMethodLabel);
            // Bounded: this runs inside RenewalAsync's advisory-lock transaction, so a slow Stripe/R2
            // call must not stall other billing events indefinitely. A timeout here throws
            // TimeoutException (not OperationCanceledException), so it's still caught below as an
            // ordinary PDF-generation failure rather than escaping past the filter as a cancellation.
            await invoicePdf.GenerateAndStoreAsync(new InvoicePdfRequest(
                    order.Id, document, stripeInvoice.Currency,
                    stripeInvoice.SubtotalMinor, stripeInvoice.DiscountMinor, stripeInvoice.TaxMinor, stripeInvoice.TotalMinor,
                    stripeInvoice.PaymentIntentId, stripeInvoice.ChargeId), cancellationToken)
                .WaitAsync(TimeSpan.FromSeconds(20), cancellationToken);
            // order.Id is the same value InvoicePdfService used to derive the R2 object key
            // (InvoiceObjectKey.For) - the download route and the storage key must both stay
            // derived from this one id, or every emailed link 404s.
            return $"{ResolvePublicBaseUrl()}/invoices/{order.Id}/pdf";
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            LogInvoicePdfGenerationFailed(logger, order.Id, exception);
            return null;
        }
    }

    // Purchases have no Stripe Invoice (invoice_creation isn't enabled on the Payment Link), so
    // unlike TryGenerateInvoicePdfUrlAsync this sources amounts from the Checkout Session and
    // generates the business's own invoice number rather than reusing a Stripe one.
    private async Task<string?> TryGeneratePurchaseInvoicePdfUrlAsync(
        LicenseOrder order, LicenseServer.Data.Customer customer, ProductDefinition product, string edition, int seats,
        string checkoutSessionId, CancellationToken cancellationToken)
    {
        try
        {
            var stripeData = await purchaseInvoiceStripeData.FetchAsync(checkoutSessionId, cancellationToken)
                ?? throw new InvalidOperationException(
                    $"Stripe checkout session '{checkoutSessionId}' could not be retrieved for PDF generation.");
            var invoiceNumber = await invoiceNumbers.AllocateAsync(clock.GetUtcNow(), cancellationToken);
            var issuer = invoiceIssuer.Value;
            var issuedDate = clock.GetUtcNow().ToString("d MMM yyyy", CultureInfo.InvariantCulture);
            // Purchases here are single-product, not multi-line-item (see SumDiscountAmount's
            // comment in InvoiceStripeData.cs) - one synthesized line for the whole order.
            var lineItem = new InvoiceLineItemDisplay(
                $"{product.DisplayName} - {edition} ({seats} seat{(seats == 1 ? "" : "s")}, Perpetual)",
                "1",
                InvoiceMoneyFormatter.Format(stripeData.SubtotalMinor, stripeData.Currency));
            var document = new InvoiceDocumentData(
                InvoiceId: invoiceNumber,
                InvoiceDate: issuedDate,
                DueDate: issuedDate,
                BusinessName: issuer.BusinessName ?? string.Empty,
                BusinessAddress: issuer.BusinessAddress ?? string.Empty,
                BusinessAbn: issuer.BusinessAbn ?? string.Empty,
                BusinessEmail: issuer.BusinessEmail ?? string.Empty,
                CustomerName: customer.Name,
                CustomerEmail: customer.Email,
                BillingAddress: string.Empty,
                ProductName: product.DisplayName,
                EditionName: edition,
                SeatCount: seats,
                BillingPeriod: "Perpetual",
                LineItems: [lineItem],
                Subtotal: InvoiceMoneyFormatter.Format(stripeData.SubtotalMinor, stripeData.Currency),
                DiscountAmount: stripeData.DiscountMinor > 0
                    ? $"-{InvoiceMoneyFormatter.Format(stripeData.DiscountMinor, stripeData.Currency)}"
                    : string.Empty,
                TaxLabel: issuer.TaxLabel,
                TaxAmount: InvoiceMoneyFormatter.Format(stripeData.TaxMinor, stripeData.Currency),
                TotalDue: InvoiceMoneyFormatter.Format(stripeData.TotalMinor, stripeData.Currency),
                PaymentMethodLabel: stripeData.PaymentMethodLabel);
            await invoicePdf.GenerateAndStoreAsync(new InvoicePdfRequest(
                    order.Id, document, stripeData.Currency,
                    stripeData.SubtotalMinor, stripeData.DiscountMinor, stripeData.TaxMinor, stripeData.TotalMinor,
                    stripeData.PaymentIntentId, stripeData.ChargeId), cancellationToken)
                .WaitAsync(TimeSpan.FromSeconds(20), cancellationToken);
            return $"{ResolvePublicBaseUrl()}/invoices/{order.Id}/pdf";
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            LogInvoicePdfGenerationFailed(logger, order.Id, exception);
            return null;
        }
    }

    private async Task<BillingEventProcessResult> PaymentFailedAsync(BillingSnapshot snapshot, CancellationToken cancellationToken)
    {
        if (snapshot.InvoiceId is null) return Quarantine("incomplete_invoice_state");
        if (await db.StripeInvoiceMappings.AnyAsync(item => item.StripeInvoiceId == snapshot.InvoiceId, cancellationToken))
            return Completed();
        var contract = await ContractAsync(snapshot, cancellationToken);
        if (contract?.License is null || contract.ProductDefinition is null)
            return Quarantine("unknown_subscription_mapping");
        var graceBase = contract.CurrentPeriodEnd > clock.GetUtcNow() ? contract.CurrentPeriodEnd.Value : clock.GetUtcNow();
        var grace = graceBase.AddDays(Math.Clamp(options.Value.GracePeriodDays, 1, 90));
        if (contract.GraceUntil is null || grace > contract.GraceUntil)
        {
            contract.GraceUntil = grace;
            contract.Status = "grace";
            contract.UpdatedAt = clock.GetUtcNow();
            await licenses.ApplyBillingTermsAsync(
                contract.License, contract.ProductDefinition, contract.Edition, contract.Seats,
                grace, snapshot.EventId, "license.billing-grace-entered", cancellationToken);
            db.AuditRecords.Add(Audit(snapshot, "billing.payment-failed", contract.Id, new
            {
                licenseId = contract.License.LicenseId,
                graceUntil = grace
            }));
        }
        await emails.QueueAsync(new TransactionalEmail(
                EmailTemplates.PaymentFailure, contract.Customer!.Email,
                new Dictionary<string, string> { ["licenseId"] = contract.License.LicenseId }),
            $"billing:payment-failure:{snapshot.InvoiceId}", cancellationToken);
        await db.SaveChangesAsync(cancellationToken);
        return Completed();
    }

    private async Task<BillingEventProcessResult> SubscriptionChangedAsync(BillingSnapshot snapshot, CancellationToken cancellationToken)
    {
        var contract = await ContractAsync(snapshot, cancellationToken);
        if (contract?.License is null || contract.ProductDefinition is null)
            return Quarantine("unknown_subscription_mapping");
        var mapped = await ResolveProductAsync(snapshot, cancellationToken, contract);
        if (mapped.Error is not null) return Quarantine(mapped.Error);
        var product = mapped.Product!;
        var price = mapped.Price!;
        var expiry = snapshot.CurrentPeriodEnd ?? contract.CurrentPeriodEnd;
        if (expiry is null) return Quarantine("missing_paid_through_state");
        await licenses.ApplyBillingTermsAsync(
            contract.License, product, price.Edition,
            snapshot.Seats > 0 ? snapshot.Seats : price.Seats,
            expiry.Value, snapshot.EventId, "license.billing-subscription-changed", cancellationToken);
        contract.ProductDefinition = product;
        contract.ProductDefinitionId = product.Id;
        contract.Edition = price.Edition;
        contract.Seats = snapshot.Seats > 0 ? snapshot.Seats : price.Seats;
        if (snapshot.CurrentPeriodEnd > contract.CurrentPeriodEnd) contract.CurrentPeriodEnd = snapshot.CurrentPeriodEnd;
        contract.CancelAtPeriodEnd = snapshot.CancelAtPeriodEnd;
        contract.Status = snapshot.CancelAtPeriodEnd ? "cancelling" : "active";
        contract.UpdatedAt = clock.GetUtcNow();
        db.AuditRecords.Add(Audit(snapshot, "billing.subscription-changed", contract.Id, new
        {
            productId = product.Id,
            contract.Edition,
            contract.Seats,
            contract.CancelAtPeriodEnd,
            paidThrough = contract.CurrentPeriodEnd
        }));
        await db.SaveChangesAsync(cancellationToken);
        return Completed();
    }

    private async Task<BillingEventProcessResult> SubscriptionDeletedAsync(BillingSnapshot snapshot, CancellationToken cancellationToken)
    {
        var contract = await ContractAsync(snapshot, cancellationToken);
        if (contract is null) return Quarantine("unknown_subscription_mapping");
        contract.Status = "ended";
        contract.UpdatedAt = clock.GetUtcNow();
        db.AuditRecords.Add(Audit(snapshot, "billing.subscription-deleted", contract.Id, new
        {
            paidThrough = contract.CurrentPeriodEnd,
            licenseId = contract.License?.LicenseId
        }));
        await db.SaveChangesAsync(cancellationToken);
        return Completed();
    }

    private async Task<BillingEventProcessResult> ReviewOrSuspendAsync(
        BillingSnapshot snapshot, string configuredAction, string auditAction, CancellationToken cancellationToken)
    {
        var contract = await ContractAsync(snapshot, cancellationToken);
        if (contract?.License is null || contract.ProductDefinition is null)
            return Quarantine("unknown_subscription_mapping");
        contract.ReviewRequired = true;
        contract.Status = "review";
        if (string.Equals(configuredAction, "suspend", StringComparison.Ordinal))
        {
            contract.SuspendedAt = clock.GetUtcNow();
            contract.Status = "suspended";
            await licenses.ApplyBillingTermsAsync(
                contract.License, contract.ProductDefinition, contract.Edition, contract.Seats,
                clock.GetUtcNow().AddTicks(-1), snapshot.EventId, "license.billing-suspended", cancellationToken);
        }
        contract.UpdatedAt = clock.GetUtcNow();
        db.AuditRecords.Add(Audit(snapshot, auditAction, contract.Id, new
        {
            action = configuredAction,
            licenseId = contract.License.LicenseId
        }));
        await db.SaveChangesAsync(cancellationToken);
        return Completed();
    }

    private async Task<BillingContract?> ContractAsync(BillingSnapshot snapshot, CancellationToken cancellationToken)
    {
        if (snapshot.SubscriptionId is not null)
        {
            return await db.StripeSubscriptionMappings
                .Include(item => item.BillingContract).ThenInclude(item => item.Customer)
                .Include(item => item.BillingContract).ThenInclude(item => item.ProductDefinition)
                .Include(item => item.BillingContract).ThenInclude(item => item.License)
                .Where(item => item.StripeSubscriptionId == snapshot.SubscriptionId)
                .Select(item => item.BillingContract)
                .SingleOrDefaultAsync(cancellationToken);
        }
        if (snapshot.InvoiceId is null) return null;
        return await db.StripeInvoiceMappings
            .Include(item => item.BillingContract).ThenInclude(item => item.Customer)
            .Include(item => item.BillingContract).ThenInclude(item => item.ProductDefinition)
            .Include(item => item.BillingContract).ThenInclude(item => item.License)
            .Where(item => item.StripeInvoiceId == snapshot.InvoiceId)
            .Select(item => item.BillingContract)
            .SingleOrDefaultAsync(cancellationToken);
    }

    private async Task<(ProductDefinition? Product, StripePriceMapping? Price, string? Error)> ResolveProductAsync(
        BillingSnapshot snapshot, CancellationToken cancellationToken, BillingContract? fallback = null)
    {
        if (snapshot.PriceId is null || snapshot.ProductId is null)
        {
            if (fallback?.ProductDefinition is not null)
            {
                var fallbackPrice = await db.StripePriceMappings.SingleOrDefaultAsync(
                    item => item.ProductDefinitionId == fallback.ProductDefinitionId, cancellationToken);
                return fallbackPrice is null
                    ? (null, null, "unknown_price_mapping")
                    : (fallback.ProductDefinition, fallbackPrice, null);
            }
            return (null, null, "unknown_price_mapping");
        }
        var price = await db.StripePriceMappings.Include(item => item.ProductDefinition)
            .SingleOrDefaultAsync(item => item.StripePriceId == snapshot.PriceId, cancellationToken);
        if (price is null) return (null, null, "unknown_price_mapping");
        var product = await db.StripeProductMappings.Include(item => item.ProductDefinition)
            .SingleOrDefaultAsync(item => item.StripeProductId == snapshot.ProductId, cancellationToken);
        if (product is null) return (null, null, "unknown_product_mapping");
        if (product.ProductDefinitionId != price.ProductDefinitionId)
            return (null, null, "conflicting_product_mapping");
        return (product.ProductDefinition, price, null);
    }

    private AuditRecord Audit(BillingSnapshot snapshot, string action, Guid contractId, object context) => new()
    {
        Actor = "billing:stripe",
        Action = action,
        TargetType = "billing_contract",
        TargetId = contractId.ToString("D"),
        Result = "success",
        ContextJson = JsonSerializer.Serialize(new { providerEventId = snapshot.EventId, business = context }),
        TimestampUtc = clock.GetUtcNow()
    };

    private static BillingEventProcessResult Completed() => new(BillingInboxStatus.Completed);
    private static BillingEventProcessResult Quarantine(string error) => new(BillingInboxStatus.Quarantined, error);
}

internal interface IStripeBillingStateProvider
{
    Task<BillingSnapshot?> ResolveAsync(WebhookInbox row, CancellationToken cancellationToken = default);
}

internal interface IStripeCurrentStateFetcher
{
    Task<string?> FetchAsync(string objectType, string objectId, CancellationToken cancellationToken = default);
}

internal sealed class StripeCurrentStateFetcher : IStripeCurrentStateFetcher
{
    private readonly StripeClient? client;

    public StripeCurrentStateFetcher(IOptions<StripeOptions> options)
    {
        if (!string.IsNullOrWhiteSpace(options.Value.ApiKey))
            client = new StripeClient(options.Value.ApiKey);
    }

    public async Task<string?> FetchAsync(string objectType, string objectId, CancellationToken cancellationToken = default)
    {
        if (client is null) return null;
        StripeEntity value = objectType switch
        {
            "subscription" => await client.V1.Subscriptions.GetAsync(objectId, cancellationToken: cancellationToken),
            "invoice" => await client.V1.Invoices.GetAsync(objectId, cancellationToken: cancellationToken),
            "checkout.session" => await client.V1.Checkout.Sessions.GetAsync(objectId,
                new Stripe.Checkout.SessionGetOptions
                {
                    Expand = ["line_items", "subscription"]
                }, cancellationToken: cancellationToken),
            "customer" => await client.V1.Customers.GetAsync(objectId, cancellationToken: cancellationToken),
            "charge" => await client.V1.Charges.GetAsync(objectId, cancellationToken: cancellationToken),
            "dispute" => await client.V1.Disputes.GetAsync(objectId,
                new DisputeGetOptions { Expand = ["charge"] }, cancellationToken: cancellationToken),
            _ => throw new InvalidOperationException("Unsupported Stripe object reconciliation type.")
        };
        return value.ToJson();
    }
}

internal sealed class StripeBillingStateProvider(
    StripeWebhookReceiver receiver,
    IStripeCurrentStateFetcher currentState) : IStripeBillingStateProvider
{
    public async Task<BillingSnapshot?> ResolveAsync(WebhookInbox row, CancellationToken cancellationToken = default)
    {
        var raw = receiver.Unprotect(row);
        using var document = JsonDocument.Parse(raw);
        var root = document.RootElement;
        var value = root.GetProperty("data").GetProperty("object");
        if (NeedsCurrentState(row.EventType, value) && row.ProviderObjectId is not null)
        {
            var fetched = await currentState.FetchAsync(ObjectType(row.EventType), row.ProviderObjectId, cancellationToken);
            if (fetched is null) throw new InvalidOperationException("Current Stripe state is unavailable for reconciliation.");
            using var current = JsonDocument.Parse(fetched);
            return Parse(row, current.RootElement);
        }
        return Parse(row, value);
    }

    internal static BillingSnapshot? Parse(WebhookInbox row, JsonElement value)
    {
        var line = FirstData(value, "line_items") ?? FirstData(value, "lines") ?? FirstData(value, "items");
        var price = line is { } lineValue ? Property(lineValue, "price") : null;
        var priceDetails = line is { } currentLine ? Path(currentLine, "pricing", "price_details") : null;
        var subscriptionValue = Property(value, "subscription");
        var customer = StringOrId(value, "customer")
            ?? (ObjectIs(value, "customer") ? String(value, "id") : null);
        var subscription = StringOrId(value, "subscription")
            ?? StringOrId(Path(value, "parent", "subscription_details"), "subscription")
            ?? (ObjectIs(value, "subscription") ? String(value, "id") : null);
        var invoice = ObjectIs(value, "invoice") ? String(value, "id") : StringOrId(value, "invoice");
        invoice ??= StringOrId(Property(value, "charge"), "invoice");
        var checkout = ObjectIs(value, "checkout.session") ? String(value, "id") : null;
        var periodEnd = Unix(value, "current_period_end") ?? Unix(value, "period_end")
            ?? Unix(subscriptionValue, "current_period_end")
            ?? Unix(Path(line, "period"), "end")
            ?? Unix(line, "current_period_end");
        var kind = row.EventType switch
        {
            "checkout.session.completed" or "checkout.session.async_payment_succeeded" => BillingEventKind.PurchaseCompleted,
            "invoice.paid" => BillingEventKind.RenewalPaid,
            "invoice.payment_failed" => BillingEventKind.PaymentFailed,
            "customer.subscription.created" or "customer.subscription.updated" => BillingEventKind.SubscriptionChanged,
            "customer.subscription.deleted" => BillingEventKind.SubscriptionDeleted,
            "charge.refunded" => BillingEventKind.Refunded,
            "charge.dispute.created" => BillingEventKind.DisputeOpened,
            _ => null
        };
        return kind is null ? null : new BillingSnapshot(
            row.ProviderEventId, kind, customer,
            String(value, "customer_name") ?? String(Path(value, "customer_details"), "name"),
            String(value, "customer_email") ?? String(Path(value, "customer_details"), "email"),
            StringOrId(price, "product") ?? String(priceDetails, "product") ?? StringOrId(value, "product"),
            ElementId(price) ?? String(priceDetails, "price") ?? StringOrId(value, "price"),
            subscription, checkout, invoice, periodEnd,
            Bool(value, "cancel_at_period_end") || Bool(subscriptionValue, "cancel_at_period_end"),
            Int(line, "quantity") ?? Int(value, "quantity") ?? 1,
            String(value, "payment_status"),
            PurchaseOrderReference(value));
    }

    private static string? PurchaseOrderReference(JsonElement value)
    {
        if (Property(value, "custom_fields") is not { ValueKind: JsonValueKind.Array } fields) return null;
        foreach (var field in fields.EnumerateArray())
        {
            if (!string.Equals(String(field, "key"), "poref", StringComparison.Ordinal)) continue;
            var reference = String(Path(field, "text"), "value");
            return string.IsNullOrWhiteSpace(reference) ? null : reference;
        }
        return null;
    }

    private static bool NeedsCurrentState(string eventType, JsonElement value)
    {
        var row = new WebhookInbox
        {
            Provider = "stripe",
            ProviderEventId = "state-check",
            EventType = eventType,
            Category = "state-check",
            ProtectedPayload = "unused",
            Status = BillingInboxStatus.Categorized
        };
        var snapshot = Parse(row, value);
        return eventType switch
        {
            "checkout.session.completed" or "checkout.session.async_payment_succeeded" => snapshot is null || snapshot.CustomerId is null
                || snapshot.CustomerName is null || snapshot.CustomerEmail is null
                || snapshot.SubscriptionId is null || snapshot.ProductId is null
                || snapshot.PriceId is null || snapshot.CurrentPeriodEnd is null
                || snapshot.PaymentStatus is null,
            "invoice.paid" => snapshot is null || snapshot.CustomerId is null
                || snapshot.SubscriptionId is null || snapshot.InvoiceId is null
                || snapshot.ProductId is null || snapshot.PriceId is null
                || snapshot.CurrentPeriodEnd is null,
            "invoice.payment_failed" => snapshot is null || snapshot.SubscriptionId is null
                || snapshot.InvoiceId is null,
            "charge.refunded" or "charge.dispute.created" => snapshot is null
                || (snapshot.SubscriptionId is null && snapshot.InvoiceId is null),
            "customer.subscription.created" or "customer.subscription.updated" => true,
            _ => false
        };
    }

    private static string ObjectType(string eventType) => eventType switch
    {
        "checkout.session.completed" or "checkout.session.async_payment_succeeded" => "checkout.session",
        "invoice.paid" or "invoice.payment_failed" => "invoice",
        "charge.refunded" => "charge",
        "charge.dispute.created" => "dispute",
        _ => "subscription"
    };

    private static bool ObjectIs(JsonElement value, string objectType) =>
        value.ValueKind == JsonValueKind.Object && String(value, "object") == objectType;
    private static JsonElement? Property(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property) ? property : null;
    private static JsonElement? Property(JsonElement? value, string name) =>
        value is { } element ? Property(element, name) : null;
    private static JsonElement? Path(JsonElement? value, params string[] names)
    {
        foreach (var name in names)
        {
            value = Property(value, name);
            if (value is null) return null;
        }
        return value;
    }
    private static JsonElement? FirstData(JsonElement value, string collectionName)
    {
        var data = Path(value, collectionName, "data");
        return data is { ValueKind: JsonValueKind.Array } && data.Value.GetArrayLength() > 0
            ? data.Value[0] : null;
    }
    private static string? ElementId(JsonElement? value) => value switch
    {
        { ValueKind: JsonValueKind.String } element => element.GetString(),
        { ValueKind: JsonValueKind.Object } element => String(element, "id"),
        _ => null
    };
    private static string? StringOrId(JsonElement value, string name) => ElementId(Property(value, name));
    private static string? StringOrId(JsonElement? value, string name) => ElementId(Property(value, name));
    private static string? String(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property)
            && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
    private static string? String(JsonElement? value, string name) =>
        value is { } element ? String(element, name) : null;
    private static bool Bool(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property)
            && property.ValueKind is JsonValueKind.True or JsonValueKind.False && property.GetBoolean();
    private static bool Bool(JsonElement? value, string name) => value is { } element && Bool(element, name);
    private static int? Int(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property)
            && property.TryGetInt32(out var number) ? number : null;
    private static int? Int(JsonElement? value, string name) => value is { } element ? Int(element, name) : null;
    private static DateTimeOffset? Unix(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property)
            && property.TryGetInt64(out var seconds)
            ? DateTimeOffset.FromUnixTimeSeconds(seconds) : null;
    private static DateTimeOffset? Unix(JsonElement? value, string name) =>
        value is { } element ? Unix(element, name) : null;
}

internal sealed class StripeBillingEventProcessor(IServiceScopeFactory scopes) : IBillingEventProcessor
{
    public async Task<BillingEventProcessResult> ProcessAsync(WebhookInbox row, CancellationToken cancellationToken = default)
    {
        if (row.Category == "unsupported") return BillingEventProcessResult.Ignored();
        await using var scope = scopes.CreateAsyncScope();
        var state = scope.ServiceProvider.GetRequiredService<IStripeBillingStateProvider>();
        var policy = scope.ServiceProvider.GetRequiredService<StripeBillingPolicyProcessor>();
        // Let ResolveAsync's "current Stripe state is unavailable" failure propagate so the
        // caller's retry-with-backoff/dead-letter handling applies instead of silently
        // dropping the event by marking it terminally categorized.
        var snapshot = await state.ResolveAsync(row, cancellationToken);
        return snapshot is null ? BillingEventProcessResult.Ignored() : await policy.ApplyAsync(snapshot, cancellationToken);
    }
}
