# Deployment Key Domain Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `DeploymentKey` entity and lifecycle (create/list/rename/rotate/revoke) that lets a machine enroll under an existing license anonymously via `Deployment Key + Machine identity`, sharing the license's existing seat pool and `Activation` records with the manual `License ID + Activation Code + Machine identity` flow, without introducing any new licensing/seat model.

**Architecture:** `DeploymentKey` is a new EF Core entity (one-to-many from `LicenseRecord`), authenticated by an HMAC-SHA256-hashed secret in the `dpk_live_<publicId>_<secret>` format, following exactly the same hash-version/pepper/public-id pattern the codebase already uses for `ApiCredential`. `LicenseStore.ActivateAsync`'s core (idempotency check, per-device dedup, seat-count check, `Activation` insert, audit) is extracted into an `internal` method `ActivateWithinLockAsync` so a new `DeploymentKeyService.EnrollAsync` can call the identical seat-authoritative logic after verifying the deployment key instead of the activation code, stamping the created `Activation.DeploymentKeyId`. Deployment Key CRUD lives in a new `DeploymentKeyService`, wired into `Program.cs` with new permissions, a dedicated anonymous rate-limited enrollment endpoint, and admin endpoints gated by the new permissions.

**Tech Stack:** ASP.NET Core 9 minimal APIs, EF Core (Npgsql/PostgreSQL), xUnit against a real Postgres test container (`scripts/test-database-and-auth.sh`).

**Spec:** GitHub issue #40 ("Add Deployment Key domain model and secure lifecycle"), `danijeljw-RPC/licsense-server-poc`.

## Global Constraints

- Terminology: always "Deployment Key" — never "Corporate License"/"Corporate License Key".
- Secret format: `dpk_live_<publicId>_<secret>` — distinct prefix from `lic_live_` (admin API credentials) and from activation codes.
- Never persist plaintext secret material; the full secret is returned only once, at creation/rotation time.
- Never put the full secret into audit records, logs, exception messages, telemetry, or URLs. Only `PublicId` and `LastFour` may appear.
- Deployment Keys do not own seats; there is no "unlimited" seat sentinel. The parent `LicenseRecord`'s existing `GetSeatLimit` (min entitlement seats) remains the sole seat authority, counted across `Activation` rows regardless of which flow created them.
- Revoking a Deployment Key blocks new enrollment only; it must never deactivate `Activation` rows already created through it.
- A Deployment Key must not grant any access beyond machine enrollment under its parent license — no admin/customer/billing/activation-listing API access.
- Comparisons of credential material use `CryptographicOperations.FixedTimeEquals`.
- Permissions: `deploymentKeys.read`, `deploymentKeys.manage`. `deploymentKeys.manage` is high-risk (MFA-gated when `Security:RequireMfaForHighRiskPermissions` is true), mirroring `licenses.revoke` / `signingKeys.manage`.
- Out of scope for this plan: Blazor admin UI (Razor components). The issue's acceptance criteria are satisfiable via the admin JSON API alone (list/redacted view = the `GET` list endpoint); no UI page is required by the issue text.

---

### Task 1: `DeploymentKey` entity, `Activation.DeploymentKeyId`, DbContext registration, migration

**Files:**
- Modify: `src/LicenseServer/Data/Entities.cs`
- Modify: `src/LicenseServer/Data/ApplicationDbContext.cs`
- Create (via `dotnet ef`): `src/LicenseServer/Data/Migrations/<timestamp>_AddDeploymentKeys.cs` (+ `.Designer.cs`), regenerates `ApplicationDbContextModelSnapshot.cs`

**Interfaces:**
- Produces: `LicenseServer.Data.DeploymentKey` entity with fields `Id, LicenseRecordId, License, Name, PublicId, SecretHash, SecretHashVersion, LastFour, CreatedAt, CreatedBy, ExpiresAt, RevokedAt, RevokedBy, RevocationReason, LastUsedAt, ReplacedByDeploymentKeyId`. Produces `ApplicationDbContext.DeploymentKeys` (`DbSet<DeploymentKey>`). Produces `Activation.DeploymentKeyId` (`Guid?`) and `Activation.DeploymentKey` (`DeploymentKey?`) nullable nav.
- Consumes: nothing (first task).

- [ ] **Step 1: Add the `DeploymentKey` entity and the `Activation.DeploymentKeyId` field**

In `src/LicenseServer/Data/Entities.cs`, add after the `ApiCredential` class (after line 95):

```csharp
public sealed class DeploymentKey
{
    public Guid Id { get; set; }
    public Guid LicenseRecordId { get; set; }
    public required LicenseRecord License { get; set; }
    public required string Name { get; set; }
    public required string PublicId { get; set; }
    public required byte[] SecretHash { get; set; }
    public required string SecretHashVersion { get; set; }
    public required string LastFour { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public required string CreatedBy { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    public DateTimeOffset? RevokedAt { get; set; }
    public string? RevokedBy { get; set; }
    public string? RevocationReason { get; set; }
    public DateTimeOffset? LastUsedAt { get; set; }
    public Guid? ReplacedByDeploymentKeyId { get; set; }
}
```

In the `Activation` class (currently lines 276-293), add two members after `DeactivatedAt`:

```csharp
    public DateTimeOffset? DeactivatedAt { get; set; }
    public Guid? DeploymentKeyId { get; set; }
    public DeploymentKey? DeploymentKey { get; set; }
}
```

- [ ] **Step 2: Register the `DbSet` and model configuration**

In `src/LicenseServer/Data/ApplicationDbContext.cs`, add after line 15 (`public DbSet<ApiCredential> ApiCredentials => Set<ApiCredential>();`):

```csharp
    public DbSet<DeploymentKey> DeploymentKeys => Set<DeploymentKey>();
```

In `OnModelCreating`, add after the `ApiCredential` block (currently lines 105-117, right before the `EmailOutboxMessage` block):

