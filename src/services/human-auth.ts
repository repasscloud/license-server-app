// Two separate human identity realms, sharing mechanics but never credentials:
//   customer: passwordless email link -> customer session (portal only)
//   admin:    email link (1st factor) -> pending_mfa session -> TOTP (2nd factor) -> admin session
// No passwords are stored anywhere: a PBKDF2/Argon2 cost that is safe would not fit the Workers
// Free CPU budget, and weakening it is not acceptable (mandate §11).
// Link tokens, session tokens and CSRF tokens are HMAC'd with AUTH_PEPPER; only hashes are stored.

import type { Config } from '../config.ts';
import { appDataAad, openCompact, sealCompact } from '../crypto/aead.ts';
import { hmac } from '../crypto/hashing.ts';
import { toBytes, type Db, type Sql } from '../db/client.ts';
import { base64UrlEncode, timingSafeEqual } from '../lib/encoding.ts';
import { AppError, conflict, invalid } from '../lib/errors.ts';
import { newId, randomBytes } from '../lib/ids.ts';
import { newTotpSecret, otpauthUri, verifyTotp } from '../auth/totp.ts';
import type { Actor } from './actor.ts';
import { audit } from './audit.ts';
import { normaliseEmail } from './customers.ts';
import { enqueueEmail } from './email.ts';
import { checkRateLimits } from './rate-limit.ts';

export type Realm = 'customer' | 'admin';

const LINK_TTL_MIN = 15;
const POLICY = {
  customer: { absoluteMs: 12 * 3600_000, idleMs: 2 * 3600_000 },
  admin: { absoluteMs: 8 * 3600_000, idleMs: 30 * 60_000, pendingMs: 10 * 60_000 },
};

const tokenHash = (config: Config, label: string, token: string) => hmac(config.secret('AUTH_PEPPER'), label, token);
export const newOpaqueToken = () => base64UrlEncode(randomBytes(32));

export async function hashIdentifier(config: Config, kind: string, value: string): Promise<string> {
  return base64UrlEncode(await hmac(config.secret('AUTH_PEPPER'), `ident/${kind}`, value)).slice(0, 22);
}

function safeRedirect(path: string | null | undefined, realm: Realm): string {
  const root = realm === 'admin' ? '/admin' : '/portal';
  if (!path || !path.startsWith(root) || path.startsWith('//') || /[\r\n\\]/.test(path)) return root;
  return path;
}

