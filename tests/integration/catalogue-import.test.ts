// Catalogue CSV import through the admin API (upload -> preview -> confirmed apply), against real
// PostgreSQL and the Stripe test double: Stripe-first and PostgreSQL-first products, identity and
// duplicate prevention, conflicts reported (never resolved), idempotent re-imports, partial
// failures, authorisation and audit, and checkout-time Stripe products under concurrency.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config, type Env } from '../../src/config.ts';
import type { Sql } from '../../src/db/client.ts';
import * as catalogue from '../../src/services/catalogue.ts';
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
let tokenId: string;

const CURRENCIES = ['aud', 'usd', 'eur', 'gbp', 'cad', 'nzd', 'sgd', 'hkd', 'jpy', 'cny', 'chf'];
type Row = Record<string, string>;

const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/** CSV with the union of the rows' columns (first-seen order), BOM and LF like the Stripe script writes. */
function csv(rows: Row[]): string {
  const headers: string[] = ['product_id', 'name', 'description', '_meta:sku', '_ls:import'];
  for (const r of rows) for (const k of Object.keys(r)) if (!headers.includes(k)) headers.push(k);
  return '﻿' + [headers.join(','), ...rows.map((r) => headers.map((h) => quote(r[h] ?? '')).join(','))].join('\n') + '\n';
}
const prices = (amount: number, extra: Row = {}): Row => ({ ...Object.fromEntries(CURRENCIES.map((c) => [`_ls:price:${c}`, String(amount)])), ...extra });

async function preview(body: string, t = token) {
  const res = await admin.request('/api/admin/v1/catalogue/imports', { method: 'POST', json: { csv: body, fileName: 'products.csv' }, token: t });
  return { status: res.status, body: (await res.json()) as any };
}
async function apply(id: string, t = token) {
  const res = await admin.request(`/api/admin/v1/catalogue/imports/${id}/apply`, { method: 'POST', json: {}, token: t });
  return { status: res.status, body: (await res.json()) as any };
}
async function previewOk(body: string) {
  const p = await preview(body);
  if (p.status !== 201) throw new Error(`preview -> ${p.status} ${JSON.stringify(p.body)}`);
  return p.body;
}
const row = (imp: any, line: number) => imp.plan.rows.find((r: any) => r.line === line);
const postsTo = (re: RegExp) => stripe.requests.filter((r) => r.method === 'POST' && re.test(r.path));
const count = async (q: PromiseLike<unknown>) => ((await q) as Array<{ n: number }>)[0]!.n;

/** A product created in Stripe by the Stripe script for this CSV row (same name/description/sku). */
function inStripe(r: Row, extra: { active?: boolean; metadata?: Row } = {}): string {
  return stripe.createProductDirect(r.name!, { description: r.description ?? '', active: extra.active, metadata: { sku: r['_meta:sku']!, ...(extra.metadata ?? {}) } });
}

// A product that does not exist yet: the CSV carries everything needed to create it.
const NEW_ACME: Row = { '_ls:product': 'acme', '_ls:product_name': 'Acme Shredder', '_ls:major': '1', '_ls:protocol': 'repass-v1' };
const ENT: Row = { '_ls:edition': 'enterprise', '_ls:edition_name': 'enterprise', '_ls:edition_activation_model': 'none', '_ls:edition_ownership': 'organisation', '_ls:edition_offline_policy': 'indefinite' };
const BIZ: Row = { '_ls:edition': 'business', '_ls:edition_name': 'business', '_ls:edition_activation_model': 'device_seats', '_ls:edition_ownership': 'organisation', '_ls:edition_offline_policy': 'indefinite', '_ls:edition_transfer_allowance': '3' };
const EDU: Row = { '_ls:edition': 'education', '_ls:edition_name': 'education', '_ls:edition_activation_model': 'none', '_ls:edition_ownership': 'institution', '_ls:edition_offline_policy': 'indefinite' };

const book: Row = { name: 'AI for Normal People — PDF', '_meta:sku': 'ai-normal-people-1-pdf', '_price:create': 'no' };
const acmeEnt: Row = { name: 'Acme Shredder 1 Enterprise', description: 'Perpetual, organisation-wide', '_meta:sku': 'acme1-ent', '_ls:import': 'yes', ...NEW_ACME, ...ENT,
  '_ls:billing': 'one_time', ...prices(49900, { '_ls:tax_percent:aud': '10', '_ls:tax_label:aud': 'GST', '_ls:price:jpy': '49800' }) };
const acmeBiz: Row = { name: 'Acme Shredder 1 Business (annual)', description: 'Per seat, billed yearly', '_meta:sku': 'acme1-biz-annual', '_ls:import': 'yes', ...NEW_ACME, ...BIZ,
  '_ls:billing': 'recurring', '_ls:interval': 'year', '_ls:seats_per_unit': '1', '_ls:quantity_scales_seats': 'yes', '_ls:max_quantity': '100', '_ls:trial_days': '14', '_ls:grace_days': '7', ...prices(4900) };

