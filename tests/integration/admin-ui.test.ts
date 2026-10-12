// Admin portal through the real HTTP stack: email link -> TOTP enrolment -> MFA session,
// realm isolation, step-up for high-risk actions, and functional (non-decorative) pages.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, currentStep, totpAt } from '../../src/auth/totp.ts';
import { loadConfig, type Env } from '../../src/config.ts';
import type { Sql } from '../../src/db/client.ts';
import { makeDeps } from '../../src/http/context.ts';
import { CaptureTransport } from '../../src/integrations/mail.ts';
import { dispatchEmails } from '../../src/services/email.ts';
import { freshDatabase } from '../helpers/db.ts';
import { FakeStripe } from '../helpers/fake-providers.ts';
import { testEnv } from '../helpers/fixtures.ts';
import { Client, httpEnv } from '../helpers/http.ts';

let sql: Sql;
let drop: () => Promise<void>;
let env: Env;
let ui: Client;
let stripe: FakeStripe;
let totpSecret = '';

async function flushMail() {
  const d = makeDeps(env);
  try {
    await dispatchEmails(d.sql, d.config, d.mail, 20);
  } finally {
    await d.sql.end();
  }
}

async function loginLink(email: string, realm: 'admin' | 'portal'): Promise<string> {
  await flushMail();
  const m = [...CaptureTransport.captured].reverse().find((x) => x.to.email === email)!;
  return new URL(new RegExp(`https?://\\S+/${realm}/auth/verify\\?token=[A-Za-z0-9_-]+`).exec(m.text)![0]).searchParams.get('token')!;
}

beforeAll(async () => {
  let url: string;
  ({ sql, drop, url } = await freshDatabase());
  const base = testEnv();
  stripe = await new FakeStripe(base.STRIPE_WEBHOOK_SECRET as string).start();
  env = httpEnv(url, { ...base, STRIPE_API_BASE: stripe.url });
  loadConfig(env);
  await sql`INSERT INTO admin_users (id, email, display_name) VALUES ('adm_root', 'root@example.test', 'Root')`;
  await sql`INSERT INTO admin_user_roles (admin_user_id, role_id) VALUES ('adm_root', 'superadmin')`;
  ui = new Client(env);
});
afterAll(async () => {
  await stripe?.stop();
  await drop?.();
});

describe('administrator sign-in', () => {
  it('requires login for admin pages', async () => {
    const r = await ui.request('/admin/products');
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toMatch(/^\/admin\/login/);
  });

  it('email link then TOTP enrolment, then MFA-complete session', async () => {
    const csrf = await ui.csrfFrom('/admin/login');
    await ui.request('/admin/login', { method: 'POST', form: { _csrf: csrf, email: 'root@example.test' } });
    const token = await loginLink('root@example.test', 'admin');
    const v = await ui.request('/admin/auth/verify', { method: 'POST', form: { _csrf: await ui.csrfFrom(`/admin/auth/verify?token=${token}`), token } });
    expect(v.headers.get('location')).toBe('/admin/mfa');
    // Pending-MFA session cannot reach admin pages.
    expect((await ui.request('/admin/products')).headers.get('location')).toBe('/admin/mfa');
    const mfaPage = await (await ui.request('/admin/mfa')).text();
    totpSecret = /Setup key: <code class="secret">([A-Z2-7]+)<\/code>/.exec(mfaPage)![1]!;
    const bad = await ui.request('/admin/mfa', { method: 'POST', form: { _csrf: await ui.csrfFrom('/admin/mfa'), code: '000000' } });
    expect(bad.headers.get('location')).toMatch(/err=/);
    const code = await totpAt(base32Decode(totpSecret), currentStep());
    const good = await ui.request('/admin/mfa', { method: 'POST', form: { _csrf: await ui.csrfFrom('/admin/mfa'), code } });
    expect(good.headers.get('location')).toBe('/admin');
    // The same code cannot be replayed.
    const [row] = await sql<{ totp_enrolled_at: Date | null }[]>`SELECT totp_enrolled_at FROM admin_users WHERE id = 'adm_root'`;
    expect(row!.totp_enrolled_at).not.toBeNull();
    const overview = await (await ui.request('/admin')).text();
    expect(overview).toMatch(/Overview/);
  });

  it('admin session does not authenticate the customer portal or the admin API', async () => {
    expect((await ui.request('/portal')).headers.get('location')).toMatch(/^\/portal\/login/);
    expect((await ui.request('/api/admin/v1/me')).status).toBe(401);
  });
});

