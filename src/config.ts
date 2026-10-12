// Typed, fail-closed configuration. Secrets come from Cloudflare Workers Secrets (production)
// or .dev.vars (local). Missing security-critical secrets make the dependent feature fail
// closed with 503; their names (never values) are reported to administrators.

import { keyringFromEnv, type Keyring } from './crypto/aead.ts';

export interface Env {
  /** Hyperdrive binding (structural type so Node tooling can share this module). */
  HYPERDRIVE?: { connectionString: string };
  /** Direct connection string; only for local Node tooling/tests. Ignored when HYPERDRIVE is bound. */
  DATABASE_URL?: string;
  ENVIRONMENT: string;
  PUBLIC_BASE_URL: string;
  MAIL_FROM_EMAIL: string;
  MAIL_FROM_NAME: string;
  SUPPORT_EMAIL: string;
  STRIPE_API_VERSION: string;
  SIGNING_KEK_ACTIVE_VERSION: string;
  APP_DATA_KEY_ACTIVE_VERSION: string;
  MAIL_TRANSPORT: string;
  MACHINE_PEPPER?: string;
  AUTH_PEPPER?: string;
  API_TOKEN_PEPPER?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  MAILERSEND_API_TOKEN?: string;
  MAILERSEND_WEBHOOK_SECRET?: string;
  /** Test hook: base URL override for the Stripe API (fake server in tests). Never set in production. */
  STRIPE_API_BASE?: string;
  /** Optional Stripe customer-portal login link (https://billing.stripe.com/p/login/…), shown as a fallback. */
  STRIPE_CUSTOMER_PORTAL_LOGIN_URL?: string;
  /** Seller details printed on invoices. */
  INVOICE_SELLER_NAME?: string;
  INVOICE_SELLER_ABN?: string;
  INVOICE_NUMBER_PREFIX?: string;
  MAILERSEND_API_BASE?: string;
  [k: string]: unknown;
}

export class ConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`server configuration incomplete: ${missing.join(', ')}`);
    this.missing = missing;
  }
}

export type Environment = 'development' | 'test' | 'staging' | 'production';
export type MailTransportKind = 'mailersend' | 'capture' | 'disabled';

export interface Config {
  environment: Environment;
  publicBaseUrl: URL;
  mailFrom: { email: string; name: string };
  supportEmail: string;
  stripeApiVersion: string;
  stripeApiBase: string;
  stripePortalLoginUrl: string | null;
  invoice: { sellerName: string; sellerAbn: string | null; prefix: string };
  mailerSendApiBase: string;
  mailTransport: MailTransportKind;
  secureCookies: boolean;
  signingKeks: Keyring;
  appDataKeys: Keyring;
  secret(name: SecretName): string;
  has(name: SecretName): boolean;
  missingSecrets(): string[];
}

export type SecretName =
  | 'MACHINE_PEPPER'
  | 'AUTH_PEPPER'
  | 'API_TOKEN_PEPPER'
  | 'STRIPE_SECRET_KEY'
  | 'STRIPE_WEBHOOK_SECRET'
  | 'MAILERSEND_API_TOKEN'
  | 'MAILERSEND_WEBHOOK_SECRET';

const REQUIRED: SecretName[] = ['MACHINE_PEPPER', 'AUTH_PEPPER', 'API_TOKEN_PEPPER', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];

export function loadConfig(env: Env): Config {
  const environment = (['development', 'test', 'staging', 'production'].includes(env.ENVIRONMENT) ? env.ENVIRONMENT : 'production') as Environment;
  const publicBaseUrl = new URL(env.PUBLIC_BASE_URL);
  const deployed = environment === 'production' || environment === 'staging';
  if (deployed && publicBaseUrl.protocol !== 'https:') throw new ConfigError(['PUBLIC_BASE_URL must be https']);
  let mailTransport = (['mailersend', 'capture', 'disabled'].includes(env.MAIL_TRANSPORT) ? env.MAIL_TRANSPORT : 'mailersend') as MailTransportKind;
  // Production can never silently capture mail and pretend it was sent.
  if (deployed && mailTransport === 'capture') mailTransport = 'mailersend';
  const signingKeks = keyringFromEnv(env, 'SIGNING_KEK');
  const appDataKeys = keyringFromEnv(env, 'APP_DATA_KEY');
  const get = (n: SecretName) => {
    const v = env[n];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  };
  return {
    environment,
    publicBaseUrl,
    mailFrom: { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME },
    supportEmail: env.SUPPORT_EMAIL,
    stripeApiVersion: env.STRIPE_API_VERSION,
    stripeApiBase: !deployed && env.STRIPE_API_BASE ? env.STRIPE_API_BASE : 'https://api.stripe.com',
    invoice: {
      sellerName: env.INVOICE_SELLER_NAME?.trim() || 'RePassCloud',
      sellerAbn: env.INVOICE_SELLER_ABN?.replace(/\s+/g, '') || null,
      prefix: /^[A-Z0-9]{2,10}$/.test(env.INVOICE_NUMBER_PREFIX ?? '') ? env.INVOICE_NUMBER_PREFIX! : 'RPL',
    },
    stripePortalLoginUrl: /^https:\/\/billing\.stripe\.com\/p\/login\/[A-Za-z0-9_]+$/.test(env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL ?? '') ? env.STRIPE_CUSTOMER_PORTAL_LOGIN_URL! : null,
    mailerSendApiBase: !deployed && env.MAILERSEND_API_BASE ? env.MAILERSEND_API_BASE : 'https://api.mailersend.com',
    mailTransport,
    secureCookies: publicBaseUrl.protocol === 'https:',
    signingKeks,
    appDataKeys,
    secret(n) {
      const v = get(n);
      if (!v) throw new ConfigError([n]);
      return v;
    },
    has: (n) => get(n) !== undefined,
    missingSecrets() {
      const m: string[] = REQUIRED.filter((n) => !get(n));
      if (mailTransport === 'mailersend' && !get('MAILERSEND_API_TOKEN')) m.push('MAILERSEND_API_TOKEN');
      if (!signingKeks.hasVersion(signingKeks.activeVersion)) m.push(`SIGNING_KEK_V${signingKeks.activeVersion}`);
      if (!appDataKeys.hasVersion(appDataKeys.activeVersion)) m.push(`APP_DATA_KEY_V${appDataKeys.activeVersion}`);
      return m;
    },
  };
}