```csharp
        builder.Entity<DeploymentKey>().HasIndex(x => x.PublicId).IsUnique();
        builder.Entity<DeploymentKey>().HasIndex(x => x.LicenseRecordId);
        builder.Entity<DeploymentKey>().HasIndex(x => x.ExpiresAt);
        builder.Entity<DeploymentKey>().HasIndex(x => x.RevokedAt);
        builder.Entity<DeploymentKey>().Property(x => x.PublicId).HasMaxLength(32);
        builder.Entity<DeploymentKey>().Property(x => x.Name).HasMaxLength(200);
        builder.Entity<DeploymentKey>().Property(x => x.SecretHashVersion).HasMaxLength(32);
        builder.Entity<DeploymentKey>().Property(x => x.LastFour).HasMaxLength(4);
        builder.Entity<DeploymentKey>().Property(x => x.CreatedBy).HasMaxLength(256);
        builder.Entity<DeploymentKey>().Property(x => x.RevokedBy).HasMaxLength(256);
        builder.Entity<DeploymentKey>().Property(x => x.RevocationReason).HasMaxLength(500);
        builder.Entity<DeploymentKey>().HasOne(x => x.License).WithMany()
            .HasForeignKey(x => x.LicenseRecordId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<DeploymentKey>().ToTable(table => table.HasCheckConstraint(
            "CK_DeploymentKeys_Lifecycle", "\"ExpiresAt\" IS NULL OR \"ExpiresAt\" > \"CreatedAt\""));
```

Add after the `Activation` index block (currently lines 219-224, right before the `SigningKeyRecord` block):

```csharp
        builder.Entity<Activation>().HasIndex(x => x.DeploymentKeyId);
        builder.Entity<Activation>().HasOne(x => x.DeploymentKey).WithMany()
            .HasForeignKey(x => x.DeploymentKeyId).OnDelete(DeleteBehavior.Restrict);
```

- [ ] **Step 3: Generate and inspect the EF Core migration**

Run:
```bash
dotnet ef migrations add AddDeploymentKeys --project src/LicenseServer --startup-project src/LicenseServer
```

Open the generated `src/LicenseServer/Data/Migrations/<timestamp>_AddDeploymentKeys.cs` and confirm it creates a `DeploymentKeys` table with all the columns from Step 1, the check constraint, the four indexes, the FK to `AspNetUsers`-independent `Licenses` (`Restrict`), and an `ALTER TABLE "Activations" ADD COLUMN "DeploymentKeyId" uuid NULL` plus its FK and index. If anything is missing, the `OnModelCreating` change in Step 2 was incomplete — fix it and regenerate (`dotnet ef migrations remove --project src/LicenseServer --startup-project src/LicenseServer` first).

- [ ] **Step 4: Build**

Run: `dotnet build src/LicenseServer/LicenseServer.csproj`
Expected: builds with no errors (no consumers of the new entity yet, so no behavior change).

- [ ] **Step 5: Commit**

```bash
git add src/LicenseServer/Data/Entities.cs src/LicenseServer/Data/ApplicationDbContext.cs src/LicenseServer/Data/Migrations/
git commit -m "feat: add DeploymentKey entity and Activation.DeploymentKeyId"
```

---

### Task 2: `DeploymentKeyHasher` and credential format helpers

**Files:**
- Create: `src/LicenseServer/DeploymentKeys.cs`
- Test: `tests/LicenseServer.Tests/DeploymentKeyFormatTests.cs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `internal sealed class DeploymentKeyHasher(byte[] pepper)` with `const string CurrentVersion = "hmac-sha256-v1"`, `byte[] Hash(string publicId, string secret)`, `bool Verify(string publicId, string secret, byte[] expected)`. Produces `internal static class DeploymentKeyFormat` with `const string Prefix = "dpk_live_"`, `static (string PublicId, string Secret, string FullValue) Generate()`, `static bool TryParse(string? value, out string publicId, out string secret)`.

- [ ] **Step 1: Write the failing format test**

Create `tests/LicenseServer.Tests/DeploymentKeyFormatTests.cs`:

```csharp
using System.Security.Cryptography;
using LicenseServer;

namespace LicenseServer.Tests;

public sealed class DeploymentKeyFormatTests
{
    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public void GenerateProducesDistinctKeysWithTheDpkLivePrefixAndExpectedShape()
    {
        var first = DeploymentKeyFormat.Generate();
        var second = DeploymentKeyFormat.Generate();

        Assert.NotEqual(first.FullValue, second.FullValue);
        Assert.StartsWith("dpk_live_", first.FullValue, StringComparison.Ordinal);
        Assert.Equal(16, first.PublicId.Length);
        Assert.Equal(43, first.Secret.Length);
        Assert.True(DeploymentKeyFormat.TryParse(first.FullValue, out var publicId, out var secret));
        Assert.Equal(first.PublicId, publicId);
        Assert.Equal(first.Secret, secret);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("lic_live_0011223344556677_abc")]
    [InlineData("dpk_live_tooshort_abc")]
    [InlineData("dpk_live_missing-secret-separator")]
    public void TryParseRejectsMalformedOrWrongPrefixValues(string? value)
    {
        Assert.False(DeploymentKeyFormat.TryParse(value, out _, out _));
    }

