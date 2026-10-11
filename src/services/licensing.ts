// Licensing core: entitlements, licences (signed artifacts with stable ids), activation keys,
// revocation, reissue and support operations. Purchase != entitlement != licence != activation
// != activation key (brief §3.1).

import type { Config } from '../config.ts';
import { appDataAad, openCompact, sealCompact } from '../crypto/aead.ts';
import { buildEnvelope, type Envelope } from '../crypto/envelope.ts';
import { hmac, sha256Hex } from '../crypto/hashing.ts';
import { textArray, toBytes, type Db, type Sql, type Tx } from '../db/client.ts';
import { EffectivePolicySchema, type EffectivePolicy } from '../domain/policy.ts';
import { getProtocol } from '../domain/protocols.ts';
import { decodeUtf8, encodeUtf8 } from '../lib/encoding.ts';
import { AppError, conflict, invalid, notFound } from '../lib/errors.ts';
import { newId, randomBytes } from '../lib/ids.ts';
import { addInterval } from '../lib/time.ts';
import { requireHighRisk, requirePermission, type Actor } from './actor.ts';
import { audit } from './audit.ts';
import { enqueueEmail } from './email.ts';
import { loadSigners } from './signing-keys.ts';

// ---------------------------------------------------------------------------------------------
// Activation keys: 150-bit Crockford base32, typed as XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX.
// Stored only as HMAC(MACHINE_PEPPER); case-insensitive; I/L->1, O->0 on input.
// ---------------------------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateActivationKey(): string {
  const bytes = randomBytes(30);
  let s = '';
  for (const b of bytes) s += CROCKFORD[b & 31];
  return s.match(/.{5}/g)!.join('-');
}

