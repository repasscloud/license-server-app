using System.Data;
using LicenseServer.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace LicenseServer.Tests;

[Collection(PostgresTestSuite.Name)]
public sealed class InvoiceNumberAllocationTests(PostgresWebFixture fixture)
{
    [Fact]
    public async Task AllocateAsyncProducesTheDocumentedFormatAndIncrementsPerBusinessDate()
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var allocator = scope.ServiceProvider.GetRequiredService<InvoiceNumberAllocator>();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var resolver = scope.ServiceProvider.GetRequiredService<ILicenseBusinessDateResolver>();
        var now = DateTimeOffset.UtcNow;
        var date = resolver.Resolve(now);

        string first;
        string second;
        await using (await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted))
        {
            first = await allocator.AllocateAsync(now);
            second = await allocator.AllocateAsync(now);
            await db.Database.CommitTransactionAsync();
        }

        Assert.Matches($@"^INV-{date:yyyy}-{date:MMdd}[0-9A-F]{{6}}$", first);
        Assert.NotEqual(first, second);
    }

    [Fact]
    public async Task RolledBackAllocationDoesNotConsumeAValue()
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
        var allocator = scope.ServiceProvider.GetRequiredService<InvoiceNumberAllocator>();
        var resolver = scope.ServiceProvider.GetRequiredService<ILicenseBusinessDateResolver>();
        var now = DateTimeOffset.UtcNow;
        var date = resolver.Resolve(now);
        var before = await db.InvoiceNumberCounters.AsNoTracking()
            .Where(item => item.BusinessDate == date)
            .Select(item => (int?)item.LastValue)
            .SingleOrDefaultAsync();

        string rolledBackNumber;
        await using (var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted))
        {
            rolledBackNumber = await allocator.AllocateAsync(now);
            await transaction.RollbackAsync();
        }

        db.ChangeTracker.Clear();
        var after = await db.InvoiceNumberCounters.AsNoTracking()
            .Where(item => item.BusinessDate == date)
            .Select(item => (int?)item.LastValue)
            .SingleOrDefaultAsync();
        Assert.Equal(before, after);

        string reusedNumber;
        await using (await db.Database.BeginTransactionAsync(IsolationLevel.ReadCommitted))
        {
            reusedNumber = await allocator.AllocateAsync(now);
            await db.Database.CommitTransactionAsync();
        }

        Assert.Equal(rolledBackNumber, reusedNumber);
    }

    [Fact]
    public async Task AllocateAsyncThrowsWhenNoTransactionIsActive()
    {
        await using var scope = fixture.Factory.Services.CreateAsyncScope();
        var allocator = scope.ServiceProvider.GetRequiredService<InvoiceNumberAllocator>();

        await Assert.ThrowsAsync<InvalidOperationException>(() => allocator.AllocateAsync(DateTimeOffset.UtcNow));
    }
}
