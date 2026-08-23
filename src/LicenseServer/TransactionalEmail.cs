using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using LicenseServer.Data;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace LicenseServer;

// HasHtmlTemplate is false only for templates that intentionally have no EmailTemplates/*.html
// file (currently just ContactSupport, #72) and must go through the plain-text-only rendering
// path in MailerSendEmailTransport instead of EmailTemplateRenderer.
internal readonly record struct EmailTemplate(string Name, int Version, string Subject, bool HasHtmlTemplate = true);

internal static class EmailTemplates
{
    public static readonly EmailTemplate PurchaseActivation = new("purchase-activation", 1, "Your license activation details");
    public static readonly EmailTemplate RenewalReminder = new("renewal-reminder", 1, "Your license renewal is approaching");
    public static readonly EmailTemplate RenewalReceipt = new("renewal-receipt", 1, "Your license renewal receipt");
    public static readonly EmailTemplate PaymentFailure = new("payment-failure", 1, "Payment action required");
    public static readonly EmailTemplate Invoice = new("invoice", 1, "Your license invoice");
    public static readonly EmailTemplate OperatorInvitation = new("operator-invitation", 1, "Set up your operator account");
    public static readonly EmailTemplate IdentityConfirmation = new("identity-confirmation", 1, "Confirm your email");
    public static readonly EmailTemplate IdentityPasswordRecovery = new("identity-password-recovery", 1, "Reset your password");
    public static readonly EmailTemplate CustomerMagicLink = new("customer-magic-link", 1, "Your secure customer portal link");
    public static readonly EmailTemplate ContactSupport = new("contact-support", 1, "Contact support", HasHtmlTemplate: false);

    private static readonly Dictionary<string, EmailTemplate> All = new[]
    {
        PurchaseActivation, RenewalReminder, RenewalReceipt, PaymentFailure, Invoice,
        OperatorInvitation, IdentityConfirmation, IdentityPasswordRecovery, CustomerMagicLink, ContactSupport
    }.ToDictionary(item => item.Name, StringComparer.Ordinal);

    public static EmailTemplate Resolve(string name) =>
        All.TryGetValue(name, out var template)
            ? template
            : throw new InvalidOperationException($"Transactional email template '{name}' is not registered.");
}

internal sealed record TransactionalEmail(
    EmailTemplate Template,
    string Recipient,
    IReadOnlyDictionary<string, string> Model);

internal interface ITransactionalEmailSender
{
    Task<Guid> QueueAsync(TransactionalEmail email, string idempotencyKey, CancellationToken cancellationToken = default);
}

internal static class EmailOutboxStatus
{
    public const string Pending = "pending";
    public const string Leased = "leased";
    public const string Retry = "retry";
    public const string Sent = "sent";
    public const string Delivered = "delivered";
    public const string Bounced = "bounced";
    public const string Complained = "complained";
    public const string Failed = "failed";
    public const string Uncertain = "uncertain";
}

