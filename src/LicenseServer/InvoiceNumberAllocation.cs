using System.Data;
using System.Globalization;
using LicenseServer.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace LicenseServer;

// Same per-business-date atomic counter pattern as LicenseIdAllocator: only purchases use
// this (renewals reuse the real Stripe invoice number, since a Stripe Invoice exists there).
internal sealed class InvoiceNumberAllocator(
    ApplicationDbContext db,
    ILicenseBusinessDateResolver businessDates)
{
    internal const int MaximumDailyValue = 0xFFFFFF;

    public async Task<string> AllocateAsync(
        DateTimeOffset utcInstant,
        CancellationToken cancellationToken = default)
    {
        var transaction = db.Database.CurrentTransaction
            ?? throw new InvalidOperationException("Invoice numbers must be allocated inside the order-processing transaction.");
        var businessDate = businessDates.Resolve(utcInstant);
        var connection = db.Database.GetDbConnection();
        if (connection.State != ConnectionState.Open)
            await connection.OpenAsync(cancellationToken);

        await using var command = connection.CreateCommand();
        command.Transaction = transaction.GetDbTransaction();
        command.CommandText = """
            INSERT INTO "InvoiceNumberCounters" ("BusinessDate", "LastValue")
            VALUES (@businessDate, 1)
            ON CONFLICT ("BusinessDate") DO UPDATE
            SET "LastValue" = "InvoiceNumberCounters"."LastValue" + 1
            WHERE "InvoiceNumberCounters"."LastValue" < 16777215
            RETURNING "LastValue";
            """;
        var dateParameter = command.CreateParameter();
        dateParameter.ParameterName = "businessDate";
        dateParameter.DbType = DbType.Date;
        dateParameter.Value = businessDate.ToDateTime(TimeOnly.MinValue);
        command.Parameters.Add(dateParameter);

        var result = await command.ExecuteScalarAsync(cancellationToken);
        if (result is null or DBNull)
        {
            throw new InvoiceNumberExhaustedException(
                $"The daily invoice number range for {businessDate:yyyy-MM-dd} is exhausted at 0xFFFFFF.");
        }

        var value = Convert.ToInt32(result, CultureInfo.InvariantCulture);
        return FormattableString.Invariant($"INV-{businessDate:yyyy}-{businessDate:MMdd}{value:X6}");
    }
}

internal sealed class InvoiceNumberExhaustedException(string message) : InvalidOperationException(message);
