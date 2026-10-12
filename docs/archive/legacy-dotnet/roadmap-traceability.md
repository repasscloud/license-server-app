# Roadmap acceptance traceability

Status: complete on `codex/prompts-14-16` as of 2026-08-14.

This matrix maps every acceptance item in `docs/README.md` to production behavior and
automated evidence. Test names are in `tests/LicenseServer.Tests` unless a script is
named explicitly.

| Acceptance item | Production implementation | Automated evidence |
| --- | --- | --- |
| Server-only immutable license ID | `LicenseStore`, `LicenseIdAllocator`, `ApplicationDbContext.GuardImmutableLicenseIds` | `CallerSuppliedLicenseIdIsIgnoredAndPersistedIdIsImmutable` |
| 1,000 concurrent unique monotonic IDs | PostgreSQL atomic counter upsert and unique license index | `OneThousandConcurrentIssuesAllocateUniqueMonotonicLicenseIds` |
| Safe generated activation-code shape | `ActivationCodeGenerator` | `GeneratorProducesDistinctCodesWithTheExactShapeAndAlphabet` |
| Activation code revealed once and absent later | `LicenseStore`, protected issuance idempotency result, safe DTOs | `ActivationCodeUsesSafeAlphabetIsRevealedOnceAndLeavesNoPlaintextTrace`; `SamePrincipalAndIdempotencyKeyReturnsEncryptedRetryResultWithoutDuplicateIssuance` |
| Product/edition forgery rejected | `ProductCatalogService`, `LicenseEditions`, `LicenseStore` | `ForgedProductEditionAndLicenseTypeValuesAreRejected`; `ArchivedProductRemainsReadableButCannotIssue` |
| Exactly one entitlement | unique entitlement index and `LicenseStore` issuance | `PortalOrApiIssuanceCreatesExactlyOneEntitlement` |
| Subscription/evaluation future expiry | `LicenseTerms.TryCanonicalizeIssuanceExpiry` | `TimeLimitedIssuanceRequiresFutureExpiry` |
| Perpetual canonical expiry and Never display | `LicenseTerms.PerpetualExpiry`, customer/UI projections | `PerpetualIssuanceUsesCanonicalExpiry`; `PortalProjectionRedactsSecretsAndFullDeviceIdentifiers` |
| Signed expiry equals server expiry | `LicenseStore.CreateLicenseAsync` | `SignedEntitlementExpiryExactlyMatchesServerExpiry` |
| Mandatory email for UI/API/Stripe | `CustomerEmails`, both `LicenseStore` issuance paths | `IssuanceRequiresNormalizedCustomerEmailAndAuthoritativeContactMetadata`; `CompletedPurchaseIssuesExactlyOneMappedLicenseAndEncryptedEmail` |
| Authoritative immutable `metadata.contactEmail` | `GuardCustomerContactSnapshots`, PostgreSQL JSONB constraint | `CustomerEmailAndJsonbContactMetadataAreDatabaseInvariants`; `CurrentCustomerEmailCanChangeWithoutRewritingTheSignedSnapshot` |
| Seeded license email invariant | `DatabaseInitializer.SeedDemoDataAsync` | `CleanMigrationAndDefaultAdminSeedAreIdempotent` |
| Case-insensitive email search | normalized customer column and `AdminDataService` | `LicenseSearchUsesNormalizedCustomerEmailCaseInsensitively` |
| Postable lifecycle confirmation | Blazor forms plus server confirmation checks | `RevocationRequiresPostedConfirmation`; `OperatorDeactivationRequiresPostedConfirmation` |
| Pre-activation cancellation is terminal | `LicenseStore.CancelAsync` | `NeverActivatedLicenseCanBeCancelledAndCannotActivateAfterward` |
| Activation history requires revoke | `LicenseStore.CancelAsync` | `LicenseWithActivationHistoryCannotBeCancelledAndRequiresRevocation` |
| Past expiry blocks online operations | `LicenseStore.AmendTermsAsync`, lifecycle checks | `AuthorizedExpiryAmendmentMayMoveIntoPastAndImmediatelyInvalidatesOnlineChecks` |
| Revocation idempotency and visibility | `LicenseStore.RevokeAsync` | `SuccessfulRevocationIsImmediatelyVisibleOnReloadAndCannotRepeatMutation` |
| Action-level lifecycle authorization | permission policies and `PermissionGuard` | `LifecycleMutationsAreDeniedWithoutTheirSpecificPermission` |
| Mutation audit with correlation | `LicenseStore` and correlation middleware | `CorrelationAndProblemContractsAreConsistent`; lifecycle/issuance contract tests |
| Offline limitation visible and tested | license details, OpenAPI, verifier boundary | `LifecyclePageHasPostableConfirmationAndExplainsOfflineLimitation`; `OnlineInvalidationIsImmediateWhileIssuedOfflineArtifactRemainsCryptographicallyValid` |
| One-time scoped API credentials | `ApiCredentialService`, bearer handler | all `ApiCredentialTests` |
| Correct 401/403 scope behavior | composite authentication and permission policies | `BearerAuthenticationUsesExistingPermissionPoliciesWithCorrect401And403` |
| Cookie antiforgery, bearer explicit header | endpoint validation and bearer `amr` claim | `CookieLifecycleMutationRequiresAntiforgery`; `BearerMutationDoesNotRequireCookieAntiforgeryAndAuditLogsRemainRedacted` |
| Built-in role matrix | `BuiltInRoles`, seeded role claims | `EveryBuiltInRoleReceivesExactlyItsAllowedPermissionMatrixOverHttp` |
| Disabled users lose sessions/keys | security stamp and `IOwnedCredentialRevoker` | `DisablingUserChangesSecurityStampAndWritesRedactedAudit`; `HumanOwnedKeysRequireExpiryAndOwnerDisableRevokesAllCredentials` |
| Final System Administrator protected | PostgreSQL advisory lock in user administration | `ConcurrentFinalAdministratorMutationsLeaveOneEnabledAdministrator` |
| Durable redacted email outbox | `TransactionalEmailSender`, `EmailOutboxProcessor` | all `TransactionalEmailTests` |
| Customer magic links safe and scoped | `CustomerAccessService`, separate cookie | all `CustomerPortalTests` |
| Stripe raw-body signature verification | `StripeWebhookReceiver`, Stripe.net `EventUtility` | `InvalidSignatureAndMalformedSignedPayloadHaveNoSideEffects` |
| Stripe duplicate/reordered idempotency | unique inbox/mappings, leases, monotonic policy | all `StripeWebhookTests`; `RenewalIsMonotonicAndSameInvoiceAcrossEventsIsIdempotent` |
| Configured payment grace | `StripeBillingPolicyProcessor`, `BillingPolicyOptions` | `PaymentFailureUsesGraceAndRecoveryClearsItWithoutRevocation` |
| UI/API shared services and policies | pages/routes inject the same domain services | `RouteInventoryUsesBoundedDtosAndActionPermissions`; `PagesAndEndpointsUseActionLevelPermissions` |
| Clean migration, restart, repeat seed | `DatabaseInitializer` advisory lock and forward migrations | `CleanMigrationAndDefaultAdminSeedAreIdempotent`; `Test-DatabaseAndAuth.ps1` |
| Signing/validator and online/offline flow | `Licensing.Core`, generator, validator, server | `Test-LicenseFlow.ps1`; `Test-ActivationFlow.ps1`; `LicensingFlowTests` |

## Migration decision

The repository retains its forward migration chain through `StripeBilling`. No
re-baseline was necessary: the chain supports both clean PostgreSQL creation and an
upgrade from the prior `PasswordlessCustomerAccess` model. The isolated database suite
creates a fresh PostgreSQL 18 database for every run and initializes/seeds twice to
prove repeatability.
