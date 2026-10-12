// Catalogue CSV import through the admin API: only _ls:import rows, dry run first, idempotent
// re-runs, immutable components, linked Stripe products, and activation.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config, type Env } from '../../src/config.ts';
import type { Sql } from '../../src/db/client.ts';
import { freshDatabase } from '../helpers/db.ts';
import { FakeStripe } from '../helpers/fake-providers.ts';
import { seedProduct, superActor, testEnv } from '../helpers/fixtures.ts';
import { bootstrapAdminToken, Client, httpEnv } from '../helpers/http.ts';

let sql: Sql;
let drop: () => Promise<void>;
let env: Env;
let config: Config;
let stripe: FakeStripe;
let admin: Client;
let token: string;

const CURRENCIES = ['aud', 'usd', 'eur', 'gbp', 'cad', 'nzd', 'sgd', 'hkd', 'jpy', 'cny', 'chf'];
const STRIPE_COLUMNS = ['product_id', 'price_id', 'name', 'description', 'tax_code', 'active', 'shippable', '_image:url', '_price:create', '_meta:sku'];
const LS_COLUMNS = ['_ls:import', '_ls:product', '_ls:major', '_ls:edition', '_ls:billing', '_ls:interval', '_ls:seats_per_unit', '_ls:quantity_scales_seats',
  '_ls:max_quantity', '_ls:activate', ...CURRENCIES.map((c) => `_ls:price:${c}`), '_ls:tax_percent:aud', '_ls:tax_label:aud'];
const HEADERS = [...STRIPE_COLUMNS, ...LS_COLUMNS];

const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
function csv(rows: Array<Record<string, string>>, headers = HEADERS): string {
  return '﻿' + [headers.join(','), ...rows.map((r) => headers.map((h) => quote(r[h] ?? '')).join(','))].join('\n') + '\n';
}
const prices = (amount: number, extra: Record<string, string> = {}) => ({ ...Object.fromEntries(CURRENCIES.map((c) => [`_ls:price:${c}`, String(amount)])), ...extra });

const products = { ent: '', biz: '' };
let rows: Array<Record<string, string>>;

async function importCsv(body: string, apply: boolean, t = token) {
  const res = await admin.request('/api/admin/v1/catalogue/import', { method: 'POST', json: { csv: body, apply }, token: t });
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  let url: string;
  ({ sql, drop, url } = await freshDatabase());
  const base = testEnv();
  stripe = await new FakeStripe(base.STRIPE_WEBHOOK_SECRET as string).start();
  env = httpEnv(url, { ...base, STRIPE_API_BASE: stripe.url });
  config = loadConfig(env);
  admin = new Client(env);
  await seedProduct(sql, config, superActor(), 'cursedelete', 2);
  ({ token } = await bootstrapAdminToken(sql, config, ['products:read', 'products:write', 'prices:read', 'prices:write']));
  products.ent = stripe.createProductDirect('CurseDelete 2 Enterprise');
  products.biz = stripe.createProductDirect('CurseDelete 2 Business');
  rows = [
    // A product from another project in the same CSV: not marked, so never imported.
    { product_id: stripe.createProductDirect('AI for Normal People — PDF'), name: 'AI for Normal People — PDF', '_meta:sku': 'ai-normal-people-1-pdf', '_price:create': 'no' },
    { product_id: products.ent, name: 'CurseDelete 2 Enterprise', description: 'Perpetual, organisation-wide', '_meta:sku': 'cd2-enterprise', '_image:url': 'https://raw.githubusercontent.com/repasscloud/license-server-app/main/assets/products/cursedelete-2.png',
      '_ls:import': 'yes', '_ls:product': 'cursedelete', '_ls:major': '2', '_ls:edition': 'enterprise', '_ls:billing': 'one_time', '_ls:activate': 'yes',
      ...prices(49900, { '_ls:tax_percent:aud': '10', '_ls:tax_label:aud': 'GST', '_ls:price:jpy': '49800' }) },
    { product_id: products.biz, name: 'CurseDelete 2 Business (annual, per seat)', '_meta:sku': 'cd2-business-annual', '_ls:import': 'yes', '_ls:product': 'cursedelete', '_ls:major': '2',
      '_ls:edition': 'business', '_ls:billing': 'recurring', '_ls:interval': 'year', '_ls:seats_per_unit': '1', '_ls:quantity_scales_seats': 'yes', '_ls:max_quantity': '100', '_ls:activate': 'yes', ...prices(4900) },
    // Not yet created in Stripe (no product_id): imported as a draft with a note.
    { name: 'CurseDelete 2 Community registration', '_meta:sku': 'cd2-community', '_ls:import': 'yes', '_ls:product': 'cursedelete', '_ls:major': '2', '_ls:edition': 'community', '_ls:billing': 'free', ...prices(0) },
  ];
});

