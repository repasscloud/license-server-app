# Software Licensing — Architecture and Implementation Specification

> Source of truth for licensing across RePassCloud applications and the
> future shared licensing server. §1–§14 are the specification as
> supplied, except that Ed25519-only wording ("Ed25519 signature",
> "Ed25519 signing keys", ...) has been generalised to point at §15.
> §15 records the subsequent signature-algorithm decision: Ed25519
> remains the default, alongside ECDSA-P256-SHA256 and ML-DSA-65, with
> one algorithm per keypair. How CurseDelete implements this is in
> [ADR-0010](adr/0010-licensing-v2.md), the user-facing behaviour is in
> [LICENSING.md](LICENSING.md), and the application↔server contract and
> server implementation brief are in
> [LICENSING-SERVER-BRIEF.md](LICENSING-SERVER-BRIEF.md).

## PURPOSE

This document defines the licensing architecture for all software applications developed within our ecosystem.

There are four software editions:

- Community
- Education
- Business
- Enterprise

The architecture must support multiple applications, multiple concurrently maintained major versions, application-specific licensing policies, centrally managed signing keys, Stripe integration, and a shared licensing server.

Claude is responsible for implementing both the application-side licensing integration and, separately, the replacement licensing server.

IMPORTANT — CURRENT IMPLEMENTATION SCOPE:

We are currently working inside an APPLICATION repository.

The immediate objective is to prepare this application for integration with the future licensing server.

The licensing server will be developed separately, in its own repository, later.

DO NOT attempt to build the licensing server inside the current application repository.

DO NOT unnecessarily couple the application's licensing implementation to assumptions about the future server's internal implementation.

The current application should implement the appropriate license models, configuration, validation logic, feature entitlement handling, and integration boundaries.

Where server functionality is not yet available, introduce clean interfaces and appropriate abstractions rather than inventing a temporary licensing server.

Do not implement fake security mechanisms or hardcoded production credentials.

Existing application functionality must remain operational during the transition.

The existing licensing server will eventually be replaced. Its current design should not dictate the architecture of the replacement.

---

# 1. GENERAL LICENSING PRINCIPLES

## 1.1 Editions

Every application supports the following four editions:

1. Community
2. Education
3. Business
4. Enterprise

Each application determines which features are available to each edition.

The licensing server manages licensing entitlements, not the internal business logic of each application.

Applications must not assume that every edition necessarily introduces additional features.

For example:

- Community may contain only basic functionality.
- Education may contain the same features as Business.
- Business may contain additional commercial functionality.
- Enterprise generally enables all application features.

The exact feature mapping is application-specific.

## 1.2 Product and Version Licensing

Every license is specific to:

- A product.
- A product major version.
- An edition.
- A customer or organisation.
- An entitlement type.

Licenses are associated with MAJOR software versions.

Examples:

A perpetual license for Product A v2.x.x permits:

- v2.0.0
- v2.1.0
- v2.3.1
- v2.99.99

It does not automatically permit:

- v1.x.x
- v3.x.x
- v4.x.x

A perpetual license includes all future minor and patch releases within the licensed major version.

A license purchased for v2.0.0 is not restricted to v2.0.0.

Major versions are independent licensing entitlements.

Different major versions may remain actively maintained and distributed simultaneously.

For example:

- Product A v1.x.x
- Product A v2.x.x
- Product A v3.x.x

All three may continue receiving updates independently.

Applications must validate the product identity and licensed major version rather than relying exclusively on cryptographic key compatibility.

## 1.3 Perpetual Licensing

Perpetual means:

- The entitlement does not expire.
- The license remains usable indefinitely for its licensed major version.
- Minor and patch updates within that major version remain included.
- The license does not automatically extend to future major versions.

Perpetual does not mean that all future major versions are included.

Licensing must distinguish between:

- License expiration.
- Subscription expiration.
- Major-version entitlement.
- License revocation.
- Signing-key compatibility.

These are separate concerns.

## 1.4 Licensing Methods

Depending on the edition and application, licenses may be supplied through:

- Signed JSON license files.
- CLI arguments.
- GUI interfaces.
- Installation parameters.
- Application-specific configuration.
- Predefined license file directories.
- Online activation tokens.
- Customer portal downloads.

Applications must support the methods relevant to their deployment model.

For example:

A CLI application may provide:

- A license installation command.
- A license information command.
- An online activation command.
- A renewal command.
- A deactivation command, where applicable.

A desktop application may provide equivalent GUI operations.

An application installer may accept a license file path or activation token.

Applications should not be required to implement irrelevant interfaces.

A CLI-only application does not need a GUI simply to satisfy the licensing architecture.

---

# 2. COMMUNITY EDITION

## 2.1 General Behaviour

Community Edition is:

- Free.
- Perpetual.
- Available without registration.
- Available without purchasing a license.
- Available without contacting the licensing server.
- Available without an internet connection.
- Not subject to device limits.
- Not subject to activation limits.
- Not subject to deactivation limits.

Community Edition must work immediately after installation.

An unregistered Community installation does not require a license file.

The application provides its basic Community functionality automatically.

The features included in Community Edition are determined by the application.

Some applications may provide substantial functionality in Community Edition.

Others may provide only basic functionality.

## 2.2 Optional Community Registration

Users may optionally register their Community installation.

