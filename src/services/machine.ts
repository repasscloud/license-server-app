// The binding v1 machine API (brief §5): activate/provision, renew, deactivate.
// Authenticated by activation keys or per-activation client secrets only — never by customer
// sessions or admin tokens. Seat allocation is serialised per licence with SELECT ... FOR UPDATE
// and protected by a partial unique index; signing happens inside the same transaction so any
// failure (e.g. no eligible key) rolls back the seat.

import type { Config } from '../config.ts';
import type { Envelope } from '../crypto/envelope.ts';
import { constantTimeEqual } from '../crypto/hashing.ts';
import { toBytes, type Sql, type Tx } from '../db/client.ts';
import { base64UrlDecode } from '../lib/encoding.ts';
import { newId, WIRE_ID_RE } from '../lib/ids.ts';
import type { Actor } from './actor.ts';
import { audit } from './audit.ts';
import {
  currentOrFreshLicense,
  hashActivationKey,
  hashClientSecret,
  LicensingRefusal,
  loadLicenseContext,
  normaliseActivationKey,
  signActivationCertificate,
  signLicense,
  transferStatus,
  type LicenseContext,
} from './licensing.ts';

export type MachineErrorCode =
  | 'invalid_request' | 'unauthorized' | 'revoked' | 'invalid_key' | 'not_found' | 'seat_limit'
  | 'transfer_limit' | 'activation_inactive' | 'subscription_expired' | 'product_mismatch'
  | 'version_mismatch' | 'rate_limited' | 'server_error';

export const MACHINE_STATUS: Record<MachineErrorCode, number> = {
  invalid_request: 400, unauthorized: 401, revoked: 403, invalid_key: 404, not_found: 404,
  seat_limit: 409, transfer_limit: 409, activation_inactive: 409, subscription_expired: 409,
  product_mismatch: 422, version_mismatch: 422, rate_limited: 429, server_error: 503,
};

const MESSAGES: Record<MachineErrorCode, string> = {
  invalid_request: 'The request was malformed.',
  unauthorized: 'This device is not authorised for that activation.',
  revoked: 'This licence has been revoked. Contact support if you believe this is a mistake.',
  invalid_key: 'That activation key was not recognised.',
  not_found: 'That licence or activation was not found.',
  seat_limit: 'All seats for this licence are in use. Release a device in the customer portal or ask your administrator.',
  transfer_limit: 'This licence has used its device transfer allowance for the last 12 months. Contact support for more transfers.',
  activation_inactive: 'This activation has been released.',
  subscription_expired: 'This subscription has expired. Renew it to continue using paid features.',
  product_mismatch: 'This key or licence is for a different product.',
  version_mismatch: 'This key or licence is for a different major version.',
  rate_limited: 'Too many requests. Try again later.',
  server_error: 'The licensing server is temporarily unavailable.',
};

export class MachineError extends Error {
  readonly code: MachineErrorCode;
  constructor(code: MachineErrorCode, message = MESSAGES[code]) {
    super(message);
    this.code = code;
  }
  get status() {
    return MACHINE_STATUS[this.code];
  }
}

// Hand-written validators (not zod) on the hot path: they cost no first-use compilation, which
// matters for cold-isolate CPU on Workers Free. Bodies are strict: unknown fields are rejected.
type Parsed<T> = { success: true; data: T } | { success: false };
const PRINTABLE = /^[\x21-\x7e]+$/;
const isPrintable = (v: unknown, max: number): v is string => typeof v === 'string' && v.length >= 1 && v.length <= max && PRINTABLE.test(v);
const isWireId = (v: unknown): v is string => typeof v === 'string' && WIRE_ID_RE.test(v);
const isMajor = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 1_000_000;
function isClientSecret(v: unknown): v is string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v)) return false;
  try {
    return base64UrlDecode(v).length === 32;
  } catch {
    return false;
  }
}
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface ActivateInput { productId: string; majorVersion: number; activationKey: string; deviceId: string; clientSecret: string }
export interface RenewInput { productId: string; majorVersion: number; activation?: { activationId: string; deviceId: string; clientSecret: string } | null }
export interface DeactivateInput { productId: string; majorVersion: number; deviceId: string; clientSecret: string }

export const ActivateBody = {
  safeParse(b: unknown): Parsed<ActivateInput> {
    if (!isObj(b) || !onlyKeys(b, ['productId', 'majorVersion', 'activationKey', 'deviceId', 'clientSecret'])) return { success: false };
    if (!isWireId(b.productId) || !isMajor(b.majorVersion) || !isPrintable(b.activationKey, 256) || !isPrintable(b.deviceId, 256) || !isClientSecret(b.clientSecret)) return { success: false };
    return { success: true, data: b as unknown as ActivateInput };
  },
};

