// /v1/* — the binding machine API (LICENSING-SERVER-BRIEF.md §5). JSON in, JSON out, errors as
// {error, message}. No cookies, no bearer tokens, no CORS: authentication is the activation
// key or the activation's client secret. Rate-limited per IP and per key/licence/activation.

import { Hono } from 'hono';
import { LicensingRefusal, hashActivationKey, normaliseActivationKey } from '../services/licensing.ts';
import { activate, ActivateBody, deactivate, DeactivateBody, MACHINE_STATUS, MachineError, renew, RenewBody, type MachineErrorCode } from '../services/machine.ts';
import { checkRateLimits, type Limit } from '../services/rate-limit.ts';
import { base64UrlEncode } from '../lib/encoding.ts';
import { type AppEnv, type Ctx, logError, readText } from './context.ts';
import type { Actor } from '../services/actor.ts';

const MAX_BODY = 16 * 1024;

function machineError(c: Ctx, code: MachineErrorCode, message?: string, retryAfter?: number) {
  const e = new MachineError(code, message);
  if (retryAfter) c.header('Retry-After', String(retryAfter));
  return c.json({ error: e.code, message: e.message }, MACHINE_STATUS[code] as 400);
}

async function parseJson(c: Ctx): Promise<unknown> {
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new MachineError('invalid_request', 'Content-Type must be application/json.');
  try {
    return JSON.parse(await readText(c, MAX_BODY));
  } catch {
    throw new MachineError('invalid_request');
  }
}

async function limit(c: Ctx, limits: Limit[]) {
  const d = await checkRateLimits(c.get('deps').sql, limits);
  if (!d.allowed) throw Object.assign(new MachineError('rate_limited'), { retryAfter: d.retryAfterSeconds });
}

const device = (c: Ctx): Actor => ({ type: 'device', id: null, label: 'device', requestId: c.get('requestId'), ipHash: c.get('ipHash') });

function handle(fn: (c: Ctx) => Promise<Response>) {
  return async (c: Ctx) => {
    try {
      return await fn(c);
    } catch (e) {
      if (e instanceof MachineError) return machineError(c, e.code, undefined, (e as MachineError & { retryAfter?: number }).retryAfter);
      if (e instanceof LicensingRefusal) return machineError(c, e.code);
      logError(c, e);
      // 5xx is reserved for server faults (including no eligible signing key or missing
      // configuration); clients treat it as "server unavailable" and never invalidate anything.
      return machineError(c, 'server_error');
    }
  };
}

export const machine = new Hono<AppEnv>();

machine.post('/activations', handle(async (c) => {
  const body = ActivateBody.safeParse(await parseJson(c));
  if (!body.success) return machineError(c, 'invalid_request');
  const { config } = c.get('deps');
  const canonical = normaliseActivationKey(body.data.activationKey);
  const keyTag = canonical ? base64UrlEncode(await hashActivationKey(config, canonical)).slice(0, 22) : 'invalid';
  await limit(c, [
    { key: `v1act:ip:${c.get('ipHash')}`, limit: 30, windowSeconds: 60 },
    { key: `v1act:key:${keyTag}`, limit: 10, windowSeconds: 60 },
  ]);
  return c.json(await activate(c.get('deps').sql, config, device(c), body.data));
}));

machine.post('/licenses/:licenseId/renew', handle(async (c) => {
  const body = RenewBody.safeParse(await parseJson(c));
  if (!body.success) return machineError(c, 'invalid_request');
  const licenseId = c.req.param('licenseId')!;
  await limit(c, [
    { key: `v1renew:ip:${c.get('ipHash')}`, limit: 60, windowSeconds: 60 },
    { key: `v1renew:lic:${licenseId.slice(0, 128)}`, limit: 20, windowSeconds: 60 },
  ]);
  const { sql, config } = c.get('deps');
  return c.json(await renew(sql, config, device(c), licenseId, body.data));
}));

machine.post('/activations/:activationId/deactivate', handle(async (c) => {
  const body = DeactivateBody.safeParse(await parseJson(c));
  if (!body.success) return machineError(c, 'invalid_request');
  const activationId = c.req.param('activationId')!;
  await limit(c, [
    { key: `v1deact:ip:${c.get('ipHash')}`, limit: 30, windowSeconds: 60 },
    { key: `v1deact:act:${activationId.slice(0, 128)}`, limit: 10, windowSeconds: 60 },
  ]);
  const { sql, config } = c.get('deps');
  await deactivate(sql, config, device(c), activationId, body.data);
  return c.body(null, 204);
}));

machine.all('*', (c) => c.json({ error: 'not_found', message: 'Unknown endpoint.' }, 404));
