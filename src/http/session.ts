// Cookie sessions for the two human realms. Separate cookie names, separate tables rows
// (realm column), separate middleware: a customer cookie can never authenticate /admin, and the
// admin API ignores cookies entirely.

import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { csrfToken, getSession, verifyCsrf, type Realm, type SessionInfo } from '../services/human-auth.ts';
import type { AppEnv, Ctx } from './context.ts';

export function cookieName(c: Ctx, realm: Realm): string {
  const secure = c.get('deps').config.secureCookies;
  return `${secure ? '__Host-' : ''}rp_${realm === 'admin' ? 'adm' : 'cus'}`;
}

export function setSessionCookie(c: Ctx, realm: Realm, token: string, maxAgeSeconds: number) {
  setCookie(c, cookieName(c, realm), token, {
    httpOnly: true,
    secure: c.get('deps').config.secureCookies,
    sameSite: realm === 'admin' ? 'Strict' : 'Lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(c: Ctx, realm: Realm) {
  deleteCookie(c, cookieName(c, realm), { path: '/', secure: c.get('deps').config.secureCookies });
}

/** Reject cross-site form posts: Origin (or Sec-Fetch-Site) must be our own origin. */
export function sameOrigin(c: Ctx): boolean {
  const origin = c.req.header('origin');
  const expected = c.get('deps').config.publicBaseUrl.origin;
  if (origin) return origin === expected;
  const site = c.req.header('sec-fetch-site');
  return site === undefined || site === 'same-origin' || site === 'none';
}

export interface RealmSession extends SessionInfo {
  token: string;
}

export async function loadSession(c: Ctx, realm: Realm): Promise<RealmSession | null> {
  const token = getCookie(c, cookieName(c, realm));
  if (!token) return null;
  const s = await getSession(c.get('deps').sql, c.get('deps').config, realm, token);
  return s ? { ...s, token } : null;
}

/** For POSTs in a cookie realm: same-origin + session-bound CSRF token. */
export function csrfGuard(realm: Realm): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'POST') {
      if (!sameOrigin(c)) return c.text('Cross-site request rejected', 403);
      const token = getCookie(c, cookieName(c, realm));
      if (token) {
        const form = await c.req.parseBody();
        const presented = typeof form._csrf === 'string' ? form._csrf : null;
        if (!(await verifyCsrf(c.get('deps').config, token, presented))) return c.text('Invalid or missing CSRF token. Reload the page and try again.', 403);
      }
    }
    const token = getCookie(c, cookieName(c, realm));
    c.set('csrf', token ? await csrfToken(c.get('deps').config, token) : '');
    await next();
  };
}

export async function formData(c: Ctx): Promise<Record<string, string>> {
  const body = await c.req.parseBody({ all: true });
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === '_csrf') continue;
    const val = Array.isArray(v) ? v.map(String).join(',') : String(v);
    out[k] = val;
  }
  return out;
}

export const numOrNull = (s: string | undefined) => (s === undefined || s.trim() === '' ? null : Number(s));
export const strOrNull = (s: string | undefined) => (s === undefined || s.trim() === '' ? null : s.trim());
export const bool = (s: string | undefined) => s === 'on' || s === 'true' || s === '1';
