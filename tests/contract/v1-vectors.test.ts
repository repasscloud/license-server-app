// Official repass-*-v1 test vectors (LICENSING-SERVER-BRIEF.md §15.3). The seeds are PUBLIC
// test material and are never used outside tests.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { derivePublicKey, importPrivateKey, verify, type SignatureAlgorithm } from '../../src/crypto/algorithms.ts';
import { buildEnvelope, signedBytes, verifyEnvelope, type TrustedKey } from '../../src/crypto/envelope.ts';
import { buildActivationClaimsV1, buildLicenseClaimsV1, validateActivationClaimsV1, validateLicenseClaimsV1 } from '../../src/domain/v1-claims.ts';
import { base64UrlDecode, base64UrlEncode, decodeUtf8, hexDecode } from '../../src/lib/encoding.ts';

interface VectorFile {
  validateAs: { productId: string; majorVersion: number; now: string; deviceId: string };
  keys: Array<{ keyId: string; algorithm: SignatureAlgorithm; testOnlyPrivateSeedHex: string; publicKey: string }>;
  vectors: Array<{ name: string; claims?: Record<string, unknown>; envelope: { format: string; payload: string; signatures: unknown[] }; expect: string }>;
}

const V: VectorFile = JSON.parse(readFileSync(new URL('../fixtures/v1-test-vectors.json', import.meta.url), 'utf8'));

function compressP256(uncompressed: Uint8Array): Uint8Array {
  const out = new Uint8Array(33);
  out[0] = (uncompressed[64]! & 1) === 0 ? 0x02 : 0x03;
  out.set(uncompressed.slice(1, 33), 1);
  return out;
}

const trusted: TrustedKey[] = V.keys.map((k) => ({ keyId: k.keyId, algorithm: k.algorithm, publicKey: base64UrlDecode(k.publicKey) }));

describe('official v1 vectors', () => {
  it('derives the published public key from every test seed', async () => {
    for (const k of V.keys) {
      const pub = await derivePublicKey(k.algorithm, hexDecode(k.testOnlyPrivateSeedHex));
      const published = k.algorithm === 'ECDSA-P256-SHA256' ? compressP256(pub) : pub;
      expect(base64UrlEncode(published), k.keyId).toBe(k.publicKey);
    }
  });

  it('verifies all valid vectors and rejects the tampered one', async () => {
    for (const v of V.vectors) {
      const r = await verifyEnvelope(JSON.stringify(v.envelope), v.envelope.format, trusted);
      if (v.expect === 'valid') expect(r.ok, v.name).toBe(true);
      else {
        expect(r.ok, v.name).toBe(false);
        if (!r.ok) expect(r.reason).toBe('invalidSignature');
      }
    }
  });

  it('serialises claims to exactly the vector payload bytes (field order, timestamps, nulls)', () => {
    for (const v of V.vectors.filter((x) => x.claims)) {
      const c = v.claims!;
      const built =
        v.envelope.format === 'repass-license-v1'
          ? buildLicenseClaimsV1({
              licenseId: c.licenseId as string,
              customerId: c.customerId as string,
              productId: c.productId as string,
              majorVersion: c.majorVersion as number,
              edition: c.edition as string,
              organisation: (c.organisation as string) ?? null,
              customerName: (c.customerName as string) ?? null,
              issuedAt: new Date(c.issuedAt as string),
              expiresAt: c.expiresAt ? new Date(c.expiresAt as string) : null,
              maxActivations: (c.maxActivations as number) ?? null,
            })
          : buildActivationClaimsV1({
              activationId: c.activationId as string,
              licenseId: c.licenseId as string,
              productId: c.productId as string,
              majorVersion: c.majorVersion as number,
              deviceId: c.deviceId as string,
              issuedAt: new Date(c.issuedAt as string),
              expiresAt: null,
            });
      expect(base64UrlEncode(new TextEncoder().encode(JSON.stringify(built))), v.name).toBe(v.envelope.payload);
    }
  });

  it('reproduces the Ed25519 vector signatures byte-for-byte from the published seed', async () => {
    const k = V.keys.find((x) => x.algorithm === 'Ed25519')!;
    const key = await importPrivateKey('Ed25519', hexDecode(k.testOnlyPrivateSeedHex));
    for (const v of V.vectors.filter((x) => x.expect === 'valid')) {
      const sig = (v.envelope.signatures as Array<{ keyId: string; signature: string }>).find((s) => s.keyId === k.keyId);
      if (!sig) continue;
      const claims = JSON.parse(decodeUtf8(base64UrlDecode(v.envelope.payload)));
      const { envelope } = await buildEnvelope(v.envelope.format, claims, [{ keyId: k.keyId, algorithm: 'Ed25519', key }], 8);
      expect(envelope.payload).toBe(v.envelope.payload);
      expect(envelope.signatures[0]!.signature, v.name).toBe(sig.signature);
    }
  });

  it('ECDSA-P256 and ML-DSA-65 signers produce signatures the verifier accepts (P1363, pure, empty context)', async () => {
    const claims = V.vectors[1]!.claims!;
    const signers = [];
    for (const k of V.keys) signers.push({ keyId: k.keyId, algorithm: k.algorithm, key: await importPrivateKey(k.algorithm, hexDecode(k.testOnlyPrivateSeedHex)) });
    const { envelope, payloadBytes } = await buildEnvelope('repass-license-v1', claims, signers, 8);
    expect(envelope.signatures.map((s) => base64UrlDecode(s.signature).length)).toEqual([64, 64, 3309]);
    const r = await verifyEnvelope(JSON.stringify(envelope), 'repass-license-v1', trusted);
    expect(r.ok && r.verifiedKeyIds).toEqual(['vector-ed25519', 'vector-p256', 'vector-mldsa65']);
    // ECDSA signature must not be DER (DER starts with 0x30 and is 70-72 bytes).
    const ecdsa = base64UrlDecode(envelope.signatures[1]!.signature);
    expect(ecdsa.length).toBe(64);
    // Raw primitive check against the signed-bytes construction.
    const msg = signedBytes('repass-license-v1', payloadBytes);
    expect(await verify('ML-DSA-65', trusted[2]!.publicKey, base64UrlDecode(envelope.signatures[2]!.signature), msg)).toBe(true);
  });

  it('a licence signature cannot be replayed as an activation certificate (format prefix)', async () => {
    const lic = V.vectors[0]!.envelope;
    const forged = { ...lic, format: 'repass-activation-v1' };
    const r = await verifyEnvelope(JSON.stringify(forged), 'repass-activation-v1', trusted);
    expect(r.ok).toBe(false);
  });

  it('rejects malformed envelopes: extra fields, too many signatures, duplicate keyIds, padding', async () => {
    const base = V.vectors[0]!.envelope;
    const cases: Array<Record<string, unknown>> = [
      { ...base, extra: 1 },
      { ...base, signatures: Array(9).fill(base.signatures[0]) },
      { ...base, signatures: [base.signatures[0], base.signatures[0]] },
      { ...base, payload: base.payload + '=' },
      { ...base, signatures: [] },
    ];
    for (const c of cases) expect((await verifyEnvelope(JSON.stringify(c), base.format, trusted)).ok).toBe(false);
  });
});

