// Per-request dependencies and shared HTTP helpers.

import type { Context, MiddlewareHandler } from 'hono';
import { ConfigError, loadConfig, type Config, type Env } from '../config.ts';
import { createSql, type Sql } from '../db/client.ts';
import { CaptureTransport, DisabledTransport, MailerSendTransport, type MailTransport } from '../integrations/mail.ts';
import { StripeClient } from '../integrations/stripe.ts';
import { AppError } from '../lib/errors.ts';
import { ulid } from '../lib/ids.ts';
import { hashIdentifier } from '../services/human-auth.ts';
import type { Actor } from '../services/actor.ts';
import { ZodError } from 'zod';

export interface Deps {
  config: Config;
  sql: Sql;
  stripe: StripeClient;
  mail: MailTransport;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    deps: Deps;
    ip: string | null;
    ipHash: string;
    actor: Actor;
    sessionToken: string;
    csrf: string;
  };
};

export type Ctx = Context<AppEnv>;

export function connectionString(env: Env): string {
  if (env.HYPERDRIVE?.connectionString) return env.HYPERDRIVE.connectionString;
  if (typeof env.DATABASE_URL === 'string' && env.DATABASE_URL && env.ENVIRONMENT !== 'production') return env.DATABASE_URL;
  throw new ConfigError(['HYPERDRIVE']);
}

export function makeDeps(env: Env): Deps {
  const config = loadConfig(env);
  const sql = createSql(connectionString(env), { max: 5 });
  const stripe = new StripeClient({
    secretKey: config.has('STRIPE_SECRET_KEY') ? config.secret('STRIPE_SECRET_KEY') : 'sk_unconfigured',
    apiVersion: config.stripeApiVersion,
    baseUrl: config.stripeApiBase,
  });
  let mail: MailTransport;
  if (config.mailTransport === 'mailersend') mail = config.has('MAILERSEND_API_TOKEN') ? new MailerSendTransport(config.secret('MAILERSEND_API_TOKEN'), config.mailerSendApiBase) : new DisabledTransport();
  else if (config.mailTransport === 'capture') mail = new CaptureTransport();
  else mail = new DisabledTransport();
  return { config, sql, stripe, mail };
}

/** Request id, deps (DB opened lazily by postgres.js), client IP hash, structured log line. */
export const baseMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = `req_${ulid()}`;
  c.set('requestId', requestId);
  const started = Date.now();
  let deps: Deps | null = null;
  try {
    deps = makeDeps(c.env);
    c.set('deps', deps);
    const ip = c.req.header('cf-connecting-ip') ?? null;
    c.set('ip', ip);
    c.set('ipHash', deps.config.has('AUTH_PEPPER') && ip ? await hashIdentifier(deps.config, 'ip', ip) : 'unknown');
    await next();
  } finally {
    c.header('X-Request-Id', requestId);
    if (deps) {
      const sql = deps.sql;
      try {
        c.executionCtx.waitUntil(sql.end({ timeout: 5 }));
      } catch {
        await sql.end({ timeout: 5 });
      }
    }
    // Structured access log: never includes bodies, tokens, keys or raw IPs.
    console.log(JSON.stringify({ t: new Date().toISOString(), requestId, method: c.req.method, path: new URL(c.req.url).pathname, status: c.res.status, ms: Date.now() - started }));
  }
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  // same-origin, not no-referrer: no-referrer makes browsers send `Origin: null` on our own form posts.
  h.set('Referrer-Policy', 'same-origin');
  h.set('X-Frame-Options', 'DENY');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; " +
      "frame-ancestors 'none'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  );
  if (new URL(c.req.url).protocol === 'https:') h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  if (!h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
};

export function bodyLimit(maxBytes: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const len = Number(c.req.header('content-length') ?? '0');
    if (len > maxBytes) return c.json({ error: 'invalid_request', message: 'Request body too large.' }, 413);
    await next();
  };
}

/** Read a body as text with a hard limit (works without Content-Length). */
export async function readText(c: Ctx, maxBytes: number): Promise<string> {
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new AppError('invalid_request', 'Request body too large');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
}

export function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof ZodError) {
    return new AppError('validation_failed', 'Request validation failed', e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  if (e instanceof ConfigError) return new AppError('provider_unavailable', 'Service temporarily unavailable (configuration)');
  if (e instanceof SyntaxError) return new AppError('invalid_request', 'Malformed JSON');
  const pg = e as { code?: string };
  if (pg?.code === '23505') return new AppError('conflict', 'Conflicting record already exists');
  if (pg?.code === '23514' || pg?.code === '23503' || pg?.code === '22P02') return new AppError('validation_failed', 'The request violates a data constraint');
  return new AppError('internal', 'Internal error');
}

export function logError(c: Ctx, e: unknown) {
  const err = e as Error & { code?: string };
  console.error(JSON.stringify({ t: new Date().toISOString(), requestId: c.get('requestId'), level: 'error', name: err?.name, code: err?.code, message: String(err?.message ?? e).slice(0, 500) }));
}
