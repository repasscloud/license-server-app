// Top-level dispatch. Machine traffic (/v1/*) is served by a minimal app with only the three
// binding routes, so a cold isolate does not pay to build the full portal/admin router — this
// keeps first-request CPU on the licensing hot path low (Workers Free: 10 ms/request).

import { Hono, type ExecutionContext } from 'hono';
import type { Env } from './config.ts';
import { type AppEnv, baseMiddleware, bodyLimit, logError, securityHeaders } from './http/context.ts';
import { machine } from './http/machine.ts';

const machineApp = new Hono<AppEnv>();
machineApp.use('*', securityHeaders);
machineApp.use('*', baseMiddleware);
machineApp.use('*', bodyLimit(16 * 1024));
machineApp.route('/v1', machine);
machineApp.notFound((c) => c.json({ error: 'not_found', message: 'Not found.' }, 404));
machineApp.onError((e, c) => {
  logError(c, e);
  return c.json({ error: 'server_error', message: 'The licensing server is temporarily unavailable.' }, 503);
});

let fullApp: Promise<typeof import('./app.tsx')> | null = null;

export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/v1/')) return machineApp.fetch(request, env, ctx);
  fullApp ??= import('./app.tsx');
  return (await fullApp).app.fetch(request, env, ctx);
}