/** Returns the canonical 30-char form, or null if the input cannot be an activation key. */
export function normaliseActivationKey(input: string): string | null {
  if (input.length > 256 || /\s/.test(input)) return null;
  const s = input.toUpperCase().replace(/-/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (s.length !== 30 || ![...s].every((ch) => CROCKFORD.includes(ch))) return null;
  return s;
}

export async function hashActivationKey(config: Config, canonical: string): Promise<Uint8Array<ArrayBuffer>> {
  return hmac(config.secret('MACHINE_PEPPER'), 'activation-key/v1', canonical);
}

export async function hashClientSecret(config: Config, licenseId: string, secret: string): Promise<Uint8Array<ArrayBuffer>> {
  return hmac(config.secret('MACHINE_PEPPER'), `client-secret/v1/${licenseId}`, secret);
}

async function storeNewActivationKey(tx: Tx, config: Config, licenseId: string, createdBy: string): Promise<{ id: string; key: string }> {
  const key = generateActivationKey();
  const canonical = normaliseActivationKey(key)!;
  const id = newId('akey');
  const reveal = await sealCompact(config.appDataKeys, encodeUtf8(key), appDataAad('activation-key-reveal', id));
  await tx`INSERT INTO activation_keys (id, license_id, key_hash, key_hint, reveal_ciphertext, reveal_key_version, reveal_expires_at, created_by)
           VALUES (${id}, ${licenseId}, ${await hashActivationKey(config, canonical)}, ${key.slice(-5)}, ${reveal.blob}, ${reveal.keyVersion},
                   now() + interval '30 days', ${createdBy})`;
  return { id, key };
}

// ---------------------------------------------------------------------------------------------
// Entitlement creation
// ---------------------------------------------------------------------------------------------

export interface NewEntitlement {
  customerId: string;
  policy: EffectivePolicy;
  startsAt: Date;
  /** Required for subscriptions (paid-through period end, grace added here); ignored otherwise. */
  periodEnd?: Date | null;
  purchaseLineId?: string | null;
  componentId?: string | null;
  subscriptionId?: string | null;
  snapshotReason: string;
}

export function computeExpiry(policy: EffectivePolicy, startsAt: Date, periodEnd?: Date | null): Date | null {
  switch (policy.term.type) {
    case 'perpetual':
      return null;
    case 'fixed_term':
      return addInterval(startsAt, policy.term.interval!, policy.term.intervalCount!);
    case 'subscription':
      if (!periodEnd) throw new AppError('internal', 'subscription entitlement requires a period end');
      return new Date(periodEnd.getTime() + policy.term.graceDays * 86_400_000);
  }
}

function ownerNames(policy: EffectivePolicy, customer: { kind: string; display_name: string; organisation_name: string | null }) {
  const looksLikeEmail = (s: string | null) => !!s && /@/.test(s);
  const clean = (s: string | null) => (s && s.trim() && !looksLikeEmail(s) ? s.trim().slice(0, 200) : null);
  if (policy.ownership === 'individual') return { customerName: clean(customer.display_name), organisationName: null };
  return { customerName: null, organisationName: clean(customer.organisation_name ?? customer.display_name) };
}

export interface CreatedEntitlement {
  entitlementId: string;
  licenseId: string;
  activationKeyId: string;
  activationKey: string;
}

/** Create entitlement + policy snapshot + licence + activation key, inside the caller's tx. */
export async function createEntitlement(tx: Tx, config: Config, actor: Actor, e: NewEntitlement): Promise<CreatedEntitlement> {
  const policy = EffectivePolicySchema.parse(e.policy);
  const [customer] = await tx<{ kind: string; display_name: string; organisation_name: string | null }[]>`
    SELECT kind, display_name, organisation_name FROM customers WHERE id = ${e.customerId}`;
  if (!customer) throw notFound('Customer');
  const expiresAt = computeExpiry(policy, e.startsAt, e.periodEnd);
  const names = ownerNames(policy, customer);
  const snapshotId = newId('eps');
  await tx`INSERT INTO entitlement_policy_snapshots (id, snapshot, reason, created_by) VALUES (${snapshotId}, ${tx.json(policy as never)}, ${e.snapshotReason}, ${actor.label})`;
  const entitlementId = newId('ent');
  await tx`
    INSERT INTO entitlements (id, customer_id, product_major_id, edition_policy_id, purchase_line_id, component_id, subscription_id, policy_snapshot_id,
                              term_type, starts_at, expires_at, seats, transfer_allowance, organisation_name, customer_name)
    VALUES (${entitlementId}, ${e.customerId}, ${policy.major.id}, ${policy.edition.policyId}, ${e.purchaseLineId ?? null}, ${e.componentId ?? null},
            ${e.subscriptionId ?? null}, ${snapshotId}, ${policy.term.type}, ${e.startsAt}, ${expiresAt}, ${policy.seats}, ${policy.transferAllowance},
            ${names.organisationName}, ${names.customerName})`;
  const licenseId = newId('lic');
  await tx`INSERT INTO licenses (id, entitlement_id) VALUES (${licenseId}, ${entitlementId})`;
  const ak = await storeNewActivationKey(tx, config, licenseId, actor.label);
  await audit(tx, actor, {
    action: 'entitlement.created', resourceType: 'entitlement', resourceId: entitlementId,
    detail: { licenseId, customerId: e.customerId, product: policy.product.slug, major: policy.major.majorVersion, edition: policy.edition.wireId, term: policy.term.type, expiresAt, seats: policy.seats, reason: e.snapshotReason },
  });
  return { entitlementId, licenseId, activationKeyId: ak.id, activationKey: ak.key };
}

// ---------------------------------------------------------------------------------------------
// Licence context and signing
// ---------------------------------------------------------------------------------------------

export interface LicenseContext {
  licenseId: string;
  entitlementId: string;
  customerId: string;
  status: 'active' | 'revoked';
  termType: 'perpetual' | 'subscription' | 'fixed_term';
  expiresAt: Date | null;
  seats: number | null;
  transferAllowance: number | null;
  transferWindowResetAt: Date | null;
  organisationName: string | null;
  customerName: string | null;
  productMajorId: string;
  productSlug: string;
  majorVersion: number;
  policy: EffectivePolicy;
  currentEnvelope: Envelope | null;
  currentIssuedAt: Date | null;
  entitlementUpdatedAt: Date;
  licenseUpdatedAt: Date;
}

export async function loadLicenseContext(db: Db, licenseId: string, forUpdate = false): Promise<LicenseContext | null> {
  const rows = forUpdate
    ? await db<Record<string, unknown>[]>`
        SELECT e.*, e.id AS ent_id, l.current_envelope, l.current_issued_at, l.updated_at AS license_updated_at, s.snapshot, p.slug, m.major_version
        FROM licenses l JOIN entitlements e ON e.id = l.entitlement_id JOIN entitlement_policy_snapshots s ON s.id = e.policy_snapshot_id
        JOIN product_majors m ON m.id = e.product_major_id JOIN products p ON p.id = m.product_id
        WHERE l.id = ${licenseId} FOR UPDATE OF l, e`
    : await db<Record<string, unknown>[]>`
        SELECT e.*, e.id AS ent_id, l.current_envelope, l.current_issued_at, l.updated_at AS license_updated_at, s.snapshot, p.slug, m.major_version
        FROM licenses l JOIN entitlements e ON e.id = l.entitlement_id JOIN entitlement_policy_snapshots s ON s.id = e.policy_snapshot_id
        JOIN product_majors m ON m.id = e.product_major_id JOIN products p ON p.id = m.product_id
        WHERE l.id = ${licenseId}`;
  const r = rows[0];
  if (!r) return null;
  return {
    licenseId,
    entitlementId: r.ent_id as string,
    customerId: r.customer_id as string,
    status: r.status as 'active' | 'revoked',
    termType: r.term_type as LicenseContext['termType'],
    expiresAt: (r.expires_at as Date | null) ?? null,
    seats: (r.seats as number | null) ?? null,
    transferAllowance: (r.transfer_allowance as number | null) ?? null,
    transferWindowResetAt: (r.transfer_window_reset_at as Date | null) ?? null,
    organisationName: (r.organisation_name as string | null) ?? null,
    customerName: (r.customer_name as string | null) ?? null,
    productMajorId: r.product_major_id as string,
    productSlug: r.slug as string,
    majorVersion: r.major_version as number,
    // Snapshots are validated with EffectivePolicySchema when written and are append-only, so
    // the hot path trusts the stored shape instead of re-parsing it on every request.
    policy: r.snapshot as EffectivePolicy,
    currentEnvelope: (r.current_envelope as Envelope | null) ?? null,
    currentIssuedAt: (r.current_issued_at as Date | null) ?? null,
    entitlementUpdatedAt: r.updated_at as Date,
    licenseUpdatedAt: r.license_updated_at as Date,
  };
}

export class LicensingRefusal extends Error {
  readonly code: 'revoked' | 'subscription_expired';
  constructor(code: 'revoked' | 'subscription_expired', message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Sign a fresh licence for the entitlement (same licenseId, new issuedAt, current expiresAt).
 * Refuses revoked entitlements and expired terms (ADR-0001 §4). Must run inside a transaction
 * so that a signing failure rolls back any seat allocation made in the same transaction.
 */
export async function signLicense(tx: Tx, config: Config, ctx: LicenseContext, actor: Actor, reason: string, now: Date): Promise<Envelope> {
  if (ctx.status === 'revoked') throw new LicensingRefusal('revoked', 'This licence has been revoked.');
  if (ctx.expiresAt && ctx.expiresAt.getTime() <= now.getTime() + 1000) {
    throw new LicensingRefusal('subscription_expired', 'This subscription has expired. Renew it to continue using paid features.');
  }
  const protocol = getProtocol(ctx.policy.protocolId);
  if (!protocol) throw new AppError('internal', `protocol ${ctx.policy.protocolId} not implemented`);
  const claims = protocol.buildLicenseClaims({
    licenseId: ctx.licenseId,
    customerId: ctx.customerId,
    productId: ctx.productSlug,
    majorVersion: ctx.majorVersion,
    edition: ctx.policy.edition.wireId,
    organisation: ctx.organisationName,
    customerName: ctx.customerName,
    issuedAt: now,
    expiresAt: ctx.expiresAt,
    maxActivations: ctx.policy.activationModel === 'device_seats' ? ctx.seats : null,
  });
  const signers = await loadSigners(tx, config.signingKeks, ctx.productMajorId, protocol.maxSignatures);
  const { envelope, payloadBytes } = await buildEnvelope(protocol.licenseFormat, claims, signers, protocol.maxSignatures);
  const keyIds = signers.map((s) => s.keyId);
  const issuedAt = new Date(Math.floor(now.getTime() / 1000) * 1000);
  await tx`UPDATE licenses SET current_envelope = ${tx.json(envelope as never)}, current_issued_at = ${issuedAt}, current_key_ids = ${textArray(tx, keyIds)},
           issue_count = issue_count + 1 WHERE id = ${ctx.licenseId}`;
  await tx`INSERT INTO license_issuances (license_id, artifact, issued_at, payload_sha256, key_ids, reason, actor)
           VALUES (${ctx.licenseId}, 'license', ${issuedAt}, ${await sha256Hex(payloadBytes)}, ${textArray(tx, keyIds)}, ${reason}, ${actor.label})`;
  await audit(tx, actor, { action: 'license.issued', resourceType: 'license', resourceId: ctx.licenseId, detail: { reason, keyIds, expiresAt: ctx.expiresAt } });
  ctx.currentEnvelope = envelope;
  ctx.currentIssuedAt = issuedAt;
  return envelope;
}

/** Return the current licence if it still reflects the entitlement, else re-sign. */
export async function currentOrFreshLicense(tx: Tx, config: Config, ctx: LicenseContext, actor: Actor, reason: string, now: Date): Promise<Envelope> {
  if (ctx.status === 'revoked') throw new LicensingRefusal('revoked', 'This licence has been revoked.');
  // licenses.updated_at is touched (full precision) on every signing, so it orders correctly
  // against any later entitlement change.
  const fresh = !!ctx.currentEnvelope && ctx.licenseUpdatedAt.getTime() >= ctx.entitlementUpdatedAt.getTime();
  const signersStillEligible = fresh ? await currentKeysStillEligible(tx, ctx) : false;
  if (fresh && signersStillEligible && !(ctx.expiresAt && ctx.expiresAt <= now)) return ctx.currentEnvelope!;
  return signLicense(tx, config, ctx, actor, reason, now);
}

async function currentKeysStillEligible(db: Db, ctx: LicenseContext): Promise<boolean> {
  const sigIds = ctx.currentEnvelope!.signatures.map((s) => s.keyId).sort();
  const rows = await db<{ signing_key_id: string }[]>`
    SELECT c.signing_key_id FROM key_compatibilities c JOIN signing_keys k ON k.id = c.signing_key_id
    WHERE c.product_major_id = ${ctx.productMajorId} AND c.eligible AND k.status = 'published' ORDER BY c.signing_key_id`;
  return rows.map((r) => r.signing_key_id).join(',') === sigIds.join(',');
}

export async function signActivationCertificate(
  tx: Tx,
  config: Config,
  ctx: LicenseContext,
  activation: { id: string; deviceId: string },
  actor: Actor,
  now: Date,
): Promise<Envelope> {
  const protocol = getProtocol(ctx.policy.protocolId)!;
  const lifetime = ctx.policy.certificateLifetimeSeconds;
  const claims = protocol.buildActivationClaims({
    activationId: activation.id,
    licenseId: ctx.licenseId,
    productId: ctx.productSlug,
    majorVersion: ctx.majorVersion,
    deviceId: activation.deviceId,
    issuedAt: now,
    expiresAt: lifetime ? new Date(Math.floor(now.getTime() / 1000) * 1000 + lifetime * 1000) : null,
  });
  const signers = await loadSigners(tx, config.signingKeks, ctx.productMajorId, protocol.maxSignatures);
  const { envelope, payloadBytes } = await buildEnvelope(protocol.activationFormat, claims, signers, protocol.maxSignatures);
  const keyIds = signers.map((s) => s.keyId);
  await tx`INSERT INTO license_issuances (license_id, artifact, activation_id, issued_at, payload_sha256, key_ids, reason, actor)
           VALUES (${ctx.licenseId}, 'activation', ${activation.id}, ${new Date(Math.floor(now.getTime() / 1000) * 1000)}, ${await sha256Hex(payloadBytes)}, ${textArray(tx, keyIds)}, 'activation', ${actor.label})`;
  return envelope;
}

// ---------------------------------------------------------------------------------------------
// Support / customer operations (shared by admin UI, admin API and customer portal)
// ---------------------------------------------------------------------------------------------

async function lockLicense(tx: Tx, licenseId: string): Promise<LicenseContext> {
  const ctx = await loadLicenseContext(tx, licenseId, true);
  if (!ctx) throw notFound('Licence');
  return ctx;
}

export async function revokeEntitlement(sql: Sql, actor: Actor, licenseId: string, input: { reason: string; source?: 'admin' | 'stripe_refund' | 'stripe_dispute' | 'system'; sourceRef?: string | null }) {
  if (actor.type !== 'stripe' && actor.type !== 'system') requireHighRisk(actor, 'entitlements:revoke');
  if (!input.reason?.trim()) throw invalid('A revocation reason is required');
  return sql.begin(async (tx) => revokeInTx(tx, actor, licenseId, input));
}

export async function revokeInTx(tx: Tx, actor: Actor, licenseId: string, input: { reason: string; source?: 'admin' | 'stripe_refund' | 'stripe_dispute' | 'system'; sourceRef?: string | null }) {
  const ctx = await lockLicense(tx, licenseId);
  const source = input.source ?? 'admin';
  const inserted = await tx`INSERT INTO revocations (entitlement_id, action, reason, source, source_ref, actor)
                            VALUES (${ctx.entitlementId}, 'revoke', ${input.reason}, ${source}, ${input.sourceRef ?? null}, ${actor.label})
                            ON CONFLICT (entitlement_id, source, source_ref, action) DO NOTHING RETURNING id`;
  if (ctx.status === 'revoked' || inserted.length === 0) return { licenseId, status: 'revoked', changed: false };
  await tx`UPDATE entitlements SET status = 'revoked', revoked_at = now(), revoked_reason = ${input.reason} WHERE id = ${ctx.entitlementId}`;
  await audit(tx, actor, { action: 'entitlement.revoked', resourceType: 'entitlement', resourceId: ctx.entitlementId, detail: { licenseId, reason: input.reason, source, sourceRef: input.sourceRef ?? null } });
  return { licenseId, status: 'revoked', changed: true };
}

export async function unrevokeEntitlement(sql: Sql, actor: Actor, licenseId: string, reason: string) {
  requireHighRisk(actor, 'entitlements:revoke');
  if (!reason?.trim()) throw invalid('A reason is required');
  return sql.begin(async (tx) => {
    const ctx = await lockLicense(tx, licenseId);
    if (ctx.status !== 'revoked') throw conflict('Licence is not revoked');
    await tx`INSERT INTO revocations (entitlement_id, action, reason, source, source_ref, actor) VALUES (${ctx.entitlementId}, 'unrevoke', ${reason}, 'admin', ${newId('req')}, ${actor.label})`;
    await tx`UPDATE entitlements SET status = 'active', revoked_at = NULL, revoked_reason = NULL WHERE id = ${ctx.entitlementId}`;
    await audit(tx, actor, { action: 'entitlement.unrevoked', resourceType: 'entitlement', resourceId: ctx.entitlementId, detail: { licenseId, reason } });
    return { licenseId, status: 'active' };
  });
}

/** Re-sign with the same licenseId (e.g. organisation rename). Brief §8. */
export async function reissueLicense(sql: Sql, config: Config, actor: Actor, licenseId: string, input: { reason: string; organisationName?: string | null; customerName?: string | null }, now = new Date()) {
  requirePermission(actor, 'licenses:issue');
  return sql.begin(async (tx) => {
    const ctx = await lockLicense(tx, licenseId);
    if (input.organisationName !== undefined || input.customerName !== undefined) {
      const org = input.organisationName === undefined ? ctx.organisationName : input.organisationName?.trim() || null;
      const name = input.customerName === undefined ? ctx.customerName : input.customerName?.trim() || null;
      if ((org && org.includes('@')) || (name && name.includes('@'))) throw invalid('Names in licences must not contain email addresses');
      await tx`UPDATE entitlements SET organisation_name = ${org}, customer_name = ${name} WHERE id = ${ctx.entitlementId}`;
      ctx.organisationName = org;
      ctx.customerName = name;
    }
    const env = await signLicense(tx, config, ctx, actor, `reissue: ${input.reason}`, now);
    return { licenseId, envelope: env };
  });
}

/**
 * Explicit, audited policy amendment for one entitlement (e.g. support changes seats).
 * Creates a new immutable snapshot; never silently follows catalogue edits.
 */
export async function amendEntitlement(sql: Sql, actor: Actor, licenseId: string, input: { seats?: number; transferAllowance?: number; expiresAt?: Date; reason: string }) {
  requirePermission(actor, 'entitlements:issue');
  if (!input.reason?.trim()) throw invalid('A reason is required');
  return sql.begin(async (tx) => {
    const ctx = await lockLicense(tx, licenseId);
    const policy: EffectivePolicy = { ...ctx.policy };
    if (input.seats !== undefined) {
      if (policy.activationModel !== 'device_seats') throw invalid('Seats only apply to device-seat entitlements');
      if (!Number.isInteger(input.seats) || input.seats < 1) throw invalid('seats must be >= 1');
      policy.seats = input.seats;
    }
    if (input.transferAllowance !== undefined) {
      if (policy.activationModel !== 'device_seats') throw invalid('Transfers only apply to device-seat entitlements');
      policy.transferAllowance = input.transferAllowance;
    }
    if (input.expiresAt !== undefined && ctx.termType === 'perpetual') throw invalid('Perpetual entitlements do not expire');
    const snapshotId = newId('eps');
    await tx`INSERT INTO entitlement_policy_snapshots (id, snapshot, reason, created_by) VALUES (${snapshotId}, ${tx.json(EffectivePolicySchema.parse(policy) as never)}, ${'amendment: ' + input.reason}, ${actor.label})`;
    await tx`UPDATE entitlements SET policy_snapshot_id = ${snapshotId}, seats = ${policy.seats}, transfer_allowance = ${policy.transferAllowance},
             expires_at = coalesce(${input.expiresAt ?? null}::timestamptz, expires_at) WHERE id = ${ctx.entitlementId}`;
    await audit(tx, actor, { action: 'entitlement.amended', resourceType: 'entitlement', resourceId: ctx.entitlementId, detail: { licenseId, seats: input.seats, transferAllowance: input.transferAllowance, expiresAt: input.expiresAt, reason: input.reason } });
    return { licenseId, seats: policy.seats, transferAllowance: policy.transferAllowance };
  });
}

/** Rotate the activation key: the old key stops working; activations are unaffected. */
export async function rotateActivationKey(sql: Sql, config: Config, actor: Actor, licenseId: string): Promise<{ licenseId: string; activationKey: string; keyHint: string }> {
  if (actor.type !== 'customer') requirePermission(actor, 'licenses:issue');
  return sql.begin(async (tx) => {
    await lockLicense(tx, licenseId);
    await tx`UPDATE activation_keys SET status = 'rotated', rotated_at = now(), reveal_ciphertext = NULL WHERE license_id = ${licenseId} AND status = 'active'`;
    const ak = await storeNewActivationKey(tx, config, licenseId, actor.label);
    // The new key is returned now; the reveal slot is cleared so it is shown exactly once.
    await tx`UPDATE activation_keys SET reveal_ciphertext = NULL, reveal_expires_at = NULL WHERE id = ${ak.id}`;
    await audit(tx, actor, { action: 'activation_key.rotated', resourceType: 'license', resourceId: licenseId, detail: { keyHint: ak.key.slice(-5) } });
    await notifyOwner(tx, config, licenseId, 'activation_key_rotated', `key_rotated:${ak.id}`, { rotatedBy: actor.type === 'customer' ? 'a member of your organisation' : 'RePassCloud support' });
    return { licenseId, activationKey: ak.key, keyHint: ak.key.slice(-5) };
  });
}

/** One-time reveal of an unrevealed activation key to its owner (ADR-0001 §5). */
export async function revealActivationKey(sql: Sql, config: Config, actor: Actor, licenseId: string): Promise<string | null> {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ id: string; reveal_ciphertext: Uint8Array | null; reveal_key_version: number | null; reveal_expires_at: Date | null }[]>`
      SELECT id, reveal_ciphertext, reveal_key_version, reveal_expires_at FROM activation_keys WHERE license_id = ${licenseId} AND status = 'active' FOR UPDATE`;
    if (!row?.reveal_ciphertext || !row.reveal_key_version || (row.reveal_expires_at && row.reveal_expires_at < new Date())) return null;
    const plain = await openCompact(config.appDataKeys, toBytes(row.reveal_ciphertext), row.reveal_key_version, appDataAad('activation-key-reveal', row.id));
    await tx`UPDATE activation_keys SET reveal_ciphertext = NULL, reveal_expires_at = NULL WHERE id = ${row.id}`;
    await audit(tx, actor, { action: 'activation_key.revealed', resourceType: 'license', resourceId: licenseId });
    return decodeUtf8(plain);
  });
}

