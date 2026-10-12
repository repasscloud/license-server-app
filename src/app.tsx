/** @jsxImportSource hono/jsx */
// Composition root: one Worker, logically isolated route groups.
//   (/v1/* binding machine API is dispatched separately in router.ts)
//   /webhooks/*        Stripe + MailerSend (signature-verified)
//   /api/admin/v1/*    admin REST API (bearer tokens only)
//   /admin/*           admin portal (admin cookie realm + TOTP)
//   /portal/*          customer portal (customer cookie realm)
//   /store, /checkout  public storefront

import { Hono } from 'hono';
import { adminApi } from './http/admin-api.ts';
import { adminUi } from './http/admin-ui.tsx';
import { type AppEnv, baseMiddleware, bodyLimit, logError, securityHeaders } from './http/context.ts';
import { portalUi, storeUi } from './http/portal-ui.tsx';
import { webhooks } from './http/webhooks.ts';
import { APP_CSS, APP_JS } from './views/assets.ts';
import { BRAND_MARK, STRIPE_MARK } from './views/brand.ts';
import { Layout } from './views/layout.tsx';

export const app = new Hono<AppEnv>();

app.use('*', securityHeaders);
app.get('/healthz', (c) => c.json({ status: 'ok' }));
app.get('/assets/app.css', (c) => c.body(APP_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }));
app.get('/assets/app.js', (c) => c.body(APP_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' }));
app.get('/assets/brand.svg', c => c.body(BRAND_MARK, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }));
app.get('/assets/stripe.svg', c => c.body(STRIPE_MARK, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }));

app.use('*', baseMiddleware);
app.use('/api/*', bodyLimit(256 * 1024));
app.use('/admin/*', bodyLimit(256 * 1024));
app.use('/portal/*', bodyLimit(32 * 1024));

app.get('/readyz', async (c) => {
  try {
    await c.get('deps').sql`SELECT 1`;
    const missing = c.get('deps').config.missingSecrets().length;
    return c.json({ status: missing ? 'degraded' : 'ok', database: 'ok', configurationComplete: missing === 0 }, missing ? 503 : 200);
  } catch (e) {
    logError(c, e);
    return c.json({ status: 'unavailable', database: 'error' }, 503);
  }
});

app.get('/robots.txt', c => c.text(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /portal\nDisallow: /checkout\nDisallow: /api/\nDisallow: /v1/\nDisallow: /webhooks/\nDisallow: /healthz\nDisallow: /readyz\nSitemap: ${new URL('/sitemap.xml', c.get('deps').config.publicBaseUrl).href}\n`));

app.route('/webhooks', webhooks);
app.route('/api/admin/v1', adminApi);
app.route('/admin', adminUi);
app.route('/portal', portalUi);
app.route('/', storeUi);

app.get('/', (c) => c.html(
  <Layout title="Licensing" realm="public" indexable description="RePass Cloud software licences and customer portal." canonical={new URL('/', c.get('deps').config.publicBaseUrl).href}>
    <h1>RePassCloud Licensing</h1>
    <div class="grid">
      <a class="card" href="/store"><h2>Store</h2><p>Buy or register RePassCloud products.</p></a>
      <a class="card" href="/portal"><h2>Customer portal</h2><p>Download licence files, manage activation keys and devices.</p></a>
    </div>
  </Layout>,
));

app.notFound((c) => (c.req.path.startsWith('/api/') || c.req.path.startsWith('/v1/') ? c.json({ error: 'not_found', message: 'Not found.' }, 404) : c.text('Not found', 404)));
app.onError((e, c) => {
  logError(c, e);
  return c.req.path.startsWith('/api/') ? c.json({ error: { code: 'internal', message: 'Internal error' } }, 500) : c.text('Internal error', 500);
});
