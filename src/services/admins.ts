// Administrators, roles, service accounts and API tokens (PATs / service-account tokens).
//
// Token format:  rpl_pat_<lookup>_<secret>   (owned by an admin user)
//                rpl_svc_<lookup>_<secret>   (owned by a service account)
// lookup = 16 chars Crockford base32 (public, indexed); secret = 43 chars base64url (256 bits).
// Stored: HMAC-SHA-256(API_TOKEN_PEPPER, secret). The plaintext is returned exactly once.
// Effective permissions = token scopes ∩ owner's CURRENT permissions (role changes and
// disablement take effect on the next request). There is no unrevocable master key.

import { z } from 'zod';
import type { Config } from '../config.ts';
import { hmac } from '../crypto/hashing.ts';
import { toBytes, type Db, type Sql } from '../db/client.ts';
import { timingSafeEqual } from '../lib/encoding.ts';
import { conflict, forbidden, invalid, notFound } from '../lib/errors.ts';
import { newId, randomBytes, ulid } from '../lib/ids.ts';
import { base64UrlEncode } from '../lib/encoding.ts';
import { ALL_PERMISSIONS, HIGH_RISK_SCOPES, isPermission } from '../auth/permissions.ts';
import { ipInCidr, isValidCidr } from '../auth/cidr.ts';
import { requireHighRisk, requirePermission, type Actor } from './actor.ts';
import { audit } from './audit.ts';
import { normaliseEmail } from './customers.ts';
import { revokeAllSessions } from './human-auth.ts';
import { checkRateLimits } from './rate-limit.ts';
import { enqueueEmail } from './email.ts';

// ---------------------------------------------------------------------------------------------
// Permissions resolution
// ---------------------------------------------------------------------------------------------

export async function adminPermissions(db: Db, adminId: string): Promise<Set<string>> {
  const rows = await db<{ permission: string }[]>`
    SELECT DISTINCT rp.permission FROM admin_user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    JOIN admin_users a ON a.id = ur.admin_user_id WHERE ur.admin_user_id = ${adminId} AND a.status = 'active'`;
  return new Set(rows.map((r) => r.permission));
}

export async function adminActor(db: Db, adminId: string, extra: { mfaAt: Date | null; requestId?: string; ipHash?: string }): Promise<Actor | null> {
  const [a] = await db<{ email: string; status: string }[]>`SELECT email, status FROM admin_users WHERE id = ${adminId}`;
  if (!a || a.status !== 'active') return null;
  return { type: 'admin', id: adminId, label: a.email, permissions: await adminPermissions(db, adminId), mfaAt: extra.mfaAt, requestId: extra.requestId, ipHash: extra.ipHash };
}

// ---------------------------------------------------------------------------------------------
// Admin users and roles
// ---------------------------------------------------------------------------------------------

export const InviteAdminInput = z.object({
  email: z.email().max(254).transform(normaliseEmail),
  displayName: z.string().trim().min(1).max(200),
  roles: z.array(z.string()).min(1),
}).strict();

export async function inviteAdmin(sql: Sql, actor: Actor, raw: unknown, config?: Config) {
  requireHighRisk(actor, 'admins:manage');
  const input = InviteAdminInput.parse(raw);
  return sql.begin(async (tx) => {
    const dup = await tx`SELECT 1 FROM admin_users WHERE email = ${input.email}`;
    if (dup.length) throw conflict('An administrator with that email already exists');
    const roles = await tx<{ id: string }[]>`SELECT id FROM roles WHERE id IN (SELECT jsonb_array_elements_text(${tx.json(input.roles as never)}::jsonb))`;
    if (roles.length !== new Set(input.roles).size) throw invalid('Unknown role');
    const id = newId('adm');
    await tx`INSERT INTO admin_users (id, email, display_name) VALUES (${id}, ${input.email}, ${input.displayName})`;
    for (const r of roles) await tx`INSERT INTO admin_user_roles (admin_user_id, role_id, granted_by) VALUES (${id}, ${r.id}, ${actor.label})`;
    await audit(tx, actor, { action: 'admin.invited', resourceType: 'admin_user', resourceId: id, detail: { roles: input.roles } });
    if (config) {
      await enqueueEmail(tx, config, { businessKey: `admin_invited:${id}`, templateKey: 'admin_invited', category: 'security', to: input.email,
        vars: { roles: input.roles.join(', '), adminUrl: new URL('/admin/login', config.publicBaseUrl).toString() } });
    }
    return { id, email: input.email, displayName: input.displayName, roles: input.roles };
  });
}

