// Signing-key registry: PostgreSQL holds public keys and AES-256-GCM-encrypted private keys.
// The KEK (SIGNING_KEK_V<n>) lives only in Workers Secrets. Decryption happens only in
// loadSigners()/rewrap and yields non-extractable CryptoKeys; private material is never
// returned by any API, written to logs, or included in audit detail.
//
// Lifecycle: generated -> published (public key handed to app teams) -> [eligible per product
// major once the minimum supported release trusts it] -> retired | compromised.

import { derivePublicKey, generateKeyPair, importPrivateKey, PRIVATE_FORMAT, type SignatureAlgorithm } from '../crypto/algorithms.ts';
import { open, seal, signingKeyAad, type Keyring } from '../crypto/aead.ts';
import type { Signer } from '../crypto/envelope.ts';
import { sha256Hex } from '../crypto/hashing.ts';
import { toBytes, type Db, type Sql, type Tx } from '../db/client.ts';
import { base64UrlEncode } from '../lib/encoding.ts';
import { AppError, conflict, invalid, notFound } from '../lib/errors.ts';
import { newId, WIRE_ID_RE } from '../lib/ids.ts';
import { compareSemver } from '../lib/semver.ts';
import { getProtocol } from '../domain/protocols.ts';
import type { Actor } from './actor.ts';
import { audit } from './audit.ts';

const ALG_TAG: Record<SignatureAlgorithm, string> = { Ed25519: 'ed25519', 'ECDSA-P256-SHA256': 'p256', 'ML-DSA-65': 'mldsa65' };

export interface SigningKeyView {
  keyId: string;
  algorithm: SignatureAlgorithm;
  publicKey: string; // base64url raw encoding (brief §7)
  fingerprint: string;
  status: string;
  origin: string;
  kekVersion: number;
  notes: string;
  createdAt: string;
  publishedAt: string | null;
  retiredAt: string | null;
  compromisedAt: string | null;
}

interface KeyRow {
  id: string;
  algorithm: SignatureAlgorithm;
  public_key: Uint8Array;
  fingerprint: string;
  status: string;
  origin: string;
  notes: string;
  created_at: Date;
  published_at: Date | null;
  retired_at: Date | null;
  compromised_at: Date | null;
  kek_version: number;
}

function view(r: KeyRow): SigningKeyView {
  return {
    keyId: r.id,
    algorithm: r.algorithm,
    publicKey: base64UrlEncode(toBytes(r.public_key)),
    fingerprint: r.fingerprint,
    status: r.status,
    origin: r.origin,
    kekVersion: r.kek_version,
    notes: r.notes,
    createdAt: r.created_at.toISOString(),
    publishedAt: r.published_at?.toISOString() ?? null,
    retiredAt: r.retired_at?.toISOString() ?? null,
    compromisedAt: r.compromised_at?.toISOString() ?? null,
  };
}

async function event(db: Db, keyId: string, ev: string, actor: Actor, detail: Record<string, unknown> = {}) {
  await db`INSERT INTO key_lifecycle_events (signing_key_id, event, actor, detail) VALUES (${keyId}, ${ev}, ${actor.label}, ${db.json(detail as never)})`;
  await audit(db, actor, { action: `signing_key.${ev}`, resourceType: 'signing_key', resourceId: keyId, detail });
}

async function suggestKeyId(db: Db, alg: SignatureAlgorithm, now: Date): Promise<string> {
  const base = `repass-${ALG_TAG[alg]}-${now.getUTCFullYear()}`;
  const rows = await db<{ id: string }[]>`SELECT id FROM signing_keys WHERE id = ${base} OR id LIKE ${base + '-%'}`;
  if (rows.length === 0) return base;
  return `${base}-${rows.length + 1}`;
}

