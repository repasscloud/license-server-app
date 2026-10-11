// Worker entry point: HTTP (Hono app) + Cron Triggers (durable background work).

import { app } from './app.tsx';
import type { Env } from './config.ts';
import { makeDeps } from './http/context.ts';
import { dailyTick, frequentTick } from './jobs/runner.ts';

export default {
  fetch: app.fetch,

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const deps = makeDeps(env);
    const log = (msg: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString(), cron: controller.cron, msg, ...data }));
    try {
      const result = controller.cron === '17 3 * * *' ? await dailyTick({ ...deps, log }) : await frequentTick({ ...deps, log });
      log('tick', result);
    } catch (e) {
      console.error(JSON.stringify({ t: new Date().toISOString(), cron: controller.cron, level: 'error', message: String((e as Error)?.message ?? e).slice(0, 500) }));
      throw e;
    } finally {
      ctx.waitUntil(deps.sql.end({ timeout: 5 }));
    }
  },
} satisfies ExportedHandler<Env>;
