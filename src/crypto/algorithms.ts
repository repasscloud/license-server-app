// Signature algorithms for the repass-*-v1 contract (brief §4.3), implemented with native
// Web Crypto only (Workers: requires the webcrypto_modern_algorithms flag for ML-DSA-65).
//
// Private keys are stored in portable 32-byte encodings:
//   Ed25519           -> RFC 8032 seed (imported via PKCS#8 wrapper)
//   ECDSA-P256-SHA256 -> big-endian private scalar d (imported via PKCS#8 / RFC 5915 wrapper)
//   ML-DSA-65         -> FIPS 204 KeyGen seed xi (imported as 'raw-seed')
// so a database dump can be restored anywhere and re-imported by any conforming library.

import { concatBytes } from '../lib/encoding.ts';

export const ALGORITHMS = ['Ed25519', 'ECDSA-P256-SHA256', 'ML-DSA-65'] as const;
export type SignatureAlgorithm = (typeof ALGORITHMS)[number];

export type PrivateFormat = 'ed25519-seed32' | 'p256-scalar32' | 'mldsa65-seed32';

export const PRIVATE_FORMAT: Record<SignatureAlgorithm, PrivateFormat> = {
  Ed25519: 'ed25519-seed32',
  'ECDSA-P256-SHA256': 'p256-scalar32',
  'ML-DSA-65': 'mldsa65-seed32',
};

export const SIGNATURE_LENGTH: Record<SignatureAlgorithm, number> = {
  Ed25519: 64,
  'ECDSA-P256-SHA256': 64,
  'ML-DSA-65': 3309,
};

export const PUBLIC_KEY_LENGTHS: Record<SignatureAlgorithm, number[]> = {
  Ed25519: [32],
  'ECDSA-P256-SHA256': [33, 65],
  'ML-DSA-65': [1952],
};

export function isSignatureAlgorithm(s: unknown): s is SignatureAlgorithm {
  return typeof s === 'string' && (ALGORITHMS as readonly string[]).includes(s);
}

const subtle = () => crypto.subtle;

// PKCS#8 PrivateKeyInfo prefixes.
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
// SEQUENCE{ INTEGER 0, SEQUENCE{ ecPublicKey, prime256v1 }, OCTET STRING{ ECPrivateKey{ 1, d } } }
const P256_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
]);

// Web Crypto ML-DSA parameters and getPublicKey() are not yet in every typing environment
// (DOM lib vs Workers runtime types), so parameters are passed through a narrow cast.
type AnyAlg = never;
type ModernSubtle = SubtleCrypto & {
  getPublicKey(key: CryptoKey, usages: string[]): Promise<CryptoKey>;
};
const mldsa = (context?: Uint8Array) => (context ? { name: 'ML-DSA-65', context } : { name: 'ML-DSA-65' }) as AnyAlg;
const jwkOf = async (k: CryptoKey) => (await subtle().exportKey('jwk', k)) as JsonWebKey;

function assertLen(b: Uint8Array, n: number, what: string) {
  if (b.length !== n) throw new Error(`${what} must be ${n} bytes`);
}

