# Operations runbook

## Daily health

- Admin → **Overview** shows dead jobs, email needing attention, failed Stripe events, drifted mappings, entitlements needing review, and missing configuration.
- `rp GET /system/health | jq .` (see [terminal-admin-api.md](terminal-admin-api.md)).
- Cloudflare dashboard → Worker → **Logs** / Metrics: look for `outcome = exceededCpu`, `exception`, and the `cpuTime` distribution.

## Stripe webhooks and reconciliation

| Symptom | Action |
|---|---|
| Event `failed` / `dead` | Read `last_error`, fix the cause (for example a missing mapping), then **Replay** (UI) or `POST /webhooks/stripe/events/{id}/replay`. Replays are idempotent. |
| Customer paid, no licence | `POST /webhooks/reconcile {"kind":"checkouts"}`. This re-fetches open checkouts from Stripe and fulfils completed ones. |
| Missed events (outage, misconfigured endpoint) | `POST /webhooks/reconcile {"kind":"backfill","sinceSeconds":<unix>}`. This pulls from the Stripe Events API (authenticated by our API key) and stores unseen events. |
| Subscription out of sync | `POST /subscriptions/{sub_…}/reconcile`, or `{"kind":"subscriptions"}`. Also runs daily. |
| Checkout `failed` with "quarantined" | Stripe's line item, price, quantity or currency did not match the stored snapshot. Investigate before granting anything. Use an admin grant if it is legitimate. |
| Entitlement `review_required` | A partial refund, a dispute (policy `review`) or a dispute closure. Decide whether to revoke or keep. To keep it, use **Mark reviewed** on the licence page, or `POST /licenses/{id}/amend {"clearReview":true,"reason":"…"}`. |

The Stripe webhook signing secret rotates in the Stripe dashboard (roll secret), then `wrangler secret put STRIPE_WEBHOOK_SECRET`. Stripe signs with both old and new secrets during the roll window. The verifier accepts any `v1` signature that matches the configured secret.

## Email (MailerSend)

| Status | Meaning | Action |
|---|---|---|
| `pending` / `failed` | Queued, or a retryable error with backoff | None. Retries continue automatically (up to 10 attempts). |
| `dead` | Permanent error (4xx), the template is missing, or retries are exhausted | Fix the cause (for example verify the domain or the template), then **Retry**. |
| `uncertain` | Timed out after sending, so MailerSend *may* have accepted it | Search MailerSend Activity for the recipient and time, then **Mark sent** or **Mark not sent**. Not-sent can then be retried. |
| `sent` | Accepted by MailerSend | Delivery is confirmed only if the webhook is configured (`delivered`). |
| `bounced` / `suppressed` | A hard bounce or complaint; the recipient is suppressed | Correct the customer's email address, then delete the suppression row if appropriate. |

To rotate the MailerSend token: create a new scoped token, `wrangler secret put MAILERSEND_API_TOKEN`, check `/admin/email` for successful sends, then revoke the old token in MailerSend.

## Dead jobs

`GET /jobs?status=dead`: inspect `last_error`, fix, then `POST /jobs/{id}/retry`. Job kinds are `stripe.process_event`, `stripe.sync_price`, `stripe.sync_offer` and `stripe.archive_price`.

## Secret rotation summary

