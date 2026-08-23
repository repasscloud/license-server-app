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
internal sealed class R2InvoiceStorage : IInvoiceStorage, IDisposable
{
    private readonly AmazonS3Client? client;
    private readonly string? bucketName;
    private readonly TimeProvider clock;

    public R2InvoiceStorage(IOptions<R2Options> options, TimeProvider clock)
    {
        this.clock = clock;
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
            AuthenticationRegion = "auto",
            Timeout = TimeSpan.FromSeconds(15)
        });
    }

    public void Dispose()
    {
        client?.Dispose();
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
            Expires = clock.GetUtcNow().UtcDateTime.Add(validFor)
        });
        return new Uri(url);
    }
}