async function superadminCount(db: Db, excluding?: string): Promise<number> {
  const [r] = await db<{ n: number }[]>`
    SELECT count(DISTINCT a.id)::int AS n FROM admin_users a JOIN admin_user_roles ur ON ur.admin_user_id = a.id
    WHERE ur.role_id = 'superadmin' AND a.status = 'active' AND a.totp_enrolled_at IS NOT NULL AND a.id <> ${excluding ?? ''}`;
  return r!.n;
}

export async function setAdminRoles(sql: Sql, actor: Actor, adminId: string, roles: string[]) {
  requireHighRisk(actor, 'admins:manage');
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727274002)`;
    const [a] = await tx`SELECT 1 FROM admin_users WHERE id = ${adminId}`;
    if (!a) throw notFound('Administrator');
    if (!roles.includes('superadmin') && (await superadminCount(tx, adminId)) === 0) throw conflict('Cannot remove the last enrolled super administrator');
    const valid = await tx<{ id: string }[]>`SELECT id FROM roles WHERE id IN (SELECT jsonb_array_elements_text(${tx.json(roles as never)}::jsonb))`;
    if (valid.length !== new Set(roles).size) throw invalid('Unknown role');
    await tx`DELETE FROM admin_user_roles WHERE admin_user_id = ${adminId}`;
    for (const r of valid) await tx`INSERT INTO admin_user_roles (admin_user_id, role_id, granted_by) VALUES (${adminId}, ${r.id}, ${actor.label})`;
    await audit(tx, actor, { action: 'admin.roles_set', resourceType: 'admin_user', resourceId: adminId, detail: { roles } });
    return { id: adminId, roles };
  });
}

export async function setAdminStatus(sql: Sql, actor: Actor, adminId: string, status: 'active' | 'disabled') {
  requireHighRisk(actor, 'admins:manage');
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727274002)`;
    if (status === 'disabled' && actor.id === adminId) throw conflict('You cannot disable yourself');
    if (status === 'disabled' && (await superadminCount(tx, adminId)) === 0) throw conflict('Cannot disable the last enrolled super administrator');
    const r = await tx`UPDATE admin_users SET status = ${status} WHERE id = ${adminId} RETURNING id`;
    if (!r.length) throw notFound('Administrator');
    if (status === 'disabled') {
      await revokeAllSessions(tx, 'admin', adminId);
      await tx`UPDATE admin_api_tokens SET revoked_at = now(), revoked_reason = 'owner disabled' WHERE admin_user_id = ${adminId} AND revoked_at IS NULL`;
    }
    await audit(tx, actor, { action: `admin.${status}`, resourceType: 'admin_user', resourceId: adminId });
    return { id: adminId, status };
  });
}

/** Clear an admin's authenticator so they re-enrol on next login (lost device). */
export async function resetAdminTotp(sql: Sql, actor: Actor, adminId: string) {
  requireHighRisk(actor, 'admins:manage');
  return sql.begin(async (tx) => {
    const r = await tx`UPDATE admin_users SET totp_secret_ciphertext = NULL, totp_key_version = NULL, totp_enrolled_at = NULL, totp_last_step = NULL WHERE id = ${adminId} RETURNING id`;
    if (!r.length) throw notFound('Administrator');
    await revokeAllSessions(tx, 'admin', adminId);
    await audit(tx, actor, { action: 'admin.totp_reset', resourceType: 'admin_user', resourceId: adminId });
  });
}