Registration is performed through Stripe using a $0.00 purchase.

Registration associates the product with:

- Customer identity.
- Customer name.
- Email address.
- Product ID.
- Product major version.
- Community Edition entitlement.

The licensing server generates a signed Community license.

Registration does not introduce device tracking.

The registered Community license may be used on multiple devices without activation limits.

Community licenses may be installed offline or obtained online.

## 2.3 Registered Community Benefits

Registered Community users receive:

- Access to the customer portal.
- Access to their customer profile.
- Downloadable license files.
- Email notifications about product updates.
- Product registration associated with their identity.
- Any optional registered Community features supported by the application.

Additional registered Community features are application-specific.

Registration must not be required for basic Community functionality.

## 2.4 Community License Validation

When no license exists:

- Application operates as unregistered Community Edition.

When a valid registered Community license exists:

- Application validates its signature.
- Application validates the product identity.
- Application validates the major version.
- Application recognises the registered Community entitlement.
- Application enables any registered Community features.

If a Community license is missing, invalid, or incompatible:

- Application continues operating using unregistered Community functionality.

Community licensing must not introduce unnecessary online dependencies.

---

# 3. EDUCATION EDITION

## 3.1 General Behaviour

Education Edition is intended for educational institutions.

Education licenses are:

- Organisation-owned.
- Perpetual.
- Volume licenses.
- Capable of completely offline operation.
- Not subject to individual device activation tracking.

Education is paid by default.

Individual applications may offer Education licenses free of charge.

Pricing and eligibility requirements are application-specific.

## 3.2 Ownership

The Education license belongs to the institution.

Ownership information originates from Stripe.

The licensing server associates the license with:

- Stripe customer.
- Organisation name.
- Organisation/business identifier, where available.
- Customer email address.
- Product.
- Major version.
- Education Edition.

The associated email address is used for account access, communications, and license recovery.

The licence is not restricted to the individual who originally completed the purchase.

## 3.3 Volume Licensing

Education uses volume licensing.

A single license can be installed across the institution.

The licensing server does not maintain device installation records.

The application does not need to report which machines use the license.

Education licenses do not consume individual device activation seats.

An application may define specific institutional licensing conditions, but the standard Education licensing model does not require device tracking.

## 3.4 Offline Licensing

Education supports fully offline license installation and verification.

A signed license can be supplied through:

- CLI.
- GUI.
- Installer arguments.
- Application configuration.
- A predefined license directory.

The application validates the signed license locally.

No communication with the licensing server is required.

Education installations may remain offline indefinitely.

There is no recurring online entitlement check.

There is no subscription renewal requirement.

## 3.5 Education Version Entitlement

Education licenses are perpetual.

A v2 Education license supports all compatible v2.x.x releases.

It does not enable v3.x.x.

A newer major version requires an appropriate new entitlement.

## 3.6 Education Features

Education features are application-specific.

An application may provide:

- Additional educational functionality.
- The same features as Business Edition.
- A restricted feature set designed for educational use.
- Features otherwise unavailable in Community Edition.

The application determines feature availability based on the validated Education entitlement.

---

# 4. BUSINESS EDITION

## 4.1 General Behaviour

Business Edition provides commercial licensing.

Business supports:

- Perpetual licenses.
- Subscription licenses.
- Online activation.
- Device activation limits.
- License transfers.
- Customer portal management.
- Application-initiated deactivation.
- Application-specific offline operation.

Business Edition requires online activation initially.

The application must contact the licensing server before establishing a new Business activation.

## 4.2 Device Activation

Business licenses are limited to a configurable number of active installations.

The allowed activation count is defined by the purchased entitlement.

For example:

- Business license with 1 seat.
- Business license with 3 seats.
- Business license with 10 seats.

A successful activation consumes one seat.

The licensing server records the activation.

Each activation should have:

- Unique activation ID.
- License ID.
- Device identifier or suitable device fingerprint.
- Activation timestamp.
- Activation status.
- Last validation timestamp, where applicable.
- Deactivation timestamp, where applicable.

Avoid collecting unnecessary machine information.

The device identifier should be sufficient to distinguish installations without requiring invasive hardware or personal information collection.

## 4.3 Activation Process

The Business activation process is:

1. Customer supplies license credentials or an activation token.
2. Application contacts the licensing server.
3. Server validates the license and entitlement.
4. Server verifies that the product and major version match.
5. Server checks the available device seat allocation.
6. Server registers the activation.
7. Server returns a signed activation certificate.
8. Application stores the activation certificate locally.
9. Application validates the certificate before enabling Business functionality.

An existing activation on the same device should be recognised where possible.

Repeated activation requests should not unnecessarily consume additional seats.

The server must prevent concurrent activation requests from exceeding the purchased seat allocation.

## 4.4 Device Limits and Transfers

Business licensing distinguishes between:

- Maximum simultaneously active devices.
- Maximum device transfers within a rolling 12-month period.

These are independent policies.

For example:

A customer may purchase a license with:

- 3 active device seats.
- 3 permitted transfers per rolling 12-month period.

The customer may operate three installations simultaneously.

When replacing a device:

1. Customer deactivates the existing device.
2. Server releases the activation seat.
3. Customer activates the replacement device.
4. Server allocates the available seat.

