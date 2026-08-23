using System.Net;
using LicenseServer.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace LicenseServer.Tests;

[Collection(PostgresTestSuite.Name)]
public sealed class ContactSupportTests(PostgresWebFixture fixture)
{
    [Fact]
    public async Task SubmitQueuesPlainTextEmailToSupportWithReasonSubject()
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<ContactSupportService>();
        var result = await service.SubmitAsync(new ContactSupportSubmission(
            ContactSupportReasons.MachineWideActivation, "customer@example.com", "LIC-123", "Please help."));

        Assert.True(result.Success);
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var row = await db.EmailOutbox.AsNoTracking()
            .Where(item => item.TemplateName == EmailTemplates.ContactSupport.Name)
            .OrderByDescending(item => item.CreatedAt)
            .FirstAsync();
        Assert.Equal(EmailOutboxStatus.Pending, row.Status);

        var sender = (TransactionalEmailSender)scope.ServiceProvider.GetRequiredService<ITransactionalEmailSender>();
        var envelope = sender.Unprotect(row);
        Assert.Equal(ContactSupportService.SupportRecipient, envelope.Recipient);
        Assert.Equal("Machine-wide activation code", envelope.Model["reason"]);
        Assert.Equal("customer@example.com", envelope.Model["replyEmail"]);
        Assert.Equal("LIC-123", envelope.Model["licenseId"]);
        Assert.Equal("Please help.", envelope.Model["message"]);
    }

    [Fact]
    public async Task SubmitOmitsLicenseIdModelKeyWhenNotProvided()
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<ContactSupportService>();
        var result = await service.SubmitAsync(new ContactSupportSubmission(
            ContactSupportReasons.Other, "customer2@example.com", null, "General question."));

        Assert.True(result.Success);
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var row = await db.EmailOutbox.AsNoTracking()
            .Where(item => item.TemplateName == EmailTemplates.ContactSupport.Name)
            .OrderByDescending(item => item.CreatedAt)
            .FirstAsync();
        var sender = (TransactionalEmailSender)scope.ServiceProvider.GetRequiredService<ITransactionalEmailSender>();
        var envelope = sender.Unprotect(row);
        Assert.False(envelope.Model.ContainsKey("licenseId"));
    }

    [Theory]
    [InlineData("not-a-real-reason", "customer@example.com", "hello")]
    [InlineData(ContactSupportReasons.Billing, "not-an-email", "hello")]
    [InlineData(ContactSupportReasons.Billing, "customer@example.com", " ")]
    public async Task SubmitRejectsInvalidInput(string reason, string email, string message)
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<ContactSupportService>();
        var result = await service.SubmitAsync(new ContactSupportSubmission(reason, email, null, message));
        Assert.False(result.Success);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public async Task PostEndpointRedirectsToSentConfirmationOnSuccess()
    {
        using var client = fixture.Factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false
        });
        using var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["Reason"] = ContactSupportReasons.Technical,
            ["ReplyEmail"] = "endpoint@example.com",
            ["Message"] = "It broke."
        });
        var response = await client.PostAsync("/support/contact/send", content);
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.Equal("/support/contact?sent=true", response.Headers.Location!.ToString());
    }

    [Fact]
    public async Task PostEndpointRedirectsWithErrorOnInvalidSubmission()
    {
        using var client = fixture.Factory.CreateClient(new Microsoft.AspNetCore.Mvc.Testing.WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false
        });
        using var content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["Reason"] = "bogus",
            ["ReplyEmail"] = "endpoint2@example.com",
            ["Message"] = "It broke."
        });
        var response = await client.PostAsync("/support/contact/send", content);
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.Contains("error=", response.Headers.Location!.ToString(), StringComparison.Ordinal);
    }
}