/** Import a stored 32-byte private encoding as a non-extractable signing key. */
export async function importPrivateKey(alg: SignatureAlgorithm, priv: Uint8Array): Promise<CryptoKey> {
  assertLen(priv, 32, 'private key material');
  switch (alg) {
    case 'Ed25519':
      return subtle().importKey('pkcs8', concatBytes(ED25519_PKCS8_PREFIX, priv), { name: 'Ed25519' }, false, ['sign']);
    case 'ECDSA-P256-SHA256':
      return subtle().importKey('pkcs8', concatBytes(P256_PKCS8_PREFIX, priv), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    case 'ML-DSA-65':
      return subtle().importKey('raw-seed' as never, priv as Uint8Array<ArrayBuffer>, mldsa(), false, ['sign']);
  }
}

/** Derive the public key, in the raw encoding published to applications (brief §4.3). */
export async function derivePublicKey(alg: SignatureAlgorithm, priv: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  assertLen(priv, 32, 'private key material');
  switch (alg) {
    case 'Ed25519': {
      const k = await subtle().importKey('pkcs8', concatBytes(ED25519_PKCS8_PREFIX, priv), { name: 'Ed25519' }, true, ['sign']);
      const jwk = await jwkOf(k);
      return b64uToBytes(jwk.x!);
    }
    case 'ECDSA-P256-SHA256': {
      const k = await subtle().importKey('pkcs8', concatBytes(P256_PKCS8_PREFIX, priv), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
      const jwk = await jwkOf(k);
      // Uncompressed SEC1 point 0x04 || X || Y (65 bytes).
      return concatBytes(Uint8Array.of(0x04), b64uToBytes(jwk.x!), b64uToBytes(jwk.y!));
    }
    case 'ML-DSA-65': {
      const ms = subtle() as ModernSubtle;
      const k = await ms.importKey('raw-seed' as never, priv as Uint8Array<ArrayBuffer>, mldsa(), false, ['sign']);
      const pub = await ms.getPublicKey(k, ['verify']);
      return new Uint8Array((await ms.exportKey('raw-public' as never, pub)) as ArrayBuffer);
    }
  }
}

export interface GeneratedKey {
  privateKey: Uint8Array<ArrayBuffer>;
  publicKey: Uint8Array<ArrayBuffer>;
}

/** Generate a fresh keypair from 32 bytes of CSPRNG output, in the portable encodings. */
export async function generateKeyPair(alg: SignatureAlgorithm): Promise<GeneratedKey> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const priv = crypto.getRandomValues(new Uint8Array(32));
    try {
      // For P-256 a random 32-byte string is a valid scalar except with negligible
      // probability (d = 0 or d >= n); import rejects those and we retry.
      const publicKey = await derivePublicKey(alg, priv);
      return { privateKey: priv, publicKey };
    } catch (e) {
      if (alg !== 'ECDSA-P256-SHA256') throw e;
    }
  }
  throw new Error('key generation failed');
}

/** Produce a signature over message bytes in the exact encoding required by v1. */
export async function sign(alg: SignatureAlgorithm, key: CryptoKey, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  let sig: ArrayBuffer;
  switch (alg) {
    case 'Ed25519':
      // Pure Ed25519 (RFC 8032), no prehash, no context.
      sig = await subtle().sign({ name: 'Ed25519' }, key, message);
      break;
    case 'ECDSA-P256-SHA256':
      // Web Crypto ECDSA emits IEEE P1363 r||s (64 bytes), never DER.
      sig = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, message);
      break;
    case 'ML-DSA-65':
      // Pure ML-DSA (not HashML-DSA) with an explicitly empty context string.
      sig = await subtle().sign(mldsa(new Uint8Array(0)), key, message);
      break;
  }
  const out = new Uint8Array(sig);
  if (out.length !== SIGNATURE_LENGTH[alg]) throw new Error(`${alg} produced ${out.length}-byte signature`);
  return out;
}

const publicKeyCache = new Map<string, Promise<CryptoKey>>();

export async function importPublicKey(alg: SignatureAlgorithm, raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (!PUBLIC_KEY_LENGTHS[alg].includes(raw.length)) throw new Error(`invalid ${alg} public key length`);
  switch (alg) {
    case 'Ed25519':
      return subtle().importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']);
    case 'ECDSA-P256-SHA256':
      return subtle().importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    case 'ML-DSA-65':
      return subtle().importKey('raw-public' as never, raw, mldsa(), false, ['verify']);
  }
}

export async function verify(alg: SignatureAlgorithm, publicKey: Uint8Array<ArrayBuffer>, signature: Uint8Array<ArrayBuffer>, message: Uint8Array<ArrayBuffer>): Promise<boolean> {
  if (signature.length !== SIGNATURE_LENGTH[alg]) return false;
  const cacheKey = `${alg}:${b64(publicKey)}`;
  let p = publicKeyCache.get(cacheKey);
  if (!p) {
    p = importPublicKey(alg, publicKey);
    publicKeyCache.set(cacheKey, p);
  }
  const key = await p;
  switch (alg) {
    case 'Ed25519':
      return subtle().verify({ name: 'Ed25519' }, key, signature, message);
    case 'ECDSA-P256-SHA256':
      return subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, message);
    case 'ML-DSA-65':
      return subtle().verify(mldsa(new Uint8Array(0)), key, signature, message);
  }
}

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64(u: Uint8Array): string {
  let s = '';
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
}