/** Release a device seat from the portal or by support. Counts toward transfers when replaced. */
/** Security notification to the customer's billing contact about a licence. */
async function notifyOwner(tx: Tx, config: Config, licenseId: string, templateKey: string, businessKey: string, vars: Record<string, string>) {
  const [c] = await tx<{ billing_email: string }[]>`SELECT c.billing_email FROM licenses l JOIN entitlements e ON e.id = l.entitlement_id JOIN customers c ON c.id = e.customer_id WHERE l.id = ${licenseId}`;
  if (c) await enqueueEmail(tx, config, { businessKey, templateKey, category: 'security', to: c.billing_email, vars: { licenseId, ...vars } });
}

export async function releaseActivation(sql: Sql, actor: Actor, activationId: string, by: 'portal' | 'support', config?: Config) {
  if (by === 'support') requirePermission(actor, 'activations:release');
  return sql.begin(async (tx) => {
    const [a] = await tx<{ license_id: string; status: string }[]>`SELECT license_id, status FROM activations WHERE id = ${activationId}`;
    if (!a) throw notFound('Activation');
    await lockLicense(tx, a.license_id);
    if (a.status !== 'active') return { activationId, status: 'inactive', changed: false, licenseId: a.license_id };
    await tx`UPDATE activations SET status = 'inactive', deactivated_at = now(), deactivated_by = ${by} WHERE id = ${activationId}`;
    await audit(tx, actor, { action: 'activation.released', resourceType: 'activation', resourceId: activationId, detail: { licenseId: a.license_id, by } });
    if (config) {
      const [d] = await tx<{ device_id: string }[]>`SELECT device_id FROM activations WHERE id = ${activationId}`;
      await notifyOwner(tx, config, a.license_id, 'device_released', `device_released:${activationId}`, { activationId, deviceSuffix: d!.device_id.slice(-8), releasedBy: by === 'portal' ? 'a member of your organisation' : 'RePassCloud support' });
    }
    return { activationId, status: 'inactive', changed: true, licenseId: a.license_id };
  });
}