A completed release-and-reassignment counts against the transfer allowance.

The transfer allowance must be configurable per product or entitlement.

Support personnel may:

- Authorise additional transfers.
- Reset transfer limits.
- Release abandoned activations.
- Correct erroneous device registrations.

## 4.5 Application Deactivation

A Business application may provide a deactivation command or GUI operation.

Example CLI operations:

- license status
- license activate
- license deactivate
- license renew

Actual command syntax is application-specific.

For application-initiated deactivation:

1. Application contacts the licensing server.
2. Server validates the deactivation request.
3. Server marks the activation as inactive.
4. Server releases the device seat.
5. Application removes its local activation certificate.

The operation must handle network failures safely.

A failed server deactivation must not falsely report that the remote activation was released.

## 4.6 Customer Portal Deactivation

The customer portal allows customers to manage active Business installations.

Customers may:

- View active devices.
- View activation dates.
- View available seats.
- Release activations.
- View transfer allowances.
- Request additional transfer capacity or support.

When an activation is released through the portal:

- Server marks the activation as inactive.
- The seat becomes available.
- The action contributes to the applicable transfer allowance.

The portal cannot directly remove a locally stored activation certificate from an offline machine.

This limitation must be reflected in the licensing implementation.

## 4.7 Offline Business Operation

Business applications may operate offline after successful activation.

Offline behaviour is application-specific.

For example:

CurseDelete may activate online once and subsequently operate offline.

A perpetual Business license may remain operational offline indefinitely.

An application that requires recurring online checks may implement them as part of its product-specific licensing policy.

The licensing architecture must support both models.

## 4.8 Business Subscriptions

Business subscription licenses have a defined entitlement expiration.

A subscription license must contain an enforceable expiration date.

The application must not extend that expiration without receiving a newly signed entitlement.

Renewal may occur through:

- Automatic online refresh.
- A CLI renewal command.
- A GUI renewal operation.
- Reinstallation or replacement of a signed license file.

Example:

An application may provide a `/renew` command that contacts the licensing server and downloads the current signed entitlement.

The application should preserve its existing valid license if a renewal request fails.

A failed network request must not unnecessarily invalidate an otherwise valid, unexpired entitlement.

When a subscription expires:

- Business functionality is disabled.
- The application reverts to unlicensed Community functionality.
- Customer data and application configuration should be preserved where possible.

An expired subscription should not prevent access to basic Community functionality.

## 4.9 Perpetual Business Licenses

Perpetual Business licenses:

- Never expire.
- Remain valid for their licensed major version.
- Include all future minor and patch releases within that major version.
- May operate offline indefinitely after activation, depending on application policy.
- Do not automatically license a future major version.

## 4.10 Offline Revocation Limitations

The architecture must explicitly acknowledge that offline revocation has limitations.

When a device is deactivated through the customer portal:

- Its server-side activation is released.
- Its activation is no longer recognised as active by the server.
- The server may allocate that seat to another device.

However, a previously issued activation certificate may still exist on an offline installation.

If the application is permitted to operate indefinitely offline, it cannot immediately discover that its activation was revoked.

Therefore:

- Applications requiring timely revocation must periodically contact the server.
- Applications supporting indefinite offline operation accept delayed revocation enforcement.
- Portal deactivation must not be described as remotely deleting the license from the device.
- The next successful server validation must recognise the revoked activation.

The licensing implementation must not promise technically impossible immediate revocation of permanently offline software.

---

# 5. ENTERPRISE EDITION

## 5.1 General Behaviour

Enterprise Edition is:

- Organisation-owned.
- Always perpetual.
- Valid for the licensed organisation and its subsidiaries.
- Available for unlimited installations.
- Not subject to device activation limits.
- Not subject to transfer limits.
- Not subject to device inventory requirements.
- Capable of completely offline operation.
- Entitled to all application features, where applicable.

Enterprise includes all minor and patch releases within its licensed major version.

A new major version requires a new entitlement.

## 5.2 Ownership

Enterprise licenses belong to the purchasing organisation.

Ownership information originates from Stripe.

The licensing server associates the entitlement with:

- Stripe customer.
- Organisation name.
- Organisation identifier, where available.
- Associated email address.
- Product.
- Major version.
- Enterprise Edition.

The license can be used across subsidiaries of the licensed organisation.

Enterprise licensing does not require recording each installation.

## 5.3 Enterprise Licensing Methods

Enterprise supports two primary licensing methods:

1. Offline license installation.
2. Online license activation.

The customer may choose the method appropriate to their environment.

## 5.4 Method 1 — Offline License Installation

The customer obtains a signed Enterprise JSON license file.

The license file can be provided through:

- Installer arguments.
- CLI arguments.
- GUI.
- Application configuration.
- A predefined license directory.

The application loads the license.

The application validates:

- Signature (see §15 for the permitted algorithms).
- Signing key identifier.
- Product identity.
- Licensed major version.
- Enterprise edition.
- Perpetual entitlement.
- License validity.

After successful validation, Enterprise functionality becomes available.

No server connection is required.

No device information is collected.

No activation seat is consumed.

No device registration occurs.

The application can remain offline indefinitely.

The application may read and verify its license file each time it starts.

Applications may automatically discover a valid license file in their configured licensing directory.

## 5.5 Method 2 — Online License Activation