internal sealed class TransactionalEmailSender(
    ApplicationDbContext db,
    IDataProtectionProvider protection,
    TimeProvider clock) : ITransactionalEmailSender
{
    private readonly IDataProtector protector = protection.CreateProtector("LicenseServer.TransactionalEmail.v1");

    public async Task<Guid> QueueAsync(
        TransactionalEmail email,
        string idempotencyKey,
        CancellationToken cancellationToken = default)
    {
        var template = EmailTemplates.Resolve(email.Template.Name);
        if (template.Version != email.Template.Version)
            throw new InvalidOperationException("Transactional email template version is not registered.");
        if (!CustomerEmails.TryNormalize(email.Recipient, out var recipient, out var error))
            throw new InvalidOperationException(error);
        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 300)
            throw new InvalidOperationException("A bounded transactional email idempotency key is required.");
        if (template != EmailTemplates.PurchaseActivation
            && email.Model.Keys.Any(key => string.Equals(key, "activationCode", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Activation-code plaintext is allowed only in the approved purchase/activation template.");

        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(idempotencyKey));
        await using var ownedTransaction = db.Database.CurrentTransaction is null
            ? await db.Database.BeginTransactionAsync(cancellationToken)
            : null;
        var lockKey = BitConverter.ToInt64(hash, 0);
        await db.Database.ExecuteSqlInterpolatedAsync(
            $"SELECT pg_advisory_xact_lock({lockKey})", cancellationToken);
        var existing = await db.EmailOutbox.AsNoTracking()
            .SingleOrDefaultAsync(item => item.IdempotencyHash == hash, cancellationToken);
        if (existing is not null)
        {
            if (ownedTransaction is not null) await ownedTransaction.CommitAsync(cancellationToken);
            return existing.Id;
        }

        var now = clock.GetUtcNow();
        var envelope = new ProtectedEmailEnvelope(recipient!, template.Name, template.Version, email.Model);
        var row = new EmailOutboxMessage
        {
            Id = Guid.NewGuid(),
            TemplateName = template.Name,
            TemplateVersion = template.Version,
            RecipientHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(recipient!))),
            ProtectedPayload = protector.Protect(JsonSerializer.Serialize(envelope)),
            IdempotencyHash = hash,
            Status = EmailOutboxStatus.Pending,
            NextAttemptAt = now,
            CreatedAt = now,
            RetainUntil = now.AddDays(30)
        };
        db.EmailOutbox.Add(row);
        await db.SaveChangesAsync(cancellationToken);
        if (ownedTransaction is not null) await ownedTransaction.CommitAsync(cancellationToken);
        return row.Id;
    }

    internal ProtectedEmailEnvelope Unprotect(EmailOutboxMessage row) =>
        JsonSerializer.Deserialize<ProtectedEmailEnvelope>(protector.Unprotect(row.ProtectedPayload))
        ?? throw new InvalidOperationException("The protected email payload is invalid.");
}

internal sealed record ProtectedEmailEnvelope(
    string Recipient,
    string TemplateName,
    int TemplateVersion,
    IReadOnlyDictionary<string, string> Model);

internal enum EmailTransportDisposition { Sent, Retry, PermanentFailure, Uncertain }
internal sealed record EmailTransportResult(EmailTransportDisposition Disposition, string? ProviderMessageId = null, string? ErrorCode = null);

internal interface IEmailTransport
{
    Task<EmailTransportResult> SendAsync(
        Guid outboxId,
        string recipientHash,
        ProtectedEmailEnvelope email,
        CancellationToken cancellationToken = default);
}

internal sealed class DevelopmentEmailTransport(ILogger<DevelopmentEmailTransport> logger) : IEmailTransport
{
    private static readonly Action<ILogger, Guid, string, string, Exception?> LogCaptured = LoggerMessage.Define<Guid, string, string>(
        LogLevel.Information, new EventId(1201, "DevelopmentEmailCaptured"),
        "Captured development email {OutboxId} template {Template} recipient {RecipientHash}");

    public Task<EmailTransportResult> SendAsync(
        Guid outboxId,
        string recipientHash,
        ProtectedEmailEnvelope email,
        CancellationToken cancellationToken = default)
    {
        LogCaptured(logger, outboxId, email.TemplateName, recipientHash, null);
        return Task.FromResult(new EmailTransportResult(EmailTransportDisposition.Sent, $"development-{outboxId:N}"));
    }
}

internal sealed class MailerSendOptions
{
    public string? ApiToken { get; set; }
    public string? FromEmail { get; set; }
    public string? FromName { get; set; }
    public string? WebhookSecret { get; set; }
}

internal sealed class MailerSendEmailTransport(HttpClient client, IOptions<MailerSendOptions> options) : IEmailTransport
{
    private readonly MailerSendOptions configured = options.Value;

