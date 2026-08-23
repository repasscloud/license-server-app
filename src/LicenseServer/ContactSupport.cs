namespace LicenseServer;

internal static class ContactSupportReasons
{
    public const string MachineWideActivation = "machine-wide-activation";
    public const string Billing = "billing";
    public const string Technical = "technical";
    public const string Other = "other";

    public static readonly IReadOnlyList<(string Value, string Label)> All =
    [
        (MachineWideActivation, "Machine-wide activation code"),
        (Billing, "Billing question"),
        (Technical, "Technical support"),
        (Other, "Other")
    ];

    public static string? LabelFor(string? value) =>
        All.Where(item => string.Equals(item.Value, value, StringComparison.Ordinal))
            .Select(item => item.Label)
            .SingleOrDefault();
}

internal sealed record ContactSupportSubmission(string? Reason, string? ReplyEmail, string? LicenseId, string? Message);

internal sealed record ContactSupportResult(bool Success, string? Error);

internal sealed class ContactSupportService(ITransactionalEmailSender sender)
{
    internal const string SupportRecipient = "hello@repasscloud.com";
    private const int MaxMessageLength = 4000;
    private const int MaxLicenseIdLength = 64;

    public async Task<ContactSupportResult> SubmitAsync(
        ContactSupportSubmission submission, CancellationToken cancellationToken = default)
    {
        var label = ContactSupportReasons.LabelFor(submission.Reason);
        if (label is null)
            return new ContactSupportResult(false, "Select a valid reason.");
        if (!CustomerEmails.TryNormalize(submission.ReplyEmail, out var replyEmail, out _))
            return new ContactSupportResult(false, "Enter a valid reply email address.");
        var message = submission.Message?.Trim();
        if (string.IsNullOrWhiteSpace(message))
            return new ContactSupportResult(false, "A message is required.");
        if (message.Length > MaxMessageLength)
            return new ContactSupportResult(false, "Message is too long.");
        var licenseId = submission.LicenseId?.Trim();
        if (licenseId is { Length: > MaxLicenseIdLength })
            return new ContactSupportResult(false, "License ID is too long.");

        var model = new Dictionary<string, string>
        {
            ["reason"] = label,
            ["replyEmail"] = replyEmail,
            ["message"] = message
        };
        if (!string.IsNullOrEmpty(licenseId))
            model["licenseId"] = licenseId;

        await sender.QueueAsync(
            new TransactionalEmail(EmailTemplates.ContactSupport, SupportRecipient, model),
            $"support:contact:{Guid.NewGuid():N}",
            cancellationToken);
        return new ContactSupportResult(true, null);
    }
}