The customer supplies an activation token, license identifier, or other supported credential.

The application contacts the licensing server.

The server:

1. Validates the customer's entitlement.
2. Confirms the product and major version.
3. Checks the Enterprise license status.
4. Returns the signed Enterprise license.

The application stores the license locally.

Subsequent executions validate the locally stored license.

No device seat is consumed.

No device inventory is maintained.

The application may operate offline indefinitely after provisioning.

## 5.6 Enterprise License Files

Enterprise applications may be configured to read a license file directly from the filesystem.

For example:

- Application installation directory.
- System-wide configuration directory.
- User-specific configuration directory.
- Administrator-configured license path.

The actual locations are platform-specific.

The application must not assume a single filesystem layout across Windows, macOS, and Linux.

A license file may be:

- Copied into the configured location.
- Referenced through an installation parameter.
- Supplied through a CLI operation.
- Imported through a GUI.

The application should validate the license whenever it is loaded.

Applications may reload the license at startup or when explicitly requested.

## 5.7 Enterprise Revocation

Enterprise licenses may be revoked centrally.

Revocation means:

- Future online activation or provisioning requests are rejected.
- Future online validation requests recognise the revoked status.
- The customer portal reflects the revoked entitlement.

A revoked Enterprise license already installed on an offline device cannot be immediately invalidated remotely.

The application continues trusting the locally signed license until it receives updated revocation information or performs a server validation, depending on its configured behaviour.

Applications may optionally support:

- Online revocation checks.
- Signed revocation lists.
- Administrator-provided revocation information.

However, recurring internet connectivity must not be mandatory for Enterprise applications configured for permanent offline operation.

---

# 6. LICENSE SIGNING AND KEY MANAGEMENT

## 6.1 Central Signing Authority

The licensing server manages all signing keypairs (Ed25519 by default; see §15).

Private signing keys are controlled exclusively by the licensing server's secure signing infrastructure.

Private keys must never be distributed with applications.

Private keys must never be embedded into:

- Application source code.
- Application binaries.
- Installers.
- Client-side configuration.
- Customer license files.

Multiple applications may use the same signing keypair.

Keypairs are not inherently associated with a product, edition, or major version.

Keypairs have unique identifiers or names.

## 6.2 Signing-Key Generation

New signing keypairs are generally generated annually.

However:

- Generating a keypair does not automatically update applications.
- Generating a keypair does not automatically change the active signing key.
- Generating a keypair does not invalidate historical licenses.
- Generating a keypair does not force existing applications to adopt it.

Signing-key rotation is centrally controlled.

Keys may be introduced into applications whenever the development team determines they are required.

Annual key generation is an administrative key-management practice, not an automatic application update policy.

## 6.3 Application Trusted-Key Sets

Every application contains an explicitly selected collection of trusted public signing keys.

The trusted-key set is controlled by the application's developers.

Different applications may trust different keys.

Different major versions of the same application may also trust different keys.

A newer major version is not required to contain the public keys used by older major versions.

An older major version is not required to adopt newly generated signing keys.

Public keys are introduced, retained, or removed intentionally.

There must be no assumption that all applications automatically trust every historical signing key.

There must be no assumption that every application automatically receives newly generated public keys.

## 6.4 Example Signing Authorities

Available signing keypairs:

- repass-signing-alpha
- repass-signing-beta
- repass-signing-gamma

These names are illustrative.

## 6.5 Example Application Trust Configuration

CurseDelete v2.x.x:

- Trusts repass-signing-alpha.
- Trusts repass-signing-beta.

CurseDelete v3.x.x:

- Trusts repass-signing-gamma.

AnotherApplication v1.x.x:

- Trusts repass-signing-alpha.
- Trusts repass-signing-gamma.

The applications are not required to share identical trusted-key sets.

The same keypair can be trusted across multiple applications.

The licensing server must understand which signing keys are compatible with the intended application releases.

## 6.6 License Issuance

The licensing server maintains the relationship between:

- Product.
- Product major version.
- Supported application releases.
- Approved signing keys.
- License schema compatibility.

When issuing a license:

1. The server identifies the purchased entitlement.
2. The server determines the product and major version.
3. The server identifies an approved signing key.
4. The server verifies that the intended application releases support the corresponding public key.
5. The server constructs the license payload.
6. The server signs the payload using the approved private key.
7. The server returns or stores the signed license.

The licensing server must not knowingly issue a license using a signing key unsupported by the intended application.

A newly generated key must not become active for issuing licenses to a product until the intended application builds support its public key.

## 6.7 Application License Validation

When validating a license, the application:

1. Loads the signed license.
2. Reads the signing key identifier.
3. Looks up the corresponding public key in its trusted-key set.
4. Rejects the license if the signing key is not trusted.
5. Verifies the signature (with the key's algorithm, which must be on the application's allowlist — §15).
6. Rejects the license if signature verification fails.
7. Validates the product identity.
8. Validates the licensed major version.
9. Validates the edition.
10. Validates the relevant entitlement dates or perpetual status.
11. Validates additional edition-specific requirements.
12. Enables the features permitted by the validated edition.

An application must never grant paid functionality based solely on an unverified license payload.

## 6.8 Key Compatibility

Key compatibility is explicitly controlled per application build.

For example:

