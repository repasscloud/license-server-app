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
        var storage = new R2InvoiceStorage(Microsoft.Extensions.Options.Options.Create(new R2Options()));

        Assert.False(await storage.ExistsAsync("invoices/missing.pdf"));
    }

    [Fact]
    public async Task StoreAsyncThrowsWhenR2IsNotConfigured()
    {
        var storage = new R2InvoiceStorage(Microsoft.Extensions.Options.Options.Create(new R2Options()));

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
        }));

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

