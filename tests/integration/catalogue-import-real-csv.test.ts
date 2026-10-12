// The real stripe-catalogue/products.csv, uploaded as-is into an EMPTY licence-server database
// (no CurseDelete product yet), with Stripe holding exactly what the Stripe script created.
// This is the owner's actual first import: it must create the product, major, editions and
// offers from the file alone, link the existing Stripe products, and then be a no-op.

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config, type Env } from '../../src/config.ts';
import type { Sql } from '../../src/db/client.ts';
import { parseCsv } from '../../src/lib/csv.ts';
import { freshDatabase } from '../helpers/db.ts';
import { FakeStripe } from '../helpers/fake-providers.ts';
import { testEnv } from '../helpers/fixtures.ts';
import { bootstrapAdminToken, Client, httpEnv } from '../helpers/http.ts';

let sql: Sql;
let drop: () => Promise<void>;
let env: Env;
let config: Config;
let stripe: FakeStripe;
let admin: Client;
let token: string;
const text = readFileSync(new URL('../../stripe-catalogue/products.csv', import.meta.url), 'utf8');

async function call(method: string, path: string, json?: unknown) {
  const res = await admin.request(`/api/admin/v1${path}`, { method, json, token });
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
  ({ token } = await bootstrapAdminToken(sql, config, ['products:read', 'products:write', 'prices:read', 'prices:write']));
  // Mirror what sync-products.sh created: same ids, names, descriptions and sku metadata.
  for (const { values: v } of parseCsv(text).rows) {
    stripe.products.set(v.product_id!, { id: v.product_id, object: 'product', name: v.name, description: v.description, active: v.active !== 'no', metadata: { sku: v['_meta:sku'] } });
  }
});

afterAll(async () => {
  await stripe?.stop();
  await drop?.();
});

describe('the real stripe-catalogue/products.csv into an empty catalogue', () => {
  it('previews cleanly: creates CurseDelete, v2, four editions and six offers; skips the books', async () => {
    expect((await sql`SELECT 1 FROM products`).length).toBe(0);
    const { status, body: imp } = await call('POST', '/catalogue/imports', { csv: text, fileName: 'products.csv' });
    expect(status).toBe(201);
    const problems = [...imp.plan.entities, ...imp.plan.rows].filter((x: any) => x.errors.length).map((x: any) => `${x.label ?? x.sku}: ${x.errors.join('; ')}`);
    expect(problems).toEqual([]);
    expect(imp.summary).toMatchObject({ rows: 11, skipped: 5, selected: 6, create: 6, errors: 0, entitiesToCreate: 6, entityErrors: 0 });
    expect(imp.plan.entities.map((e: any) => e.changes[0])).toEqual([
      'create product cursedelete named "CurseDelete" (draft)',
      'create major cursedelete v2 on protocol repass-v1 (draft; transfer allowance 3 (default), activation key in email yes (default))',
      'create edition policy cursedelete v2 community edition: "community", none, individual, offline indefinite, certificate lifetime none, transfer allowance major default',
      'create edition policy cursedelete v2 education edition: "education", none, institution, offline indefinite, certificate lifetime none, transfer allowance major default',
      'create edition policy cursedelete v2 business edition: "business", device_seats, organisation, offline indefinite, certificate lifetime none, transfer allowance major default',
      'create edition policy cursedelete v2 enterprise edition: "enterprise", none, organisation, offline indefinite, certificate lifetime none, transfer allowance major default',
    ]);
    expect(imp.plan.rows.filter((r: any) => r.action === 'skipped').map((r: any) => r.sku)).toEqual([
      'ai-normal-people-1-pdf', 'ai-normal-people-1-epub', 'ai-normal-people-1-bundle', 'ai-normal-people-1-paperback-signed', 'ai-normal-people-1-paperback_colour-signed',
    ]);
    expect((await sql`SELECT 1 FROM products`).length).toBe(0);

    const applied = await call('POST', `/catalogue/imports/${imp.id}/apply`, {});
    expect(applied.status).toBe(200);
    expect(applied.body.result.counts).toMatchObject({ applied: 6, errors: 0, partial: 0, entitiesCreated: 6 });
    const offers = await sql<{ sku: string; edition_id: string; display_name: string; stripe_product_id: string }[]>`
      SELECT o.sku, ep.edition_id, ep.display_name, pm.stripe_product_id FROM offers o
      JOIN offer_entitlement_components c ON c.offer_id = o.id JOIN product_edition_policies ep ON ep.id = c.edition_policy_id
      JOIN stripe_product_mappings pm ON pm.offer_id = o.id ORDER BY o.sku`;
    expect(offers.map((o) => [o.sku, o.edition_id, o.display_name])).toEqual([
      ['cd2-business-annual', 'business', 'business'], ['cd2-business-monthly', 'business', 'business'], ['cd2-business-perpetual', 'business', 'business'],
      ['cd2-community', 'community', 'community'], ['cd2-education', 'education', 'education'], ['cd2-enterprise', 'enterprise', 'enterprise'],
    ]);
    const csvIds = new Map(parseCsv(text).rows.map((r) => [r.values['_meta:sku'], r.values.product_id]));
    for (const o of offers) expect(o.stripe_product_id).toBe(csvIds.get(o.sku));
    // Existing Stripe products were linked, never created.
    expect(stripe.requests.filter((r) => r.method === 'POST' && r.path === '/v1/products').length).toBe(0);
  });

  it('a second upload of the same file changes nothing', async () => {
    const { body: imp } = await call('POST', '/catalogue/imports', { csv: text, fileName: 'products.csv' });
    expect(imp.summary).toMatchObject({ unchanged: 6, create: 0, update: 0, link: 0, errors: 0, entitiesToCreate: 0, entityErrors: 0 });
  });
});