If CurseDelete v2.0.0 accepts a license signed with repass-signing-alpha, future v2.x.x releases intended to continue supporting that license must retain the corresponding public key.

If a new keypair is introduced for CurseDelete v2.5.0, older v2 releases do not automatically support licenses signed using that keypair.

Therefore, the licensing server must account for the intended application release compatibility when selecting signing keys.

Older licenses remain valid in newer application builds only when those builds continue trusting the necessary public keys and supporting the relevant license format.

Historical signing keys must be retained securely by the server for as long as they are required for compatible license issuance or other authorised operations.

Historical public keys must remain embedded only in application builds that intentionally support them.

## 6.9 Product and Version Enforcement

Signing-key trust and product entitlement are separate validation requirements.

Even if two products trust the same signing key:

- A license for Product A must not activate Product B.
- A license for Product A v2 must not activate Product A v3.
- A Business license must not automatically grant Enterprise functionality.

This is enforced using signed license claims.

The application must validate the claims after successfully verifying the signature.

Cryptographic compatibility alone does not establish entitlement.

---

# 7. LICENSE FILE FORMAT

## 7.1 General Format

Licenses use JSON.

The license payload is digitally signed (Ed25519 by default; see §15).

The signed payload must include sufficient information for completely offline validation where that edition supports offline licensing.

A standard license should include:

- License schema version.
- Unique license ID.
- Customer reference.
- Product ID.
- Licensed major version.
- Edition.
- Organisation name, where applicable.
- Registered customer identity, where applicable.
- Issue timestamp.
- Perpetual entitlement flag.
- Expiration timestamp, where applicable.
- Signing key identifier.
- Signature.

Additional entitlement information may be included when required.

## 7.2 Signing and Canonicalisation

The license format must clearly define which bytes are signed.

The implementation must not rely on arbitrary JSON formatting or property ordering.

Use a documented and deterministic signing representation.

Suitable approaches include:

- Canonical JSON serialization.
- A separately encoded payload with a detached signature.

The signing and verification processes must use identical payload bytes.

The format must support future schema versions.

Applications must reject unsupported or malformed license formats safely.

## 7.3 Example Conceptual License

The following is illustrative and is not a final wire-format contract.

```json
{
  "schemaVersion": 1,
  "licenseId": "lic_example_001",
  "customerId": "cus_example_001",
  "productId": "cursedelete",
  "majorVersion": 2,
  "edition": "enterprise",
  "organisation": "Example Organisation Pty Ltd",
  "issuedAt": "2026-10-11T00:00:00Z",
  "perpetual": true,
  "expiresAt": null,
  "keyId": "repass-signing-alpha",
  "signature": "<base64url-encoded-signature>"
}
```

The final license format must ensure the signature is not included in the data being signed unless the envelope format explicitly defines that behaviour.

The application must not treat this illustrative JSON structure as an established server API contract.

## 7.4 Business Activation Certificates

Business activation certificates are separate from the underlying commercial entitlement.

They should include:

- Certificate schema version.
- Unique activation ID.
- License ID.
- Product ID.
- Licensed major version.
- Device identifier or suitable device fingerprint.
- Activation issue timestamp.
- Certificate expiration, where applicable.
- Signing key identifier.
- Signature.

The activation certificate demonstrates that the server authorised a particular installation.

The underlying license determines commercial entitlement.

The application must validate both where required.

The certificate format must not allow an expired subscription entitlement to be extended merely by possessing an old activation certificate.

## 7.5 Information Protection

JSON signatures protect integrity and authenticity.

They do not provide encryption.

A customer must not be able to modify:

- Edition.
- Product identity.
- Major version.
- Entitlement dates.
- Perpetual status.
- Activation limits.
- Other signed entitlement claims.

Any unauthorised modification must invalidate the signature.

Do not embed unnecessary sensitive customer data.

Email addresses do not need to be present inside license files when a stable customer reference is sufficient.

If confidentiality is required, encryption may be implemented separately from signing.

Encryption must not replace signature verification.

The application must not contain private signing keys or server-only secrets.

---

# 8. CENTRAL LICENSING SERVER

## 8.1 Server Responsibilities

The future licensing server will be a shared service for all applications.

It will manage:

- Products.
- Product major versions.
- Editions.
- Customers.
- Organisations.
- Entitlements.
- Licenses.
- Signing keys.
- License issuance.
- Online provisioning.
- Business activations.
- Business deactivations.
- Device transfer allowances.
- License renewals.
- Revocations.
- Customer portal functionality.
- Stripe integration.
- License audit history.

The server must be product-agnostic.

Product-specific policies must be configurable.

A new application must not require rewriting the licensing server.

## 8.2 Stripe Integration

Stripe handles:

- Customer identity.
- Organisation/business information.
- Product purchases.
- Payment processing.
- Subscription billing.
- Commercial transaction records.

The licensing server handles:

- Entitlements.
- License generation.
- License signatures.
- License validation services.
- Application activations.
- License management.
- Provisioning.

The licensing server receives Stripe webhook events.

When a qualifying purchase is confirmed:

1. Stripe sends the webhook.
2. Licensing server verifies the webhook authenticity.
3. Server resolves the Stripe customer.
4. Server determines the purchased product or bundle.
5. Server determines the licensing entitlement.
6. Server generates the necessary signed licenses.
7. Server associates the licenses with the customer.
8. Licenses become available through the customer portal.