    public async Task<EmailTransportResult> SendAsync(
        Guid outboxId,
        string recipientHash,
        ProtectedEmailEnvelope email,
        CancellationToken cancellationToken = default)
    {
        var template = EmailTemplates.Resolve(email.TemplateName);
        var (subject, text, html) = template.HasHtmlTemplate
            ? (template.Subject, EmailTemplateRenderer.RenderText(template, email.Model), EmailTemplateRenderer.RenderHtml(template, email.Model))
            : RenderPlainTextOnly(template, email.Model);
        using var request = new HttpRequestMessage(HttpMethod.Post, "v1/email")
        {
            Content = JsonContent.Create(new
            {
                from = new { email = configured.FromEmail, name = configured.FromName },
                to = new[] { new { email = email.Recipient } },
                subject,
                text,
                html
            })
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", configured.ApiToken);
        request.Headers.Add("X-Requested-With", $"license-outbox-{outboxId:N}");
        try
        {
            using var response = await client.SendAsync(request, cancellationToken);
            if (response.StatusCode == HttpStatusCode.Accepted)
                return new EmailTransportResult(EmailTransportDisposition.Sent,
                    response.Headers.TryGetValues("x-message-id", out var values) ? values.FirstOrDefault() : null);
            if (response.StatusCode == HttpStatusCode.TooManyRequests || (int)response.StatusCode >= 500)
                return new EmailTransportResult(EmailTransportDisposition.Retry, ErrorCode: $"http-{(int)response.StatusCode}");
            return new EmailTransportResult(EmailTransportDisposition.PermanentFailure, ErrorCode: $"http-{(int)response.StatusCode}");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new EmailTransportResult(EmailTransportDisposition.Uncertain, ErrorCode: "timeout-ambiguous");
        }
        catch (HttpRequestException)
        {
            return new EmailTransportResult(EmailTransportDisposition.Uncertain, ErrorCode: "network-ambiguous");
        }
    }

    // ContactSupport (#72) has no EmailTemplates/*.html file by design: it reads a small fixed
    // set of model keys directly rather than substituting tokens into a shared template, and its
    // subject is the human-readable contact reason rather than the template's static subject.
    private static (string Subject, string Text, string Html) RenderPlainTextOnly(
        EmailTemplate template, IReadOnlyDictionary<string, string> model)
    {
        var subject = model.TryGetValue("reason", out var reasonLabel) ? reasonLabel : template.Subject;
        var lines = new List<string>();
        if (model.TryGetValue("replyEmail", out var replyEmail)) lines.Add($"Reply email: {replyEmail}");
        if (model.TryGetValue("licenseId", out var licenseId)) lines.Add($"License ID: {licenseId}");
        lines.Add(string.Empty);
        if (model.TryGetValue("message", out var message)) lines.Add(message);
        var text = string.Join(Environment.NewLine, lines);
        var html = $"<p>{WebUtility.HtmlEncode(text).Replace("\n", "<br>", StringComparison.Ordinal)}</p>";
        return (subject, text, html);
    }
}

// Renders EmailTemplates/*.html files (embedded resources) by substituting {{placeholder}}
// tokens from a TransactionalEmail.Model, and derives a plain-text alternative from the same
// rendered HTML rather than keeping a second hand-written copy of each template's content.
internal static class EmailTemplateRenderer
{
    private static readonly ConcurrentDictionary<string, string> TemplateCache = new(StringComparer.Ordinal);
    private static readonly Regex PlaceholderPattern = new(@"\{\{(\w+)\}\}", RegexOptions.Compiled);
    private static readonly Regex ConditionalBlockPattern = new(
        @"\{\{#if (\w+)\}\}(.*?)\{\{/if\}\}", RegexOptions.Compiled | RegexOptions.Singleline);
    private static readonly Regex HeadPattern = new(@"<head[^>]*>.*?</head>", RegexOptions.Compiled | RegexOptions.Singleline | RegexOptions.IgnoreCase);
    private static readonly Regex CommentPattern = new(@"<!--.*?-->", RegexOptions.Compiled | RegexOptions.Singleline);
    private static readonly Regex AnchorPattern = new(
        "<a\\s+[^>]*href=\"(?<url>[^\"]*)\"[^>]*>(?<text>.*?)</a>",
        RegexOptions.Compiled | RegexOptions.Singleline | RegexOptions.IgnoreCase);
    private static readonly Regex BlockBreakPattern = new(
        @"</(p|tr|table|div|h1|h2|h3)>|<br\s*/?>", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex TagPattern = new("<[^>]+>", RegexOptions.Compiled);

    public static string RenderHtml(EmailTemplate template, IReadOnlyDictionary<string, string> model)
    {
        if (!template.HasHtmlTemplate)
            throw new InvalidOperationException(
                $"Template '{template.Name}' has no HTML file; it must use the plain-text-only rendering path.");
        return Substitute(ApplyConditionalBlocks(LoadSource(template.Name), model), model);
    }

    public static string RenderText(EmailTemplate template, IReadOnlyDictionary<string, string> model) =>
        ToPlainText(RenderHtml(template, model));

    private static string LoadSource(string templateName) =>
        TemplateCache.GetOrAdd(templateName, static name =>
        {
            var assembly = typeof(EmailTemplateRenderer).Assembly;
            var resourceName = $"{assembly.GetName().Name}.EmailTemplates.{name}.html";
            using var stream = assembly.GetManifestResourceStream(resourceName)
                ?? throw new InvalidOperationException($"Email template resource '{resourceName}' was not found.");
            using var reader = new StreamReader(stream);
            return reader.ReadToEnd();
        });

    // A placeholder with no matching model key renders as empty text: the token disappears
    // rather than leaking a raw "{{token}}" into a sent email or throwing and blocking the
    // whole send. This lets optional fields (e.g. an invoice link not yet generated) degrade
    // gracefully instead of requiring every template's every token to always be supplied.
    private static string Substitute(string source, IReadOnlyDictionary<string, string> model) =>
        PlaceholderPattern.Replace(source, match =>
            model.TryGetValue(match.Groups[1].Value, out var value) ? value : string.Empty);

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

    private static string ToPlainText(string html)
    {
        var withoutHead = HeadPattern.Replace(html, string.Empty);
        var withoutComments = CommentPattern.Replace(withoutHead, string.Empty);
        var withLinksInlined = AnchorPattern.Replace(withoutComments, match =>
        {
            var linkText = TagPattern.Replace(match.Groups["text"].Value, string.Empty).Trim();
            var url = match.Groups["url"].Value;
            return url.Length == 0 ? linkText : $"{linkText} ({url})";
        });
        var withBreaks = BlockBreakPattern.Replace(withLinksInlined, "\n");
        var stripped = TagPattern.Replace(withBreaks, string.Empty);
        var decoded = WebUtility.HtmlDecode(stripped);
        var lines = decoded.Split('\n')
            .Select(line => line.Trim())
            .Where(line => line.Length > 0);
        return string.Join(Environment.NewLine, lines);
    }
}

internal static class EmailRetrySchedule
{
    public static TimeSpan Delay(int attempt) =>
        TimeSpan.FromMinutes(Math.Min(360, Math.Pow(2, Math.Clamp(attempt, 1, 10))));
}

internal sealed class EmailOutboxProcessor(
    ApplicationDbContext db,
    TransactionalEmailSender sender,
    IEmailTransport transport,
    TimeProvider clock)
{
    public async Task<int> ProcessBatchAsync(CancellationToken cancellationToken = default)
    {
        var now = clock.GetUtcNow();
        await db.EmailDeliveryEvents.Where(item => item.ReceivedAt < now.AddDays(-30))
            .ExecuteDeleteAsync(cancellationToken);
        await db.EmailOutbox.Where(item => item.RetainUntil < now
                && item.Status != EmailOutboxStatus.Pending
                && item.Status != EmailOutboxStatus.Leased
                && item.Status != EmailOutboxStatus.Retry)
            .ExecuteDeleteAsync(cancellationToken);
        var leaseId = Guid.NewGuid();
        List<EmailOutboxMessage> batch;
        await using (var transaction = await db.Database.BeginTransactionAsync(cancellationToken))
        {
            batch = await db.EmailOutbox
                .FromSqlInterpolated($"""
                    SELECT * FROM "EmailOutbox"
                    WHERE (("Status" IN ('pending', 'retry') AND "NextAttemptAt" <= {now})
                        OR ("Status" = 'leased' AND "LeaseExpiresAt" <= {now}))
                    ORDER BY "NextAttemptAt", "CreatedAt"
                    FOR UPDATE SKIP LOCKED
                    LIMIT 10
                    """)
                .ToListAsync(cancellationToken);
            foreach (var row in batch)
            {
                row.Status = EmailOutboxStatus.Leased;
                row.LeaseId = leaseId;
                row.LeaseExpiresAt = now.AddMinutes(2);
                row.AttemptCount++;
            }
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }

        foreach (var row in batch)
        {
            EmailTransportResult result;
            try { result = await transport.SendAsync(row.Id, row.RecipientHash, sender.Unprotect(row), cancellationToken); }
            catch (Exception) when (!cancellationToken.IsCancellationRequested)
            {
                result = new EmailTransportResult(EmailTransportDisposition.Uncertain, ErrorCode: "transport-exception-ambiguous");
            }

            var completedAt = clock.GetUtcNow();
            row.ProviderMessageId = result.ProviderMessageId;
            row.LastErrorCode = result.ErrorCode;
            row.LeaseId = null;
            row.LeaseExpiresAt = null;
            switch (result.Disposition)
            {
                case EmailTransportDisposition.Sent:
                    row.Status = EmailOutboxStatus.Sent;
                    row.SentAt = completedAt;
                    break;
                case EmailTransportDisposition.Retry when row.AttemptCount < 8:
                    row.Status = EmailOutboxStatus.Retry;
                    row.NextAttemptAt = completedAt + EmailRetrySchedule.Delay(row.AttemptCount);
                    break;
                case EmailTransportDisposition.Retry:
                case EmailTransportDisposition.PermanentFailure:
                    row.Status = EmailOutboxStatus.Failed;
                    break;
                default:
                    // MailerSend has no idempotency contract for this request. An ambiguous
                    // network outcome requires reconciliation instead of a blind resend.
                    row.Status = EmailOutboxStatus.Uncertain;
                    break;
            }
            await db.SaveChangesAsync(cancellationToken);
        }
        return batch.Count;
    }
}

internal sealed class EmailOutboxWorker(
    IServiceScopeFactory scopes,
    IOptions<EmailWorkerOptions> options,
    ILogger<EmailOutboxWorker> logger) : BackgroundService
{
    private static readonly Action<ILogger, Exception?> LogIterationFailure = LoggerMessage.Define(
        LogLevel.Error, new EventId(1202, "EmailWorkerIterationFailed"),
        "Transactional email worker iteration failed without logging recipient or content.");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.Enabled) return;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopes.CreateAsyncScope();
                var processed = await scope.ServiceProvider.GetRequiredService<EmailOutboxProcessor>()
                    .ProcessBatchAsync(stoppingToken);
                await Task.Delay(processed == 0 ? TimeSpan.FromSeconds(5) : TimeSpan.FromMilliseconds(100), stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
            catch (Exception exception)
            {
                LogIterationFailure(logger, exception);
                await Task.Delay(TimeSpan.FromSeconds(10), stoppingToken);
            }
        }
    }
}