    [Fact]
    public void HasherVerifiesOnlyTheExactPublicIdSecretPairAndIsFixedTime()
    {
        var pepper = RandomNumberGenerator.GetBytes(32);
        var hasher = new DeploymentKeyHasher(pepper);
        var (publicId, secret, _) = DeploymentKeyFormat.Generate();
        var hash = hasher.Hash(publicId, secret);

        Assert.True(hasher.Verify(publicId, secret, hash));
        Assert.False(hasher.Verify(publicId, "wrong-secret", hash));
        Assert.False(hasher.Verify("wrong-public-id", secret, hash));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails to compile (types do not exist yet)**

Run: `dotnet test tests/LicenseServer.Tests/LicenseServer.Tests.csproj --filter DeploymentKeyFormatTests`
Expected: build error — `DeploymentKeyFormat`/`DeploymentKeyHasher` do not exist.

- [ ] **Step 3: Implement `DeploymentKeys.cs`**

Create `src/LicenseServer/DeploymentKeys.cs`:

```csharp
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.WebUtilities;

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test tests/LicenseServer.Tests/LicenseServer.Tests.csproj --filter DeploymentKeyFormatTests`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add src/LicenseServer/DeploymentKeys.cs tests/LicenseServer.Tests/DeploymentKeyFormatTests.cs
git commit -m "feat: add DeploymentKeyHasher and dpk_live_ credential format"
```

---

### Task 3: Permissions and role matrix

**Files:**
- Modify: `src/LicenseServer/Authorization/Permissions.cs`
- Modify: `src/LicenseServer/Authorization/BuiltInRoles.cs`

**Interfaces:**
- Produces: `Permissions.DeploymentKeysRead = "deploymentKeys.read"`, `Permissions.DeploymentKeysManage = "deploymentKeys.manage"`, both in `Permissions.All`; `DeploymentKeysManage` in `Permissions.HighRisk`. `LicenseManager` role gets both; `SupportAgent` and `Auditor` get `DeploymentKeysRead`.
- Consumes: nothing.

- [ ] **Step 1: Add the permissions**

In `src/LicenseServer/Authorization/Permissions.cs`, add after `SigningKeysManage` (line 23):

```csharp
    public const string DeploymentKeysRead = "deploymentKeys.read";
    public const string DeploymentKeysManage = "deploymentKeys.manage";
```

Update `All` (lines 25-31) to append them:

```csharp
    public static readonly IReadOnlyList<string> All =
    [
        LicensesRead, LicensesIssue, LicensesUpdate, LicensesCancel, LicensesRevoke, LicensesImport,
        ActivationsManage, CustomersRead, CustomersManage, ProductsRead, ProductsManage,
        UsersRead, UsersManage, ApiKeysManageSelf, ApiKeysManageAll, AuditRead, BillingManage,
        SigningKeysManage, DeploymentKeysRead, DeploymentKeysManage
    ];
```

Update `HighRisk` (lines 33-36):

```csharp
    public static readonly IReadOnlySet<string> HighRisk = new HashSet<string>(StringComparer.Ordinal)
    {
        UsersManage, ApiKeysManageAll, LicensesRevoke, SigningKeysManage, DeploymentKeysManage
    };
```

- [ ] **Step 2: Update the role matrix**

In `src/LicenseServer/Authorization/BuiltInRoles.cs`, update `LicenseManager` (lines 24-31):

```csharp
            [LicenseManager] =
            [
                Permissions.LicensesRead, Permissions.LicensesIssue, Permissions.LicensesUpdate,
                Permissions.LicensesCancel, Permissions.LicensesRevoke, Permissions.LicensesImport,
                Permissions.ActivationsManage,
                Permissions.CustomersRead, Permissions.CustomersManage, Permissions.ProductsRead,
                Permissions.ApiKeysManageSelf, Permissions.AuditRead,
                Permissions.DeploymentKeysRead, Permissions.DeploymentKeysManage
            ],
```

Update `SupportAgent` (lines 37-41):

```csharp
            [SupportAgent] =
            [
                Permissions.LicensesRead, Permissions.ActivationsManage, Permissions.CustomersRead,
                Permissions.ProductsRead, Permissions.ApiKeysManageSelf, Permissions.DeploymentKeysRead
            ],
```

Update `Auditor` (lines 44-48):

```csharp
            [Auditor] =
            [
                Permissions.LicensesRead, Permissions.CustomersRead, Permissions.ProductsRead,
                Permissions.UsersRead, Permissions.ApiKeysManageSelf, Permissions.AuditRead,
                Permissions.DeploymentKeysRead
            ],
```

- [ ] **Step 3: Build**

Run: `dotnet build src/LicenseServer/LicenseServer.csproj`
Expected: builds with no errors. `SystemAdministrator` automatically gains both new permissions via `Permissions.All`.

- [ ] **Step 4: Commit**

```bash
git add src/LicenseServer/Authorization/Permissions.cs src/LicenseServer/Authorization/BuiltInRoles.cs
git commit -m "feat: add deploymentKeys.read/manage permissions and role grants"
```

---

### Task 4: Extract `LicenseStore.ActivateWithinLockAsync` (pure refactor, no behavior change)

**Files:**
- Modify: `src/LicenseServer/LicenseStore.cs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `internal async Task<StoreResult<ActiveActivation>> ActivateWithinLockAsync(LicenseRecord license, Guid requestId, string normalizedDeviceId, string deviceIdSuffix, string? deviceName, string mode, byte[] tokenHash, DateTimeOffset now, Guid? deploymentKeyId, string auditActor, CancellationToken cancellationToken)` — runs inside a caller-owned transaction with `license` already locked/tracked with `Entitlements` loaded; does not call `SaveChangesAsync`/`CommitAsync`/`RollbackAsync` itself. `internal static bool IsSerializationFailure(Exception? exception)` (was `private static`).
- This task's only success criterion is that the **existing** test suite (in particular `LicensingFlowTests.cs` and any other activation tests) still passes unmodified — it proves the refactor preserved behavior.

- [ ] **Step 1: Extract the shared method**

In `src/LicenseServer/LicenseStore.cs`, replace the body of `ActivateAsync` (current lines 273-398) with:

```csharp
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
            // Only the "created a new activation" success path leaves anything for
            // ActivateWithinLockAsync to persist - the idempotent-replay and already-active-
            // for-device success paths return early without adding any entity, and must not
            // reach a real COMMIT: under Serializable isolation, committing a transaction that
            // only read (via the FOR UPDATE lock) can itself surface a spurious 40001
            // serialization failure, which would regress those two paths from an unconditional
            // 200 OK to a possible concurrent-retry 409 - a behavior change ActivateAsync must
            // not introduce relative to its pre-extraction form.
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
```

Change `private static bool IsSerializationFailure(Exception? exception)` (current line 400) to `internal static bool IsSerializationFailure(Exception? exception)` — same body, only the modifier changes.

- [ ] **Step 2: Build**

Run: `dotnet build src/LicenseServer/LicenseServer.csproj`
Expected: builds with no errors.

- [ ] **Step 3: Run the full existing test suite to confirm no regression**

Run: `./scripts/test-database-and-auth.sh --test-filter "FullyQualifiedName~LicensingFlowTests|FullyQualifiedName~ActivationCodeTests"`
Expected: PASS, identical to pre-refactor results. If anything fails, the extraction changed observable behavior — compare the failing assertion against the original method body (git diff) before proceeding; do not paper over a real behavior change.

- [ ] **Step 4: Commit**

```bash
git add src/LicenseServer/LicenseStore.cs
git commit -m "refactor: extract LicenseStore.ActivateWithinLockAsync for reuse by deployment-key enrollment"
```

---

### Task 5: API contracts

**Files:**
- Modify: `src/LicenseServer/ApiContracts.cs`

**Interfaces:**
- Produces: `CreateDeploymentKeyRequest`, `RenameDeploymentKeyRequest`, `RevokeDeploymentKeyRequest`, `DeploymentKeyView`, `CreatedDeploymentKey`, `EnrollDeploymentKeyRequest` records, all `public sealed record` in namespace `LicenseServer`.

- [ ] **Step 1: Add the records**

In `src/LicenseServer/ApiContracts.cs`, add at the end of the file (after line 71):

```csharp

public sealed record CreateDeploymentKeyRequest(string? Name, DateTimeOffset? ExpiresAt);
public sealed record RenameDeploymentKeyRequest(string? Name);
public sealed record RevokeDeploymentKeyRequest(string? Reason);

public sealed record DeploymentKeyView(
    Guid Id,
    string PublicId,
    string Name,
    Guid LicenseRecordId,
    string LastFour,
    DateTimeOffset CreatedAt,
    string CreatedBy,
    DateTimeOffset? ExpiresAt,
    DateTimeOffset? RevokedAt,
    DateTimeOffset? LastUsedAt,
    Guid? ReplacedByDeploymentKeyId);

public sealed record CreatedDeploymentKey(DeploymentKeyView DeploymentKey, string Secret);

public sealed record EnrollDeploymentKeyRequest(
    string? DeploymentKey,
    string? RequestId,
    string? ActivationToken,
    string? Mode,
    DeviceRequest? Device);
```

- [ ] **Step 2: Build**

Run: `dotnet build src/LicenseServer/LicenseServer.csproj`
Expected: builds with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/LicenseServer/ApiContracts.cs
git commit -m "feat: add Deployment Key API contracts"
```

---

### Task 6: `DeploymentKeyService` — CRUD lifecycle and enrollment

**Files:**
- Modify: `src/LicenseServer/DeploymentKeys.cs`

**Interfaces:**
- Consumes: `ApplicationDbContext`, `LicenseStore.ActivateWithinLockAsync` / `LicenseStore.IsSerializationFailure` / `LicenseStore.Hash` (Task 4), `DeploymentKeyHasher` / `DeploymentKeyFormat` (Task 2), `Permissions.DeploymentKeysRead` / `DeploymentKeysManage` (Task 3), `PermissionGuard.RequireAsync` (existing), `ILicenseSigner.CanSign` (existing), `DeviceIdentity.Scheme` / `IsValidDeviceId` from `SoftwareLicensing` (existing), `StoreResult<T>` (existing), API contracts from Task 5.
- Produces: `internal sealed class DeploymentKeyService` with `CreateAsync`, `ListAsync`, `RenameAsync`, `RotateAsync`, `RevokeAsync`, `EnrollAsync` — signatures below.

- [ ] **Step 1: Write the failing service tests**

Create `tests/LicenseServer.Tests/DeploymentKeyServiceTests.cs`:

```csharp
using System.Text.Json;
using LicenseServer.Authorization;
using LicenseServer.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace LicenseServer.Tests;

[Collection(PostgresTestSuite.Name)]
public sealed class DeploymentKeyServiceTests(PostgresWebFixture fixture)
{
    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task CreatedDeploymentKeyIsShownOnceAndOnlyItsHashIsPersisted()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 3);
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<DeploymentKeyService>();

        var created = await service.CreateAsync(licenseId, new CreateDeploymentKeyRequest("Intune", null), "stage11-test");

        Assert.True(created.Success);
        Assert.StartsWith("dpk_live_", created.Value!.Secret, StringComparison.Ordinal);

        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var stored = await db.DeploymentKeys.SingleAsync(x => x.Id == created.Value.DeploymentKey.Id);
        var json = JsonSerializer.Serialize(stored);
        Assert.Equal(DeploymentKeyHasher.CurrentVersion, stored.SecretHashVersion);
        Assert.Equal(32, stored.SecretHash.Length);
        Assert.DoesNotContain(created.Value.Secret, json, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task MultipleActiveDeploymentKeysCanCoexistOnOneLicense()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 3);
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<DeploymentKeyService>();

        await service.CreateAsync(licenseId, new CreateDeploymentKeyRequest("Intune", null), "stage11-test");
        await service.CreateAsync(licenseId, new CreateDeploymentKeyRequest("RMM", null), "stage11-test");
        await service.CreateAsync(licenseId, new CreateDeploymentKeyRequest("Servers", null), "stage11-test");

        var listed = await service.ListAsync(licenseId);
        Assert.True(listed.Success);
        Assert.Equal(3, listed.Value!.Count);
        Assert.All(listed.Value, item => Assert.Null(item.RevokedAt));
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task RotatingADeploymentKeyInvalidatesThePreviousSecretButKeepsTheKeyUsable()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 3);
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<DeploymentKeyService>();
        var created = await service.CreateAsync(licenseId, new CreateDeploymentKeyRequest("Intune", null), "stage11-test");

