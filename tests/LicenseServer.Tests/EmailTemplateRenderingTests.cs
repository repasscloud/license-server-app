using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using LicenseServer.Data;
using Microsoft.Extensions.Options;

namespace LicenseServer.Tests;

public sealed class EmailTemplateRenderingTests
{
    [Fact]
    public void RenderHtmlSubstitutesKnownPlaceholdersFromModel()
    {
        var model = new Dictionary<string, string>
        {
            ["productName"] = "Acme Widget Pro",
            ["editionName"] = "Enterprise",
            ["seatCount"] = "25",
            ["licenseId"] = "LIC-9001",
            ["activationCode"] = "ABCD-1234",
            ["expiryDate"] = "Never",
            ["machineWideUrl"] = "https://example.test/support/contact?reason=machine-wide-activation"
        };

        var html = EmailTemplateRenderer.RenderHtml(EmailTemplates.PurchaseActivation, model);

        Assert.Contains("Acme Widget Pro", html, StringComparison.Ordinal);
        Assert.Contains("Enterprise", html, StringComparison.Ordinal);
        Assert.Contains("ABCD-1234", html, StringComparison.Ordinal);
        Assert.Contains("https://example.test/support/contact?reason=machine-wide-activation", html, StringComparison.Ordinal);
        Assert.DoesNotContain("{{", html, StringComparison.Ordinal);
    }

    [Fact]
    public void RenderHtmlRendersMissingPlaceholderAsEmptyInsteadOfThrowing()
    {
        var model = new Dictionary<string, string>
        {
            ["productName"] = "Acme Widget Pro"
            // editionName, seatCount, licenseId, activationCode, expiryDate, machineWideUrl deliberately omitted.
        };

        var html = EmailTemplateRenderer.RenderHtml(EmailTemplates.PurchaseActivation, model);

        Assert.DoesNotContain("{{editionName}}", html, StringComparison.Ordinal);
        Assert.DoesNotContain("{{", html, StringComparison.Ordinal);
        Assert.Contains("Acme Widget Pro", html, StringComparison.Ordinal);
    }

    [Fact]
    public void RenderTextIsDerivedFromTheSameTemplateAndModelAsHtml()
    {
        var model = new Dictionary<string, string>
        {
            ["actionUrl"] = "https://example.test/renew"
        };

        var text = EmailTemplateRenderer.RenderText(EmailTemplates.RenewalReminder, model);

        Assert.Contains("https://example.test/renew", text, StringComparison.Ordinal);
        Assert.DoesNotContain("<", text, StringComparison.Ordinal);
    }

    [Fact]
    public void RenderHtmlThrowsForTemplateWithNoHtmlFile()
    {
        Assert.Throws<InvalidOperationException>(() =>
            EmailTemplateRenderer.RenderHtml(EmailTemplates.ContactSupport, new Dictionary<string, string>()));
    }

    public static IEnumerable<object[]> HtmlBackedTemplateNames() =>
    [
        ["purchase-activation"], ["renewal-reminder"], ["renewal-receipt"], ["payment-failure"], ["invoice"],
        ["operator-invitation"], ["identity-confirmation"], ["identity-password-recovery"], ["customer-magic-link"]
    ];

    [Theory]
    [MemberData(nameof(HtmlBackedTemplateNames))]
    public void EveryHtmlBackedTemplateResolvesAsAnEmbeddedResource(string templateName)
    {
        var template = EmailTemplates.Resolve(templateName);
        var html = EmailTemplateRenderer.RenderHtml(template, new Dictionary<string, string>());
        Assert.False(string.IsNullOrWhiteSpace(html));
    }

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

    [Fact]
    public void RenderHtmlDropsInvoiceDownloadButtonWhenActionUrlIsMissing()
    {
        var html = EmailTemplateRenderer.RenderHtml(EmailTemplates.Invoice, new Dictionary<string, string>());

        Assert.DoesNotContain("Download invoice", html, StringComparison.Ordinal);
        Assert.DoesNotContain("{{#if", html, StringComparison.Ordinal);
        Assert.DoesNotContain("{{/if}}", html, StringComparison.Ordinal);
    }

    [Fact]
    public void RenderHtmlKeepsInvoiceDownloadButtonWhenActionUrlIsPresent()
    {
        var html = EmailTemplateRenderer.RenderHtml(EmailTemplates.Invoice, new Dictionary<string, string>
        {
            ["actionUrl"] = "https://example.test/invoices/abc/pdf"
        });

        Assert.Contains("Download invoice", html, StringComparison.Ordinal);
        Assert.Contains("https://example.test/invoices/abc/pdf", html, StringComparison.Ordinal);
    }
}

public sealed class MailerSendEmailTransportTests
{
    private static (MailerSendEmailTransport Transport, CapturingHandler Handler) CreateTransport()
    {
        var handler = new CapturingHandler();
        var client = new HttpClient(handler) { BaseAddress = new Uri("https://api.mailersend.test/") };
        var options = Options.Create(new MailerSendOptions
        {
            ApiToken = "test-token",
            FromEmail = "no-reply@example.test",
            FromName = "License Server"
        });
        return (new MailerSendEmailTransport(client, options), handler);
    }

    [Fact]
    public async Task SendAsyncRendersHtmlTemplateForTemplatesWithAnHtmlFile()
    {
        var (transport, handler) = CreateTransport();
        var envelope = new ProtectedEmailEnvelope("customer@example.test", EmailTemplates.RenewalReminder.Name,
            EmailTemplates.RenewalReminder.Version, new Dictionary<string, string> { ["actionUrl"] = "https://example.test/renew" });

        var result = await transport.SendAsync(Guid.NewGuid(), "hash", envelope);

        Assert.Equal(EmailTransportDisposition.Sent, result.Disposition);
        var payload = handler.CapturedRequestBody!.Value;
        Assert.Contains("https://example.test/renew", payload.GetProperty("html").GetString(), StringComparison.Ordinal);
        Assert.Contains("https://example.test/renew", payload.GetProperty("text").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task SendAsyncUsesPlainTextOnlyPathForTemplateWithNoHtmlFile()
    {
        var (transport, handler) = CreateTransport();
        var envelope = new ProtectedEmailEnvelope("hello@example.test", EmailTemplates.ContactSupport.Name,
            EmailTemplates.ContactSupport.Version, new Dictionary<string, string>
            {
                ["reason"] = "Billing question",
                ["replyEmail"] = "customer@example.test",
                ["message"] = "Please help with my invoice."
            });

        var result = await transport.SendAsync(Guid.NewGuid(), "hash", envelope);

        Assert.Equal(EmailTransportDisposition.Sent, result.Disposition);
        var payload = handler.CapturedRequestBody!.Value;
        Assert.Equal("Billing question", payload.GetProperty("subject").GetString());
        Assert.Contains("Please help with my invoice.", payload.GetProperty("text").GetString(), StringComparison.Ordinal);
    }

    private sealed class CapturingHandler : HttpMessageHandler
    {
        public JsonElement? CapturedRequestBody { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = await request.Content!.ReadAsStringAsync(cancellationToken);
            CapturedRequestBody = JsonSerializer.Deserialize<JsonElement>(body);
            var response = new HttpResponseMessage(HttpStatusCode.Accepted);
            response.Headers.Add("x-message-id", "msg-test-1");
            return response;
        }
    }
}
