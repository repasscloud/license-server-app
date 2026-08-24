using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Globalization;
using LicenseServer.Data;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Npgsql;
using SoftwareLicensing;
using LicenseServer.Authorization;

namespace LicenseServer;

internal sealed class LicenseStore(
    ApplicationDbContext db,
    LicenseIdAllocator licenseIds,
    TimeProvider clock,
    IActivationCodeGenerator activationCodeGenerator,
    IActivationCodeHasher activationCodeHasher,
    IDataProtectionProvider dataProtectionProvider,
    IOptions<ActivationCodeOptions> activationCodeOptions,
    PermissionGuard permissions,
    ILicenseSigner signer)
{
    private readonly IDataProtector issuanceResultProtector = dataProtectionProvider.CreateProtector(
        "LicenseServer.IssuanceResult.v1");

    internal async Task<StoreResult<IssuedLicense>> IssueForBillingAsync(
        IssueLicenseRequest request,
        Customer customer,
        IssuanceContext context,
        CancellationToken cancellationToken = default)
    {
        if (db.Database.CurrentTransaction is null)
            throw new InvalidOperationException("Billing issuance must participate in the billing transaction.");
        var now = clock.GetUtcNow();
        var edition = request.Edition?.Trim().ToLowerInvariant();
        var licenseType = request.LicenseType?.Trim().ToLowerInvariant();
        if (!CustomerEmails.TryNormalize(customer.Email, out var customerEmail, out var emailError))
            return StoreResult<IssuedLicense>.BadRequest(emailError!, "customerEmail");
        if (request.ProductId is null || request.ProductId == Guid.Empty)
            return StoreResult<IssuedLicense>.BadRequest("An active product ID is required.", "productId");
        if (!LicenseEditions.IsSupported(edition))
            return StoreResult<IssuedLicense>.BadRequest("Edition is not an approved controlled value.", "edition");
        if (request.Seats <= 0)
            return StoreResult<IssuedLicense>.BadRequest("Seats must be greater than zero.", "seats");
        if (!LicenseTerms.TryCanonicalizeIssuanceExpiry(licenseType, request.ExpiresAt, now, out var expiry, out var error))
            return StoreResult<IssuedLicense>.BadRequest(error!, "expiresAt");

        var product = await db.ProductDefinitions.SingleOrDefaultAsync(
            item => item.Id == request.ProductId.Value && item.IsActive, cancellationToken);
        if (product is null)
            return StoreResult<IssuedLicense>.BadRequest("The selected product does not exist or is archived.", "productId");

        var metadata = new JsonObject();
        if (request.Metadata is not null)
        {
            foreach (var item in request.Metadata.Where(item =>
                         !string.Equals(item.Key, "contactEmail", StringComparison.Ordinal)
                         && item.Value is string or bool or int or long or decimal or double))
                metadata[item.Key] = JsonValue.Create(item.Value);
        }
        metadata["contactEmail"] = customerEmail;
        var activationCode = activationCodeGenerator.Generate();
        var activationHash = activationCodeHasher.Hash(activationCode);
        var licenseId = await licenseIds.AllocateAsync(now, cancellationToken);
        var license = new LicenseRecord
        {
            Id = Guid.NewGuid(),
            LicenseId = licenseId,
            CustomerId = customer.Id,
            Customer = customer,
            ActivationCodeHash = activationHash.Value,
            ActivationCodeHashVersion = activationHash.Version,
            MetadataJson = metadata.ToJsonString(),
            IssuedAt = now,
            ExpiresAt = expiry,
            Entitlements =
            [
                new Entitlement
                {
                    Id = Guid.NewGuid(), ProductDefinitionId = product.Id, ProductDefinition = product,
                    Product = product.Code, Edition = edition!, LicenseType = licenseType!, Seats = request.Seats,
                    UpdatesUntil = request.UpdatesUntil, License = null!
                }
            ]
        };
        db.Licenses.Add(license);
        AddAudit(context.Actor, "license.issued", "license", licenseId, "success", new
        {
            customerId = customer.Id,
            productId = product.Id,
            product = product.Code,
            edition,
            licenseType,
            expiresAt = expiry,
            seats = request.Seats,
            correlationId = context.CorrelationId
        }, now);
        await db.SaveChangesAsync(cancellationToken);
        return StoreResult<IssuedLicense>.Ok(new IssuedLicense(
            licenseId, activationCode, metadata,
            [new IssuedEntitlement(product.Code, edition!, licenseType!, request.Seats, expiry)]));
    }

    internal async Task<StoreResult<bool>> ApplyBillingTermsAsync(
        LicenseRecord license,
        ProductDefinition product,
        string edition,
        int seats,
        DateTimeOffset expiry,
        string eventId,
        string action,
        CancellationToken cancellationToken = default)
    {
        if (db.Database.CurrentTransaction is null)
            throw new InvalidOperationException("Billing terms must participate in the billing transaction.");
        if (!LicenseEditions.IsSupported(edition) || seats <= 0)
            return StoreResult<bool>.BadRequest("Mapped billing terms are invalid.");
        await db.Entry(license).Collection(item => item.Entitlements).LoadAsync(cancellationToken);
        if (license.Entitlements.Count != 1)
            return StoreResult<bool>.Conflict("Billing terms require exactly one entitlement.");
        var entitlement = license.Entitlements[0];
        var old = new { license.ExpiresAt, entitlement.Product, entitlement.Edition, entitlement.Seats };
        license.ExpiresAt = expiry.ToUniversalTime();
        entitlement.ProductDefinitionId = product.Id;
        entitlement.ProductDefinition = product;
        entitlement.Product = product.Code;
        entitlement.Edition = edition;
        entitlement.Seats = seats;
        db.Entry(license).Property(item => item.Version).IsModified = true;
        AddAudit("billing:stripe", action, "license", license.LicenseId, "success", new
        {
            eventId,
            old,
            @new = new { expiresAt = expiry, product = product.Code, edition, seats },
            correlationId = eventId
        }, clock.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);
        return StoreResult<bool>.Ok(true);
    }
    public async Task<StoreResult<IssuedLicense>> IssueAsync(
        IssueLicenseRequest request, IssuanceContext context,
        CancellationToken cancellationToken = default)
    {
        await permissions.RequireAsync(Permissions.LicensesIssue);
        var now = clock.GetUtcNow();
        var customerName = request.CustomerName?.Trim();
        var edition = request.Edition?.Trim().ToLowerInvariant();
        var licenseType = request.LicenseType?.Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(customerName))
            return StoreResult<IssuedLicense>.BadRequest("Customer name is required.", "customerName");
        if (request.ProductId is null || request.ProductId == Guid.Empty)
            return StoreResult<IssuedLicense>.BadRequest("An active product ID is required.", "productId");
        if (!CustomerEmails.TryNormalize(request.CustomerEmail, out var customerEmail, out var emailError))
            return StoreResult<IssuedLicense>.BadRequest(emailError!, "customerEmail");
        if (!LicenseEditions.IsSupported(edition))
            return StoreResult<IssuedLicense>.BadRequest("Edition is not an approved controlled value.", "edition");
        if (request.Seats <= 0)
            return StoreResult<IssuedLicense>.BadRequest("Seats must be greater than zero.", "seats");
        if (!LicenseTerms.TryCanonicalizeIssuanceExpiry(licenseType, request.ExpiresAt, now, out var expiry, out var error))
            return StoreResult<IssuedLicense>.BadRequest(error!, LicenseTerms.IsSupportedType(licenseType) ? "expiresAt" : "licenseType");

        var metadata = new JsonObject();
        if (request.Metadata is not null)
        {
            foreach (var item in request.Metadata.Where(item =>
                         !string.Equals(item.Key, "contactEmail", StringComparison.Ordinal)
                         && item.Value is string or bool or int or long or decimal or double))
                metadata[item.Key] = JsonValue.Create(item.Value);
        }
        metadata["contactEmail"] = customerEmail;

        var idempotency = ValidateIdempotency(context, request);
        if (idempotency.Error is not null)
            return StoreResult<IssuedLicense>.BadRequest(idempotency.Error);

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            if (idempotency.Identity is not null
                && await ReplayAsync(idempotency.Identity, now, cancellationToken) is { } replay)
                return replay;

            var product = await db.ProductDefinitions.SingleOrDefaultAsync(
                item => item.Id == request.ProductId.Value && item.IsActive,
                cancellationToken);
            if (product is null)
                return StoreResult<IssuedLicense>.BadRequest("The selected product does not exist or is archived.", "productId");

            // PostgreSQL serializes the single upserted counter row for this business date.
            // Read committed avoids whole-transaction serialization retries while the atomic
            // statement and unique license index retain concurrency safety. A later rollback
            // rolls back this allocation with the license, customer, entitlement, and audit row.
            var licenseId = await licenseIds.AllocateAsync(now, cancellationToken);
            // Allocation locks the day's counter row. Recheck after acquiring it so two
            // simultaneous submissions with one key cannot both proceed to issuance.
            if (idempotency.Identity is not null
                && await ReplayAsync(idempotency.Identity, now, cancellationToken) is { } serializedReplay)
                return serializedReplay;

            var activationCode = activationCodeGenerator.Generate();
            var activationHash = activationCodeHasher.Hash(activationCode);
            var license = new LicenseRecord
            {
                Id = Guid.NewGuid(),
                LicenseId = licenseId,
                Customer = new Customer
                {
                    Id = Guid.NewGuid(),
                    Name = customerName,
                    Email = customerEmail,
                    NormalizedEmail = customerEmail,
                    CreatedAt = now
                },
                ActivationCodeHash = activationHash.Value,
                ActivationCodeHashVersion = activationHash.Version,
                MetadataJson = metadata.ToJsonString(),
                IssuedAt = now,
                ExpiresAt = expiry,
                Entitlements =
                [
                    new Entitlement
                    {
                        Id = Guid.NewGuid(), Edition = edition!, LicenseType = licenseType!,
                        ProductDefinitionId = product.Id, ProductDefinition = product,
                        Product = product.Code, Seats = request.Seats, UpdatesUntil = request.UpdatesUntil, License = null!
                    }
                ]
            };
            db.Licenses.Add(license);
            AddAudit(context.Actor, "license.issued", "license", licenseId, "success", new
            {
                customer = customerName,
                productId = product.Id,
                product = product.Code,
                edition,
                licenseType,
                expiresAt = expiry,
                seats = request.Seats,
                correlationId = context.CorrelationId
            }, now);
            var issued = new IssuedLicense(
                licenseId, activationCode, metadata,
                [new IssuedEntitlement(product.Code, edition!, licenseType!, request.Seats, expiry)]);
            if (idempotency.Identity is not null)
            {
                db.IssuanceIdempotencyRecords.Add(new IssuanceIdempotencyRecord
                {
                    Id = Guid.NewGuid(),
                    PrincipalId = idempotency.Identity.PrincipalId,
                    KeyHash = idempotency.Identity.KeyHash,
                    RequestHash = idempotency.Identity.RequestHash,
                    ProtectedResult = issuanceResultProtector.Protect(JsonSerializer.Serialize(issued)),
                    CreatedAt = now,
                    ExpiresAt = now.AddMinutes(Math.Clamp(activationCodeOptions.Value.IdempotencyWindowMinutes, 1, 15))
                });
            }
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);

            return StoreResult<IssuedLicense>.Ok(issued);
        }
        catch (LicenseIdExhaustedException exception)
        {
            await transaction.RollbackAsync(cancellationToken);
            db.ChangeTracker.Clear();
            return StoreResult<IssuedLicense>.Conflict(exception.Message);
        }
        catch (DbUpdateException)
        {
            await transaction.RollbackAsync(cancellationToken);
            db.ChangeTracker.Clear();
            return StoreResult<IssuedLicense>.Conflict("The license could not be issued concurrently. Retry the request.");
        }
    }

    public async Task<StoreResult<ActiveActivation>> ActivateAsync(
        string licenseId,
        ActivateRequest request,
        DateTimeOffset now,
        string? requestedSigningKeyId = null,
        CancellationToken cancellationToken = default)
    {
        var validation = ValidateActivationRequest(request);
        if (validation is not null)
            return StoreResult<ActiveActivation>.BadRequest(validation);

        // Checked before any state is mutated: signing happens after this method commits (the
        // caller needs the committed activation's ID/timestamps to build the license artifact), so
        // a signing failure discovered only after commit would leave the activation - and the
        // request ID that made it idempotent - unusably stuck with no artifact ever issued.
        if (!signer.CanSign(requestedSigningKeyId))
            return StoreResult<ActiveActivation>.ServiceUnavailable(
                "No signing key is currently able to sign. Try again once an administrator restores a default or active signing key.");

        var requestId = Guid.Parse(request.RequestId!);
        var tokenHash = Hash(request.ActivationToken!);

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        try
        {
            var license = await db.Licenses
                .FromSqlInterpolated($"SELECT * FROM \"Licenses\" WHERE \"LicenseId\" = {licenseId} FOR UPDATE")
                .Include(x => x.Entitlements)
                .SingleOrDefaultAsync(cancellationToken);

            if (license is null)
                return StoreResult<ActiveActivation>.NotFound("License was not found.");
            if (!activationCodeHasher.Verify(
                    request.ActivationCode,
                    license.ActivationCodeHashVersion,
                    license.ActivationCodeHash))
                return StoreResult<ActiveActivation>.Unauthorized("Activation code is invalid.");

            var normalizedDeviceId = request.Device!.DeviceId!.ToUpperInvariant();
            var result = await ActivateWithinLockAsync(
                license, requestId, normalizedDeviceId, request.Device.DeviceId[^8..].ToUpperInvariant(),
                CleanDeviceName(request.Device.DeviceName), request.Mode!, tokenHash, now,
                deploymentKeyId: null, auditActor: "license-client", cancellationToken);
            if (result.Success && db.ChangeTracker.HasChanges())
            {
                await db.SaveChangesAsync(cancellationToken);
                await transaction.CommitAsync(cancellationToken);
            }
            return result;
        }
        catch (Exception exception) when (exception is DbUpdateException || IsSerializationFailure(exception))
        {
            // Under Serializable isolation a losing concurrent activation surfaces as a Postgres
            // 40001 serialization failure. EF's default (non-retrying) execution strategy detects
            // that this is transient and rewraps it in an InvalidOperationException suggesting
            // EnableRetryOnFailure, rather than surfacing the DbUpdateException/PostgresException
            // directly - so the chain has to be searched instead of caught by type.
            await transaction.RollbackAsync(cancellationToken);
            return StoreResult<ActiveActivation>.Conflict("The license was activated concurrently. Retry to see the active device.");
        }
    }

    // Called with `license` already locked (FOR UPDATE) and tracked, with Entitlements loaded, by
    // an already-open caller transaction. Never calls SaveChanges/Commit/Rollback itself - on a
    // Success result the caller must SaveChanges+Commit; on failure the caller lets the
    // transaction roll back on dispose, exactly as ActivateAsync always did before this method
    // was extracted so DeploymentKeyService.EnrollAsync could share the same seat-authoritative
    // core after verifying a deployment key instead of an activation code.
    internal async Task<StoreResult<ActiveActivation>> ActivateWithinLockAsync(
        LicenseRecord license,
        Guid requestId,
        string normalizedDeviceId,
        string deviceIdSuffix,
        string? deviceName,
        string mode,
        byte[] tokenHash,
        DateTimeOffset now,
        Guid? deploymentKeyId,
        string auditActor,
        CancellationToken cancellationToken)
    {
        if (LifecycleBlock(license, now) is { } blocked)
            return StoreResult<ActiveActivation>.Forbidden(blocked);

        var priorRequest = await db.Activations
            .SingleOrDefaultAsync(x => x.LicenseRecordId == license.Id && x.RequestId == requestId, cancellationToken);
        if (priorRequest is not null)
        {
            var idempotent = priorRequest.DeactivatedAt is null
                && string.Equals(priorRequest.DeviceIdHash, normalizedDeviceId, StringComparison.OrdinalIgnoreCase)
                && CryptographicOperations.FixedTimeEquals(priorRequest.TokenHash, tokenHash);
            return idempotent
                ? StoreResult<ActiveActivation>.Ok(ToActive(priorRequest, license.LicenseId))
                : StoreResult<ActiveActivation>.Conflict("The activation request ID has already been used.");
        }

        var activeForDevice = await db.Activations.SingleOrDefaultAsync(
            x => x.LicenseRecordId == license.Id
                && x.DeactivatedAt == null
                && x.DeviceIdHash == normalizedDeviceId,
            cancellationToken);
        if (activeForDevice is not null)
        {
            return CryptographicOperations.FixedTimeEquals(activeForDevice.TokenHash, tokenHash)
                ? StoreResult<ActiveActivation>.Ok(ToActive(activeForDevice, license.LicenseId))
                : StoreResult<ActiveActivation>.Conflict(
                    $"License is already active on device ...{activeForDevice.DeviceIdSuffix}. Reuse the original activation credentials or deactivate that activation first.");
        }

        var activeCount = await db.Activations.CountAsync(
            x => x.LicenseRecordId == license.Id && x.DeactivatedAt == null,
            cancellationToken);
        var seatLimit = GetSeatLimit(license);
        if (activeCount >= seatLimit)
            return StoreResult<ActiveActivation>.Conflict(
                $"Activation limit reached. {activeCount} of {seatLimit} seats are currently active.");

        var isTransfer = activeCount == 0 && await db.Activations.AnyAsync(
            x => x.LicenseRecordId == license.Id && x.DeviceIdHash != normalizedDeviceId,
            cancellationToken);

        var entity = new Activation
        {
            Id = Guid.NewGuid(),
            ActivationId = Guid.NewGuid().ToString("D"),
            LicenseRecordId = license.Id,
            License = license,
            RequestId = requestId,
            DeviceIdHash = normalizedDeviceId,
            DeviceIdSuffix = deviceIdSuffix,
            DeviceName = deviceName,
            Mode = mode,
            TokenHash = tokenHash,
            ActivatedAt = now,
            RefreshAfter = mode == "online" ? now.AddDays(1) : null,
            LeaseExpiresAt = mode == "online" ? now.AddDays(7) : null,
            DeploymentKeyId = deploymentKeyId
        };
        db.Activations.Add(entity);
        AddAudit(auditActor, "activation.created", "activation", entity.ActivationId, "success", new
        {
            licenseId = license.LicenseId,
            mode = entity.Mode,
            deviceSuffix = entity.DeviceIdSuffix,
            deploymentKeyId
        }, now);
        if (isTransfer)
        {
            AddAudit(auditActor, "license.transferred", "license", license.LicenseId, "success", new
            {
                activationId = entity.ActivationId,
                deviceSuffix = entity.DeviceIdSuffix,
                mode = entity.Mode
            }, now);
        }
        return StoreResult<ActiveActivation>.Ok(ToActive(entity, license.LicenseId));
    }

    internal static bool IsSerializationFailure(Exception? exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is PostgresException postgres
                && (postgres.SqlState == PostgresErrorCodes.SerializationFailure
                    || postgres.SqlState == PostgresErrorCodes.DeadlockDetected))
                return true;
        }
        return false;
    }

    public async Task<StoreResult<ActiveActivation>> AuthorizeAsync(
        string activationId,
        ActivationCredentialRequest request,
        CancellationToken cancellationToken = default)
    {
        var activation = await db.Activations.Include(x => x.License)
            .SingleOrDefaultAsync(x => x.ActivationId == activationId && x.DeactivatedAt == null, cancellationToken);
        if (activation is null)
            return StoreResult<ActiveActivation>.NotFound("Activation is not active.");
        if (LifecycleBlock(activation.License, DateTimeOffset.UtcNow) is { } blocked)
            return StoreResult<ActiveActivation>.Forbidden(blocked);
        if (string.IsNullOrWhiteSpace(request.DeviceId)
            || !string.Equals(activation.DeviceIdHash, request.DeviceId, StringComparison.OrdinalIgnoreCase)
            || !FixedTimeMatches(request.ActivationToken, activation.TokenHash))
        {
            return StoreResult<ActiveActivation>.Unauthorized("Activation credentials are invalid.");
        }

        return StoreResult<ActiveActivation>.Ok(ToActive(activation, activation.License.LicenseId));
    }

    public async Task<StoreResult<ActiveActivation>> RefreshAsync(
        string activationId,
        ActivationCredentialRequest request,
        DateTimeOffset now,
        string? requestedSigningKeyId = null,
        CancellationToken cancellationToken = default)
    {
        // See ActivateAsync's identical check: the lease extension below commits before signing
        // runs, so a signing failure discovered afterward would leave the lease extended with no
        // artifact ever issued to the caller.
        if (!signer.CanSign(requestedSigningKeyId))
            return StoreResult<ActiveActivation>.ServiceUnavailable(
                "No signing key is currently able to sign. Try again once an administrator restores a default or active signing key.");

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var authorized = await AuthorizeAsync(activationId, request, cancellationToken);
        if (!authorized.Success)
            return authorized;
        if (authorized.Value!.Mode != "online")
            return StoreResult<ActiveActivation>.Conflict("Offline activations do not use leases.");

        var activation = await db.Activations.SingleAsync(x => x.ActivationId == activationId, cancellationToken);
        activation.LastRefreshedAt = now;
        activation.RefreshAfter = now.AddDays(1);
        activation.LeaseExpiresAt = now.AddDays(7);
        AddAudit("license-client", "activation.refreshed", "activation", activationId, "success", new
        {
            leaseExpiresAt = activation.LeaseExpiresAt
        }, now);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return StoreResult<ActiveActivation>.Ok(ToActive(activation, authorized.Value.LicenseId));
    }

    public async Task<StoreResult<ActiveActivation>> DeactivateAsync(
        string activationId,
        ActivationCredentialRequest request,
        DateTimeOffset now,
        string actor = "license-client",
        CancellationToken cancellationToken = default)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var authorized = await AuthorizeAsync(activationId, request, cancellationToken);
        if (!authorized.Success)
            return authorized;

        var activation = await db.Activations.SingleAsync(x => x.ActivationId == activationId, cancellationToken);
        activation.DeactivatedAt = now;
        AddAudit(actor, "activation.deactivated", "activation", activationId, "success", new
        {
            licenseId = authorized.Value!.LicenseId,
            deviceSuffix = activation.DeviceIdSuffix
        }, now);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return StoreResult<ActiveActivation>.Ok(ToActive(activation, authorized.Value.LicenseId));
    }

    // Releases the seat for whatever activation currently holds normalizedDeviceId on the given
    // license, without requiring the activationToken issued at enrollment time. Intended for a
    // credential holder (deployment key, or license-id + activation-code) who still controls the
    // device but lost the local activationToken - the normal AuthorizeAsync/DeactivateAsync path
    // needs that token and has no recovery route. Deliberately scoped to "this exact device, this
    // exact license" rather than an arbitrary deviceId, so it cannot be used to grief a seat the
    // caller does not hold.
    internal async Task<StoreResult<ActiveActivation>> ForceDeactivateByDeviceAsync(
        Guid licenseRecordId,
        string normalizedDeviceId,
        DateTimeOffset now,
        string actor,
        CancellationToken cancellationToken = default)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var activation = await db.Activations.Include(x => x.License)
            .SingleOrDefaultAsync(x => x.License.Id == licenseRecordId
                && x.DeviceIdHash == normalizedDeviceId && x.DeactivatedAt == null, cancellationToken);
        if (activation is null)
            return StoreResult<ActiveActivation>.NotFound("No active activation was found for this device.");

        activation.DeactivatedAt = now;
        AddAudit(actor, "activation.force-deactivated", "activation", activation.ActivationId, "success", new
        {
            licenseId = activation.License.LicenseId,
            deviceSuffix = activation.DeviceIdSuffix,
            priorActivationId = activation.ActivationId
        }, now);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return StoreResult<ActiveActivation>.Ok(ToActive(activation, activation.License.LicenseId));
    }

    public async Task<StoreResult<bool>> RevokeAsync(
        string licenseId,
        string? reason,
        string actor,
        DateTimeOffset now,
        CancellationToken cancellationToken = default) =>
        await RevokeAsync(licenseId, reason, actor, now, null, null, cancellationToken);

    public async Task<StoreResult<bool>> RevokeAsync(
        string licenseId, string? reason, string actor, DateTimeOffset now,
        long? expectedVersion, string? correlationId,
        CancellationToken cancellationToken = default)
    {
        await permissions.RequireAsync(Permissions.LicensesRevoke);
        if (string.IsNullOrWhiteSpace(reason) || reason.Trim().Length < 3)
            return StoreResult<bool>.BadRequest("A revocation reason of at least three characters is required.");

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var license = await LockedLicenseAsync(licenseId, cancellationToken);
        if (license is null)
            return StoreResult<bool>.NotFound("License was not found.");
        if (license.CancelledAt is not null)
            return StoreResult<bool>.Conflict("A cancelled license is terminal and cannot be revoked.");
        if (license.RevokedAt is not null)
        {
            await transaction.CommitAsync(cancellationToken);
            return StoreResult<bool>.Ok(true);
        }
        if (expectedVersion is not null && license.Version != expectedVersion)
            return StoreResult<bool>.Conflict("The license was changed by another operation. Reload and retry.");
        license.RevokedAt = now;
        license.RevocationReason = reason.Trim()[..Math.Min(reason.Trim().Length, 500)];
        license.RevokedBy = actor;
        AddAudit(actor, "license.revoked", "license", licenseId, "success", new
        {
            reason = license.RevocationReason,
            old = new { revokedAt = (DateTimeOffset?)null },
            @new = new { revokedAt = now },
            version = license.Version + 1,
            correlationId
        }, now);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return StoreResult<bool>.Ok(true);
    }

    public async Task<StoreResult<bool>> CancelAsync(
        string licenseId, string? reason, string actor, DateTimeOffset now, long expectedVersion,
        string? reference, string? correlationId, CancellationToken cancellationToken = default)
    {
        await permissions.RequireAsync(Permissions.LicensesCancel);
        if (string.IsNullOrWhiteSpace(reason) || reason.Trim().Length < 3)
            return StoreResult<bool>.BadRequest("A cancellation reason of at least three characters is required.");

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var license = await LockedLicenseAsync(licenseId, cancellationToken);
        if (license is null) return StoreResult<bool>.NotFound("License was not found.");
        if (license.RevokedAt is not null)
            return StoreResult<bool>.Conflict("A revoked license is terminal and cannot be cancelled.");
        if (license.CancelledAt is not null)
        {
            await transaction.CommitAsync(cancellationToken);
            return StoreResult<bool>.Ok(true);
        }
        if (license.Version != expectedVersion)
            return StoreResult<bool>.Conflict("The license was changed by another operation. Reload and retry.");
        if (await db.Activations.AnyAsync(x => x.LicenseRecordId == license.Id, cancellationToken))
            return StoreResult<bool>.Conflict("A license with activation history cannot be cancelled; revoke it instead.");

        license.CancelledAt = now;
        license.CancellationReason = reason.Trim()[..Math.Min(reason.Trim().Length, 500)];
        license.CancelledBy = actor;
        license.CancellationReference = string.IsNullOrWhiteSpace(reference)
            ? null : reference.Trim()[..Math.Min(reference.Trim().Length, 200)];
        AddAudit(actor, "license.cancelled", "license", licenseId, "success", new
        {
            reason = license.CancellationReason,
            reference = license.CancellationReference,
            old = new { cancelledAt = (DateTimeOffset?)null },
            @new = new { cancelledAt = now },
            version = license.Version + 1,
            correlationId
        }, now);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return StoreResult<bool>.Ok(true);
    }

    public async Task<StoreResult<bool>> AmendTermsAsync(
        string licenseId, AmendTermsRequest request, string actor, DateTimeOffset now,
        string? correlationId, CancellationToken cancellationToken = default)
    {
        await permissions.RequireAsync(Permissions.LicensesUpdate);
        if (string.IsNullOrWhiteSpace(request.Reason) || request.Reason.Trim().Length < 3)
            return StoreResult<bool>.BadRequest("An amendment reason of at least three characters is required.");
        var edition = request.Edition?.Trim().ToLowerInvariant();
        if (request.Edition is not null && !LicenseEditions.IsSupported(edition))
            return StoreResult<bool>.BadRequest("Edition is not an approved controlled value.");
        if (request.ExpiresAt is null && request.Seats is null && request.UpdatesUntil is null && edition is null)
            return StoreResult<bool>.BadRequest("At least one supported term must be supplied.");
        if (request.Seats is <= 0)
            return StoreResult<bool>.BadRequest("Seats must be greater than zero.");

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        try
        {
            var license = await db.Licenses
                .FromSqlInterpolated($"SELECT * FROM \"Licenses\" WHERE \"LicenseId\" = {licenseId} FOR UPDATE")
                .Include(x => x.Entitlements)
                .SingleOrDefaultAsync(cancellationToken);
            if (license is null) return StoreResult<bool>.NotFound("License was not found.");
            if (license.Version != request.Version)
                return StoreResult<bool>.Conflict("The license was changed by another operation. Reload and retry.");
            if (license.CancelledAt is not null || license.RevokedAt is not null)
                return StoreResult<bool>.Conflict("Terms cannot be amended after cancellation or revocation.");
            if (license.Entitlements.Count != 1)
                return StoreResult<bool>.Conflict("Administrative terms amendment requires exactly one entitlement.");
            if (license.Provenance == LicenseProvenance.Imported)
                return StoreResult<bool>.Conflict(
                    "Imported licenses cannot have their terms amended through this page: the signed artifact, " +
                    "not this relational index, remains the source of truth and would silently diverge from it. " +
                    "Use admin-side revoke to terminate it if needed.");
            if (request.Seats is not null)
            {
                // Counted inside this method's own FOR UPDATE lock on the license row, which
                // ActivateWithinLockAsync also takes before reading/writing the active count - so a
                // concurrent activation and a concurrent seat amendment always serialize against each
                // other (via the catch below) instead of racing to an Active > Seats state.
                var activeCount = await db.Activations.CountAsync(
                    x => x.LicenseRecordId == license.Id && x.DeactivatedAt == null, cancellationToken);
                if (request.Seats.Value < activeCount)
                    return StoreResult<bool>.Conflict(
                        $"Seats cannot be reduced to {request.Seats.Value}: {activeCount} activation(s) are currently active. " +
                        "Deactivate machines first, or use a separate remediation workflow for forced over-allocation.");
            }

            var entitlement = license.Entitlements[0];
            var old = new
            {
                expiresAt = license.ExpiresAt?.AddTicks(license.ExpirySubMicrosecondTicks),
                entitlement.Seats,
                entitlement.UpdatesUntil,
                entitlement.Edition
            };
            if (request.ExpiresAt is not null) license.ExpiresAt = request.ExpiresAt.Value.ToUniversalTime();
            if (request.Seats is not null) entitlement.Seats = request.Seats.Value;
            if (request.UpdatesUntil is not null) entitlement.UpdatesUntil = request.UpdatesUntil;
            if (edition is not null) entitlement.Edition = edition;
            db.Entry(license).Property(x => x.Version).IsModified = true;
            AddAudit(actor, "license.terms-amended", "license", licenseId, "success", new
            {
                old,
                @new = new { expiresAt = license.ExpiresAt, entitlement.Seats, entitlement.UpdatesUntil, entitlement.Edition },
                reason = request.Reason.Trim(),
                version = license.Version + 1,
                correlationId
            }, now);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return StoreResult<bool>.Ok(true);
        }
        catch (Exception exception) when (exception is DbUpdateException || IsSerializationFailure(exception))
        {
            // See ActivateAsync's identical catch: under Serializable isolation, a losing side of
            // a genuine read/write conflict (e.g. this amendment's active-count read racing a
            // concurrent activation insert) surfaces as a Postgres 40001, not a lock wait.
            await transaction.RollbackAsync(cancellationToken);
            return StoreResult<bool>.Conflict("The license was changed by another operation. Reload and retry.");
        }
    }

    public async Task<StoreResult<RotatedActivationCode>> RotateActivationCodeAsync(
        string licenseId,
        long expectedVersion,
        string actor,
        string? correlationId,
        CancellationToken cancellationToken = default)
    {
        await permissions.RequireAsync(Permissions.LicensesUpdate);
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var license = await LockedLicenseAsync(licenseId, cancellationToken);
        if (license is null) return StoreResult<RotatedActivationCode>.NotFound("License was not found.");
        if (license.Version != expectedVersion)
            return StoreResult<RotatedActivationCode>.Conflict("The license was changed by another operation. Reload and retry.");
        if (license.CancelledAt is not null || license.RevokedAt is not null)
            return StoreResult<RotatedActivationCode>.Conflict("The activation code cannot be rotated after cancellation or revocation.");

        var code = activationCodeGenerator.Generate();
        var hash = activationCodeHasher.Hash(code);
        license.ActivationCodeHash = hash.Value;
        license.ActivationCodeHashVersion = hash.Version;
        db.Entry(license).Property(item => item.Version).IsModified = true;
        AddAudit(actor, "license.activation-code-rotated", "license", licenseId, "success",
            new { version = license.Version + 1, correlationId }, clock.GetUtcNow());
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return StoreResult<RotatedActivationCode>.Ok(new RotatedActivationCode(licenseId, code, license.Version));
    }

    public async Task<StoreResult<bool>> AdminDeactivateAsync(
        string activationId, string? reason, long expectedVersion, string actor, DateTimeOffset now,
        string? correlationId, CancellationToken cancellationToken = default)
    {
        await permissions.RequireAsync(Permissions.ActivationsManage);
        if (string.IsNullOrWhiteSpace(reason) || reason.Trim().Length < 3)
            return StoreResult<bool>.BadRequest("A deactivation reason of at least three characters is required.");

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var activation = await db.Activations.Include(x => x.License)
            .SingleOrDefaultAsync(x => x.ActivationId == activationId, cancellationToken);
        if (activation is null) return StoreResult<bool>.NotFound("Activation was not found.");
        if (activation.License.Version != expectedVersion)
            return StoreResult<bool>.Conflict("The license was changed by another operation. Reload and retry.");
        if (activation.DeactivatedAt is not null)
        {
            await transaction.CommitAsync(cancellationToken);
            return StoreResult<bool>.Ok(true);
        }

        activation.DeactivatedAt = now;
        db.Entry(activation.License).Property(x => x.Version).IsModified = true;
        AddAudit(actor, "activation.admin-deactivated", "activation", activationId, "success", new
        {
            licenseId = activation.License.LicenseId,
            reason = reason.Trim(),
            old = new { deactivatedAt = (DateTimeOffset?)null },
            @new = new { deactivatedAt = now },
            version = activation.License.Version + 1,
            correlationId
        }, now);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return StoreResult<bool>.Ok(true);
    }

    public async Task<JsonObject> CreateLicenseAsync(
        ActiveActivation activation,
        DateTimeOffset issuedAt,
        CancellationToken cancellationToken = default)
    {
        var record = await db.Licenses.AsNoTracking()
            .Include(x => x.Customer)
            .Include(x => x.Entitlements)
            .SingleAsync(x => x.Id == activation.LicenseRecordId, cancellationToken);

        var activationJson = new JsonObject
        {
            ["activationId"] = activation.ActivationId,
            ["mode"] = activation.Mode,
            ["activatedAt"] = activation.ActivatedAt.ToString("O")
        };
        if (activation.Mode == "online")
        {
            activationJson["refreshAfter"] = activation.RefreshAfter?.ToString("O");
            activationJson["leaseExpiresAt"] = activation.LeaseExpiresAt?.ToString("O");
        }

        var bindingJson = new JsonObject
        {
            ["scheme"] = DeviceIdentity.Scheme,
            ["deviceId"] = activation.DeviceIdHash
        };
        if (!string.IsNullOrWhiteSpace(activation.DeviceName))
            bindingJson["deviceName"] = activation.DeviceName;

        var entitlements = new JsonArray();
        foreach (var entitlement in record.Entitlements.OrderBy(x => x.Product))
        {
            var item = new JsonObject
            {
                ["product"] = entitlement.Product,
                ["edition"] = entitlement.Edition,
                ["licenseType"] = entitlement.LicenseType,
                ["seats"] = entitlement.Seats,
                ["expiresAt"] = (record.ExpiresAt?.AddTicks(record.ExpirySubMicrosecondTicks) ?? LicenseTerms.PerpetualExpiry)
                    .ToUniversalTime().ToString("O")
            };
            if (entitlement.UpdatesUntil is not null)
                item["updatesUntil"] = entitlement.UpdatesUntil.Value.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            entitlements.Add(item);
        }

        return new JsonObject
        {
            ["licenseId"] = record.LicenseId,
            ["customer"] = record.Customer.Name,
            ["issuedAt"] = issuedAt.ToString("O"),
            ["metadata"] = JsonNode.Parse(record.MetadataJson) ?? new JsonObject(),
            ["deviceBinding"] = bindingJson,
            ["activation"] = activationJson,
            ["entitlements"] = entitlements
        };
    }

    private static int GetSeatLimit(LicenseRecord license)
    {
        if (license.Entitlements.Count == 0)
            throw new InvalidOperationException("A license must have at least one entitlement.");

        return license.Entitlements.Min(item => item.Seats);
    }

    private void AddAudit(string actor, string action, string targetType, string targetId, string result, object context, DateTimeOffset now) =>
        db.AuditRecords.Add(new AuditRecord
        {
            Actor = actor,
            Action = action,
            TargetType = targetType,
            TargetId = targetId,
            Result = result,
            ContextJson = JsonSerializer.Serialize(context),
            TimestampUtc = now
        });

    internal static byte[] Hash(string value) => SHA256.HashData(Encoding.UTF8.GetBytes(value));

    private Task<LicenseRecord?> LockedLicenseAsync(string licenseId, CancellationToken cancellationToken) =>
        db.Licenses.FromSqlInterpolated($"SELECT * FROM \"Licenses\" WHERE \"LicenseId\" = {licenseId} FOR UPDATE")
            .SingleOrDefaultAsync(cancellationToken);

    internal static string GetLifecycleState(LicenseRecord license, bool hasActiveActivation, DateTimeOffset now) =>
        license.CancelledAt is not null ? "cancelled"
        : license.RevokedAt is not null ? "revoked"
        : license.ExpiresAt is not null && license.ExpiresAt <= now ? "expired"
        : hasActiveActivation ? "active"
        : "available";

    private static string? LifecycleBlock(LicenseRecord license, DateTimeOffset now) =>
        license.CancelledAt is not null ? "License has been cancelled."
        : license.RevokedAt is not null ? "License has been revoked."
        : license.ExpiresAt is not null && license.ExpiresAt <= now ? "License has expired."
        : null;

    private static (IssuanceIdempotencyIdentity? Identity, string? Error) ValidateIdempotency(
        IssuanceContext context,
        IssueLicenseRequest request)
    {
        if (string.IsNullOrWhiteSpace(context.IdempotencyKey)) return (null, null);
        if (context.IdempotencyKey.Length is < 16 or > 200)
            return (null, "The idempotency key must be between 16 and 200 characters.");
        if (string.IsNullOrWhiteSpace(context.PrincipalId))
            return (null, "An authenticated principal is required for idempotent issuance.");

        var requestJson = JsonSerializer.SerializeToUtf8Bytes(request);
        return (new IssuanceIdempotencyIdentity(
            context.PrincipalId[..Math.Min(context.PrincipalId.Length, 256)],
            SHA256.HashData(Encoding.UTF8.GetBytes(context.IdempotencyKey)),
            SHA256.HashData(requestJson)), null);
    }

    private async Task<StoreResult<IssuedLicense>?> ReplayAsync(
        IssuanceIdempotencyIdentity identity,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var record = await db.IssuanceIdempotencyRecords.AsNoTracking().SingleOrDefaultAsync(
            item => item.PrincipalId == identity.PrincipalId && item.KeyHash == identity.KeyHash,
            cancellationToken);
        if (record is null) return null;
        if (!CryptographicOperations.FixedTimeEquals(record.RequestHash, identity.RequestHash))
            return StoreResult<IssuedLicense>.Conflict("The idempotency key was already used for a different issuance request.");
        if (record.ExpiresAt <= now)
            return StoreResult<IssuedLicense>.Conflict("The idempotent retry window has expired; use a new key after confirming the original result.");

        try
        {
            var issued = JsonSerializer.Deserialize<IssuedLicense>(
                issuanceResultProtector.Unprotect(record.ProtectedResult));
            return issued is null
                ? StoreResult<IssuedLicense>.Conflict("The prior issuance result is unavailable.")
                : StoreResult<IssuedLicense>.Ok(issued);
        }
        catch (CryptographicException)
        {
            return StoreResult<IssuedLicense>.Conflict("The prior issuance result is unavailable.");
        }
        catch (JsonException)
        {
            return StoreResult<IssuedLicense>.Conflict("The prior issuance result is unavailable.");
        }
    }

    private static string? ValidateActivationRequest(ActivateRequest request)
    {
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

    private static string? CleanDeviceName(string? value) => string.IsNullOrWhiteSpace(value)
        ? null
        : value.Trim()[..Math.Min(value.Trim().Length, 100)];

    private static bool IsStrongActivationToken(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        try { return Convert.FromBase64String(value).Length == 32; }
        catch (FormatException) { return false; }
    }

    private static bool FixedTimeMatches(string? supplied, byte[] expected) =>
        supplied is not null && CryptographicOperations.FixedTimeEquals(Hash(supplied), expected);

    private static ActiveActivation ToActive(Activation value, string licenseId) => new(
        value.LicenseRecordId,
        licenseId,
        value.ActivationId,
        value.DeviceIdHash,
        value.DeviceIdSuffix,
        value.DeviceName,
        value.Mode,
        value.ActivatedAt,
        value.RefreshAfter,
        value.LeaseExpiresAt);

    internal sealed record ActiveActivation(
        Guid LicenseRecordId,
        string LicenseId,
        string ActivationId,
        string DeviceIdHash,
        string DeviceIdSuffix,
        string? DeviceName,
        string Mode,
        DateTimeOffset ActivatedAt,
        DateTimeOffset? RefreshAfter,
        DateTimeOffset? LeaseExpiresAt);

    internal sealed record IssuedEntitlement(
        string Product, string Edition, string LicenseType, int Seats, DateTimeOffset ExpiresAt);

    internal sealed record IssuedLicense(
        string LicenseId, string ActivationCode, JsonObject Metadata,
        IReadOnlyList<IssuedEntitlement> Entitlements);

    internal sealed record RotatedActivationCode(string LicenseId, string ActivationCode, long Version);

    private sealed record IssuanceIdempotencyIdentity(
        string PrincipalId, byte[] KeyHash, byte[] RequestHash);
}

internal sealed record IssuanceContext(
    string Actor,
    string PrincipalId,
    string CorrelationId,
    string? IdempotencyKey);

internal sealed record StoreResult<T>(bool Success, int StatusCode, string? Error, T? Value, string? Field = null)
{
    public static StoreResult<T> Ok(T value) => new(true, 200, null, value);
    public static StoreResult<T> BadRequest(string error, string? field = null) => new(false, 400, error, default, field);
    public static StoreResult<T> Unauthorized(string error) => new(false, 401, error, default);
    public static StoreResult<T> Forbidden(string error) => new(false, 403, error, default);
    public static StoreResult<T> NotFound(string error) => new(false, 404, error, default);
    public static StoreResult<T> Conflict(string error) => new(false, 409, error, default);
    public static StoreResult<T> ServiceUnavailable(string error) => new(false, 503, error, default);
}