        var rotated = await service.RotateAsync(created.Value!.DeploymentKey.Id, "stage11-test");

        Assert.True(rotated.Success);
        Assert.NotEqual(created.Value.Secret, rotated.Value!.Secret);
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var oldKey = await db.DeploymentKeys.SingleAsync(x => x.Id == created.Value.DeploymentKey.Id);
        Assert.NotNull(oldKey.RevokedAt);
        Assert.Equal(rotated.Value.DeploymentKey.Id, oldKey.ReplacedByDeploymentKeyId);

        var enroll = scope.ServiceProvider.GetRequiredService<DeploymentKeyService>();
        var withOldSecret = await enroll.EnrollAsync(EnrollRequest(created.Value.Secret, "AA11"), DateTimeOffset.UtcNow);
        Assert.False(withOldSecret.Success);
        var withNewSecret = await enroll.EnrollAsync(EnrollRequest(rotated.Value.Secret, "BB22"), DateTimeOffset.UtcNow);
        Assert.True(withNewSecret.Success);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task RevokingADeploymentKeyDoesNotDeactivateMachinesPreviouslyEnrolledThroughIt()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 3);
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<DeploymentKeyService>();
        var created = await service.CreateAsync(licenseId, new CreateDeploymentKeyRequest("Intune", null), "stage11-test");
        var enrolled = await service.EnrollAsync(EnrollRequest(created.Value!.Secret, "CC33"), DateTimeOffset.UtcNow);
        Assert.True(enrolled.Success);

        var revoked = await service.RevokeAsync(created.Value.DeploymentKey.Id, "compromised", "stage11-test");
        Assert.True(revoked.Success);

        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var activation = await db.Activations.SingleAsync(x => x.ActivationId == enrolled.Value!.ActivationId);
        Assert.Null(activation.DeactivatedAt);

        var secondEnroll = await service.EnrollAsync(EnrollRequest(created.Value.Secret, "DD44"), DateTimeOffset.UtcNow);
        Assert.False(secondEnroll.Success);
        Assert.Equal(401, secondEnroll.StatusCode);
    }

    private async Task<(string LicenseId, Guid LicenseRecordId)> IssueLicenseAsync(int seats)
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<LicenseStore>();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var product = await db.ProductDefinitions.FirstAsync(x => x.IsActive);
        var issued = await store.IssueAsync(new IssueLicenseRequest(
            $"Deployment Key Test {Guid.NewGuid():N}", $"dpk-{Guid.NewGuid():N}@example.com",
            product.Id, "business", "perpetual", null, seats, null, null),
            new IssuanceContext("stage11-test", "stage11-test", Guid.NewGuid().ToString(), null));
        Assert.True(issued.Success, issued.Error);
        var record = await db.Licenses.SingleAsync(x => x.LicenseId == issued.Value!.LicenseId);
        return (issued.Value!.LicenseId, record.Id);
    }

    private static EnrollDeploymentKeyRequest EnrollRequest(string deploymentKey, string deviceSuffix) => new(
        deploymentKey,
        Guid.NewGuid().ToString(),
        Convert.ToBase64String(RandomToken()),
        "offline",
        new DeviceRequest("os-machine-id-sha256-v1", new string(deviceSuffix[0], 60) + deviceSuffix, "test-device"));

    private static byte[] RandomToken() => System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
}
```

- [ ] **Step 2: Run to verify it fails to compile**

Run: `dotnet test tests/LicenseServer.Tests/LicenseServer.Tests.csproj --filter DeploymentKeyServiceTests`
Expected: build error — `DeploymentKeyService` does not exist.

- [ ] **Step 3: Implement `DeploymentKeyService`**

Append to `src/LicenseServer/DeploymentKeys.cs` (after the `DeploymentKeyFormat` class):

```csharp
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
        var current = await db.DeploymentKeys.Include(x => x.License).SingleOrDefaultAsync(x => x.Id == id, cancellationToken);
        if (current is null) return StoreResult<CreatedDeploymentKey>.NotFound("Deployment key was not found.");
        if (current.RevokedAt is not null)
            return StoreResult<CreatedDeploymentKey>.Conflict("A revoked deployment key cannot be rotated.");

        var now = clock.GetUtcNow();
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

    private void AddRejectionAudit(DeploymentKey? key, string publicId, string reason, DateTimeOffset now) =>
        db.AuditRecords.Add(new AuditRecord
        {
            Actor = "anonymous",
            Action = "deployment-key.enrollment-rejected",
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
```

Add the required `using` directives at the top of `src/LicenseServer/DeploymentKeys.cs`:

```csharp
using System.Data;
using System.Text.Json;
using LicenseServer.Authorization;
using LicenseServer.Data;
using Microsoft.EntityFrameworkCore;
using SoftwareLicensing;
```
(keep the existing `System.Security.Cryptography`, `System.Text`, `Microsoft.AspNetCore.WebUtilities` from Task 2)

- [ ] **Step 4: Register `DeploymentKeyService` and `DeploymentKeyHasher` in DI (minimal, to let the test project compile/run)**

This is completed fully in Task 8; for this task, add only the two DI lines needed for `DeploymentKeyServiceTests` to resolve the service, in `src/LicenseServer/Program.cs` right after line 273 (`builder.Services.AddSingleton(new ApiCredentialHasher(apiCredentialPepper));`):

```csharp
var configuredDeploymentKeyPepper = builder.Configuration["DeploymentKeys:Pepper"];
byte[] deploymentKeyPepper;
if (string.IsNullOrWhiteSpace(configuredDeploymentKeyPepper) && builder.Environment.IsDevelopment())
    deploymentKeyPepper = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
else if (string.IsNullOrWhiteSpace(configuredDeploymentKeyPepper))
    throw new InvalidOperationException("DeploymentKeys:Pepper is required outside Development and must be at least 32 random bytes encoded as Base64.");
else
{
    try { deploymentKeyPepper = Convert.FromBase64String(configuredDeploymentKeyPepper); }
    catch (FormatException exception) { throw new InvalidOperationException("DeploymentKeys:Pepper must be valid Base64.", exception); }
    if (deploymentKeyPepper.Length < 32) throw new InvalidOperationException("DeploymentKeys:Pepper must decode to at least 32 bytes.");
}
builder.Services.AddSingleton(new DeploymentKeyHasher(deploymentKeyPepper));
```

And after line 283 (`builder.Services.AddScoped<ApiCredentialService>();`):

```csharp
builder.Services.AddScoped<DeploymentKeyService>();
```

Add a `DeploymentKeys:Pepper` entry to the test fixture so `DeploymentKeyServiceTests` can run: in `tests/LicenseServer.Tests/PostgresWebFixture.cs`, add after line 144 (`["ApiCredentials:Pepper"] = "HyQjIiEgHx4dHBsaGRgXFhUUExIREA8ODQwLCgkIBwY=",`):

```csharp
                ["DeploymentKeys:Pepper"] = "9vWKjZpH04swggPztM7cfUpwLXtasA7YaCyYWZPylAI=",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `./scripts/test-database-and-auth.sh --test-filter "FullyQualifiedName~DeploymentKeyServiceTests"`
Expected: PASS (all four tests).

- [ ] **Step 6: Commit**

```bash
git add src/LicenseServer/DeploymentKeys.cs src/LicenseServer/Program.cs tests/LicenseServer.Tests/PostgresWebFixture.cs tests/LicenseServer.Tests/DeploymentKeyServiceTests.cs
git commit -m "feat: add DeploymentKeyService lifecycle and seat-shared enrollment"
```

---

### Task 7: Admin CRUD endpoints

**Files:**
- Modify: `src/LicenseServer/Program.cs`

**Interfaces:**
- Consumes: `DeploymentKeyService` (Task 6), `Permissions.DeploymentKeysRead`/`DeploymentKeysManage` (Task 3), existing `ValidAntiforgeryAsync`/`AntiforgeryProblem`/`Problem`/`FieldProblem` helpers.
- Produces: five new admin routes under `/api/v1/admin`.

- [ ] **Step 1: Add the routes**

In `src/LicenseServer/Program.cs`, add immediately after the `adminApi.MapPost("/activations/{activationId}/deactivate", ...)` block (currently ends at line 884, right before the `app.MapPost("/licenses/{licenseId}/cancel", ...)` Razor-form section):

```csharp

adminApi.MapPost("/licenses/{licenseId}/deployment-keys", async (
    string licenseId, CreateDeploymentKeyRequest request, DeploymentKeyService service,
    IAntiforgery antiforgery, HttpContext context, CancellationToken ct) =>
{
    if (!await ValidAntiforgeryAsync(antiforgery, context)) return AntiforgeryProblem();
    var result = await service.CreateAsync(licenseId, request, context.User.Identity?.Name ?? "unknown", ct);
    return result.Success
        ? Results.Created($"/api/v1/admin/licenses/{licenseId}/deployment-keys", result.Value)
        : FieldProblem(result);
}).RequireAuthorization(Permissions.DeploymentKeysManage)
  .WithDescription("Creates one deployment key for this license and returns its full secret exactly once.");

adminApi.MapGet("/licenses/{licenseId}/deployment-keys", async (
    string licenseId, DeploymentKeyService service, CancellationToken ct) =>
{
    var result = await service.ListAsync(licenseId, ct);
    return result.Success ? Results.Ok(result.Value) : Problem(result);
}).RequireAuthorization(Permissions.DeploymentKeysRead)
  .WithDescription("Lists redacted deployment keys for this license. Secrets are never returned.");

adminApi.MapPatch("/deployment-keys/{id:guid}", async (
    Guid id, RenameDeploymentKeyRequest request, DeploymentKeyService service,
    IAntiforgery antiforgery, HttpContext context, CancellationToken ct) =>
{
    if (!await ValidAntiforgeryAsync(antiforgery, context)) return AntiforgeryProblem();
    var result = await service.RenameAsync(id, request.Name, context.User.Identity?.Name ?? "unknown", ct);
    return result.Success ? Results.Ok(result.Value) : FieldProblem(result);
}).RequireAuthorization(Permissions.DeploymentKeysManage);

adminApi.MapPost("/deployment-keys/{id:guid}/rotate", async (
    Guid id, DeploymentKeyService service, IAntiforgery antiforgery, HttpContext context, CancellationToken ct) =>
{
    if (!await ValidAntiforgeryAsync(antiforgery, context)) return AntiforgeryProblem();
    var result = await service.RotateAsync(id, context.User.Identity?.Name ?? "unknown", ct);
    return result.Success ? Results.Ok(result.Value) : Problem(result);
}).RequireAuthorization(Permissions.DeploymentKeysManage)
  .WithDescription("Issues a new secret and immediately invalidates the previous one. Returns the new secret exactly once.");

adminApi.MapPost("/deployment-keys/{id:guid}/revoke", async (
    Guid id, RevokeDeploymentKeyRequest request, DeploymentKeyService service,
    IAntiforgery antiforgery, HttpContext context, CancellationToken ct) =>
{
    if (!await ValidAntiforgeryAsync(antiforgery, context)) return AntiforgeryProblem();
    var result = await service.RevokeAsync(id, request.Reason, context.User.Identity?.Name ?? "unknown", ct);
    return result.Success ? Results.NoContent() : Problem(result);
}).RequireAuthorization(Permissions.DeploymentKeysManage)
  .WithDescription("Blocks new enrollment through this key. Machines already enrolled through it remain active.");
```

- [ ] **Step 2: Build**

Run: `dotnet build src/LicenseServer/LicenseServer.csproj`
Expected: builds with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/LicenseServer/Program.cs
git commit -m "feat: add admin Deployment Key CRUD endpoints"
```

---

### Task 8: Anonymous enrollment endpoint, dedicated rate limiting, credential-partitioned throttling

**Files:**
- Modify: `src/LicenseServer/Program.cs`

**Interfaces:**
- Consumes: `DeploymentKeyService.EnrollAsync` (Task 6), existing `SignedResponse`/`Problem` helpers, `LicenseStore`, `ILicenseSigner`, `ILicenseVerifier`.
- Produces: `POST /api/v1/deployment-keys/enroll` (anonymous), rate-limit policy `"deployment-key-enroll"` partitioned by the presented deployment key's public ID when parseable (falling back to remote IP).

- [ ] **Step 1: Add the rate limit policy**

In `src/LicenseServer/Program.cs`, inside `builder.Services.AddRateLimiter(options => { ... })` (currently lines 293-317), add after the `"device-api"` policy (before the closing `});` at line 317):

```csharp
    options.AddPolicy("deployment-key-enroll", context =>
    {
        var partitionKey = context.Items.TryGetValue("deployment-key-partition", out var value) && value is string key
            ? key
            : context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        return RateLimitPartition.GetFixedWindowLimiter(partitionKey, _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = builder.Configuration.GetValue("RateLimits:DeploymentKeyEnrollPermitLimit", 20),
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0,
            AutoReplenishment = true
        });
    });