beforeAll(async () => {
  let url: string;
  ({ sql, drop, url } = await freshDatabase());
  const base = testEnv();
  stripe = await new FakeStripe(base.STRIPE_WEBHOOK_SECRET as string).start();
  env = httpEnv(url, { ...base, STRIPE_API_BASE: stripe.url });
  config = loadConfig(env);
  admin = new Client(env);
  ({ token, tokenId } = await bootstrapAdminToken(sql, config, ['products:read', 'products:write', 'prices:read', 'prices:write']));
  book.product_id = stripe.createProductDirect(book.name!);
  acmeEnt.product_id = inStripe(acmeEnt);
  acmeBiz.product_id = inStripe(acmeBiz);
});

afterAll(async () => {
  await stripe?.stop();
  await drop?.();
});

describe('CSV validation and authorisation', () => {
  it('rejects files it cannot read, without recording an import', async () => {
    const noLs = await preview('product_id,name\nprod_x,Thing\n');
    expect(noLs.status).toBe(422);
    expect(noLs.body.error.message).toMatch(/no _ls:import column/);
    const typo = await preview(csv([{ ...acmeEnt, '_ls:edtion': 'x' }]));
    expect(typo.body.error.message).toMatch(/Unknown license-server column\(s\): _ls:edtion/);
    expect((await preview('name,_ls:import\n"unterminated,yes\n')).body.error.message).toMatch(/Unterminated quoted field/);
    expect((await preview(csv([acmeEnt]).replace(/\n$/, ',extra\n'))).body.error.message).toMatch(/fields; the header has/);
    expect(await count(sql`SELECT count(*)::int AS n FROM catalogue_imports`)).toBe(0);
  });

  it('needs products:write and prices:write to upload or apply; products:read to look', async () => {
    const { token: reader } = await bootstrapAdminToken(sql, config, ['products:read']);
    const { token: noPrices } = await bootstrapAdminToken(sql, config, ['products:read', 'products:write']);
    expect((await preview(csv([acmeEnt]), reader)).status).toBe(403);
    expect((await preview(csv([acmeEnt]), noPrices)).status).toBe(403);
    const list = await admin.request('/api/admin/v1/catalogue/imports', { token: reader });
    expect(list.status).toBe(200);
  });
});