Webhook processing must be idempotent.

Duplicate webhook deliveries must not create unintended duplicate licenses.

License issuance must be based on verified purchase state rather than trusting arbitrary client-supplied product or edition information.

## 8.3 Product Bundles

Stripe may sell bundles containing multiple applications.

A bundle does not create a universal multi-application license.

Instead:

- Stripe identifies the purchased bundle.
- The licensing server resolves its component product entitlements.
- The server generates separate licenses for each included product.
- Each license remains product-specific.
- Each license specifies its own major version and edition.

Customers may see a single bundle purchase while receiving multiple product licenses.

## 8.4 Customer Ownership

A customer may own:

- Licenses for multiple different applications.
- Multiple licenses for the same application.
- Licenses for different major versions.
- Licenses for different editions.
- Perpetual and subscription entitlements where supported.

The system must not assume one customer equals one license.

It must not assume one product equals one license per customer.

It must distinguish the commercial purchase from the issued entitlement and license artifact.

## 8.5 Customer Portal

The customer portal should provide:

- Customer profile.
- Organisation information.
- Registered products.
- Purchased licenses.
- License downloads.
- Entitlement information.
- Product and major-version identification.
- Subscription information, where applicable.
- Business device activation management.
- Business seat availability.
- Device transfer allowances.
- License renewal and provisioning operations.
- Support contact or escalation mechanisms.

Community users with registered licenses should also have customer portal access.

Enterprise and Education customers should not be presented with unnecessary device-management functionality.

## 8.6 Entitlement Updates

Applications should be able to obtain updated entitlements without requiring customers to manually replace license files.

Where supported:

- Application contacts the licensing server.
- Server resolves the current entitlement.
- Server returns an updated signed license.
- Application validates the new license.
- Application replaces or updates its locally stored license safely.

Applications must validate the new license before replacing an existing valid license.

A network failure must not automatically destroy an existing valid perpetual entitlement.

Subscription renewal requires newly signed entitlement information establishing the updated expiration.

## 8.7 Suggested Server Domain Model

The future server should consider these separate domain objects:

PRODUCT
- Product ID.
- Product name.
- Product configuration.

PRODUCT VERSION
- Product ID.
- Major version.
- Supported editions.
- Licensing policies.
- Compatible signing keys.

CUSTOMER
- Customer ID.
- Stripe customer ID.
- Customer name.
- Email address.
- Organisation information.

ENTITLEMENT
- Entitlement ID.
- Customer ID.
- Product ID.
- Licensed major version.
- Edition.
- Perpetual or subscription.
- Validity dates.
- Activation allowance, where applicable.
- Status.

LICENSE
- License ID.
- Entitlement ID.
- Signing key identifier.
- Signed license payload.
- Issue timestamp.

ACTIVATION
- Activation ID.
- License ID.
- Device identifier, where required.
- Activation timestamp.
- Deactivation timestamp.
- Status.

SIGNING KEY
- Unique key ID.
- Signature algorithm (§15).
- Public verification key.
- Secure private-key reference.
- Key status.
- Creation timestamp.
- Permitted signing usage.

KEY COMPATIBILITY
- Product ID.
- Major version.
- Compatible application releases.
- Approved signing key ID.
- Issuance eligibility.

This is a conceptual starting point rather than a mandate for specific database tables.

The final server implementation should use appropriate domain modelling and database design.

---

# 9. APPLICATION-SIDE LICENSING ARCHITECTURE

## 9.1 Responsibilities

Every application should have a clean licensing integration that can:

- Identify its own product ID.
- Identify its own major version.
- Load license information.
- Validate signatures.
- Resolve the appropriate trusted public key.
- Validate edition and product entitlement.
- Determine effective licensed functionality.
- Fall back to Community Edition when appropriate.
- Store license information securely.
- Support the relevant provisioning methods.
- Communicate with the future licensing server where required.

The application should not implement the licensing server's internal commercial logic.

## 9.2 Application Configuration

Application-specific configuration should define:

- Product ID.
- Application version.
- Trusted signing keys.
- Permitted signature algorithms (§15).
- Supported licensing schema versions.
- Edition feature mapping.
- License file locations.
- Supported activation methods.
- Online licensing endpoint configuration.
- Business offline behaviour.
- Relevant renewal behaviour.

Avoid hardcoding licensing rules throughout unrelated application features.

A single licensing component should determine the effective edition and entitlements.

Application features should consume that licensing state consistently.

## 9.3 Feature Entitlements

Applications must determine feature availability using their own configuration.

For example:

Feature A:
- Community: Enabled.
- Education: Enabled.
- Business: Enabled.
- Enterprise: Enabled.

Feature B:
- Community: Disabled.
- Education: Enabled.
- Business: Enabled.
- Enterprise: Enabled.

Feature C:
- Community: Disabled.
- Education: Disabled.
- Business: Enabled.
- Enterprise: Enabled.

These are examples only.

Do not assume this exact mapping applies to the current application.

The actual application's existing behaviour and intended product edition policies must be examined before implementing feature restrictions.

A license establishes the edition.

The application determines which features that edition permits.

## 9.4 License Validation Result

Application code should expose a clear licensing result that distinguishes:

- Unregistered Community.
- Registered Community.
- Education.
- Business.
- Enterprise.
- Missing license.
- Invalid signature.
- Unsupported signing key.
- Incorrect product.
- Incorrect major version.
- Expired entitlement.
- Revoked entitlement, when known.
- Activation required.
- Activation invalid.
- Server unavailable.

Not all validation failures should terminate the application.

For example:

- Missing license should normally mean Community Edition.
- Expired Business subscription should revert to Community Edition.
- Invalid paid license should not enable paid functionality.
- Server unavailability should not prevent valid offline-permitted licenses from working.

The application must make these distinctions deliberately.

## 9.5 Local License Storage

Applications should use appropriate operating-system conventions for storing license files.

Requirements:

- Support Windows, macOS, and Linux where relevant.
- Avoid hardcoded user-specific paths.
- Support system-wide and user-specific installations where appropriate.
- Apply sensible filesystem permissions.
- Validate the license whenever it is loaded.
- Avoid silently overwriting valid licenses with invalid files.
- Avoid unnecessary storage of activation credentials.

Enterprise and Education deployments may require administrator-managed license directories.

CLI applications may need to run unattended or through automation.

The licensing implementation must support the application's actual deployment model.

---

# 10. SECURITY REQUIREMENTS

The architecture must:

- Use the approved signature algorithms (§15), with Ed25519 as the default.
- Keep private signing keys server-side.
- Embed only intentionally approved public keys in applications.
- Validate signatures before accepting entitlement claims.
- Validate product identity and major-version entitlement.
- Prevent license modifications without invalidating signatures.
- Avoid embedding production server credentials in applications.
- Use authenticated and encrypted connections for online activation.
- Protect activation credentials from unnecessary exposure.
- Avoid collecting unnecessary device information.
- Handle malformed license files safely.
- Avoid trusting unsigned edition or feature claims.
- Avoid granting paid features when licensing validation fails.
- Support deliberate signing-key rotation.
- Preserve compatibility with legitimately issued licenses where required.

The server must additionally:

- Authenticate Stripe webhook events.
- Prevent duplicate webhook processing.
- Enforce Business activation limits transactionally.
- Authorise customer portal operations.
- Protect signing keys.
- Record security-relevant license operations.
- Prevent unauthorised license issuance.
- Prevent one customer from managing another customer's licenses.

---

# 11. CURRENT DEVELOPMENT TASK — APPLICATION REPOSITORY

IMPORTANT:

We are currently modifying the application, not the central licensing server.

Claude should use this document as the architectural source of truth while preparing the current application for the future licensing system.

The immediate development work should focus on the following.

## 11.1 Review Existing Application Licensing

Inspect the existing application and determine:

- Current license handling.
- Existing license file formats.
- Existing activation mechanisms.
- Existing public-key verification.
- Existing edition checks.
- Existing feature restrictions.
- Existing CLI/GUI license commands.
- Existing license-related configuration.
- Existing tests.
- Dependencies on the current licensing server.

Do not discard useful existing functionality merely because the server will be replaced.

Preserve functionality that is compatible with the new architecture.

Identify and isolate functionality that depends on the old server.

## 11.2 Implement Clean Integration Boundaries

Prepare the application for:

- Signed JSON licenses.
- Signature validation with the approved algorithms (§15).
- Configurable trusted public keys.
- Product and major-version validation.
- Edition resolution.
- Feature entitlement evaluation.
- Offline license installation.
- Online activation interfaces where required.
- Online entitlement refresh where required.
- Business activation and deactivation where required.

Use interfaces and abstractions appropriate to the application's existing architecture.

Do not introduce a large framework where a small, maintainable implementation is sufficient.

## 11.3 Avoid Premature Server Implementation

The future server will be built in a separate repository.

For now:

- Define application-side integration contracts.
- Document expected server interactions.
- Implement local license validation.
- Isolate network interactions behind appropriate interfaces.
- Keep endpoint configuration externalised.
- Avoid inventing permanent API contracts without documenting them as provisional.
- Do not generate production signing keys inside the application repository.
- Do not implement Stripe logic inside the application.

Mock or fake dependencies may be used for automated tests, but they must not be mistaken for production licensing services.

## 11.4 Preserve Application Behaviour

The application must continue to support Community Edition without licensing infrastructure.

Invalid or absent paid licensing must not unnecessarily prevent basic application operation.

Feature restrictions should follow the application's intended edition policy.

Do not remove functionality or introduce breaking changes unless necessary and justified.

Where licensing changes require migration from an existing implementation, document the compatibility and migration implications.

## 11.5 Automated Testing

Add or update tests covering:

- Missing license.
- Valid Community license.
- Valid Education license.
- Valid Business license.
- Valid Enterprise license.
- Invalid signature.
- Unsupported signing key.
- Incorrect product ID.
- Incorrect major version.
- Perpetual entitlement.
- Expired subscription.
- License file corruption.
- Multiple trusted public keys.
- Historical key compatibility.
- Offline license validation.
- Community fallback.
- Edition-specific feature permissions.

Additional tests should cover activation and deactivation behaviour where those capabilities are relevant to the current application.

Tests must not require the future licensing server to exist.

Use test-only keypairs and signed test fixtures.

Never include production private signing keys in the repository.