async function storeKey(
  tx: Tx,
  kek: Keyring,
  actor: Actor,
  p: { keyId: string; algorithm: SignatureAlgorithm; privateKey: Uint8Array<ArrayBuffer>; publicKey: Uint8Array<ArrayBuffer>; origin: 'generated' | 'imported' | 'test_vector'; notes: string },
) {
  if (!WIRE_ID_RE.test(p.keyId)) throw invalid('keyId must match [A-Za-z0-9_.-]{1,128}');
  const exists = await tx`SELECT 1 FROM signing_keys WHERE id = ${p.keyId}`;
  if (exists.length) throw conflict(`keyId ${p.keyId} already exists and key ids are never reused`);
  const format = PRIVATE_FORMAT[p.algorithm];
  const sealed = await seal(kek, p.privateKey, signingKeyAad(p.keyId, p.algorithm, format, kek.activeVersion));
  const fingerprint = await sha256Hex(p.publicKey);
  await tx`INSERT INTO signing_keys (id, algorithm, public_key, fingerprint, origin, notes, created_by)
           VALUES (${p.keyId}, ${p.algorithm}, ${p.publicKey}, ${fingerprint}, ${p.origin}, ${p.notes}, ${actor.label})`;
  await tx`INSERT INTO signing_key_secrets (signing_key_id, private_format, ciphertext, nonce, tag, kek_version)
           VALUES (${p.keyId}, ${format}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.tag}, ${sealed.keyVersion})`;
  await event(tx, p.keyId, p.origin === 'generated' ? 'generated' : 'imported', actor, { algorithm: p.algorithm, fingerprint, kekVersion: sealed.keyVersion });
  p.privateKey.fill(0);
}

/** Generate a new keypair. Generation changes nothing about issuance (brief §7 rotation). */
export async function generateSigningKey(
  sql: Sql,
  kek: Keyring,
  actor: Actor,
  input: { algorithm: SignatureAlgorithm; keyId?: string; notes?: string },
  now = new Date(),
): Promise<SigningKeyView> {
  const { privateKey, publicKey } = await generateKeyPair(input.algorithm);
  return sql.begin(async (tx) => {
    const keyId = input.keyId ?? (await suggestKeyId(tx, input.algorithm, now));
    await storeKey(tx, kek, actor, { keyId, algorithm: input.algorithm, privateKey, publicKey, origin: 'generated', notes: input.notes ?? '' });
    return getSigningKey(tx, keyId);
  }) as Promise<SigningKeyView>;
}

/**
 * Restricted import of existing private material (operator CLI only; not exposed over HTTP).
 * The public key is derived from the private material, so a mismatched pair cannot be stored.
 */
export async function importSigningKey(
  sql: Sql,
  kek: Keyring,
  actor: Actor,
  input: { keyId: string; algorithm: SignatureAlgorithm; privateKey: Uint8Array<ArrayBuffer>; origin: 'imported' | 'test_vector'; notes?: string },
): Promise<SigningKeyView> {
  const publicKey = await derivePublicKey(input.algorithm, input.privateKey);
  return sql.begin(async (tx) => {
    await storeKey(tx, kek, actor, { ...input, publicKey, notes: input.notes ?? '' });
    return getSigningKey(tx, input.keyId);
  }) as Promise<SigningKeyView>;
}

export async function listSigningKeys(db: Db): Promise<SigningKeyView[]> {
  const rows = await db<KeyRow[]>`
    SELECT k.*, s.kek_version FROM signing_keys k JOIN signing_key_secrets s ON s.signing_key_id = k.id ORDER BY k.created_at`;
  return rows.map(view);
}

export async function getSigningKey(db: Db, keyId: string): Promise<SigningKeyView> {
  const rows = await db<KeyRow[]>`
    SELECT k.*, s.kek_version FROM signing_keys k JOIN signing_key_secrets s ON s.signing_key_id = k.id WHERE k.id = ${keyId}`;
  if (!rows[0]) throw notFound('Signing key');
  return view(rows[0]);
}

export async function publishSigningKey(sql: Sql, actor: Actor, keyId: string): Promise<SigningKeyView> {
  return sql.begin(async (tx) => {
    const r = await tx<{ status: string }[]>`SELECT status FROM signing_keys WHERE id = ${keyId} FOR UPDATE`;
    if (!r[0]) throw notFound('Signing key');
    if (r[0].status !== 'generated') throw conflict(`Key is ${r[0].status}; only generated keys can be published`);
    await tx`UPDATE signing_keys SET status = 'published', published_at = now() WHERE id = ${keyId}`;
    await event(tx, keyId, 'published', actor);
    return getSigningKey(tx, keyId);
  }) as Promise<SigningKeyView>;
}