export async function listAdmins(db: Db) {
  return db<{ id: string; email: string; display_name: string; status: string; totp_enrolled: boolean; roles: string; last_login_at: Date | null; created_at: Date }[]>`
    SELECT a.id, a.email, a.display_name, a.status, a.totp_enrolled_at IS NOT NULL AS totp_enrolled, a.last_login_at, a.created_at,
      coalesce((SELECT string_agg(role_id, ',' ORDER BY role_id) FROM admin_user_roles WHERE admin_user_id = a.id), '') AS roles
    FROM admin_users a ORDER BY a.created_at`;
}

export async function listRoles(db: Db) {
  return db<{ id: string; name: string; description: string; permissions: string }[]>`
    SELECT r.id, r.name, r.description, coalesce((SELECT string_agg(permission, ',' ORDER BY permission) FROM role_permissions WHERE role_id = r.id), '') AS permissions
    FROM roles r ORDER BY r.id`;
}

// ---------------------------------------------------------------------------------------------
// Service accounts
// ---------------------------------------------------------------------------------------------

export const ServiceAccountInput = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,63}$/),
  description: z.string().trim().max(500).default(''),
  allowedScopes: z.array(z.string()).min(1),
}).strict();

export async function createServiceAccount(sql: Sql, actor: Actor, raw: unknown) {
  requireHighRisk(actor, 'admins:manage');
  const input = ServiceAccountInput.parse(raw);
  for (const s of input.allowedScopes) if (!isPermission(s)) throw invalid(`Unknown scope ${s}`);
  // A service account can never be granted more than its creator holds.
  for (const s of input.allowedScopes) if (!actor.permissions?.has(s)) throw forbidden(`You cannot delegate ${s}`);
  return sql.begin(async (tx) => {
    const dup = await tx`SELECT 1 FROM service_accounts WHERE name = ${input.name}`;
    if (dup.length) throw conflict('A service account with that name exists');
    const id = newId('svc');
    await tx`INSERT INTO service_accounts (id, name, description, allowed_scopes, created_by)
             VALUES (${id}, ${input.name}, ${input.description}, (SELECT array_agg(x) FROM jsonb_array_elements_text(${tx.json(input.allowedScopes as never)}::jsonb) x), ${actor.label})`;
    await audit(tx, actor, { action: 'service_account.created', resourceType: 'service_account', resourceId: id, detail: { allowedScopes: input.allowedScopes } });
    return { id, ...input };
  });
}

export async function setServiceAccountStatus(sql: Sql, actor: Actor, id: string, status: 'active' | 'disabled') {
  requireHighRisk(actor, 'admins:manage');
  return sql.begin(async (tx) => {
    const r = await tx`UPDATE service_accounts SET status = ${status} WHERE id = ${id} RETURNING id`;
    if (!r.length) throw notFound('Service account');
    if (status === 'disabled') await tx`UPDATE admin_api_tokens SET revoked_at = now(), revoked_reason = 'service account disabled' WHERE service_account_id = ${id} AND revoked_at IS NULL`;
    await audit(tx, actor, { action: `service_account.${status}`, resourceType: 'service_account', resourceId: id });
    return { id, status };
  });
}

export async function listServiceAccounts(db: Db) {
  return db<{ id: string; name: string; description: string; allowed_scopes: string[]; status: string; created_at: Date }[]>`SELECT * FROM service_accounts ORDER BY name`;
}

// ---------------------------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------------------------

export const CreateTokenInput = z.object({
  name: z.string().trim().min(1).max(100),
  serviceAccountId: z.string().nullable().default(null),
  scopes: z.array(z.string()).min(1).max(ALL_PERMISSIONS.length),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  notBefore: z.coerce.date().nullable().default(null),
  allowedCidrs: z.array(z.string()).max(20).default([]),
  rateLimitPerMinute: z.number().int().min(1).max(10000).default(120),
}).strict();