internal sealed class EmailWorkerOptions { public bool Enabled { get; set; } = true; }

internal sealed class TransactionalIdentityEmailSender(ITransactionalEmailSender sender) : IEmailSender<ApplicationUser>
{
    public Task SendConfirmationLinkAsync(ApplicationUser user, string email, string confirmationLink) =>
        QueueAsync(EmailTemplates.IdentityConfirmation, user, email, confirmationLink, "confirm");

    public Task SendPasswordResetLinkAsync(ApplicationUser user, string email, string resetLink) =>
        QueueAsync(EmailTemplates.IdentityPasswordRecovery, user, email, resetLink, "reset-link");

    public Task SendPasswordResetCodeAsync(ApplicationUser user, string email, string resetCode) =>
        sender.QueueAsync(new TransactionalEmail(EmailTemplates.IdentityPasswordRecovery, email,
            new Dictionary<string, string> { ["resetCode"] = resetCode }),
            $"identity:reset-code:{user.Id}:{SHA256Hex(resetCode)}");

    private Task<Guid> QueueAsync(EmailTemplate template, ApplicationUser user, string email, string actionUrl, string purpose) =>
        sender.QueueAsync(new TransactionalEmail(template, email,
            new Dictionary<string, string> { ["actionUrl"] = actionUrl }),
            $"identity:{purpose}:{user.Id}:{SHA256Hex(actionUrl)}");

