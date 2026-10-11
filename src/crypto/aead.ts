// Application-side envelope encryption with AES-256-GCM and versioned key-encryption keys.
//
// Two independent keyrings, never mixed:
//   SIGNING_KEK_V<n>  -> wraps private signing keys (signing_key_secrets)
//   APP_DATA_KEY_V<n> -> TOTP secrets, email outbox payloads, one-time activation-key reveals
// Each secret is 32 random bytes, base64-encoded, held in Cloudflare Workers Secrets.
// Associated data binds every ciphertext to its purpose and row identity, so a ciphertext
// cannot be transplanted between rows or purposes.

import { base64Decode, concatBytes, encodeUtf8 } from '../lib/encoding.ts';

export class KeyringError extends Error {}

export interface Keyring {
  readonly name: 'SIGNING_KEK' | 'APP_DATA_KEY';
  readonly activeVersion: number;
  key(version: number): Promise<CryptoKey>;
  hasVersion(version: number): boolean;
}

export function keyringFromEnv(
  env: Record<string, unknown>,
  name: 'SIGNING_KEK' | 'APP_DATA_KEY',
): Keyring {
  const activeRaw = env[`${name}_ACTIVE_VERSION`];
  const activeVersion = Number(activeRaw ?? 1);
  if (!Number.isInteger(activeVersion) || activeVersion < 1) throw new KeyringError(`${name}_ACTIVE_VERSION is invalid`);
  const cache = new Map<number, Promise<CryptoKey>>();
  const material = (v: number): string | undefined => {
    const s = env[`${name}_V${v}`];
    return typeof s === 'string' && s.length > 0 ? s : undefined;
  };
  return {
    name,
    activeVersion,
    hasVersion: (v) => material(v) !== undefined,
    key(version) {
      let p = cache.get(version);
      if (!p) {
        const m = material(version);
        if (!m) return Promise.reject(new KeyringError(`${name}_V${version} is not configured`));
        const bytes = base64Decode(m);
        if (bytes.length !== 32) return Promise.reject(new KeyringError(`${name}_V${version} must be 32 bytes (base64)`));
        p = crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        cache.set(version, p);
      }
      return p;
    },
  };
}

export interface Sealed {
  ciphertext: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  tag: Uint8Array<ArrayBuffer>;
  keyVersion: number;
}

export async function seal(ring: Keyring, plaintext: Uint8Array<ArrayBuffer>, aad: string, version = ring.activeVersion): Promise<Sealed> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await ring.key(version);
  const out = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encodeUtf8(aad), tagLength: 128 }, key, plaintext),
  );
  return { ciphertext: out.slice(0, out.length - 16), tag: out.slice(out.length - 16), nonce, keyVersion: version };
}

export async function open(ring: Keyring, sealed: Sealed, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await ring.key(sealed.keyVersion);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: sealed.nonce, additionalData: encodeUtf8(aad), tagLength: 128 },
        key,
        concatBytes(sealed.ciphertext, sealed.tag),
      ),
    );
  } catch {
    throw new KeyringError(`${ring.name} decryption failed (wrong key version, wrong key, or tampered data)`);
  }
}

// Compact single-column form for app-data blobs: version(1) || nonce(12) || ciphertext || tag(16).
export async function sealCompact(ring: Keyring, plaintext: Uint8Array<ArrayBuffer>, aad: string): Promise<{ blob: Uint8Array<ArrayBuffer>; keyVersion: number }> {
  const s = await seal(ring, plaintext, aad);
  return { blob: concatBytes(Uint8Array.of(1), s.nonce, s.ciphertext, s.tag), keyVersion: s.keyVersion };
}

export async function openCompact(ring: Keyring, blob: Uint8Array, keyVersion: number, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  if (blob.length < 1 + 12 + 16 || blob[0] !== 1) throw new KeyringError('unsupported sealed blob format');
  return open(
    ring,
    {
      nonce: blob.slice(1, 13),
      ciphertext: blob.slice(13, blob.length - 16),
      tag: blob.slice(blob.length - 16),
      keyVersion,
    },
    aad,
  );
}

export function signingKeyAad(keyId: string, algorithm: string, format: string, kekVersion: number): string {
  return `repass/signing-key/v1|${keyId}|${algorithm}|${format}|kek=${kekVersion}`;
}

export function appDataAad(purpose: string, rowId: string): string {
  return `repass/app-data/v1|${purpose}|${rowId}`;
}