export interface CompatibilityView {
  id: string;
  keyId: string;
  algorithm: string;
  keyStatus: string;
  productMajorId: string;
  productSlug: string;
  majorVersion: number;
  trustedSinceVersion: string;
  trustedUntilVersion: string | null;
  eligible: boolean;
  minimumSupportedRelease: string | null;
  effectiveEligible: boolean;
  blockedReason: string | null;
}

interface CompatRow {
  id: string;
  signing_key_id: string;
  algorithm: SignatureAlgorithm;
  key_status: string;
  product_major_id: string;
  slug: string;
  major_version: number;
  trusted_since_version: string;
  trusted_until_version: string | null;
  eligible: boolean;
  min_release: string | null;
}

/** Why a key cannot currently sign for a major, or null when it can. */
function eligibilityBlock(r: Pick<CompatRow, 'key_status' | 'trusted_since_version' | 'trusted_until_version' | 'min_release'>): string | null {
  if (r.key_status !== 'published') return `key status is ${r.key_status}`;
  if (!r.min_release) return 'product major has no shipped minimum supported release';
  if (compareSemver(r.min_release, r.trusted_since_version) < 0) return `minimum supported release ${r.min_release} predates first trusting release ${r.trusted_since_version}`;
  if (r.trusted_until_version && compareSemver(r.min_release, r.trusted_until_version) > 0) return `minimum supported release ${r.min_release} no longer trusts this key (last ${r.trusted_until_version})`;
  return null;
}

const COMPAT_SELECT = (db: Db) => db`
  SELECT c.id, c.signing_key_id, k.algorithm, k.status AS key_status, c.product_major_id, p.slug, m.major_version,
         c.trusted_since_version, c.trusted_until_version, c.eligible,
         (SELECT r.version FROM product_releases r WHERE r.product_major_id = c.product_major_id AND r.is_minimum_supported) AS min_release
  FROM key_compatibilities c
  JOIN signing_keys k ON k.id = c.signing_key_id
  JOIN product_majors m ON m.id = c.product_major_id
  JOIN products p ON p.id = m.product_id`;

function compatView(r: CompatRow): CompatibilityView {
  const block = eligibilityBlock(r);
  return {
    id: r.id,
    keyId: r.signing_key_id,
    algorithm: r.algorithm,
    keyStatus: r.key_status,
    productMajorId: r.product_major_id,
    productSlug: r.slug,
    majorVersion: r.major_version,
    trustedSinceVersion: r.trusted_since_version,
    trustedUntilVersion: r.trusted_until_version,
    eligible: r.eligible,
    minimumSupportedRelease: r.min_release,
    effectiveEligible: r.eligible && block === null,
    blockedReason: block,
  };
}

export async function listCompatibilities(db: Db, filter: { productMajorId?: string; keyId?: string } = {}): Promise<CompatibilityView[]> {
  const rows = await db<CompatRow[]>`
    ${COMPAT_SELECT(db)}
    WHERE (${filter.productMajorId ?? null}::text IS NULL OR c.product_major_id = ${filter.productMajorId ?? null})
      AND (${filter.keyId ?? null}::text IS NULL OR c.signing_key_id = ${filter.keyId ?? null})
    ORDER BY p.slug, m.major_version, c.signing_key_id`;
  return rows.map(compatView);
}

