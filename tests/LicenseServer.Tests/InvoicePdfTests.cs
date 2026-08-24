using LicenseServer.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using QuestPDF.Infrastructure;

namespace LicenseServer.Tests;

public sealed class InvoicePdfRendererTests
{
    static InvoicePdfRendererTests() => QuestPDF.Settings.License = LicenseType.Community;

    [Fact]
    public void RenderProducesAValidPdfForFullData()
    {
        var renderer = new InvoicePdfRenderer();

        var bytes = renderer.Render(SampleData());

        Assert.True(bytes.Length > 100);
        Assert.Equal("%PDF", System.Text.Encoding.ASCII.GetString(bytes, 0, 4));
    }

    [Fact]
    public void RenderProducesAValidPdfWithNoLineItems()
    {
        var renderer = new InvoicePdfRenderer();
        var data = SampleData() with { LineItems = [] };

        var bytes = renderer.Render(data);

        Assert.True(bytes.Length > 100);
        Assert.Equal("%PDF", System.Text.Encoding.ASCII.GetString(bytes, 0, 4));
    }

    [Fact]
    public void RenderProducesAValidPdfWithADiscountApplied()
    {
        var renderer = new InvoicePdfRenderer();
        var data = SampleData() with { DiscountAmount = "-$25.00" };

        var bytes = renderer.Render(data);

        Assert.True(bytes.Length > 100);
        Assert.Equal("%PDF", System.Text.Encoding.ASCII.GetString(bytes, 0, 4));
    }

    internal static InvoiceDocumentData SampleData() => new(
        InvoiceId: "INV-1001",
        InvoiceDate: "1 Jan 2026",
        DueDate: "1 Jan 2026",
        BusinessName: "RePass Cloud Pty Ltd",
        BusinessAddress: "1 Example St, Adelaide SA 5000",
        BusinessAbn: "12 345 678 901",
        BusinessEmail: "billing@repasscloud.com",
        CustomerName: "Jane Buyer",
        CustomerEmail: "jane@example.test",
        BillingAddress: "",
        ProductName: "Acme Widget Pro",
        EditionName: "Enterprise",
        SeatCount: 25,
        BillingPeriod: "1 Jan 2026 - 1 Jan 2027",
        LineItems: [new InvoiceLineItemDisplay("Enterprise seats", "25", "$500.00")],
        Subtotal: "$500.00",
        DiscountAmount: "",
        TaxLabel: "GST",
        TaxAmount: "$50.00",
        TotalDue: "$550.00",
        PaymentMethodLabel: "Visa •••• 4242");
}

public sealed class InvoiceObjectKeyTests
{
    [Fact]
    public void ForProducesADeterministicKeyFromTheOrderId()
    {
        var orderId = Guid.Parse("11111111-2222-3333-4444-555555555555");

        Assert.Equal("invoices/11111111222233334444555555555555.pdf", InvoiceObjectKey.For(orderId));
    }
}

public sealed class R2InvoiceStorageTests
{
    [Fact]
    public async Task ExistsAsyncReturnsFalseWhenR2IsNotConfigured()
    {
        var storage = new R2InvoiceStorage(Microsoft.Extensions.Options.Options.Create(new R2Options()), TimeProvider.System);

        Assert.False(await storage.ExistsAsync("invoices/missing.pdf"));
    }

    [Fact]
    public async Task StoreAsyncThrowsWhenR2IsNotConfigured()
    {
        var storage = new R2InvoiceStorage(Microsoft.Extensions.Options.Options.Create(new R2Options()), TimeProvider.System);

        await Assert.ThrowsAsync<InvalidOperationException>(() => storage.StoreAsync("invoices/x.pdf", [1, 2, 3]));
    }

    [Fact]
    public async Task GetPresignedDownloadUrlAsyncComputesASignedUrlWithoutANetworkCall()
    {
        var storage = new R2InvoiceStorage(Microsoft.Extensions.Options.Options.Create(new R2Options
        {
            AccountId = "test-account",
            AccessKeyId = "AKIDTEST",
            SecretAccessKey = "secret-test-key",
            BucketName = "invoices-test"
        }), TimeProvider.System);

        var url = await storage.GetPresignedDownloadUrlAsync("invoices/abc.pdf", TimeSpan.FromMinutes(10));

        Assert.StartsWith(
            "https://test-account.r2.cloudflarestorage.com/invoices-test/invoices/abc.pdf",
            url.ToString(), StringComparison.Ordinal);
        Assert.Contains("X-Amz-Signature=", url.ToString(), StringComparison.Ordinal);
    }
}

public sealed class InvoiceMoneyFormatterTests
{
    [Theory]
    [InlineData(55000, "aud", "$550.00")]
    [InlineData(999, "usd", "$9.99")]
    [InlineData(100, "eur", "€1.00")]
    [InlineData(100, "gbp", "£1.00")]
    [InlineData(500, "xyz", "XYZ 5.00")]
    public void FormatRendersMinorUnitsWithACurrencySymbol(long minorUnits, string currency, string expected) =>
        Assert.Equal(expected, InvoiceMoneyFormatter.Format(minorUnits, currency));
}

public sealed class StripeInvoiceDataProviderTests
{
    [Fact]
    public void SumTaxAmountAddsMultipleTaxRatesCorrectly()
    {
        var taxes = new List<Stripe.InvoiceTotalTax>
        {
            new() { Amount = 500 },
            new() { Amount = 250 }
        };

        Assert.Equal(750, StripeInvoiceDataProvider.SumTaxAmount(taxes));
    }