describe('Stripe-first: products created in Stripe, then imported', () => {
  let importId = '';

  it('previews an empty catalogue: what would be created, linked and skipped, writing nothing', async () => {
    const before = stripe.requests.length;
    const imp = await previewOk(csv([book, acmeEnt, acmeBiz]));
    importId = imp.id;
    expect(imp).toMatchObject({ status: 'previewed', stripeMode: 'test', fileName: 'products.csv' });
    expect(imp.summary).toMatchObject({ rows: 3, selected: 2, skipped: 1, create: 2, errors: 0, entitiesToCreate: 4, entityErrors: 0 });
    expect(imp.plan.entities.map((e: any) => [e.label, e.action])).toEqual([
      ['Product acme', 'create'], ['acme v1', 'create'], ['acme v1 enterprise edition', 'create'], ['acme v1 business edition', 'create'],
    ]);
    expect(row(imp, 2)).toMatchObject({ action: 'skipped', sku: 'ai-normal-people-1-pdf' });
    const ent = row(imp, 3);
    expect(ent).toMatchObject({ action: 'create', sku: 'acme1-ent', stripeProductId: acmeEnt.product_id, errors: [] });
    expect(ent.changes[0]).toMatch(/^create offer acme1-ent \(acme v1 enterprise; one_time; perpetual/);
    expect(ent.changes[1]).toMatch(/^set prices AUD 49900 \+ 10% GST, USD 49900, .*JPY 49800/);
    expect(ent.changes[2]).toBe(`link Stripe product ${acmeEnt.product_id}`);
    expect(row(imp, 4).changes[0]).toMatch(/recurring every 1 year; subscription, 1 seat\(s\) per unit × quantity, 14-day trial, 7-day grace/);
    // Nothing changed: no catalogue rows, and Stripe was only read.
    expect(await count(sql`SELECT count(*)::int AS n FROM products`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM offers`)).toBe(0);
    expect(stripe.requests.slice(before).every((r) => r.method === 'GET')).toBe(true);
    const [a] = await sql<{ actor_type: string; actor_id: string; resource_id: string }[]>`SELECT actor_type, actor_id, resource_id FROM audit_events WHERE action = 'catalogue.import_previewed'`;
    expect(a).toEqual({ actor_type: 'api_token', actor_id: tokenId, resource_id: importId });
  });

  it('applies exactly the preview through the audited services, linking the existing Stripe products', async () => {
    const r = await apply(importId);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'applied', result: { counts: { applied: 2, unchanged: 0, skipped: 1, errors: 0, partial: 0, entitiesCreated: 4 } } });
    const [p] = await sql<{ id: string; name: string; status: string }[]>`SELECT id, name, status FROM products WHERE slug = 'acme'`;
    expect(p).toMatchObject({ name: 'Acme Shredder', status: 'draft' });
    const [m] = await sql<{ protocol_id: string; status: string }[]>`SELECT protocol_id, status FROM product_majors WHERE product_id = ${p!.id} AND major_version = 1`;
    expect(m).toEqual({ protocol_id: 'repass-v1', status: 'draft' });
    const eps = await sql<{ edition_id: string; activation_model: string; transfer_allowance: number | null }[]>`
      SELECT edition_id, activation_model, transfer_allowance FROM product_edition_policies ORDER BY edition_id`;
    expect(eps).toEqual([{ edition_id: 'business', activation_model: 'device_seats', transfer_allowance: 3 }, { edition_id: 'enterprise', activation_model: 'none', transfer_allowance: null }]);
    const offers = await sql<{ sku: string; status: string; stripe_product_id: string; sync_state: string }[]>`
      SELECT o.sku, o.status, pm.stripe_product_id, pm.sync_state FROM offers o JOIN stripe_product_mappings pm ON pm.offer_id = o.id ORDER BY o.sku`;
    expect(offers).toEqual([
      { sku: 'acme1-biz-annual', status: 'draft', stripe_product_id: acmeBiz.product_id, sync_state: 'synced' },
      { sku: 'acme1-ent', status: 'draft', stripe_product_id: acmeEnt.product_id, sync_state: 'synced' },
    ]);
    expect(await count(sql`SELECT count(*)::int AS n FROM price_versions WHERE status = 'active'`)).toBe(22);
    const [aud] = await sql<{ tax_rate_bps: number; tax_label: string }[]>`
      SELECT pv.tax_rate_bps, pv.tax_label FROM price_versions pv JOIN offers o ON o.id = pv.offer_id WHERE o.sku = 'acme1-ent' AND pv.currency = 'aud'`;
    expect(aud).toEqual({ tax_rate_bps: 1000, tax_label: 'GST' });
    // The existing Stripe products were linked and tagged, never created or renamed.
    expect(postsTo(/^\/v1\/products$/).length).toBe(0);
    expect(stripe.products.get(acmeEnt.product_id!)).toMatchObject({ name: acmeEnt.name, metadata: { sku: 'acme1-ent', repass_sku: 'acme1-ent' } });
    // Every change is attributed to the administrator's token.
    const actions = await sql<{ action: string; actor_id: string }[]>`SELECT action, actor_id FROM audit_events
      WHERE action IN ('product.created', 'product_major.created', 'edition_policy.created', 'offer.created', 'price.activated', 'stripe.product_linked', 'catalogue.import_applied')`;
    expect(new Set(actions.map((x) => x.actor_id))).toEqual(new Set([tokenId]));
    expect(actions.filter((x) => x.action === 'stripe.product_linked').length).toBe(2);
    expect(actions.filter((x) => x.action === 'catalogue.import_applied').length).toBe(1);
  });

  it('re-importing the same CSV changes nothing and creates no duplicates', async () => {
    const imp = await previewOk(csv([book, acmeEnt, acmeBiz]));
    expect(imp.summary).toMatchObject({ selected: 2, create: 0, link: 0, update: 0, unchanged: 2, errors: 0, entitiesToCreate: 0 });
    const r = await apply(imp.id);
    expect(r.body.result.counts).toMatchObject({ applied: 0, unchanged: 2, errors: 0 });
    expect(await count(sql`SELECT count(*)::int AS n FROM offers`)).toBe(2);
    expect(await count(sql`SELECT count(*)::int AS n FROM products`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM price_versions`)).toBe(22);
    // Applying the same import twice is refused.
    expect((await apply(imp.id)).body.error.message).toMatch(/already been applied/);
  });

  it('updates the right records: a renamed product keeps its identity and Stripe link; changed prices get new versions', async () => {
    stripe.products.get(acmeEnt.product_id!)!.name = 'Acme Shredder 1 Enterprise Edition';
    acmeEnt.name = 'Acme Shredder 1 Enterprise Edition';
    acmeBiz['_ls:price:aud'] = '5900';
    const imp = await previewOk(csv([book, acmeEnt, acmeBiz]));
    expect(row(imp, 3)).toMatchObject({ action: 'update', changes: ['update name "Acme Shredder 1 Enterprise" → "Acme Shredder 1 Enterprise Edition"'] });
    expect(row(imp, 4)).toMatchObject({ action: 'update', changes: ['set prices AUD 5900'] });
    expect((await apply(imp.id)).body.result.counts).toMatchObject({ applied: 2 });
    const [o] = await sql<{ name: string; stripe_product_id: string }[]>`SELECT o.name, pm.stripe_product_id FROM offers o JOIN stripe_product_mappings pm ON pm.offer_id = o.id WHERE o.sku = 'acme1-ent'`;
    expect(o).toEqual({ name: 'Acme Shredder 1 Enterprise Edition', stripe_product_id: acmeEnt.product_id });
    const aud = await sql<{ unit_amount: number; status: string }[]>`
      SELECT pv.unit_amount, pv.status FROM price_versions pv JOIN offers o ON o.id = pv.offer_id WHERE o.sku = 'acme1-biz-annual' AND pv.currency = 'aud' ORDER BY pv.created_at`;
    expect(aud).toEqual([{ unit_amount: 4900, status: 'archived' }, { unit_amount: 5900, status: 'active' }]);
    expect(await count(sql`SELECT count(*)::int AS n FROM offers`)).toBe(2);
  });

  it('activates on request, then never changes the price of an offer on sale silently (draft prices)', async () => {
    const [p] = await sql<{ id: string }[]>`SELECT id FROM products WHERE slug = 'acme'`;
    acmeEnt['_ls:activate'] = 'yes';
    const early = await previewOk(csv([acmeEnt]));
    expect(row(early, 2).errors[0]).toMatch(/_ls:activate = yes needs acme v1 to be active \(product draft, major draft\)/);
    await catalogue.updateProduct(sql, superActor(), p!.id, { status: 'active' });
    const [m] = await sql<{ id: string }[]>`SELECT id FROM product_majors WHERE product_id = ${p!.id}`;
    await catalogue.updateMajor(sql, superActor(), m!.id, { status: 'active' });
    const imp = await previewOk(csv([acmeEnt]));
    expect(row(imp, 2)).toMatchObject({ action: 'update', changes: ['activate offer'] });
    await apply(imp.id);
    expect((await sql`SELECT status FROM offers WHERE sku = 'acme1-ent'`)[0]!.status).toBe('active');

    acmeEnt['_ls:price:usd'] = '52900';
    const change = await previewOk(csv([acmeEnt]));
    expect(row(change, 2).changes).toEqual(['add draft prices USD 52900 (the offer is on sale: activate them in the admin portal)']);
    await apply(change.id);
    const usd = await sql<{ unit_amount: number; status: string }[]>`
      SELECT pv.unit_amount, pv.status FROM price_versions pv JOIN offers o ON o.id = pv.offer_id WHERE o.sku = 'acme1-ent' AND pv.currency = 'usd' ORDER BY pv.created_at`;
    expect(usd).toEqual([{ unit_amount: 49900, status: 'active' }, { unit_amount: 52900, status: 'draft' }]);
    const again = await previewOk(csv([acmeEnt]));
    expect(row(again, 2)).toMatchObject({ action: 'unchanged', changes: [] });
    expect(row(again, 2).warnings).toContain('USD 52900 is already waiting as a draft price: activate it in the admin portal');
  });
});

describe('conflicts and duplicates are reported, never resolved', () => {
  it('rejects rows whose CSV, licence-server and Stripe data disagree, and applies only the rest', async () => {
    const base = (sku: string, name: string, extra: Row = {}): Row => ({ name, '_meta:sku': sku, '_ls:import': 'yes', '_ls:product': 'acme', '_ls:major': '1', ...ENT,
      '_ls:billing': 'one_time', ...prices(1000), ...extra });
    const good = { name: 'Acme Shredder 1 Education', '_meta:sku': 'acme1-edu', '_ls:import': 'yes', '_ls:product': 'acme', '_ls:major': '1', ...EDU,
      '_ls:billing': 'free', '_ls:customer_kind': 'organisation', ...prices(0) };
    const nameRow = base('c-name', 'Conflict name row');
    nameRow.product_id = stripe.createProductDirect('Some other name', { metadata: { sku: 'c-name' } });
    const archived = base('c-archived', 'Archived row');
    archived.product_id = inStripe(archived, { active: false });
    const missing = base('c-missing', 'Missing row', { product_id: 'prod_doesnotexist1' });
    const malformed = base('c-malformed', 'Malformed row', { product_id: 'price_123' });
    const otherSku = base('c-meta', 'Meta row');
    otherSku.product_id = stripe.createProductDirect('Meta row', { metadata: { sku: 'something-else' } });
    const steal = base('c-steal', 'Steal row', { product_id: acmeBiz.product_id! });
    const relink: Row = { ...acmeEnt, name: 'Relink row' };
    relink.product_id = inStripe(relink);
    const inactive = base('c-inactive', 'Inactive row', { active: 'no' });
    inactive.product_id = inStripe(inactive);
    const dupA = base('c-dup', 'Dup A');
    const dupB = base('c-dup', 'Dup B');
    const shared = stripe.createProductDirect('Shared', { metadata: {} });
    const sameProdA = base('c-shared-a', 'Shared', { product_id: shared });
    const sameProdB = base('c-shared-b', 'Shared B', { product_id: shared, name: 'Shared' });
    const nameA = base('c-samename-a', 'Same Name');
    const nameB = base('c-samename-b', 'same name');
    const clash = base('c-clash', 'acme shredder 1 enterprise EDITION');
    const immutable = { ...acmeBiz, product_id: '', '_ls:max_quantity': '50' };
    const noBilling = base('c-nobilling', 'No billing', { '_ls:billing': '', '_ls:tax_percent:aud': '10' });

    const rows = [good, nameRow, archived, missing, malformed, otherSku, steal, relink, inactive, dupA, dupB, sameProdA, sameProdB, nameA, nameB, clash, immutable, noBilling];
    const imp = await previewOk(csv(rows));
    const errs = (i: number) => row(imp, i + 2).errors.join(' | ');
    expect(row(imp, 2)).toMatchObject({ action: 'create', errors: [] });
    expect(errs(1)).toMatch(/Stripe product name "Some other name" differs from the CSV name "Conflict name row"/);
    expect(errs(2)).toMatch(/is archived in Stripe/);
    expect(errs(3)).toMatch(/Stripe product prod_doesnotexist1 does not exist in this Stripe account \(test mode\)/);
    expect(errs(4)).toMatch(/product_id must be a Stripe product id \(prod_…\), got "price_123"/);
    expect(errs(5)).toMatch(/has metadata sku "something-else", the CSV _meta:sku is "c-meta"/);
    expect(errs(6)).toMatch(new RegExp(`Stripe product ${acmeBiz.product_id} is linked to offer acme1-biz-annual in the licence server, but this CSV row is SKU c-steal`));
    expect(errs(6)).toMatch(/is tagged for licence-server SKU "acme1-biz-annual"/);
    expect(errs(7)).toMatch(new RegExp(`Offer acme1-ent is linked to Stripe product ${acmeEnt.product_id} in the licence server, but the CSV says ${relink.product_id}`));
    expect(errs(8)).toMatch(/CSV active = no, but Stripe product .* is active/);
    expect(errs(9)).toMatch(/SKU c-dup appears on lines 11, 12/);
    expect(errs(10)).toMatch(/SKU c-dup appears on lines 11, 12/);
    expect(errs(11)).toMatch(new RegExp(`Stripe product ${shared} appears on lines 13, 14`));
    expect(errs(12)).toMatch(new RegExp(`Stripe product ${shared} appears on lines 13, 14`));
    expect(errs(13)).toMatch(/Offer name same name appears on lines 15, 16/);
    expect(errs(14)).toMatch(/Offer name same name appears on lines 15, 16/);
    expect(errs(15)).toMatch(/Offer name "acme shredder 1 enterprise EDITION" is already used by offer acme1-ent/);
    expect(errs(16)).toMatch(/Offer acme1-biz-annual exists and what it grants or how it bills cannot change \(max quantity: licence server 100, CSV 50\)/);
    expect(errs(17)).toMatch(/_ls:billing is required/);
    expect(errs(17)).toMatch(/_ls:tax_percent:aud and _ls:tax_label:aud go together/);
    expect(imp.summary).toMatchObject({ selected: 18, create: 1, errors: 17 });

    const offersBefore = await count(sql`SELECT count(*)::int AS n FROM offers`);
    const stripeWritesBefore = stripe.requests.filter((r) => r.method === 'POST').length;
    const r = await apply(imp.id);
    expect(r.body.result.counts).toMatchObject({ applied: 1, errors: 17 });
    expect(await count(sql`SELECT count(*)::int AS n FROM offers`)).toBe(offersBefore + 1);
    // Nothing was written to Stripe for the rejected rows, and the existing links are untouched.
    expect(stripe.requests.filter((x) => x.method === 'POST').length).toBe(stripeWritesBefore);
    expect(stripe.products.get(nameRow.product_id!)!.name).toBe('Some other name');
    expect((await sql`SELECT pm.stripe_product_id FROM offers o JOIN stripe_product_mappings pm ON pm.offer_id = o.id WHERE o.sku = 'acme1-ent'`)[0]!.stripe_product_id).toBe(acmeEnt.product_id);
  });

  it('rejects missing or inconsistent licensing metadata instead of inventing it', async () => {
    const row0 = (sku: string, extra: Row): Row => ({ name: `Meta ${sku}`, '_meta:sku': sku, '_ls:import': 'yes', '_ls:billing': 'one_time', ...prices(1000), ...extra });
    const rows = [
      row0('m-noname', { '_ls:product': 'beta', '_ls:major': '1', '_ls:protocol': 'repass-v1', ...ENT }),
      row0('m-noprotocol', { '_ls:product': 'acme', '_ls:major': '2', ...ENT }),
      row0('m-noedition-cols', { '_ls:product': 'acme', '_ls:major': '1', '_ls:edition': 'community' }),
      row0('m-unknown-edition', { '_ls:product': 'acme', '_ls:major': '1', '_ls:edition': 'platinum' }),
      row0('m-incompatible', { '_ls:product': 'gamma', '_ls:product_name': 'Gamma', '_ls:major': '1', '_ls:protocol': 'repass-v1', ...EDU, '_ls:edition_activation_model': 'device_seats' }),
      row0('m-disagree-a', { '_ls:product': 'delta', '_ls:product_name': 'Delta', '_ls:major': '1', '_ls:protocol': 'repass-v1', ...ENT }),
      row0('m-disagree-b', { '_ls:product': 'delta', '_ls:product_name': 'Delta Two', '_ls:major': '1', '_ls:protocol': 'repass-v1', ...ENT }),
      row0('m-badprotocol', { '_ls:product': 'eps', '_ls:product_name': 'Eps', '_ls:major': '1', '_ls:protocol': 'repass-v9', ...ENT }),
      row0('m-edition-differs', { '_ls:product': 'acme', '_ls:major': '1', ...BIZ, '_ls:edition_ownership': 'individual', '_ls:billing': 'one_time' }),
    ];
    const imp = await previewOk(csv(rows));
    const entity = (label: string) => imp.plan.entities.find((e: any) => e.label === label);
    expect(entity('Product beta').errors[0]).toMatch(/Product beta does not exist: add _ls:product_name to create it/);
    expect(entity('acme v2').errors[0]).toMatch(/acme v2 does not exist: add _ls:protocol \(repass-v1\) to create it/);
    expect(entity('acme v1 community edition').errors[0]).toMatch(/_ls:edition_name, _ls:edition_activation_model, _ls:edition_ownership, _ls:edition_offline_policy are required to create it/);
    expect(entity('acme v1 platinum edition').errors[0]).toMatch(/Unknown edition "platinum"/);
    expect(entity('gamma v1 education edition').errors.length).toBeGreaterThan(0);
    expect(entity('Product delta').errors[0]).toMatch(/Rows disagree on _ls:product_name: "Delta" \(line 7\) vs "Delta Two" \(line 8\)/);
    expect(entity('eps v1').errors[0]).toMatch(/_ls:protocol "repass-v9" is not implemented/);
    expect(entity('acme v1 business edition').errors[0]).toMatch(/_ls:edition_ownership "individual" differs from the licence server's "organisation"/);
    for (const r of imp.plan.rows) {
      expect(r.action).toBe('error');
      expect(r.errors.join(' ')).toMatch(/Not imported until .* fixed/);
    }
    // The product name in the licence server is not overwritten by the CSV either.
    const renamed = await previewOk(csv([{ ...acmeEnt, '_ls:product_name': 'Acme Different' }]));
    expect(renamed.plan.entities[0].errors[0]).toMatch(/_ls:product_name "Acme Different" differs from the licence server's product name "Acme Shredder"/);
  });
});

describe('PostgreSQL-first: products not in Stripe yet, created at first checkout', () => {
  const pg = (sku: string, name: string, extra: Row = {}): Row => ({ name, description: `${name} (database first)`, '_meta:sku': sku, '_ls:import': 'yes',
    '_ls:product': 'cursedelete', '_ls:major': '2', '_ls:edition': 'enterprise', '_ls:billing': 'one_time', '_ls:activate': 'yes', ...prices(20000), ...extra });
  const BUSINESS = { name: 'Jane Citizen', businessName: 'Buyer Org', country: 'AU' };

  async function checkout(sku: string, email: string, key = `ck_${Math.random().toString(36).slice(2)}aaaaaaaa`) {
    const shopper = new Client(env);
    const csrf = await shopper.csrfFrom('/store');
    const res = await shopper.request('/checkout', { method: 'POST', form: { _csrf: csrf, sku, currency: 'aud', quantity: '1', email, idempotencyKey: key, unitAmount: '1', ...BUSINESS } });
    return { status: res.status, location: res.headers.get('location') ?? '', text: res.status >= 400 ? await res.text() : '' };
  }
  const offerIdOf = async (sku: string) => (await sql<{ id: string }[]>`SELECT id FROM offers WHERE sku = ${sku}`)[0]!.id;
  const mappingOf = async (sku: string) => (await sql<{ stripe_product_id: string | null; last_error: string | null }[]>`
    SELECT pm.stripe_product_id, pm.last_error FROM offers o JOIN stripe_product_mappings pm ON pm.offer_id = o.id WHERE o.sku = ${sku}`)[0]!;
  const productOfSession = (loc: string) => stripe.sessions.get(loc.split('/').pop()!)!._line_items[0].price.product as string;

  beforeAll(async () => {
    await seedProduct(sql, config, superActor(), 'cursedelete', 2);
  });

  it('imports an offer with no Stripe product id without touching Stripe', async () => {
    const writes = stripe.requests.filter((r) => r.method === 'POST').length;
    const imp = await previewOk(csv([pg('pgf-ent', 'CurseDelete 2 Enterprise (database first)')]));
    expect(row(imp, 2)).toMatchObject({ action: 'create', stripeProductId: null });
    expect(row(imp, 2).changes).toEqual([expect.stringMatching(/^create offer pgf-ent/), expect.stringMatching(/^set prices/), 'activate offer']);
    expect(row(imp, 2).warnings).toContain('not in Stripe yet: the Stripe product is created and linked automatically at the first checkout (or run the Stripe script first and re-import)');
    await apply(imp.id);
    expect(await mappingOf('pgf-ent')).toEqual({ stripe_product_id: null, last_error: null });
    expect((await sql`SELECT status FROM offers WHERE sku = 'pgf-ent'`)[0]!.status).toBe('active');
    expect(stripe.requests.filter((r) => r.method === 'POST').length).toBe(writes);
  });

  it('refuses a row without product_id when Stripe already has a product for that SKU', async () => {
    const r = pg('pgf-known', 'Known in Stripe');
    const existing = stripe.createProductDirect('Known in Stripe', { metadata: { sku: 'pgf-known' } });
    const imp = await previewOk(csv([r]));
    expect(row(imp, 2).errors[0]).toMatch(new RegExp(`No product_id in the CSV, but Stripe \\(test mode\\) already has ${existing} "Known in Stripe" for SKU pgf-known`));
  });

  it('concurrent first checkouts create exactly one Stripe product and all use it', async () => {
    const before = postsTo(/^\/v1\/products$/).length;
    stripe.delayMs = 40;
    const results = await Promise.all([1, 2, 3, 4].map((i) => checkout('pgf-ent', `race${i}@buyer.example`)));
    stripe.delayMs = 0;
    for (const r of results) expect(r.status, r.text).toBe(303);
    const created = postsTo(/^\/v1\/products$/).slice(before);
    expect(created.length).toBe(1);
    const offerId = await offerIdOf('pgf-ent');
    expect(created[0]).toMatchObject({ idempotencyKey: `repass-product-${offerId}`, params: { name: 'CurseDelete 2 Enterprise (database first)', metadata: { repass_offer_id: offerId, repass_sku: 'pgf-ent', sku: 'pgf-ent' } } });
    const { stripe_product_id: pid } = await mappingOf('pgf-ent');
    expect(pid).toBe([...stripe.products.values()].find((p) => (p.metadata as Row).repass_offer_id === offerId)!.id);
    for (const r of results) expect(productOfSession(r.location)).toBe(pid);
    expect(await count(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'stripe.product_created' AND resource_id = ${offerId}`)).toBe(1);
    // Later purchases reuse it.
    const later = await checkout('pgf-ent', 'later@buyer.example');
    expect(productOfSession(later.location)).toBe(pid);
    expect(postsTo(/^\/v1\/products$/).length).toBe(before + 1);
  });

  it('a re-import then reports the server-created link so the CSV can record it', async () => {
    const { stripe_product_id: pid } = await mappingOf('pgf-ent');
    const imp = await previewOk(csv([pg('pgf-ent', 'CurseDelete 2 Enterprise (database first)')]));
    expect(row(imp, 2)).toMatchObject({ action: 'unchanged', stripeProductId: pid });
    expect(row(imp, 2).warnings[0]).toBe(`linked to Stripe product ${pid} in the licence server: copy it into product_id so the Stripe script updates that product instead of creating a duplicate`);
    // With the id copied in (as the Stripe script expects), the row verifies cleanly.
    const withId = await previewOk(csv([pg('pgf-ent', 'CurseDelete 2 Enterprise (database first)', { product_id: pid! })]));
    expect(row(withId, 2)).toMatchObject({ action: 'unchanged', errors: [] });
  });

  it('a failed Stripe call fails the checkout truthfully; the retry creates the product once', async () => {
    await apply((await previewOk(csv([pg('pgf-retry', 'Retry offer')]))).id);
    stripe.failNext(/^POST \/v1\/products$/, 500, 1);
    const k = 'ck_retry_aaaaaaaaaaaaaaaa';
    const first = await checkout('pgf-retry', 'retry@buyer.example', k);
    expect(first.status).toBe(503);
    expect(await mappingOf('pgf-retry')).toMatchObject({ stripe_product_id: null, last_error: expect.stringMatching(/Stripe 500/) });
    const second = await checkout('pgf-retry', 'retry@buyer.example', k);
    expect(second.status).toBe(303);
    const offerId = await offerIdOf('pgf-retry');
    expect([...stripe.products.values()].filter((p) => (p.metadata as Row).repass_offer_id === offerId).length).toBe(1);
    expect(await mappingOf('pgf-retry')).toMatchObject({ stripe_product_id: productOfSession(second.location), last_error: null });
  });

  it('recovers a product whose link was lost instead of creating a second one; two candidates is a conflict', async () => {
    await apply((await previewOk(csv([pg('pgf-lost', 'Lost link offer'), pg('pgf-twice', 'Twice tagged offer')]))).id);
    const lostId = await offerIdOf('pgf-lost');
    // Stripe created it earlier (tagged with the offer id) but the database write never happened.
    const orphan = stripe.createProductDirect('Lost link offer', { metadata: { repass_offer_id: lostId, repass_sku: 'pgf-lost' } });
    const before = postsTo(/^\/v1\/products$/).length;
    const c = await checkout('pgf-lost', 'lost@buyer.example');
    expect(c.status).toBe(303);
    expect(productOfSession(c.location)).toBe(orphan);
    expect(postsTo(/^\/v1\/products$/).length).toBe(before);
    expect(await count(sql`SELECT count(*)::int AS n FROM audit_events WHERE action = 'stripe.product_relinked' AND resource_id = ${lostId}`)).toBe(1);

    const twiceId = await offerIdOf('pgf-twice');
    for (const n of [1, 2]) stripe.createProductDirect(`Twice ${n}`, { metadata: { repass_offer_id: twiceId } });
    const t = await checkout('pgf-twice', 'twice@buyer.example');
    expect(t.status).toBe(412);
    expect(t.text).toMatch(/Stripe has 2 products tagged for offer pgf-twice/);
    expect((await mappingOf('pgf-twice')).stripe_product_id).toBeNull();
  });
});

describe('apply safety', () => {
  it('refuses to apply a preview that no longer matches the catalogue or Stripe, showing the new preview', async () => {
    const r = { ...acmeBiz, '_ls:price:aud': '5900' };
    const imp = await previewOk(csv([r, { ...acmeEnt, '_ls:import': 'no' }]));
    expect(row(imp, 2).action).toBe('unchanged');
    stripe.products.get(acmeBiz.product_id!)!.name = 'Renamed in Stripe meanwhile';
    const res = await apply(imp.id);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/changed since this preview\. Nothing was applied/);
    const now = await (await admin.request(`/api/admin/v1/catalogue/imports/${imp.id}`, { token })).json() as any;
    expect(now.status).toBe('previewed');
    expect(row(now, 2).errors[0]).toMatch(/Stripe product name "Renamed in Stripe meanwhile" differs from the CSV name/);
    stripe.products.get(acmeBiz.product_id!)!.name = acmeBiz.name!;
  });

  it('applies one import at a time', async () => {
    const a = await previewOk(csv([acmeBiz]));
    const b = await previewOk(csv([acmeBiz]));
    await sql`UPDATE catalogue_imports SET status = 'applying', apply_started_at = now() WHERE id = ${a.id}`;
    expect((await apply(b.id)).body.error.message).toMatch(/Another catalogue import is being applied/);
    // A claim abandoned for over 10 minutes (e.g. the worker died) can be taken over.
    await sql`UPDATE catalogue_imports SET apply_started_at = now() - interval '11 minutes' WHERE id = ${a.id}`;
    expect((await apply(a.id)).status).toBe(200);
    expect((await apply(b.id)).status).toBe(200);
  });

  it('a step failing mid-row leaves a recoverable state: the next upload shows and applies only what is left', async () => {
    const r: Row = { name: 'Acme Shredder 1 Business (monthly)', description: 'Per seat, monthly', '_meta:sku': 'acme1-biz-monthly', '_ls:import': 'yes', '_ls:product': 'acme', '_ls:major': '1',
      '_ls:edition': 'business', '_ls:billing': 'recurring', '_ls:interval': 'month', '_ls:seats_per_unit': '1', '_ls:quantity_scales_seats': 'yes', '_ls:max_quantity': '100', ...prices(590) };
    r.product_id = inStripe(r);
    const imp = await previewOk(csv([r]));
    expect(row(imp, 2).changes.length).toBe(3);
    stripe.failNext(new RegExp(`^POST /v1/products/${r.product_id}$`), 500, 1);
    const res = await apply(imp.id);
    expect(res.body.result.rows[0]).toMatchObject({ outcome: 'partial', done: [expect.stringMatching(/^create offer/), expect.stringMatching(/^set prices/)] });
    expect(res.body.result.rows[0].error).toMatch(/Stripe 500.*upload the CSV again/);
    const rest = await previewOk(csv([r]));
    expect(row(rest, 2)).toMatchObject({ action: 'link', changes: [`link Stripe product ${r.product_id}`] });
    expect((await apply(rest.id)).body.result.counts).toMatchObject({ applied: 1 });
    expect(await count(sql`SELECT count(*)::int AS n FROM offers WHERE sku = 'acme1-biz-monthly'`)).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM price_versions pv JOIN offers o ON o.id = pv.offer_id WHERE o.sku = 'acme1-biz-monthly'`)).toBe(11);
  });

  it('a Stripe outage fails the preview without recording it', async () => {
    const n = await count(sql`SELECT count(*)::int AS n FROM catalogue_imports`);
    stripe.failNext(/^GET \/v1\/products\//, 503, 1);
    const p = await preview(csv([acmeBiz]));
    expect(p.status).toBe(503);
    expect(await count(sql`SELECT count(*)::int AS n FROM catalogue_imports`)).toBe(n);
  });
});

describe('edition names', () => {
  it('accepts only the lower-case catalogue names, including corporate for an edition', async () => {
    const r = (sku: string, name: string): Row => ({ name: `Names ${sku}`, '_meta:sku': sku, '_ls:import': 'yes', '_ls:product': 'zeta', '_ls:product_name': 'Zeta',
      '_ls:major': '1', '_ls:protocol': 'repass-v1', ...ENT, '_ls:edition_name': name, '_ls:billing': 'one_time', ...prices(1000) });
    const imp = await previewOk(csv([r('n-upper', 'Enterprise')]));
    expect(row(imp, 2).errors[0]).toBe('_ls:edition_name must be one of community, education, business, enterprise, corporate (lower case), got "Enterprise"');
    const ok = await previewOk(csv([r('n-corporate', 'corporate')]));
    expect(row(ok, 2)).toMatchObject({ action: 'create', errors: [] });
    expect(ok.plan.entities.find((e: any) => e.kind === 'edition_policy').changes[0]).toMatch(/^create edition policy zeta v1 enterprise edition: "corporate"/);
  });
});
