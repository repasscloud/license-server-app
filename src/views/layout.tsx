/** @jsxImportSource hono/jsx */
import type { Child, FC } from 'hono/jsx';
import { SiteFooter } from './footer.tsx';
import { APP_ASSET_VERSION } from './assets.ts';

export const Layout: FC<{ title: string; controls?: Child; indexable?: boolean; description?: string; canonical?: string; image?: string; realm: 'admin' | 'customer' | 'public'; who?: string | null; csrf?: string; flash?: { kind: 'ok' | 'err'; text: string } | null; children?: Child }> = (p) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="robots" content={p.indexable ? 'index,follow' : 'noindex,nofollow'} />
      {p.description ? <meta name="description" content={p.description.slice(0, 300)} /> : null}
      {p.canonical ? <link rel="canonical" href={p.canonical} /> : null}
      {p.indexable ? <><meta property="og:title" content={`${p.title} · RePass Cloud`} /><meta property="og:type" content="website" />{p.canonical ? <meta property="og:url" content={p.canonical} /> : null}{p.description ? <meta property="og:description" content={p.description.slice(0, 300)} /> : null}{p.image ? <meta property="og:image" content={p.image} /> : null}</> : null}
      <meta name="color-scheme" content="light dark" />
      <link rel="icon" href="/assets/brand.svg" type="image/svg+xml" />
      <title>{p.title} · RePassCloud Licensing</title>
      <link rel="stylesheet" href={`/assets/app.css?v=${APP_ASSET_VERSION}`} />
      <script src={`/assets/app.js?v=${APP_ASSET_VERSION}`}></script>
    </head>
    <body class={`realm-${p.realm}`}><a class="skip-link" href="#main">Skip to content</a>
      <header class="top">
        <a class="brand" href={p.realm === 'admin' ? '/admin' : '/store'}><img src="/assets/brand.svg" alt="" width="36" height="36" /><span>RePass Cloud<small>{p.realm === 'admin' ? 'Administration' : p.realm === 'customer' ? 'Customer portal' : 'Software & licensing'}</small></span></a>
        {p.realm === 'admin' && p.who ? (
          <nav aria-label="Admin">
            <a href="/admin">Overview</a><a href="/admin/products">Products</a><a href="/admin/offers">Offers</a><a href="/admin/customers">Customers</a>
            <a href="/admin/licenses">Licences</a><a href="/admin/keys">Signing keys</a><a href="/admin/billing">Billing</a><a href="/admin/email">Email</a>
            <a href="/admin/access">Access</a><a href="/admin/audit">Audit</a>
          </nav>
        ) : null}
        {p.realm === 'customer' && p.who ? (<nav aria-label="Portal"><a href="/portal">My licences</a><a href="/store">Store</a></nav>) : null}
        {p.realm === 'public' ? (<nav aria-label="Site"><a href="/store">Store</a><a href="/portal">Customer portal</a></nav>) : null}
        {p.controls}
        <div class="account-controls">
          {p.who ? <><span class="who">{p.who}</span><form class="signout-form" method="post" action={p.realm === 'admin' ? '/admin/logout' : '/portal/logout'}>
            <input type="hidden" name="_csrf" value={p.csrf ?? ''} /><button class="secondary" type="submit">Sign out</button>
          </form></> : null}
          <button class="secondary theme-toggle" type="button" data-theme-toggle aria-label="Switch colour theme" hidden>Theme</button>
        </div>
      </header>
      <main id="main">
        {p.flash ? <div class={`flash ${p.flash.kind}`} role={p.flash.kind === 'err' ? 'alert' : 'status'}>{p.flash.text}</div> : null}
        {p.children}
      </main>
      <SiteFooter />
    </body>
  </html>
);

export const Csrf: FC<{ token: string }> = ({ token }) => <input type="hidden" name="_csrf" value={token} />;

export const Badge: FC<{ v: string }> = ({ v }) => {
  const ok = ['active', 'synced', 'published', 'completed', 'processed', 'sent', 'delivered', 'done', 'shipped', 'success', 'applied', 'created'];
  const bad = ['revoked', 'failed', 'dead', 'compromised', 'drifted', 'disabled', 'denied', 'failure', 'bounced', 'expired', 'error'];
  return <span class={`badge ${ok.includes(v) ? 'ok' : bad.includes(v) ? 'bad' : 'warn'}`}>{v}</span>;
};

export const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') : '—');
export { money } from '../lib/money.ts';