describe('v1 claim rules (server refuses what clients reject)', () => {
  const base = {
    licenseId: 'lic_x',
    customerId: 'cus_x',
    productId: 'cursedelete',
    majorVersion: 2,
    issuedAt: new Date('2026-10-11T00:00:00.789Z'),
  };
  it('truncates timestamps to whole seconds with Z', () => {
    const c = buildLicenseClaimsV1({ ...base, edition: 'community', expiresAt: null });
    expect(c.issuedAt).toBe('2026-10-11T00:00:00Z');
    expect(c.expiresAt).toBeNull();
    expect(c.perpetual).toBe(true);
  });
  it('rejects non-perpetual enterprise, business without seats, seats on non-business, emails', () => {
    expect(() => buildLicenseClaimsV1({ ...base, edition: 'enterprise', expiresAt: new Date('2027-01-01T00:00:00Z') })).toThrow(/only business/);
    expect(() => buildLicenseClaimsV1({ ...base, edition: 'business', expiresAt: null })).toThrow(/maxActivations/);
    expect(() => buildLicenseClaimsV1({ ...base, edition: 'education', expiresAt: null, maxActivations: 2 })).toThrow(/only allowed for business/);
    expect(() => buildLicenseClaimsV1({ ...base, edition: 'community', customerName: 'jane@example.com', expiresAt: null })).toThrow(/email/);
    expect(() => buildLicenseClaimsV1({ ...base, edition: 'business', maxActivations: 1, expiresAt: new Date('2026-10-11T00:00:00Z') })).toThrow(/later than issuedAt/);
    expect(() => buildLicenseClaimsV1({ ...base, edition: 'platinum', expiresAt: null })).toThrow(/edition/);
  });
  it('rejects unknown fields', () => {
    expect(validateLicenseClaimsV1({ ...V.vectors[0]!.claims, email: 'x' })).toContain('unknown field email');
    expect(validateActivationClaimsV1({ ...V.vectors[2]!.claims, hostname: 'x' })).toContain('unknown field hostname');
  });
});