    [Fact]
    public void SumTaxAmountReturnsZeroForNullOrEmpty()
    {
        Assert.Equal(0, StripeInvoiceDataProvider.SumTaxAmount(null));
        Assert.Equal(0, StripeInvoiceDataProvider.SumTaxAmount(new List<Stripe.InvoiceTotalTax>()));
    }

    [Fact]
    public void SumDiscountAmountAddsMultipleDiscountsCorrectly()
    {
        var discounts = new List<Stripe.InvoiceDiscountAmount>
        {
            new() { Amount = 500 },
            new() { Amount = 250 }
        };

        Assert.Equal(750, StripeInvoiceDataProvider.SumDiscountAmount(discounts));
    }

    [Fact]
    public void SumDiscountAmountReturnsZeroForNullOrEmpty()
    {
        Assert.Equal(0, StripeInvoiceDataProvider.SumDiscountAmount(null));
        Assert.Equal(0, StripeInvoiceDataProvider.SumDiscountAmount(new List<Stripe.InvoiceDiscountAmount>()));
    }
}

// InvoicePdfService no longer fetches Stripe data itself (callers build InvoiceDocumentData from
// whichever Stripe object actually has it - a real Invoice for renewals, a Checkout Session for
// purchases); it renders, stores to R2, and persists the LicenseOrderInvoice row, so these tests
// need a real ApplicationDbContext rather than a fake, hence the Postgres fixture.
[Collection(PostgresTestSuite.Name)]
public sealed class InvoicePdfServiceTests(PostgresWebFixture fixture)
{
    [Fact]
    public async Task GenerateAndStoreAsyncStoresRenderedBytesAndPersistsTheLicenseOrderInvoiceRow()
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var renderer = new FakeInvoicePdfRenderer([1, 2, 3]);
        var storage = new FakeInvoiceStorage();
        var service = new InvoicePdfService(renderer, storage, db, TimeProvider.System);
        var orderId = await SeedOrderAsync(db);
        // A random-per-run invoice number, not a fixed literal: this test's Postgres fixture is a
        // long-lived database shared across test runs, and the row it inserts here is never
        // cleaned up, so a fixed literal collides with the unique index on a second run.
        var invoiceNumber = $"INV-TEST-{Guid.NewGuid():N}"[..24];
        var document = InvoicePdfRendererTests.SampleData() with { InvoiceId = invoiceNumber };

        var key = await service.GenerateAndStoreAsync(new InvoicePdfRequest(
            orderId, document, "AUD", 50000, 2500, 5000, 52500, "pi_test_1", "ch_test_1"));

        Assert.Equal(InvoiceObjectKey.For(orderId), key);
        Assert.Equal(key, storage.StoredKey);
        Assert.Equal(new byte[] { 1, 2, 3 }, storage.StoredContent);
        Assert.Same(document, renderer.CapturedData);

        db.ChangeTracker.Clear();
        var row = await db.LicenseOrderInvoices.AsNoTracking().SingleAsync(item => item.LicenseOrderId == orderId);
        Assert.Equal(invoiceNumber, row.InvoiceNumber);
        Assert.Equal("pi_test_1", row.StripePaymentIntentId);
        Assert.Equal("ch_test_1", row.StripeChargeId);
        Assert.Equal("AUD", row.Currency);
        Assert.Equal(50000, row.SubtotalMinor);
        Assert.Equal(2500, row.DiscountMinor);
        Assert.Equal(5000, row.TaxMinor);
        Assert.Equal(52500, row.TotalMinor);
        Assert.Equal(document.PaymentMethodLabel, row.PaymentMethodLabel);
    }

    private static async Task<Guid> SeedOrderAsync(ApplicationDbContext db)
    {
        var marker = Guid.NewGuid().ToString("N");
        var customer = new Customer
        {
            Id = Guid.NewGuid(),
            Name = "Jane Buyer",
            Email = $"invoice-svc-{marker}@example.test",
            NormalizedEmail = $"invoice-svc-{marker}@example.test",
            CreatedAt = DateTimeOffset.UtcNow
        };
        var product = new ProductDefinition
        {
            Id = Guid.NewGuid(),
            Code = $"invoice-svc-{marker}",
            DisplayName = "Acme Widget Pro",
            IsActive = true,
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        };
        var order = new LicenseOrder
        {
            Id = Guid.NewGuid(),
            Customer = customer,
            CustomerId = customer.Id,
            ProductDefinition = product,
            ProductDefinitionId = product.Id,
            Kind = "purchase",
            Status = "paid",
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        };
        db.Customers.Add(customer);
        db.ProductDefinitions.Add(product);
        db.LicenseOrders.Add(order);
        await db.SaveChangesAsync();
        return order.Id;
    }

    private sealed class FakeInvoicePdfRenderer(byte[] bytes) : IInvoicePdfRenderer
    {
        public InvoiceDocumentData? CapturedData { get; private set; }
        public byte[] Render(InvoiceDocumentData data)
        {
            CapturedData = data;
            return bytes;
        }
    }

    private sealed class FakeInvoiceStorage : IInvoiceStorage
    {
        public string? StoredKey { get; private set; }
        public byte[]? StoredContent { get; private set; }

        public Task StoreAsync(string key, byte[] content, CancellationToken cancellationToken = default)
        {
            StoredKey = key;
            StoredContent = content;
            return Task.CompletedTask;
        }

        public Task<bool> ExistsAsync(string key, CancellationToken cancellationToken = default) =>
            Task.FromResult(StoredKey == key);

        public Task<Uri> GetPresignedDownloadUrlAsync(string key, TimeSpan validFor, CancellationToken cancellationToken = default) =>
            Task.FromResult(new Uri($"https://example.test/{key}"));
    }
}

