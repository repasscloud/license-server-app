using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace LicenseServer.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddLicenseOrderInvoices : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "InvoiceNumberCounters",
                columns: table => new
                {
                    BusinessDate = table.Column<DateOnly>(type: "date", nullable: false),
                    LastValue = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InvoiceNumberCounters", x => x.BusinessDate);
                    table.CheckConstraint("CK_InvoiceNumberCounters_LastValue", "\"LastValue\" BETWEEN 0 AND 16777215");
                });

            migrationBuilder.CreateTable(
                name: "LicenseOrderInvoices",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    LicenseOrderId = table.Column<Guid>(type: "uuid", nullable: false),
                    InvoiceNumber = table.Column<string>(type: "character varying(24)", maxLength: 24, nullable: false),
                    StripePaymentIntentId = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    StripeChargeId = table.Column<string>(type: "character varying(255)", maxLength: 255, nullable: true),
                    Currency = table.Column<string>(type: "character varying(3)", maxLength: 3, nullable: false),
                    SubtotalMinor = table.Column<long>(type: "bigint", nullable: false),
                    DiscountMinor = table.Column<long>(type: "bigint", nullable: false),
                    TaxMinor = table.Column<long>(type: "bigint", nullable: false),
                    TotalMinor = table.Column<long>(type: "bigint", nullable: false),
                    PaymentMethodLabel = table.Column<string>(type: "character varying(100)", maxLength: 100, nullable: true),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_LicenseOrderInvoices", x => x.Id);
                    table.ForeignKey(
                        name: "FK_LicenseOrderInvoices_LicenseOrders_LicenseOrderId",
                        column: x => x.LicenseOrderId,
                        principalTable: "LicenseOrders",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_LicenseOrderInvoices_InvoiceNumber",
                table: "LicenseOrderInvoices",
                column: "InvoiceNumber",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_LicenseOrderInvoices_LicenseOrderId",
                table: "LicenseOrderInvoices",
                column: "LicenseOrderId",
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_LicenseOrderInvoices_StripeChargeId",
                table: "LicenseOrderInvoices",
                column: "StripeChargeId");

            migrationBuilder.CreateIndex(
                name: "IX_LicenseOrderInvoices_StripePaymentIntentId",
                table: "LicenseOrderInvoices",
                column: "StripePaymentIntentId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "InvoiceNumberCounters");

            migrationBuilder.DropTable(
                name: "LicenseOrderInvoices");
        }
    }
}
