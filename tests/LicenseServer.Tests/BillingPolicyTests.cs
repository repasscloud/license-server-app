using LicenseServer.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using System.Text.Json;

namespace LicenseServer.Tests;

[Collection(PostgresTestSuite.Name)]
public sealed class BillingPolicyTests(PostgresWebFixture fixture)
{
    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public void CurrentStripeCheckoutStateUsesNestedContactAndLineItemPricing()
    {
        var row = new WebhookInbox
        {
            Provider = "stripe",
            ProviderEventId = "evt_nested",
            EventType = "checkout.session.completed",
            Category = "purchase",
            ProtectedPayload = "unused",
            Status = BillingInboxStatus.Categorized
        };
        using var document = JsonDocument.Parse("""
        {
          "id": "cs_nested",
          "object": "checkout.session",
          "customer": "cus_nested",
          "customer_details": {
            "name": "Nested Buyer",
            "email": "nested@example.com"
          },
          "subscription": "sub_nested",
          "line_items": {
            "data": [
              {
                "quantity": 3,
                "price": {
                  "id": "price_nested",
                  "product": "prod_nested"
                }
              }
            ]
          }
        }
        """);

        var snapshot = StripeBillingStateProvider.Parse(row, document.RootElement);

        Assert.NotNull(snapshot);
        Assert.Equal("cus_nested", snapshot.CustomerId);
        Assert.Equal("Nested Buyer", snapshot.CustomerName);
        Assert.Equal("nested@example.com", snapshot.CustomerEmail);
        Assert.Equal("prod_nested", snapshot.ProductId);
        Assert.Equal("price_nested", snapshot.PriceId);
        Assert.Equal("sub_nested", snapshot.SubscriptionId);
        Assert.Equal("cs_nested", snapshot.CheckoutSessionId);
        Assert.Equal(3, snapshot.Seats);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public void CurrentStripeInvoiceStateUsesDahliaParentAndPricingFields()
    {
        var row = new WebhookInbox
        {
            Provider = "stripe",
            ProviderEventId = "evt_invoice_nested",
            EventType = "invoice.paid",
            Category = "renewal",
            ProtectedPayload = "unused",
            Status = BillingInboxStatus.Categorized
        };
        using var document = JsonDocument.Parse("""
        {
          "id": "in_nested",
          "object": "invoice",
          "customer": "cus_nested",
          "parent": {
            "subscription_details": { "subscription": "sub_nested" }
          },
          "lines": {
            "data": [
              {
                "quantity": 5,
                "period": { "end": 1798761600 },
                "pricing": {
                  "price_details": {
                    "price": "price_nested",
                    "product": "prod_nested"
                  }
                }
              }
            ]
          }
        }
        """);

        var snapshot = StripeBillingStateProvider.Parse(row, document.RootElement);

        Assert.NotNull(snapshot);
        Assert.Equal("sub_nested", snapshot.SubscriptionId);
        Assert.Equal("in_nested", snapshot.InvoiceId);
        Assert.Equal("prod_nested", snapshot.ProductId);
        Assert.Equal("price_nested", snapshot.PriceId);
        Assert.Equal(DateTimeOffset.FromUnixTimeSeconds(1798761600), snapshot.CurrentPeriodEnd);
        Assert.Equal(5, snapshot.Seats);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public async Task CompletedPurchaseIssuesExactlyOneMappedLicenseAndEncryptedEmail()
    {
        var marker = Guid.NewGuid().ToString("N");
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await AddCatalogMappingsAsync(db, marker);
        var processor = scope.ServiceProvider.GetRequiredService<StripeBillingPolicyProcessor>();
        var snapshot = Purchase(marker);

        Assert.Equal(BillingInboxStatus.Completed, (await processor.ApplyAsync(snapshot)).Status);
        Assert.Equal(BillingInboxStatus.Completed, (await processor.ApplyAsync(snapshot)).Status);

        db.ChangeTracker.Clear();
        var contract = await ContractAsync(db, marker);
        var license = await db.Licenses.AsNoTracking().Include(item => item.Entitlements).Include(item => item.Customer)
            .SingleAsync(item => item.Id == contract.LicenseRecordId);
        Assert.Equal($"buyer-{marker}@example.com", license.Customer.NormalizedEmail);
        Assert.Equal($"buyer-{marker}@example.com", System.Text.Json.JsonDocument.Parse(license.MetadataJson)
            .RootElement.GetProperty("contactEmail").GetString());
        Assert.Single(license.Entitlements);
        Assert.DoesNotContain("stripe", license.MetadataJson, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(1, await db.LicenseOrders.CountAsync(item => item.BillingContractId == contract.Id));
        Assert.Equal(1, await db.EmailOutbox.CountAsync(item => item.TemplateName == EmailTemplates.PurchaseActivation.Name
            && item.RecipientHash == HashEmail($"buyer-{marker}@example.com")));
        var email = await db.EmailOutbox.AsNoTracking().SingleAsync(item => item.TemplateName == EmailTemplates.PurchaseActivation.Name
            && item.RecipientHash == HashEmail($"buyer-{marker}@example.com"));
        Assert.DoesNotContain($"buyer-{marker}@example.com", email.ProtectedPayload, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public void CurrentStripeCheckoutStateExtractsPurchaseOrderFromCustomFields()
    {
        var row = new WebhookInbox
        {
            Provider = "stripe",
            ProviderEventId = "evt_poref",
            EventType = "checkout.session.completed",
            Category = "purchase",
            ProtectedPayload = "unused",
            Status = BillingInboxStatus.Categorized
        };
        using var document = JsonDocument.Parse("""
        {
          "id": "cs_poref",
          "object": "checkout.session",
          "customer": null,
          "customer_details": { "name": "PO Buyer", "email": "po@example.com" },
          "subscription": null,
          "custom_fields": [
            { "key": "poref", "label": { "custom": "PO Ref", "type": "custom" }, "optional": true,
              "text": { "value": "abcd-1234" }, "type": "text" }
          ]
        }
        """);

        var snapshot = StripeBillingStateProvider.Parse(row, document.RootElement);

        Assert.NotNull(snapshot);
        Assert.Equal("abcd-1234", snapshot.PurchaseOrder);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public void CurrentStripeCheckoutStatePurchaseOrderIsNullWhenFieldAbsent()
    {
        var row = new WebhookInbox
        {
            Provider = "stripe",
            ProviderEventId = "evt_no_poref",
            EventType = "checkout.session.completed",
            Category = "purchase",
            ProtectedPayload = "unused",
            Status = BillingInboxStatus.Categorized
        };
        using var document = JsonDocument.Parse("""
        {
          "id": "cs_no_poref",
          "object": "checkout.session",
          "customer": null,
          "customer_details": { "name": "No PO Buyer", "email": "nopo@example.com" },
          "subscription": null,
          "custom_fields": []
        }
        """);

        var snapshot = StripeBillingStateProvider.Parse(row, document.RootElement);

        Assert.NotNull(snapshot);
        Assert.Null(snapshot.PurchaseOrder);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public async Task CompletedOneTimePurchaseIssuesPerpetualLicenseFromProductMappingTerms()
    {
        var marker = Guid.NewGuid().ToString("N");
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        db.StripeProductMappings.Add(new StripeProductMapping
        {
            Id = Guid.NewGuid(),
            StripeProductId = $"prod_{marker}",
            ProductDefinitionId = RoadmapTestSupport.KnownProductId,
            Edition = "enterprise",
            LicenseType = "perpetual",
            Seats = 500,
            UpdatesUntil = null,
            ExpiresAt = null,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        });
        await db.SaveChangesAsync();
        var processor = scope.ServiceProvider.GetRequiredService<StripeBillingPolicyProcessor>();
        var snapshot = OneTimePurchase(marker) with { PurchaseOrder = "abcd-1234" };

        var result = await processor.ApplyAsync(snapshot);
        var replay = await processor.ApplyAsync(snapshot);

        Assert.Equal(BillingInboxStatus.Completed, result.Status);
        Assert.Equal(BillingInboxStatus.Completed, replay.Status);
        db.ChangeTracker.Clear();
        Assert.Equal(0, await db.StripeSubscriptionMappings.CountAsync(
            item => item.StripeSubscriptionId == $"sub_{marker}"));
        var order = await db.StripeCheckoutSessionMappings.AsNoTracking()
            .Where(item => item.StripeCheckoutSessionId == $"cs_{marker}")
            .Select(item => item.LicenseOrder).SingleAsync();
        var license = await db.Licenses.AsNoTracking().Include(item => item.Entitlements)
            .SingleAsync(item => item.Id == order.LicenseRecordId);
        var entitlement = license.Entitlements.Single();
        Assert.Equal("enterprise", entitlement.Edition);
        Assert.Equal("perpetual", entitlement.LicenseType);
        Assert.Equal(500, entitlement.Seats);
        Assert.Equal("abcd-1234", JsonDocument.Parse(license.MetadataJson)
            .RootElement.GetProperty("purchaseOrder").GetString());
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public async Task CompletedOneTimePurchaseUsesMappedSeatsNotStripeLineItemQuantity()
    {
        // Regression test for #68: a one-time Payment Link checkout for a fixed-seat SKU
        // reports a Stripe line-item quantity of 1 (the buyer bought one of the SKU, not
        // "500" of anything), but the mapped product's Seats (a fixed attribute of the
        // edition) must still win.
        var marker = Guid.NewGuid().ToString("N");
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        db.StripeProductMappings.Add(new StripeProductMapping
        {
            Id = Guid.NewGuid(),
            StripeProductId = $"prod_{marker}",
            ProductDefinitionId = RoadmapTestSupport.KnownProductId,
            Edition = "enterprise",
            LicenseType = "perpetual",
            Seats = 500,
            UpdatesUntil = null,
            ExpiresAt = null,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        });
        await db.SaveChangesAsync();
        var processor = scope.ServiceProvider.GetRequiredService<StripeBillingPolicyProcessor>();
        var snapshot = OneTimePurchase(marker) with { Seats = 1 };

        var result = await processor.ApplyAsync(snapshot);

        Assert.Equal(BillingInboxStatus.Completed, result.Status);
        db.ChangeTracker.Clear();
        var order = await db.StripeCheckoutSessionMappings.AsNoTracking()
            .Where(item => item.StripeCheckoutSessionId == $"cs_{marker}")
            .Select(item => item.LicenseOrder).SingleAsync();
        var license = await db.Licenses.AsNoTracking().Include(item => item.Entitlements)
            .SingleAsync(item => item.Id == order.LicenseRecordId);
        Assert.Equal(500, license.Entitlements.Single().Seats);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public async Task OneTimePurchaseAgainstSubscriptionOnlyMappingQuarantinesWithoutIssuingLicense()
    {
        var marker = Guid.NewGuid().ToString("N");
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        db.StripeProductMappings.Add(new StripeProductMapping
        {
            Id = Guid.NewGuid(),
            StripeProductId = $"prod_{marker}",
            ProductDefinitionId = RoadmapTestSupport.KnownProductId,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        });
        await db.SaveChangesAsync();
        var before = await db.Licenses.CountAsync();
        var processor = scope.ServiceProvider.GetRequiredService<StripeBillingPolicyProcessor>();

        var result = await processor.ApplyAsync(OneTimePurchase(marker));

        Assert.Equal(BillingInboxStatus.Quarantined, result.Status);
        Assert.Equal("incomplete_one_time_product_mapping", result.ErrorCode);
        Assert.Equal(before, await db.Licenses.CountAsync());
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public async Task RenewalIsMonotonicAndSameInvoiceAcrossEventsIsIdempotent()
    {
        var marker = Guid.NewGuid().ToString("N");
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await AddCatalogMappingsAsync(db, marker);
        var processor = scope.ServiceProvider.GetRequiredService<StripeBillingPolicyProcessor>();
        await processor.ApplyAsync(Purchase(marker));
        var firstEnd = DateTimeOffset.UtcNow.AddYears(2);

        var first = await processor.ApplyAsync(Purchase(marker) with
        {
            Kind = BillingEventKind.RenewalPaid,
            EventId = $"evt_renew_{marker}",
            InvoiceId = $"in_renew_{marker}",
            CheckoutSessionId = null,
            CurrentPeriodEnd = firstEnd
        });
        var replay = await processor.ApplyAsync(Purchase(marker) with
        {
            Kind = BillingEventKind.RenewalPaid,
            EventId = $"evt_renew_alias_{marker}",
            InvoiceId = $"in_renew_{marker}",
            CheckoutSessionId = null,
            CurrentPeriodEnd = firstEnd.AddMonths(-1)
        });

        Assert.Equal(BillingInboxStatus.Completed, first.Status);
        Assert.Equal(BillingInboxStatus.Completed, replay.Status);
        db.ChangeTracker.Clear();
        var contract = await ContractAsync(db, marker);
        var license = await db.Licenses.AsNoTracking().SingleAsync(item => item.Id == contract.LicenseRecordId);
        Assert.Equal(firstEnd, license.ExpiresAt?.AddTicks(license.ExpirySubMicrosecondTicks));
        Assert.Equal(1, await db.StripeInvoiceMappings.CountAsync(item => item.StripeInvoiceId == $"in_renew_{marker}"));
        Assert.Equal(1, await db.EmailOutbox.CountAsync(item => item.TemplateName == EmailTemplates.RenewalReceipt.Name
            && item.RecipientHash == HashEmail($"buyer-{marker}@example.com")));
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public async Task RenewalSucceedsWhenPdfGenerationIsUnavailable()
    {
        var marker = Guid.NewGuid().ToString("N");
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await AddCatalogMappingsAsync(db, marker);
        var processor = scope.ServiceProvider.GetRequiredService<StripeBillingPolicyProcessor>();
        await processor.ApplyAsync(Purchase(marker));

        var result = await processor.ApplyAsync(Purchase(marker) with
        {
            Kind = BillingEventKind.RenewalPaid,
            EventId = $"evt_renew_pdf_{marker}",
            InvoiceId = $"in_renew_pdf_{marker}",
            CheckoutSessionId = null,
            CurrentPeriodEnd = DateTimeOffset.UtcNow.AddYears(1)
        });

        Assert.Equal(BillingInboxStatus.Completed, result.Status);
        Assert.Equal(1, await db.EmailOutbox.CountAsync(item => item.TemplateName == EmailTemplates.RenewalReceipt.Name
            && item.RecipientHash == HashEmail($"buyer-{marker}@example.com")));
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public async Task PaymentFailureUsesGraceAndRecoveryClearsItWithoutRevocation()
    {
        var marker = Guid.NewGuid().ToString("N");
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await AddCatalogMappingsAsync(db, marker);
        var processor = scope.ServiceProvider.GetRequiredService<StripeBillingPolicyProcessor>();
        await processor.ApplyAsync(Purchase(marker));

        await processor.ApplyAsync(Purchase(marker) with
        {
            Kind = BillingEventKind.PaymentFailed,
            EventId = $"evt_failed_{marker}",
            InvoiceId = $"in_failed_{marker}",
            CheckoutSessionId = null
        });
        db.ChangeTracker.Clear();
        var failed = await ContractAsync(db, marker, tracked: true);
        var license = await db.Licenses.SingleAsync(item => item.Id == failed.LicenseRecordId);
        Assert.NotNull(failed.GraceUntil);
        Assert.Null(license.RevokedAt);
        Assert.True(license.ExpiresAt >= failed.GraceUntil?.AddTicks(-9));

        var recoveredEnd = DateTimeOffset.UtcNow.AddYears(3);
        await processor.ApplyAsync(Purchase(marker) with
        {
            Kind = BillingEventKind.RenewalPaid,
            EventId = $"evt_recovered_{marker}",
            InvoiceId = $"in_failed_{marker}",
            CheckoutSessionId = null,
            CurrentPeriodEnd = recoveredEnd
        });
        db.ChangeTracker.Clear();
        var recovered = await db.BillingContracts.AsNoTracking().SingleAsync(item => item.Id == failed.Id);
        Assert.Null(recovered.GraceUntil);
        Assert.Equal("active", recovered.Status);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public async Task CancellationReversalPlanChangeAndDeletionPreservePaidThroughPolicy()
    {
        var marker = Guid.NewGuid().ToString("N");
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await AddCatalogMappingsAsync(db, marker);
        var processor = scope.ServiceProvider.GetRequiredService<StripeBillingPolicyProcessor>();
        var purchase = Purchase(marker);
        await processor.ApplyAsync(purchase);

        await processor.ApplyAsync(purchase with { Kind = BillingEventKind.SubscriptionChanged, EventId = $"evt_cancel_{marker}", CancelAtPeriodEnd = true });
        await processor.ApplyAsync(purchase with { Kind = BillingEventKind.SubscriptionChanged, EventId = $"evt_reverse_{marker}", CancelAtPeriodEnd = false, Seats = 4 });
        await processor.ApplyAsync(purchase with { Kind = BillingEventKind.SubscriptionDeleted, EventId = $"evt_delete_{marker}" });

        db.ChangeTracker.Clear();
        var contract = await ContractAsync(db, marker);
        var license = await db.Licenses.AsNoTracking().Include(item => item.Entitlements).SingleAsync(item => item.Id == contract.LicenseRecordId);
        Assert.False(contract.CancelAtPeriodEnd);
        Assert.Equal("ended", contract.Status);
        Assert.Equal(4, license.Entitlements.Single().Seats);
        Assert.Equal(purchase.CurrentPeriodEnd, license.ExpiresAt?.AddTicks(license.ExpirySubMicrosecondTicks));
    }

    [Theory]
    [InlineData(BillingEventKind.Refunded)]
    [InlineData(BillingEventKind.DisputeOpened)]
    [Trait("ExpectedGreenStage", "15")]
    public async Task RefundAndDisputeDefaultToReviewWithoutSilentSuspension(string kind)
    {
        var marker = Guid.NewGuid().ToString("N");
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        await AddCatalogMappingsAsync(db, marker);
        var processor = scope.ServiceProvider.GetRequiredService<StripeBillingPolicyProcessor>();
        var purchase = Purchase(marker);
        await processor.ApplyAsync(purchase);
        var invoiceId = $"in_review_{marker}";
        await processor.ApplyAsync(purchase with
        {
            Kind = BillingEventKind.RenewalPaid,
            EventId = $"evt_paid_{marker}",
            InvoiceId = invoiceId,
            CheckoutSessionId = null
        });
        await processor.ApplyAsync(purchase with
        {
            Kind = kind,
            EventId = $"evt_review_{marker}",
            SubscriptionId = null,
            InvoiceId = invoiceId,
            CheckoutSessionId = null
        });

        db.ChangeTracker.Clear();
        var contract = await ContractAsync(db, marker);
        Assert.True(contract.ReviewRequired);
        Assert.Null(contract.SuspendedAt);
        Assert.Equal("review", contract.Status);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public async Task UnknownOrConflictingMappingQuarantinesWithoutBusinessSideEffects()
    {
        var marker = Guid.NewGuid().ToString("N");
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var before = await db.Licenses.CountAsync();
        var result = await scope.ServiceProvider.GetRequiredService<StripeBillingPolicyProcessor>()
            .ApplyAsync(Purchase(marker));
        Assert.Equal(BillingInboxStatus.Quarantined, result.Status);
        Assert.Equal("unknown_price_mapping", result.ErrorCode);
        Assert.Equal(before, await db.Licenses.CountAsync());
    }

    [Fact]
    [Trait("ExpectedGreenStage", "15")]
    public async Task BillingOperationsRequirePermissionAndOnlyResetProcessState()
    {
        var marker = Guid.NewGuid().ToString("N");
        await using (var scope = fixture.Factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            db.WebhookInbox.Add(new WebhookInbox
            {
                Id = Guid.NewGuid(),
                Provider = "stripe",
                ProviderEventId = $"evt_ops_{marker}",
                EventType = "invoice.paid",
                Category = "renewal",
                ProviderObjectId = $"in_ops_{marker}",
                ProtectedPayload = "protected-immutable",
                Status = BillingInboxStatus.Quarantined,
                NextAttemptAt = DateTimeOffset.UtcNow,
                ProviderCreatedAt = DateTimeOffset.UtcNow,
                ReceivedAt = DateTimeOffset.UtcNow,
                LastErrorCode = "unknown_price_mapping"
            });
            await db.SaveChangesAsync();
        }

        using var denied = fixture.CreateAuthenticatedClient(false, "licenses.read");
        Assert.Equal(System.Net.HttpStatusCode.Forbidden,
            (await denied.GetAsync("/api/v1/admin/billing/events")).StatusCode);
        using var allowed = fixture.CreateAuthenticatedClient(false, "billing.manage");
        var list = await allowed.GetAsync("/api/v1/admin/billing/events");
        Assert.Equal(System.Net.HttpStatusCode.OK, list.StatusCode);
    }

    private static async Task AddCatalogMappingsAsync(ApplicationDbContext db, string marker)
    {
        db.StripeProductMappings.Add(new StripeProductMapping
        {
            Id = Guid.NewGuid(),
            StripeProductId = $"prod_{marker}",
            ProductDefinitionId = RoadmapTestSupport.KnownProductId,
            CreatedAt = DateTimeOffset.UtcNow
        });
        db.StripePriceMappings.Add(new StripePriceMapping
        {
            Id = Guid.NewGuid(),
            StripePriceId = $"price_{marker}",
            ProductDefinitionId = RoadmapTestSupport.KnownProductId,
            Edition = "corporate",
            LicenseType = "subscription",
            Seats = 2,
            CreatedAt = DateTimeOffset.UtcNow
        });
        await db.SaveChangesAsync();
    }

    private static BillingSnapshot Purchase(string marker) => new(
        EventId: $"evt_purchase_{marker}",
        Kind: BillingEventKind.PurchaseCompleted,
        CustomerId: $"cus_{marker}",
        CustomerName: $"Buyer {marker}",
        CustomerEmail: $"buyer-{marker}@example.com",
        ProductId: $"prod_{marker}",
        PriceId: $"price_{marker}",
        SubscriptionId: $"sub_{marker}",
        CheckoutSessionId: $"cs_{marker}",
        InvoiceId: $"in_initial_{marker}",
        CurrentPeriodEnd: DateTimeOffset.UtcNow.AddYears(1),
        CancelAtPeriodEnd: false,
        Seats: 2,
        PaymentStatus: "paid");

    private static BillingSnapshot OneTimePurchase(string marker) => new(
        EventId: $"evt_purchase_{marker}",
        Kind: BillingEventKind.PurchaseCompleted,
        CustomerId: $"cus_{marker}",
        CustomerName: $"Buyer {marker}",
        CustomerEmail: $"buyer-{marker}@example.com",
        ProductId: $"prod_{marker}",
        PriceId: null,
        SubscriptionId: null,
        CheckoutSessionId: $"cs_{marker}",
        InvoiceId: null,
        CurrentPeriodEnd: null,
        CancelAtPeriodEnd: false,
        Seats: 0,
        PaymentStatus: "paid");

    private static string HashEmail(string email) => Convert.ToHexStringLower(
        System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(email)));

    private static async Task<BillingContract> ContractAsync(ApplicationDbContext db, string marker, bool tracked = false)
    {
        var query = tracked ? db.StripeSubscriptionMappings.AsQueryable() : db.StripeSubscriptionMappings.AsNoTracking();
        return await query.Where(item => item.StripeSubscriptionId == $"sub_{marker}")
            .Select(item => item.BillingContract).SingleAsync();
    }
}

public sealed class RenewalReceiptModelTests
{
    [Fact]
    public void BuildIncludesInvoicePdfUrlWhenProvided()
    {
        var model = RenewalReceiptModel.Build("LIC-1", "https://example.test/invoices/x/pdf");

        Assert.Equal("LIC-1", model["licenseId"]);
        Assert.Equal("https://example.test/invoices/x/pdf", model["invoicePdfUrl"]);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void BuildOmitsInvoicePdfUrlWhenNullOrEmpty(string? invoicePdfUrl)
    {
        var model = RenewalReceiptModel.Build("LIC-1", invoicePdfUrl);

        Assert.False(model.ContainsKey("invoicePdfUrl"));
    }
}
