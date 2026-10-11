// repass-*-v1 claim construction and validation (brief §4.4–§4.5). The validators mirror what
// v1 clients enforce, so the server refuses to sign anything a client would reject.

import { WIRE_ID_RE } from '../lib/ids.ts';
import { rfc3339 } from '../lib/time.ts';

export const V1_LICENSE_FORMAT = 'repass-license-v1';
export const V1_ACTIVATION_FORMAT = 'repass-activation-v1';
export const V1_EDITIONS = ['community', 'education', 'business', 'enterprise'] as const;
export type V1Edition = (typeof V1_EDITIONS)[number];

const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface LicenseClaimsInput {
  licenseId: string;
  customerId: string;
  productId: string;
  majorVersion: number;
  edition: string;
  organisation?: string | null;
  customerName?: string | null;
  issuedAt: Date;
  expiresAt: Date | null; // null => perpetual
  maxActivations?: number | null;
}

/** Build claims in the brief's field order. Optional fields are omitted when absent. */
export function buildLicenseClaimsV1(i: LicenseClaimsInput): Record<string, unknown> {
  const c: Record<string, unknown> = {
    schemaVersion: 1,
    licenseId: i.licenseId,
    customerId: i.customerId,
    productId: i.productId,
    majorVersion: i.majorVersion,
    edition: i.edition,
  };
  if (i.organisation) c.organisation = i.organisation;
  if (i.customerName) c.customerName = i.customerName;
  c.issuedAt = rfc3339(i.issuedAt);
  c.perpetual = i.expiresAt === null;
  c.expiresAt = i.expiresAt === null ? null : rfc3339(i.expiresAt);
  if (i.maxActivations !== null && i.maxActivations !== undefined) c.maxActivations = i.maxActivations;
  const errs = validateLicenseClaimsV1(c);
  if (errs.length) throw new ClaimsError(errs);
  return c;
}

export interface ActivationClaimsInput {
  activationId: string;
  licenseId: string;
  productId: string;
  majorVersion: number;
  deviceId: string;
  issuedAt: Date;
  expiresAt: Date | null;
}

export function buildActivationClaimsV1(i: ActivationClaimsInput): Record<string, unknown> {
  const c: Record<string, unknown> = {
    schemaVersion: 1,
    activationId: i.activationId,
    licenseId: i.licenseId,
    productId: i.productId,
    majorVersion: i.majorVersion,
    deviceId: i.deviceId,
    issuedAt: rfc3339(i.issuedAt),
    expiresAt: i.expiresAt === null ? null : rfc3339(i.expiresAt),
  };
  const errs = validateActivationClaimsV1(c);
  if (errs.length) throw new ClaimsError(errs);
  return c;
}

export class ClaimsError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid v1 claims: ${problems.join('; ')}`);
  }
}

const LICENSE_FIELDS = new Set([
  'schemaVersion', 'licenseId', 'customerId', 'productId', 'majorVersion', 'edition',
  'organisation', 'customerName', 'issuedAt', 'perpetual', 'expiresAt', 'maxActivations',
]);

function isEmail(s: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(s);
}

export function validateLicenseClaimsV1(c: Record<string, unknown>): string[] {
  const e: string[] = [];
  for (const k of Object.keys(c)) if (!LICENSE_FIELDS.has(k)) e.push(`unknown field ${k}`);
  if (c.schemaVersion !== 1) e.push('schemaVersion must be 1');
  for (const k of ['licenseId', 'customerId', 'productId'] as const) {
    if (typeof c[k] !== 'string' || !WIRE_ID_RE.test(c[k] as string)) e.push(`${k} must be a wire identifier`);
  }
  if (typeof c.customerId === 'string' && isEmail(c.customerId)) e.push('customerId must not be an email address');
  if (!Number.isSafeInteger(c.majorVersion) || (c.majorVersion as number) < 0) e.push('majorVersion must be a non-negative integer');
  if (!(V1_EDITIONS as readonly unknown[]).includes(c.edition)) e.push('edition must be a v1 edition id');
  for (const k of ['organisation', 'customerName'] as const) {
    if (k in c) {
      if (typeof c[k] !== 'string' || (c[k] as string).trim().length === 0) e.push(`${k} must be non-empty when present`);
      else if (isEmail(c[k] as string)) e.push(`${k} must not contain an email address`);
    }
  }
  if (typeof c.issuedAt !== 'string' || !RFC3339_Z.test(c.issuedAt)) e.push('issuedAt must be RFC 3339 UTC whole seconds');
  if (typeof c.perpetual !== 'boolean') e.push('perpetual must be boolean');
  if (c.perpetual === true) {
    if (c.expiresAt !== null && c.expiresAt !== undefined) e.push('perpetual licences must not expire');
  } else if (c.perpetual === false) {
    if (typeof c.expiresAt !== 'string' || !RFC3339_Z.test(c.expiresAt)) e.push('expiresAt required when not perpetual');
    else if (typeof c.issuedAt === 'string' && c.expiresAt <= c.issuedAt) e.push('expiresAt must be later than issuedAt');
    if (c.edition !== 'business') e.push('only business licences may be non-perpetual');
  }
  if (c.edition === 'business') {
    if (!Number.isSafeInteger(c.maxActivations) || (c.maxActivations as number) < 1) e.push('business requires maxActivations >= 1');
  } else if ('maxActivations' in c) {
    e.push('maxActivations is only allowed for business');
  }
  return e;
}

const ACTIVATION_FIELDS = new Set(['schemaVersion', 'activationId', 'licenseId', 'productId', 'majorVersion', 'deviceId', 'issuedAt', 'expiresAt']);

export function validateActivationClaimsV1(c: Record<string, unknown>): string[] {
  const e: string[] = [];
  for (const k of Object.keys(c)) if (!ACTIVATION_FIELDS.has(k)) e.push(`unknown field ${k}`);
  if (c.schemaVersion !== 1) e.push('schemaVersion must be 1');
  for (const k of ['activationId', 'licenseId', 'productId'] as const) {
    if (typeof c[k] !== 'string' || !WIRE_ID_RE.test(c[k] as string)) e.push(`${k} must be a wire identifier`);
  }
  if (!Number.isSafeInteger(c.majorVersion) || (c.majorVersion as number) < 0) e.push('majorVersion must be a non-negative integer');
  if (typeof c.deviceId !== 'string' || c.deviceId.length === 0) e.push('deviceId required');
  if (typeof c.issuedAt !== 'string' || !RFC3339_Z.test(c.issuedAt)) e.push('issuedAt must be RFC 3339 UTC whole seconds');
  if (c.expiresAt !== null && c.expiresAt !== undefined) {
    if (typeof c.expiresAt !== 'string' || !RFC3339_Z.test(c.expiresAt)) e.push('expiresAt must be RFC 3339 or null');
    else if (typeof c.issuedAt === 'string' && c.expiresAt <= c.issuedAt) e.push('expiresAt must be later than issuedAt');
  }
  return e;
}