export async function grantTransfers(sql: Sql, actor: Actor, licenseId: string, amount: number, reason: string) {
  requirePermission(actor, 'transfers:write');
  if (!Number.isInteger(amount) || amount < 1 || amount > 100) throw invalid('amount must be 1..100');
  if (!reason?.trim()) throw invalid('A reason is required');
  return sql.begin(async (tx) => {
    await lockLicense(tx, licenseId);
    await tx`INSERT INTO transfer_events (license_id, kind, amount, actor) VALUES (${licenseId}, 'grant', ${amount}, ${actor.label})`;
    await audit(tx, actor, { action: 'transfers.granted', resourceType: 'license', resourceId: licenseId, detail: { amount, reason } });
    return transferStatus(tx, licenseId);
  });
}

export async function resetTransfers(sql: Sql, actor: Actor, licenseId: string, reason: string) {
  requirePermission(actor, 'transfers:write');
  if (!reason?.trim()) throw invalid('A reason is required');
  return sql.begin(async (tx) => {
    const ctx = await lockLicense(tx, licenseId);
    await tx`UPDATE entitlements SET transfer_window_reset_at = now() WHERE id = ${ctx.entitlementId}`;
    await tx`INSERT INTO transfer_events (license_id, kind, amount, actor) VALUES (${licenseId}, 'reset', 0, ${actor.label})`;
    await audit(tx, actor, { action: 'transfers.reset', resourceType: 'license', resourceId: licenseId, detail: { reason } });
    return transferStatus(tx, licenseId);
  });
}

