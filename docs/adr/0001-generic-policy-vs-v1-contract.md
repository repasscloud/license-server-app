# ADR-0001: Generic per-product licensing policy vs the strict `repass-*-v1` contract

- **Status:** Accepted
- **Date:** 2026-10-11
- **Affected clients:** every application release that verifies `repass-license-v1` /
  `repass-activation-v1` with `schemaVersion: 1` (first: CurseDelete 2.1.x, `cursedelete` major `2`).

## Context

The rewrite mandate (`docs/requirements/REWRITE-MANDATE.md`) requires a product-agnostic server in
which every product, major, edition, term, seat and activation policy is data in PostgreSQL. It
explicitly forbids treating `community` / `education` / `business` / `enterprise` as four
globally fixed behaviour bundles. For example, a product might sell an Education subscription
or a perpetual Business edition.

The upstream server brief (`docs/requirements/upstream/LICENSING-SERVER-BRIEF.md`) is binding for
every client that speaks `repass-*-v1`. Those clients already **reject** licences that break the
v1 rules (§3.2, §4.4 of the brief):

| v1 rule (client-enforced) | Consequence if violated |
| --- | --- |
| `perpetual: false` is allowed only for `business` | Client rejects the licence |
| `maxActivations` is required (≥ 1) for `business` and forbidden for every other edition | Client rejects the licence |
| Device activation certificates exist only for `business` | Non-business clients never call with a device |
| Unknown claim fields are rejected | No new claims without `schemaVersion: 2` |
| `expiresAt` must be strictly later than `issuedAt` when `perpetual: false` | Re-signing an expired subscription produces an invalid file |

## Decision

1. **Protocols are an explicit, code-implemented capability, and products choose one as data.**
   `license_protocols` lists the wire protocols and `product_majors.protocol_id` selects one per
   product major. The server code ships a registry (`src/domain/protocols.ts`). It implements only
   `repass-v1`, which owns the v1 issuance rules above. A protocol row whose ID has no code
   implementation cannot be attached to a sellable major.
2. **Every offer is validated against its major's protocol** both when an offer is created, edited
   or published and again at issuance. Under `repass-v1`:
   - a non-perpetual term (`subscription`, `fixed_term`, trial) is accepted only for an edition
     policy whose wire edition is `business`;
   - `activation_model = device_seats` is accepted only for `business`, and `business` requires it
     with `seats ≥ 1`;
   - a certificate lifetime (`activation_certificate_lifetime_seconds`) is allowed only with
     device seats.

   Combinations that are invalid for v1, such as an Education subscription or a seatless Business
   offer, are **refused with a validation error** rather than silently reinterpreted. They become
   possible only when a future protocol (for example `repass-v2`) is implemented in code and tested,
   and a product major opts into it. Older v1 majors are never changed.
3. **Edition labels are data.** `edition_definitions` holds the label and its wire ID. Behaviour
   (term, seats, transfers, activation model, key delivery, refund/dispute action) comes from
   `product_edition_policies` and `offer_entitlement_components`. The only code that inspects
   the edition wire ID is the v1 protocol module, because v1 clients inspect it.
4. **Renewal of an expired non-perpetual entitlement returns `409 subscription_expired`.** It does
   not re-sign a licence whose `expiresAt` is before its new `issuedAt`, because v1 clients reject
   such a licence. The brief permits this for activation ("prefer returning
   `subscription_expired`"). We apply it to renew as well, where the client "reports; changes
   nothing", which is the correct outcome. The portal still offers the last validly issued
   artifact for download.
5. **Activation keys are stored as keyed hashes only.** The brief requires a key to be "shown in
   the purchase email and the portal" and also "store only a hash". The server therefore:
   - holds the plaintext only transiently: in an encrypted, single-use `reveal` slot that the
     owning customer can open once in the portal (30-day expiry), and in the encrypted email
     outbox payload, which is purged when the message reaches a terminal state;
   - lets `product_majors.activation_key_email` decide per product major whether the key goes in
     the purchase email (CurseDelete: yes, per the brief) or only behind the authenticated
     portal;
   - otherwise reveals a key only on rotation, once.
6. **Grace periods are policy data.** `offer_entitlement_components.grace_days`, default `0`, is
   added to the paid-through period end when the subscription expiry is computed. Non-payment never
   revokes; it simply stops extending (brief §8).
7. **Seat reductions never deactivate devices.** If `customer.subscription.updated` lowers seats
   below the active count, new activations return `seat_limit` until the count drops (brief §9).
8. **Stripe is a mapping target, not the catalogue.** Brief §9/§10 say "map Stripe Prices to
   entitlement templates in configuration". We keep the PostgreSQL offer/price version as the
   master and map it to a Stripe Price that the server created. Checkout uses only the
   DB-resolved mapping, and fulfilment reads the immutable checkout snapshot, never Stripe
   metadata, to decide what to grant.

## Consequences

- Product teams can onboard new products and majors with no code change as long as the policies
  are expressible in `repass-v1`. Anything else needs a protocol implementation and a client
  release. That is intentional, because it is a client contract change.
- The admin UI and API reject invalid combinations with an explanation of which protocol rule
  failed.
- Some business configurations described as "illustrative" in the mandate cannot be sold to
  v1-only clients. Examples are Product B's "subscriptions for all four editions" and a
  non-perpetual Enterprise edition. The server reports this as a protocol limitation and does not
  hide it.