```

- [ ] **Step 2: Add the body-peek middleware, before `app.UseRateLimiter()`**

Add immediately before `app.UseRateLimiter();` (currently line 377):

```csharp
app.UseWhen(
    context => HttpMethods.IsPost(context.Request.Method)
        && context.Request.Path.Equals("/api/v1/deployment-keys/enroll", StringComparison.OrdinalIgnoreCase),
    branch => branch.Use(async (context, next) =>
    {
        // Rate limiting middleware resolves its partition key synchronously from HttpContext
        // before minimal-API model binding reads the body, so a distinct public-id partition (in
        // addition to the IP-based device-api partition every other anonymous endpoint uses) has
        // to be extracted here and stashed in HttpContext.Items ahead of app.UseRateLimiter().
        // Peeking only the safe, non-secret "deploymentKey" public-id prefix - never comparing or
        // logging the secret half - keeps this consistent with the "never log the full secret" rule.
        context.Request.EnableBuffering();
        using var reader = new StreamReader(context.Request.Body, System.Text.Encoding.UTF8, leaveOpen: true);
        var body = await reader.ReadToEndAsync();
        context.Request.Body.Position = 0;
        string partitionKey;
        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(body);
            // TryGetProperty throws InvalidOperationException (not JsonException) when the root
            // isn't a JSON object - a body like `null`, `[]`, or a bare string/number/bool is
            // syntactically valid JSON, so Parse succeeds and the catch below never fires; the
            // ValueKind guard here avoids the call entirely instead of relying on a broader catch.
            partitionKey = document.RootElement.ValueKind == System.Text.Json.JsonValueKind.Object
                && document.RootElement.TryGetProperty("deploymentKey", out var value)
                && value.ValueKind == System.Text.Json.JsonValueKind.String
                && DeploymentKeyFormat.TryParse(value.GetString(), out var publicId, out _)
                ? $"dpk:{publicId}"
                : context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        }
        catch (System.Text.Json.JsonException)
        {
            partitionKey = context.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        }
        context.Items["deployment-key-partition"] = partitionKey;
        await next();
    }));