/** Always resolves identically whether or not the email exists (anti-enumeration). */
export async function requestLogin(sql: Sql, config: Config, realm: Realm, rawEmail: string, ipHash: string, redirectPath?: string | null): Promise<void> {
  const email = normaliseEmail(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return;
  const emailHash = await hashIdentifier(config, 'email', email);
  const rl = await checkRateLimits(sql, [
    { key: `login:${realm}:email:${emailHash}`, limit: 5, windowSeconds: 3600 },
    { key: `login:${realm}:ip:${ipHash}`, limit: 30, windowSeconds: 3600 },
  ]);
  if (!rl.allowed) return;
  // Customers: the first sign-in creates the portal account (purchases attach to it by email later).
  // It stays unverified until the emailed link is used. Disabled accounts get nothing.
  // Admins: only existing, active administrators.
  const subject = realm === 'customer'
    ? (await sql<{ id: string; status: string }[]>`
        INSERT INTO portal_users (id, email) VALUES (${newId('usr')}, ${email})
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email RETURNING id, status`)[0]
    : (await sql<{ id: string; status: string }[]>`SELECT id, status FROM admin_users WHERE email = ${email}`)[0];
  if (!subject || subject.status !== 'active') return;
  const token = newOpaqueToken();
  const id = newId('chl');
  await sql.begin(async (tx) => {
    await tx`INSERT INTO auth_challenges (id, realm, purpose, subject_id, token_hash, redirect_path, created_ip_hash, expires_at)
             VALUES (${id}, ${realm}, 'login', ${subject.id}, ${await tokenHash(config, 'login-link/v1', token)}, ${safeRedirect(redirectPath, realm)}, ${ipHash},
                     now() + make_interval(mins => ${LINK_TTL_MIN}))`;
    const url = new URL(realm === 'admin' ? '/admin/auth/verify' : '/portal/auth/verify', config.publicBaseUrl);
    url.searchParams.set('token', token);
    await enqueueEmail(tx, config, {
      businessKey: `login:${id}`, templateKey: realm === 'admin' ? 'admin_login' : 'customer_login', category: 'security',
      to: email, vars: { loginUrl: url.toString(), expiresMinutes: String(LINK_TTL_MIN) },
    });
    await audit(tx, { type: realm === 'admin' ? 'admin' : 'customer', id: subject.id, label: realm, ipHash }, { action: `${realm}.login_link_sent`, resourceType: realm === 'admin' ? 'admin_user' : 'portal_user', resourceId: subject.id });
  });
}

export interface SessionInfo {
  realm: Realm;
  subjectId: string;
  state: 'pending_mfa' | 'active';
  mfaAt: Date | null;
  expiresAt: Date;
  idHash: Uint8Array<ArrayBuffer>;
}

/** Consume a link token exactly once; returns a new session token for the cookie. */
export async function consumeLoginLink(sql: Sql, config: Config, realm: Realm, token: string, ipHash: string): Promise<{ sessionToken: string; redirect: string; state: 'pending_mfa' | 'active' }> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('unauthorized', 'This sign-in link is invalid or has expired.');
  const h = await tokenHash(config, 'login-link/v1', token);
  return sql.begin(async (tx) => {
    const [c] = await tx<{ id: string; subject_id: string; redirect_path: string | null }[]>`
      UPDATE auth_challenges SET consumed_at = now()
      WHERE token_hash = ${h} AND realm = ${realm} AND consumed_at IS NULL AND expires_at > now()
      RETURNING id, subject_id, redirect_path`;
    if (!c) throw new AppError('unauthorized', 'This sign-in link is invalid or has expired.');
    const sessionToken = newOpaqueToken();
    const now = Date.now();
    let state: 'pending_mfa' | 'active' = 'active';
    let expires: Date;
    let idle: Date;
    if (realm === 'customer') {
      const [u] = await tx<{ status: string }[]>`UPDATE portal_users SET email_verified_at = coalesce(email_verified_at, now()), last_login_at = now() WHERE id = ${c.subject_id} RETURNING status`;
      if (u?.status !== 'active') throw new AppError('unauthorized', 'This account is disabled.');
      expires = new Date(now + POLICY.customer.absoluteMs);
      idle = new Date(now + POLICY.customer.idleMs);
    } else {
      const [a] = await tx<{ status: string }[]>`SELECT status FROM admin_users WHERE id = ${c.subject_id}`;
      if (a?.status !== 'active') throw new AppError('unauthorized', 'This account is disabled.');
      state = 'pending_mfa';
      expires = new Date(now + POLICY.admin.pendingMs);
      idle = expires;
    }
    await tx`INSERT INTO auth_sessions (id_hash, realm, subject_id, state, expires_at, idle_expires_at, ip_hash)
             VALUES (${await tokenHash(config, 'session/v1', sessionToken)}, ${realm}, ${c.subject_id}, ${state}, ${expires}, ${idle}, ${ipHash})`;
    await audit(tx, { type: realm === 'admin' ? 'admin' : 'customer', id: c.subject_id, label: realm, ipHash }, { action: `${realm}.login_link_consumed`, resourceType: 'session', detail: { state } });
    return { sessionToken, redirect: safeRedirect(c.redirect_path, realm), state };
  });
}

export async function getSession(db: Db, config: Config, realm: Realm, sessionToken: string | undefined): Promise<SessionInfo | null> {
  if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return null;
  const idHash = await tokenHash(config, 'session/v1', sessionToken);
  const [s] = await db<{ subject_id: string; state: 'pending_mfa' | 'active'; mfa_at: Date | null; expires_at: Date; idle_expires_at: Date; last_seen_at: Date }[]>`
    SELECT subject_id, state, mfa_at, expires_at, idle_expires_at, last_seen_at FROM auth_sessions
    WHERE id_hash = ${idHash} AND realm = ${realm} AND revoked_at IS NULL AND expires_at > now() AND idle_expires_at > now()`;
  if (!s) return null;
  // Sliding idle window; write at most once a minute to save queries.
  if (s.state === 'active' && Date.now() - s.last_seen_at.getTime() > 60_000) {
    const idleMs = realm === 'admin' ? POLICY.admin.idleMs : POLICY.customer.idleMs;
    await db`UPDATE auth_sessions SET last_seen_at = now(), idle_expires_at = least(expires_at, now() + make_interval(secs => ${idleMs / 1000})) WHERE id_hash = ${idHash}`;
  }
  return { realm, subjectId: s.subject_id, state: s.state, mfaAt: s.mfa_at, expiresAt: s.expires_at, idHash };
}

export async function logout(db: Db, config: Config, realm: Realm, sessionToken: string | undefined): Promise<void> {
  if (!sessionToken) return;
  await db`UPDATE auth_sessions SET revoked_at = now() WHERE id_hash = ${await tokenHash(config, 'session/v1', sessionToken)} AND realm = ${realm}`;
}

export async function revokeAllSessions(db: Db, realm: Realm, subjectId: string): Promise<void> {
  await db`UPDATE auth_sessions SET revoked_at = now() WHERE realm = ${realm} AND subject_id = ${subjectId} AND revoked_at IS NULL`;
}

/** CSRF token bound to the session (synchroniser pattern, derived so nothing extra is stored). */
export async function csrfToken(config: Config, sessionToken: string): Promise<string> {
  return base64UrlEncode(await hmac(config.secret('AUTH_PEPPER'), 'csrf/v1', sessionToken)).slice(0, 32);
}

