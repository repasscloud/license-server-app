namespace LicenseServer;

public sealed record DeviceRequest(string? Scheme, string? DeviceId, string? DeviceName);

public sealed record ActivateRequest(
    string? RequestId,
    string? ActivationCode,
    string? ActivationToken,
    string? Mode,
    DeviceRequest? Device);

public sealed record ActivationCredentialRequest(
    string? ActivationToken,
    string? DeviceId);

public sealed record ActivationResponse(
    string LicenseId,
    string ActivationId,
    string Status,
    string SignedLicense,
    DateTimeOffset? RefreshAfter,
    DateTimeOffset? LeaseExpiresAt);

public sealed record ValidationResponse(
    string LicenseId,
    string ActivationId,
    string Status,
    DateTimeOffset ServerTime);

public sealed record DeactivationResponse(
    string LicenseId,
    string ActivationId,
    string Status,
    DateTimeOffset DeactivatedAt);

public sealed record RevokeRequest(bool Confirmed, string? Reason, long? Version);

public sealed record RevokeSigningKeyRequest(bool Confirmed, string? Reason);

public sealed record CancelRequest(bool Confirmed, string? Reason, long Version, string? Reference = null);

public sealed record AdminDeactivateRequest(bool Confirmed, string? Reason, long Version);

public sealed record AmendTermsRequest(
    DateTimeOffset? ExpiresAt,
    int? Seats,
    DateOnly? UpdatesUntil,
    string? Reason,
    long Version,
    string? Edition = null);

public sealed record IssueLicenseRequest(
    string? CustomerName,
    string? CustomerEmail,
    Guid? ProductId,
    string? Edition,
    string? LicenseType,
    DateTimeOffset? ExpiresAt,
    int Seats,
    DateOnly? UpdatesUntil,
    IReadOnlyDictionary<string, object?>? Metadata);

public sealed record CreateProductRequest(string? Code, string? DisplayName, string? Description);
public sealed record UpdateProductRequest(string? DisplayName, string? Description, bool? IsActive);

public sealed record CreateStripeProductMappingRequest(
    string? StripeProductId,
    Guid? ProductDefinitionId,
    string? Edition,
    string? LicenseType,
    int? Seats,
    DateOnly? UpdatesUntil,
    DateTimeOffset? ExpiresAt);

public sealed record UpdateStripeProductMappingRequest(
    Guid? ProductDefinitionId,
    string? Edition,
    string? LicenseType,
    int? Seats,
    DateOnly? UpdatesUntil,
    DateTimeOffset? ExpiresAt);
public sealed record UpdateCustomerRequest(string? Name, string? Email);
public sealed record RotateActivationCodeRequest(long Version);

public sealed record InviteUserRequest(string? Email, IReadOnlyList<string>? Roles);
public sealed record CreateServiceAccountRequest(string? Email, IReadOnlyList<string>? Roles);
public sealed record CreateUserRequest(string? Email, string? AccountType, IReadOnlyList<string>? Roles);
public sealed record UpdateUserRequest(bool? IsEnabled, IReadOnlyList<string>? Roles, bool ForcePasswordReset = false);

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

public sealed record ForceDeactivateDeploymentKeyRequest(
    string? DeploymentKey,
    DeviceRequest? Device);

public sealed record ForceDeactivationResponse(
    string LicenseId,
    string ActivationId,
    string Status,
    DateTimeOffset DeactivatedAt);