```

- [ ] **Step 3: Add the enrollment endpoint**

Add immediately after the `app.MapPost("/api/v1/activations/{activationId}/deactivate", ...)` block (currently ends at line 542, right before `var adminApi = ...` at line 544):

```csharp
app.MapPost("/api/v1/deployment-keys/enroll", async (
    EnrollDeploymentKeyRequest request, DeploymentKeyService service, LicenseStore store,
    ILicenseSigner signer, ILicenseVerifier verifier, CancellationToken cancellationToken) =>
{
    var now = DateTimeOffset.UtcNow;
    var result = await service.EnrollAsync(request, now, cancellationToken: cancellationToken);
    return result.Success
        ? await SignedResponse(result.Value!, store, signer, verifier, now, cancellationToken)
        : Problem(result);
}).AllowAnonymous().RequireRateLimiting("deployment-key-enroll")
  .WithDescription("Enrolls one machine under the deployment key's parent license, sharing that license's existing seat pool and activation records with the manual activation-code flow. The deployment key grants only machine enrollment - no admin, customer, billing, or activation-listing access.");
```

- [ ] **Step 4: Build**

Run: `dotnet build src/LicenseServer/LicenseServer.csproj`
Expected: builds with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/LicenseServer/Program.cs
git commit -m "feat: add anonymous Deployment Key enrollment endpoint with credential-partitioned rate limiting"
```