/**
 * Transfers used in the trailing 365 days (since the last support reset), net of support
 * grants in the same window. Brief §6.2.
 */
export async function transferStatus(db: Db, licenseId: string, now = new Date()) {
  const [r] = await db<{ allowance: number | null; used: number; granted: number }[]>`
    SELECT e.transfer_allowance AS allowance,
      coalesce((SELECT sum(t.amount) FROM transfer_events t WHERE t.license_id = l.id AND t.kind = 'transfer'
                AND t.occurred_at > greatest(${now}::timestamptz - interval '365 days', coalesce(e.transfer_window_reset_at, '-infinity'))), 0)::int AS used,
      coalesce((SELECT sum(t.amount) FROM transfer_events t WHERE t.license_id = l.id AND t.kind = 'grant'
                AND t.occurred_at > greatest(${now}::timestamptz - interval '365 days', coalesce(e.transfer_window_reset_at, '-infinity'))), 0)::int AS granted
    FROM licenses l JOIN entitlements e ON e.id = l.entitlement_id WHERE l.id = ${licenseId}`;
  if (!r) throw notFound('Licence');
  const allowance = r.allowance ?? 0;
  const effectiveUsed = Math.max(0, r.used - r.granted);
  return { allowance, used: r.used, granted: r.granted, remaining: Math.max(0, allowance - effectiveUsed) };
}

