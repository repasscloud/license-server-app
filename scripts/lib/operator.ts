// Shared helpers for operator CLIs. Secrets are read from the environment or stdin, never argv.
import { createInterface } from 'node:readline/promises';
import { loadConfig, type Env } from '../../src/config.ts';
import { createSql } from '../../src/db/client.ts';

export function operatorEnv(): Env {
  const e = process.env;
  return {
    ENVIRONMENT: e.ENVIRONMENT ?? 'production',
    PUBLIC_BASE_URL: e.PUBLIC_BASE_URL ?? 'https://license-server.repasscloud.com',
    MAIL_FROM_EMAIL: e.MAIL_FROM_EMAIL ?? 'hello@repasscloud.com',
    MAIL_FROM_NAME: e.MAIL_FROM_NAME ?? 'RePassCloud Licensing',
    SUPPORT_EMAIL: e.SUPPORT_EMAIL ?? 'hello@repasscloud.com',
    STRIPE_API_VERSION: e.STRIPE_API_VERSION ?? '2026-09-30.endive',
    SIGNING_KEK_ACTIVE_VERSION: e.SIGNING_KEK_ACTIVE_VERSION ?? '1',
    APP_DATA_KEY_ACTIVE_VERSION: e.APP_DATA_KEY_ACTIVE_VERSION ?? '1',
    MAIL_TRANSPORT: 'disabled',
    ...Object.fromEntries(Object.entries(e).filter(([k]) => /^(SIGNING_KEK_V\d+|APP_DATA_KEY_V\d+|MACHINE_PEPPER|AUTH_PEPPER|API_TOKEN_PEPPER)$/.test(k))),
  } as Env;
}

export function operatorDeps() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (direct connection)');
  const env = operatorEnv();
  return { sql: createSql(url, { max: 1 }), config: loadConfig(env), env };
}

export async function readSecretLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await rl.question(prompt);
  rl.close();
  return answer.trim();
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
export const flag = (name: string) => process.argv.includes(`--${name}`);
