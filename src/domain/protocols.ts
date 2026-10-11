// Wire-protocol registry. A protocol is CODE: it defines the claims and rules a client
// release verifies. Products select a protocol per major in the database; only protocols
// implemented here can be used. See ADR-0001.

import type { EffectivePolicy, PolicyProblem } from './policy.ts';
import {
  V1_ACTIVATION_FORMAT,
  V1_EDITIONS,
  V1_LICENSE_FORMAT,
  buildActivationClaimsV1,
  buildLicenseClaimsV1,
  type ActivationClaimsInput,
  type LicenseClaimsInput,
} from './v1-claims.ts';

export interface LicenseProtocol {
  id: string;
  licenseFormat: string;
  activationFormat: string;
  maxSignatures: number;
  validatePolicy(p: EffectivePolicy): PolicyProblem[];
  buildLicenseClaims(i: LicenseClaimsInput): Record<string, unknown>;
  buildActivationClaims(i: ActivationClaimsInput): Record<string, unknown>;
}

const repassV1: LicenseProtocol = {
  id: 'repass-v1',
  licenseFormat: V1_LICENSE_FORMAT,
  activationFormat: V1_ACTIVATION_FORMAT,
  maxSignatures: 8,
  validatePolicy(p) {
    const out: PolicyProblem[] = [];
    const wire = p.edition.wireId;
    if (!(V1_EDITIONS as readonly string[]).includes(wire)) {
      out.push({ rule: 'v1.edition', message: `repass-v1 clients only understand editions ${V1_EDITIONS.join(', ')}` });
    }
    const isBusiness = wire === 'business';
    if (p.term.type !== 'perpetual' && !isBusiness) {
      out.push({ rule: 'v1.perpetual', message: `repass-v1 clients reject non-perpetual ${wire} licences; only business may be ${p.term.type}` });
    }
    if (isBusiness && p.activationModel !== 'device_seats') {
      out.push({ rule: 'v1.business.seats', message: 'repass-v1 business licences require maxActivations and device activation' });
    }
    if (!isBusiness && p.activationModel !== 'none') {
      out.push({ rule: 'v1.device.business_only', message: 'repass-v1 only supports device activation for business' });
    }
    if (p.certificateLifetimeSeconds !== null && p.activationModel !== 'device_seats') {
      out.push({ rule: 'v1.certificate', message: 'Activation certificate lifetime applies only to device-seat editions' });
    }
    if (p.offlinePolicy === 'periodic_check' && p.certificateLifetimeSeconds === null) {
      out.push({ rule: 'v1.periodic', message: 'repass-v1 periodic online checks are expressed via a certificate lifetime' });
    }
    return out;
  },
  buildLicenseClaims: buildLicenseClaimsV1,
  buildActivationClaims: buildActivationClaimsV1,
};

const REGISTRY = new Map<string, LicenseProtocol>([[repassV1.id, repassV1]]);

export function getProtocol(id: string): LicenseProtocol | undefined {
  return REGISTRY.get(id);
}

export function implementedProtocolIds(): string[] {
  return [...REGISTRY.keys()];
}