/** Record which releases of a product major embed (trust) a key. Does not make it eligible. */
export async function setKeyTrust(
  sql: Sql,
  actor: Actor,
  input: { keyId: string; productMajorId: string; trustedSinceVersion: string; trustedUntilVersion?: string | null },
): Promise<CompatibilityView> {
  compareSemver(input.trustedSinceVersion, input.trustedSinceVersion); // validates format
  if (input.trustedUntilVersion) {
    if (compareSemver(input.trustedUntilVersion, input.trustedSinceVersion) < 0) throw invalid('trustedUntilVersion precedes trustedSinceVersion');
  }
  return sql.begin(async (tx) => {
    const k = await tx`SELECT 1 FROM signing_keys WHERE id = ${input.keyId}`;
    if (!k.length) throw notFound('Signing key');
    const m = await tx`SELECT 1 FROM product_majors WHERE id = ${input.productMajorId}`;
    if (!m.length) throw notFound('Product major');
    await tx`
      INSERT INTO key_compatibilities (id, signing_key_id, product_major_id, trusted_since_version, trusted_until_version, approved_by)
      VALUES (${newId('kcp')}, ${input.keyId}, ${input.productMajorId}, ${input.trustedSinceVersion}, ${input.trustedUntilVersion ?? null}, ${actor.label})
      ON CONFLICT (signing_key_id, product_major_id) DO UPDATE
        SET trusted_since_version = EXCLUDED.trusted_since_version,
            trusted_until_version = EXCLUDED.trusted_until_version`;
    await event(tx, input.keyId, 'trust_recorded', actor, { productMajorId: input.productMajorId, since: input.trustedSinceVersion, until: input.trustedUntilVersion ?? null });
    const [row] = await listCompatibilities(tx, { keyId: input.keyId, productMajorId: input.productMajorId });
    return row!;
  }) as Promise<CompatibilityView>;
}

/**
 * Mark a key eligible for issuance for a product major. Requires that the major's minimum
 * supported (shipped) release trusts the key (brief §7, architecture §6.6/§6.8).
 */