const TOKEN_RE = /^rpl_(pat|svc)_([0-9A-HJKMNP-TV-Z]{16})_([A-Za-z0-9_-]{43})$/;

async function secretHash(config: Config, secret: string) {
  return hmac(config.secret('API_TOKEN_PEPPER'), 'api-token/v1', secret);
}

export interface CreatedToken {
  id: string;
  token: string; // shown once
  name: string;
  scopes: string[];
  expiresAt: string;
  owner: { type: 'admin' | 'service_account'; id: string };
}

/**
 * Create a token. Admins may create tokens for themselves within their own permissions.
 * Tokens for service accounts require tokens:manage. High-risk scopes are capped at 30 days.
 * Must be invoked from an MFA-fresh admin session or a token holding tokens:manage.
 */
export async function createApiToken(sql: Sql, config: Config, actor: Actor, raw: unknown, now = new Date()): Promise<CreatedToken> {
  const input = CreateTokenInput.parse(raw);
  const owner = input.serviceAccountId ? { type: 'service_account' as const, id: input.serviceAccountId } : null;
  if (actor.type !== 'admin' && actor.type !== 'api_token') throw forbidden();
  if (owner || actor.type === 'api_token') requireHighRisk(actor, 'tokens:manage', now);
  else if (actor.type === 'admin' && (!actor.mfaAt || now.getTime() - actor.mfaAt.getTime() > 15 * 60_000)) throw forbidden('Creating a token requires a recent authenticator check (step-up)');
  const scopes = [...new Set(input.scopes)];
  for (const s of scopes) {
    if (!isPermission(s)) throw invalid(`Unknown scope ${s}`);
    if (!actor.permissions?.has(s)) throw forbidden(`You cannot delegate scope ${s}`);
  }
  const highRisk = scopes.some((s) => HIGH_RISK_SCOPES.has(s));
  if (highRisk && input.expiresInDays > 30) throw invalid('Tokens with high-risk scopes may last at most 30 days');
  for (const c of input.allowedCidrs) if (!isValidCidr(c)) throw invalid(`Invalid CIDR ${c}`);
  const ownerAdminId = owner ? null : actor.type === 'admin' ? actor.id : (actor.principalId ?? null);
  if (!owner && (!ownerAdminId || !ownerAdminId.startsWith('adm_'))) throw forbidden('Only administrators own personal tokens');
  return sql.begin(async (tx) => {
    if (owner) {
      const [sa] = await tx<{ allowed_scopes: string[]; status: string }[]>`SELECT allowed_scopes, status FROM service_accounts WHERE id = ${owner.id}`;
      if (!sa || sa.status !== 'active') throw notFound('Active service account');
      for (const s of scopes) if (!sa.allowed_scopes.includes(s)) throw forbidden(`Service account is not allowed scope ${s}`);
    }
    const id = newId('tok');
    const lookup = ulid().slice(-16);
    const secret = base64UrlEncode(randomBytes(32));
    const token = `rpl_${owner ? 'svc' : 'pat'}_${lookup}_${secret}`;
    const expiresAt = new Date(now.getTime() + input.expiresInDays * 86_400_000);
    await tx`INSERT INTO admin_api_tokens (id, lookup_id, secret_hash, name, admin_user_id, service_account_id, scopes, not_before, expires_at, allowed_cidrs, rate_limit_per_minute, created_by)
             VALUES (${id}, ${lookup}, ${await secretHash(config, secret)}, ${input.name}, ${ownerAdminId}, ${owner?.id ?? null},
                     (SELECT array_agg(x) FROM jsonb_array_elements_text(${tx.json(scopes as never)}::jsonb) x), ${input.notBefore}, ${expiresAt},
                     (SELECT coalesce(array_agg(x), '{}') FROM jsonb_array_elements_text(${tx.json(input.allowedCidrs as never)}::jsonb) x),
                     ${input.rateLimitPerMinute}, ${actor.label})`;
    await audit(tx, actor, { action: 'api_token.created', resourceType: 'api_token', resourceId: id, detail: { name: input.name, scopes, expiresAt, owner: owner ?? { type: 'admin', id: ownerAdminId }, highRisk } });
    return { id, token, name: input.name, scopes, expiresAt: expiresAt.toISOString(), owner: owner ?? { type: 'admin' as const, id: ownerAdminId! } };
  });
}