export function licenceFileName(template: string, ctx: { productSlug: string; majorVersion: number; edition: string; licenseId: string }): string {
  return template
    .replace('{product}', ctx.productSlug)
    .replace('{major}', String(ctx.majorVersion))
    .replace('{edition}', ctx.edition)
    .replace('{licenseId}', ctx.licenseId)
    .replace(/[^A-Za-z0-9_.-]/g, '_');
}

/**
 * Licence file for download (portal/admin). Re-signs when the entitlement changed since the last
 * signing; for an expired subscription returns the last validly signed artifact (ADR-0001 §4).
 */
export async function licenseFileForDownload(sql: Sql, config: Config, actor: Actor, licenseId: string, now = new Date()): Promise<{ fileName: string; envelope: Envelope }> {
  return sql.begin(async (tx) => {
    const ctx = await lockLicense(tx, licenseId);
    if (ctx.status === 'revoked') throw new AppError('forbidden', 'This licence has been revoked.');
    let envelope: Envelope;
    try {
      envelope = await currentOrFreshLicense(tx, config, ctx, actor, 'download', now);
    } catch (e) {
      if (e instanceof LicensingRefusal && e.code === 'subscription_expired' && ctx.currentEnvelope) envelope = ctx.currentEnvelope;
      else if (e instanceof LicensingRefusal) throw new AppError('precondition_failed', e.message);
      else throw e;
    }
    const [m] = await tx<{ licence_file_name_template: string }[]>`SELECT licence_file_name_template FROM product_majors WHERE id = ${ctx.productMajorId}`;
    await audit(tx, actor, { action: 'license.downloaded', resourceType: 'license', resourceId: licenseId });
    return { fileName: licenceFileName(m!.licence_file_name_template, { productSlug: ctx.productSlug, majorVersion: ctx.majorVersion, edition: ctx.policy.edition.wireId, licenseId }), envelope };
  });
}
