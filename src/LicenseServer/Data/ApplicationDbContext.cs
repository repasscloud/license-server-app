using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using System.Text.Json;

namespace LicenseServer.Data;

public sealed class ApplicationDbContext(DbContextOptions<ApplicationDbContext> options)
    : IdentityDbContext<ApplicationUser>(options)
{
    public DbSet<Customer> Customers => Set<Customer>();
    public DbSet<LicenseIdCounter> LicenseIdCounters => Set<LicenseIdCounter>();
    public DbSet<ProductDefinition> ProductDefinitions => Set<ProductDefinition>();
    public DbSet<LicenseRecord> Licenses => Set<LicenseRecord>();
    public DbSet<IssuanceIdempotencyRecord> IssuanceIdempotencyRecords => Set<IssuanceIdempotencyRecord>();
    public DbSet<ApiCredential> ApiCredentials => Set<ApiCredential>();
    public DbSet<DeploymentKey> DeploymentKeys => Set<DeploymentKey>();
    public DbSet<EmailOutboxMessage> EmailOutbox => Set<EmailOutboxMessage>();
    public DbSet<EmailDeliveryEvent> EmailDeliveryEvents => Set<EmailDeliveryEvent>();
    public DbSet<CustomerAccessChallenge> CustomerAccessChallenges => Set<CustomerAccessChallenge>();
    public DbSet<WebhookInbox> WebhookInbox => Set<WebhookInbox>();
    public DbSet<BillingContract> BillingContracts => Set<BillingContract>();
    public DbSet<LicenseOrder> LicenseOrders => Set<LicenseOrder>();
    public DbSet<StripeCustomerMapping> StripeCustomerMappings => Set<StripeCustomerMapping>();
    public DbSet<StripeProductMapping> StripeProductMappings => Set<StripeProductMapping>();
    public DbSet<StripePriceMapping> StripePriceMappings => Set<StripePriceMapping>();
    public DbSet<StripeSubscriptionMapping> StripeSubscriptionMappings => Set<StripeSubscriptionMapping>();
    public DbSet<StripeCheckoutSessionMapping> StripeCheckoutSessionMappings => Set<StripeCheckoutSessionMapping>();
    public DbSet<StripeInvoiceMapping> StripeInvoiceMappings => Set<StripeInvoiceMapping>();
    public DbSet<InvoiceNumberCounter> InvoiceNumberCounters => Set<InvoiceNumberCounter>();
    public DbSet<LicenseOrderInvoice> LicenseOrderInvoices => Set<LicenseOrderInvoice>();
    public DbSet<Entitlement> Entitlements => Set<Entitlement>();
    public DbSet<Activation> Activations => Set<Activation>();
    public DbSet<SigningKeyRecord> SigningKeys => Set<SigningKeyRecord>();
    public DbSet<AuditRecord> AuditRecords => Set<AuditRecord>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        builder.Entity<ApplicationUser>().Property(x => x.MustChangePassword).HasDefaultValue(false);
        builder.Entity<Customer>().HasIndex(x => x.ExternalId).IsUnique();
        builder.Entity<Customer>().HasIndex(x => x.NormalizedEmail);
        builder.Entity<Customer>().Property(x => x.Name).HasMaxLength(200);
        builder.Entity<Customer>().Property(x => x.Email).HasMaxLength(CustomerEmails.MaximumLength);
        builder.Entity<Customer>().Property(x => x.NormalizedEmail).HasMaxLength(CustomerEmails.MaximumLength);
        builder.Entity<LicenseIdCounter>().HasKey(x => x.BusinessDate);
        builder.Entity<LicenseIdCounter>().ToTable(table => table.HasCheckConstraint(
            "CK_LicenseIdCounters_LastValue",
            "\"LastValue\" BETWEEN 0 AND 16777215"));
        builder.Entity<ProductDefinition>().HasIndex(x => x.Code).IsUnique();
        builder.Entity<ProductDefinition>().Property(x => x.Code).HasMaxLength(100);
        builder.Entity<ProductDefinition>().Property(x => x.DisplayName).HasMaxLength(200);
        builder.Entity<ProductDefinition>().Property(x => x.Description).HasMaxLength(2000);
        builder.Entity<ProductDefinition>().ToTable(table => table.HasCheckConstraint(
            "CK_ProductDefinitions_Code",
            "\"Code\" ~ '^[a-z0-9][a-z0-9-]{0,99}$'"));
        builder.Entity<LicenseRecord>().HasIndex(x => x.LicenseId).IsUnique();
        builder.Entity<LicenseRecord>().Property(x => x.LicenseId).HasMaxLength(19);
        builder.Entity<LicenseRecord>().Property(x => x.MetadataJson).HasColumnType("jsonb");
        builder.Entity<LicenseRecord>().Property(x => x.ActivationCodeHashVersion).HasMaxLength(32)
            .HasDefaultValue(ActivationCodeHasher.LegacySha256Version);
        builder.Entity<LicenseRecord>().Property(x => x.Version).IsConcurrencyToken();
        builder.Entity<LicenseRecord>().Property(x => x.RevocationReason).HasMaxLength(500);
        builder.Entity<LicenseRecord>().Property(x => x.CancellationReason).HasMaxLength(500);
        builder.Entity<LicenseRecord>().Property(x => x.RevokedBy).HasMaxLength(256);
        builder.Entity<LicenseRecord>().Property(x => x.CancelledBy).HasMaxLength(256);
        builder.Entity<LicenseRecord>().Property(x => x.CancellationReference).HasMaxLength(200);
        builder.Entity<LicenseRecord>().HasIndex(x => x.ExpiresAt);
        builder.Entity<LicenseRecord>().Property(x => x.ExpirySubMicrosecondTicks).HasDefaultValue(0);
        builder.Entity<LicenseRecord>().HasIndex(x => x.CancelledAt);
        builder.Entity<LicenseRecord>().HasIndex(x => x.RevokedAt);
        builder.Entity<LicenseRecord>().ToTable(table => table.HasCheckConstraint(
            "CK_Licenses_TerminalState",
            "NOT (\"CancelledAt\" IS NOT NULL AND \"RevokedAt\" IS NOT NULL)"));
        builder.Entity<LicenseRecord>().ToTable(table => table.HasCheckConstraint(
            "CK_Licenses_ExpiryPrecision",
            "\"ExpirySubMicrosecondTicks\" BETWEEN 0 AND 9"));
        builder.Entity<LicenseRecord>().ToTable(table => table.HasCheckConstraint(
            "CK_Licenses_ContactEmail",
            "COALESCE(jsonb_typeof(\"MetadataJson\" -> 'contactEmail') = 'string' " +
            "AND (\"MetadataJson\" ->> 'contactEmail') = lower(btrim(\"MetadataJson\" ->> 'contactEmail')) " +
            "AND (\"MetadataJson\" ->> 'contactEmail') ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$', FALSE)"));
        builder.Entity<LicenseRecord>().Property(x => x.Provenance).HasMaxLength(20).HasDefaultValue(LicenseProvenance.Issued);
        builder.Entity<LicenseRecord>().Property(x => x.ImportedBy).HasMaxLength(256);
        builder.Entity<LicenseRecord>().ToTable(table => table.HasCheckConstraint(
            "CK_Licenses_Provenance", "\"Provenance\" IN ('issued', 'imported')"));
        // Every Imported* column is populated together or not at all, and exactly tracks Provenance -
        // an "imported" row with no stored artifact (or an "issued" row with one, even partially)
        // would mean the provenance label and the data backing it have drifted apart. Written as
        // two explicit branches rather than a single biconditional on the conjunction: the
        // biconditional form only ties the *conjunction* to Provenance = 'imported', which would
        // still accept an "issued" row with, say, three of the four Imported* columns set and one
        // left null - each branch below independently requires all four or none.
        builder.Entity<LicenseRecord>().ToTable(table => table.HasCheckConstraint(
            "CK_Licenses_ImportProvenance",
            "(\"Provenance\" = 'imported' " +
            "AND \"ImportedSignedEnvelope\" IS NOT NULL AND \"ImportedSignedEnvelopeSha256\" IS NOT NULL " +
            "AND \"ImportedAt\" IS NOT NULL AND \"ImportedBy\" IS NOT NULL) " +
            "OR (\"Provenance\" != 'imported' " +
            "AND \"ImportedSignedEnvelope\" IS NULL AND \"ImportedSignedEnvelopeSha256\" IS NULL " +
            "AND \"ImportedAt\" IS NULL AND \"ImportedBy\" IS NULL)"));
        builder.Entity<LicenseRecord>().HasMany(x => x.Entitlements).WithOne(x => x.License).HasForeignKey(x => x.LicenseRecordId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<LicenseRecord>().HasMany(x => x.Activations).WithOne(x => x.License).HasForeignKey(x => x.LicenseRecordId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<IssuanceIdempotencyRecord>().Property(x => x.PrincipalId).HasMaxLength(256);
        builder.Entity<IssuanceIdempotencyRecord>().Property(x => x.ProtectedResult).HasColumnType("text");
        builder.Entity<IssuanceIdempotencyRecord>().HasIndex(x => new { x.PrincipalId, x.KeyHash }).IsUnique();
        builder.Entity<IssuanceIdempotencyRecord>().HasIndex(x => x.ExpiresAt);
        builder.Entity<ApiCredential>().HasIndex(x => x.PublicId).IsUnique();
        builder.Entity<ApiCredential>().HasIndex(x => x.OwnerUserId);
        builder.Entity<ApiCredential>().HasIndex(x => x.ExpiresAt);
        builder.Entity<ApiCredential>().Property(x => x.PublicId).HasMaxLength(32);
        builder.Entity<ApiCredential>().Property(x => x.Name).HasMaxLength(200);
        builder.Entity<ApiCredential>().Property(x => x.HashVersion).HasMaxLength(32);
        builder.Entity<ApiCredential>().Property(x => x.LastFour).HasMaxLength(4);
        builder.Entity<ApiCredential>().Property(x => x.RevokedBy).HasMaxLength(256);
        builder.Entity<ApiCredential>().Property(x => x.ScopesJson).HasColumnType("jsonb");
        builder.Entity<ApiCredential>().HasOne(x => x.OwnerUser).WithMany()
            .HasForeignKey(x => x.OwnerUserId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<ApiCredential>().ToTable(table => table.HasCheckConstraint(
            "CK_ApiCredentials_Lifecycle", "\"ExpiresAt\" IS NULL OR \"ExpiresAt\" > \"CreatedAt\""));
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
        builder.Entity<EmailOutboxMessage>().ToTable("EmailOutbox");
        builder.Entity<EmailOutboxMessage>().HasIndex(item => item.IdempotencyHash).IsUnique();
        builder.Entity<EmailOutboxMessage>().HasIndex(item => new { item.Status, item.NextAttemptAt });
        builder.Entity<EmailOutboxMessage>().HasIndex(item => item.ProviderMessageId);
        builder.Entity<EmailOutboxMessage>().HasIndex(item => item.RetainUntil);
        builder.Entity<EmailOutboxMessage>().Property(item => item.TemplateName).HasMaxLength(100);
        builder.Entity<EmailOutboxMessage>().Property(item => item.RecipientHash).HasMaxLength(64);
        builder.Entity<EmailOutboxMessage>().Property(item => item.Status).HasMaxLength(20);
        builder.Entity<EmailOutboxMessage>().Property(item => item.ProviderMessageId).HasMaxLength(256);
        builder.Entity<EmailOutboxMessage>().Property(item => item.LastErrorCode).HasMaxLength(100);
        builder.Entity<EmailOutboxMessage>().ToTable("EmailOutbox", table => table.HasCheckConstraint(
            "CK_EmailOutbox_Status", "\"Status\" IN ('pending','leased','retry','sent','delivered','bounced','complained','failed','uncertain')"));
        builder.Entity<EmailDeliveryEvent>().HasIndex(item => item.ProviderEventId).IsUnique();
        builder.Entity<EmailDeliveryEvent>().HasIndex(item => item.ProviderMessageId);
        builder.Entity<EmailDeliveryEvent>().Property(item => item.ProviderEventId).HasMaxLength(256);
        builder.Entity<EmailDeliveryEvent>().Property(item => item.ProviderMessageId).HasMaxLength(256);
        builder.Entity<EmailDeliveryEvent>().Property(item => item.EventType).HasMaxLength(100);
        builder.Entity<CustomerAccessChallenge>().HasIndex(item => item.TokenHash).IsUnique();
        builder.Entity<CustomerAccessChallenge>().HasIndex(item => new { item.IdentifierHash, item.CreatedAt });
        builder.Entity<CustomerAccessChallenge>().HasIndex(item => new { item.RemoteAddressHash, item.CreatedAt });
        builder.Entity<CustomerAccessChallenge>().HasIndex(item => item.ExpiresAt);
        builder.Entity<CustomerAccessChallenge>().HasOne(item => item.Customer).WithMany()
            .HasForeignKey(item => item.CustomerId).OnDelete(DeleteBehavior.Cascade);
        builder.Entity<WebhookInbox>().ToTable("WebhookInbox", table => table.HasCheckConstraint(
            "CK_WebhookInbox_Status", "\"Status\" IN ('pending','leased','retry','categorized','completed','ignored','quarantined','dead_letter')"));
        builder.Entity<WebhookInbox>().HasIndex(item => item.ProviderEventId).IsUnique();
        builder.Entity<WebhookInbox>().HasIndex(item => new { item.Status, item.NextAttemptAt });
        builder.Entity<WebhookInbox>().HasIndex(item => item.ProviderCreatedAt);
        builder.Entity<WebhookInbox>().Property(item => item.Provider).HasMaxLength(32);
        builder.Entity<WebhookInbox>().Property(item => item.ProviderEventId).HasMaxLength(255);
        builder.Entity<WebhookInbox>().Property(item => item.EventType).HasMaxLength(150);
        builder.Entity<WebhookInbox>().Property(item => item.Category).HasMaxLength(50);
        builder.Entity<WebhookInbox>().Property(item => item.ProviderObjectId).HasMaxLength(255);
        builder.Entity<WebhookInbox>().Property(item => item.LastErrorCode).HasMaxLength(100);
        builder.Entity<BillingContract>().Property(item => item.Status).HasMaxLength(40);
        builder.Entity<BillingContract>().Property(item => item.LicenseType).HasMaxLength(30);
        builder.Entity<BillingContract>().Property(item => item.Edition).HasMaxLength(100);
        builder.Entity<BillingContract>().Property(item => item.Version).IsConcurrencyToken();
        builder.Entity<BillingContract>().HasOne(item => item.Customer).WithMany()
            .HasForeignKey(item => item.CustomerId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<BillingContract>().HasOne(item => item.ProductDefinition).WithMany()
            .HasForeignKey(item => item.ProductDefinitionId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<BillingContract>().HasOne(item => item.License).WithMany()
            .HasForeignKey(item => item.LicenseRecordId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<LicenseOrder>().Property(item => item.Kind).HasMaxLength(40);
        builder.Entity<LicenseOrder>().Property(item => item.Status).HasMaxLength(40);
        builder.Entity<LicenseOrder>().HasOne(item => item.BillingContract).WithMany()
            .HasForeignKey(item => item.BillingContractId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<LicenseOrder>().HasOne(item => item.Customer).WithMany()
            .HasForeignKey(item => item.CustomerId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<LicenseOrder>().HasOne(item => item.ProductDefinition).WithMany()
            .HasForeignKey(item => item.ProductDefinitionId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<LicenseOrder>().HasOne(item => item.License).WithMany()
            .HasForeignKey(item => item.LicenseRecordId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<StripeCustomerMapping>().HasIndex(item => item.StripeCustomerId).IsUnique();
        builder.Entity<StripeCustomerMapping>().HasIndex(item => item.CustomerId).IsUnique();
        builder.Entity<StripeCustomerMapping>().Property(item => item.StripeCustomerId).HasMaxLength(255);
        builder.Entity<StripeCustomerMapping>().HasOne(item => item.Customer).WithMany()
            .HasForeignKey(item => item.CustomerId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<StripeProductMapping>().HasIndex(item => item.StripeProductId).IsUnique();
        builder.Entity<StripeProductMapping>().Property(item => item.StripeProductId).HasMaxLength(255);
        builder.Entity<StripeProductMapping>().Property(item => item.Edition).HasMaxLength(100);
        builder.Entity<StripeProductMapping>().Property(item => item.LicenseType).HasMaxLength(30);
        builder.Entity<StripeProductMapping>().HasOne(item => item.ProductDefinition).WithMany()
            .HasForeignKey(item => item.ProductDefinitionId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<StripePriceMapping>().HasIndex(item => item.StripePriceId).IsUnique();
        builder.Entity<StripePriceMapping>().Property(item => item.StripePriceId).HasMaxLength(255);
        builder.Entity<StripePriceMapping>().Property(item => item.Edition).HasMaxLength(100);
        builder.Entity<StripePriceMapping>().Property(item => item.LicenseType).HasMaxLength(30);
        builder.Entity<StripePriceMapping>().HasOne(item => item.ProductDefinition).WithMany()
            .HasForeignKey(item => item.ProductDefinitionId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<StripeSubscriptionMapping>().HasIndex(item => item.StripeSubscriptionId).IsUnique();
        builder.Entity<StripeSubscriptionMapping>().HasIndex(item => item.BillingContractId).IsUnique();
        builder.Entity<StripeSubscriptionMapping>().Property(item => item.StripeSubscriptionId).HasMaxLength(255);
        builder.Entity<StripeSubscriptionMapping>().HasOne(item => item.BillingContract).WithMany()
            .HasForeignKey(item => item.BillingContractId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<StripeCheckoutSessionMapping>().HasIndex(item => item.StripeCheckoutSessionId).IsUnique();
        builder.Entity<StripeCheckoutSessionMapping>().HasIndex(item => item.LicenseOrderId).IsUnique();
        builder.Entity<StripeCheckoutSessionMapping>().Property(item => item.StripeCheckoutSessionId).HasMaxLength(255);
        builder.Entity<StripeCheckoutSessionMapping>().HasOne(item => item.LicenseOrder).WithMany()
            .HasForeignKey(item => item.LicenseOrderId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<StripeInvoiceMapping>().HasIndex(item => item.StripeInvoiceId).IsUnique();
        builder.Entity<StripeInvoiceMapping>().HasIndex(item => item.AppliedEventId).IsUnique();
        builder.Entity<StripeInvoiceMapping>().Property(item => item.StripeInvoiceId).HasMaxLength(255);
        builder.Entity<StripeInvoiceMapping>().Property(item => item.AppliedEventId).HasMaxLength(255);
        builder.Entity<StripeInvoiceMapping>().HasOne(item => item.LicenseOrder).WithMany()
            .HasForeignKey(item => item.LicenseOrderId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<StripeInvoiceMapping>().HasOne(item => item.BillingContract).WithMany()
            .HasForeignKey(item => item.BillingContractId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<InvoiceNumberCounter>().HasKey(x => x.BusinessDate);
        builder.Entity<InvoiceNumberCounter>().ToTable(table => table.HasCheckConstraint(
            "CK_InvoiceNumberCounters_LastValue",
            "\"LastValue\" BETWEEN 0 AND 16777215"));
        builder.Entity<LicenseOrderInvoice>().HasIndex(item => item.LicenseOrderId).IsUnique();
        builder.Entity<LicenseOrderInvoice>().HasIndex(item => item.InvoiceNumber).IsUnique();
        builder.Entity<LicenseOrderInvoice>().HasIndex(item => item.StripePaymentIntentId);
        builder.Entity<LicenseOrderInvoice>().HasIndex(item => item.StripeChargeId);
        builder.Entity<LicenseOrderInvoice>().Property(item => item.InvoiceNumber).HasMaxLength(24);
        builder.Entity<LicenseOrderInvoice>().Property(item => item.StripePaymentIntentId).HasMaxLength(255);
        builder.Entity<LicenseOrderInvoice>().Property(item => item.StripeChargeId).HasMaxLength(255);
        builder.Entity<LicenseOrderInvoice>().Property(item => item.Currency).HasMaxLength(3);
        builder.Entity<LicenseOrderInvoice>().Property(item => item.PaymentMethodLabel).HasMaxLength(100);
        builder.Entity<LicenseOrderInvoice>().HasOne(item => item.LicenseOrder).WithOne()
            .HasForeignKey<LicenseOrderInvoice>(item => item.LicenseOrderId).OnDelete(DeleteBehavior.Restrict);
        // Not (LicenseRecordId) alone: a multi-product imported license legitimately has one
        // Entitlement per product on the same LicenseRecord (see "License import" in
        // docs/superpowers/specs/2026-08-14-key-ring-signing-design.md). The composite still
        // blocks two entitlements for the same product on one license, matching the in-artifact
        // duplicate-product check LicenseSchema.Parse already performs.
        builder.Entity<Entitlement>().HasIndex(x => new { x.LicenseRecordId, x.Product }).IsUnique();
        builder.Entity<Entitlement>().HasOne(x => x.ProductDefinition).WithMany(x => x.Entitlements)
            .HasForeignKey(x => x.ProductDefinitionId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<Entitlement>().ToTable(table =>
        {
            table.HasCheckConstraint("CK_Entitlements_LicenseType", "\"LicenseType\" IN ('perpetual', 'subscription', 'evaluation')");
            table.HasCheckConstraint("CK_Entitlements_Edition", "\"Edition\" IN ('community', 'project', 'education', 'consumer', 'business', 'smb', 'enterprise', 'corporate')");
            table.HasCheckConstraint("CK_Entitlements_Seats", "\"Seats\" > 0");
        });
        builder.Entity<Activation>().HasIndex(x => x.ActivationId).IsUnique();
        builder.Entity<Activation>().HasIndex(x => new { x.LicenseRecordId, x.RequestId }).IsUnique();
        builder.Entity<Activation>().HasIndex(x => new { x.LicenseRecordId, x.DeviceIdHash }).IsUnique()
            .HasFilter("\"DeactivatedAt\" IS NULL");
        builder.Entity<Activation>().HasIndex(x => new { x.LicenseRecordId, x.DeactivatedAt });
        builder.Entity<Activation>().HasIndex(x => x.LeaseExpiresAt);
        builder.Entity<Activation>().HasIndex(x => x.DeploymentKeyId);
        builder.Entity<Activation>().HasOne(x => x.DeploymentKey).WithMany()
            .HasForeignKey(x => x.DeploymentKeyId).OnDelete(DeleteBehavior.Restrict);
        builder.Entity<SigningKeyRecord>().HasIndex(x => x.KeyId).IsUnique();
        builder.Entity<SigningKeyRecord>().HasIndex(x => x.IsDefault).IsUnique().HasFilter("\"IsDefault\"");
        builder.Entity<AuditRecord>().HasIndex(x => x.TimestampUtc);
        builder.Entity<AuditRecord>().Property(x => x.Actor).HasMaxLength(256);
        builder.Entity<AuditRecord>().Property(x => x.Action).HasMaxLength(100);
        builder.Entity<ApplicationUser>().Property(x => x.AccountType).HasMaxLength(20)
            .HasDefaultValue(ApplicationUser.HumanAccountType);
        builder.Entity<ApplicationUser>().Property(x => x.IsEnabled).HasDefaultValue(true);
        builder.Entity<ApplicationUser>().Property(x => x.DisabledBy).HasMaxLength(256);
        builder.Entity<ApplicationUser>().HasIndex(x => new { x.AccountType, x.IsEnabled });
        builder.Entity<ApplicationUser>().ToTable(table => table.HasCheckConstraint(
            "CK_AspNetUsers_AccountType", "\"AccountType\" IN ('human', 'service')"));
    }

    public override int SaveChanges(bool acceptAllChangesOnSuccess)
    {
        GuardImmutableAudit();
        GuardImmutableLicenseIds();
        GuardImmutableProductCodes();
        GuardCustomerContactSnapshots();
        NormalizeExpiryPrecision();
        TouchVersions();
        return base.SaveChanges(acceptAllChangesOnSuccess);
    }

    public override Task<int> SaveChangesAsync(bool acceptAllChangesOnSuccess, CancellationToken cancellationToken = default)
    {
        GuardImmutableAudit();
        GuardImmutableLicenseIds();
        GuardImmutableProductCodes();
        GuardCustomerContactSnapshots();
        NormalizeExpiryPrecision();
        TouchVersions();
        return base.SaveChangesAsync(acceptAllChangesOnSuccess, cancellationToken);
    }

    private void GuardImmutableAudit()
    {
        if (ChangeTracker.Entries<AuditRecord>().Any(x => x.State is EntityState.Modified or EntityState.Deleted))
            throw new InvalidOperationException("Audit records are immutable.");
    }

    private void GuardImmutableLicenseIds()
    {
        if (ChangeTracker.Entries<LicenseRecord>().Any(entry =>
                entry.State == EntityState.Modified
                && entry.Property(x => x.LicenseId).IsModified
                && !string.Equals(
                    entry.Property(x => x.LicenseId).OriginalValue,
                    entry.Property(x => x.LicenseId).CurrentValue,
                    StringComparison.Ordinal)))
        {
            throw new InvalidOperationException("LicenseId is immutable after insertion.");
        }
    }

    private void TouchVersions()
    {
        foreach (var entry in ChangeTracker.Entries<LicenseRecord>().Where(x => x.State == EntityState.Modified))
            entry.Entity.Version++;
    }

    private void GuardCustomerContactSnapshots()
    {
        foreach (var entry in ChangeTracker.Entries<Customer>().Where(entry => entry.State is EntityState.Added or EntityState.Modified))
        {
            if (!CustomerEmails.TryNormalize(entry.Entity.Email, out var normalized, out var error)
                || !string.Equals(entry.Entity.NormalizedEmail, normalized, StringComparison.Ordinal))
            {
                throw new InvalidOperationException(error ?? "Customer normalized email must match the current email.");
            }
        }

        foreach (var entry in ChangeTracker.Entries<LicenseRecord>())
        {
            if (entry.State == EntityState.Modified && entry.Property(item => item.MetadataJson).IsModified)
                throw new InvalidOperationException("Signed contact metadata is an immutable issuance snapshot.");
            if (entry.State != EntityState.Added)
                continue;

            string? contactEmail;
            try
            {
                using var document = JsonDocument.Parse(entry.Entity.MetadataJson);
                contactEmail = document.RootElement.ValueKind == JsonValueKind.Object
                    && document.RootElement.TryGetProperty("contactEmail", out var value)
                    && value.ValueKind == JsonValueKind.String
                    ? value.GetString()
                    : null;
            }
            catch (JsonException)
            {
                contactEmail = null;
            }

            if (!CustomerEmails.TryNormalize(contactEmail, out var normalized, out _)
                || !string.Equals(entry.Entity.Customer.NormalizedEmail, normalized, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("License metadata.contactEmail must equal the normalized customer email at issuance.");
            }
        }
    }

    private void GuardImmutableProductCodes()
    {
        if (ChangeTracker.Entries<ProductDefinition>().Any(entry =>
                entry.State == EntityState.Modified
                && entry.Property(item => item.Code).IsModified
                && !string.Equals(
                    entry.Property(item => item.Code).OriginalValue,
                    entry.Property(item => item.Code).CurrentValue,
                    StringComparison.Ordinal)))
        {
            throw new InvalidOperationException("Product code is immutable after creation.");
        }
    }

    private void NormalizeExpiryPrecision()
    {
        foreach (var entry in ChangeTracker.Entries<LicenseRecord>()
                     .Where(x => x.Entity.ExpiresAt is not null
                         && (x.State == EntityState.Added || x.Property(y => y.ExpiresAt).IsModified)))
        {
            var utc = entry.Entity.ExpiresAt!.Value.ToUniversalTime();
            entry.Entity.ExpirySubMicrosecondTicks = (int)(utc.Ticks % 10);
            entry.Entity.ExpiresAt = new DateTimeOffset(utc.Ticks - utc.Ticks % 10, TimeSpan.Zero);
        }
    }
}
