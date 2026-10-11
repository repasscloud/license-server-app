// Keyed hashing for bearer secrets (activation keys, client secrets, sessions, magic links,
// API tokens). Each trust domain has its own pepper secret so they can be rotated, and so a
// value from one domain can never verify in another.

import { base64Decode, encodeUtf8, hexEncode, timingSafeEqual } from '../lib/encoding.ts';

export type PepperName = 'MACHINE_PEPPER' | 'AUTH_PEPPER' | 'API_TOKEN_PEPPER';

const keyCache = new Map<string, Promise<CryptoKey>>();

export function hmacKey(secret: string): Promise<CryptoKey> {
  let p = keyCache.get(secret);
  if (!p) {
    const raw = base64Decode(secret);
    if (raw.length < 32) return Promise.reject(new Error('pepper must be at least 32 bytes'));
    p = crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, p);
  }
  return p;
}

export async function hmac(secret: string, label: string, value: string | Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const key = await hmacKey(secret);
  const body = typeof value === 'string' ? encodeUtf8(value) : value;
  const msg = new Uint8Array(label.length + 1 + body.length);
  msg.set(encodeUtf8(label), 0);
  msg[label.length] = 0x00;
  msg.set(body, label.length + 1);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
}

export async function sha256(data: Uint8Array<ArrayBuffer> | string): Promise<Uint8Array<ArrayBuffer>> {
  const b = typeof data === 'string' ? encodeUtf8(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', b));
}

export async function sha256Hex(data: Uint8Array<ArrayBuffer> | string): Promise<string> {
  return hexEncode(await sha256(data));
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return timingSafeEqual(a, b);
}
