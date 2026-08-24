using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using LicenseServer.Authorization;
using LicenseServer.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace LicenseServer.Tests;

[Collection(PostgresTestSuite.Name)]
public sealed class DeploymentKeyForceDeactivateTests(PostgresWebFixture fixture)
{
    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task ForceDeactivateReleasesTheSeatWithoutTheOriginalActivationToken()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 1);
        var (secret, client) = await CreateDeploymentKeyAsync(licenseId, "Lost-Credentials");
        var deviceId = NewDeviceId();

        var enroll = await client.PostAsJsonAsync("/api/v1/deployment-keys/enroll", EnrollBody(secret, deviceId));
        Assert.Equal(HttpStatusCode.OK, enroll.StatusCode);

        // Simulate the local activationToken never having been persisted: force-deactivate is
        // called with only the deployment key and the recomputed deviceId.
        var forceDeactivate = await client.PostAsJsonAsync("/api/v1/deployment-keys/force-deactivate",
            ForceDeactivateBody(secret, deviceId));
        Assert.Equal(HttpStatusCode.OK, forceDeactivate.StatusCode);
        var body = await forceDeactivate.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("deactivated", body.GetProperty("status").GetString());
        Assert.Equal(licenseId, body.GetProperty("licenseId").GetString());

        var reEnroll = await client.PostAsJsonAsync("/api/v1/deployment-keys/enroll", EnrollBody(secret, deviceId));
        Assert.Equal(HttpStatusCode.OK, reEnroll.StatusCode);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task ForceDeactivateWithNoActiveActivationForTheDeviceIsNotFound()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 1);
        var (secret, client) = await CreateDeploymentKeyAsync(licenseId, "Never-Enrolled");

        var response = await client.PostAsJsonAsync("/api/v1/deployment-keys/force-deactivate",
            ForceDeactivateBody(secret, NewDeviceId()));
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task ForceDeactivateDoesNotReleaseADifferentDevicesSeat()
    {
        var (licenseId, activationCode) = await IssueLicenseAsync(seats: 2);
        var (secret, client) = await CreateDeploymentKeyAsync(licenseId, "Intune");
        var enrolledDeviceId = NewDeviceId();
        var enroll = await client.PostAsJsonAsync("/api/v1/deployment-keys/enroll", EnrollBody(secret, enrolledDeviceId));
        Assert.Equal(HttpStatusCode.OK, enroll.StatusCode);

        using var activateClient = fixture.Factory.CreateClient();
        var otherDeviceId = NewDeviceId();
        var activate = await activateClient.PostAsJsonAsync($"/api/v1/licenses/{licenseId}/activate", new
        {
            requestId = Guid.NewGuid().ToString(),
            activationCode,
            activationToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
            mode = "offline",
            device = new { scheme = "os-machine-id-sha256-v1", deviceId = otherDeviceId, deviceName = "manual-device" }
        });
        Assert.Equal(HttpStatusCode.OK, activate.StatusCode);

        // A device that was never enrolled/active still cannot force-release a different device's
        // seat on the same license just by presenting the deployment key.
        var response = await client.PostAsJsonAsync("/api/v1/deployment-keys/force-deactivate",
            ForceDeactivateBody(secret, NewDeviceId()));
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);

        var stillActive = await client.PostAsJsonAsync($"/api/v1/activations/{await ActivationIdFor(otherDeviceId)}/validate",
            new { activationToken = "irrelevant", deviceId = otherDeviceId });
        Assert.NotEqual(HttpStatusCode.NotFound, stillActive.StatusCode);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task InvalidDeploymentKeyIsRejected()
    {
        using var client = fixture.Factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/v1/deployment-keys/force-deactivate",
            ForceDeactivateBody("dpk_live_0000000000000000_" + new string('A', 43), NewDeviceId()));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task RevokedDeploymentKeyIsRejected()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 1);
        var (secret, client) = await CreateDeploymentKeyAsync(licenseId, "Intune");
        await using (var scope = fixture.Factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var key = await db.DeploymentKeys.SingleAsync(x => x.Name == "Intune" && x.LicenseRecordId ==
                db.Licenses.Single(l => l.LicenseId == licenseId).Id);
            key.RevokedAt = DateTimeOffset.UtcNow;
            key.RevokedBy = "stage11-test";
            await db.SaveChangesAsync();
        }

        var response = await client.PostAsJsonAsync("/api/v1/deployment-keys/force-deactivate",
            ForceDeactivateBody(secret, NewDeviceId()));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Contains("has been revoked", await response.Content.ReadAsStringAsync(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task ForceDeactivateWritesAnAuditRecord()
    {
        var (licenseId, _) = await IssueLicenseAsync(seats: 1);
        var (secret, client) = await CreateDeploymentKeyAsync(licenseId, "Audited");
        var deviceId = NewDeviceId();
        Assert.Equal(HttpStatusCode.OK,
            (await client.PostAsJsonAsync("/api/v1/deployment-keys/enroll", EnrollBody(secret, deviceId))).StatusCode);

        var response = await client.PostAsJsonAsync("/api/v1/deployment-keys/force-deactivate",
            ForceDeactivateBody(secret, deviceId));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        Assert.True(await db.AuditRecords.AnyAsync(x => x.Action == "deployment-key.force-deactivation-succeeded"));
        Assert.True(await db.AuditRecords.AnyAsync(x => x.Action == "activation.force-deactivated"));
    }

    [Fact]
    [Trait("ExpectedGreenStage", "11")]
    public async Task ForceDeactivateWritesAnAuditRecordEvenWhenValidationFails()
    {
        // A malformed request (missing device) must still be recorded, not just rejections that
        // get as far as verifying the deployment key - the whole point of the audit trail is to
        // surface every attempt, including ones that never reach credential verification.
        using var client = fixture.Factory.CreateClient();
        var response = await client.PostAsJsonAsync("/api/v1/deployment-keys/force-deactivate", new
        {
            deploymentKey = "dpk_live_0000000000000000_" + new string('A', 43)
        });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);

        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        Assert.True(await db.AuditRecords.AnyAsync(x =>
            x.Action == "deployment-key.force-deactivation-rejected" && x.Result == "rejected"));
    }

    private async Task<string> ActivationIdFor(string deviceId)
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var normalizedDeviceId = deviceId.ToUpperInvariant();
        var activation = await db.Activations.SingleAsync(x => x.DeviceIdHash == normalizedDeviceId);
        return activation.ActivationId;
    }

    private async Task<(string LicenseId, string ActivationCode)> IssueLicenseAsync(int seats)
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<LicenseStore>();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var product = await db.ProductDefinitions.FirstAsync(x => x.IsActive);
        var issued = await store.IssueAsync(new IssueLicenseRequest(
            $"ForceDeactivate Test {Guid.NewGuid():N}", $"force-deactivate-{Guid.NewGuid():N}@example.com",
            product.Id, "business", "perpetual", null, seats, null, null),
            new IssuanceContext("stage11-test", "stage11-test", Guid.NewGuid().ToString(), null));
        Assert.True(issued.Success, issued.Error);
        return (issued.Value!.LicenseId, issued.Value.ActivationCode);
    }

    private async Task<(string Secret, HttpClient Client)> CreateDeploymentKeyAsync(string licenseId, string name)
    {
        var client = fixture.CreateAuthenticatedClient(administrator: true, Permissions.DeploymentKeysManage);
        var response = await RoadmapTestSupport.PostAdminAsync(
            client, $"/api/v1/admin/licenses/{licenseId}/deployment-keys", new { name });
        Assert.True(response.StatusCode == HttpStatusCode.Created, await response.Content.ReadAsStringAsync());
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        return (body.GetProperty("secret").GetString()!, client);
    }

    private static object EnrollBody(string deploymentKey, string deviceId) => new
    {
        deploymentKey,
        requestId = Guid.NewGuid().ToString(),
        activationToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
        mode = "offline",
        device = new { scheme = "os-machine-id-sha256-v1", deviceId, deviceName = "enrolled-device" }
    };

    private static object ForceDeactivateBody(string deploymentKey, string deviceId) => new
    {
        deploymentKey,
        device = new { scheme = "os-machine-id-sha256-v1", deviceId, deviceName = "recovery-device" }
    };

    // Every Postgres-backed test class in this run shares one database (see PostgresTestSuite),
    // so a fixed deviceId literal can collide with another test's activation for the same device.
    // A GUID-derived 64-hex-char id keeps each test's device identity unique across the whole run.
    private static string NewDeviceId() => Convert.ToHexString(Guid.NewGuid().ToByteArray())
        .PadRight(64, '0')[..64];
}
