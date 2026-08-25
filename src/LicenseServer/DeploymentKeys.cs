using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LicenseServer.Authorization;
using LicenseServer.Data;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.EntityFrameworkCore;
using SoftwareLicensing;

namespace LicenseServer;

internal sealed class DeploymentKeyHasher(byte[] pepper)
{
    public const string CurrentVersion = "hmac-sha256-v1";

    public byte[] Hash(string publicId, string secret)
    {
        using var hmac = new HMACSHA256(pepper);
        return hmac.ComputeHash(Encoding.UTF8.GetBytes($"{publicId}.{secret}"));
    }

    public bool Verify(string publicId, string secret, byte[] expected) =>
        CryptographicOperations.FixedTimeEquals(Hash(publicId, secret), expected);
}

internal static class DeploymentKeyFormat
{
    public const string Prefix = "dpk_live_";

    public static (string PublicId, string Secret, string FullValue) Generate()
    {
        var publicId = Convert.ToHexString(RandomNumberGenerator.GetBytes(8));
        var secret = WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(32));
        return (publicId, secret, $"{Prefix}{publicId}_{secret}");
    }

    public static bool TryParse(string? value, out string publicId, out string secret)
    {
        publicId = secret = "";
        if (string.IsNullOrEmpty(value) || !value.StartsWith(Prefix, StringComparison.Ordinal)) return false;
        var separator = value.IndexOf('_', Prefix.Length);
        if (separator < 0) return false;
        publicId = value[Prefix.Length..separator];
        secret = value[(separator + 1)..];
        return publicId.Length == 16 && secret.Length == 43;
    }
}