export const RenewBody = {
  safeParse(b: unknown): Parsed<RenewInput> {
    if (!isObj(b) || !onlyKeys(b, ['productId', 'majorVersion', 'activation']) || !isWireId(b.productId) || !isMajor(b.majorVersion)) return { success: false };
    const a = b.activation;
    if (a !== undefined && a !== null) {
      if (!isObj(a) || !onlyKeys(a, ['activationId', 'deviceId', 'clientSecret']) || !isWireId(a.activationId) || !isPrintable(a.deviceId, 256) || !isClientSecret(a.clientSecret)) return { success: false };
    }
    return { success: true, data: b as unknown as RenewInput };
  },
};

export const DeactivateBody = {
  safeParse(b: unknown): Parsed<DeactivateInput> {
    if (!isObj(b) || !onlyKeys(b, ['productId', 'majorVersion', 'deviceId', 'clientSecret'])) return { success: false };
    if (!isWireId(b.productId) || !isMajor(b.majorVersion) || !isPrintable(b.deviceId, 256) || !isClientSecret(b.clientSecret)) return { success: false };
    return { success: true, data: b as unknown as DeactivateInput };
  },
};

export interface MachineResponse {
  license: Envelope;
  activation: Envelope | null;
}

function checkProduct(ctx: LicenseContext, productId: string, major: number) {
  if (ctx.productSlug !== productId) throw new MachineError('product_mismatch');
  if (ctx.majorVersion !== major) throw new MachineError('version_mismatch');
}

function mapRefusal(e: unknown): never {
  if (e instanceof LicensingRefusal) throw new MachineError(e.code);
  throw e;
}

