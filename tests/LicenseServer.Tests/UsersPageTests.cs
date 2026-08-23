using System.Net;
using System.Text.RegularExpressions;
using LicenseServer.Authorization;
using LicenseServer.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.DependencyInjection;

namespace LicenseServer.Tests;

[Collection(PostgresTestSuite.Name)]
[Trait("Suite", "Baseline")]
public sealed class UsersPageTests(PostgresWebFixture fixture)
{
    // Regression test for #75 (a follow-up to #64): an account holding `users.manage` via a
    // built-in role does not necessarily see the management UI, because that permission is
    // HighRisk and the policy also requires an "amr: mfa" claim (see PermissionAuthorization.cs),
    // which the claims factory only adds when the account has two-factor enabled. An operator
    // without 2FA configured must not have the Users page silently hide the management UI with
    // no explanation - it should say MFA is required and how to enable it.
    [Fact]
    public async Task UsersPageExplainsMissingMfaInsteadOfSilentlyHidingManagementUi()
    {
        const string email = "no-mfa-admin@localhost";
        const string password = "NoMfaAdminPassword!9x-R4q";
        await using (var scope = fixture.Factory.Services.CreateAsyncScope())
        {
            var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var operatorUser = new ApplicationUser
            {
                UserName = email,
                Email = email,
                EmailConfirmed = true,
                MustChangePassword = false,
                CreatedAt = DateTimeOffset.UtcNow
            };
            var created = await users.CreateAsync(operatorUser, password);
            Assert.True(created.Succeeded, string.Join("; ", created.Errors.Select(x => x.Code)));
            var added = await users.AddToRoleAsync(operatorUser, BuiltInRoles.SystemAdministrator);
            Assert.True(added.Succeeded, string.Join("; ", added.Errors.Select(x => x.Code)));
        }

        try
        {
            using var client = fixture.Factory.CreateClient(new()
            {
                AllowAutoRedirect = false,
                HandleCookies = true,
                BaseAddress = new Uri("https://localhost")
            });
            var loginPage = await client.GetStringAsync("/Account/Login");
            var token = AntiforgeryToken(loginPage);
            var login = await client.PostAsync("/Account/Login", new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["__RequestVerificationToken"] = token,
                ["_handler"] = "login",
                ["Input.Email"] = email,
                ["Input.Password"] = password,
                ["Input.RememberMe"] = "false"
            }));
            Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);

            var usersPage = await client.GetAsync("/settings/users");
            Assert.Equal(HttpStatusCode.OK, usersPage.StatusCode);
            var html = await usersPage.Content.ReadAsStringAsync();

            Assert.Contains("users.manage", html);
            Assert.Contains("multi-factor authentication", html);
            Assert.Contains("/Account/Manage/TwoFactorAuthentication", html);
            Assert.DoesNotContain("Add identity", html);
        }
        finally
        {
            // This test's account is a second, permanently-enabled System Administrator. Other
            // tests in this shared-database collection (e.g. UserAdministrationTests's "leave one
            // enabled administrator" invariant) assume the seeded default admin is the only one,
            // so this account must not outlive the test.
            await using var scope = fixture.Factory.Services.CreateAsyncScope();
            var users = scope.ServiceProvider.GetRequiredService<UserManager<ApplicationUser>>();
            var operatorUser = await users.FindByEmailAsync(email);
            if (operatorUser is not null) await users.DeleteAsync(operatorUser);
        }
    }

    private static string AntiforgeryToken(string html)
    {
        var match = Regex.Match(html, "name=\"__RequestVerificationToken\"[^>]*value=\"([^\"]+)\"");
        Assert.True(match.Success, "Antiforgery token was not rendered.");
        return WebUtility.HtmlDecode(match.Groups[1].Value);
    }
}