    private static string SHA256Hex(string value) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}

internal sealed class MailerSendWebhookService(
    ApplicationDbContext db,
    IOptions<MailerSendOptions> options,
    TimeProvider clock)
{
    public async Task<bool> HandleAsync(string rawBody, string? signature, CancellationToken cancellationToken = default)
    {
        var secret = options.Value.WebhookSecret;
        if (string.IsNullOrWhiteSpace(secret) || string.IsNullOrWhiteSpace(signature)) return false;
        byte[] supplied;
        try { supplied = Convert.FromHexString(signature); }
        catch (FormatException) { return false; }
        var expected = HMACSHA256.HashData(Encoding.UTF8.GetBytes(secret), Encoding.UTF8.GetBytes(rawBody));
        if (supplied.Length != expected.Length || !CryptographicOperations.FixedTimeEquals(supplied, expected)) return false;

        using var document = JsonDocument.Parse(rawBody);
        var root = document.RootElement;
        var type = root.TryGetProperty("type", out var typeValue) ? typeValue.GetString() : null;
        if (string.IsNullOrWhiteSpace(type)) return true;
        var providerEventId = root.TryGetProperty("id", out var idValue) ? idValue.GetString() : null;
        providerEventId ??= Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(rawBody)));
        if (await db.EmailDeliveryEvents.AnyAsync(item => item.ProviderEventId == providerEventId, cancellationToken))
            return true;

        string? providerMessageId = null;
        if (root.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Object)
        {
            if (data.TryGetProperty("message_id", out var flatMessageId)) providerMessageId = flatMessageId.GetString();
            else if (data.TryGetProperty("email", out var email) && email.ValueKind == JsonValueKind.Object
                     && email.TryGetProperty("message", out var message) && message.ValueKind == JsonValueKind.Object
                     && message.TryGetProperty("id", out var nestedMessageId)) providerMessageId = nestedMessageId.GetString();
        }

        var now = clock.GetUtcNow();
        db.EmailDeliveryEvents.Add(new EmailDeliveryEvent
        {
            Id = Guid.NewGuid(), ProviderEventId = providerEventId, ProviderMessageId = providerMessageId,
            EventType = type, OccurredAt = now, ReceivedAt = now
        });
        if (!string.IsNullOrWhiteSpace(providerMessageId))
        {
            var row = await db.EmailOutbox.SingleOrDefaultAsync(item => item.ProviderMessageId == providerMessageId, cancellationToken);
            if (row is not null)
            {
                row.Status = type.Contains("complaint", StringComparison.OrdinalIgnoreCase) ? EmailOutboxStatus.Complained
                    : type.Contains("bounce", StringComparison.OrdinalIgnoreCase) ? EmailOutboxStatus.Bounced
                    : type.Contains("deliver", StringComparison.OrdinalIgnoreCase) ? EmailOutboxStatus.Delivered
                    : row.Status;
            }
        }
        await db.SaveChangesAsync(cancellationToken);
        return true;
    }
}