async function loadTokenForManagement(db: Db, actor: Actor, id: string) {
  const [t] = await db<{ id: string; admin_user_id: string | null; service_account_id: string | null; revoked_at: Date | null; name: string; scopes: string[]; allowed_cidrs: string[]; rate_limit_per_minute: number; expires_at: Date; created_at: Date }[]>`
    SELECT id, admin_user_id, service_account_id, revoked_at, name, scopes, allowed_cidrs, rate_limit_per_minute, expires_at, created_at FROM admin_api_tokens WHERE id = ${id}`;
  if (!t) throw notFound('Token');
  const selfOwned = t.admin_user_id !== null && (actor.id === t.admin_user_id || actor.principalId === t.admin_user_id);
  if (!selfOwned) requirePermission(actor, 'tokens:manage');
  return t;
}

export async function revokeApiToken(sql: Sql, actor: Actor, id: string, reason: string) {
  return sql.begin(async (tx) => {
    const t = await loadTokenForManagement(tx, actor, id);
    if (t.revoked_at) return { id, revoked: true, changed: false };
    await tx`UPDATE admin_api_tokens SET revoked_at = now(), revoked_reason = ${reason.slice(0, 200)} WHERE id = ${id}`;
    await audit(tx, actor, { action: 'api_token.revoked', resourceType: 'api_token', resourceId: id, detail: { reason } });
    return { id, revoked: true, changed: true };
  });
}

/** Rotate: new secret with the same settings; the old token is revoked atomically. */
export async function rotateApiToken(sql: Sql, config: Config, actor: Actor, id: string, opts: { expiresInDays?: number } = {}): Promise<CreatedToken> {
  const t = await loadTokenForManagement(sql, actor, id);
  if (t.revoked_at) throw conflict('Token is revoked; create a new one');
  const lifetime = opts.expiresInDays ?? Math.max(1, Math.round((t.expires_at.getTime() - t.created_at.getTime()) / 86_400_000));
  const created = await createApiToken(sql, config, actor, {
    name: t.name, serviceAccountId: t.service_account_id, scopes: t.scopes, expiresInDays: Math.min(lifetime, 365),
    allowedCidrs: t.allowed_cidrs, rateLimitPerMinute: t.rate_limit_per_minute,
  });
  await sql.begin(async (tx) => {
    await tx`UPDATE admin_api_tokens SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = ${id} AND revoked_at IS NULL`;
    await tx`UPDATE admin_api_tokens SET rotated_from_id = ${id} WHERE id = ${created.id}`;
    await audit(tx, actor, { action: 'api_token.rotated', resourceType: 'api_token', resourceId: id, detail: { newTokenId: created.id } });
  });
  return created;
}

export async function listApiTokens(db: Db, actor: Actor) {
  const all = actor.permissions?.has('tokens:manage');
  const owner = actor.type === 'admin' ? actor.id : actor.principalId ?? null;
  return db<{ id: string; name: string; lookup_id: string; admin_user_id: string | null; service_account_id: string | null; scopes: string[]; expires_at: Date; last_used_at: Date | null; revoked_at: Date | null; created_at: Date; allowed_cidrs: string[]; rate_limit_per_minute: number }[]>`
    SELECT id, name, lookup_id, admin_user_id, service_account_id, scopes, expires_at, last_used_at, revoked_at, created_at, allowed_cidrs, rate_limit_per_minute
    FROM admin_api_tokens WHERE ${!!all} OR admin_user_id = ${owner ?? ''} ORDER BY created_at DESC LIMIT 500`;
}