/** POST /v1/activations */
export async function activate(sql: Sql, config: Config, actor: Actor, body: ActivateInput, now = new Date()): Promise<MachineResponse> {
  const canonical = normaliseActivationKey(body.activationKey);
  if (!canonical) {
    await audit(sql, actor, { action: 'machine.activate', outcome: 'failure', detail: { error: 'invalid_key' } });
    throw new MachineError('invalid_key');
  }
  const keyHash = await hashActivationKey(config, canonical);
  const [key] = await sql<{ license_id: string }[]>`SELECT license_id FROM activation_keys WHERE key_hash = ${keyHash} AND status = 'active'`;
  if (!key) {
    await audit(sql, actor, { action: 'machine.activate', outcome: 'failure', detail: { error: 'invalid_key', keyHint: canonical.slice(-5) } });
    throw new MachineError('invalid_key');
  }
  const licenseId = key.license_id;
  try {
    return await sql.begin(async (tx) => {
      // Serialise all seat work for this licence.
      const ctx = await loadLicenseContext(tx, licenseId, true);
      if (!ctx) throw new MachineError('invalid_key');
      checkProduct(ctx, body.productId, body.majorVersion);
      if (ctx.status === 'revoked') throw new MachineError('revoked');
      if (ctx.expiresAt && ctx.expiresAt <= now) throw new MachineError('subscription_expired');

      if (ctx.policy.activationModel === 'none') {
        // Provisioning only: ignore and never store deviceId/clientSecret (brief §5.1 step 3).
        const license = await currentOrFreshLicense(tx, config, ctx, actor, 'provision', now).catch(mapRefusal);
        await audit(tx, actor, { action: 'machine.provision', resourceType: 'license', resourceId: licenseId });
        return { license, activation: null };
      }

      const secretHash = await hashClientSecret(config, licenseId, body.clientSecret);
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM activations WHERE license_id = ${licenseId} AND device_id = ${body.deviceId} AND status = 'active'`;
      let activationId: string;
      if (existing) {
        // Same device re-activating: reuse seat and activationId; rotate the stored secret hash.
        activationId = existing.id;
        await tx`UPDATE activations SET client_secret_hash = ${secretHash}, last_validated_at = ${now} WHERE id = ${activationId}`;
        await audit(tx, actor, { action: 'activation.reused', resourceType: 'activation', resourceId: activationId, detail: { licenseId } });
      } else {
        const [counts] = await tx<{ active: number; fresh_used: number }[]>`
          SELECT count(*) FILTER (WHERE status = 'active')::int AS active,
                 count(*) FILTER (WHERE NOT counted_as_transfer)::int AS fresh_used
          FROM activations WHERE license_id = ${licenseId}`;
        const seats = ctx.seats ?? 0;
        if (counts!.active >= seats) throw new MachineError('seat_limit');
        // Filling a never-used seat is free; re-using a released seat is a transfer (brief §6.2).
        const isTransfer = counts!.fresh_used >= seats;
        if (isTransfer) {
          const t = await transferStatus(tx, licenseId, now);
          if (t.remaining <= 0) throw new MachineError('transfer_limit');
        }
        activationId = newId('act');
        await tx`INSERT INTO activations (id, license_id, device_id, client_secret_hash, status, counted_as_transfer, activated_at, last_validated_at)
                 VALUES (${activationId}, ${licenseId}, ${body.deviceId}, ${secretHash}, 'active', ${isTransfer}, ${now}, ${now})`;
        if (isTransfer) await tx`INSERT INTO transfer_events (license_id, activation_id, kind, amount, actor) VALUES (${licenseId}, ${activationId}, 'transfer', 1, ${actor.label})`;
        await audit(tx, actor, { action: 'activation.created', resourceType: 'activation', resourceId: activationId, detail: { licenseId, transfer: isTransfer, deviceSuffix: body.deviceId.slice(-8) } });
      }
      const license = await currentOrFreshLicense(tx, config, ctx, actor, 'activate', now).catch(mapRefusal);
      const activation = await signActivationCertificate(tx, config, ctx, { id: activationId, deviceId: body.deviceId }, actor, now);
      return { license, activation };
    });
  } catch (e) {
    if (e instanceof MachineError) {
      await audit(sql, actor, { action: 'machine.activate', resourceType: 'license', resourceId: licenseId, outcome: e.code === 'seat_limit' || e.code === 'transfer_limit' ? 'denied' : 'failure', detail: { error: e.code } });
    }
    throw e;
  }
}

async function verifyActivationCredentials(
  tx: Tx,
  config: Config,
  licenseId: string | null,
  activationId: string,
  deviceId: string,
  secret: string,
) {
  const [a] = await tx<{ id: string; license_id: string; device_id: string; client_secret_hash: Uint8Array; status: string }[]>`
    SELECT id, license_id, device_id, client_secret_hash, status FROM activations WHERE id = ${activationId}`;
  if (!a || (licenseId !== null && a.license_id !== licenseId)) throw new MachineError('not_found');
  const expected = toBytes(a.client_secret_hash);
  const actual = await hashClientSecret(config, a.license_id, secret);
  // Evaluate both checks before branching to keep timing uniform.
  const secretOk = constantTimeEqual(expected, actual);
  const deviceOk = a.device_id === deviceId;
  if (!(secretOk && deviceOk)) throw new MachineError('unauthorized');
  return a;
}

/** POST /v1/licenses/{licenseId}/renew */
export async function renew(sql: Sql, config: Config, actor: Actor, licenseId: string, body: RenewInput, now = new Date()): Promise<MachineResponse> {
  if (!WIRE_ID_RE.test(licenseId)) throw new MachineError('invalid_request');
  try {
    return await sql.begin(async (tx) => {
      const ctx = await loadLicenseContext(tx, licenseId, true);
      if (!ctx) throw new MachineError('not_found');
      checkProduct(ctx, body.productId, body.majorVersion);
      if (ctx.status === 'revoked') throw new MachineError('revoked');
      let activationEnvelope: Envelope | null = null;
      let act: { id: string; device_id: string } | null = null;
      if (body.activation) {
        const a = await verifyActivationCredentials(tx, config, licenseId, body.activation.activationId, body.activation.deviceId, body.activation.clientSecret);
        if (a.status !== 'active') throw new MachineError('activation_inactive');
        act = a;
      }
      const license = await signLicense(tx, config, ctx, actor, 'renew', now).catch(mapRefusal);
      if (act) {
        await tx`UPDATE activations SET last_validated_at = ${now} WHERE id = ${act.id}`;
        activationEnvelope = await signActivationCertificate(tx, config, ctx, { id: act.id, deviceId: act.device_id }, actor, now);
      }
      await audit(tx, actor, { action: 'machine.renew', resourceType: 'license', resourceId: licenseId, detail: { activationId: act?.id ?? null } });
      return { license, activation: activationEnvelope };
    });
  } catch (e) {
    if (e instanceof MachineError) await audit(sql, actor, { action: 'machine.renew', resourceType: 'license', resourceId: licenseId, outcome: 'failure', detail: { error: e.code } });
    throw e;
  }
}

/** POST /v1/activations/{activationId}/deactivate — releases the seat even when revoked. */
export async function deactivate(sql: Sql, config: Config, actor: Actor, activationId: string, body: DeactivateInput, now = new Date()): Promise<void> {
  if (!WIRE_ID_RE.test(activationId)) throw new MachineError('invalid_request');
  try {
    await sql.begin(async (tx) => {
      const [pre] = await tx<{ license_id: string }[]>`SELECT license_id FROM activations WHERE id = ${activationId}`;
      if (!pre) throw new MachineError('not_found');
      const ctx = await loadLicenseContext(tx, pre.license_id, true);
      if (!ctx) throw new MachineError('not_found');
      checkProduct(ctx, body.productId, body.majorVersion);
      const a = await verifyActivationCredentials(tx, config, pre.license_id, activationId, body.deviceId, body.clientSecret);
      if (a.status !== 'active') throw new MachineError('activation_inactive');
      await tx`UPDATE activations SET status = 'inactive', deactivated_at = ${now}, deactivated_by = 'client' WHERE id = ${activationId}`;
      await audit(tx, actor, { action: 'activation.released', resourceType: 'activation', resourceId: activationId, detail: { licenseId: pre.license_id, by: 'client' } });
    });
  } catch (e) {
    if (e instanceof MachineError) await audit(sql, actor, { action: 'machine.deactivate', resourceType: 'activation', resourceId: activationId, outcome: 'failure', detail: { error: e.code } });
    throw e;
  }
}
