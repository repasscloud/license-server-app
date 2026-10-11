// Signing keys live in PostgreSQL (public + AES-256-GCM encrypted private). A dump/restore to
// another PostgreSQL preserves identities and, with the separately held KEK, signing ability.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { buildEnvelope, verifyEnvelope } from '../../src/crypto/envelope.ts';
import { createSql, type Sql } from '../../src/db/client.ts';
import { base64UrlDecode } from '../../src/lib/encoding.ts';
import { generateSigningKey, loadSigners, rewrapSigningKeys } from '../../src/services/signing-keys.ts';
import { freshDatabase } from '../helpers/db.ts';
import { seedProduct, superActor, testConfig, testEnv } from '../helpers/fixtures.ts';

function bin(name: string): string {
  for (const d of ['/opt/homebrew/opt/postgresql@18/bin', '/usr/lib/postgresql/18/bin', '/usr/lib/postgresql/17/bin', '/usr/bin']) if (existsSync(join(d, name))) return join(d, name);
  return name;
}

let a: { sql: Sql; url: string; drop: () => Promise<void> };
let restoredSql: Sql;
let restoredName: string;
let majorId: string;
const { env, config } = testConfig();
const admin = superActor();
const dir = mkdtempSync(join(tmpdir(), 'repass-dump-'));

beforeAll(async () => {
  a = await freshDatabase();
  majorId = (await seedProduct(a.sql, config, admin)).majorId;
  await generateSigningKey(a.sql, config.signingKeks, admin, { algorithm: 'ECDSA-P256-SHA256', keyId: 'repass-p256-2026' });
  // Dump with pg_dump (custom format) and restore into a brand-new database.
  const dump = join(dir, 'db.dump');
  execFileSync(bin('pg_dump'), ['-Fc', '-f', dump, a.url]);
  restoredName = `repass_restore_${Math.random().toString(36).slice(2, 8)}`;
  const admin2 = postgres(inject('pgAdminUrl'), { max: 1, onnotice: () => {} });
  await admin2.unsafe(`CREATE DATABASE ${restoredName}`);
  await admin2.end();
  const u = new URL(inject('pgAdminUrl'));
  u.pathname = `/${restoredName}`;
  execFileSync(bin('pg_restore'), ['--no-owner', '-d', u.toString(), dump]);
  restoredSql = createSql(u.toString());
});

afterAll(async () => {
  await restoredSql?.end();
  const admin2 = postgres(inject('pgAdminUrl'), { max: 1, onnotice: () => {} });
  await admin2.unsafe(`DROP DATABASE IF EXISTS ${restoredName} WITH (FORCE)`);
  await admin2.end();
  await a?.drop();
  rmSync(dir, { recursive: true, force: true });
});

async function signAndVerify(sql: Sql, cfg = config) {
  const signers = await loadSigners(sql, cfg.signingKeks, majorId, 8);
  const { envelope } = await buildEnvelope('repass-license-v1', { schemaVersion: 1, x: 1 }, signers, 8);
  const keys = await sql<{ id: string; algorithm: 'Ed25519' | 'ML-DSA-65' | 'ECDSA-P256-SHA256'; public_key: Uint8Array }[]>`SELECT id, algorithm, public_key FROM signing_keys`;
  const r = await verifyEnvelope(JSON.stringify(envelope), 'repass-license-v1', keys.map((k) => ({ keyId: k.id, algorithm: k.algorithm, publicKey: new Uint8Array(k.public_key) })));
  return { ok: r.ok, keyIds: r.ok ? r.verifiedKeyIds : [] };
}

describe('PostgreSQL key registry portability and KEK lifecycle', () => {
  it('restored database preserves key identities, public keys and encrypted private keys', async () => {
    const before = await a.sql`SELECT id, encode(public_key, 'hex') AS pk, fingerprint FROM signing_keys ORDER BY id`;
    const after = await restoredSql`SELECT id, encode(public_key, 'hex') AS pk, fingerprint FROM signing_keys ORDER BY id`;
    expect(after).toEqual(before);
    const enc = await restoredSql<{ n: number }[]>`SELECT count(*)::int AS n FROM signing_key_secrets WHERE octet_length(ciphertext) = 32 AND octet_length(nonce) = 12 AND octet_length(tag) = 16`;
    expect(enc[0]!.n).toBe(3);
    // No plaintext seed is present anywhere in the dump-restored rows.
    const raw = await restoredSql<{ c: string }[]>`SELECT encode(ciphertext, 'hex') AS c FROM signing_key_secrets`;
    expect(raw.map((r) => r.c)).not.toContain('01'.repeat(32));
  });

  it('signs after restore with the separately held KEK', async () => {
    const r = await signAndVerify(restoredSql);
    expect(r).toEqual({ ok: true, keyIds: ['vector-ed25519', 'vector-mldsa65'] });
  });

  it('fails closed with the wrong KEK', async () => {
    const wrong = loadConfig(testEnv({ MACHINE_PEPPER: env.MACHINE_PEPPER }));
    await expect(loadSigners(restoredSql, wrong.signingKeks, majorId, 8)).rejects.toThrow(/decryption failed/);
  });

  it('rewraps to a new KEK version without changing key ids; the old KEK can then be removed', async () => {
    const v2 = testEnv().SIGNING_KEK_V1 as string;
    const both = loadConfig({ ...env, SIGNING_KEK_V2: v2, SIGNING_KEK_ACTIVE_VERSION: '2' });
    const r = await rewrapSigningKeys(restoredSql, both.signingKeks, admin, 2, 20);
    expect(r.remaining).toBe(0);
    expect(r.rewrapped.sort()).toEqual(['repass-p256-2026', 'vector-ed25519', 'vector-mldsa65']);
    const onlyV2 = loadConfig({ ...env, SIGNING_KEK_V1: undefined, SIGNING_KEK_V2: v2, SIGNING_KEK_ACTIVE_VERSION: '2' });
    expect((await signAndVerify(restoredSql, onlyV2)).ok).toBe(true);
    const onlyV1 = loadConfig({ ...env, SIGNING_KEK_ACTIVE_VERSION: '1' });
    await expect(loadSigners(restoredSql, onlyV1.signingKeks, majorId, 8)).rejects.toThrow(/SIGNING_KEK_V2 is not configured/);
    const events = await restoredSql`SELECT 1 FROM key_lifecycle_events WHERE event = 'rewrapped'`;
    expect(events.length).toBe(3);
  });

  it('detects tampering and ciphertext transplanted between keys (AAD binding)', async () => {
    const cfg = loadConfig({ ...env, SIGNING_KEK_ACTIVE_VERSION: '1' });
    // Original DB still on KEK v1. Swap the Ed25519 ciphertext into the ML-DSA row.
    await a.sql`UPDATE signing_key_secrets t SET ciphertext = s.ciphertext, nonce = s.nonce, tag = s.tag
                FROM signing_key_secrets s WHERE t.signing_key_id = 'vector-mldsa65' AND s.signing_key_id = 'vector-ed25519'`;
    await expect(loadSigners(a.sql, cfg.signingKeks, majorId, 8)).rejects.toThrow(/decryption failed/);
    expect(base64UrlDecode('AA').length).toBe(1);
  });

  it('private key material is never deletable (append-only registry)', async () => {
    await expect(a.sql`DELETE FROM signing_keys WHERE id = 'repass-p256-2026'`).rejects.toThrow(/append-only|foreign key/);
    await expect(a.sql`DELETE FROM signing_key_secrets WHERE signing_key_id = 'repass-p256-2026'`).rejects.toThrow(/append-only/);
  });
});
