/** @jsxImportSource hono/jsx */
import { Hono } from 'hono';
import { listPublicCatalogue, STORE_CURRENCIES } from '../services/catalogue.ts';
import { Catalogue, ProductDetail, ProductToolbar, selectStoreOffer, storeEntries } from '../views/storefront.tsx';
import { Layout } from '../views/layout.tsx';
import { loadSession } from './session.ts';
import type { AppEnv, Ctx } from './context.ts';

const COUNTRY_CURRENCY: Record<string, string> = {
  AU: 'aud', US: 'usd', GB: 'gbp', CA: 'cad', NZ: 'nzd', SG: 'sgd', HK: 'hkd', JP: 'jpy', CN: 'cny', CH: 'chf', LI: 'chf',
  AT: 'eur', BE: 'eur', CY: 'eur', DE: 'eur', EE: 'eur', ES: 'eur', FI: 'eur', FR: 'eur', GR: 'eur', HR: 'eur', IE: 'eur', IT: 'eur',
  LT: 'eur', LU: 'eur', LV: 'eur', MT: 'eur', NL: 'eur', PT: 'eur', SI: 'eur', SK: 'eur',
};
const geoCountry = (c: Ctx) => String((c.req.raw as { cf?: { country?: string } }).cf?.country ?? '');
const currencyFor = (c: Ctx) => {
  const asked = (c.req.query('currency') ?? '').toLowerCase();
  return STORE_CURRENCIES.includes(asked as typeof STORE_CURRENCIES[number]) ? asked : COUNTRY_CURRENCY[geoCountry(c)] ?? 'aud';
};
const canonical = (c: Ctx, path: string) => new URL(path, c.get('deps').config.publicBaseUrl).href;
export const storefront = new Hono<AppEnv>();
storefront.get('/store', async c => {
  const entries = storeEntries(await listPublicCatalogue(c.get('deps').sql, new Date()));
  return c.html(<Layout title="Products" realm="public" indexable description="Explore RePass Cloud software, compare licence editions and choose your plan." canonical={canonical(c, '/store')}>
    <Catalogue entries={entries} currency={currencyFor(c)} currencies={[...STORE_CURRENCIES]} />
  </Layout>);
});
const product = async (c: Ctx) => {
  const entries = storeEntries(await listPublicCatalogue(c.get('deps').sql, new Date()));
  const path = new URL(c.req.url).pathname;
  const entry = entries.find(e => e.href === path);
  if (!entry) return c.html(<Layout title="Product unavailable" realm="public"><h1>Product unavailable</h1><p>This product is not currently available. <a href="/store">Explore available products</a>.</p></Layout>, 404);
  const selected = selectStoreOffer(entry.offers, { sku: c.req.query('sku'), version: c.req.query('version'), edition: c.req.query('edition') });
  const session = await loadSession(c, 'customer');
  const email = session ? (await c.get('deps').sql<{ email: string }[]>`SELECT email FROM portal_users WHERE id = ${session.subjectId} AND status = 'active'`)[0]?.email ?? null : null;
  return c.html(<Layout title={entry.name} realm="public" controls={<ProductToolbar entry={entry} selected={selected} currency={currencyFor(c)} currencies={[...STORE_CURRENCIES]} />} indexable description={entry.description || selected.description} canonical={canonical(c, entry.href)} image={entry.imageUrl ? new URL(entry.imageUrl, c.get('deps').config.publicBaseUrl).href : undefined}>
    <ProductDetail entry={entry} selected={selected} currency={currencyFor(c)} currencies={[...STORE_CURRENCIES]} csrf={c.get('csrf')} email={email} country={geoCountry(c)} />
  </Layout>);
};
storefront.get('/store/products/:slug', product);
storefront.get('/store/bundles/:sku', product);
storefront.get('/sitemap.xml', async c => {
  const entries = storeEntries(await listPublicCatalogue(c.get('deps').sql, new Date()));
  const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const paths = ['/', '/store', ...entries.map(e => e.href)];
  return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(p => `<url><loc>${escape(canonical(c, p))}</loc></url>`).join('')}</urlset>`, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
});
