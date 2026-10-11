// Signed envelope shared by repass-license-v1 and repass-activation-v1 (brief §4.1–§4.2).
//
//   { "format": F, "payload": b64u(P), "signatures": [{signatureAlgorithm,keyId,signature}...] }
//   signed bytes = UTF8(F) || 0x0A || P
//
// The payload bytes are serialised exactly once and embedded verbatim; they are never
// re-serialised.

import { base64UrlDecode, base64UrlEncode, concatBytes, decodeUtf8, encodeUtf8 } from '../lib/encoding.ts';
import { isSignatureAlgorithm, sign, verify, type SignatureAlgorithm } from './algorithms.ts';

export const MAX_ENVELOPE_BYTES = 64 * 1024;

export interface SignatureEntry {
  signatureAlgorithm: SignatureAlgorithm;
  keyId: string;
  signature: string;
}

export interface Envelope {
  format: string;
  payload: string;
  signatures: SignatureEntry[];
}

export interface Signer {
  keyId: string;
  algorithm: SignatureAlgorithm;
  key: CryptoKey;
}

export function signedBytes(format: string, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  return concatBytes(encodeUtf8(format), Uint8Array.of(0x0a), payload);
}

export async function buildEnvelope(
  format: string,
  claims: Record<string, unknown>,
  signers: Signer[],
  maxSignatures: number,
): Promise<{ envelope: Envelope; payloadBytes: Uint8Array<ArrayBuffer>; serialized: string }> {
  if (signers.length < 1 || signers.length > maxSignatures) {
    throw new Error(`envelope needs 1..${maxSignatures} signatures, got ${signers.length}`);
  }
  const ids = new Set(signers.map((s) => s.keyId));
  if (ids.size !== signers.length) throw new Error('duplicate keyId in envelope');
  const payloadBytes = encodeUtf8(JSON.stringify(claims));
  const msg = signedBytes(format, payloadBytes);
  const signatures: SignatureEntry[] = [];
  for (const s of signers) {
    const sig = await sign(s.algorithm, s.key, msg);
    signatures.push({ signatureAlgorithm: s.algorithm, keyId: s.keyId, signature: base64UrlEncode(sig) });
  }
  const envelope: Envelope = { format, payload: base64UrlEncode(payloadBytes), signatures };
  const serialized = JSON.stringify(envelope);
  if (encodeUtf8(serialized).length > MAX_ENVELOPE_BYTES) throw new Error('envelope exceeds 64 KiB');
  return { envelope, payloadBytes, serialized };
}

export interface TrustedKey {
  keyId: string;
  algorithm: SignatureAlgorithm;
  publicKey: Uint8Array<ArrayBuffer>;
}

export type VerifyFailure =
  | 'malformed'
  | 'wrongFormat'
  | 'tooLarge'
  | 'noTrustedSignature'
  | 'invalidSignature'
  | 'invalidPayload';

export type VerifyResult =
  | { ok: true; claims: Record<string, unknown>; verifiedKeyIds: string[]; payloadBytes: Uint8Array }
  | { ok: false; reason: VerifyFailure };

/**
 * Client-equivalent verifier, used by tests and tooling. Mirrors brief §5.5: strict envelope
 * shape, any trusted signature with an allowed algorithm suffices, unknown keys are skipped,
 * and a trusted signature that fails verification rejects the envelope.
 */
export async function verifyEnvelope(
  raw: string,
  expectedFormat: string,
  trusted: TrustedKey[],
  allowedAlgorithms: readonly SignatureAlgorithm[] = ['Ed25519', 'ECDSA-P256-SHA256', 'ML-DSA-65'],
): Promise<VerifyResult> {
  if (encodeUtf8(raw).length > MAX_ENVELOPE_BYTES) return { ok: false, reason: 'tooLarge' };
  let env: unknown;
  try {
    env = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isPlainObject(env)) return { ok: false, reason: 'malformed' };
  const keys = Object.keys(env).sort().join(',');
  if (keys !== 'format,payload,signatures') return { ok: false, reason: 'malformed' };
  const { format, payload, signatures } = env as Record<string, unknown>;
  if (typeof format !== 'string' || typeof payload !== 'string' || !Array.isArray(signatures)) return { ok: false, reason: 'malformed' };
  if (format !== expectedFormat) return { ok: false, reason: 'wrongFormat' };
  if (signatures.length < 1 || signatures.length > 8) return { ok: false, reason: 'malformed' };
  let payloadBytes: Uint8Array<ArrayBuffer>;
  try {
    payloadBytes = base64UrlDecode(payload);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const seen = new Set<string>();
  const verifiedKeyIds: string[] = [];
  const msg = signedBytes(format, payloadBytes);
  for (const s of signatures) {
    if (!isPlainObject(s) || Object.keys(s).sort().join(',') !== 'keyId,signature,signatureAlgorithm') return { ok: false, reason: 'malformed' };
    const { signatureAlgorithm, keyId, signature } = s as Record<string, unknown>;
    if (typeof keyId !== 'string' || typeof signature !== 'string' || typeof signatureAlgorithm !== 'string') return { ok: false, reason: 'malformed' };
    if (seen.has(keyId)) return { ok: false, reason: 'malformed' };
    seen.add(keyId);
    const tk = trusted.find((t) => t.keyId === keyId);
    if (!tk || !isSignatureAlgorithm(signatureAlgorithm) || !allowedAlgorithms.includes(signatureAlgorithm)) continue;
    if (tk.algorithm !== signatureAlgorithm) return { ok: false, reason: 'invalidSignature' };
    let sigBytes: Uint8Array<ArrayBuffer>;
    try {
      sigBytes = base64UrlDecode(signature);
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!(await verify(tk.algorithm, tk.publicKey, sigBytes, msg))) return { ok: false, reason: 'invalidSignature' };
    verifiedKeyIds.push(keyId);
  }
  if (verifiedKeyIds.length === 0) return { ok: false, reason: 'noTrustedSignature' };
  let claims: unknown;
  try {
    claims = JSON.parse(decodeUtf8(payloadBytes));
  } catch {
    return { ok: false, reason: 'invalidPayload' };
  }
  if (!isPlainObject(claims)) return { ok: false, reason: 'invalidPayload' };
  return { ok: true, claims: claims as Record<string, unknown>, verifiedKeyIds, payloadBytes };
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
