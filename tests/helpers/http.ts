// Drive the real Hono app (all middleware, routes, services) in Node against real PostgreSQL.
import type { ExecutionContext } from 'hono';
import { handleFetch } from '../../src/router.ts';
import type { Env } from '../../src/config.ts';
import type { Sql } from '../../src/db/client.ts';
import { createApiToken } from '../../src/services/admins.ts';
import type { Config } from '../../src/config.ts';
import { newId } from '../../src/lib/ids.ts';

export class TestCtx {
  pending: Promise<unknown>[] = [];
  waitUntil(p: Promise<unknown>) {
    this.pending.push(p.catch(() => undefined));
  }
  passThroughOnException() {}
  props = {};
  async settle() {
    await Promise.all(this.pending);
    this.pending = [];
  }
}

export class Client {
  cookies = new Map<string, string>();
  constructor(readonly env: Env, readonly base = 'http://localhost:8787') {}

  async request(path: string, init: RequestInit & { form?: Record<string, string>; json?: unknown; token?: string; ip?: string } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    headers.set('cf-connecting-ip', init.ip ?? '198.51.100.7');
    let body = init.body;
    if (init.form) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
      headers.set('origin', this.base);
      body = new URLSearchParams(init.form).toString();
    }
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    if (init.token) headers.set('authorization', `Bearer ${init.token}`);
    const ctx = new TestCtx();
    const res = await handleFetch(new Request(`${this.base}${path}`, { ...init, headers, body, redirect: 'manual' }), this.env, ctx as unknown as ExecutionContext);
    await ctx.settle();
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = sc.split(';');
      const [k, v] = pair!.split('=');
      if (attrs.some((a) => /max-age=0/i.test(a)) || v === '') this.cookies.delete(k!.trim());
      else this.cookies.set(k!.trim(), v!.trim());
    }
    return res;
  }

  async csrfFrom(path: string): Promise<string> {
    const html = await (await this.request(path)).text();
    return /name="_csrf" value="([^"]*)"/.exec(html)?.[1] ?? '';
  }
}

export function httpEnv(dbUrl: string, base: Env): Env {
  return { ...base, DATABASE_URL: dbUrl };
}

/** Bootstrap a super administrator directly (as scripts/bootstrap-admin.ts does) and mint a PAT. */
export async function bootstrapAdminToken(sql: Sql, config: Config, scopes: string[], opts: { roles?: string[]; expiresInDays?: number; allowedCidrs?: string[] } = {}) {
  const adminId = newId('adm');
  await sql`INSERT INTO admin_users (id, email, display_name, totp_enrolled_at) VALUES (${adminId}, ${`root-${adminId.slice(-6).toLowerCase()}@example.test`}, 'Root', now())`;
  for (const r of opts.roles ?? ['superadmin']) await sql`INSERT INTO admin_user_roles (admin_user_id, role_id) VALUES (${adminId}, ${r})`;
  const perms = new Set((await sql<{ permission: string }[]>`SELECT permission FROM role_permissions WHERE role_id IN (SELECT role_id FROM admin_user_roles WHERE admin_user_id = ${adminId})`).map((r) => r.permission));
  const t = await createApiToken(sql, config, { type: 'admin', id: adminId, label: 'root', permissions: perms, mfaAt: new Date() }, { name: 'test', scopes, expiresInDays: opts.expiresInDays ?? 30, allowedCidrs: opts.allowedCidrs ?? [] });
  return { adminId, token: t.token, tokenId: t.id };
}
