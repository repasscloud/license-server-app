import { afterAll, beforeAll, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db.ts';
import { seedProduct, superActor, testConfig } from '../helpers/fixtures.ts';
import { newId } from '../../src/lib/ids.ts';
import { Client, httpEnv } from '../helpers/http.ts';
import * as catalogue from '../../src/services/catalogue.ts';
import type { Sql } from '../../src/db/client.ts';

let sql: Sql, drop: () => Promise<void>, client: Client, productId: string, majorId: string, policyId: string, offerId: string;
const actor = superActor();
beforeAll(async () => {
  const db = await freshDatabase(); sql = db.sql; drop = db.drop;
  const { config, env } = testConfig(); client = new Client(httpEnv(db.url, env));
  const p = await seedProduct(sql, config, actor, 'curated');
  productId = p.productId; majorId = p.majorId; policyId = p.editions.community!;
  const offer = await catalogue.createOffer(sql, actor, { sku: 'curated-community', name: 'Community registration', kind: 'single', billing: 'free', components: [{ editionPolicyId: policyId, termType: 'perpetual' }] });
  offerId = String((offer as Record<string, unknown>).id);
  await catalogue.createPriceSet(sql, actor, offerId, { prices: catalogue.STORE_CURRENCIES.map(currency => ({ currency, unitAmount: 0 })) });
  await catalogue.setOfferStatus(sql, actor, offerId, 'active');
});
afterAll(async () => { await drop?.(); });

it('persists safe product artwork and rejects executable and protocol-relative URLs', async () => {
  const p = await catalogue.updateProduct(sql, actor, productId, { imageUrl: 'https://example.test/icon.png' });
  expect(p.image_url).toBe('https://example.test/icon.png');
  for (const imageUrl of ['javascript:alert(1)', '//example.test/icon.png', 'data:text/html,x']) {
    await expect(catalogue.updateProduct(sql, actor, productId, { imageUrl })).rejects.toThrow();
  }
  expect((await catalogue.updateProduct(sql, actor, productId, { imageUrl: '/assets/icon.png' })).image_url).toBe('/assets/icon.png');
});
it('renders a curated product link and server-rendered edition page with public metadata', async () => {
  const store = await (await client.request('/store')).text();
  expect(store).toContain('/store/products/curated');
  expect(store).not.toContain('name="businessName"');
  const detail = await (await client.request('/store/products/curated?sku=curated-community')).text();
  expect(detail).toContain('Community');
  expect(detail).toContain('name="sku"');
  expect(detail).toContain('name="robots" content="index,follow"');
  expect(detail).toMatch(/data-organisation-fields[^>]*hidden=""[^>]*disabled=""/);
  expect(detail).toContain('https://stripe.com');
  expect(await (await client.request('/portal/login')).text()).toContain('content="noindex,nofollow"');
});
it('configures organisation details consistently in the catalogue and product form', async () => {
  await catalogue.updateOffer(sql, actor, offerId, { organisationDetails: 'required' });
  const items = await catalogue.listPublicCatalogue(sql, new Date());
  expect(items[0]?.needsOrganisation).toBe(true);
  const detail = await (await client.request('/store/products/curated')).text();
  expect(detail).toContain('name="country"');
  expect(detail).toContain('Australia');
  expect(detail).not.toContain('Country (two-letter code');
  const missing = await client.request('/checkout', { method: 'POST', form: { sku: 'curated-community', currency: 'aud', quantity: '1', email: 'required@example.test', name: 'Buyer', idempotencyKey: newId('req') } });
  expect(missing.status).toBe(422);
  expect(await missing.text()).toContain('Business name and country are required');
  await catalogue.updateOffer(sql, actor, offerId, { organisationDetails: 'auto' });
});
it('excludes private products and unavailable majors/policies from catalogue and sitemap', async () => {
  for (const change of ['private', 'major', 'policy']) {
    if (change === 'private') await catalogue.updateProduct(sql, actor, productId, { visibility: 'private' });
    if (change === 'major') await catalogue.updateMajor(sql, actor, majorId, { status: 'sales_closed' });
    if (change === 'policy') await sql`UPDATE product_edition_policies SET status = 'retired' WHERE id = ${policyId}`;
    expect(await catalogue.listPublicCatalogue(sql, new Date())).toEqual([]);
    expect((await client.request('/store/products/curated')).status).toBe(404);
    expect(await (await client.request('/sitemap.xml')).text()).not.toContain('/store/products/curated');
    await catalogue.updateProduct(sql, actor, productId, { visibility: 'public' });
    await catalogue.updateMajor(sql, actor, majorId, { status: 'active' });
    await sql`UPDATE product_edition_policies SET status = 'active' WHERE id = ${policyId}`;
  }
});

it('does not let personal-only configuration bypass organisation licence ownership', async () => {
  const p = await catalogue.getMajor(sql, majorId);
  const business = p.editions.find(e => e.edition_id === 'business')!;
  await expect(catalogue.createOffer(sql, actor, { sku: 'invalid-personal', name: 'Invalid personal', kind: 'single', billing: 'one_time', organisationDetails: 'none', components: [{ editionPolicyId: business.id, termType: 'perpetual', seatsPerUnit: 1 }] })).rejects.toThrow('Organisation-owned editions require');
});
it('returns a crawlable sitemap and excludes private route groups in robots', async () => {
  const sitemap = await client.request('/sitemap.xml');
  expect(sitemap.headers.get('content-type')).toContain('application/xml');
  expect(await sitemap.text()).toContain('http://localhost:8787/store/products/curated');
  const robots = await (await client.request('/robots.txt')).text();
  expect(robots).toContain('Allow: /');
  expect(robots).toContain('Disallow: /portal');
  expect(robots).toContain('Sitemap: http://localhost:8787/sitemap.xml');
});

it('rejects organisation requirements on an individual-only offer', async () => {
  await expect(catalogue.createOffer(sql, actor, { sku: 'contradictory', name: 'Contradictory', kind: 'single', billing: 'free', customerKind: 'individual', organisationDetails: 'required', components: [{ editionPolicyId: policyId, termType: 'perpetual' }] })).rejects.toThrow('Individual-only offers cannot require');
});

it('separates numeric versions, editions and header licence/currency controls', async () => {
  const html = await (await client.request('/store/products/curated')).text();
  expect(html).toMatch(/<option value="2" selected="">2<\/option>/);
  expect(html).toContain('data-licence-picker');
  expect(html).toContain('data-edition-picker');
  const header = html.split('</header>')[0]!;
  expect(header).toContain('data-currency-picker');
  expect(header).toContain('data-licence-picker');
  expect(header).not.toContain('Community registration');
  expect(html).toMatch(/app\.js\?v=[a-f0-9]+/);
});
