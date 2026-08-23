using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using LicenseServer.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace LicenseServer.Tests;

[Collection(PostgresTestSuite.Name)]
public sealed class TransactionalEmailTests(PostgresWebFixture fixture)
{
    [Fact]
    [Trait("ExpectedGreenStage", "12")]
    public async Task QueueEncryptsPayloadAndSuppressesDuplicateIdempotencyKeys()
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var sender = scope.ServiceProvider.GetRequiredService<ITransactionalEmailSender>();
        var first = await sender.QueueAsync(new TransactionalEmail(
            EmailTemplates.OperatorInvitation, "operator@example.com",
            new Dictionary<string, string> { ["actionUrl"] = "https://example.test/reset?secret=once" }),
            "operator-invite:email-stage12");
        var duplicate = await sender.QueueAsync(new TransactionalEmail(
            EmailTemplates.OperatorInvitation, "operator@example.com",
            new Dictionary<string, string> { ["actionUrl"] = "https://example.test/reset?secret=once" }),
            "operator-invite:email-stage12");

        Assert.Equal(first, duplicate);
        var row = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().EmailOutbox
            .AsNoTracking().SingleAsync(item => item.Id == first);
        Assert.DoesNotContain("operator@example.com", row.ProtectedPayload, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("secret=once", row.ProtectedPayload, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(EmailOutboxStatus.Pending, row.Status);
        Assert.Equal(0, row.AttemptCount);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "12")]
    public async Task QueueRejectsActivationCodeModelKeyOutsidePurchaseActivationTemplate()
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var sender = scope.ServiceProvider.GetRequiredService<ITransactionalEmailSender>();
        await Assert.ThrowsAsync<InvalidOperationException>(() => sender.QueueAsync(
            new TransactionalEmail(EmailTemplates.RenewalReceipt, "guard@example.com",
                new Dictionary<string, string> { ["activationCode"] = "SHOULD-NOT-LEAK" }),
            "stage12-guard-activation-code"));
    }

    [Fact]
    [Trait("ExpectedGreenStage", "12")]
    public async Task IdentitySenderQueuesProviderNeutralTemplates()
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var sender = scope.ServiceProvider.GetRequiredService<IEmailSender<ApplicationUser>>();
        var user = new ApplicationUser { Id = Guid.NewGuid().ToString("D"), UserName = "identity@example.com", Email = "identity@example.com" };
        await sender.SendPasswordResetLinkAsync(user, user.Email, "https://example.test/reset/identity-secret");

        var row = await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>().EmailOutbox.AsNoTracking()
            .OrderByDescending(item => item.CreatedAt)
            .FirstAsync(item => item.TemplateName == EmailTemplates.IdentityPasswordRecovery.Name);
        Assert.DoesNotContain("identity-secret", row.ProtectedPayload, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "12")]
    public async Task OutboxParticipatesInBusinessTransactionRollback()
    {
        Guid id;
        await using (var scope = fixture.Factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            await using var transaction = await db.Database.BeginTransactionAsync();
            id = await scope.ServiceProvider.GetRequiredService<ITransactionalEmailSender>().QueueAsync(
                new TransactionalEmail(EmailTemplates.Invoice, "rollback@example.com", new Dictionary<string, string>()),
                "stage12-rollback");
            await transaction.RollbackAsync();
        }

        await using var verification = fixture.Factory.Services.CreateAsyncScope();
        Assert.False(await verification.ServiceProvider.GetRequiredService<ApplicationDbContext>()
            .EmailOutbox.AnyAsync(item => item.Id == id));
    }

    [Fact]
    [Trait("ExpectedGreenStage", "12")]
    public async Task WorkerClaimsDecryptsAndCompletesFakeDelivery()
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var id = await scope.ServiceProvider.GetRequiredService<ITransactionalEmailSender>().QueueAsync(
            new TransactionalEmail(EmailTemplates.RenewalReminder, "worker@example.com",
                new Dictionary<string, string> { ["actionUrl"] = "https://example.test/renew" }),
            "stage12-worker-success");

        Assert.True(await scope.ServiceProvider.GetRequiredService<EmailOutboxProcessor>().ProcessBatchAsync() >= 1);
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        db.ChangeTracker.Clear();
        var row = await db.EmailOutbox.AsNoTracking().SingleAsync(item => item.Id == id);
        Assert.Equal(EmailOutboxStatus.Sent, row.Status);
        Assert.StartsWith("development-", row.ProviderMessageId, StringComparison.Ordinal);
        Assert.Equal(1, row.AttemptCount);
        Assert.NotNull(row.SentAt);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "12")]
    public async Task WebhookRejectsInvalidSignatureAndDeduplicatesAuthenticatedEvents()
    {
        const string body = "{\"id\":\"evt-stage12-1\",\"type\":\"activity.delivered\",\"data\":{\"message_id\":\"msg-stage12-1\"}}";
        using var client = fixture.Factory.CreateClient();
        using var invalid = new HttpRequestMessage(HttpMethod.Post, "/api/v1/webhooks/mailersend")
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json")
        };
        invalid.Headers.Add("Signature", "invalid");
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(invalid)).StatusCode);

        var signature = Convert.ToHexStringLower(HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(PostgresWebFixture.MailerSendWebhookSecret), Encoding.UTF8.GetBytes(body)));
        for (var attempt = 0; attempt < 2; attempt++)
        {
            using var valid = new HttpRequestMessage(HttpMethod.Post, "/api/v1/webhooks/mailersend")
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json")
            };
            valid.Headers.Add("Signature", signature);
            Assert.Equal(HttpStatusCode.NoContent, (await client.SendAsync(valid)).StatusCode);
        }

        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        Assert.Equal(1, await scope.ServiceProvider.GetRequiredService<ApplicationDbContext>()
            .EmailDeliveryEvents.CountAsync(item => item.ProviderEventId == "evt-stage12-1"));
    }

    [Theory]
    [InlineData(1, 2)]
    [InlineData(2, 4)]
    [InlineData(10, 360)]
    [Trait("ExpectedGreenStage", "12")]
    public void RetryScheduleIsBoundedExponential(int attempt, int expectedMinutes) =>
        Assert.Equal(TimeSpan.FromMinutes(expectedMinutes), EmailRetrySchedule.Delay(attempt));
}
