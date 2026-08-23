# PDF Invoices on Cloudflare R2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate a PDF rendition of a renewal invoice, store it privately in Cloudflare R2, serve it through a presigned-redirect download endpoint, and link to it from the `invoice` and `renewal-receipt` transactional emails — closing out #73 and #74. Also verify (no code) that #72 (`ContactSupport`) is fully implemented and close it.

**Architecture:** Five new small files under `src/LicenseServer/` each own one responsibility (PDF rendering, R2 storage, Stripe data fetch, orchestration, and the download endpoint lives in `Program.cs`). `EmailTemplateRenderer` gains a `{{#if key}}...{{/if}}` block-conditional pass. `BillingPolicies.cs`'s `RenewalAsync` calls the new orchestrator and adds `invoicePdfUrl` to the `RenewalReceipt` email model on success, or omits it (never failing the renewal) on any failure.

**Tech Stack:** QuestPDF 2026.6.0 (Community license, pure .NET PDF generation), AWSSDK.S3 4.0.102 (S3-compatible client against Cloudflare R2's endpoint), Stripe.net 52.2.0 (already a dependency; adds one `InvoiceService.GetAsync` call), xUnit with hand-written fakes (no mocking library, matching repo convention).

**Spec:** [docs/superpowers/specs/2026-08-23-invoice-pdf-r2-design.md](../specs/2026-08-23-invoice-pdf-r2-design.md)

## Global Constraints

- No new DB table/column. The R2 object key is derived deterministically from `LicenseOrder.Id`: `invoices/{orderId:N}.pdf`.
- The bucket stays **private**. Downloads go through `GET /invoices/{orderId:guid}/pdf`, which HEAD-checks the object and redirects to a short-lived presigned URL.
- PDF generation/storage failures must never block a renewal or its receipt email — always caught, logged, and degrade to omitting `invoicePdfUrl`.
- No mocking library exists in this repo (`tests/LicenseServer.Tests/LicenseServer.Tests.csproj` has none) — every fake is a hand-written class implementing the relevant interface, matching `MailerSendEmailTransportTests.CapturingHandler` and `StripeCurrentStateFetcher`'s nullable-client-guard style.
- Full Postgres-backed suite (`TEST_POSTGRES_CONNECTION`) must pass before opening the PR.
- Target PR base: `dev`.

---

## Task 1: Invoice PDF renderer (QuestPDF)

**Files:**
- Create: `src/LicenseServer/InvoicePdf.cs`
- Modify: `src/LicenseServer/Program.cs:1-2` (add `using QuestPDF.Infrastructure;` and set the Community license near the top, right after `var builder = WebApplication.CreateBuilder(args);`)
- Modify: `Directory.Packages.props` (add `QuestPDF` version)
- Modify: `src/LicenseServer/LicenseServer.csproj` (add `QuestPDF` package reference)
- Test: `tests/LicenseServer.Tests/InvoicePdfTests.cs`

**Interfaces:**
- Produces: `internal sealed record InvoiceLineItemDisplay(string Description, string Quantity, string Amount)`; `internal sealed record InvoiceDocumentData(string InvoiceId, string InvoiceDate, string DueDate, string BusinessName, string BusinessAddress, string BusinessAbn, string BusinessEmail, string CustomerName, string CustomerEmail, string BillingAddress, string ProductName, string EditionName, int SeatCount, string BillingPeriod, IReadOnlyList<InvoiceLineItemDisplay> LineItems, string Subtotal, string TaxLabel, string TaxAmount, string TotalDue, string PaymentMethodLabel)`; `internal interface IInvoicePdfRenderer { byte[] Render(InvoiceDocumentData data); }`; `internal sealed class InvoicePdfRenderer : IInvoicePdfRenderer`.

- [ ] **Step 1: Add package references**

In `Directory.Packages.props`, add to the `<ItemGroup>` (keep the list alphabetically ordered like the existing entries):

```xml
<PackageVersion Include="QuestPDF" Version="2026.6.0" />
```

In `src/LicenseServer/LicenseServer.csproj`, add to the existing `<ItemGroup>` containing `PackageReference` entries:

```xml
<PackageReference Include="QuestPDF" />
```

- [ ] **Step 2: Write the failing test**

Create `tests/LicenseServer.Tests/InvoicePdfTests.cs`:

```csharp
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `dotnet test tests/LicenseServer.Tests --filter InvoicePdfRendererTests`
Expected: FAIL (compile error) — `InvoicePdfRenderer`, `InvoiceDocumentData`, `InvoiceLineItemDisplay` do not exist yet.

- [ ] **Step 4: Write the minimal implementation**

Create `src/LicenseServer/InvoicePdf.cs`:

```csharp
using QuestPDF.Fluent;
using QuestPDF.Infrastructure;

namespace LicenseServer;

internal sealed record InvoiceLineItemDisplay(string Description, string Quantity, string Amount);

internal sealed record InvoiceDocumentData(
    string InvoiceId,
    string InvoiceDate,
    string DueDate,
    string BusinessName,
    string BusinessAddress,
    string BusinessAbn,
    string BusinessEmail,
    string CustomerName,
    string CustomerEmail,
    string BillingAddress,
    string ProductName,
    string EditionName,
    int SeatCount,
    string BillingPeriod,
    IReadOnlyList<InvoiceLineItemDisplay> LineItems,
    string Subtotal,
    string TaxLabel,
    string TaxAmount,
    string TotalDue,
    string PaymentMethodLabel);

internal interface IInvoicePdfRenderer
{
    byte[] Render(InvoiceDocumentData data);
}

// Builds the PDF from structured data rather than converting invoice.html, so generation needs
// no headless-browser/Chromium dependency in the container. Layout intentionally mirrors
// invoice.html's sections (header, from/billed-to, line items, totals, payment method) without
// being pixel-identical to it.
internal sealed class InvoicePdfRenderer : IInvoicePdfRenderer
{
    public byte[] Render(InvoiceDocumentData data) =>
        Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Margin(36);
                page.Header().Text($"Invoice {data.InvoiceId}").FontSize(20).Bold();
                page.Content().Column(column =>
                {
                    column.Spacing(8);
                    column.Item().Text($"Issued {data.InvoiceDate} - Due {data.DueDate}");
                    column.Item().Row(row =>
                    {
                        row.RelativeItem().Column(from =>
                        {
                            from.Item().Text("From").SemiBold();
                            from.Item().Text(data.BusinessName);
                            from.Item().Text(data.BusinessAddress);
                            from.Item().Text($"ABN {data.BusinessAbn}");
                            from.Item().Text(data.BusinessEmail);
                        });
                        row.RelativeItem().Column(to =>
                        {
                            to.Item().Text("Billed to").SemiBold();
                            to.Item().Text(data.CustomerName);
                            to.Item().Text(data.CustomerEmail);
                            to.Item().Text(data.BillingAddress);
                        });
                    });
                    column.Item().Text($"{data.ProductName} - {data.EditionName} - {data.SeatCount} seats - {data.BillingPeriod}");
                    column.Item().Table(table =>
                    {
                        table.ColumnsDefinition(columns =>
                        {
                            columns.RelativeColumn(3);
                            columns.RelativeColumn(1);
                            columns.RelativeColumn(1);
                        });
                        table.Header(header =>
                        {
                            header.Cell().Text("Description").SemiBold();
                            header.Cell().Text("Qty").SemiBold();
                            header.Cell().Text("Amount").SemiBold();
                        });
                        foreach (var item in data.LineItems)
                        {
                            table.Cell().Text(item.Description);
                            table.Cell().Text(item.Quantity);
                            table.Cell().Text(item.Amount);
                        }
                    });
                    column.Item().AlignRight().Text($"Subtotal: {data.Subtotal}");
                    column.Item().AlignRight().Text($"{data.TaxLabel}: {data.TaxAmount}");
                    column.Item().AlignRight().Text($"Total due: {data.TotalDue}").Bold();
                    column.Item().Text($"Charged to {data.PaymentMethodLabel}");
                });
            });
        }).GeneratePdf();
}
```

In `src/LicenseServer/Program.cs`, add near the top (after the existing `using` block, before `var builder = ...`):

```csharp
using QuestPDF.Infrastructure;
```

And immediately after `var builder = WebApplication.CreateBuilder(args);`:

```csharp
QuestPDF.Settings.License = LicenseType.Community;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `dotnet test tests/LicenseServer.Tests --filter InvoicePdfRendererTests`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add Directory.Packages.props src/LicenseServer/LicenseServer.csproj src/LicenseServer/InvoicePdf.cs src/LicenseServer/Program.cs tests/LicenseServer.Tests/InvoicePdfTests.cs
git commit -m "Add QuestPDF-based invoice PDF renderer"
```

---

## Task 2: `{{#if}}` block-conditional in `EmailTemplateRenderer`

**Files:**
- Modify: `src/LicenseServer/TransactionalEmail.cs:245-306` (the `EmailTemplateRenderer` class)
- Modify: `src/LicenseServer/EmailTemplates/renewal-receipt.html`
- Test: `tests/LicenseServer.Tests/EmailTemplateRenderingTests.cs`

**Interfaces:**
- Consumes: nothing new from Task 1.
- Produces: `EmailTemplateRenderer.RenderHtml`/`RenderText` (unchanged signatures) now also strip `{{#if key}}...{{/if}}` blocks before token substitution. Later tasks (7) rely on: a template can use `{{#if invoicePdfUrl}}...{{/if}}` and the block is kept only when the model has a non-empty `invoicePdfUrl` value.

- [ ] **Step 1: Write the failing tests**

In `tests/LicenseServer.Tests/EmailTemplateRenderingTests.cs`, add to `EmailTemplateRenderingTests`:

```csharp
[Fact]
public void RenderHtmlDropsConditionalBlockWhenModelKeyIsMissing()
{
    var html = EmailTemplateRenderer.RenderHtml(EmailTemplates.RenewalReceipt, new Dictionary<string, string>
    {
        ["licenseId"] = "LIC-9001"
    });

    Assert.DoesNotContain("Download invoice", html, StringComparison.Ordinal);
    Assert.DoesNotContain("{{#if", html, StringComparison.Ordinal);
    Assert.DoesNotContain("{{/if}}", html, StringComparison.Ordinal);
}

[Fact]
public void RenderHtmlDropsConditionalBlockWhenModelKeyIsEmpty()
{
    var html = EmailTemplateRenderer.RenderHtml(EmailTemplates.RenewalReceipt, new Dictionary<string, string>
    {
        ["licenseId"] = "LIC-9001",
        ["invoicePdfUrl"] = ""
    });

    Assert.DoesNotContain("Download invoice", html, StringComparison.Ordinal);
}

[Fact]
public void RenderHtmlKeepsConditionalBlockWhenModelKeyIsPresent()
{
    var html = EmailTemplateRenderer.RenderHtml(EmailTemplates.RenewalReceipt, new Dictionary<string, string>
    {
        ["licenseId"] = "LIC-9001",
        ["invoicePdfUrl"] = "https://example.test/invoices/abc/pdf"
    });

    Assert.Contains("Download invoice", html, StringComparison.Ordinal);
    Assert.Contains("https://example.test/invoices/abc/pdf", html, StringComparison.Ordinal);
    Assert.DoesNotContain("{{#if", html, StringComparison.Ordinal);
    Assert.DoesNotContain("{{/if}}", html, StringComparison.Ordinal);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/LicenseServer.Tests --filter EmailTemplateRenderingTests`
Expected: FAIL — `RenderHtmlKeepsConditionalBlockWhenModelKeyIsPresent` fails because `renewal-receipt.html` doesn't have a conditional block yet (its `{{invoicePdfUrl}}` token still renders unconditionally, so the "missing" tests currently fail too since the button always renders with an empty `href`).

- [ ] **Step 3: Write the minimal implementation**

In `src/LicenseServer/TransactionalEmail.cs`, inside `EmailTemplateRenderer`, add the new regex field next to `PlaceholderPattern`:

```csharp
    private static readonly Regex ConditionalBlockPattern = new(
        @"\{\{#if (\w+)\}\}(.*?)\{\{/if\}\}", RegexOptions.Compiled | RegexOptions.Singleline);
```

Change `RenderHtml` to run the new pass first:

```csharp
    public static string RenderHtml(EmailTemplate template, IReadOnlyDictionary<string, string> model)
    {
        if (!template.HasHtmlTemplate)
            throw new InvalidOperationException(
                $"Template '{template.Name}' has no HTML file; it must use the plain-text-only rendering path.");
        return Substitute(ApplyConditionalBlocks(LoadSource(template.Name), model), model);
    }
```

Add the new method next to `Substitute`, with a comment matching the style of `Substitute`'s existing "Missing-placeholder behavior" comment:

```csharp
    // Block-conditional behavior: a {{#if key}}...{{/if}} section (including its own markers) is
    // removed entirely when the model has no non-empty value for key, and kept (markers stripped,
    // content left in place for the ordinary token pass) otherwise. This is how a template drops a
    // whole element - not just blanks a token - when optional data (e.g. an invoice PDF link) is
    // absent, without every consumer needing its own if/else around QueueAsync's model dictionary.
    private static string ApplyConditionalBlocks(string source, IReadOnlyDictionary<string, string> model) =>
        ConditionalBlockPattern.Replace(source, match =>
            model.TryGetValue(match.Groups[1].Value, out var value) && !string.IsNullOrEmpty(value)
                ? match.Groups[2].Value
                : string.Empty);
```

In `src/LicenseServer/EmailTemplates/renewal-receipt.html`, wrap the download-button `<td>` (inside the `<tr>` that also has the "View receipt" button):

```html
                  <td style="border-radius:6px;background-color:#0f172a;padding-right:10px;">
                    <a href="{{actionUrl}}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">View receipt</a>
                  </td>
                  {{#if invoicePdfUrl}}<td style="border-radius:6px;border:1px solid #cbd5e1;">
                    <a href="{{invoicePdfUrl}}" style="display:inline-block;padding:12px 24px;font-size:14px;font-weight:600;color:#0f172a;text-decoration:none;">Download invoice (PDF)</a>
                  </td>{{/if}}
```

Also update the file's top comment (the one already describing `{{invoicePdfUrl}}`) to state the mechanism is implemented, not just a note-to-self:

```html
<!--
  Template: renewal-receipt (v1)
  Model tokens: {{productName}}, {{editionName}}, {{licenseId}}, {{amount}}, {{periodEnd}}, {{paymentMethodLabel}}, {{actionUrl}}, {{invoicePdfUrl}}
  {{invoicePdfUrl}} - link to the generated invoice PDF for this renewal. The "Download invoice"
  button's <td> is wrapped in {{#if invoicePdfUrl}}...{{/if}} (see EmailTemplateRenderer's
  ApplyConditionalBlocks) so the whole button is omitted, not left as a dead link, when this
  renewal has no PDF (e.g. PDF generation failed - see BillingPolicies.RenewalAsync).
-->
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/LicenseServer.Tests --filter EmailTemplateRenderingTests`
Expected: PASS (all cases, including the pre-existing `EveryHtmlBackedTemplateResolvesAsAnEmbeddedResource` theory for `renewal-receipt`, which renders with an empty model and must still succeed with the block simply dropped)

- [ ] **Step 5: Commit**

```bash
git add src/LicenseServer/TransactionalEmail.cs src/LicenseServer/EmailTemplates/renewal-receipt.html tests/LicenseServer.Tests/EmailTemplateRenderingTests.cs
git commit -m "Add {{#if}} block-conditional to EmailTemplateRenderer"
```

---

## Task 3: R2 object storage

**Files:**
- Create: `src/LicenseServer/InvoiceStorage.cs`
- Modify: `Directory.Packages.props` (add `AWSSDK.S3` version)
- Modify: `src/LicenseServer/LicenseServer.csproj` (add `AWSSDK.S3` package reference)
- Test: `tests/LicenseServer.Tests/InvoicePdfTests.cs`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `internal static class InvoiceObjectKey { public static string For(Guid licenseOrderId); }`; `internal sealed class R2Options { public string? AccountId; public string? AccessKeyId; public string? SecretAccessKey; public string? BucketName; }`; `internal interface IInvoiceStorage { Task StoreAsync(string key, byte[] content, CancellationToken ct = default); Task<bool> ExistsAsync(string key, CancellationToken ct = default); Task<Uri> GetPresignedDownloadUrlAsync(string key, TimeSpan validFor, CancellationToken ct = default); }`; `internal sealed class R2InvoiceStorage(IOptions<R2Options> options) : IInvoiceStorage`.

- [ ] **Step 1: Add package references**

In `Directory.Packages.props`:

```xml
<PackageVersion Include="AWSSDK.S3" Version="4.0.102" />
```

In `src/LicenseServer/LicenseServer.csproj`:

```xml
<PackageReference Include="AWSSDK.S3" />
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/LicenseServer.Tests/InvoicePdfTests.cs`:

```csharp
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `dotnet test tests/LicenseServer.Tests --filter "InvoiceObjectKeyTests|R2InvoiceStorageTests"`
Expected: FAIL (compile error) — `InvoiceObjectKey`, `R2Options`, `R2InvoiceStorage` do not exist yet.

- [ ] **Step 4: Write the minimal implementation**

Create `src/LicenseServer/InvoiceStorage.cs`:

```csharp
using Amazon.S3;
using Amazon.S3.Model;
using Microsoft.Extensions.Options;

namespace LicenseServer;

internal sealed class R2Options
{
    public string? AccountId { get; set; }
    public string? AccessKeyId { get; set; }
    public string? SecretAccessKey { get; set; }
    public string? BucketName { get; set; }
}

// The R2 object key is derived from the LicenseOrder id alone: no DB row is needed to know a PDF
// exists for an order, since the download endpoint can just ask R2 directly (see the
// /invoices/{orderId}/pdf endpoint in Program.cs).
internal static class InvoiceObjectKey
{
    public static string For(Guid licenseOrderId) => $"invoices/{licenseOrderId:N}.pdf";
}

internal interface IInvoiceStorage
{
    Task StoreAsync(string key, byte[] content, CancellationToken cancellationToken = default);
    Task<bool> ExistsAsync(string key, CancellationToken cancellationToken = default);
    Task<Uri> GetPresignedDownloadUrlAsync(string key, TimeSpan validFor, CancellationToken cancellationToken = default);
}

// Follows the same nullable-client-guard pattern as StripeCurrentStateFetcher (BillingPolicies.cs):
// with no R2 credentials configured (e.g. local dev), ExistsAsync reports nothing stored and
// StoreAsync/GetPresignedDownloadUrlAsync throw rather than the app failing to start.
internal sealed class R2InvoiceStorage : IInvoiceStorage
{
    private readonly AmazonS3Client? client;
    private readonly string? bucketName;

    public R2InvoiceStorage(IOptions<R2Options> options)
    {
        var configured = options.Value;
        bucketName = configured.BucketName;
        if (string.IsNullOrWhiteSpace(configured.AccountId)
            || string.IsNullOrWhiteSpace(configured.AccessKeyId)
            || string.IsNullOrWhiteSpace(configured.SecretAccessKey)
            || string.IsNullOrWhiteSpace(configured.BucketName))
            return;
        client = new AmazonS3Client(configured.AccessKeyId, configured.SecretAccessKey, new AmazonS3Config
        {
            ServiceURL = $"https://{configured.AccountId}.r2.cloudflarestorage.com",
            ForcePathStyle = true,
            AuthenticationRegion = "auto"
        });
    }

    public async Task StoreAsync(string key, byte[] content, CancellationToken cancellationToken = default)
    {
        if (client is null) throw new InvalidOperationException("R2 storage is not configured.");
        using var stream = new MemoryStream(content);
        await client.PutObjectAsync(new PutObjectRequest
        {
            BucketName = bucketName,
            Key = key,
            InputStream = stream,
            ContentType = "application/pdf"
        }, cancellationToken);
    }

    public async Task<bool> ExistsAsync(string key, CancellationToken cancellationToken = default)
    {
        if (client is null) return false;
        try
        {
            await client.GetObjectMetadataAsync(
                new GetObjectMetadataRequest { BucketName = bucketName, Key = key }, cancellationToken);
            return true;
        }
        catch (AmazonS3Exception exception) when (exception.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return false;
        }
    }

    public async Task<Uri> GetPresignedDownloadUrlAsync(string key, TimeSpan validFor, CancellationToken cancellationToken = default)
    {
        if (client is null) throw new InvalidOperationException("R2 storage is not configured.");
        var url = await client.GetPreSignedURLAsync(new GetPreSignedUrlRequest
        {
            BucketName = bucketName,
            Key = key,
            Verb = HttpVerb.GET,
            Expires = DateTime.UtcNow.Add(validFor)
        });
        return new Uri(url);
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test tests/LicenseServer.Tests --filter "InvoiceObjectKeyTests|R2InvoiceStorageTests"`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add Directory.Packages.props src/LicenseServer/LicenseServer.csproj src/LicenseServer/InvoiceStorage.cs tests/LicenseServer.Tests/InvoicePdfTests.cs
git commit -m "Add private R2 storage for invoice PDFs"
```

---

## Task 4: Stripe invoice data provider

**Files:**
- Create: `src/LicenseServer/InvoiceStripeData.cs`
- Test: `tests/LicenseServer.Tests/InvoicePdfTests.cs`

**Interfaces:**
- Consumes: `InvoiceLineItemDisplay` from Task 1 (`src/LicenseServer/InvoicePdf.cs`); `StripeOptions` from `src/LicenseServer/StripeWebhook.cs:22` (`ApiKey` property).
- Produces: `internal sealed record StripeInvoiceData(string Number, string BillingPeriod, string Subtotal, string TaxAmount, string Total, string PaymentMethodLabel, IReadOnlyList<InvoiceLineItemDisplay> LineItems)`; `internal interface IInvoiceStripeDataProvider { Task<StripeInvoiceData?> FetchAsync(string stripeInvoiceId, CancellationToken ct = default); }`; `internal sealed class StripeInvoiceDataProvider(IOptions<StripeOptions> options) : IInvoiceStripeDataProvider`; `internal static class InvoiceMoneyFormatter { public static string Format(long minorUnits, string currencyCode); }`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/LicenseServer.Tests/InvoicePdfTests.cs`:

```csharp
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/LicenseServer.Tests --filter InvoiceMoneyFormatterTests`
Expected: FAIL (compile error) — `InvoiceMoneyFormatter` does not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Create `src/LicenseServer/InvoiceStripeData.cs`:

```csharp
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test tests/LicenseServer.Tests --filter InvoiceMoneyFormatterTests`
Expected: PASS (5 cases)

- [ ] **Step 5: Commit**

```bash
git add src/LicenseServer/InvoiceStripeData.cs tests/LicenseServer.Tests/InvoicePdfTests.cs
git commit -m "Add Stripe invoice data provider for PDF generation"
```

---

## Task 5: `InvoicePdfService` orchestrator

**Files:**
- Create: `src/LicenseServer/InvoicePdfService.cs`
- Test: `tests/LicenseServer.Tests/InvoicePdfTests.cs`

**Interfaces:**
- Consumes: `IInvoicePdfRenderer`/`InvoiceDocumentData`/`InvoiceLineItemDisplay` (Task 1); `IInvoiceStorage`/`InvoiceObjectKey` (Task 3); `IInvoiceStripeDataProvider`/`StripeInvoiceData` (Task 4).
- Produces: `internal sealed class InvoiceIssuerOptions { public string? BusinessName; public string? BusinessAddress; public string? BusinessAbn; public string? BusinessEmail; public string TaxLabel = "GST"; }`; `internal sealed record InvoicePdfRequest(Guid LicenseOrderId, string StripeInvoiceId, string CustomerName, string CustomerEmail, string ProductName, string EditionName, int SeatCount)`; `internal interface IInvoicePdfService { Task<string> GenerateAndStoreAsync(InvoicePdfRequest request, CancellationToken ct = default); }` (returns the R2 object key; throws `InvalidOperationException` if Stripe data is unavailable, or propagates whatever `IInvoiceStorage` throws); `internal sealed class InvoicePdfService(IInvoiceStripeDataProvider, IInvoicePdfRenderer, IInvoiceStorage, IOptions<InvoiceIssuerOptions>, TimeProvider) : IInvoicePdfService`. Task 7 calls `GenerateAndStoreAsync` and catches any exception.

- [ ] **Step 1: Write the failing tests**

Add to `tests/LicenseServer.Tests/InvoicePdfTests.cs`:

```csharp
public sealed class InvoicePdfServiceTests
{
    [Fact]
    public async Task GenerateAndStoreAsyncBuildsDocumentFromStripeDataAndStoresRenderedBytes()
    {
        var stripeData = new FakeInvoiceStripeDataProvider(new StripeInvoiceData(
            Number: "INV-2002",
            BillingPeriod: "1 Jan 2026 - 1 Jan 2027",
            Subtotal: "$500.00",
            TaxAmount: "$50.00",
            Total: "$550.00",
            PaymentMethodLabel: "Visa •••• 4242",
            LineItems: [new InvoiceLineItemDisplay("Enterprise seats", "25", "$500.00")]));
        var renderer = new FakeInvoicePdfRenderer([1, 2, 3]);
        var storage = new FakeInvoiceStorage();
        var service = new InvoicePdfService(stripeData, renderer, storage,
            Microsoft.Extensions.Options.Options.Create(new InvoiceIssuerOptions
            {
                BusinessName = "RePass Cloud Pty Ltd",
                BusinessAddress = "1 Example St",
                BusinessAbn = "12 345 678 901",
                BusinessEmail = "billing@repasscloud.com",
                TaxLabel = "GST"
            }),
            TimeProvider.System);
        var orderId = Guid.NewGuid();

        var key = await service.GenerateAndStoreAsync(new InvoicePdfRequest(
            orderId, "in_test_1", "Jane Buyer", "jane@example.test", "Acme Widget Pro", "Enterprise", 25));

        Assert.Equal(InvoiceObjectKey.For(orderId), key);
        Assert.Equal(key, storage.StoredKey);
        Assert.Equal(new byte[] { 1, 2, 3 }, storage.StoredContent);
        Assert.NotNull(renderer.CapturedData);
        Assert.Equal("Acme Widget Pro", renderer.CapturedData!.ProductName);
        Assert.Equal("$550.00", renderer.CapturedData.TotalDue);
        Assert.Equal("GST", renderer.CapturedData.TaxLabel);
        Assert.Equal("Jane Buyer", renderer.CapturedData.CustomerName);
        Assert.Single(renderer.CapturedData.LineItems);
    }

    [Fact]
    public async Task GenerateAndStoreAsyncThrowsWhenStripeDataIsUnavailable()
    {
        var service = new InvoicePdfService(
            new FakeInvoiceStripeDataProvider(null),
            new FakeInvoicePdfRenderer([1]),
            new FakeInvoiceStorage(),
            Microsoft.Extensions.Options.Options.Create(new InvoiceIssuerOptions()),
            TimeProvider.System);

        await Assert.ThrowsAsync<InvalidOperationException>(() => service.GenerateAndStoreAsync(
            new InvoicePdfRequest(Guid.NewGuid(), "in_missing", "Jane Buyer", "jane@example.test", "Product", "Edition", 1)));
    }

    private sealed class FakeInvoiceStripeDataProvider(StripeInvoiceData? data) : IInvoiceStripeDataProvider
    {
        public Task<StripeInvoiceData?> FetchAsync(string stripeInvoiceId, CancellationToken cancellationToken = default) =>
            Task.FromResult(data);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/LicenseServer.Tests --filter InvoicePdfServiceTests`
Expected: FAIL (compile error) — `InvoicePdfService`, `InvoicePdfRequest`, `InvoiceIssuerOptions` do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Create `src/LicenseServer/InvoicePdfService.cs`:

```csharp
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
            InvoiceDate: now.ToString("d MMM yyyy"),
            DueDate: now.ToString("d MMM yyyy"),
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/LicenseServer.Tests --filter InvoicePdfServiceTests`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/LicenseServer/InvoicePdfService.cs tests/LicenseServer.Tests/InvoicePdfTests.cs
git commit -m "Add InvoicePdfService orchestrator"
```

---

## Task 6: Download endpoint, DI wiring, and config

**Files:**
- Modify: `src/LicenseServer/Program.cs` (DI registrations near the `MailerSend`/`Stripe`/`Billing` options section, and endpoint mapping near the other `AllowAnonymous` `MapGet`s)
- Modify: `src/LicenseServer/appsettings.json`
- Modify: `.env.prod.example`
- Modify: `compose.prod.yaml`

**Interfaces:**
- Consumes: `R2Options`/`IInvoiceStorage`/`R2InvoiceStorage`/`InvoiceObjectKey` (Task 3); `InvoiceIssuerOptions`/`IInvoicePdfService`/`InvoicePdfService` (Task 5); `IInvoiceStripeDataProvider`/`StripeInvoiceDataProvider` (Task 4); `IInvoicePdfRenderer`/`InvoicePdfRenderer` (Task 1).
- Produces: `GET /invoices/{orderId:guid}/pdf` endpoint, live in the running app. Task 7's emailed link points at this path.

- [ ] **Step 1: Register options and services**

In `src/LicenseServer/Program.cs`, near the existing `builder.Services.Configure<StripeOptions>(...)` / `builder.Services.AddOptions<BillingPolicyOptions>()...` block, add:

```csharp
builder.Services.Configure<R2Options>(builder.Configuration.GetSection("R2"));
builder.Services.Configure<InvoiceIssuerOptions>(builder.Configuration.GetSection("Invoice"));
builder.Services.AddScoped<IInvoiceStorage, R2InvoiceStorage>();
builder.Services.AddScoped<IInvoiceStripeDataProvider, StripeInvoiceDataProvider>();
builder.Services.AddScoped<IInvoicePdfRenderer, InvoicePdfRenderer>();
builder.Services.AddScoped<IInvoicePdfService, InvoicePdfService>();
```

- [ ] **Step 2: Add the download endpoint**

Near the other anonymous `app.MapGet(...)` calls (e.g. next to `/customer/access/consume`), add:

```csharp
app.MapGet("/invoices/{orderId:guid}/pdf", async (Guid orderId, IInvoiceStorage storage, CancellationToken ct) =>
{
    var key = InvoiceObjectKey.For(orderId);
    if (!await storage.ExistsAsync(key, ct))
        return Results.NotFound();
    var url = await storage.GetPresignedDownloadUrlAsync(key, TimeSpan.FromMinutes(10), ct);
    return Results.Redirect(url.ToString());
}).AllowAnonymous()
  .WithDescription("Redirects to a short-lived presigned R2 URL for this order's invoice PDF. The order GUID is the bearer token, matching the customer magic-link trust model.");
```

- [ ] **Step 3: Add default/non-secret config**

In `src/LicenseServer/appsettings.json`, add a top-level `"Invoice"` section (after `"CustomerPortal"`):

```json
  "Invoice": {
    "TaxLabel": "GST"
  },
```

(No `"R2"` section is added here — every R2 field is a secret/deployment-specific value with no safe local default, matching how `MailerSend`/`Stripe` secrets are absent from `appsettings.json` too. Locally, `R2InvoiceStorage` runs in its unconfigured/no-op mode.)

- [ ] **Step 4: Add production secrets/config**

In `.env.prod.example`, after the `--- Stripe ---` section, add:

```
# --- Cloudflare R2 (invoice PDF storage) ---
R2_ACCOUNT_ID=replace-with-cloudflare-account-id
R2_ACCESS_KEY_ID=replace-with-r2-access-key-id
R2_SECRET_ACCESS_KEY=replace-with-r2-secret-access-key
R2_BUCKET_NAME=license-server-invoices

# --- Invoice issuer details (embedded in generated invoice PDFs) ---
INVOICE_BUSINESS_NAME=replace-with-legal-business-name
INVOICE_BUSINESS_ADDRESS=replace-with-business-address
INVOICE_BUSINESS_ABN=replace-with-abn
INVOICE_BUSINESS_EMAIL=replace-with-billing-email
```

(`.env.prod` itself is gitignored — see `.gitignore:8` — and does not exist in this repo; only `.env.prod.example` is tracked and needs editing.)

In `compose.prod.yaml`, in the app service's `environment:` block, right after the existing `Stripe__ApiVersion: 2026-07-29.dahlia` line and before `Billing__GracePeriodDays: ...`, add:

```yaml
      R2__AccountId: ${R2_ACCOUNT_ID:?Set R2_ACCOUNT_ID in .env.prod}
      R2__AccessKeyId: ${R2_ACCESS_KEY_ID:?Set R2_ACCESS_KEY_ID in .env.prod}
      R2__SecretAccessKey: ${R2_SECRET_ACCESS_KEY:?Set R2_SECRET_ACCESS_KEY in .env.prod}
      R2__BucketName: ${R2_BUCKET_NAME:?Set R2_BUCKET_NAME in .env.prod}
      Invoice__BusinessName: ${INVOICE_BUSINESS_NAME:?Set INVOICE_BUSINESS_NAME in .env.prod}
      Invoice__BusinessAddress: ${INVOICE_BUSINESS_ADDRESS:?Set INVOICE_BUSINESS_ADDRESS in .env.prod}
      Invoice__BusinessAbn: ${INVOICE_BUSINESS_ABN:?Set INVOICE_BUSINESS_ABN in .env.prod}
      Invoice__BusinessEmail: ${INVOICE_BUSINESS_EMAIL:?Set INVOICE_BUSINESS_EMAIL in .env.prod}
```

- [ ] **Step 5: Verify the app still builds and boots**

Run: `dotnet build src/LicenseServer/LicenseServer.csproj`
Expected: Build succeeds with no new warnings (warnings fail the build per `Directory.Build.props`'s `TreatWarningsAsErrors`).

Run: `dotnet test tests/LicenseServer.Tests --filter "InvoicePdfRendererTests|InvoiceObjectKeyTests|R2InvoiceStorageTests|InvoiceMoneyFormatterTests|InvoicePdfServiceTests|EmailTemplateRenderingTests"`
Expected: PASS (all tests from Tasks 1-5 still pass with the DI wiring in place)

- [ ] **Step 6: Commit**

```bash
git add src/LicenseServer/Program.cs src/LicenseServer/appsettings.json .env.prod.example compose.prod.yaml
git commit -m "Wire up invoice PDF services, download endpoint, and R2/issuer config"
```

---

## Task 7: Wire `RenewalAsync` to generate the PDF and link the email

**Files:**
- Modify: `src/LicenseServer/BillingPolicies.cs:55-60` (constructor), `:374-377` (the `RenewalReceipt` `QueueAsync` call)
- Modify: `tests/LicenseServer.Tests/BillingPolicyTests.cs`

**Interfaces:**
- Consumes: `IInvoicePdfService`/`InvoicePdfRequest` (Task 5).
- Produces: `internal static class RenewalReceiptModel { public static Dictionary<string, string> Build(string licenseId, string? invoicePdfUrl); }` (pure, unit-testable independent of DB/network).

- [ ] **Step 1: Write the failing tests**

Add to `tests/LicenseServer.Tests/BillingPolicyTests.cs`, a new top-level test class in the same file:

```csharp
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
```

And, inside the existing `BillingPolicyTests` class (near `RenewalIsMonotonicAndSameInvoiceAcrossEventsIsIdempotent`), add:

```csharp
[Fact]
[Trait("ExpectedGreenStage", "15")]
public async Task RenewalSucceedsAndOmitsInvoicePdfUrlWhenPdfGenerationIsUnavailable()
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
```

(This asserts failure isolation: `R2`/`Stripe:ApiKey` are unset in `PostgresWebFixture`'s test config, so PDF generation is guaranteed to fail there, and the renewal must still complete and still queue the receipt.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/LicenseServer.Tests --filter "RenewalReceiptModelTests|RenewalSucceedsAndOmitsInvoicePdfUrlWhenPdfGenerationIsUnavailable"`
Expected: FAIL — `RenewalReceiptModelTests` fails to compile (`RenewalReceiptModel` doesn't exist). The Postgres test currently passes already (it's exercising existing behavior), so it's a regression guard here rather than a red test — confirm it still passes after Step 3, don't worry if it's already green before that.

- [ ] **Step 3: Write the minimal implementation**

In `src/LicenseServer/BillingPolicies.cs`, change the `StripeBillingPolicyProcessor` constructor (currently at line ~55-60):

```csharp
internal sealed class StripeBillingPolicyProcessor(
    ApplicationDbContext db,
    LicenseStore licenses,
    ITransactionalEmailSender emails,
    IInvoicePdfService invoicePdf,
    IOptions<BillingPolicyOptions> options,
    TimeProvider clock,
    IConfiguration configuration,
    IWebHostEnvironment environment,
    ILogger<StripeBillingPolicyProcessor> logger)
```

Add near the top of the file (after the `BillingPolicyOptions` class, before `StripeBillingPolicyProcessor`):

```csharp
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
```

Add a `LoggerMessage` field inside `StripeBillingPolicyProcessor` (near its other members):

```csharp
    private static readonly Action<ILogger, Guid, Exception> LogInvoicePdfGenerationFailed = LoggerMessage.Define<Guid>(
        LogLevel.Warning, new EventId(1501, "InvoicePdfGenerationFailed"),
        "Invoice PDF generation failed for license order {LicenseOrderId}; renewal receipt queued without invoicePdfUrl.");
```

Replace the existing email-queue block in `RenewalAsync` (currently):

```csharp
        await emails.QueueAsync(new TransactionalEmail(
                EmailTemplates.RenewalReceipt, contract.Customer!.Email,
                new Dictionary<string, string> { ["licenseId"] = contract.License.LicenseId }),
            $"billing:renewal:{snapshot.InvoiceId}", cancellationToken);
```

with:

```csharp
        var invoicePdfUrl = await TryGenerateInvoicePdfUrlAsync(order, contract, product, snapshot, cancellationToken);
        await emails.QueueAsync(new TransactionalEmail(
                EmailTemplates.RenewalReceipt, contract.Customer!.Email,
                RenewalReceiptModel.Build(contract.License.LicenseId, invoicePdfUrl)),
            $"billing:renewal:{snapshot.InvoiceId}", cancellationToken);
```

Add the new private helper method to `StripeBillingPolicyProcessor` (near `RenewalAsync`):

```csharp
    private async Task<string?> TryGenerateInvoicePdfUrlAsync(
        LicenseOrder order, BillingContract contract, ProductDefinition product, BillingSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        try
        {
            await invoicePdf.GenerateAndStoreAsync(new InvoicePdfRequest(
                order.Id, snapshot.InvoiceId!, contract.Customer!.Name, contract.Customer!.Email,
                product.DisplayName, contract.Edition, contract.Seats), cancellationToken);
            var publicBaseUrl = configuration["CustomerPortal:PublicBaseUrl"]?.TrimEnd('/')
                ?? (environment.IsDevelopment()
                    ? "http://localhost:8080"
                    : throw new InvalidOperationException("CustomerPortal:PublicBaseUrl is required outside Development."));
            return $"{publicBaseUrl}/invoices/{order.Id}/pdf";
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            LogInvoicePdfGenerationFailed(logger, order.Id, exception);
            return null;
        }
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/LicenseServer.Tests --filter "RenewalReceiptModelTests|BillingPolicyTests"`
Expected: PASS (all `RenewalReceiptModelTests` cases, all pre-existing `BillingPolicyTests` cases, and the new `RenewalSucceedsAndOmitsInvoicePdfUrlWhenPdfGenerationIsUnavailable`)

- [ ] **Step 5: Commit**

```bash
git add src/LicenseServer/BillingPolicies.cs tests/LicenseServer.Tests/BillingPolicyTests.cs
git commit -m "Wire RenewalAsync to generate and link the invoice PDF"
```

---

## Task 8: Full suite run

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Run the full Postgres-backed suite**

Run: `dotnet test` (from the repo root, with `TEST_POSTGRES_CONNECTION` set per the repo's test script, e.g. via `scripts/Test-DatabaseAndAuth.ps1` or an equivalent local/dockerized Postgres)
Expected: PASS, 0 failures, across every test project.

- [ ] **Step 2: Run a build with warnings-as-errors from a clean state**

Run: `dotnet build`
Expected: Build succeeds with no warnings.

- [ ] **Step 3: If anything fails, fix forward**

Do not skip or weaken a failing assertion to make it pass. If a test in an earlier task turns out to have been wrong given how a later task actually wired things together, fix the test to assert the correct behavior, and note the fix in the final report to the user.

---

## Task 9: Verify #72 (`ContactSupport`) and close it

**Files:** none (verification only — no code changes)

**Interfaces:** none

- [ ] **Step 1: Re-read the #72 issue spec**

Run: `gh issue view 72 --repo repasscloud/license-server-app`

- [ ] **Step 2: Check each requirement against current `dev`**

Check, reading the actual current files (not from memory of this plan):
- `src/LicenseServer/ContactSupport.cs` — `ContactSupportService`, `ContactSupportReasons`, submission validation.
- `src/LicenseServer/Components/Pages/ContactSupport.razor` — the `/support/contact` page.
- `src/LicenseServer/TransactionalEmail.cs` — the `EmailTemplates.ContactSupport` entry (`HasHtmlTemplate: false`) and `MailerSendEmailTransport.RenderPlainTextOnly`.
- `src/LicenseServer/Program.cs` — the `/support/contact/send` endpoint.
- `tests/LicenseServer.Tests/ContactSupportTests.cs` — confirm it exercises the above and passes.

For each requirement in the issue, confirm there is code (and, ideally, a passing test) satisfying it. List any gap found.

- [ ] **Step 3: Run the existing ContactSupport tests**

Run: `dotnet test tests/LicenseServer.Tests --filter ContactSupportTests`
Expected: PASS

- [ ] **Step 4: Close the issue if it holds up**

If every requirement is met: `gh issue close 72 --repo repasscloud/license-server-app --comment "Verified against current dev: ContactSupportService, the /support/contact page, the contact-support template entry, and the plain-text-only send path (see src/LicenseServer/ContactSupport.cs, Components/Pages/ContactSupport.razor, TransactionalEmail.cs) all match this issue's spec, covered by tests/LicenseServer.Tests/ContactSupportTests.cs."`

If any requirement is not met, do not close the issue — report the gap to the user instead and ask whether to open a follow-up task for it.

---

## After all tasks

Open a PR against `dev` per the repo's usual workflow (see `superpowers:finishing-a-development-branch`), summarizing #73, #74, and the #72 verification outcome.