---

### Task 9: Endpoint-level enrollment tests

**Files:**
- Create: `tests/LicenseServer.Tests/DeploymentKeyEnrollmentTests.cs`

**Interfaces:**
- Consumes: `PostgresWebFixture` (`fixture.CreateAuthenticatedClient`, `fixture.Factory`), admin endpoints (Task 7), enrollment endpoint (Task 8), `DeploymentKeyService`/`LicenseStore` for setup.

- [ ] **Step 1: Write the tests**

Create `tests/LicenseServer.Tests/DeploymentKeyEnrollmentTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using LicenseServer.Authorization;
using LicenseServer.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace LicenseServer.Tests;

[Collection(PostgresTestSuite.Name)]
public sealed class DeploymentKeyEnrollmentTests(PostgresWebFixture fixture)
{
    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task EnrollmentSharesTheSameSeatPoolAsManualActivation()
    {
        var (licenseId, activationCode) = await IssueLicenseAsync(seats: 2);
        var secret = await CreateDeploymentKeyAsync(licenseId, "Intune");

        using var enrollClient = fixture.Factory.CreateClient();
        var first = await enrollClient.PostAsJsonAsync("/api/v1/deployment-keys/enroll", EnrollBody(secret, "AA11"));
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);

        using var activateClient = fixture.Factory.CreateClient();
        var second = await activateClient.PostAsJsonAsync($"/api/v1/licenses/{licenseId}/activate", new
        {
            requestId = Guid.NewGuid().ToString(),
            activationCode,
            activationToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
            mode = "offline",
            device = new { scheme = "os-machine-id-sha256-v1", deviceId = new string('B', 60) + "BB22", deviceName = "manual-device" }
        });
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        var third = await enrollClient.PostAsJsonAsync("/api/v1/deployment-keys/enroll", EnrollBody(secret, "CC33"));
        Assert.Equal(HttpStatusCode.Conflict, third.StatusCode);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task InvalidDeploymentKeyIsRejected()
    {
        using var client = fixture.Factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/v1/deployment-keys/enroll",
            EnrollBody("dpk_live_0000000000000000_" + new string('A', 43), "DD44"));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task RevokedDeploymentKeyIsRejected()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 2);
        var secret = await CreateDeploymentKeyAsync(licenseId, "Intune");
        await using (var scope = fixture.Factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var key = await db.DeploymentKeys.SingleAsync(x => x.Name == "Intune" && x.LicenseRecordId ==
                db.Licenses.Single(l => l.LicenseId == licenseId).Id);
            key.RevokedAt = DateTimeOffset.UtcNow;
            key.RevokedBy = "stage11-test";
            await db.SaveChangesAsync();
        }

        using var client = fixture.Factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/v1/deployment-keys/enroll", EnrollBody(secret, "EE55"));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task ExpiredDeploymentKeyIsRejected()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 2);
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var service = scope.ServiceProvider.GetRequiredService<DeploymentKeyService>();
        var created = await service.CreateAsync(licenseId,
            new CreateDeploymentKeyRequest("Expiring", DateTimeOffset.UtcNow.AddMinutes(1)), "stage11-test");
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var key = await db.DeploymentKeys.SingleAsync(x => x.Id == created.Value!.DeploymentKey.Id);
        key.ExpiresAt = DateTimeOffset.UtcNow.AddSeconds(-1);
        await db.SaveChangesAsync();

        using var client = fixture.Factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/v1/deployment-keys/enroll", EnrollBody(created.Value!.Secret, "FF66"));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task DeploymentKeyGrantsNoAccessToAdminOrCustomerApis()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 2);
        var secret = await CreateDeploymentKeyAsync(licenseId, "Intune");

        using var client = fixture.Factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await client.GetAsync($"/api/v1/admin/authorization/{Permissions.LicensesRead}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await client.GetAsync($"/api/v1/admin/licenses/{licenseId}")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized,
            (await client.GetAsync($"/api/v1/admin/licenses/{licenseId}/deployment-keys")).StatusCode);
    }

    private async Task<(string LicenseId, string ActivationCode)> IssueLicenseAsync(int seats)
    {
        // Issued directly through LicenseStore rather than the admin HTTP endpoint or the shared
        // seeded demo license: LicensingFlowTests.cs mutates (and eventually revokes) that demo
        // license, and since every Postgres-backed test class shares one xUnit collection (so runs
        // sequentially against the same database), reusing it here would make these tests order-
        // dependent on what LicensingFlowTests left behind. A freshly issued license avoids that.
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<LicenseStore>();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var product = await db.ProductDefinitions.FirstAsync(x => x.IsActive);
        var issued = await store.IssueAsync(new IssueLicenseRequest(
            $"Enrollment Test {Guid.NewGuid():N}", $"enroll-{Guid.NewGuid():N}@example.com",
            product.Id, "business", "perpetual", null, seats, null, null),
            new IssuanceContext("stage11-test", "stage11-test", Guid.NewGuid().ToString(), null));
        Assert.True(issued.Success, issued.Error);
        return (issued.Value!.LicenseId, issued.Value.ActivationCode);
    }

    private async Task<string> CreateDeploymentKeyAsync(string licenseId, string name)
    {
        using var client = fixture.CreateAuthenticatedClient(administrator: true);
        var response = await client.PostAsJsonAsync($"/api/v1/admin/licenses/{licenseId}/deployment-keys", new { name });
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return body.GetProperty("secret").GetString()!;
    }

    private static object EnrollBody(string deploymentKey, string deviceSuffix) => new
    {
        deploymentKey,
        requestId = Guid.NewGuid().ToString(),
        activationToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
        mode = "offline",
        device = new { scheme = "os-machine-id-sha256-v1", deviceId = new string('A', 60) + deviceSuffix, deviceName = "enrolled-device" }
    };
}
```