export async function verifyCsrf(config: Config, sessionToken: string, presented: string | undefined | null): Promise<boolean> {
  if (!presented) return false;
  const expected = new TextEncoder().encode(await csrfToken(config, sessionToken));
  return timingSafeEqual(expected, new TextEncoder().encode(presented));
}

// ---------------------------------------------------------------------------------------------
// Admin TOTP second factor
// ---------------------------------------------------------------------------------------------

interface AdminTotpRow {
  totp_secret_ciphertext: Uint8Array | null;
  totp_key_version: number | null;
  totp_enrolled_at: Date | null;
  totp_last_step: number | null;
  email: string;
}

async function loadTotpSecret(config: Config, adminId: string, row: AdminTotpRow): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!row.totp_secret_ciphertext || !row.totp_key_version) return null;
  return openCompact(config.appDataKeys, toBytes(row.totp_secret_ciphertext), row.totp_key_version, appDataAad('admin-totp', adminId));
}

/** Begin TOTP enrolment for an admin who has none (first login after invite/bootstrap). */
export async function beginTotpEnrolment(sql: Sql, config: Config, session: SessionInfo): Promise<{ otpauthUri: string; secretBase32: string }> {
  const [a] = await sql<AdminTotpRow[]>`SELECT totp_secret_ciphertext, totp_key_version, totp_enrolled_at, totp_last_step, email FROM admin_users WHERE id = ${session.subjectId}`;
  if (!a) throw new AppError('unauthorized', 'Unknown administrator');
  if (a.totp_enrolled_at) throw conflict('An authenticator is already enrolled');
  let secret = await loadTotpSecret(config, session.subjectId, a);
  if (!secret) {
    secret = newTotpSecret();
    const sealed = await sealCompact(config.appDataKeys, secret, appDataAad('admin-totp', session.subjectId));
    await sql`UPDATE admin_users SET totp_secret_ciphertext = ${sealed.blob}, totp_key_version = ${sealed.keyVersion} WHERE id = ${session.subjectId} AND totp_enrolled_at IS NULL`;
  }
  const uri = otpauthUri(secret, a.email);
  return { otpauthUri: uri, secretBase32: new URL(uri).searchParams.get('secret')! };
}

/** Verify a TOTP code: completes login (pending_mfa -> active), enrolment, or step-up. */
export async function verifyAdminTotp(sql: Sql, config: Config, session: SessionInfo, code: string, ipHash: string): Promise<void> {
  const rl = await checkRateLimits(sql, [{ key: `totp:admin:${session.subjectId}`, limit: 8, windowSeconds: 300 }]);
  if (!rl.allowed) throw new AppError('rate_limited', 'Too many attempts. Wait a few minutes.');
  await sql.begin(async (tx) => {
    const [a] = await tx<AdminTotpRow[]>`SELECT totp_secret_ciphertext, totp_key_version, totp_enrolled_at, totp_last_step, email FROM admin_users WHERE id = ${session.subjectId} AND status = 'active' FOR UPDATE`;
    const actor: Actor = { type: 'admin', id: session.subjectId, label: a?.email ?? 'admin', ipHash };
    const secret = a ? await loadTotpSecret(config, session.subjectId, a) : null;
    const step = secret ? await verifyTotp(secret, code.trim(), a!.totp_last_step) : null;
    if (step === null) {
      await audit(tx, actor, { action: 'admin.mfa_failed', outcome: 'failure', resourceType: 'admin_user', resourceId: session.subjectId });
      throw new AppError('unauthorized', 'That code is not valid.');
    }
    await tx`UPDATE admin_users SET totp_last_step = ${step}, totp_enrolled_at = coalesce(totp_enrolled_at, now()), last_login_at = now() WHERE id = ${session.subjectId}`;
    const now = Date.now();
    if (session.state === 'pending_mfa') {
      await tx`UPDATE auth_sessions SET state = 'active', mfa_at = now(), expires_at = ${new Date(now + POLICY.admin.absoluteMs)},
               idle_expires_at = ${new Date(now + POLICY.admin.idleMs)}, last_seen_at = now() WHERE id_hash = ${session.idHash}`;
    } else {
      await tx`UPDATE auth_sessions SET mfa_at = now() WHERE id_hash = ${session.idHash}`;
    }
    await audit(tx, actor, { action: session.state === 'pending_mfa' ? 'admin.login_completed' : 'admin.step_up', resourceType: 'admin_user', resourceId: session.subjectId, detail: { enrolled: !a!.totp_enrolled_at } });
  });
}

export async function adminTotpEnrolled(db: Db, adminId: string): Promise<boolean> {
  const [a] = await db<{ e: boolean }[]>`SELECT totp_enrolled_at IS NOT NULL AS e FROM admin_users WHERE id = ${adminId}`;
  return !!a?.e;
}

export function assertCodeShape(code: unknown): string {
  if (typeof code !== 'string' || !/^\s*\d{6}\s*$/.test(code)) throw invalid('Enter the 6-digit code from your authenticator app');
  return code.trim();
}