internal sealed class DeploymentKeyService(
    ApplicationDbContext db,
    LicenseStore licenseStore,
    DeploymentKeyHasher hasher,
    PermissionGuard permissions,
    ILicenseSigner signer,
    TimeProvider clock)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<StoreResult<CreatedDeploymentKey>> CreateAsync(
        string licenseId, CreateDeploymentKeyRequest request, string actor, CancellationToken cancellationToken = default)
    {
        await permissions.RequireAsync(Permissions.DeploymentKeysManage);
        var name = request.Name?.Trim();
        if (string.IsNullOrWhiteSpace(name) || name.Length > 200)
            return StoreResult<CreatedDeploymentKey>.BadRequest(
                "Deployment key name is required and cannot exceed 200 characters.", "name");
        var now = clock.GetUtcNow();
        if (request.ExpiresAt is not null && request.ExpiresAt <= now)
            return StoreResult<CreatedDeploymentKey>.BadRequest("Expiry must be in the future.", "expiresAt");

        var license = await db.Licenses.SingleOrDefaultAsync(x => x.LicenseId == licenseId, cancellationToken);
        if (license is null) return StoreResult<CreatedDeploymentKey>.NotFound("License was not found.");
        if (license.CancelledAt is not null || license.RevokedAt is not null)
            return StoreResult<CreatedDeploymentKey>.Conflict(
                "A cancelled or revoked license cannot receive new deployment keys.");

        var (publicId, secret, fullValue) = DeploymentKeyFormat.Generate();
        var record = new DeploymentKey
        {
            Id = Guid.NewGuid(),
            LicenseRecordId = license.Id,
            License = license,
            Name = name,
            PublicId = publicId,
            SecretHash = hasher.Hash(publicId, secret),
            SecretHashVersion = DeploymentKeyHasher.CurrentVersion,
            LastFour = secret[^4..],
            CreatedAt = now,
            CreatedBy = actor,
            ExpiresAt = request.ExpiresAt?.ToUniversalTime()
        };
        db.DeploymentKeys.Add(record);
        AddAudit(actor, "deployment-key.created", record, new { record.Name, licenseId, record.ExpiresAt });
        await db.SaveChangesAsync(cancellationToken);
        return StoreResult<CreatedDeploymentKey>.Ok(new CreatedDeploymentKey(ToView(record), fullValue));
    }

    public async Task<StoreResult<IReadOnlyList<DeploymentKeyView>>> ListAsync(
        string licenseId, CancellationToken cancellationToken = default)
    {
        await permissions.RequireAsync(Permissions.DeploymentKeysRead);
        var license = await db.Licenses.AsNoTracking().SingleOrDefaultAsync(x => x.LicenseId == licenseId, cancellationToken);
        if (license is null) return StoreResult<IReadOnlyList<DeploymentKeyView>>.NotFound("License was not found.");
        var rows = await db.DeploymentKeys.AsNoTracking()
            .Where(x => x.LicenseRecordId == license.Id)
            .OrderByDescending(x => x.CreatedAt)
            .ToListAsync(cancellationToken);
        return StoreResult<IReadOnlyList<DeploymentKeyView>>.Ok(rows.Select(ToView).ToArray());
    }

    public async Task<StoreResult<DeploymentKeyView>> RenameAsync(
        Guid id, string? name, string actor, CancellationToken cancellationToken = default)
    {
        await permissions.RequireAsync(Permissions.DeploymentKeysManage);
        var trimmed = name?.Trim();
        if (string.IsNullOrWhiteSpace(trimmed) || trimmed.Length > 200)
            return StoreResult<DeploymentKeyView>.BadRequest(
                "Deployment key name is required and cannot exceed 200 characters.", "name");
        var key = await db.DeploymentKeys.SingleOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (key is null) return StoreResult<DeploymentKeyView>.NotFound("Deployment key was not found.");
        var old = key.Name;
        key.Name = trimmed;
        AddAudit(actor, "deployment-key.renamed", key, new { old, @new = trimmed });
        await db.SaveChangesAsync(cancellationToken);
        return StoreResult<DeploymentKeyView>.Ok(ToView(key));
    }

    public async Task<StoreResult<CreatedDeploymentKey>> RotateAsync(
        Guid id, string actor, CancellationToken cancellationToken = default)
    {
        await permissions.RequireAsync(Permissions.DeploymentKeysManage);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        // FOR UPDATE: without a row lock, two concurrent rotations of the same key can both read
        // RevokedAt == null before either commits, and both would then create a live, unrevoked
        // replacement - leaving two valid successor keys instead of exactly one. The lock forces
        // the second caller to wait for the first's commit, then re-read the now-revoked row and
        // correctly hit the RevokedAt guard below instead of racing it.
        var current = await db.DeploymentKeys
            .FromSqlInterpolated($"SELECT * FROM \"DeploymentKeys\" WHERE \"Id\" = {id} FOR UPDATE")
            .Include(x => x.License)
            .SingleOrDefaultAsync(cancellationToken);
        if (current is null) return StoreResult<CreatedDeploymentKey>.NotFound("Deployment key was not found.");
        var now = clock.GetUtcNow();
        if (current.RevokedAt is not null)
            return StoreResult<CreatedDeploymentKey>.Conflict("A revoked deployment key cannot be rotated.");
        if (current.ExpiresAt is not null && current.ExpiresAt <= now)
            return StoreResult<CreatedDeploymentKey>.Conflict("An expired deployment key cannot be rotated; create a new one.");

        var (publicId, secret, fullValue) = DeploymentKeyFormat.Generate();
        var replacement = new DeploymentKey
        {
            Id = Guid.NewGuid(),
            LicenseRecordId = current.LicenseRecordId,
            License = current.License,
            Name = current.Name,
            PublicId = publicId,
            SecretHash = hasher.Hash(publicId, secret),
            SecretHashVersion = DeploymentKeyHasher.CurrentVersion,
            LastFour = secret[^4..],
            CreatedAt = now,
            CreatedBy = actor,
            ExpiresAt = current.ExpiresAt
        };
        current.RevokedAt = now;
        current.RevokedBy = actor;
        current.RevocationReason = "Rotated";
        current.ReplacedByDeploymentKeyId = replacement.Id;
        db.DeploymentKeys.Add(replacement);
        AddAudit(actor, "deployment-key.rotated", current, new { replacementPublicId = publicId });
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return StoreResult<CreatedDeploymentKey>.Ok(new CreatedDeploymentKey(ToView(replacement), fullValue));
    }

    public async Task<StoreResult<bool>> RevokeAsync(
        Guid id, string? reason, string actor, CancellationToken cancellationToken = default)
    {
        await permissions.RequireAsync(Permissions.DeploymentKeysManage);
        var key = await db.DeploymentKeys.SingleOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (key is null) return StoreResult<bool>.NotFound("Deployment key was not found.");
        if (key.RevokedAt is not null) return StoreResult<bool>.Ok(true);
        key.RevokedAt = clock.GetUtcNow();
        key.RevokedBy = actor;
        key.RevocationReason = string.IsNullOrWhiteSpace(reason) ? null : reason.Trim()[..Math.Min(reason.Trim().Length, 500)];
        AddAudit(actor, "deployment-key.revoked", key, new { reason = key.RevocationReason });
        await db.SaveChangesAsync(cancellationToken);
        return StoreResult<bool>.Ok(true);
    }

    public async Task<StoreResult<LicenseStore.ActiveActivation>> EnrollAsync(
        EnrollDeploymentKeyRequest request,
        DateTimeOffset now,
        string? requestedSigningKeyId = null,
        CancellationToken cancellationToken = default)
    {
        var validation = ValidateEnrollRequest(request);
        if (validation is not null)
            return StoreResult<LicenseStore.ActiveActivation>.BadRequest(validation);
        if (!signer.CanSign(requestedSigningKeyId))
            return StoreResult<LicenseStore.ActiveActivation>.ServiceUnavailable(
                "No signing key is currently able to sign. Try again once an administrator restores a default or active signing key.");
        if (!DeploymentKeyFormat.TryParse(request.DeploymentKey, out var publicId, out var secret))
        {
            AddRejectionAudit(null, "unparseable", "malformed-credential", now);
            await db.SaveChangesAsync(cancellationToken);
            return StoreResult<LicenseStore.ActiveActivation>.Unauthorized("Deployment key is invalid.");
        }

        var requestId = Guid.Parse(request.RequestId!);
        var tokenHash = LicenseStore.Hash(request.ActivationToken!);

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        try
        {
            var key = await db.DeploymentKeys
                .FromSqlInterpolated($"SELECT * FROM \"DeploymentKeys\" WHERE \"PublicId\" = {publicId} FOR UPDATE")
                .SingleOrDefaultAsync(cancellationToken);
            if (key is null || key.SecretHashVersion != DeploymentKeyHasher.CurrentVersion
                || !hasher.Verify(publicId, secret, key.SecretHash))
            {
                AddRejectionAudit(null, publicId, "invalid-credential", now);
                await db.SaveChangesAsync(cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return StoreResult<LicenseStore.ActiveActivation>.Unauthorized("Deployment key is invalid.");
            }
            if (key.RevokedAt is not null)
            {
                AddRejectionAudit(key, publicId, "revoked", now);
                await db.SaveChangesAsync(cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return StoreResult<LicenseStore.ActiveActivation>.Unauthorized("Deployment key has been revoked.");
            }
            if (key.ExpiresAt is not null && key.ExpiresAt <= now)
            {
                AddRejectionAudit(key, publicId, "expired", now);
                await db.SaveChangesAsync(cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return StoreResult<LicenseStore.ActiveActivation>.Unauthorized("Deployment key has expired.");
            }

            var license = await db.Licenses
                .FromSqlInterpolated($"SELECT * FROM \"Licenses\" WHERE \"Id\" = {key.LicenseRecordId} FOR UPDATE")
                .Include(x => x.Entitlements)
                .SingleAsync(cancellationToken);

            var normalizedDeviceId = request.Device!.DeviceId!.ToUpperInvariant();
            var result = await licenseStore.ActivateWithinLockAsync(
                license, requestId, normalizedDeviceId, request.Device.DeviceId[^8..].ToUpperInvariant(),
                CleanDeviceName(request.Device.DeviceName), request.Mode!, tokenHash, now,
                key.Id, $"deployment-key:{key.PublicId}", cancellationToken);

            if (result.Success)
            {
                key.LastUsedAt = now;
                AddAudit($"deployment-key:{key.PublicId}", "deployment-key.enrollment-succeeded", key, new
                {
                    activationId = result.Value!.ActivationId,
                    deviceSuffix = result.Value.DeviceIdSuffix
                });
            }
            else
            {
                AddRejectionAudit(key, publicId, result.Error ?? "rejected", now);
            }

            // Intentionally diverges from ActivateWithinLockAsync's documented contract ("on a
            // Success result the caller must SaveChanges+Commit; on failure the caller lets the
            // transaction roll back on dispose"): we commit unconditionally here, on both the
            // success and failure branches, because a rejection still needs its audit record
            // (added above by AddRejectionAudit) persisted even though the enrollment itself
            // failed. This is safe today because every failure path inside
            // ActivateWithinLockAsync returns before mutating anything - it is read-only right up
            // to the point it decides to insert the Activation row - so committing on failure is
            // currently a no-op for that part of the transaction; only our own audit insert is
            // actually persisted. If ActivateWithinLockAsync ever grows a failure path that
            // mutates state before returning, this blanket commit would need revisiting.
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return result;
        }
        catch (Exception exception) when (exception is DbUpdateException || LicenseStore.IsSerializationFailure(exception))
        {
            await transaction.RollbackAsync(cancellationToken);
            return StoreResult<LicenseStore.ActiveActivation>.Conflict(
                "The license was activated concurrently. Retry to see the active device.");
        }
    }

    // Lets a deployment-key holder release the seat held by an activation matching a caller-
    // supplied deviceId, when the local activationToken was lost (e.g. a build shipped with a
    // mismatched key pair, so enrollment succeeded server-side but the client never persisted the
    // token - see issue #88). deviceId is recomputed with the same os-machine-id-sha256-v1 scheme
    // used at enrollment, but - exactly like enroll's own deviceId handling - it is a deterministic,
    // self-reported identifier, NOT a cryptographic proof that the call originates on that specific
    // device: the server cannot verify hardware possession, and the full deviceId hash is embedded
    // in every signed license artifact (see LicenseStore.CreateLicenseAsync), so anyone who can
    // read another machine's license file (or clones a VM image before individualization) and also
    // holds the shared deployment key can force-release that machine's seat. This mirrors the
    // existing enroll endpoint's trust model (the deployment key is the actual credential; deviceId
    // is bookkeeping, not authentication) but is more dangerous because it can interrupt an already-
    // running machine rather than merely contest a free seat. The blast radius is bounded, not
    // eliminated, by a dedicated - and deliberately much stricter than enroll's - rate limit
    // ("deployment-key-force-deactivate") plus an audit record on every call, success or rejection,
    // so repeated or successful abuse is both slow and immediately visible. See the "Recovering a
    // seat" section of docs/ai/deployment-key-machine-activation.md for the full trust-model
    // writeup and the guidance to rotate the deployment key if abuse is suspected.
    //
    // Every branch below (validation failure, credential failure, and the actual attempt) writes
    // its rejection/success audit and they all share one Serializable transaction committed exactly
    // once at the end - deliberately diverging from ForceDeactivateWithinLockAsync's documented
    // "no transaction, caller commits" contract only in the sense that we are that caller: this
    // keeps the activation change and every audit record for one call atomic, so a later failure in
    // this method can never leave the seat released without its audit trail (or vice versa).
    public async Task<StoreResult<LicenseStore.ActiveActivation>> ForceDeactivateAsync(
        ForceDeactivateDeploymentKeyRequest request,
        DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        const string rejectedAction = "deployment-key.force-deactivation-rejected";
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);

        var validation = ValidateForceDeactivateRequest(request);
        if (validation is not null)
        {
            AddRejectionAudit(null, request.DeploymentKey ?? "unknown", "invalid-request", now, rejectedAction);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return StoreResult<LicenseStore.ActiveActivation>.BadRequest(validation);
        }
        if (!DeploymentKeyFormat.TryParse(request.DeploymentKey, out var publicId, out var secret))
        {
            AddRejectionAudit(null, "unparseable", "malformed-credential", now, rejectedAction);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return StoreResult<LicenseStore.ActiveActivation>.Unauthorized("Deployment key is invalid.");
        }

        var key = await db.DeploymentKeys
            .FromSqlInterpolated($"SELECT * FROM \"DeploymentKeys\" WHERE \"PublicId\" = {publicId} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);
        if (key is null || key.SecretHashVersion != DeploymentKeyHasher.CurrentVersion
            || !hasher.Verify(publicId, secret, key.SecretHash))
        {
            AddRejectionAudit(null, publicId, "invalid-credential", now, rejectedAction);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return StoreResult<LicenseStore.ActiveActivation>.Unauthorized("Deployment key is invalid.");
        }
        if (key.RevokedAt is not null)
        {
            AddRejectionAudit(key, publicId, "revoked", now, rejectedAction);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return StoreResult<LicenseStore.ActiveActivation>.Unauthorized("Deployment key has been revoked.");
        }
        if (key.ExpiresAt is not null && key.ExpiresAt <= now)
        {
            AddRejectionAudit(key, publicId, "expired", now, rejectedAction);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return StoreResult<LicenseStore.ActiveActivation>.Unauthorized("Deployment key has expired.");
        }

        var normalizedDeviceId = request.Device!.DeviceId!.ToUpperInvariant();
        var result = await licenseStore.ForceDeactivateWithinLockAsync(
            key.LicenseRecordId, normalizedDeviceId, now, $"deployment-key:{key.PublicId}", cancellationToken);

        if (result.Success)
        {
            key.LastUsedAt = now;
            AddAudit($"deployment-key:{key.PublicId}", "deployment-key.force-deactivation-succeeded", key, new
            {
                activationId = result.Value!.ActivationId,
                deviceSuffix = result.Value.DeviceIdSuffix
            });
        }
        else
        {
            AddRejectionAudit(key, publicId, result.Error ?? "rejected", now, rejectedAction);
        }
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return result;
    }

    private static string? ValidateForceDeactivateRequest(ForceDeactivateDeploymentKeyRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.DeploymentKey))
            return "A deployment key is required.";
        if (request.Device is null
            || !string.Equals(request.Device.Scheme, DeviceIdentity.Scheme, StringComparison.Ordinal)
            || request.Device.DeviceId is null
            || !DeviceIdentity.IsValidDeviceId(request.Device.DeviceId))
            return $"Device must use {DeviceIdentity.Scheme} with a 64-character SHA-256 identifier.";
        return null;
    }

    private void AddAudit(string actor, string action, DeploymentKey key, object context) =>
        db.AuditRecords.Add(new AuditRecord
        {
            Actor = actor,
            Action = action,
            TargetType = "deployment-key",
            TargetId = key.PublicId,
            Result = "success",
            ContextJson = JsonSerializer.Serialize(new
            {
                publicId = key.PublicId,
                lastFour = key.LastFour,
                licenseRecordId = key.LicenseRecordId,
                extra = context
            }, JsonOptions),
            TimestampUtc = clock.GetUtcNow()
        });

    private void AddRejectionAudit(
        DeploymentKey? key, string publicId, string reason, DateTimeOffset now,
        string action = "deployment-key.enrollment-rejected") =>
        db.AuditRecords.Add(new AuditRecord
        {
            Actor = "anonymous",
            Action = action,
            TargetType = "deployment-key",
            TargetId = key?.PublicId ?? publicId,
            Result = "rejected",
            ContextJson = JsonSerializer.Serialize(new { reason, lastFour = key?.LastFour }, JsonOptions),
            TimestampUtc = now
        });

    private static string? ValidateEnrollRequest(EnrollDeploymentKeyRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.DeploymentKey))
            return "A deployment key is required.";
        if (request.Device is null
            || !string.Equals(request.Device.Scheme, DeviceIdentity.Scheme, StringComparison.Ordinal)
            || request.Device.DeviceId is null
            || !DeviceIdentity.IsValidDeviceId(request.Device.DeviceId))
            return $"Device must use {DeviceIdentity.Scheme} with a 64-character SHA-256 identifier.";
        if (request.Mode is not ("online" or "offline"))
            return "Mode must be 'online' or 'offline'.";
        if (!Guid.TryParse(request.RequestId, out _) || !IsStrongActivationToken(request.ActivationToken))
            return "RequestId must be a GUID and activationToken must be 32 random bytes encoded as Base64.";
        return null;
    }

    private static bool IsStrongActivationToken(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        try { return Convert.FromBase64String(value).Length == 32; }
        catch (FormatException) { return false; }
    }

    private static string? CleanDeviceName(string? value) => string.IsNullOrWhiteSpace(value)
        ? null
        : value.Trim()[..Math.Min(value.Trim().Length, 100)];

    private static DeploymentKeyView ToView(DeploymentKey key) => new(
        key.Id, key.PublicId, key.Name, key.LicenseRecordId, key.LastFour,
        key.CreatedAt, key.CreatedBy, key.ExpiresAt, key.RevokedAt, key.LastUsedAt, key.ReplacedByDeploymentKeyId);
}