afterAll(async () => {
  await stripe?.stop();
  await drop?.();
});

describe('catalogue CSV import', () => {
  it('rejects files without the license-server columns, and typos in them', async () => {
    expect((await importCsv(csv(rows, STRIPE_COLUMNS), false)).body.error.message).toMatch(/no _ls:import column/);
    const typo = await importCsv(csv(rows, [...HEADERS, '_ls:edtion']), false);
    expect(typo.status).toBe(422);
    expect(typo.body.error.message).toMatch(/Unknown license-server column\(s\): _ls:edtion/);
  });

  it('needs products:write and prices:write', async () => {
    const { token: readOnly } = await bootstrapAdminToken(sql, config, ['products:read', 'products:write']);
    expect((await importCsv(csv(rows), false, readOnly)).status).toBe(403);
  });

  it('dry run reports the plan for marked rows only and changes nothing', async () => {
    const before = stripe.requests.length;
    const r = await importCsv(csv(rows), false);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, selected: 3, skipped: 1, created: 3, updated: 0, unchanged: 0, errors: 0 });
    expect(r.body.rows[0]).toMatchObject({ line: 2, sku: 'ai-normal-people-1-pdf', action: 'skipped' });
    expect(r.body.rows[1].changes).toEqual(['create offer (cursedelete v2 enterprise, one_time, perpetual)',
      `set prices ${CURRENCIES.map((c) => `${c.toUpperCase()} ${c === 'jpy' ? 49800 : 49900}`).join(', ')}`, `link Stripe product ${products.ent}`, 'activate']);
    expect(r.body.rows[3].warnings).toContain('no product_id yet: run the Stripe script first; the offer cannot be activated until it is linked');
    expect((await sql`SELECT 1 FROM offers`).length).toBe(0);
    // Only read-only Stripe calls (product checks).
    expect(stripe.requests.slice(before).every((x) => x.method === 'GET')).toBe(true);
  });

  it('apply creates, prices, links and activates exactly the marked offers', async () => {
    const r = await importCsv(csv(rows), true);
    expect(r.body).toMatchObject({ dryRun: false, selected: 3, skipped: 1, created: 3, errors: 0 });
    const offers = await sql<{ sku: string; status: string; billing: string; stripe_product_id: string | null }[]>`
      SELECT o.sku, o.status, o.billing, m.stripe_product_id FROM offers o JOIN stripe_product_mappings m ON m.offer_id = o.id ORDER BY o.sku`;
    expect(offers).toEqual([
      { sku: 'cd2-business-annual', status: 'active', billing: 'recurring', stripe_product_id: products.biz },
      { sku: 'cd2-community', status: 'draft', billing: 'free', stripe_product_id: null },
      { sku: 'cd2-enterprise', status: 'active', billing: 'one_time', stripe_product_id: products.ent },
    ]);
    const [aud] = await sql<{ unit_amount: number; tax_rate_bps: number; tax_label: string }[]>`
      SELECT pv.unit_amount, pv.tax_rate_bps, pv.tax_label FROM price_versions pv JOIN offers o ON o.id = pv.offer_id WHERE o.sku = 'cd2-enterprise' AND pv.currency = 'aud' AND pv.status = 'active'`;
    expect(aud).toEqual({ unit_amount: 49900, tax_rate_bps: 1000, tax_label: 'GST' });
    const [biz] = await sql<{ recurring_interval: string; seats_per_unit: number; quantity_scales_seats: boolean; max_quantity: number }[]>`
      SELECT pv.recurring_interval, c.seats_per_unit, c.quantity_scales_seats, o.max_quantity FROM offers o JOIN price_versions pv ON pv.offer_id = o.id
      JOIN offer_entitlement_components c ON c.offer_id = o.id WHERE o.sku = 'cd2-business-annual' AND pv.currency = 'usd'`;
    expect(biz).toEqual({ recurring_interval: 'year', seats_per_unit: 1, quantity_scales_seats: true, max_quantity: 100 });
    // Stripe keeps its name; only metadata is added. No product is ever created.
    expect(stripe.products.get(products.ent)).toMatchObject({ name: 'CurseDelete 2 Enterprise', metadata: { repass_sku: 'cd2-enterprise' } });
    expect(stripe.requests.filter((x) => x.method === 'POST' && x.path === '/v1/products').length).toBe(0);
    const [a] = await sql<{ detail: { created: number; skus: string[] } }[]>`SELECT detail FROM audit_events WHERE action = 'catalogue.imported'`;
    expect(a!.detail).toMatchObject({ created: 3, skus: ['cd2-enterprise:create', 'cd2-business-annual:create', 'cd2-community:create'] });
    expect((await sql`SELECT 1 FROM audit_events WHERE action = 'offer.created'`).length).toBe(3);
  });

  it('re-running is a no-op; changes create new price versions only where they differ', async () => {
    const again = await importCsv(csv(rows), true);
    expect(again.body).toMatchObject({ created: 0, updated: 0, unchanged: 3, errors: 0 });
    const versions = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM price_versions`)[0]!.n;
    const n = await versions();
    rows[1] = { ...rows[1]!, name: 'CurseDelete 2 Enterprise (perpetual)', '_ls:price:aud': '54900' };
    const changed = await importCsv(csv(rows), true);
    expect(changed.body).toMatchObject({ updated: 1, unchanged: 2, errors: 0 });
    expect(changed.body.rows[1].changes).toEqual(['update name', 'set prices AUD 54900']);
    expect(await versions()).toBe(n + 1);
    expect((await sql`SELECT name FROM offers WHERE sku = 'cd2-enterprise'`)[0]!.name).toBe('CurseDelete 2 Enterprise (perpetual)');
  });

  it('refuses to change what an existing offer grants, per row, without stopping other rows', async () => {
    const bad = rows.map((r) => (r['_meta:sku'] === 'cd2-business-annual' ? { ...r, '_ls:seats_per_unit': '5' } : r));
    bad.push({ ...rows[3]!, name: 'Duplicate' });
    const linkedTwice = { ...rows[3]!, '_meta:sku': 'cd2-community-2', product_id: products.ent };
    bad.push(linkedTwice);
    const r = await importCsv(csv(bad), true);
    expect(r.body.errors).toBe(3);
    expect(r.body.rows[2]).toMatchObject({ sku: 'cd2-business-annual', action: 'error' });
    expect(r.body.rows[2].error).toMatch(/cannot change \(seats_per_unit 1 → 5\); use a new SKU/);
    expect(r.body.rows[4].error).toMatch(/SKU cd2-community is also on line 5/);
    expect(r.body.rows[5].error).toMatch(/Stripe product .* is also on line 3/);
    expect(r.body.rows[1].action).toBe('unchanged');
  });

  it('accepts the documented example CSV (stripe-catalogue/license-server.example.csv)', async () => {
    const example = readFileSync(new URL('../../stripe-catalogue/license-server.example.csv', import.meta.url), 'utf8')
      .replace(/cd2-(business-annual|enterprise|community)/g, 'ex-$1');
    const r = await importCsv(example, false);
    expect(r.body).toMatchObject({ dryRun: true, selected: 3, created: 3, errors: 0 });
    expect(r.body.rows.every((x: any) => x.warnings.some((w: string) => /no product_id yet/.test(w)))).toBe(true);
  });

  it('activation needs every currency and a linked product', async () => {
    const partial = { ...rows[3]!, '_meta:sku': 'cd2-community-partial', '_ls:activate': 'yes', '_ls:price:chf': '' };
    const r = await importCsv(csv([partial]), false);
    expect(r.body.rows[0].error).toMatch(/needs a linked Stripe product/);
    const linked = { ...partial, product_id: stripe.createProductDirect('CurseDelete 2 Community') };
    expect((await importCsv(csv([linked]), false)).body.rows[0].error).toMatch(/needs a price in every store currency; missing CHF/);
  });
});