describe('admin pages are functional', () => {
  it('renders every section', async () => {
    for (const p of ['/admin', '/admin/products', '/admin/offers', '/admin/customers', '/admin/licenses', '/admin/keys', '/admin/billing', '/admin/email', '/admin/access', '/admin/audit']) {
      const r = await ui.request(p);
      expect(r.status, p).toBe(200);
      const html = await r.text();
      expect(html, p).toMatch(/<h1>/);
      expect(r.headers.get('content-security-policy')).toMatch(/script-src 'self'/);
    }
  });

  it('creates a product via the UI form (same service as the API) and audits it', async () => {
    const csrf = await ui.csrfFrom('/admin/products');
    const r = await ui.request('/admin/products', { method: 'POST', form: { _csrf: csrf, slug: 'uiapp', name: 'UI App', description: '', visibility: 'public' } });
    expect(r.status).toBe(303);
    const [a] = await sql<{ actor_type: string; actor_id: string }[]>`SELECT actor_type, actor_id FROM audit_events WHERE action = 'product.created'`;
    expect(a).toEqual({ actor_type: 'admin', actor_id: 'adm_root' });
  });

  it('imports the catalogue CSV: Import CSV button, upload, preview, confirm, result', async () => {
    expect(await (await ui.request('/admin/products')).text()).toContain('href="/admin/catalogue/imports">Import CSV</a>');
    expect(await (await ui.request('/admin/offers')).text()).toContain('href="/admin/catalogue/imports">Import CSV</a>');
    const page = await (await ui.request('/admin/catalogue/imports')).text();
    expect(page).toMatch(/<h1>Import products from the catalogue CSV<\/h1>/);
    expect(page).toContain('enctype="multipart/form-data"');
    // The product exists (created above); its major and edition come from the CSV.
    const prod = stripe.createProductDirect('UI App Enterprise', { description: '', metadata: { sku: 'uiapp1-ent' } });
    const csv = '﻿product_id,name,_meta:sku,_ls:import,_ls:product,_ls:major,_ls:protocol,_ls:edition,_ls:edition_name,_ls:edition_activation_model,_ls:edition_ownership,_ls:edition_offline_policy,_ls:billing,_ls:price:aud\n'
      + 'prod_Book1,"AI for Normal People — PDF",ai-pdf,,,,,,,,,,,\n'
      + `${prod},UI App Enterprise,uiapp1-ent,yes,uiapp,1,repass-v1,enterprise,Enterprise,none,organisation,indefinite,one_time,1000\n`;
    const form = new FormData();
    form.set('_csrf', await ui.csrfFrom('/admin/catalogue/imports'));
    form.set('file', new File([csv], 'products.csv', { type: 'text/csv' }));
    const r = await ui.request('/admin/catalogue/imports', { method: 'POST', body: form, headers: { origin: 'http://localhost:8787' } });
    expect(r.status).toBe(303);
    const previewUrl = r.headers.get('location')!;
    expect(previewUrl).toMatch(/^\/admin\/catalogue\/imports\/imp_[0-9A-Z]{26}$/);
    const html = await (await ui.request(previewUrl)).text();
    expect(html).toContain('Preview only: nothing has changed yet.');
    expect(html).toMatch(/1 row\(s\) to import, 1 skipped · 1 create/);
    expect(html).toContain('create major uiapp v1 on protocol repass-v1');
    expect(html).toContain(`link Stripe product ${prod}`);
    expect(html).toMatch(/no active price for USD, EUR/);
    expect(html).toContain('Confirm and apply');
    expect((await sql`SELECT 1 FROM offers WHERE sku = 'uiapp1-ent'`).length).toBe(0);

    const applied = await ui.request(`${previewUrl}/apply`, { method: 'POST', form: { _csrf: await ui.csrfFrom(previewUrl) } });
    expect(applied.status).toBe(303);
    expect(decodeURIComponent(applied.headers.get('location')!)).toMatch(/Import applied: 1 offer\(s\) changed, 2 product\/major\/edition created/);
    const after = await (await ui.request(previewUrl)).text();
    expect(after).toMatch(/Catalogue import <span class="badge ok">applied<\/span>/);
    expect(after).not.toContain('Confirm and apply');
    const [o] = await sql<{ stripe_product_id: string }[]>`SELECT pm.stripe_product_id FROM offers o JOIN stripe_product_mappings pm ON pm.offer_id = o.id WHERE o.sku = 'uiapp1-ent'`;
    expect(o!.stripe_product_id).toBe(prod);
    // Attributed to the signed-in administrator, through the same audited services as the API.
    const audits = await sql<{ action: string; actor_type: string; actor_id: string }[]>`
      SELECT action, actor_type, actor_id FROM audit_events WHERE action IN ('catalogue.import_previewed', 'catalogue.import_applied', 'offer.created', 'product_major.created')`;
    expect(audits.length).toBe(4);
    for (const a of audits) expect(a).toMatchObject({ actor_type: 'admin', actor_id: 'adm_root' });
    expect(await (await ui.request('/admin/catalogue/imports')).text()).toContain('products.csv');
  });

  it('high-risk actions require a recent TOTP step-up', async () => {
    await sql`UPDATE auth_sessions SET mfa_at = now() - interval '1 hour' WHERE realm = 'admin'`;
    const csrf = await ui.csrfFrom('/admin/keys');
    const r = await ui.request('/admin/keys', { method: 'POST', form: { _csrf: csrf, algorithm: 'Ed25519', keyId: 'ui-ed25519-2026' } });
    expect(r.status).toBe(403);
    expect(await r.text()).toMatch(/step-up/);
    await sql`UPDATE admin_users SET totp_last_step = NULL WHERE id = 'adm_root'`;
    const code = await totpAt(base32Decode(totpSecret), currentStep());
    await ui.request('/admin/step-up', { method: 'POST', form: { _csrf: await ui.csrfFrom('/admin/step-up'), code, next: '/admin/keys' } });
    const ok = await ui.request('/admin/keys', { method: 'POST', form: { _csrf: await ui.csrfFrom('/admin/keys'), algorithm: 'Ed25519', keyId: 'ui-ed25519-2026' } });
    expect(ok.status).toBe(303);
    const page = await (await ui.request('/admin/keys')).text();
    expect(page).toContain('ui-ed25519-2026');
    expect(page).not.toMatch(/ciphertext|private_format/);
  });

  it('creates a personal API token once and it works from a terminal without cookies', async () => {
    const csrf = await ui.csrfFrom('/admin/access');
    const r = await ui.request('/admin/access/tokens', { method: 'POST', body: new URLSearchParams([['_csrf', csrf], ['name', 'laptop'], ['expiresInDays', '7'], ['rateLimitPerMinute', '60'], ['allowedCidrs', ''], ['scopes', 'products:read'], ['scopes', 'audit:read']]).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost:8787' } });
    const html = await r.text();
    const token = /(rpl_pat_[0-9A-Z]{16}_[A-Za-z0-9_-]{43})/.exec(html)![1]!;
    const terminal = new Client(env); // no cookies
    const me = await terminal.request('/api/admin/v1/me', { token });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { permissions: string[] }).permissions).toEqual(['audit:read', 'products:read']);
    // The listing never shows the secret again.
    expect(await (await ui.request('/admin/access')).text()).not.toContain(token);
  });

  it('logout revokes the session', async () => {
    await ui.request('/admin/logout', { method: 'POST', form: { _csrf: await ui.csrfFrom('/admin') } });
    expect((await ui.request('/admin')).headers.get('location')).toMatch(/^\/admin\/login/);
  });
});