| Secret | Effect of rotation | Procedure |
|---|---|---|
| `SIGNING_KEK_V<n>` | None for clients | See [signing-keys.md](signing-keys.md) (add V2, rewrap, remove V1) |
| `APP_DATA_KEY_V<n>` | Encrypted TOTP secrets, pending key reveals and queued email payloads need the old version until re-encrypted | Add `APP_DATA_KEY_V2` and switch `APP_DATA_KEY_ACTIVE_VERSION`. Keep V1 until queued email drains and the 30-day reveals expire. Admins re-enrol TOTP, or a superadmin uses *Reset authenticator*, before V1 is removed. |
| `MACHINE_PEPPER` | **Invalidates every activation key and client secret.** Clients would need re-activation. | Avoid. Rotate only after a confirmed leak, then mass-rotate activation keys (support) and accept that Business devices must re-activate. |
| `AUTH_PEPPER` | Signs everyone out; outstanding login links stop working; rate-limit and recipient hashes reset | Safe at any time. |
| `API_TOKEN_PEPPER` | **Invalidates every API token** | Re-issue tokens afterwards. |
| Stripe secret key | — | Roll in Stripe, then `wrangler secret put STRIPE_SECRET_KEY` |
| Database runtime password | — | `ALTER ROLE repass_runtime PASSWORD …`, then `wrangler hyperdrive update … --connection-string=…` |

## Incident response (general)

1. Contain: revoke the API tokens involved (`/admin/access`), disable admins or service accounts, mark keys compromised, and rotate the relevant secret from the table above.
2. Preserve evidence: `audit_events` is append-only. Export the time window: `rp GET '/audit?limit=500&beforeId=…'`.
3. Assess customer impact, including licences issued during the window (`license_issuances`).
4. Notify as required. Australian Privacy Act Notifiable Data Breaches scheme obligations may apply to personal information; obtain legal advice. This software makes no compliance claims.

## Audit review

Review weekly: `api_token.ip_denied`, `admin.mfa_failed`, `machine.* outcome=failure` spikes (key guessing), `entitlement.revoked`, `signing_key.*`, `admin.*`, and `stripe.refund_unmapped`.

## Privacy and retention

- Licences contain no email addresses: only the customer ID, plus an organisation or person name.
- Activations store only the client-supplied opaque `deviceId` and timestamps. Non-device editions store no device data.
- IP addresses are stored only as HMAC hashes (rate limits, audit).
- Retention (daily job): raw Stripe event payloads are purged after 90 days; sent email rows after 180 days; expired sessions and challenges after 30 and 7 days; rate-limit buckets after 1 day. Audit events are append-only. To purge entries older than 400 days, the owner role runs `SET app.audit_purge = 'on'; DELETE FROM audit_events WHERE occurred_at < now() - interval '400 days';` in a deliberate maintenance action.
- Customer deletion requests: entitlements and licences referencing a customer are commercial records. Anonymise the customer row (`display_name`, `organisation_name`, `billing_email`, `tax_id`) and remove portal members instead of deleting. Obtain legal advice on retention obligations (for example tax records).

## Free-plan limits

Measured on the implementer's machine. Verify with production telemetry.

| Resource | Free limit | This application |
|---|---|---|
| CPU per request | 10 ms | Warm: Business activation 0.84 ms p50 / 4.3 ms p95; renew 1.1 / 4.8 ms; admin API ~1 ms p50. **Cold first request per isolate: ~20 ms**, relying on Cloudflare's documented per-isolate tolerance for infrequent overruns (`docs/perf/cpu-latest.json`). |
| CPU per cron | 10 ms | Bounded batches (3 jobs, 3 emails, 1 checkout reconcile per tick). Each job with signing is ≤ ~5 ms warm. |
| Requests/day | 100,000 | Plus about 720 cron invocations/day |
| Hyperdrive queries/day | 100,000 | Measured statements: Business activation 12, re-activation 11, renew 9. Estimated from code: admin API call ~6, portal page ~5–10, idle cron tick ~3 (~2.2k/day). **Budget: roughly 7–8k machine operations/day.** |
| Subrequests | 50 per invocation | ≤ 5 database connections plus ≤ 3 provider calls per request; job batches stay well under 50 |
| Cron Triggers | 5 per account | 2 used |

**When to move to Workers Paid ($5/month at the time of writing, verify current pricing).** Upgrade if `exceededCpu` outcomes appear in Workers Logs or Analytics more than occasionally, or if Hyperdrive approaches 100k queries/day. No code change is required. Optionally set `limits.cpu_ms` and raise batch sizes. Do not switch without the owner's approval.