Add the two missing `using` directives at the top: `using System.Security.Cryptography;` and `using System.Text.Json;`.

- [ ] **Step 2: Run to verify they fail (if any endpoint wiring gap exists) or pass**

Run: `./scripts/test-database-and-auth.sh --test-filter "FullyQualifiedName~DeploymentKeyEnrollmentTests"`
Expected: PASS on first run since Tasks 6-8 are already implemented. If any test fails, fix the implementation (not the test) — the test names encode the issue's required behaviors directly (seat sharing, invalid/revoked/expired rejection, no unrelated API access).

- [ ] **Step 3: Add a rate-limit enforcement test**

Add one more `[Fact]` to the same file:

```csharp
    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task EnrollmentRateLimitRejectsBurstsFromTheSamePublicId()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 50);
        var secret = await CreateDeploymentKeyAsync(licenseId, "RateLimited");
        using var client = fixture.Factory.CreateClient();

        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 25; i++)
        {
            var response = await client.PostAsJsonAsync("/api/v1/deployment-keys/enroll", EnrollBody(secret, $"{i:D4}"));
            statuses.Add(response.StatusCode);
        }

        Assert.Contains(HttpStatusCode.TooManyRequests, statuses);
    }
```

This relies on `RateLimits:DeploymentKeyEnrollPermitLimit` being small enough in the test environment to trip within 25 requests. Add to `tests/LicenseServer.Tests/PostgresWebFixture.cs`, in the same `AddInMemoryCollection` dictionary as the pepper entries (Task 6, Step 4):

```csharp
                ["RateLimits:DeploymentKeyEnrollPermitLimit"] = "10",
```

- [ ] **Step 4: Run the full Deployment Key test set**

Run: `./scripts/test-database-and-auth.sh --test-filter "FullyQualifiedName~DeploymentKey"`
Expected: PASS (format, service, and enrollment tests together).

- [ ] **Step 5: Commit**

```bash
git add tests/LicenseServer.Tests/DeploymentKeyEnrollmentTests.cs tests/LicenseServer.Tests/PostgresWebFixture.cs
git commit -m "test: cover Deployment Key enrollment, rejection paths, and rate limiting"
```

---

### Task 10: Full suite verification and documentation

**Files:**
- Modify: `LICENSING-INTEGRATION.md`
- Modify: `README.md` (only if it documents the admin API surface — check first)

**Interfaces:**
- None — documentation and final verification only.

- [ ] **Step 1: Document the enrollment flow**

In `LICENSING-INTEGRATION.md`, add a new subsection after `### 6.4 Deactivate` (ends at line ~433, right before `## 7. Offline activation request`):

```markdown
### 6.5 Deployment key enrollment (unattended fleet enrollment) — `POST {baseUrl}/api/v1/deployment-keys/enroll`

For Business/Enterprise/Education-style deployments (Intune, RMM, golden images), an operator
creates one or more **Deployment Keys** for a license from the admin API
(`POST /api/v1/admin/licenses/{licenseId}/deployment-keys`). A Deployment Key is not the license's
activation code — it is a separate, revocable credential in the form
`dpk_live_<publicId>_<secret>`, shown in full only once at creation or rotation.

Request body is identical to `Activate` except `activationCode` is replaced by `deploymentKey`:

```json
{
  "deploymentKey": "dpk_live_...",
  "requestId": "GUID",
  "activationToken": "base64(32 random bytes)",
  "mode": "online",
  "device": { "scheme": "os-machine-id-sha256-v1", "deviceId": "...", "deviceName": "..." }
}
```

The response is the same signed `ActivationResponse` as `Activate`. Enrollment consumes from the
same seat pool as manual activation, and the resulting activation is managed identically afterward
(`validate` / `refresh` / `deactivate`). Revoking a Deployment Key blocks *new* enrollment through
it; machines already enrolled keep working until deactivated through the normal activation
lifecycle. A Deployment Key grants no access beyond this one enrollment endpoint.
```

- [ ] **Step 2: Run the complete test suite**

Run: `./scripts/test-database-and-auth.sh`
Expected: PASS — every test in `tests/LicenseServer.Tests`, including the new Deployment Key tests and all pre-existing tests (proving the `LicenseStore.ActivateAsync` refactor in Task 4 introduced no regression).

- [ ] **Step 3: Full solution build in Release**

Run: `dotnet build --configuration Release`
Expected: builds with no errors or new warnings.

- [ ] **Step 4: Commit**

```bash
git add LICENSING-INTEGRATION.md
git commit -m "docs: document Deployment Key enrollment flow"
```

---

## Post-plan: acceptance criteria cross-check

- `DeploymentKey` is a first-class entity related to one licence — Task 1.
- Multiple Deployment Keys per licence — Task 6 test `MultipleActiveDeploymentKeysCanCoexistOnOneLicense`.
- Full key secret shown only once, never stored plaintext — Task 6 test `CreatedDeploymentKeyIsShownOnceAndOnlyItsHashIsPersisted`; Task 6 `RotateAsync` returns the new secret only in its return value, never re-derivable from stored `SecretHash`.
- Create/list/rename/rotate/revoke lifecycle — Task 6/7.
- Revocation blocks new enrollment but leaves existing activations intact — Task 6 test `RevokingADeploymentKeyDoesNotDeactivateMachinesPreviouslyEnrolledThroughIt`.
- Deployment Keys inherit seat capacity from their parent licence — Task 4 (`ActivateWithinLockAsync` shared seat-count logic), Task 9 test `EnrollmentSharesTheSameSeatPoolAsManualActivation`.
- No `Unlimited` seat mode/sentinel introduced — no such field added anywhere in this plan.
- Permissions, audit events, rate-limit hooks — Task 3 (permissions), Task 6 (`deployment-key.created/renamed/rotated/revoked/enrollment-succeeded/enrollment-rejected` audit actions), Task 8 (dedicated rate-limit policy + credential partitioning).
- Terminology — "Deployment Key" used consistently throughout; no "Corporate License" wording anywhere in this plan.