---

# 12. FUTURE DEVELOPMENT TASK — LICENSING SERVER REPLACEMENT

The licensing server will be developed separately.

When that work begins, Claude should use this same specification to implement the central service.

The server implementation must support:

- All four editions.
- Multiple applications.
- Multiple major versions.
- Perpetual entitlements.
- Business subscriptions.
- Volume licensing.
- Business device activations.
- Business transfers and deactivations.
- Enterprise offline license provisioning.
- Stripe webhook-driven license issuance.
- Product bundles.
- Customer portal management.
- Entitlement refresh.
- Named signing keys for each approved algorithm (§15).
- Shared signing keys across applications.
- Explicit application signing-key compatibility.
- Historical signing-key retention.
- License revocation.
- Audit logging.

The replacement must not assume that every application uses the same activation model.

The replacement must not force Education or Enterprise installations to report device identities.

The replacement must not force perpetual offline licenses to contact the server periodically.

The replacement must not automatically distribute newly generated signing keys to every application.

The replacement must not automatically treat a major-version upgrade as an entitlement to the new version.

The replacement should support application-specific policies through a clean, maintainable product configuration model.

---

# 13. IMPORTANT ARCHITECTURAL DISTINCTIONS

Claude must preserve the following distinctions throughout implementation.

1. A product is not the same as a product major version.
2. A purchase is not the same as an entitlement.
3. An entitlement is not the same as a signed license artifact.
4. A Business activation is not the same as the underlying license.
5. A signing key is not inherently associated with a product or major version.
6. A trusted signing key does not establish product entitlement by itself.
7. A perpetual license does not grant future major versions.
8. An offline license does not require recurring server validation.
9. Server-side revocation does not guarantee immediate revocation of indefinitely offline installations.
10. Registered Community licenses do not imply device tracking.
11. Education volume licenses do not imply device tracking.
12. Enterprise unlimited installations do not imply device tracking.
13. Business device limits require server-side activation management.
14. Application feature availability is determined by application configuration, not universally by the licensing server.
15. New signing keys do not automatically become trusted by existing application releases.
16. Historical signing keys are retained or trusted only where required by the intended compatibility policy.
17. The central licensing service and the application licensing integration are separate software components.

---

# 14. IMPLEMENTATION EXPECTATIONS FOR CLAUDE

Use this specification to guide the current application's licensing changes.

Before making changes:

- Inspect the existing implementation.
- Understand the application's architecture.
- Identify existing licensing behaviour worth retaining.
- Determine which editions and activation methods are relevant.
- Identify where licensing decisions currently occur.
- Identify dependencies on the old licensing server.

During implementation:

- Keep code concise and maintainable.
- Follow the application's existing conventions.
- Prefer clear interfaces over unnecessary abstractions.
- Avoid duplicate licensing logic.
- Keep feature entitlement evaluation centralised.
- Keep cryptographic validation independent of feature evaluation.
- Keep server communication independent of local validation.
- Support only relevant application integration methods.
- Do not add unnecessary dependencies.
- Add meaningful automated tests.
- Document provisional future-server integration contracts.

Do not assume that the old licensing server architecture must be preserved.

Do not implement the future licensing server inside this repository.

Do not redesign unrelated application functionality.

The immediate goal is to make the application licensing implementation correct, secure, maintainable, and ready for integration with the separately developed licensing server.

When the future licensing server is developed, it must implement the shared architecture described here without requiring every application to redesign its licensing integration.

---

# 15. SIGNATURE ALGORITHMS

## 15.1 Supported algorithms

```json
{
  "supportedSignatureAlgorithms": [
    { "id": "ECDSA-P256-SHA256", "standard": "FIPS-186-5", "fipsApproved": true },
    { "id": "Ed25519", "standard": "RFC-8032", "fipsApproved": false },
    { "id": "ML-DSA-65", "standard": "FIPS-204", "fipsApproved": true, "quantumResistant": true }
  ],
  "defaultSignatureAlgorithm": "Ed25519"
}
```

## 15.2 Architecture decisions

- Ed25519: default for ordinary software licences.
- ECDSA P-256: for deployments requiring FIPS-approved cryptography.
- ML-DSA-65: for quantum-resistant signatures and long-term cryptographic resilience.
- Each signing keypair is associated with exactly one algorithm.
- Each licence identifies its signing key using `keyId`.
- Applications validate signatures using trusted public keys and an explicit allowlist of permitted algorithms.
- Annual key rotation applies independently to each algorithm.
- Historical verification keys remain available for perpetual licences.
- The licensing server holds private keys; applications receive public keys only.

Each signature entry names its algorithm and key:

```json
{
  "signatureAlgorithm": "ML-DSA-65",
  "keyId": "licensing-2026-mldsa65",
  "signature": "<base64-signature>"
}
```

## 15.3 Implementation considerations

1. FIPS compliance requires more than selecting ECDSA or ML-DSA. The cryptographic implementation and operating environment must meet the applicable FIPS requirements.
2. A licence signed only with ML-DSA-65 requires the application to support ML-DSA verification. For compatibility during migration, licences may carry dual signatures.

Final selection: ECDSA P-256, Ed25519, and ML-DSA-65 — enterprise compatibility, efficient everyday signing, and post-quantum protection without unnecessary algorithms.