export async function setKeyEligibility(sql: Sql, actor: Actor, input: { keyId: string; productMajorId: string; eligible: boolean }): Promise<CompatibilityView> {
  return sql.begin(async (tx) => {
    await tx`SELECT 1 FROM product_majors WHERE id = ${input.productMajorId} FOR UPDATE`;
    const [row] = await tx<CompatRow[]>`${COMPAT_SELECT(tx)} WHERE c.signing_key_id = ${input.keyId} AND c.product_major_id = ${input.productMajorId}`;
    if (!row) throw notFound('Key trust record (record which releases trust the key first)');
    if (input.eligible) {
      const block = eligibilityBlock(row);
      if (block) throw new AppError('precondition_failed', `Key cannot become eligible: ${block}`);
      const protocolRow = await tx<{ protocol_id: string }[]>`SELECT protocol_id FROM product_majors WHERE id = ${input.productMajorId}`;
      const max = getProtocol(protocolRow[0]!.protocol_id)?.maxSignatures ?? 1;
      const count = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM key_compatibilities WHERE product_major_id = ${input.productMajorId} AND eligible AND signing_key_id <> ${input.keyId}`;
      if (count[0]!.n + 1 > max) throw conflict(`At most ${max} keys may be eligible for one product major (protocol signature limit)`);
    }
    await tx`UPDATE key_compatibilities SET eligible = ${input.eligible}, eligible_at = ${input.eligible ? new Date() : null}, approved_by = ${actor.label}
             WHERE signing_key_id = ${input.keyId} AND product_major_id = ${input.productMajorId}`;
    await event(tx, input.keyId, input.eligible ? 'eligible' : 'ineligible', actor, { productMajorId: input.productMajorId });
    const [out] = await listCompatibilities(tx, { keyId: input.keyId, productMajorId: input.productMajorId });
    return out!;
  }) as Promise<CompatibilityView>;
}

/**
 * Retire a key: stop signing with it. Refused when a product major would be left with no
 * effective eligible key unless `force` is set (issuance for that major would then fail closed).
 */
export async function retireSigningKey(sql: Sql, actor: Actor, keyId: string, opts: { force?: boolean; compromised?: boolean; reason: string }): Promise<SigningKeyView> {
  return sql.begin(async (tx) => {
    const r = await tx<{ status: string }[]>`SELECT status FROM signing_keys WHERE id = ${keyId} FOR UPDATE`;
    if (!r[0]) throw notFound('Signing key');
    if (r[0].status === 'compromised') throw conflict('Key is already marked compromised');
    if (!opts.compromised && r[0].status === 'retired') throw conflict('Key is already retired');
    if (!opts.compromised && !opts.force) {
      const stranded = await tx<{ slug: string; major_version: number }[]>`
        SELECT p.slug, m.major_version FROM key_compatibilities c
        JOIN product_majors m ON m.id = c.product_major_id JOIN products p ON p.id = m.product_id
        WHERE c.signing_key_id = ${keyId} AND c.eligible
          AND NOT EXISTS (SELECT 1 FROM key_compatibilities o JOIN signing_keys ok ON ok.id = o.signing_key_id
                          WHERE o.product_major_id = c.product_major_id AND o.eligible AND ok.status = 'published' AND o.signing_key_id <> ${keyId})`;
      if (stranded.length) {
        throw conflict(`Retiring would leave no eligible signing key for: ${stranded.map((s) => `${s.slug} v${s.major_version}`).join(', ')}. Make another key eligible first, or force.`);
      }
    }
    const status = opts.compromised ? 'compromised' : 'retired';
    if (opts.compromised) await tx`UPDATE signing_keys SET status = 'compromised', compromised_at = now() WHERE id = ${keyId}`;
    else await tx`UPDATE signing_keys SET status = 'retired', retired_at = now() WHERE id = ${keyId}`;
    await tx`UPDATE key_compatibilities SET eligible = false WHERE signing_key_id = ${keyId}`;
    await event(tx, keyId, status, actor, { reason: opts.reason, forced: !!opts.force });
    return getSigningKey(tx, keyId);
  }) as Promise<SigningKeyView>;
}

/** Re-encrypt private keys under another KEK version, preserving key identities. Bounded batch. */
export async function rewrapSigningKeys(sql: Sql, kek: Keyring, actor: Actor, toVersion: number, limit = 20): Promise<{ rewrapped: string[]; remaining: number }> {
  if (!kek.hasVersion(toVersion)) throw new AppError('precondition_failed', `SIGNING_KEK_V${toVersion} is not configured`);
  return sql.begin(async (tx) => {
    const rows = await tx<{ signing_key_id: string; algorithm: SignatureAlgorithm; private_format: string; ciphertext: Uint8Array; nonce: Uint8Array; tag: Uint8Array; kek_version: number }[]>`
      SELECT s.*, k.algorithm FROM signing_key_secrets s JOIN signing_keys k ON k.id = s.signing_key_id
      WHERE s.kek_version <> ${toVersion} ORDER BY s.signing_key_id LIMIT ${limit} FOR UPDATE OF s`;
    const done: string[] = [];
    for (const r of rows) {
      const plain = await open(kek, { ciphertext: toBytes(r.ciphertext), nonce: toBytes(r.nonce), tag: toBytes(r.tag), keyVersion: r.kek_version },
        signingKeyAad(r.signing_key_id, r.algorithm, r.private_format, r.kek_version));
      const s = await seal(kek, plain, signingKeyAad(r.signing_key_id, r.algorithm, r.private_format, toVersion), toVersion);
      plain.fill(0);
      await tx`UPDATE signing_key_secrets SET ciphertext = ${s.ciphertext}, nonce = ${s.nonce}, tag = ${s.tag}, kek_version = ${toVersion}, encrypted_at = now()
               WHERE signing_key_id = ${r.signing_key_id}`;
      await event(tx, r.signing_key_id, 'rewrapped', actor, { fromKekVersion: r.kek_version, toKekVersion: toVersion });
      done.push(r.signing_key_id);
    }
    const rem = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM signing_key_secrets WHERE kek_version <> ${toVersion}`;
    return { rewrapped: done, remaining: rem[0]!.n };
  }) as Promise<{ rewrapped: string[]; remaining: number }>;
}

/**
 * Ids of the keys loadSigners() would sign with right now (same eligibility rules, no secrets).
 * Used to decide whether a stored envelope may be reused or must be re-signed.
 */
export async function usableSigningKeyIds(db: Db, productMajorId: string): Promise<string[]> {
  const rows = await db<(Pick<CompatRow, 'signing_key_id' | 'key_status' | 'trusted_since_version' | 'trusted_until_version' | 'min_release'>)[]>`
    SELECT c.signing_key_id, k.status AS key_status, c.trusted_since_version, c.trusted_until_version,
           (SELECT r.version FROM product_releases r WHERE r.product_major_id = c.product_major_id AND r.is_minimum_supported) AS min_release
    FROM key_compatibilities c
    JOIN signing_keys k ON k.id = c.signing_key_id
    JOIN signing_key_secrets s ON s.signing_key_id = c.signing_key_id
    WHERE c.product_major_id = ${productMajorId} AND c.eligible`;
  return rows.filter((r) => eligibilityBlock(r) === null).map((r) => r.signing_key_id);
}

// Decrypted, non-extractable CryptoKeys cached per isolate to keep per-request CPU low.
const signerCache = new Map<string, Promise<CryptoKey>>();

/**
 * All keys that may sign for a product major right now (brief §7: sign with EVERY eligible key,
 * at most the protocol limit). Throws when none are eligible: issuing with an untrusted key would
 * "succeed" server-side and fail on the device.
 */
export async function loadSigners(db: Db, kek: Keyring, productMajorId: string, maxSignatures: number): Promise<Signer[]> {
  const rows = await db<(CompatRow & { private_format: string; ciphertext: Uint8Array; nonce: Uint8Array; tag: Uint8Array; kek_version: number })[]>`
    SELECT c.id, c.signing_key_id, k.algorithm, k.status AS key_status, c.product_major_id, c.trusted_since_version, c.trusted_until_version, c.eligible,
           (SELECT r.version FROM product_releases r WHERE r.product_major_id = c.product_major_id AND r.is_minimum_supported) AS min_release,
           s.private_format, s.ciphertext, s.nonce, s.tag, s.kek_version
    FROM key_compatibilities c
    JOIN signing_keys k ON k.id = c.signing_key_id
    JOIN signing_key_secrets s ON s.signing_key_id = c.signing_key_id
    WHERE c.product_major_id = ${productMajorId} AND c.eligible
    ORDER BY c.eligible_at NULLS LAST, c.signing_key_id`;
  const usable = rows.filter((r) => eligibilityBlock(r) === null);
  if (usable.length === 0) throw new AppError('provider_unavailable', 'No signing key is eligible for this product major');
  if (usable.length > maxSignatures) throw new AppError('internal', 'More eligible keys than the protocol allows');
  const out: Signer[] = [];
  for (const r of usable) {
    // Bound to the KEK material fingerprint and the exact ciphertext, so a different KEK or a
    // rewrapped/replaced secret never reuses a previously decrypted key.
    const cacheKey = `${r.signing_key_id}:${r.kek_version}:${await kek.fingerprint(r.kek_version)}:${await sha256Hex(toBytes(r.ciphertext))}`;
    let p = signerCache.get(cacheKey);
    if (!p) {
      p = (async () => {
        const plain = await open(kek, { ciphertext: toBytes(r.ciphertext), nonce: toBytes(r.nonce), tag: toBytes(r.tag), keyVersion: r.kek_version },
          signingKeyAad(r.signing_key_id, r.algorithm, r.private_format, r.kek_version));
        try {
          return await importPrivateKey(r.algorithm, plain);
        } finally {
          plain.fill(0);
        }
      })();
      p.catch(() => signerCache.delete(cacheKey));
      signerCache.set(cacheKey, p);
    }
    out.push({ keyId: r.signing_key_id, algorithm: r.algorithm, key: await p });
  }
  return out;
}

/** Trusted-key export for application teams: public material only. */
export async function exportTrustedKeys(db: Db, productMajorId?: string) {
  const keys = await listSigningKeys(db);
  const compat = await listCompatibilities(db, productMajorId ? { productMajorId } : {});
  return keys
    .filter((k) => k.status !== 'generated')
    .map((k) => ({
      keyId: k.keyId,
      algorithm: k.algorithm,
      publicKey: k.publicKey,
      status: k.status,
      compatibility: compat.filter((c) => c.keyId === k.keyId).map((c) => ({ product: c.productSlug, major: c.majorVersion, since: c.trustedSinceVersion, until: c.trustedUntilVersion, eligible: c.effectiveEligible })),
    }));
}
