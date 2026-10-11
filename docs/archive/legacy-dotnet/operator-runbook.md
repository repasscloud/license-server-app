# LicenseServer operator runbook

## Required secret configuration

Store values in the deployment platform's secret manager. Names only are documented:

- `ConnectionStrings__DefaultConnection`
- `ActivationCodes__Pepper`
- `ApiCredentials__Pepper`
- `DeploymentKeys__Pepper`
- `MailerSend__ApiToken`
- `MailerSend__WebhookSecret`
- `Stripe__ApiKey`
- `Stripe__WebhookSecret`
- `Licensing__KeyDirectory` — a mounted, read-only directory of `<keyId>.private.pem` /
  `<keyId>.public.pem` pairs, for the development PoC only

Use independent peppers. Prefer a least-privilege Stripe restricted API key. Never put
these values in source, committed `.env` files, logs, audit, exception pages, or
analytics. Production signing must move from the mounted development PEM directory to
a KMS/HSM or isolated signing service.

## MailerSend setup

1. Verify the sender domain and configure `MailerSend__FromEmail` and optional
   `MailerSend__FromName`.
2. Configure `MailerSend__ApiToken` and the delivery-status webhook signing secret.
3. Point delivery events at `POST /api/v1/webhooks/mailersend`.
4. Monitor `EmailOutbox` status. `uncertain` means an ambiguous provider outcome and
   requires reconciliation; do not blindly resend it.

Email recipient/model data is Data Protection ciphertext. Back up PostgreSQL and Data
Protection keys together or queued messages and short-lived protected replay results
cannot be decrypted after recovery. Terminal email and delivery-event retention is 30
days by default; align database backups and privacy retention with the actual operating
jurisdiction.

## Stripe setup

1. Use Stripe API version `2026-07-29.dahlia` and Stripe.net 52.2.0.
2. Configure a webhook endpoint at
   `POST /api/v1/integrations/stripe/webhook` for:
   `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `charge.refunded`,
   `charge.dispute.created`, and `charge.dispute.closed`.
3. Set `Stripe__WebhookSecret` to that endpoint's secret. Set `Stripe__ApiKey` to a
   restricted key that can read the customer, Checkout Session, invoice, subscription,
   Product, and Price objects needed for reconciliation.
4. Create dedicated internal mappings for Stripe Products and Prices before accepting
   purchases. A Price mapping fixes the internal product, edition, license type, and
   seats; client metadata is never authoritative.
5. Review `Billing__GracePeriodDays` (default `7`), `Billing__RefundAction` (default
   `review`), and `Billing__DisputeAction` (default `review`). The latter two accept
   `review` or `suspend`.

Stripe can deliver events more than once and out of order. The inbox acknowledges only
verified events, stores protected payloads, and processes through leases. Missing or
conflicting mappings become `quarantined`. After fixing the mapping/configuration, an
operator with `billing.manage` may inspect
`GET /api/v1/admin/billing/events` and invoke
`POST /api/v1/admin/billing/events/{id}/reprocess`. Reprocess changes process state
only; it cannot edit the provider payload or business history.

Stripe Tax is not enabled by this repository. Enabling automatic tax does not collect
tax without active registrations; the operator must assess registrations and configure
Stripe Tax separately.

## Roles and credentials

- Human operators use Identity cookies; high-risk permissions require MFA in
  production.
- Automation uses service accounts with scoped `lic_live_...` bearer credentials.
- `Billing Automation` includes the narrow license/customer/product/billing permissions
  required by billing workflows.
- Cookie mutations require `X-CSRF-TOKEN`. Bearer credentials are accepted only in the
  `Authorization` header and do not rely on cookies.

One-time activation codes, API keys, invitation/reset links, and magic-link tokens
cannot be recovered from the database. Rotate or reissue through the audited workflow;
never query protected payloads to display them later.

## Backup, recovery, and migration

Back up PostgreSQL, Data Protection keys, public signing-key metadata, and the external
signing-key service configuration as one recovery set. Test restore procedures. Retain
append-only audit history according to legal/security policy and export it to
retention-locked storage for production.

The current strategy is forward migrations. On startup, one PostgreSQL advisory lock
serializes migration and seed. Before deployment:

```powershell
dotnet ef migrations list --project src/LicenseServer --startup-project src/LicenseServer
dotnet ef database update --project src/LicenseServer --startup-project src/LicenseServer
```

For a disposable Compose reset, first confirm resources by label:

```powershell
docker compose config --quiet
docker compose ps --all
docker volume ls --filter label=com.docker.compose.project=license-server
```

Only then use `./docker-down.ps1 -RemoveVolumes` or
`REMOVE_VOLUMES=true sh ./docker-down.sh`. Never target an unlabeled or unrelated
volume.

## Incident and recovery cues

- Stripe invalid-signature spikes: reject requests, rotate the endpoint secret if
  compromise is suspected, and review ingress logs without recording bodies/headers.
- Stripe `dead_letter`: repair transient provider/database cause, then reprocess.
- Stripe `quarantined`: repair the explicit mapping/configuration conflict, then
  reprocess.
- Email `uncertain`: reconcile in MailerSend by provider/request correlation before
  deciding whether to send again.
- Lost activation code: perform audited activation-code rotation; the original cannot
  be recovered.
- Lost API key: rotate/revoke it; the original cannot be recovered.
- Signing-key rotation (routine, not a compromise): drop the new `<keyId>.private.pem` /
  `<keyId>.public.pem` pair into the mounted key directory, rescan (or wait for the next
  periodic reload) so it appears in `/settings/signing-keys`, then use "Set as default"
  there. No restart required. Retain the old key so historical licences keep verifying.
- Signing-key retirement (stop signing, keep verifying): remove only the retired key's
  `<keyId>.private.pem` file from the mounted directory and rescan. Its public key and
  `SigningKeys` row are untouched, so licences it already signed keep validating.
- Signing-key compromise (destructive): revoke it immediately from `/settings/signing-keys`
  (System Administrator only; requires a reason and explicit confirmation) — this fails
  verification for every licence that key ever signed, but **only inside this server's
  own live verification**. It has no effect on `LicenseValidator`/`TrustedPublicKeys.cs`
  already compiled into shipped products: a licence — or a forgery made with the
  compromised private key — still validates successfully inside any already-shipped
  product until that product is rebuilt with an updated `TrustedPublicKeys.cs` and
  customers upgrade. Treat propagating the compromise to shipped products as a separate,
  urgent release process, not something this endpoint does for you. If the exposed key
  was the default, immediately set a replacement default — the server never
  auto-substitutes one.

## Fundamental offline limits

Signed license files provide authenticity, not secrecy. They cannot be recalled once
downloaded, an offline machine can roll back its clock, and software-only device IDs
can be spoofed by a machine owner. Immediate suspension and revocation require online
validation or short leases. A seat count in a signed file does not enforce concurrent
usage without an online seat-allocation protocol.