export class TokenAuthError extends Error {
  readonly code: 'unauthorized' | 'forbidden' | 'rate_limited';
  readonly retryAfter: number;
  constructor(code: 'unauthorized' | 'forbidden' | 'rate_limited', message: string, retryAfter = 0) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Authenticate `Authorization: Bearer rpl_...`. Never consults cookies. */
export async function authenticateApiToken(sql: Sql, config: Config, bearer: string, ip: string | null, ipHash: string, requestId: string, now = new Date()): Promise<Actor> {
  const m = TOKEN_RE.exec(bearer);
  const generic = new TokenAuthError('unauthorized', 'Invalid, expired or revoked API token');
  if (!m) throw generic;
  const [, kind, lookup, secret] = m as unknown as [string, 'pat' | 'svc', string, string];
  const [t] = await sql<{
    id: string; secret_hash: Uint8Array; scopes: string[]; expires_at: Date; not_before: Date | null; revoked_at: Date | null;
    admin_user_id: string | null; service_account_id: string | null; allowed_cidrs: string[]; rate_limit_per_minute: number; last_used_at: Date | null;
    owner_status: string | null; owner_label: string | null; sa_scopes: string[] | null;
  }[]>`
    SELECT t.*, coalesce(a.status, s.status) AS owner_status, coalesce(a.email, 'svc:' || s.name) AS owner_label, s.allowed_scopes AS sa_scopes
    FROM admin_api_tokens t LEFT JOIN admin_users a ON a.id = t.admin_user_id LEFT JOIN service_accounts s ON s.id = t.service_account_id
    WHERE t.lookup_id = ${lookup}`;
  const expected = t ? toBytes(t.secret_hash) : new Uint8Array(32);
  const ok = timingSafeEqual(expected, await secretHash(config, secret));
  if (!t || !ok || (kind === 'svc') !== (t.service_account_id !== null)) throw generic;
  if (t.revoked_at || t.expires_at <= now || (t.not_before && t.not_before > now) || t.owner_status !== 'active') throw generic;
  if (t.allowed_cidrs.length > 0 && (!ip || !t.allowed_cidrs.some((c) => ipInCidr(ip, c)))) {
    await audit(sql, { type: 'api_token', id: t.id, label: t.owner_label ?? 'token', requestId, ipHash }, { action: 'api_token.ip_denied', outcome: 'denied', resourceType: 'api_token', resourceId: t.id });
    throw new TokenAuthError('forbidden', 'This token may not be used from this network');
  }
  const rl = await checkRateLimits(sql, [{ key: `token:${t.id}`, limit: t.rate_limit_per_minute, windowSeconds: 60 }], now);
  if (!rl.allowed) throw new TokenAuthError('rate_limited', 'API token rate limit exceeded', rl.retryAfterSeconds);
  const ownerPerms = t.admin_user_id ? await adminPermissions(sql, t.admin_user_id) : new Set(t.sa_scopes ?? []);
  const permissions = new Set(t.scopes.filter((s) => ownerPerms.has(s)));
  if (!t.last_used_at || now.getTime() - t.last_used_at.getTime() > 60_000) {
    await sql`UPDATE admin_api_tokens SET last_used_at = ${now}, last_used_ip_hash = ${ipHash} WHERE id = ${t.id}`;
  }
  return {
    type: 'api_token', id: t.id, label: `${t.owner_label}#${t.id.slice(-6)}`, permissions,
    principalId: t.admin_user_id ?? t.service_account_id ?? undefined, requestId, ipHash,
  };
}

export function assertTokenShape(token: string): boolean {
  return TOKEN_RE.test(token);
}
