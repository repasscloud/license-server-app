using QuestPDF.Fluent;
using QuestPDF.Infrastructure;

namespace LicenseServer;

internal sealed record InvoiceLineItemDisplay(string Description, string Quantity, string Amount);

internal sealed record InvoiceDocumentData(
    string InvoiceId,
    string InvoiceDate,
    string DueDate,
    string BusinessName,
    string BusinessAddress,
    string BusinessAbn,
    string BusinessEmail,
    string CustomerName,
    string CustomerEmail,
    string BillingAddress,
    string ProductName,
    string EditionName,
    int SeatCount,
    string BillingPeriod,
    IReadOnlyList<InvoiceLineItemDisplay> LineItems,
    string Subtotal,
    string DiscountAmount,
    string TaxLabel,
    string TaxAmount,
    string TotalDue,
    string PaymentMethodLabel);

internal interface IInvoicePdfRenderer
{
    byte[] Render(InvoiceDocumentData data);
}

// Builds the PDF from structured data rather than converting invoice.html, so generation needs
// no headless-browser/Chromium dependency in the container. Layout intentionally mirrors
// invoice.html's sections (header, from/billed-to, line items, totals, payment method) without
// being pixel-identical to it.
internal sealed class InvoicePdfRenderer : IInvoicePdfRenderer
{
    public byte[] Render(InvoiceDocumentData data) =>
        Document.Create(container =>
        {
            container.Page(page =>
            {
                page.Margin(36);
                page.Header().Text($"Invoice {data.InvoiceId}").FontSize(20).Bold();
                page.Content().Column(column =>
                {
                    column.Spacing(8);
                    column.Item().Text($"Issued {data.InvoiceDate} - Due {data.DueDate}");
                    column.Item().Row(row =>
                    {
                        row.RelativeItem().Column(from =>
                        {
                            from.Item().Text("From").SemiBold();
                            from.Item().Text(data.BusinessName);
                            from.Item().Text(data.BusinessAddress);
                            from.Item().Text($"ABN {data.BusinessAbn}");
                            from.Item().Text(data.BusinessEmail);
                        });
                        row.RelativeItem().Column(to =>
                        {
                            to.Item().Text("Billed to").SemiBold();
                            to.Item().Text(data.CustomerName);
                            to.Item().Text(data.CustomerEmail);
                            to.Item().Text(data.BillingAddress);
                        });
                    });
                    column.Item().Text($"{data.ProductName} - {data.EditionName} - {data.SeatCount} seats - {data.BillingPeriod}");
                    column.Item().Table(table =>
                    {
                        table.ColumnsDefinition(columns =>
                        {
                            columns.RelativeColumn(3);
                            columns.RelativeColumn(1);
                            columns.RelativeColumn(1);
                        });
                        table.Header(header =>
                        {
                            header.Cell().Text("Description").SemiBold();
                            header.Cell().Text("Qty").SemiBold();
                            header.Cell().Text("Amount").SemiBold();
                        });
                        foreach (var item in data.LineItems)
                        {
                            table.Cell().Text(item.Description);
                            table.Cell().Text(item.Quantity);
                            table.Cell().Text(item.Amount);
                        }
                    });
                    column.Item().AlignRight().Text($"Subtotal: {data.Subtotal}");
                    // Discounts are per-purchase, not per-line-item, and rare: only shown when
                    // one was actually applied to this invoice, rather than always printing a
                    // zero/blank discount row.
                    if (!string.IsNullOrEmpty(data.DiscountAmount))
                        column.Item().AlignRight().Text($"Discount: {data.DiscountAmount}");
                    column.Item().AlignRight().Text($"{data.TaxLabel}: {data.TaxAmount}");
                    column.Item().AlignRight().Text($"Total due: {data.TotalDue}").Bold();
                    column.Item().Text($"Charged to {data.PaymentMethodLabel}");
                });
            });
        }).GeneratePdf();
}
